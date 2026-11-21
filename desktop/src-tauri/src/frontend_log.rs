//! 前端错误日志：把 WebView 里的崩溃/异常落盘，让排障不必依赖用户「记得点复制」。
//!
//! 🔴 为什么必须单独一条通道，不能复用 `server::append_log`：
//! 那个函数按 **GBK** 编码写盘（NC 中间件/客户端日志的约定，`-Dfile.encoding=GBK`）。
//! 前端错误里有 JS 堆栈、emoji、任意 Unicode，GBK 编不出来会被替换成 `?`，
//! 堆栈里的关键字符就丢了。这里固定 **UTF-8**，与 NC 日志分开存。
//!
//! 🔴 为什么前端崩溃以前查不到：`ErrorBoundary.componentDidCatch` 只 `console.error`，
//! 用户点一次「重新加载」现场就没了；`operations.ts` 也不持久化，重启即丢。
//! 结果是「用户说刚才报错了」而我们拿不到任何堆栈。
//!
//! 设计约束：
//! - **绝不阻断 UI**：写日志失败只回错误，调用方 fire-and-forget。
//! - **有界**：单文件超过 `MAX_BYTES` 就轮转成 `.1`（与 `service_log` 同命名），
//!   只留一份历史，磁盘占用上限 = 2 × MAX_BYTES。
//! - **单条有界**：一条超长堆栈（递归爆栈能到几 MB）先截断再写，避免一条撑爆配额。

use crate::app_error::AppError;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

/// 单个日志文件上限。前端错误不是高频流，2 MiB 足够存几千条堆栈。
pub const MAX_BYTES: u64 = 2 * 1024 * 1024;

/// 单条记录上限。爆栈的 stack 能到几 MB，一条就该截断而不是撑爆整份配额。
pub const MAX_ENTRY_BYTES: usize = 16 * 1024;

/// 截断标记：读日志的人必须能看出「这里被截了」，否则会以为堆栈本来就这么短。
const TRUNCATED_MARK: &str = "\n…[已截断，完整堆栈请在应用内复制错误信息]\n";

pub fn log_path(config_dir: &Path) -> PathBuf {
    config_dir.join("logs").join("frontend.log")
}

pub fn rotated_path(config_dir: &Path) -> PathBuf {
    config_dir.join("logs").join("frontend.log.1")
}

/// 一条记录截断后的正文。
///
/// 按**字符边界**截，不能按字节切：UTF-8 中文/emoji 切一半会产生非法序列，
/// 落盘后整份日志都可能被编辑器判成乱码（同 `java_run::complete_prefix_len` 的判据）。
pub fn clamp_entry(text: &str) -> String {
    if text.len() <= MAX_ENTRY_BYTES {
        return text.to_string();
    }
    let budget = MAX_ENTRY_BYTES.saturating_sub(TRUNCATED_MARK.len());
    let mut end = budget.min(text.len());
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{TRUNCATED_MARK}", &text[..end])
}

/// 写盘前是否该轮转。抽成纯判据是为了脱库单测边界（正好等于上限不轮转）。
pub fn should_rotate(current_len: u64, incoming_len: u64) -> bool {
    current_len.saturating_add(incoming_len) > MAX_BYTES
}

/// 追加一条前端错误。`line` 由调用方组装成单行或多行文本，这里只负责编码与配额。
static ROTATION: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub(crate) fn with_rotation_lock<T>(run: impl FnOnce() -> T) -> T {
    let _lock = ROTATION.lock().unwrap_or_else(|error| error.into_inner());
    run()
}

pub fn append(config_dir: &Path, line: &str) -> Result<(), AppError> {
    with_rotation_lock(|| append_locked(config_dir, line))
}

fn append_locked(config_dir: &Path, line: &str) -> Result<(), AppError> {
    let path = log_path(config_dir);
    let dir = path
        .parent()
        .ok_or_else(|| AppError::internal("log.badPath", "日志目录无效"))?;
    fs::create_dir_all(dir).map_err(|e| AppError::io("建日志目录失败", e))?;

    let body = clamp_entry(line);
    let current = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    if should_rotate(current, body.len() as u64) {
        // 只留一份历史：rename 覆盖旧的 .1。失败不阻断本次写入——
        // 宁可这份略微超限，也不能因为轮转失败把当前这条错误丢掉。
        let _ = fs::rename(&path, rotated_path(config_dir));
    }

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| AppError::io("写前端日志失败", e))?;
    file.write_all(body.as_bytes())
        .map_err(|e| AppError::io("写前端日志失败", e))?;
    Ok(())
}

