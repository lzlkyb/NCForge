//! Rust 侧崩溃现场：panic 落盘 + 异常退出标记。
//!
//! 🔴 为什么必须做：前端崩了有 `ErrorBoundary` 三层 + `frontend_log` 落盘，用户还能点
//! 「复制错误信息」；**Rust 侧 panic 则是进程直接消失**——窗口没了，`env_logger` 只往
//! stderr 打（release 构建 `windows_subsystem="windows"` 根本没有控制台），一行字都留不下。
//! 用户能提供的唯一信息是「刚点了一下就没了」。
//!
//! 🔴 为什么不能只加日志文件而不加 hook：`env_logger` 没有文件 appender，而且
//! panic 是**绕开日志系统**的（panic 走 hook，不走 `log::error!`）。必须 `set_hook`。
//!
//! 设计约束（每条都对应一次真实的踩坑方式）：
//! - **hook 里绝不能再 panic**：Rust 检测到「panic 中的 panic」会直接 `abort`，
//!   那时连 stderr 都没有。整个写盘过程包在 `catch_unwind` 里。
//! - **拿不到锁就跳过写盘**：用 `try_lock`，不用 `lock`。若 panic 恰好发生在持锁线程，
//!   `lock` 会永久阻塞，界面直接冻死——比丢一条日志严重得多。
//! - **保留默认 hook**：先 `take_hook()` 存下默认实现，自定义 hook 里先调它，
//!   否则开发时控制台再也看不到 panic 输出。
//! - **去重按「第一条」计时**：5 秒窗口内同指纹只写一条，且**不刷新窗口**。
//!   若按最后一条刷新，持续 panic 的循环会把自己永久压掉，一条都留不下。
//! - **异常退出不夸大成崩溃**：marker 残留只说明「没走正常退出」，
//!   可能是断电、任务管理器强杀、Ctrl+C。只有**确有 panic 记录**才提示用户，
//!   否则更新重启与开发时反复中断都会变成误报（状态诚实原则）。

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// panic 日志上限。panic 不是高频事件，1 MiB 足够存上百条。
const MAX_LOG_BYTES: u64 = 1024 * 1024;
/// 单条上限：backtrace 在 release 下可能很长，截断避免一条撑爆配额。
const MAX_ENTRY_BYTES: usize = 16 * 1024;
/// 同指纹去重窗口。
const DEDUP_WINDOW: Duration = Duration::from_secs(5);
/// 去重表容量上限：panic 风暴时不无限增长。
const DEDUP_SLOTS: usize = 200;
/// backtrace 最多保留多少字节（超出部分没有定位价值，只会让包变大）。
const MAX_BACKTRACE_BYTES: usize = 8 * 1024;

static CONFIG_DIR: OnceLock<PathBuf> = OnceLock::new();
static SEEN: Mutex<Vec<(u64, Instant)>> = Mutex::new(Vec::new());
static HOOK_INSTALLED: AtomicBool = AtomicBool::new(false);
/// 本次启动时看到的「上次运行痕迹」。`begin_session` 会覆盖 marker，
/// 所以必须在这里留一份给诊断包用。
static PREV_RUN: Mutex<Option<PreviousRun>> = Mutex::new(None);

pub fn log_path(config_dir: &Path) -> PathBuf {
    config_dir.join("logs").join("rust-panic.log")
}

pub fn marker_path(config_dir: &Path) -> PathBuf {
    config_dir.join("logs").join(".session-running")
}

/// 记下配置目录，供 hook 使用。hook 可能在 `setup` 之前就触发（甚至早于窗口创建），
/// 那之前只能写 stderr——所以这里用 `OnceLock` 而不是参数传递。
pub fn set_config_dir(dir: &Path) {
    let _ = CONFIG_DIR.set(dir.to_path_buf());
}

/// 安装 panic hook。**必须在 `main` 里尽早调用**，且只装一次（重复调用无副作用）。
///
/// 注意：`check-boot-path.mjs` 要求 `fn main` 第一句是 `boot_timing::mark_process_start()`，
/// 所以本函数只能排在其后。它不做任何 IO，不影响启动耗时。
pub fn install_hook() {
    if HOOK_INSTALLED.swap(true, Ordering::SeqCst) {
        return;
    }
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // 先保留默认行为：开发时控制台必须还能看到 panic。
        default_hook(info);
        // 🔴 从这里往下任何一步都不能把异常再抛出去。
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            record_panic(info);
        }));
    }));
}

