//! One-transfer cancellation lifetime and the driver's exact-limit EOF contract.
use crate::state::AppState;
use serde_json::Value;
use std::sync::{atomic::AtomicBool, Arc};

pub(crate) struct CancelRegistration {
    state: Arc<AppState>,
    id: u64,
    pub(crate) token: Arc<AtomicBool>,
}
impl CancelRegistration {
    pub(crate) fn register(state: Arc<AppState>, id: u64) -> Result<Self, String> {
        let token = Arc::new(AtomicBool::new(false));
        {
            let mut map = state
                .export_cancels
                .lock()
                .map_err(|_| "导出取消状态异常")?;
            if map.contains_key(&id) {
                return Err("这个导出实例已经在运行".into());
            }
            map.insert(id, token.clone());
        }
        Ok(Self { state, id, token })
    }
}
impl Drop for CancelRegistration {
    fn drop(&mut self) {
        let mut map = self
            .state
            .export_cancels
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if map
            .get(&self.id)
            .is_some_and(|t| Arc::ptr_eq(t, &self.token))
        {
            map.remove(&self.id);
        }
    }
}
pub(crate) fn probe_has_more(body: &Value) -> Result<bool, String> {
    let rows = body
        .get("rows")
        .and_then(Value::as_array)
        .ok_or("数据库桥未返回结果行")?;
    if rows.is_empty() && body.get("hasMore").and_then(Value::as_bool) == Some(true) {
        return Err("数据库桥返回空页却声称仍有数据，已停止导出".into());
    }
    Ok(!rows.is_empty())
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::Ordering;
    #[test]
    fn cancellation_isolated_and_registration_released_on_error() {
        let d = tempfile::tempdir().unwrap();
        let st = AppState::new(crate::config::AppConfig::default(), d.path().to_path_buf());
        let a = CancelRegistration::register(st.clone(), 1).unwrap();
        let b = CancelRegistration::register(st.clone(), 2).unwrap();
        a.token.store(true, Ordering::SeqCst);
        assert!(!b.token.load(Ordering::SeqCst));
        assert!(CancelRegistration::register(st.clone(), 1).is_err());
        drop(a);
        assert!(!st.export_cancels.lock().unwrap().contains_key(&1));
        drop(b);
        assert!(st.export_cancels.lock().unwrap().is_empty());
    }
    #[test]
    fn exact_limit_eof_complete_and_extra_row_partial() {
        assert!(!probe_has_more(&json!({"rows":[],"hasMore":false})).unwrap());
        assert!(probe_has_more(&json!({"rows":[[1]],"hasMore":true})).unwrap());
        assert!(probe_has_more(&json!({"rows":[],"hasMore":true})).is_err());
        assert!(probe_has_more(&json!({})).is_err());
    }
}
