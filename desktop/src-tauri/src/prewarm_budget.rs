//! Cross-index background I/O admission. Foreground commands never wait on this gate.
use std::sync::{Mutex, MutexGuard};
static GATE: Mutex<()> = Mutex::new(());
pub fn acquire() -> MutexGuard<'static, ()> {
    // Give the first frame and session restoration a head start.
    std::thread::sleep(std::time::Duration::from_millis(750));
    GATE.lock().unwrap_or_else(|e| e.into_inner())
}
#[cfg(test)]
mod tests {
    #[test]
    fn only_one_background_index_can_run() {
        let _guard = super::GATE.lock().unwrap();
        assert!(super::GATE.try_lock().is_err());
    }
}
