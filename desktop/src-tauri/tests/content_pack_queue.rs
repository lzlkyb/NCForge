use nc_forge::content_pack::{current_for, ensure};
use std::time::{Duration, Instant};

// The worker and cache directory are process-wide. Exercise the real queue in
// its own test binary so other search fixtures cannot change the cache directory.
#[test]
fn background_queue_wakes_for_later_work() {
    let base = tempfile::tempdir().unwrap();
    for _ in 0..2 {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("A.java"), b"class A {}").unwrap();
        ensure(root.path(), base.path());
        let deadline = Instant::now() + Duration::from_secs(5);
        while current_for(root.path()).is_none() {
            assert!(Instant::now() < deadline, "pack queue stalled");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
