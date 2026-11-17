//! 冷启动基线：进程启动 → 前端首帧。
//!
//! 为什么起点必须在 Rust 的 `main()`：`performance.now()` 的 0 点是 document start，
//! 不含进程创建、单实例插件探测与 WebView2 初始化——而那正是冷启动的大头。
//! 只有把起点放在进程第一行，报出来的数字才是用户体感的那一段。
//!
//! 只记日志、不加任何等待：这条打点在首帧之后执行，不在启动路径上。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

static PROCESS_START: OnceLock<Instant> = OnceLock::new();

/// 首帧总耗时。诊断包要带走这个数，不能只让它躺在日志里。
///
/// 🔴 **不能用 0 当「还没到首帧」的哨兵**：机器够快时首帧就是 0 ms，
/// 那样合法的 0 会被读成「没记录」，诊断包里凭空少一项。用独立布尔位表达「有没有」。
static FIRST_FRAME_MS: AtomicU64 = AtomicU64::new(0);
static FIRST_FRAME_SET: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// 各段耗时。只存白名单内的段名，重复调用同一段时**保留第一次**——
/// 同一个段被触发两次说明调用方有问题，取首次才能反映真实启动路径。
static STAGES_MS: Mutex<Vec<(&'static str, u64)>> = Mutex::new(Vec::new());

/// `main()` 第一件事调这个。重复调用无副作用（只认第一次）。
pub fn mark_process_start() {
    let _ = PROCESS_START.set(Instant::now());
}

/// 前端报到首帧。返回进程启动到此刻的毫秒数；起点没记过（测试环境）时返回 `None`。
pub fn first_frame(frontend_ms: f64) -> Option<u64> {
    let start = PROCESS_START.get()?;
    let total = start.elapsed().as_millis() as u64;
    if FIRST_FRAME_SET
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        FIRST_FRAME_MS.store(total, Ordering::SeqCst);
    }
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
    // 从白名单里取出 `&'static str`：这样快照里存的是编译期字面量，不会有生命周期问题。
    let known = STAGES.iter().find(|s| **s == name).copied()?;
    let total = start.elapsed().as_millis() as u64;
    if let Ok(mut slots) = STAGES_MS.lock() {
        record_stage(&mut slots, known, total);
    }
    log::info!("启动分段：进程启动 → {name} {total} ms（其中前端自报 {frontend_ms:.0} ms）");
    Some(total)
}

/// 记一段耗时。同一段第二次出现时**保留第一次**（取首次才反映真实启动路径）。
/// 返回是否真的写进去了，便于单测。
pub fn record_stage(slots: &mut Vec<(&'static str, u64)>, name: &'static str, ms: u64) -> bool {
    if slots.iter().any(|(n, _)| *n == name) {
        return false;
    }
    slots.push((name, ms));
    true
}

/// 启动耗时快照，供诊断包带走。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Snapshot {
    /// 进程启动 → 前端首帧。没到首帧时为 `None`（不是 0：0 会被读成「秒开」）。
    pub first_frame_ms: Option<u64>,
    pub stages: Vec<(&'static str, u64)>,
}

pub fn snapshot() -> Snapshot {
    Snapshot {
        first_frame_ms: if FIRST_FRAME_SET.load(Ordering::SeqCst) {
            Some(FIRST_FRAME_MS.load(Ordering::SeqCst))
        } else {
            None
        },
        stages: STAGES_MS.lock().map(|v| v.clone()).unwrap_or_default(),
    }
}

/// 启动历史文件（每行一条记录）。
pub fn history_path(config_dir: &std::path::Path) -> std::path::PathBuf {
    config_dir.join("boot-history.jsonl")
}

/// 保留的天数上限：40 条足够做中位数，也不会让文件长成没人看的样子。
const HISTORY_SLOTS: usize = 40;

/// 把本次启动写进历史。**只在首帧之后调用一次**，不在启动路径上。
///
/// 🔴 为什么必须落盘：`log::info!` 在 release 构建里根本没有控制台（`windows_subsystem`），
/// 启动耗时只存在于开发机的终端里。没有历史文件，「启动变慢了」就永远只能靠感觉。
/// 写盘失败一律吞掉——启动打点不该让应用开不起来。
pub fn append_history(config_dir: &std::path::Path) {
    let snap = snapshot();
    let Some(first) = snap.first_frame_ms else {
        return;
    };
    let stages: serde_json::Map<String, serde_json::Value> = snap
        .stages
        .iter()
        .map(|(k, v)| ((*k).to_string(), serde_json::json!(v)))
        .collect();
    let line = serde_json::json!({
        "ts": crate::crash::now_ms(),
        "firstFrameMs": first,
        "stages": stages,
    })
    .to_string();

    let path = history_path(config_dir);
    let mut lines: Vec<String> = std::fs::read_to_string(&path)
        .unwrap_or_default()
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| l.to_string())
        .collect();
    lines.push(line);
    if lines.len() > HISTORY_SLOTS {
        lines.drain(0..lines.len() - HISTORY_SLOTS);
    }
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&path, format!("{}\n", lines.join("\n")));
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

    /// 同一段被触发两次时保留首次：第二次多半是重试/重复渲染，记它会让启动看着变慢。
    #[test]
    fn 分段重复出现只保留第一次() {
        let mut slots: Vec<(&'static str, u64)> = Vec::new();
        assert!(record_stage(&mut slots, "tree", 120));
        assert!(!record_stage(&mut slots, "tree", 900), "第二次不该覆盖");
        assert_eq!(slots, vec![("tree", 120)]);
        assert!(record_stage(&mut slots, "index", 500));
        assert_eq!(slots.len(), 2);
    }

    /// 快照给诊断包用：报过首帧后必须有值。
    ///
    /// 🔴 不能断言「一开始是 None」：`FIRST_FRAME_SET` 是进程级静态，
    /// 同进程里别的用例可能已经报过首帧，那条断言会随执行顺序 flaky。
    /// 也**不能断言值 > 0**：机器够快时首帧就是 0 ms，那是合法值（这正是把
    /// 「有没有」与「是多少」拆成两个原子的原因）。
    #[test]
    fn 快照能取到首帧耗时() {
        mark_process_start();
        let _ = first_frame(1.0);
        assert!(snapshot().first_frame_ms.is_some(), "报过首帧就应有值");
    }

    /// 启动历史只保留最近 N 条：文件是给「看趋势」用的，不是审计日志。
    #[test]
    fn 启动历史滚动保留有限条数() {
        let dir = crate::test_support::tmp("boot-history");
        mark_process_start();
        let _ = first_frame(1.0);
        for _ in 0..(HISTORY_SLOTS + 5) {
            append_history(&dir);
        }
        let text = std::fs::read_to_string(history_path(&dir)).unwrap();
        let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
        assert_eq!(lines.len(), HISTORY_SLOTS, "实测 {}", lines.len());
        // 每行都必须是合法 JSON，否则脚本解析会在半路炸
        for line in &lines {
            let v: serde_json::Value = serde_json::from_str(line).expect("必须是合法 JSON");
            assert!(v["firstFrameMs"].is_u64() || v["firstFrameMs"].is_i64());
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
