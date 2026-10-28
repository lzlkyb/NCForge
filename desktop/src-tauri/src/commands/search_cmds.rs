//! 搜索命令：把 `search::search` 包成 IPC 命令。
//!
//! 路径解析、工作区白名单、阻塞线程的范式都沿用 `workspace_cmds`：
//! 这里只取当前工作区根（搜索天然覆盖整个工作区，不需要单文件路径参数），
//! 然后把纯逻辑丢进 spawn_blocking，避免一次全量扫盘卡住 async 运行时。

use std::path::PathBuf;
use std::sync::Arc;

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
