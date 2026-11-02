//! NCC/BIP 报文解密用的服务端开关读取。
//!
//! `hotwebs/nccloud/WEB-INF/config/miscellaneous.xml` 的 `<gzip>` / `<aesKey>` / `<mark>`
//! 决定对端报文是否压过 / 加过密（`mark` 只是加签，解密用不到，界面上仅作提示）。
//!
//! 读取失败**不报错**：上游工具在文件不存在时按「全开」起步，让用户手动按实际调整；
//! 这里沿用同一口径，避免 NC home 没配好时整个对话框打不开。
//!
//! 解密本身在前端 WebCrypto 里做（AES-CTR + gzip 都是标准能力，不需要往 Rust 引依赖），
//! 这里只负责把开关读出来。算法见 `desktop/src/lib/nccDecode.ts`。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;

use crate::nc_home;
use crate::state::AppState;

/// 相对 NC home 的配置文件（与上游 `NCCJsonDecodeDialog` 同一路径）。
pub const MISC_XML: &str = "hotwebs/nccloud/WEB-INF/config/miscellaneous.xml";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NccDecodeConfig {
    /// 解析到的 NC home（解析失败时为空串）。
    pub home: String,
    /// 期望的配置文件绝对路径（读不到时也给出来，方便用户去核对）。
    pub path: String,
    /// 文件是否真的读到了（false = 下面的开关是默认值，不是文件里的值）。
    pub found: bool,
    pub gzip: bool,
    /// 对应 `<aesKey>`：是否启用 AES 加解密。
    pub aes: bool,
    /// 对应 `<mark>`：是否启用数据加签（解密不需要它，仅展示）。
    pub mark: bool,
}

impl Default for NccDecodeConfig {
    fn default() -> Self {
        Self {
            home: String::new(),
            path: String::new(),
            found: false,
            // 与上游 `initDefualtValues` 一致：文件缺失时默认三项全开
            gzip: true,
            aes: true,
            mark: true,
        }
    }
}

/// 读 `miscellaneous.xml` 的三项开关。文件缺失/标签缺失一律回落默认值。
fn read_flags(root: &Path) -> NccDecodeConfig {
    let path = root.join(MISC_XML.replace('/', std::path::MAIN_SEPARATOR_STR));
    let path_text = path.to_string_lossy().to_string();
    let Ok(bytes) = std::fs::read(&path) else {
        return NccDecodeConfig {
            home: root.to_string_lossy().to_string(),
            path: path_text,
            ..NccDecodeConfig::default()
        };
    };
    let text = crate::workspace::decode_lossy(&bytes);
    NccDecodeConfig {
        home: root.to_string_lossy().to_string(),
        path: path_text,
        found: true,
        gzip: flag(&text, "gzip"),
        aes: flag(&text, "aesKey"),
        mark: flag(&text, "mark"),
    }
}

/// 取 `<tag>true|false</tag>`；标签缺失或值不是 true/false 时按 true（上游口径）。
fn flag(xml: &str, tag: &str) -> bool {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let Some(start) = xml.find(&open).map(|i| i + open.len()) else {
        return true;
    };
    let Some(end) = xml[start..].find(&close).map(|i| i + start) else {
        return true;
    };
    match xml[start..end].trim().to_ascii_lowercase().as_str() {
        "false" => false,
        "true" => true,
        _ => true,
    }
}

/// 读取当前 NC home 的报文开关（界面打开解密对话框时拉一次）。
#[tauri::command]
pub async fn ncc_decode_config(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<NccDecodeConfig, String> {
    let configured = state.config.read().await.nc_home.clone();
    tauri::async_runtime::spawn_blocking(move || match nc_home::resolve(configured.as_deref()) {
        Ok(home) => read_flags(&PathBuf::from(&home.root)),
        // NC home 找不到不该让工具不可用：给默认值并标记 found=false，界面会说明
        Err(_) => NccDecodeConfig::default(),
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(tag: &str) -> PathBuf {
        let mut d = std::env::temp_dir();
        d.push(format!("ncforge-ncc-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn write_misc(root: &Path, body: &str) {
        let dir = root
            .join("hotwebs")
            .join("nccloud")
            .join("WEB-INF")
            .join("config");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("miscellaneous.xml"), body.as_bytes()).unwrap();
    }

    #[test]
    fn 按文件读出三个开关() {
        let d = temp_dir("flags");
        write_misc(
            &d,
            "<?xml version=\"1.0\"?><miscellaneous>\
             <gzip>false</gzip><mark>true</mark><aesKey>false</aesKey>\
             </miscellaneous>",
        );
        let c = read_flags(&d);
        assert!(c.found);
        assert!(!c.gzip);
        assert!(!c.aes);
        assert!(c.mark);
        assert!(c.path.ends_with("miscellaneous.xml"));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn 文件缺失时回落全开且标记不可信() {
        let d = temp_dir("missing");
        let c = read_flags(&d);
        assert!(!c.found);
        assert!(c.gzip && c.aes && c.mark, "与上游默认一致：全开");
        assert!(c.path.ends_with("miscellaneous.xml"), "路径要能给人看");
        let _ = fs::remove_dir_all(&d);
    }

    /// 标签缺失或值写坏时按 true：宁可默认多解一层，也不要悄悄把开关吞成 false。
    #[test]
    fn 标签缺失或非法值按默认开() {
        let d = temp_dir("partial");
        write_misc(
            &d,
            "<miscellaneous><gzip>FALSE</gzip><mark>yes</mark></miscellaneous>",
        );
        let c = read_flags(&d);
        assert!(!c.gzip, "大小写不敏感");
        assert!(c.mark, "非法值回落 true");
        assert!(c.aes, "标签缺失回落 true");
        let _ = fs::remove_dir_all(&d);
    }

    /// 真实文件声明 UTF-8，但同事可能存成 GBK；带中文注释时也要能读到标签。
    #[test]
    fn gbk_注释不影响解析() {
        let d = temp_dir("gbk");
        let mut body = b"<miscellaneous><gzip>false</gzip><!-- ".to_vec();
        // "压缩" 的 GBK 编码
        body.extend_from_slice(&[0xD1, 0xB9, 0xCB, 0xF5]);
        body.extend_from_slice(b" --><aesKey>true</aesKey></miscellaneous>");
        let dir = d
            .join("hotwebs")
            .join("nccloud")
            .join("WEB-INF")
            .join("config");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("miscellaneous.xml"), &body).unwrap();
        let c = read_flags(&d);
        assert!(!c.gzip);
        assert!(c.aes);
        let _ = fs::remove_dir_all(&d);
    }
}
