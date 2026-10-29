//! 系统类命令：自启、配置读写、安装信息。**壳子级通用件，与业务无关。**
//!
//! 这些命令演示了三种典型模式，新命令照抄即可：
//! 1. **托管状态读写**（`get_config` / `save_config`）：`State<Arc<AppState>>` + RwLock；
//! 2. **插件调用**（`set_autostart`）：tauri 插件在 Rust 侧的用法；
//! 3. **只读环境信息**（`get_app_info`）：纯函数式返回，不碰状态。

use std::sync::Arc;

use crate::config::AppConfig;
use crate::state::AppState;

/// 读当前配置（启动后可能已被其它命令改过，以内存为准）。
///
/// 口令密文（`svn_password_dpapi` / `db_password_dpapi`）在此出口抹成占位符：
/// 前端不消费它们，IPC 桥对面是整个 webview，密文不过桥（见 `AppConfig::redacted`）。
#[tauri::command]
pub async fn get_config(state: tauri::State<'_, Arc<AppState>>) -> Result<AppConfig, String> {
    Ok(state.config.read().await.clone().redacted())
}

/// 设置项的局部更新：只改传进来的字段，其余保持当前值。
///
/// 为什么不再提供「传整份 AppConfig」的 `save_config`：那要求前端先 get 一份、合并、
/// 再整份写回，中间任何一次别的写入都会被覆盖（丢的是对方那次改动），而且**字段名写错
/// 一个字母就会静默变成一份全默认配置**——serde 默认忽略未知字段，于是工作区、NC home、
/// 堆上限一起被清空，界面还显示保存成功。局部更新没有这两个失败模式。
///
/// 字段名与 `AppConfig` 一致用 **snake_case**（不做 rename_all）：前端读配置拿到的就是
/// 这套名字，写回时不用再记一套 camelCase 映射，少一次转写出错的机会。
///
/// 新增设置项时在这里加字段，并同步 `lib/appConfig.ts` 的 `ConfigPatch`；
/// 需要校验或联动系统状态的设置（NC home、堆上限、工作区）继续用各自的专用命令。
#[derive(Debug, serde::Deserialize)]
pub struct ConfigPatch {
    #[serde(default)]
    pub release_webview_on_close: Option<bool>,
    #[serde(default)]
    pub autostart_enabled: Option<bool>,
}

/// 落盘并返回改完的**完整配置**：调用方据此回填表单，不用再 get 一次。
/// 与 `get_config` 同一出口口径：口令密文抹成占位符（`redacted`）。
#[tauri::command]
pub async fn patch_config(
    state: tauri::State<'_, Arc<AppState>>,
    patch: ConfigPatch,
) -> Result<AppConfig, String> {
    state
        .update_config(move |cfg| {
            if let Some(v) = patch.release_webview_on_close {
                cfg.release_webview_on_close = v;
            }
            if let Some(v) = patch.autostart_enabled {
                cfg.autostart_enabled = v;
            }
            Ok(())
        })
        .await
        .map(AppConfig::redacted)
}

/// 开机自启状态。
#[tauri::command]
pub fn get_autostart(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch()
        .is_enabled()
        .map_err(|e| format!("读取自启状态失败: {e}"))
}

/// 设置开机自启。返回**最终生效状态**（而非 `()`）：
/// 前端 toggle 是乐观置值的，失败时要靠返回值区分「成功但无返回值」与「失败」
/// 才能回滚——`invokeOrToast` 对 `Result<()>` 命令无从判断（成功也是 undefined）。
#[tauri::command]
pub fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    let al = app.autolaunch();
    if enabled {
        al.enable().map_err(|e| format!("开启自启失败: {e}"))?;
    } else {
        al.disable().map_err(|e| format!("关闭自启失败: {e}"))?;
    }
    // 读回真源而不是直接返回入参：个别平台（Windows 注册表写入）可能存在延迟，
    // 以插件自己的状态为准，前端拿它校正 UI。
    al.is_enabled()
        .map_err(|e| format!("读取自启状态失败: {e}"))
}

