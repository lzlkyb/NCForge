//! 调试适配器的事件处理器：把适配器事件转成前端事件，并做状态收尾。
//!
//! 从 `debug_cmds.rs` 拆出（体量门禁）：命令层不该同时装着「一条命令怎么发」
//! 和「适配器说话时怎么接」两件事。这里只依赖 `debug_cmds` 的两个小助手
//! （`lock_debug` / `emit_status`），不依赖任何命令。
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::Emitter;

use super::debug_cmds::lock_debug;
use crate::debug::{DebugStatus, DebugTarget};
use crate::lang::LangSession;
use crate::state::AppState;

/// 把某个目标当前的状态推给前端（`debug-status` 事件）。
pub fn emit_status(app: &tauri::AppHandle, state: &AppState, target: DebugTarget) {
    let status = lock_debug(state).slot_ref(target).status.clone();
    let _ = app.emit("debug-status", status);
}

/// 适配器事件处理器：路径映射与状态收尾都在这。
pub struct Handler {
    pub app: tauri::AppHandle,
    pub state: Arc<AppState>,
    pub target: DebugTarget,
    /// 连接代数（见 `TargetRun::generation`）。
    pub generation: u64,
    pub lang: Arc<LangSession>,
}

impl Handler {
    /// 会话结束（目标退出 / 适配器断开 / 主动停止的收尾）：只有当前这一代才动状态。
    fn finish(&self, message: &str) {
        let cleared = {
            let mut run = lock_debug(&self.state);
            let slot = run.slot(self.target);
            if slot.generation == self.generation && slot.session.is_some() {
                slot.session = None;
                slot.status = DebugStatus::stopped(self.target);
                slot.status.message = message.to_string();
                true
            } else {
                false
            }
        };
        if cleared {
            emit_status(&self.app, &self.state, self.target);
        }
    }
}

impl crate::debug::DapHandler for Handler {
    fn on_event(&self, event: &str, body: Value) {
        // 目标退出后适配器连接仍在，主动收尾，别让界面停在「已暂停」
        if event == "terminated" {
            self.finish("调试目标已结束");
        }
        // breakpoint 等事件里的 source.path 也是普通路径，要和请求回包走同一条映射
        let body = self.lang.from_server_paths(&self.lang.from_server(&body));
        let _ = self.app.emit(
            "debug-event",
            json!({ "target": self.target, "event": event, "body": body }),
        );
    }

    fn on_exit(&self, reason: &str) {
        self.finish(reason);
    }
}
