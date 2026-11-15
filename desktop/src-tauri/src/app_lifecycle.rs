//! Synchronous final cleanup: the event loop cannot await child shutdown after Exit.
use crate::{ecj_worker, java_run::JavaRuns, state::AppState};
use std::sync::Arc;
use tauri::Manager;

pub fn shutdown(app: &tauri::AppHandle) {
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
    }
}
