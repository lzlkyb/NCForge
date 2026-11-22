//! Synchronous final cleanup: the event loop cannot await child shutdown after Exit.
use crate::{ecj_worker, java_run::JavaRuns, state::AppState};
use std::sync::Arc;
use tauri::Manager;

pub fn shutdown(app: &tauri::AppHandle) {
    // 先清「异常退出」标记：这一步不能放在后面，否则任何一次子进程清理卡住或 panic，
    // 都会让下次启动误报「上次崩溃」。正常退出路径必须覆盖更新重启（也走 Exit）。
    if let Some(state) = app.try_state::<Arc<AppState>>() {
        crate::crash::end_session(&state.config_dir);
    }
    if let Some(jobs) = app.try_state::<JavaRuns>() {
        jobs.cancel_all();
    }
    if let Some(state) = app.try_state::<Arc<AppState>>() {
        if let Some(session) = state
            .lang
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .session
            .take()
        {
            session.client.kill();
        }
        let sessions = {
            let mut debug = state.debug.lock().unwrap_or_else(|e| e.into_inner());
            [
                debug.server.session.take(),
                debug.client.session.take(),
                debug.remote.session.take(),
            ]
        };
        for session in sessions.into_iter().flatten() {
            session.client.kill();
        }
        // Database child shutdown also releases the server's uncommitted transaction.
        let bridges: Vec<_> = state
            .db
            .lock()
            .map(|mut map| map.drain().map(|(_, bridge)| bridge).collect())
            .unwrap_or_default();
        for bridge in bridges {
            bridge.shutdown();
        }
        ecj_worker::shutdown_all();
        // 常驻 binding resolver 的 Holder 是进程级 static，永不 drop ⇒ Bridge 的
        // Drop 不会跑；不在这里显式杀，退出时那个 768MB 的 java 子进程会成孤儿。
        crate::bind_resolver::shutdown();
    }
}