/// 把一次 panic 组装成可读文本（纯函数，便于脱库单测）。
pub fn format_panic(
    message: &str,
    location: Option<(&str, u32, u32)>,
    thread: Option<&str>,
    backtrace: Option<&str>,
) -> String {
    let stamp = now_ms();
    let mut out = format!("[{stamp}] [rust] thread={}\n", thread.unwrap_or("unnamed"));
    out.push_str(message.trim());
    out.push('\n');
    match location {
        Some((file, line, col)) => out.push_str(&format!("    at {file}:{line}:{col}\n")),
        // 没有位置信息时明说，否则读日志的人会以为被截断了。
        None => out.push_str("    at <未知位置>\n"),
    }
    if let Some(bt) = backtrace.filter(|b| !b.trim().is_empty()) {
        out.push_str("--- backtrace ---\n");
        let clipped = if bt.len() > MAX_BACKTRACE_BYTES {
            let mut end = MAX_BACKTRACE_BYTES;
            while end > 0 && !bt.is_char_boundary(end) {
                end -= 1;
            }
            format!("{}\n…[backtrace 已截断]\n", &bt[..end])
        } else {
            format!("{bt}\n")
        };
        out.push_str(&clipped);
    }
    out
}

fn record_panic(info: &std::panic::PanicHookInfo<'_>) {
    let message = if let Some(s) = info.payload().downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = info.payload().downcast_ref::<String>() {
        s.clone()
    } else {
        "<非字符串 panic 载荷>".to_string()
    };
    let location = info.location().map(|l| (l.file(), l.line(), l.column()));
    let thread = std::thread::current().name().map(|s| s.to_string());
    if !should_write(
        fingerprint(&message) ^ fingerprint(location.map(|l| l.0).unwrap_or("")),
        Instant::now(),
    ) {
        return;
    }
    // backtrace 只在真的要写盘时才抓：`force_capture` 有明显开销，
    // 且 release 构建没有 debug info 时它给你的只是一串地址。
    let bt = std::backtrace::Backtrace::force_capture().to_string();
    let text = format_panic(&message, location, thread.as_deref(), Some(&bt));
    if let Some(dir) = CONFIG_DIR.get() {
        let _ = append(dir, &text);
    }
}

/// 同指纹去重判据。**窗口从第一条算起，不刷新**——否则持续 panic 会被永久压掉。
///
/// 抽成独立函数是为了能在单测里喂假的 `Instant`，不必真的等 5 秒。
pub fn should_write_in(seen: &mut Vec<(u64, Instant)>, fp: u64, now: Instant) -> bool {
    seen.retain(|(_, t)| now.saturating_duration_since(*t) < DEDUP_WINDOW);
    if seen.iter().any(|(f, _)| *f == fp) {
        return false;
    }
    seen.push((fp, now));
    if seen.len() > DEDUP_SLOTS {
        seen.remove(0);
    }
    true
}

fn should_write(fp: u64, now: Instant) -> bool {
    // 🔴 拿不到锁就放行（写一条总比死锁好）：panic 可能发生在持锁线程里。
    match SEEN.try_lock() {
        Ok(mut seen) => should_write_in(&mut seen, fp, now),
        Err(_) => true,
    }
}

/// FNV-1a。不引依赖：只需要一个稳定的短指纹，不需要抗碰撞。
pub fn fingerprint(text: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in text.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// 追加一条 panic 记录，超上限轮转为 `.1`。
pub fn append(config_dir: &Path, text: &str) -> Result<(), String> {
    let path = log_path(config_dir);
    let dir = path.parent().ok_or("日志目录无效")?;
    fs::create_dir_all(dir).map_err(|e| format!("建日志目录失败: {e}"))?;

    let body = clamp(text);
    let current = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    if current.saturating_add(body.len() as u64) > MAX_LOG_BYTES {
        // 轮转失败不阻断写入：宁可这份略超限，也不能把这条崩溃记录丢掉。
        let _ = fs::rename(&path, dir.join("rust-panic.log.1"));
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("写 panic 日志失败: {e}"))?;
    file.write_all(body.as_bytes())
        .map_err(|e| format!("写 panic 日志失败: {e}"))?;
    Ok(())
}

fn clamp(text: &str) -> String {
    if text.len() <= MAX_ENTRY_BYTES {
        return text.to_string();
    }
    let mut end = MAX_ENTRY_BYTES;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n…[已截断]\n", &text[..end])
}

/// 上一次运行留下的痕迹。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreviousRun {
    /// 上次标记写入时刻（unix ms）。
    pub started_at_ms: u64,
    /// 上次是否**确有 panic 记录**。只有它为真才值得提示用户。
    pub had_panic: bool,
}

