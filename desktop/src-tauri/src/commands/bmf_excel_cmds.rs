//! 元数据「导入导出」命令：自有字段模板的导出与导入预览。
//!
//! 导出只写用户在工作区内点选的目录；导入只读文件、只规划 `EditOp`，
//! 真正的落盘仍走 `bmf_edit_save`（SHA 校验 + 备份 + 原子写 + diff）。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::State;

use crate::bmf_excel::{self, ImportPreview};
use crate::bmf_model::BmfDoc;
use crate::security::path::display_path;
use crate::state::AppState;

use super::bmf_cmds::safe_write_path;

/// 导出模板到用户选定的目录（必须位于工作区或链接工程内）。
#[tauri::command]
pub async fn bmf_excel_template(
    state: State<'_, Arc<AppState>>,
    path: String,
    target_dir: String,
) -> Result<String, String> {
    let dir = {
        let cfg = state.config.read().await;
        safe_write_path(&cfg, &target_dir)?
    };
    tauri::async_runtime::spawn_blocking(move || {
        let doc = BmfDoc::open(Path::new(&path))?;
        let written = bmf_excel::write_template(&doc, &dir)?;
        Ok(display_path(&written))
    })
    .await
    .map_err(|e| format!("导出模板失败：{e}"))?
}

/// 解析导入文件并对照当前文档生成预览；不写任何文件。
#[tauri::command]
pub async fn bmf_excel_preview(path: String, file: String) -> Result<ImportPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ext = PathBuf::from(&file)
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if ext != "xlsx" {
            return Err(
                "只支持 .xlsx（用 NCForge 导出的自有模板）；官方 PDM 格式等样本后再适配"
                    .to_string(),
            );
        }
        let meta = std::fs::metadata(&file).map_err(|_| "导入文件不可读".to_string())?;
        if meta.len() > 20 * 1024 * 1024 {
            return Err("导入文件超过 20 MB，拒绝读取".to_string());
        }
        let bytes = std::fs::read(&file).map_err(|e| format!("读取导入文件失败：{e}"))?;
        let doc = BmfDoc::open(Path::new(&path))?;
        bmf_excel::plan_import(&doc, &file, &bytes)
    })
    .await
    .map_err(|e| format!("解析导入文件失败：{e}"))?
}