/// 读最近的前端错误日志（给设置页「查看」用）。只读尾部，避免整份读进内存。
pub fn read_tail(config_dir: &Path, max_bytes: u64) -> Result<String, AppError> {
    let path = log_path(config_dir);
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        // 还没崩过不是错误，界面显示「暂无记录」即可
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(e) => return Err(AppError::io("读前端日志失败", e)),
    };
    // 从字符边界开始，否则首行会是半个字符。
    // 🔴 判据必须落在**字节数组**上：UTF-8 续字节是 0b10xxxxxx，
    // 拿 lossy 之后的 String 下标去判是另一个索引空间，会错位。
    let mut start = bytes.len().saturating_sub(max_bytes as usize);
    while start > 0 && (bytes[start] & 0xC0) == 0x80 {
        start -= 1;
    }
    Ok(String::from_utf8_lossy(&bytes[start..]).into_owned())
}

/// 确保日志目录存在（供「打开日志目录」在还没崩过时也能打开）。
pub fn ensure_dir(config_dir: &Path) -> Result<PathBuf, AppError> {
    let path = log_path(config_dir);
    let dir = path
        .parent()
        .ok_or_else(|| AppError::internal("log.badPath", "日志目录无效"))?
        .to_path_buf();
    fs::create_dir_all(&dir).map_err(|e| AppError::io("建日志目录失败", e))?;
    Ok(dir)
}

