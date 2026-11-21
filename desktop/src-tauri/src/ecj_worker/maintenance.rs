use std::sync::Weak;

use super::{Bridge, POOL};

pub(crate) fn memory_processes() -> (Vec<Weak<Bridge>>, usize) {
    let Some((lock, _)) = POOL.get() else {
        return (Vec::new(), 0);
    };
    let pool = lock.lock().unwrap_or_else(|error| error.into_inner());
    (pool.workers.clone(), pool.idle.len())
}

pub(crate) fn release_idle() -> usize {
    let Some((lock, cv)) = POOL.get() else {
        return 0;
    };
    let idle = {
        let mut pool = lock.lock().unwrap_or_else(|error| error.into_inner());
        // Borrowed workers stay in the same generation and can finish their compilations.
        let idle = std::mem::take(&mut pool.idle);
        pool.total = pool.total.saturating_sub(idle.len());
        cv.notify_all();
        idle
    };
    let count = idle.len();
    for (_, bridge) in idle {
        bridge.shutdown();
    }
    count
}