/// 开始本次会话：读旧标记 → 写新标记。
///
/// 返回 `None` 表示上次是干净退出（或首次运行）。
pub fn begin_session(config_dir: &Path) -> Option<PreviousRun> {
    let marker = marker_path(config_dir);
    let previous = fs::read_to_string(&marker)
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .map(|started_at_ms| PreviousRun {
            started_at_ms,
            had_panic: panic_newer_than(config_dir, started_at_ms),
        });
    if let Some(dir) = marker.parent() {
        let _ = fs::create_dir_all(dir);
    }
    // 先读后写：顺序反了会把旧标记抹掉，异常退出永远检测不到。
    let _ = fs::write(&marker, now_ms().to_string());
    if let Ok(mut slot) = PREV_RUN.lock() {
        *slot = previous.clone();
    }
    previous
}

/// 上次运行的痕迹（本次启动时读到的）。诊断包与状态栏共用这一份。
pub fn previous_run() -> Option<PreviousRun> {
    PREV_RUN.lock().ok().and_then(|slot| slot.clone())
}

/// 正常退出时清标记。挂在 `RunEvent::Exit` 上——**必须覆盖更新重启路径**，
/// 否则每次升完版本首次启动都会报「上次未正常退出」。
pub fn end_session(config_dir: &Path) {
    let _ = fs::remove_file(marker_path(config_dir));
}

/// panic 日志的 mtime 是否晚于给定时刻。
fn panic_newer_than(config_dir: &Path, started_at_ms: u64) -> bool {
    let Ok(meta) = fs::metadata(log_path(config_dir)) else {
        return false;
    };
    let Ok(modified) = meta.modified() else {
        return false;
    };
    let mtime_ms = modified
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    mtime_ms > started_at_ms
}

