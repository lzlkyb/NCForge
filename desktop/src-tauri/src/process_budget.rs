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
/// 不直接用 `AtomicU64::fetch_update`：新版 stable 已把它标记 deprecated（改名
/// `try_update`），`-D warnings` 下弃用警告会变成编译错误；而本地工具链较旧时
/// 又不能直接换成新名字。手写 CAS 循环在两边都稳定，语义与 fetch_update 一致：
/// 成功返回加之前的旧值，超预算（含溢出）返回当前值。
fn reserve(counter: &AtomicU64, amount: u64) -> Result<u64, u64> {
    let mut used = counter.load(Ordering::Acquire);
    loop {
        let next = match used.checked_add(amount) {
            Some(next) if next <= LIMIT_MB => next,
            _ => return Err(used),
        };
        match counter.compare_exchange_weak(used, next, Ordering::AcqRel, Ordering::Acquire) {
            Ok(_) => return Ok(used),
            Err(actual) => used = actual,
        }
    }
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
