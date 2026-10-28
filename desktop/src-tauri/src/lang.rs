//! 代码智能（jdt.ls）的会话状态与路径映射。纯逻辑，不依赖 tauri，可单测。
//!
//! 编辑器里打开的是工作副本里的真实文件，jdt.ls 看到的却是影子工程里的 junction 路径
//! （见 `shadow.rs`）。两边的 URI 只差一个前缀，所以：
//! - 发给 jdt.ls 之前：真实模块目录前缀 → 影子模块目录前缀；
//! - jdt.ls 返回之后：影子前缀 → 真实前缀（跳转结果、诊断才能在编辑器里打开真实文件）。
//!
//! 前缀由同一个 `lsp::path_to_uri` 生成，中文/空格的转义两边一致，所以直接做字符串替换。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;

use crate::lsp::{path_to_uri, LspClient};

/// jdt.ls 默认堆上限（MB）。实测 gl 模块实际用 656MB。
pub const DEFAULT_XMX_MB: u32 = 1024;
/// 可设范围。下限：再小 jdt.ls 在 NC 工程上会频繁 OOM；上限：它不需要更多，设大了只会挤掉中间件的内存。
pub const XMX_MIN_MB: u32 = 512;
pub const XMX_MAX_MB: u32 = 4096;

/// 校验用户填的内存上限。
pub fn validate_xmx(mb: u32) -> Result<u32, String> {
    if (XMX_MIN_MB..=XMX_MAX_MB).contains(&mb) {
        Ok(mb)
    } else {
        Err(format!(
            "代码智能的内存上限要在 {XMX_MIN_MB}~{XMX_MAX_MB} MB 之间，当前填的是 {mb}"
        ))
    }
}

/// 语言服务当前状态，前端用 `lang-status` 事件与 `lang_status` 命令读取。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LangStatus {
    /// `stopped` / `starting`（拉起与影子工程生成）/ `indexing`（jdt.ls 在建索引）/ `ready` / `error`
    pub state: String,
    pub module: Option<String>,
    /// 给人看的一句话（进度原文或错误原因）。
    pub message: String,
    pub source_files: usize,
    pub jar_count: usize,
}

impl LangStatus {
    pub fn stopped() -> Self {
        Self {
            state: "stopped".into(),
            module: None,
            message: String::new(),
            source_files: 0,
            jar_count: 0,
        }
    }
}

/// 一次运行中的语言服务。
pub struct LangSession {
    pub client: LspClient,
    pub module: String,
    real_dir: PathBuf,
    shadow_dir: PathBuf,
    real_prefix: String,
    shadow_prefix: String,
}

impl LangSession {
    pub fn new(client: LspClient, module: &str, real_dir: &Path, shadow_dir: &Path) -> Self {
        Self {
            client,
            module: module.to_string(),
            real_dir: real_dir.to_path_buf(),
            shadow_dir: shadow_dir.to_path_buf(),
            real_prefix: path_to_uri(&real_dir.to_string_lossy()),
            shadow_prefix: path_to_uri(&shadow_dir.to_string_lossy()),
        }
    }

    /// 真实文件路径 → 影子工程里的 URI。不在当前模块内返回 `Err`。
    pub fn shadow_uri_of(&self, real_path: &str) -> Result<String, String> {
        let rel = Path::new(real_path)
            .strip_prefix(&self.real_dir)
            .map_err(|_| format!("文件不在当前代码智能模块（{}）内", self.module))?;
        Ok(path_to_uri(&self.shadow_dir.join(rel).to_string_lossy()))
    }

    /// 发给 jdt.ls 的消息：真实前缀 → 影子前缀。
    pub fn to_server(&self, v: &Value) -> Value {
        swap_prefix(v, &self.real_prefix, &self.shadow_prefix)
    }

    /// jdt.ls 返回的消息：影子前缀 → 真实前缀。
    pub fn from_server(&self, v: &Value) -> Value {
        swap_prefix(v, &self.shadow_prefix, &self.real_prefix)
    }
}

/// 运行态：会话 + 状态。`AppState.lang` 持有。
pub struct LangRun {
    pub session: Option<Arc<LangSession>>,
    pub status: LangStatus,
}

impl Default for LangRun {
    fn default() -> Self {
        Self {
            session: None,
            status: LangStatus::stopped(),
        }
    }
}

/// 把 JSON 里所有以 `from` 开头的 URI 字符串换成 `to` 开头。
///
/// 只换「字符串值的开头」，不会动正文里碰巧出现的同样文字（比如源码里写着一个 file:/// 路径）。
pub fn swap_prefix(v: &Value, from: &str, to: &str) -> Value {
    match v {
        // 前缀后必须是结尾或 `/`，否则 `…/gl` 会误伤同名前缀的 `…/gl2`
        Value::String(s) => match s.strip_prefix(from) {
            Some(rest) if rest.is_empty() || rest.starts_with('/') => {
                Value::String(format!("{to}{rest}"))
            }
            _ => v.clone(),
        },
        Value::Array(a) => Value::Array(a.iter().map(|x| swap_prefix(x, from, to)).collect()),
        Value::Object(m) => Value::Object(
            m.iter()
                .map(|(k, x)| (k.clone(), swap_prefix(x, from, to)))
                .collect(),
        ),
        _ => v.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn xmx_range_is_enforced_at_both_ends() {
        assert_eq!(validate_xmx(1024), Ok(1024));
        assert_eq!(validate_xmx(XMX_MIN_MB), Ok(XMX_MIN_MB));
        assert_eq!(validate_xmx(XMX_MAX_MB), Ok(XMX_MAX_MB));
        assert!(validate_xmx(XMX_MIN_MB - 1).is_err());
        assert!(validate_xmx(XMX_MAX_MB + 1).is_err());
        assert!(validate_xmx(0).is_err());
    }

    #[test]
    fn swap_prefix_only_touches_string_heads() {
        let v = json!({
            "uri": "file:///C:/ws/gl/A.java",
            "list": [{ "targetUri": "file:///C:/ws/gl/B.java" }, "jdt://contents/x"],
            // 正文里出现同样文字，不在开头，不能被替换
            "text": "路径是 file:///C:/ws/gl/A.java 这个",
            "n": 3
        });
        let out = swap_prefix(&v, "file:///C:/ws/gl", "file:///D:/shadow/gl");
        assert_eq!(out["uri"], "file:///D:/shadow/gl/A.java");
        assert_eq!(out["list"][0]["targetUri"], "file:///D:/shadow/gl/B.java");
        assert_eq!(out["list"][1], "jdt://contents/x");
        assert_eq!(out["text"], "路径是 file:///C:/ws/gl/A.java 这个");
        assert_eq!(out["n"], 3);
        // 同名前缀的另一个模块不能被误换
        let other = json!({ "uri": "file:///C:/ws/gl2/A.java" });
        assert_eq!(
            swap_prefix(&other, "file:///C:/ws/gl", "file:///D:/s/gl"),
            other
        );
    }

    #[test]
    fn swap_prefix_roundtrips_with_chinese_paths() {
        let real = path_to_uri(r"C:\work\aier\newar\总账 gl");
        let shadow = path_to_uri(r"D:\data\shadow\总账 gl");
        let v = json!({ "uri": format!("{real}/src/Step4View.java") });
        let there = swap_prefix(&v, &real, &shadow);
        assert!(there["uri"].as_str().unwrap().starts_with(&shadow));
        assert_eq!(swap_prefix(&there, &shadow, &real), v);
    }
}