/// 组装一条记录：时间 + 来源 + 消息 + 堆栈。
///
/// 时间用 UTC RFC3339 风格但**不引 chrono**：这里只需要人能读懂的顺序，
/// 用 `SystemTime` 折算即可，少一个依赖（machete 门禁会查无用依赖）。
pub fn format_entry(kind: &str, message: &str, stack: Option<&str>, page: Option<&str>) -> String {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut out = format!("[{stamp}] [{kind}]");
    if let Some(p) = page.filter(|p| !p.is_empty()) {
        out.push_str(&format!(" [page={p}]"));
    }
    out.push(' ');
    out.push_str(message.trim());
    out.push('\n');
    if let Some(s) = stack.filter(|s| !s.trim().is_empty()) {
        out.push_str(s.trim());
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        crate::test_support::tmp(tag)
    }

    #[test]
    fn 写入用utf8而不是gbk() {
        let dir = tmp("fe-log-utf8");
        // 🔴 这些字符 GBK 编不出来：若误用 server::append_log 会变成 ?，堆栈就废了
        let line = format_entry("render", "渲染失败 🚀 emoji", Some("at Café.tsx:1"), None);
        append(&dir, &line).unwrap();
        let raw = fs::read(log_path(&dir)).unwrap();
        let text = String::from_utf8(raw).expect("必须是合法 UTF-8");
        assert!(text.contains("🚀"), "emoji 丢了：{text}");
        assert!(text.contains("Café"), "非 ASCII 字母丢了：{text}");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn 超过上限就轮转且只留一份历史() {
        let dir = tmp("fe-log-rotate");
        // 🔴 单条上限（16 KiB）远小于文件上限（2 MiB），**一条写不满**：
        // 必须多次追加把文件堆到接近上限，再写一条触发轮转。
        // 第一版夹具用一条 2 MiB 的字符串，被 clamp_entry 截成 16 KiB ⇒ 永远不轮转。
        let chunk = "x".repeat(MAX_ENTRY_BYTES - 64);
        let rounds = (MAX_BYTES as usize / chunk.len()) + 1;
        for _ in 0..rounds {
            append(&dir, &chunk).unwrap();
        }
        assert!(rotated_path(&dir).exists(), "堆过上限必须轮转");
        append(&dir, "标记条\n").unwrap();
        // 再堆一轮：历史只有一份，不无限堆积
        for _ in 0..rounds {
            append(&dir, &chunk).unwrap();
        }
        append(&dir, "第三条\n").unwrap();
        let logs: Vec<String> = fs::read_dir(dir.join("logs"))
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
            .collect();
        assert_eq!(logs.len(), 2, "只留 frontend.log 与 .1，实测 {logs:?}");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn 轮转判据的边界() {
        assert!(!should_rotate(0, MAX_BYTES), "正好铺满不算超");
        assert!(should_rotate(1, MAX_BYTES), "多一字节就要轮转");
        assert!(should_rotate(u64::MAX, 1), "溢出不能绕回 0");
        assert!(!should_rotate(0, 0));
    }

    #[test]
    fn 超长单条按字符边界截断() {
        let dir = tmp("fe-log-clamp");
        // 🔴 夹具必须让截断点**落在字符中间**，否则这条测试是假绿：
        // budget = MAX_ENTRY_BYTES - TRUNCATED_MARK.len() = 16320，能被 3 整除，
        // 纯中文（每字 3 字节）时截断点天然对齐 ⇒ 去掉回退循环照样通过。
        // 前置 1 个 ASCII 把后续字符整体错位 1 字节，才真正逼出回退分支。
        // （2026-11-16 红灯验证实测：不加这个前缀，注入「按字节裸切」exit=0。）
        let long = format!("x{}", "凭证".repeat(MAX_ENTRY_BYTES));
        append(&dir, &long).unwrap();
        let raw = fs::read(log_path(&dir)).unwrap();
        let text = String::from_utf8(raw).expect("截断不能切出半个字符");
        assert!(text.len() <= MAX_ENTRY_BYTES, "实测 {}", text.len());
        assert!(
            text.contains("已截断"),
            "必须留下截断标记，否则读者以为堆栈本来就这么短"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn 截断判据不破坏短文本() {
        assert_eq!(clamp_entry("短消息"), "短消息");
        let exact = "y".repeat(MAX_ENTRY_BYTES);
        assert_eq!(clamp_entry(&exact), exact, "正好等于上限不截");
    }

    #[test]
    fn 没有日志时读到空而不是报错() {
        let dir = tmp("fe-log-empty");
        assert_eq!(read_tail(&dir, 4096).unwrap(), "");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn 读尾部不整份读且首字符完整() {
        let dir = tmp("fe-log-tail");
        append(&dir, "前面很长".repeat(400).as_str()).unwrap();
        append(&dir, "最后一条\n").unwrap();
        // 🔴 窗口必须让起点**落在字符中间**：总长 4813，减 64 = 4749 能被 3 整除
        // ⇒ 纯中文时起点天然对齐，去掉回退循环也绿（2026-11-16 红灯实测 exit=0）。
        // 取 65 使起点 % 3 == 2，真正逼出「往回退到字符首字节」这段。
        let tail = read_tail(&dir, 65).unwrap();
        assert!(tail.contains("最后一条"), "尾部要含最新记录：{tail}");
        assert!(tail.len() <= 65 + 8, "只读尾部，实测 {}", tail.len());
        assert!(
            !tail.contains('\u{FFFD}'),
            "首字符被切一半会出现替换符：{tail}"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn 记录含时间来源与页面() {
        let line = format_entry("unhandledrejection", "CONFLICT: 磁盘已改", None, Some("db"));
        assert!(line.contains("[unhandledrejection]"));
        assert!(line.contains("[page=db]"));
        assert!(line.contains("CONFLICT: 磁盘已改"));
        assert!(
            line.ends_with('\n'),
            "每条必须以换行结尾，否则两条会黏在一行"
        );
        // 空 page 不该输出空括号
        assert!(!format_entry("render", "x", None, Some("")).contains("page="));
    }

    #[test]
    fn 目录不存在也能打开日志目录() {
        let dir = tmp("fe-log-ensure");
        let got = ensure_dir(&dir).unwrap();
        assert!(got.is_dir(), "还没崩过也要能打开目录");
        assert_eq!(got, dir.join("logs"));
        fs::remove_dir_all(&dir).unwrap();
    }
}
