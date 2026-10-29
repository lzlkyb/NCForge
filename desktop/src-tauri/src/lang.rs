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
        let rel = rel_under(&self.real_dir.to_string_lossy(), real_path)
            .ok_or_else(|| format!("文件不在当前代码智能模块（{}）内", self.module))?;
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
    /// 每次拉起自增。进程退出回调据此判断「退出的是不是当前这一代」，
    /// 避免旧进程收尾时把刚起来的新会话误判成崩溃。
    pub generation: u64,
    /// 每次**停止请求**自增（不只成功停掉时才加，见 `cancel_epoch` 的注释）。
    ///
    /// `launch` 从生成影子工程到登记 session 有几秒窗口，这期间 `session` 还是 `None`：
    /// `stop_now` 摘不到东西、直接把状态置成 stopped 就返回了，而 launch 收尾时不复检
    /// 停止意图，照常登记 session 并把状态改成 indexing。结果是用户明确关了开关或换了
    /// 工作区，一个约 700MB 的 jdt.ls 还在跑，状态栏还说「正在建立索引」。
    /// 拉起时记下这个计数，登记前比一次，对不上就把刚起的 client 杀掉、不登记。
    pub cancel_epoch: u64,
}

impl Default for LangRun {
    fn default() -> Self {
        Self {
            session: None,
            status: LangStatus::stopped(),
            generation: 0,
            cancel_epoch: 0,
        }
    }
}

/// `path` 在 `base` 目录下的相对部分；不在其下返回 `None`。
///
/// Windows 路径不区分大小写，而前端传来的路径大小写取决于用户填的工作区根，
/// `base` 却是 canonicalize 后的真实大小写——用 `Path::strip_prefix` 会把大小写不同的同一目录当成不同目录，
/// 于是整个模块的文件都会被判成「不在模块里」，补全全部静默失效。
/// 只对 ASCII 折叠大小写（保持字节长度，返回的相对部分取自原路径）。
pub fn rel_under(base: &str, path: &str) -> Option<String> {
    let norm = |s: &str| s.trim_start_matches(r"\\?\").replace('/', "\\");
    let (b, p) = (norm(base), norm(path));
    let b = b.trim_end_matches('\\');
    let head = p.get(..b.len())?;
    if !head.eq_ignore_ascii_case(b) {
        return None;
    }
    let rest = &p[b.len()..];
    rest.strip_prefix('\\')
        .filter(|r| !r.is_empty())
        .map(str::to_string)
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
    fn rel_under_ignores_case_and_separator_style() {
        let base = r"C:\work\aier\newar\gl";
        assert_eq!(
            rel_under(base, r"C:\work\aier\newar\gl\src\A.java").as_deref(),
            Some(r"src\A.java")
        );
        // 盘符、目录大小写不同，正斜杠混用，都算同一个模块
        assert_eq!(
            rel_under(base, "c:/Work/AIER/Newar/GL/src/A.java").as_deref(),
            Some(r"src\A.java")
        );
        // 带扩展长度前缀、base 带尾部斜杠
        assert_eq!(
            rel_under(
                r"C:\work\aier\newar\gl\",
                r"\\?\C:\work\aier\newar\gl\x\B.java"
            )
            .as_deref(),
            Some(r"x\B.java")
        );
        // 同名前缀的另一个模块、模块目录本身、完全无关的路径，都不算
        assert_eq!(rel_under(base, r"C:\work\aier\newar\gl2\src\A.java"), None);
        assert_eq!(rel_under(base, r"C:\work\aier\newar\gl"), None);
        assert_eq!(rel_under(base, r"D:\other\A.java"), None);
        // 非 ASCII 路径不会在字符边界上切坏
        assert_eq!(
            rel_under(r"C:\工作", r"C:\工作\a.java").as_deref(),
            Some("a.java")
        );
        assert_eq!(rel_under(r"C:\工作", r"C:\工"), None);
    }

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
