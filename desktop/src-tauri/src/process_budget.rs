//! JVM heap admission, with per-process native headroom. This is not RSS accounting.
use std::sync::atomic::{AtomicU64, Ordering};
const LIMIT_MB: u64 = 6144;
static RESERVED: AtomicU64 = AtomicU64::new(0);
pub struct Reservation(u64);
impl Reservation {
    pub fn acquire(heap_mb: u32) -> Result<Self, String> {
        let amount = u64::from(heap_mb) + 256;
        reserve(&RESERVED, amount)
            .map(|_| Self(amount))
            .map_err(|_| {
                "后台 Java 进程内存预算已满，请停止暂不使用的语言服务或数据库连接后重试".into()
            })
    }
}
fn reserve(counter: &AtomicU64, amount: u64) -> Result<u64, u64> {
    counter.fetch_update(Ordering::AcqRel, Ordering::Acquire, |used| {
        used.checked_add(amount).filter(|next| *next <= LIMIT_MB)
    })
}
impl Drop for Reservation {
    fn drop(&mut self) {
        RESERVED.fetch_sub(self.0, Ordering::AcqRel);
    }
}
#[cfg(test)]
mod tests {
    #[test]
    fn aggregate_budget_rejects_then_accepts_after_release() {
        let used = super::AtomicU64::new(0);
        assert!(super::reserve(&used, 4096).is_ok());
        assert!(super::reserve(&used, 2049).is_err());
        assert_eq!(used.load(super::Ordering::Acquire), 4096);
        used.fetch_sub(4096, super::Ordering::AcqRel);
        assert!(super::reserve(&used, 6144).is_ok());
    }
    #[test]
    fn oversized_process_is_rejected() {
        assert!(super::Reservation::acquire(6144).is_err());
    }
}
