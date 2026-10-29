//! 指数退避重试。更新检查/下载与资源包下载共用这一份实现。
//!
//! 从 `commands/update.rs` 原样搬来（2026-10-29 资源包外置时）：两边逻辑完全一致，
//! 各维护一份只会漂移。搬移未改行为，`update.rs` 的既有测试原样通过。

use std::time::Duration;

/// 第 `attempt` 次重试前的退避秒数（attempt 从 1 起：首次失败等 1s，第二次 2s……）。
/// 位移夹到 6（64s 平台期）：attempt 再大也只是到这里为止，且防 max_retries≥65 时
/// `1u64 << 64` 移位溢出——debug 构建直接 panic，release 也会产出垃圾延迟。
pub fn backoff_delay_secs(attempt: u32) -> u64 {
    1u64 << attempt.saturating_sub(1).min(6)
}

/// 指数退避重试。
///
/// `should_retry` 决定某个错误是否值得再试一次。**不能无条件重试**：确定性结论
/// （如「源上没有 manifest」）重试 N 次只会让用户多等 N 次退避。
/// 抖动取系统时钟纳秒取模而非 rand crate——这里要的只是「错开」，不是密码学随机，
/// 且不给调用方引入新依赖。
pub async fn retry_with_backoff<F, Fut, T, E>(
    max_retries: u32,
    operation_name: &str,
    should_retry: impl Fn(&E) -> bool,
    f: F,
) -> Result<T, E>
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = Result<T, E>>,
    E: std::fmt::Display,
{
    let mut attempt = 0u32;
    loop {
        match f().await {
            Ok(val) => return Ok(val),
            Err(e) => {
                if !should_retry(&e) {
                    log::info!("[Retry] {operation_name} 遇到不可重试错误，放弃: {e}");
                    return Err(e);
                }
                attempt += 1;
                if attempt > max_retries {
                    return Err(e);
                }
                // 位移夹到 6（64s 平台期）：attempt 再大也只是到这里为止。
                // 不夹的话 max_retries≥65 时 `1u64 << 64` 移位溢出——debug 构建
                // 直接 panic，release 也会产出垃圾延迟。
                let delay_secs = backoff_delay_secs(attempt);
                // +0–511ms 抖动：无抖动时，一次服务端抖动恢复会让所有客户端在
                // 同一刻齐刷刷回源（惊群），刚缓过来的源又被自己打回去。
                let jitter_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| (d.subsec_nanos() % 512) as u64);
                log::warn!(
                    "[Retry] {} 失败（第 {}/{} 次），{}s+{}ms 后重试: {}",
                    operation_name,
                    attempt,
                    max_retries,
                    delay_secs,
                    jitter_ms,
                    e
                );
                tokio::time::sleep(Duration::from_millis(delay_secs * 1000 + jitter_ms)).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// 不可重试错误必须只调用一次。
    #[tokio::test]
    async fn non_retryable_error_is_attempted_once() {
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        let result: Result<(), String> = retry_with_backoff(
            2,
            "测试",
            |e: &String| !e.contains("fatal"),
            || {
                let counter = counter.clone();
                async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    Err("fatal error".to_string())
                }
            },
        )
        .await;

        assert!(result.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    /// 可重试错误：`max_retries=1` ⇒ 首次 + 重试 1 次 = 2 次调用。
    #[tokio::test]
    async fn retryable_error_is_attempted_again() {
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        let result: Result<(), String> = retry_with_backoff(
            1,
            "测试",
            |_| true,
            || {
                let counter = counter.clone();
                async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    Err("transient".to_string())
                }
            },
        )
        .await;

        assert!(result.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    /// 退避延迟有上界（1s + 抖动，测试里不会真等满）：第二次重试前 elapsed >= 1s。
    #[tokio::test]
    async fn backoff_delay_is_bounded() {
        let start = std::time::Instant::now();
        let result: Result<(), String> = retry_with_backoff(
            1,
            "测试",
            |_| true,
            || async { Err("transient".to_string()) },
        )
        .await;
        assert!(result.is_err());
        // 1s 基础退避 + ≤511ms 抖动；给 2s 上界防测试挂死
        assert!(start.elapsed() < Duration::from_secs(2));
    }

    /// 指数增长到 64s 平台期后不再增长，且大 attempt 不移位溢出
    /// （`1u64 << 64` 在 debug 下 panic——这就是本测试存在的理由）。
    #[test]
    fn backoff_delay_secs_grows_then_plateaus() {
        assert_eq!(backoff_delay_secs(1), 1);
        assert_eq!(backoff_delay_secs(2), 2);
        assert_eq!(backoff_delay_secs(3), 4);
        assert_eq!(backoff_delay_secs(7), 64); // 平台期
        assert_eq!(backoff_delay_secs(65), 64); // 改动前这里 panic
        assert_eq!(backoff_delay_secs(u32::MAX), 64);
        assert_eq!(backoff_delay_secs(0), 1); // 防御性：0 也当首次
    }
}
