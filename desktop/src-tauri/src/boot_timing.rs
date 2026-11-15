//! 冷启动基线：进程启动 → 前端首帧。
//!
//! 为什么起点必须在 Rust 的 `main()`：`performance.now()` 的 0 点是 document start，
//! 不含进程创建、单实例插件探测与 WebView2 初始化——而那正是冷启动的大头。
//! 只有把起点放在进程第一行，报出来的数字才是用户体感的那一段。
//!
//! 只记日志、不加任何等待：这条打点在首帧之后执行，不在启动路径上。

use std::sync::OnceLock;
use std::time::Instant;

static PROCESS_START: OnceLock<Instant> = OnceLock::new();

/// `main()` 第一件事调这个。重复调用无副作用（只认第一次）。
pub fn mark_process_start() {
    let _ = PROCESS_START.set(Instant::now());
}

/// 前端报到首帧。返回进程启动到此刻的毫秒数；起点没记过（测试环境）时返回 `None`。
pub fn first_frame(frontend_ms: f64) -> Option<u64> {
    let start = PROCESS_START.get()?;
    let total = start.elapsed().as_millis() as u64;
    log::info!("冷启动：进程启动 → 前端首帧 {total} ms（其中前端自报 {frontend_ms:.0} ms）");
    Some(total)
}

/// 启动分段：目录树 / 索引就绪 / 首批诊断。
///
/// 「首屏可编辑」那一段不在这里——它由 [`first_frame`] 记（同一个时刻），
/// 白名单里再放一个 `editable` 只会让同一时刻出现两条日志，读的人要去比对哪个才算。
/// 白名单固定三个名字：前端传错既不报错也不记，避免日志里冒出拼错的阶段名。
pub const STAGES: [&str; 3] = ["tree", "index", "diag"];

/// 记一段。返回进程启动到该段的毫秒数；起点没记过或段名不在白名单时返回 `None`。
pub fn stage(name: &str, frontend_ms: f64) -> Option<u64> {
    let start = PROCESS_START.get()?;
    if !STAGES.contains(&name) {
        return None;
    }
    let total = start.elapsed().as_millis() as u64;
    log::info!("启动分段：进程启动 → {name} {total} ms（其中前端自报 {frontend_ms:.0} ms）");
    Some(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 没走 `main()` 的进程（单元测试）不能假装有基线：返回 None，别报一个假的 0。
    #[test]
    fn 未标记起点时返回_none() {
        // 这个测试进程里 mark_process_start 可能被别的用例调过，所以只验「不 panic 且不编造」
        if PROCESS_START.get().is_none() {
            assert_eq!(first_frame(12.0), None);
        }
    }

    /// 标了起点之后必须给出一个非零且单调的量级（同一进程内第二次不会更小）。
    #[test]
    fn 标记之后给出总耗时() {
        mark_process_start();
        let a = first_frame(12.0).expect("标记后应有基线");
        std::thread::sleep(std::time::Duration::from_millis(2));
        let b = first_frame(12.0).expect("标记后应有基线");
        assert!(b >= a, "总耗时应单调不减：{a} → {b}");
    }

    /// 段名拼错了要静默丢掉：宁可少一行日志，也不要日志里出现拼错的阶段名。
    #[test]
    fn 未知段名不记() {
        mark_process_start();
        assert_eq!(stage("editble", 1.0), None);
        assert_eq!(stage("", 1.0), None);
        // 「首屏」由 first_frame 记，不在分段白名单里——重复记同一时刻会让日志对不上账
        assert_eq!(stage("editable", 1.0), None);
        assert!(stage("index", 1.0).is_some());
    }
}