/// 读 panic 日志尾部（给状态栏与诊断包用）。不存在时返回空串而非报错。
pub fn read_tail(config_dir: &Path, max_bytes: usize) -> String {
    let Ok(bytes) = fs::read(log_path(config_dir)) else {
        return String::new();
    };
    let mut start = bytes.len().saturating_sub(max_bytes);
    while start > 0 && (bytes[start] & 0xC0) == 0x80 {
        start -= 1;
    }
    String::from_utf8_lossy(&bytes[start..]).into_owned()
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        crate::test_support::tmp(tag)
    }

    #[test]
    fn 记录里有消息位置与线程() {
        let line = format_panic(
            "index out of bounds",
            Some(("src/db_rust.rs", 1234, 7)),
            Some("db-pool"),
            None,
        );
        assert!(line.contains("[rust]"));
        assert!(line.contains("thread=db-pool"));
        assert!(line.contains("index out of bounds"));
        assert!(
            line.contains("src/db_rust.rs:1234:7"),
            "行号是排障第一手证据，缺了就白记：{line}"
        );
    }

    #[test]
    fn 没有位置信息时明说而不是留空() {
        let line = format_panic("boom", None, None, None);
        assert!(line.contains("<未知位置>"), "留空会被读成「被截断了」");
        assert!(line.contains("thread=unnamed"));
    }

    #[test]
    fn 超长_backtrace_截断且不切坏字符() {
        let bt = format!("x{}", "栈".repeat(MAX_BACKTRACE_BYTES));
        let line = format_panic("panic", None, None, Some(&bt));
        assert!(line.contains("已截断"));
        assert!(
            line.len() < MAX_BACKTRACE_BYTES + 1024,
            "实测 {}",
            line.len()
        );
        // 真能当 UTF-8 读（截断点必须落在字符边界）
        assert!(!String::from_utf8(line.into_bytes())
            .unwrap()
            .contains('\u{FFFD}'));
    }

    #[test]
    fn 去重窗口按第一条算且不刷新() {
        let t0 = Instant::now();
        let mut seen = Vec::new();
        assert!(should_write_in(&mut seen, 7, t0));
        // 2 秒后再来同一个：压掉，且**不刷新**窗口起点
        assert!(!should_write_in(&mut seen, 7, t0 + Duration::from_secs(2)));
        // 距第一条 5 秒整：窗口已满，允许再写一条
        assert!(should_write_in(&mut seen, 7, t0 + Duration::from_secs(5)));
        // 不同指纹互不影响
        assert!(should_write_in(&mut seen, 8, t0 + Duration::from_secs(5)));
    }

    /// 去重表天然有界（只留窗口内的），但**窗口内的 panic 风暴**仍要靠容量上限兜住。
    /// 🔴 夹具必须全部落在 5 秒窗口内：隔着窗口喂数据会被 `retain` 清空，
    /// 那样测的是「窗口裁剪」而不是「容量上限」，永远只有 1 条。
    #[test]
    fn 去重表不会无限增长() {
        let t0 = Instant::now();
        let mut seen = Vec::new();
        for i in 0..(DEDUP_SLOTS as u64 + 50) {
            should_write_in(&mut seen, i, t0 + Duration::from_millis(i));
        }
        assert_eq!(seen.len(), DEDUP_SLOTS, "实测 {}", seen.len());
    }

    #[test]
    fn 指纹稳定且区分大小写() {
        assert_eq!(fingerprint("abc"), fingerprint("abc"));
        assert_ne!(fingerprint("abc"), fingerprint("ABC"));
        assert_ne!(fingerprint(""), fingerprint(" "));
    }

    #[test]
    fn 写盘可用且轮转只留一份历史() {
        let dir = tmp("crash-rotate");
        let chunk = format_panic(&"x".repeat(MAX_ENTRY_BYTES * 2), None, None, None);
        let rounds = (MAX_LOG_BYTES as usize / MAX_ENTRY_BYTES) + 2;
        for _ in 0..rounds {
            append(&dir, &chunk).unwrap();
        }
        assert!(
            dir.join("logs").join("rust-panic.log.1").exists(),
            "超上限必须轮转"
        );
        let names: Vec<String> = fs::read_dir(dir.join("logs"))
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
            .collect();
        assert_eq!(names.len(), 2, "只留当前 + 一份历史，实测 {names:?}");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn 单条超长按字符边界截断() {
        let dir = tmp("crash-clamp");
        // 前置 1 个 ASCII 让截断点落在字符中间（同 frontend_log 的夹具教训）
        let text = format!("x{}", "崩".repeat(MAX_ENTRY_BYTES));
        append(&dir, &text).unwrap();
        let raw = fs::read(log_path(&dir)).unwrap();
        let s = String::from_utf8(raw).expect("不能切出半个字符");
        assert!(s.len() <= MAX_ENTRY_BYTES + 32, "实测 {}", s.len());
        assert!(s.contains("已截断"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn 第一次运行没有上次痕迹() {
        let dir = tmp("crash-first");
        assert_eq!(begin_session(&dir), None);
        assert!(marker_path(&dir).exists(), "本次的标记必须写下去");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn 标记残留但没_panic_时不判崩溃() {
        let dir = tmp("crash-nopanic");
        // 模拟上次留下标记
        fs::create_dir_all(dir.join("logs")).unwrap();
        let old = now_ms().saturating_sub(60_000);
        fs::write(marker_path(&dir), old.to_string()).unwrap();
        let prev = begin_session(&dir).expect("标记在就该报上次痕迹");
        assert_eq!(prev.started_at_ms, old);
        assert!(
            !prev.had_panic,
            "没有 panic 记录就不该说人家崩溃（断电/强杀/Ctrl+C 都会留标记）"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn 标记之后有_panic_才判崩溃() {
        let dir = tmp("crash-withpanic");
        fs::create_dir_all(dir.join("logs")).unwrap();
        let old = now_ms().saturating_sub(60_000);
        fs::write(marker_path(&dir), old.to_string()).unwrap();
        append(&dir, "boom\n").unwrap();
        let prev = begin_session(&dir).expect("标记在就该报上次痕迹");
        assert!(prev.had_panic, "panic 日志比标记新，必须判为崩溃");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn 正常退出清掉标记() {
        let dir = tmp("crash-clean");
        begin_session(&dir);
        assert!(marker_path(&dir).exists());
        end_session(&dir);
        assert!(!marker_path(&dir).exists(), "正常退出必须清标记");
        assert_eq!(begin_session(&dir), None);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn 没有日志时读尾部返回空() {
        let dir = tmp("crash-empty");
        assert_eq!(read_tail(&dir, 1024), "");
    }

    #[test]
    fn 读尾部不切坏首字符() {
        let dir = tmp("crash-tail");
        append(&dir, &"前".repeat(500)).unwrap();
        append(&dir, "最后一条\n").unwrap();
        let tail = read_tail(&dir, 65);
        assert!(tail.contains("最后一条"));
        assert!(!tail.contains('\u{FFFD}'), "首字符被切一半：{tail}");
        fs::remove_dir_all(&dir).unwrap();
    }
}
