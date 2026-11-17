//! 诊断包与崩溃摘要命令。
//!
//! 🔴 为什么预览和导出是两条命令：打包前必须让用户**先看清里面有什么**（学 IDEA 的
//! 敏感数据确认）。预览只 stat 不读内容，所以点开确认页不会把六份日志读进内存。

use crate::app_error::AppError;
use crate::diagnostics::{self, PlanItem, UiSnapshot};
use crate::state::AppState;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::Manager;

/// 上次运行的崩溃摘要，给状态栏胶囊用。没崩过（或没有 panic 证据）时返回 `None`。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashSummary {
    pub started_at_ms: u64,
    /// panic 日志尾部，供用户直接看，不必打开目录。
    pub tail: String,
}

/// 预览：将打包哪些条目。不含内容。
///
/// 不返 `Result`：这一步只 stat 白名单里的固定路径，没有可失败的输入。
/// 套一层 `Result` 只会让前端多一个永远不会走到的 `catch`。
#[tauri::command]
pub fn diagnostics_preview(state: tauri::State<'_, Arc<AppState>>) -> Vec<PlanItem> {
    diagnostics::plan(&state.config_dir)
}

/// 打包导出。`include` 是用户勾选后的包内路径列表（`None` = 全打）。
///
/// 落盘目录优先取系统「下载」目录；拿不到时退回配置目录，保证导出不会因为
/// 解析路径失败而整个失败。
#[tauri::command]
pub fn export_diagnostics(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    ui: Option<UiSnapshot>,
    include: Option<Vec<String>>,
    out_dir: Option<String>,
) -> Result<String, AppError> {
    let entries = diagnostics::collect(
        &state.config_dir,
        &ui.unwrap_or_default(),
        include.as_deref(),
    );
    // 全勾掉时导出一个只有 README 的空包没有意义，直接报错让人看清。
    if entries.is_empty() {
        return Err(
            AppError::input("diagnostics.empty", "没有勾选任何内容").with_hint("至少勾一项再导出")
        );
    }
    let dir = match out_dir.filter(|s| !s.trim().is_empty()) {
        Some(p) => PathBuf::from(p),
        None => app
            .path()
            .download_dir()
            .unwrap_or_else(|_| state.config_dir.clone()),
    };
    let path = diagnostics::write_zip(&dir, &entries)
        .map_err(|d| AppError::env("diagnostics.zipFailed", d))?;
    Ok(path.to_string_lossy().into_owned())
}

/// 在资源管理器里定位刚导出的包。
#[tauri::command]
pub fn diagnostics_reveal(app: tauri::AppHandle, path: String) -> Result<(), AppError> {
    use tauri_plugin_opener::OpenerExt;
    let p = PathBuf::from(path);
    if !p.exists() {
        return Err(AppError::env("diagnostics.missing", "诊断包已被移动或删除"));
    }
    app.opener()
        .reveal_item_in_dir(&p)
        .map_err(|e| AppError::env("diagnostics.revealFailed", format!("打开位置失败: {e}")))
}

/// 上次是否崩溃。**只有确有 panic 记录时才算崩溃**——标记残留也可能只是断电或强杀，
/// 那种情况报「崩溃」会让用户以为是我们弄坏了东西。
#[tauri::command]
pub fn crash_summary(state: tauri::State<'_, Arc<AppState>>) -> Option<CrashSummary> {
    let prev = crate::crash::previous_run()?;
    if !prev.had_panic {
        return None;
    }
    Some(CrashSummary {
        started_at_ms: prev.started_at_ms,
        tail: crate::crash::read_tail(&state.config_dir, 4 * 1024),
    })
}
