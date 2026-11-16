//! 前端错误日志的三个命令：写一条、读尾部、在资源管理器里定位。
//!
//! 🔴 `frontend_log_append` **不返回 Result 给业务用**：前端是 fire-and-forget，
//! 写日志失败绝不能反过来影响正在崩溃的页面。这里仍返回 `Result` 是为了
//! 让失败可见（控制台能看到），但调用方一律 `.catch(() => undefined)`。

use crate::frontend_log;
use crate::state::AppState;
use std::sync::Arc;

/// 追加一条前端错误。`kind` 是来源（render / window.onerror / unhandledrejection）。
#[tauri::command]
pub fn frontend_log_append(
    state: tauri::State<'_, Arc<AppState>>,
    kind: String,
    message: String,
    stack: Option<String>,
    page: Option<String>,
) -> Result<(), String> {
    let line = frontend_log::format_entry(&kind, &message, stack.as_deref(), page.as_deref());
    frontend_log::append(&state.config_dir, &line)
}

/// 读最近的前端错误（默认尾部 64 KiB，够看几十条堆栈）。
#[tauri::command]
pub fn frontend_log_read(
    state: tauri::State<'_, Arc<AppState>>,
    max_bytes: Option<u64>,
) -> Result<String, String> {
    frontend_log::read_tail(&state.config_dir, max_bytes.unwrap_or(64 * 1024))
}

/// 在资源管理器里定位前端日志；还没崩过时打开日志目录。
///
/// 与 `client_reveal_log` 同一套口径：文件在就 reveal，不在就建目录再打开，
/// 不让用户点了按钮得到一个「文件不存在」的错误。
#[tauri::command]
pub fn frontend_log_reveal(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let path = frontend_log::log_path(&state.config_dir);
    if path.exists() {
        return app
            .opener()
            .reveal_item_in_dir(&path)
            .map_err(|e| format!("打开日志位置失败: {e}"));
    }
    let dir = frontend_log::ensure_dir(&state.config_dir)?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| format!("打开日志目录失败: {e}"))
}
