//! 字段观察点（watchpoint）命令：问适配器 + 整批下发。
//!
//! 从 `debug_cmds.rs` 拆出（那个文件已到体量门禁边上）：断点命令留在原处，
//! 观察点是另一套 DAP 请求、另一份同步状态机（前端 `lib/watchpointSync.ts`），
//! 单独成文件两边都改得动。
//!
//! 适配器判据（java-debug 0.32.0 反编译）在 `crate::debug::data_breakpoints`：
//! dataId 只能问出来、响应按请求顺序回报 verified、accessType 三种线格式。
//! 请求共用 `debug_cmds::ask_app`（结构化错误版 DAP 请求助手）。
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tauri::State;

use super::debug_cmds::ask_app;
use crate::app_error::AppError;
use crate::debug::{self, DebugTarget};
use crate::state::AppState;

/// 字段观察点（watchpoint）：问适配器「这个字段能不能观察」。
///
/// 只在暂停时有意义——`variables_reference` 来自当前帧的变量树，恢复后即失效
/// （但已装上的观察点由 dataId 标识，继续有效）。局部变量的引用解析不到
/// ObjectReference，适配器直接报错，调用方把原话提示出来即可。
#[tauri::command]
pub async fn debug_data_breakpoint_info(
    state: State<'_, Arc<AppState>>,
    target: String,
    variables_reference: i64,
    name: String,
) -> Result<Value, AppError> {
    ask_app(
        state.inner().clone(),
        DebugTarget::parse(&target).map_err(|e| AppError::input("debug.badTarget", e))?,
        "dataBreakpointInfo",
        debug::data_breakpoint_info_args(variables_reference, &name),
        Duration::from_secs(15),
    )
    .await
}

/// 字段观察点整批下发（空数组 = 全部清掉）。命中时停因是 "data breakpoint"。
///
/// 适配器回报的 `breakpoints` 与请求逐项同序（0.32.0 字节码确认，Types$Breakpoint
/// 上没有 dataId），前端按位置把 verified 映射回条目——所以 Rust 侧不过滤、不重排。
#[tauri::command]
pub async fn debug_set_data_breakpoints(
    state: State<'_, Arc<AppState>>,
    target: String,
    breakpoints: Vec<debug::DataBreakpointSpec>,
) -> Result<Value, AppError> {
    ask_app(
        state.inner().clone(),
        DebugTarget::parse(&target).map_err(|e| AppError::input("debug.badTarget", e))?,
        "setDataBreakpoints",
        debug::data_breakpoints_args(&breakpoints),
        Duration::from_secs(15),
    )
    .await
}
