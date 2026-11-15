use crate::change_shelf::{self, ShelfRestoreFile, ShelfSummary};
use crate::state::AppState;
use crate::workspace_edit::FileEdit;
use std::sync::{Arc, Mutex};
static SHELF_LOCK: Mutex<()> = Mutex::new(());
async fn context(state: &AppState) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    Ok((
        state.config_dir.clone(),
        state
            .config
            .read()
            .await
            .workspace_root
            .clone()
            .map(std::path::PathBuf::from)
            .ok_or("尚未打开工程")?,
    ))
}
#[tauri::command]
pub async fn change_shelf_list(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<ShelfSummary>, String> {
    let (config, root) = context(&state).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = SHELF_LOCK.lock().map_err(|e| e.to_string())?;
        change_shelf::list(&config, &root)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn change_shelf_create(
    state: tauri::State<'_, Arc<AppState>>,
    name: String,
    files: Vec<FileEdit>,
) -> Result<ShelfSummary, String> {
    let (config, root) = context(&state).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = SHELF_LOCK.lock().map_err(|e| e.to_string())?;
        change_shelf::create(&config, &root, &name, files)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn change_shelf_plan(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
) -> Result<Vec<ShelfRestoreFile>, String> {
    let (config, root) = context(&state).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = SHELF_LOCK.lock().map_err(|e| e.to_string())?;
        change_shelf::plan(&config, &root, &id)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn change_shelf_delete(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
) -> Result<(), String> {
    let (config, root) = context(&state).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = SHELF_LOCK.lock().map_err(|e| e.to_string())?;
        change_shelf::remove(&config, &root, &id)
    })
    .await
    .map_err(|e| e.to_string())?
}
