use crate::state::AppState;
use crate::workspace_edit::{self, EditOutcome, FileEdit};
use std::sync::{Arc, Mutex};

// A second plan cannot interleave its writes and rollback with the current transaction.
static EDIT_LOCK: Mutex<()> = Mutex::new(());

#[tauri::command]
pub async fn workspace_apply_edit(
    state: tauri::State<'_, Arc<AppState>>,
    edits: Vec<FileEdit>,
) -> Result<EditOutcome, String> {
    let root = state
        .config
        .read()
        .await
        .workspace_root
        .clone()
        .ok_or("尚未打开工程")?;
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = EDIT_LOCK.lock().map_err(|_| "重构锁不可用")?;
        workspace_edit::apply(std::path::Path::new(&root), edits)
    })
    .await
    .map_err(|e| format!("重构任务失败：{e}"))?
}
