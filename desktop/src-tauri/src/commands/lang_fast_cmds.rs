//! Phase 1 快速跳转的命令层。
//!
//! 只做三件事：从配置里取工作区根 / NC home、把参数交给 `crate::fast_decl`、把结果原样返回。
//! **永远不返回错误**：索引没建好、文件读不到、工作区没打开 —— 一律回空数组，
//! 前端据此退回内容搜索。跳转链路上「多一种失败方式」比「少一种精度」代价大得多。

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Value;
use tauri::AppHandle;

use crate::app_error::AppError;
use crate::state::AppState;

/// 在声明索引里解析 `textDocument/definition`。
///
/// 返回 `Location[]`，与 jdt.ls 的 `textDocument/definition` 同形状（额外带 `name`/`fromJar`
/// 两个诊断字段），前端现有的 `toTargets` 转换可以直接吃。
///
/// `line` 是 **1 基**、`character` 是 **0 基**（LSP 口径）——调用方负责从 Monaco 的
/// 1 基行列换算过来。
#[tauri::command]
pub async fn lang_fast_definition(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
    line: u32,
    character: u32,
) -> Result<Value, AppError> {
    let empty = || Ok(serde_json::json!([]));
    let (root, nc_home) = {
        let cfg = state.config.read().await;
        (cfg.workspace_root.clone(), cfg.nc_home.clone())
    };
    let Some(root) = root else {
        return empty();
    };
    let root = PathBuf::from(root);
    let file = PathBuf::from(&path);
    if !file.is_file() {
        return empty();
    }
    // 命中即答；没建好就顺手起一次后台构建（当次回空，前端退回内容搜索）
    let Some(loaded) = crate::fast_decl::lookup_or_kick(&app, state.inner(), &root, nc_home) else {
        return empty();
    };
    let locs = crate::fast_decl::definition(&loaded, &file, line, character, &root);
    // 没命中**不记日志也不提示**：Ctrl+悬停会扫过大量单词，一次一条会把日志写成噪音。
    // 要排查索引质量直接看 types.idx 的规模，不要在这里逐条记。
    Ok(serde_json::json!(locs))
}

/// 声明索引的状态（设置页显示）。**只读**，不触发构建。
///
/// 没有工作区时返回 `state = "none"`，不报错 —— 设置页在没打开工程时也会渲染。
#[tauri::command]
pub async fn lang_fast_status(state: tauri::State<'_, Arc<AppState>>) -> Result<Value, AppError> {
    let root = {
        let cfg = state.config.read().await;
        cfg.workspace_root.clone()
    };
    let Some(root) = root else {
        return Ok(serde_json::json!({ "state": "none" }));
    };
    let st = crate::fast_decl::status(state.inner(), &PathBuf::from(root));
    Ok(serde_json::to_value(st).unwrap_or(Value::Null))
}
