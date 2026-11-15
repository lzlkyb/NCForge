use std::sync::Arc;
use std::time::Duration;

use crate::debug::{self, DebugTarget};
use crate::state::AppState;
use serde_json::Value;

/// java-debug 0.32 settings are shared by targets using the same language service.
#[tauri::command]
pub async fn debug_set_step_filters(
    state: tauri::State<'_, Arc<AppState>>,
    target: String,
    filters: Vec<String>,
) -> Result<Value, String> {
    if filters.len() > 64
        || filters.iter().any(|f| {
            f.len() > 200
                || f.is_empty()
                || !f
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "_.$*".contains(c))
        })
    {
        return Err("无效的步进过滤规则：最多 64 条 Java 包名模式".into());
    }
    let target = DebugTarget::parse(&target)?;
    let session = state
        .debug
        .lock()
        .map_err(|_| "调试状态异常")?
        .slot_ref(target)
        .session
        .clone()
        .ok_or("当前目标尚未附加调试器")?;
    tauri::async_runtime::spawn_blocking(move || {
        let current = session.lang.client.request(
            "workspace/executeCommand",
            debug::read_debug_settings_args(),
            Duration::from_secs(15),
        )?;
        let args = debug::update_step_filters_args(current, &filters)?;
        let reply = session.lang.client.request(
            "workspace/executeCommand",
            args,
            Duration::from_secs(15),
        )?;
        debug::verify_step_filters_reply(reply, &filters)
    })
    .await
    .map_err(|e| format!("设置步进过滤后台任务失败：{e}"))?
}
