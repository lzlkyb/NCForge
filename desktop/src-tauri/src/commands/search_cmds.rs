//! 搜索命令：把 `search::search` 包成 IPC 命令。
//!
//! 路径解析、工作区白名单、阻塞线程的范式都沿用 `workspace_cmds`：
//! 这里只取当前工作区根（搜索天然覆盖整个工作区，不需要单文件路径参数），
//! 然后把纯逻辑丢进 spawn_blocking，避免一次全量扫盘卡住 async 运行时。

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;

use crate::search::{self, SearchOptions, SearchOutcome};
use crate::state::AppState;

#[tauri::command]
pub async fn search_workspace(
    state: tauri::State<'_, Arc<AppState>>,
    options: SearchOptions,
) -> Result<SearchOutcome, String> {
    let root = state
        .config
        .read()
        .await
        .workspace_root
        .clone()
        .ok_or_else(|| "尚未选择工作区目录".to_string())?;
    let root = PathBuf::from(root);
    tauri::async_runtime::spawn_blocking(move || search::search(&root, &options))
        .await
        .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 工作区文件清单（「转到文件」用）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileList {
    /// 相对工作区根、`/` 分隔。
    pub files: Vec<String>,
    pub truncated: bool,
}

#[tauri::command]
pub async fn search_list_files(state: tauri::State<'_, Arc<AppState>>) -> Result<FileList, String> {
    let root = state
        .config
        .read()
        .await
        .workspace_root
        .clone()
        .ok_or_else(|| "尚未选择工作区目录".to_string())?;
    let root = PathBuf::from(root);
    tauri::async_runtime::spawn_blocking(move || {
        let (files, truncated) = search::list_files(&root);
        FileList { files, truncated }
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))
}