/// 应用信息（版本 / 平台）。版本取 Cargo.toml 真源（env! 编译期常量）。
/// 前端关于卡、侧栏版本徽章都用它——不要在 package.json 再维护一份。
#[tauri::command]
pub fn get_app_info() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "platform": std::env::consts::OS,
    }))
}

/// 在系统文件管理器中揭示安装目录。
#[tauri::command]
pub fn reveal_install_dir(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = std::env::current_exe()
        .map_err(|e| format!("定位可执行文件失败: {e}"))?
        .parent()
        .ok_or_else(|| "无法解析安装目录".to_string())?
        .to_path_buf();
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| format!("打开目录失败: {e}"))
}

/// 允许 `open_external` 打开的 URL scheme 白名单。
///
/// 为什么必须白名单：插件底层是 `open::that_detached`（Windows 上即 ShellExecuteW），
/// 对输入零校验——`open_external("file:///C:/.../evil.exe")` 会直接启动程序，
/// `ms-excel:`/`search-ms:` 等协议处理程序同样能被触发。壳子的命令面对整个前端开放，
/// 前端一旦有 XSS 或被投毒的依赖，这就是任意代码执行。
/// 只放行「看文档/开仓库/发邮件」需要的三种；其余一律拒绝并明确报错
/// （静默失败会让调用方以为链接已打开）。
fn is_allowed_external_url(url: &str) -> bool {
    match url::Url::parse(url) {
        Ok(u) => matches!(u.scheme(), "https" | "http" | "mailto"),
        Err(_) => false,
    }
}

/// 用系统默认浏览器打开外部链接（仅白名单 scheme，见 `is_allowed_external_url`）。
#[tauri::command]
pub fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    if !is_allowed_external_url(&url) {
        return Err(format!(
            "不允许打开的链接（仅支持 http/https/mailto）: {url}"
        ));
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("打开链接失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 白名单的**目的**是防任意程序执行：file:// 与各类协议处理程序必须被拒。
    #[test]
    fn external_url_whitelist_blocks_dangerous_schemes() {
        // 放行：文档/仓库/邮件
        assert!(is_allowed_external_url(
            "https://github.com/tauri-apps/tauri"
        ));
        assert!(is_allowed_external_url("http://example.com/docs"));
        assert!(is_allowed_external_url("HTTPS://EXAMPLE.COM")); // scheme 大小写不敏感
        assert!(is_allowed_external_url("mailto:dev@example.com"));
        assert!(is_allowed_external_url(
            "mailto:dev@example.com?subject=Feedback"
        ));

        // 拒绝：本地文件（Windows 上可直接启动 exe）
        assert!(!is_allowed_external_url(
            "file:///C:/Windows/System32/calc.exe"
        ));
        assert!(!is_allowed_external_url("FILE:///C:/x.bat"));
        // 拒绝：协议处理程序与伪协议
        assert!(!is_allowed_external_url(
            "ms-excel:ofe|u|https://example.com/x.csv"
        ));
        assert!(!is_allowed_external_url(
            "search-ms:query=evil&displayname=x"
        ));
        assert!(!is_allowed_external_url("javascript:alert(1)"));
        assert!(!is_allowed_external_url(
            "data:text/html,<script>alert(1)</script>"
        ));
        assert!(!is_allowed_external_url("vbscript:msgbox(1)"));
        // 拒绝：不是 URL 的输入（含 UNC 路径、盘符路径）
        assert!(!is_allowed_external_url("C:/Windows/System32/calc.exe"));
        assert!(!is_allowed_external_url(r"\\server\share\evil.exe"));
        assert!(!is_allowed_external_url(""));
        // 前导/尾随空格按 WHATWG URL 标准被 trim，解析结果仍是合法 https ⇒ 放行
        // （浏览器对同样的输入也是如此处理，没有 bypass 面）。
        assert!(is_allowed_external_url("  https://example.com  "));
        // URL 内部的 tab/换行同样会被 strip，判定的是 strip 后的结果——
        // 不存在「看起来 A 实际 B」的混淆面；strip 后 scheme 非法照样拒。
        assert!(!is_allowed_external_url("java\nscript:alert(1)"));
        assert!(!is_allowed_external_url("java\tscript:alert(1)"));
    }
}
