//! Bounded, cancellable Java execution and machine-readable JUnit results.
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, Mutex,
};
use std::time::{Duration, Instant};

mod coverage;
mod process_tree;
mod selection;
pub use coverage::coverage_classes;
pub use process_tree::ProcessTree;
pub use selection::{selected_sources, test_sources};
pub type ProcessRegistry = Mutex<HashMap<String, Arc<ProcessTree>>>;
#[cfg(test)]
use selection::source_binary_names;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JavaRunRequest {
    pub id: String,
    pub path: String,
    pub mode: String,
    pub classes: Vec<String>,
    pub args: Vec<String>,
    pub debug: bool,
    pub coverage: bool,
    #[serde(default)]
    pub extra_classpath: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub target: String,
    pub count: usize,
    pub failures: usize,
    pub ignored: usize,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestFailure {
    pub class_name: String,
    pub method: String,
    pub trace: String,
}
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct JavaRunResult {
    pub id: String,
    pub ok: bool,
    pub cancelled: bool,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    pub tests: Vec<TestResult>,
    pub failures: Vec<TestFailure>,
    pub report: Option<String>,
    pub results_truncated: bool,
}

pub struct JavaRuns(
    pub Mutex<HashMap<String, Arc<AtomicBool>>>,
    pub Arc<ProcessRegistry>,
);
impl Default for JavaRuns {
    fn default() -> Self {
        Self(
            Mutex::new(HashMap::new()),
            Arc::new(Mutex::new(HashMap::new())),
        )
    }
}
impl JavaRuns {
    pub fn cancel_all(&self) {
        for flag in self.0.lock().unwrap_or_else(|e| e.into_inner()).values() {
            flag.store(true, Ordering::Relaxed);
        }
        let trees: Vec<_> = self
            .1
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .cloned()
            .collect();
        for tree in trees {
            tree.kill();
        }
    }
}
impl Drop for JavaRuns {
    fn drop(&mut self) {
        self.cancel_all();
    }
}
pub fn validate(request: &JavaRunRequest) -> Result<(), String> {
    let id_ok = !request.id.is_empty()
        && request.id.len() <= 80
        && request
            .id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-');
    let name = |value: &str| {
        !value.is_empty()
            && value.len() <= 400
            && value.split('#').count() <= 2
            && value.split(['.', '#']).all(|part| {
                !part.is_empty()
                    && part.chars().enumerate().all(|(i, c)| {
                        c == '_'
                            || c == '$'
                            || c.is_ascii_alphabetic()
                            || (i > 0 && c.is_ascii_digit())
                    })
            })
    };
    if !id_ok
        || !["main", "test"].contains(&request.mode.as_str())
        || request.classes.is_empty()
        || request.classes.len() > 500
        || request.classes.iter().any(|v| !name(v))
        || (request.mode == "main"
            && (request.classes.len() != 1 || request.classes[0].contains('#')))
        || request.args.len() > 100
        || request
            .args
            .iter()
            .any(|a| a.len() > 4000 || a.contains('\0'))
        || request.args.iter().map(|a| a.len()).sum::<usize>() > 20_000
        || request.extra_classpath.len() > 64
    {
        return Err("运行配置无效：请选择完整类名，单测可使用 类名#方法名".into());
    }
    if request.coverage && request.debug {
        return Err("覆盖率与暂停调试请分别运行，避免暂停时生成不完整报告".into());
    }
    Ok(())
}
fn decode(value: &str) -> Option<String> {
    String::from_utf8(
        base64::engine::general_purpose::STANDARD
            .decode(value)
            .ok()?,
    )
    .ok()
}
pub fn parse_test_line(line: &str, result: &mut JavaRunResult) -> bool {
    let parts: Vec<_> = line.trim().split('\t').collect();
    if parts.first() == Some(&"NCFORGE_TEST_SUMMARY") && parts.len() == 5 {
        if let (Some(target), Ok(count), Ok(failures), Ok(ignored)) = (
            decode(parts[1]),
            parts[2].parse(),
            parts[3].parse(),
            parts[4].parse(),
        ) {
            if result.tests.len() >= 1000 || target.len() > 800 {
                result.results_truncated = true;
                return true;
            }
            result.tests.push(TestResult {
                target,
                count,
                failures,
                ignored,
            });
            return true;
        }
    }
    if parts.first() == Some(&"NCFORGE_TEST_FAILURE") && parts.len() == 4 {
        if let (Some(class_name), Some(method), Some(trace)) =
            (decode(parts[1]), decode(parts[2]), decode(parts[3]))
        {
            if result.failures.len() >= 1000 || class_name.len() > 400 || method.len() > 800 {
                result.results_truncated = true;
                return true;
            }
            result.failures.push(TestFailure {
                class_name,
                method,
                trace: trace.chars().take(16000).collect(),
            });
            return true;
        }
    }
    false
}
pub fn hide(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = command;
    }
}
/// 一批字节里「可以安全解码的完整部分」的长度，尾部残缺的多字节字符留给下一轮。
///
/// 🔴 为什么必须有这一步：`take(64KB).read_until` 会在**任意字节**处切断，
/// 包括一个 UTF-8 字符中间。切出来的半截让 `from_utf8` 直接 Err ⇒
/// `workspace::decode` 走 `Err(_)` 分支把**整块 64KB 回退 GBK**，
/// 不是只丢一个字符，而是整段中文全变乱码。
///
/// 只对「以 `\n` 结尾」的批做保留：那是被 64KB 上限硬切的，后面一定还有字节。
/// 进程收尾的最后半截没有下一轮可拼，原样交出去（与旧行为一致，不吞输出）。
fn complete_prefix_len(bytes: &[u8]) -> usize {
    match std::str::from_utf8(bytes) {
        Ok(_) => bytes.len(),
        Err(e) if e.error_len().is_none() => e.valid_up_to(),
        // 中间就有非法字节 = 本来就是 GBK 或二进制，整块交给 decode 判编码
        Err(_) => bytes.len(),
    }
}

/// Reader messages are bounded; a process printing a giant line cannot consume unbounded RAM.
fn reader(input: impl Read + Send + 'static, tx: mpsc::SyncSender<String>) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(input);
        // 上一轮切剩的半个字符（最多 3 字节），拼到下一轮开头再解码。
        let mut carry: Vec<u8> = Vec::new();
        loop {
            let mut bytes = std::mem::take(&mut carry);
            match std::io::Read::by_ref(&mut reader)
                .take(64 * 1024)
                .read_until(b'\n', &mut bytes)
            {
                Ok(0) | Err(_) => {
                    // 流结束：残留的半截没有下一轮可拼，原样发出去，别静默吞掉
                    if !bytes.is_empty() {
                        let _ = tx.send(crate::workspace::decode_lossy(&bytes));
                    }
                    break;
                }
                Ok(_) => {
                    let cut = if bytes.last() == Some(&b'\n') {
                        bytes.len()
                    } else {
                        complete_prefix_len(&bytes)
                    };
                    carry = bytes.split_off(cut);
                    if !bytes.is_empty() && tx.send(crate::workspace::decode_lossy(&bytes)).is_err()
                    {
                        break;
                    }
                }
            }
        }
    });
}
pub fn execute(
    command: &mut Command,
    id: &str,
    cancel: &AtomicBool,
    timeout: Duration,
    log: impl FnMut(&str),
    started: impl FnOnce(u32),
) -> Result<JavaRunResult, String> {
    execute_registered(command, id, cancel, timeout, log, started, None)
}
struct RegisteredProcess<'a> {
    registry: Option<&'a ProcessRegistry>,
    id: String,
    tree: Arc<ProcessTree>,
}
impl Drop for RegisteredProcess<'_> {
    fn drop(&mut self) {
        self.tree.kill();
        if let Some(registry) = self.registry {
            let mut pids = registry.lock().unwrap_or_else(|e| e.into_inner());
            if pids
                .get(&self.id)
                .is_some_and(|tree| Arc::ptr_eq(tree, &self.tree))
            {
                pids.remove(&self.id);
            }
        }
    }
}
pub fn execute_registered(
    command: &mut Command,
    id: &str,
    cancel: &AtomicBool,
    timeout: Duration,
    mut log: impl FnMut(&str),
    started: impl FnOnce(u32),
    registry: Option<&ProcessRegistry>,
) -> Result<JavaRunResult, String> {
    hide(command);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let start = Instant::now();
    if cancel.load(Ordering::Relaxed) {
        return Ok(JavaRunResult {
            id: id.into(),
            cancelled: true,
            ..Default::default()
        });
    }
    let (mut child, tree) = ProcessTree::spawn(command)?;
    if let Some(registry) = registry {
        registry
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.into(), tree.clone());
    }
    let _registered = RegisteredProcess {
        registry,
        id: id.into(),
        tree: tree.clone(),
    };
    if cancel.load(Ordering::Relaxed) {
        tree.kill();
        let _ = child.wait();
        return Ok(JavaRunResult {
            id: id.into(),
            cancelled: true,
            ..Default::default()
        });
    }
    if let Err(error) = tree.resume() {
        tree.kill();
        let _ = child.wait();
        if cancel.load(Ordering::Relaxed) {
            return Ok(JavaRunResult {
                id: id.into(),
                cancelled: true,
                ..Default::default()
            });
        }
        return Err(error);
    }
    started(child.id());
    let (tx, rx) = mpsc::sync_channel(256);
    if let Some(out) = child.stdout.take() {
        reader(out, tx.clone());
    }
    if let Some(err) = child.stderr.take() {
        reader(err, tx.clone());
    }
    drop(tx);
    let mut result = JavaRunResult {
        id: id.into(),
        ..Default::default()
    };
    let mut lines = 0usize;
    let mut truncated = false;
    let mut output_complete = true;
    let mut completed = None;
    loop {
        // Drain bounded batches, then check cancellation and process status even under output floods.
        for _ in 0..128 {
            let Ok(line) = rx.try_recv() else {
                break;
            };
            if parse_test_line(&line, &mut result) {
                continue;
            }
            if lines < 20_000 {
                log(&line);
                lines += 1;
            } else if !truncated {
                log("输出超过 20000 行，后续文本已截断；进程继续运行，可取消。\n");
                truncated = true;
            }
        }
        if cancel.load(Ordering::Relaxed) || start.elapsed() > timeout {
            tree.kill();
            let _ = child.kill();
            let _ = child.wait();
            result.cancelled = cancel.load(Ordering::Relaxed);
            if !result.cancelled {
                output_complete = false;
                log("运行超过时间上限，进程已终止。\n");
            }
            break;
        }
        if completed.is_none() {
            match child.try_wait() {
                Ok(Some(status)) => {
                    result.exit_code = status.code();
                    completed = Some(Instant::now());
                    // A main process exiting does not own the remainder of its lifetime:
                    // terminate ordinary descendants before draining their inherited pipes.
                    tree.kill();
                }
                Ok(None) => {}
                Err(e) => {
                    tree.kill();
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("读取 Java 状态失败：{e}"));
                }
            }
        }
        if let Some(done) = completed {
            if drain_expired(done.elapsed()) {
                tree.kill();
                output_complete = false;
                log("主进程已退出，输出管道等待超过 2 秒；进程组已终止，停止等待。\n");
                break;
            }
            // Pipes normally close immediately; do not block on an inherited pipe held by user code.
            match rx.recv_timeout(Duration::from_millis(40)) {
                Ok(line) => {
                    if !parse_test_line(&line, &mut result) && lines < 20_000 {
                        log(&line);
                        lines += 1;
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        } else {
            std::thread::sleep(Duration::from_millis(40));
        }
    }
    if result.results_truncated {
        log("测试结果超过展示上限（1000 条汇总 / 1000 个失败），结果不完整，不能判断为全部通过；官方 XML 保留完整测试结果。\n");
    }
    result.ok = output_complete
        && !result.cancelled
        && !result.results_truncated
        && result.exit_code == Some(0);
    result.duration_ms = start.elapsed().as_millis() as u64;
    Ok(result)
}
fn drain_expired(elapsed: Duration) -> bool {
    elapsed >= Duration::from_secs(2)
}
pub fn java_args_file(path: &Path, args: &[String]) -> Result<(), String> {
    if args.iter().any(|a| a.contains(['\n', '\r', '\0'])) {
        return Err("运行参数不能包含换行或 NUL".into());
    }
    let text = args
        .iter()
        .map(|a| format!("\"{}\"", a.replace('\\', "/").replace('"', "\\\"")))
        .collect::<Vec<_>>()
        .join("\n");
    crate::atomic_file::write_atomic(path, text.as_bytes())
}
pub fn prepare_run_directory(base: &Path, id: &str) -> Result<PathBuf, String> {
    std::fs::create_dir_all(base).map_err(|e| e.to_string())?;
    let canonical = std::fs::canonicalize(base).map_err(|e| e.to_string())?;
    let mut owned = Vec::new();
    for entry in std::fs::read_dir(base)
        .map_err(|e| e.to_string())?
        .flatten()
    {
        let path = entry.path();
        let metadata = entry.metadata().map_err(|e| e.to_string())?;
        if !metadata.is_dir()
            || crate::build_layout::is_reparse(&metadata)
            || entry.file_type().map_err(|e| e.to_string())?.is_symlink()
        {
            continue;
        }
        if std::fs::read(path.join(".ncforge-java-run"))
            .is_ok_and(|bytes| bytes == b"NCFORGE-JAVA-RUN-v1")
        {
            owned.push((metadata.modified().unwrap_or(std::time::UNIX_EPOCH), path));
        }
    }
    owned.sort_by_key(|(time, _)| *time);
    let remove_count = owned.len().saturating_sub(11);
    for (_, path) in owned.into_iter().take(remove_count) {
        let resolved = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
        if resolved.parent() != Some(canonical.as_path()) {
            return Err("运行缓存路径异常，未清理".into());
        }
        // Only directories created by this runner carry the marker. Never clean general TEMP.
        std::fs::remove_dir_all(resolved).map_err(|e| format!("清理旧运行缓存失败：{e}"))?;
    }
    let directory = base.join(id);
    if directory.exists() {
        return Err("运行编号已使用，请重新运行".into());
    }
    std::fs::create_dir(&directory).map_err(|e| e.to_string())?;
    crate::atomic_file::write_atomic(&directory.join(".ncforge-java-run"), b"NCFORGE-JAVA-RUN-v1")?;
    Ok(directory)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestCandidate {
    pub class_name: String,
    pub path: String,
    pub methods: Vec<String>,
}
pub fn discover_tests(root: &Path) -> Result<Vec<TestCandidate>, String> {
    let annotation = regex::Regex::new(
        r"@(?:[\w.]+\.)?(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\b",
    )
    .map_err(|e| e.to_string())?;
    let methods = regex::Regex::new(r"(?:public\s+)?(?:void|[\w<>.]+)\s+([\w$]+)\s*\(")
        .map_err(|e| e.to_string())?;
    let legacy = regex::Regex::new(r"\bextends\s+(?:junit\.framework\.)?TestCase\b")
        .map_err(|e| e.to_string())?;
    let mut found = Vec::new();
    for path in test_sources(root, &[])? {
        if std::fs::metadata(&path).map_err(|e| e.to_string())?.len() > 2 * 1024 * 1024 {
            continue;
        }
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        let clean = crate::build_state::strip_comments_and_literals(
            &crate::workspace::decode_lossy(&bytes),
        );
        let types = selection::source_types(&clean);
        let owner_at = |offset: usize| {
            types
                .iter()
                .filter(|t| t.start <= offset && offset < t.end)
                .max_by_key(|t| t.start)
        };
        let mut candidates: HashMap<String, Vec<String>> = HashMap::new();
        for marked in annotation.find_iter(&clean) {
            let Some(owner) = owner_at(marked.start()) else {
                continue;
            };
            if let Some(name) = methods
                .captures(&clean[marked.end()..])
                .and_then(|c| c.get(1))
            {
                if marked.end() + name.start() < owner.end {
                    candidates
                        .entry(owner.name.clone())
                        .or_default()
                        .push(name.as_str().into());
                }
            }
        }
        for test_type in types
            .iter()
            .filter(|t| legacy.is_match(&clean[t.header..t.start]))
        {
            let names = candidates.entry(test_type.name.clone()).or_default();
            for method in methods.captures_iter(&clean[test_type.start..test_type.end]) {
                if let Some(name) = method.get(1) {
                    let offset = test_type.start + name.start();
                    if name.as_str().starts_with("test")
                        && owner_at(offset).is_some_and(|owner| owner.name == test_type.name)
                    {
                        names.push(name.as_str().into());
                    }
                }
            }
        }
        for (class_name, mut methods) in candidates {
            methods.sort();
            methods.dedup();
            methods.truncate(500);
            found.push(TestCandidate {
                class_name,
                path: path.to_string_lossy().into(),
                methods,
            });
        }
        if found.len() > 500 {
            return Err("测试类超过 500 个，请缩小运行范围".into());
        }
    }
    found.sort_by(|a, b| a.class_name.cmp(&b.class_name));
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 收集 reader 发出的全部分片。
    fn drain(bytes: Vec<u8>) -> String {
        let (tx, rx) = mpsc::sync_channel::<String>(64);
        reader(std::io::Cursor::new(bytes), tx);
        let mut out = String::new();
        while let Ok(part) = rx.recv() {
            out.push_str(&part);
        }
        out
    }

    /// 🔴 64KB 上限切在 UTF-8 字符中间时，**整块 64KB 会被回退成 GBK**（不只丢一个字符）。
    /// 造一条超长行：ASCII 填充到 65535 字节，第 65536 字节正好是「凭」的首字节。
    #[test]
    fn utf8_char_split_at_64k_boundary_is_not_decoded_as_gbk() {
        let mut line = vec![b'a'; 64 * 1024 - 1];
        line.extend_from_slice("凭证查询\n".as_bytes());
        let text = drain(line);
        assert!(
            text.ends_with("凭证查询\n"),
            "边界字符被切断后整块回退 GBK，实测尾部 {:?}",
            &text[text.len().saturating_sub(24)..]
        );
        assert!(!text.contains('\u{FFFD}'), "不该出现替换字符");
        assert_eq!(text.len(), 64 * 1024 - 1 + "凭证查询\n".len());
    }

    /// 四字节字符（emoji）切在第 1/2/3 字节处都要能拼回来。
    #[test]
    fn four_byte_char_split_at_every_offset_roundtrips() {
        for keep in 1..4 {
            let mut line = vec![b'x'; 64 * 1024 - keep];
            line.extend_from_slice("🚀ok\n".as_bytes());
            let text = drain(line);
            assert!(text.ends_with("🚀ok\n"), "keep={keep} 时拼不回来");
        }
    }

    /// 纯判据：只保留「尾部残缺」，中间的非法字节要原样交给 decode 判编码。
    #[test]
    fn complete_prefix_only_trims_incomplete_tail() {
        let ok = "凭证".as_bytes();
        assert_eq!(complete_prefix_len(ok), ok.len());
        // 尾部残缺：切掉不完整的那个字符
        assert_eq!(complete_prefix_len(&ok[..ok.len() - 1]), 3);
        assert_eq!(complete_prefix_len(&ok[..1]), 0);
        // 中间就有非法字节 = GBK/二进制，整块交出去让 decode 判，不许在这里截断
        let gbk = [0xC6, 0xBE, 0xD6, 0xA4];
        assert_eq!(complete_prefix_len(&gbk), gbk.len());
        assert_eq!(complete_prefix_len(b""), 0);
    }

    /// GBK 输出不能被这条新逻辑改坏：整块仍交给 decode 判编码。
    #[test]
    fn gbk_output_still_decodes_after_chunking() {
        let (gbk, _, _) = encoding_rs::GBK.encode("发票查询\n");
        let mut line = vec![b'b'; 64 * 1024 - 2];
        line.extend_from_slice(&gbk);
        assert!(drain(line).ends_with("发票查询\n"));
    }

    /// 进程收尾的半截字符没有下一轮可拼，也要发出去，不能静默吞掉。
    ///
    /// 注意断言的是「字节没被丢弃」而不是解码后的字符数：单个残缺字节交给
    /// `decode` 会按 GBK 解成替换字符，长度本就会变，这里只保证输出没被截短。
    #[test]
    fn trailing_partial_char_at_eof_is_still_emitted() {
        let mut line = vec![b'c'; 64 * 1024 - 1];
        line.extend_from_slice(&"凭".as_bytes()[..1]);
        let text = drain(line);
        assert!(
            text.len() >= 64 * 1024,
            "尾部残留字节被吞了，实测长度 {}",
            text.len()
        );
        assert!(
            text.starts_with(&"c".repeat(100)),
            "前面的正常输出不该受影响"
        );
    }

    #[test]
    fn selected_source_keeps_secondary_and_nested_types_without_basename_matches() {
        let temp = tempfile::tempdir().unwrap();
        let exact = temp.path().join("A.java");
        std::fs::write(
            &exact,
            "package demo; class A {} class OtherTest { static class Nested {} }",
        )
        .unwrap();
        let wrong = temp.path().join("OtherTest.java");
        std::fs::write(&wrong, "package unrelated; class OtherTest {}").unwrap();
        assert_eq!(
            selected_sources(
                temp.path(),
                &["demo.OtherTest$Nested#test".into()],
                Some(&exact)
            )
            .unwrap(),
            vec![exact.clone()]
        );
        assert_eq!(
            selected_sources(temp.path(), &["demo.OtherTest".into()], None).unwrap(),
            vec![exact]
        );
        assert!(selected_sources(temp.path(), &["missing.OtherTest".into()], None).is_err());
    }
    #[test]
    fn explicit_source_disambiguates_duplicate_full_class_declarations() {
        let temp = tempfile::tempdir().unwrap();
        let one = temp.path().join("one");
        let two = temp.path().join("two");
        std::fs::create_dir(&one).unwrap();
        std::fs::create_dir(&two).unwrap();
        let exact = one.join("A.java");
        for path in [&exact, &two.join("A.java")] {
            std::fs::write(path, "package demo; class A {}").unwrap();
        }
        assert!(selected_sources(temp.path(), &["demo.A".into()], None).is_err());
        assert_eq!(
            selected_sources(temp.path(), &["demo.A".into()], Some(&exact)).unwrap(),
            vec![exact]
        );
    }
    #[test]
    fn class_names_preserve_member_nesting_and_literal_dollar_identifiers() {
        assert_eq!(source_binary_names("package demo; class A$Test { static class Inner {} void m() { class Local {} } } class Other {}"), vec!["demo.A$Test", "demo.A$Test$Inner", "demo.Other"]);
    }
    #[test]
    fn source_selection_accepts_java_whitespace_in_package_declarations() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("A.java");
        for package in [
            "package demo.tests;",
            "package\tdemo.tests;",
            "package\ndemo.tests;",
            "package demo .\n tests ;",
            "package\u{000c}demo\t.\ttests;",
        ] {
            std::fs::write(
                &path,
                format!("{package} class A {{}} class OtherTest {{ @Test void test() {{}} }}"),
            )
            .unwrap();
            assert_eq!(
                selected_sources(
                    temp.path(),
                    &["demo.tests.OtherTest#test".into()],
                    Some(&path)
                )
                .unwrap(),
                vec![path.clone()],
                "{package}"
            );
            assert_eq!(
                discover_tests(temp.path()).unwrap()[0].class_name,
                "demo.tests.OtherTest"
            );
        }
    }
    #[test]
    fn module_discovery_reports_declared_secondary_and_nested_test_classes() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("A.java"), "package demo; class A {} class OtherTest { @Test void one() {} class Inner { @Test void two() {} } } class OldTest extends junit.framework.TestCase { public void testOld() {} }").unwrap();
        let found = discover_tests(temp.path()).unwrap();
        assert_eq!(
            found
                .iter()
                .map(|c| c.class_name.as_str())
                .collect::<Vec<_>>(),
            vec!["demo.OldTest", "demo.OtherTest", "demo.OtherTest$Inner"]
        );
        assert_eq!(found[1].methods, vec!["one"]);
        assert_eq!(found[2].methods, vec!["two"]);
    }
    #[test]
    fn completed_pipe_deadline_is_absolute_even_when_output_keeps_arriving() {
        assert!(!drain_expired(Duration::from_millis(1999)));
        assert!(drain_expired(Duration::from_secs(2)));
        assert!(drain_expired(Duration::from_secs(10)));
    }
    #[test]
    fn timeout_while_draining_a_successful_parent_cannot_report_success() {
        #[cfg(windows)]
        let mut command = {
            let mut command = Command::new("powershell.exe");
            command.args([
                "-NoProfile",
                "-Command",
                "[Console]::Out.Write(('line' + [Environment]::NewLine) * 384)",
            ]);
            command
        };
        #[cfg(not(windows))]
        let mut command = {
            let mut command = Command::new("sh");
            command.args([
                "-c",
                "i=0; while [ $i -lt 384 ]; do printf 'line\\n'; i=$((i+1)); done",
            ]);
            command
        };
        let registry = Arc::new(ProcessRegistry::default());
        let watchdog_registry = registry.clone();
        let (done, wait_done) = mpsc::channel();
        let watchdog = std::thread::spawn(move || {
            if wait_done.recv_timeout(Duration::from_secs(6)).is_err() {
                let trees: Vec<_> = watchdog_registry
                    .lock()
                    .unwrap()
                    .values()
                    .cloned()
                    .collect();
                for tree in trees {
                    tree.kill();
                }
            }
        });
        let mut lines = 0;
        let mut timed_out = false;
        let started = Instant::now();
        let result = execute_registered(
            &mut command,
            "drain-timeout",
            &AtomicBool::new(false),
            Duration::from_secs(2),
            |line| {
                lines += 1;
                // Give the small writer time to exit before the first status check;
                // the next batch then crosses the deadline while exit_code is already 0.
                if lines == 1 {
                    std::thread::sleep(Duration::from_millis(200));
                }
                if lines == 130 {
                    std::thread::sleep(Duration::from_millis(2500));
                }
                if line.contains("运行超过时间上限") {
                    timed_out = true;
                }
            },
            |_| {},
            Some(&registry),
        )
        .unwrap();
        let _ = done.send(());
        watchdog.join().unwrap();
        assert!(started.elapsed() < Duration::from_secs(6));
        assert_eq!(result.exit_code, Some(0));
        assert!(timed_out);
        assert!(!result.ok);
        assert!(!result.cancelled);
        assert!(registry.lock().unwrap().is_empty());
    }
    #[test]
    fn parent_exit_terminates_pipe_flooding_descendants() {
        #[cfg(windows)]
        let mut command = {
            let mut command = Command::new("powershell.exe");
            command.args(["-NoProfile", "-Command", "$child = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList @('-NoProfile','-Command','while($true){ [Console]::WriteLine(''flood''); Start-Sleep -Milliseconds 10 }') -NoNewWindow -PassThru; [Console]::WriteLine('CHILD:' + $child.Id); Start-Sleep -Milliseconds 500"]);
            command
        };
        #[cfg(not(windows))]
        let mut command = {
            let mut command = Command::new("sh");
            command.args(["-c", "sh -c 'while :; do echo flood; sleep 0.01; done' & printf 'CHILD:%s\\n' \"$!\"; sleep 0.15"]);
            command
        };
        let registry = Arc::new(ProcessRegistry::default());
        let watchdog_registry = registry.clone();
        let (done, wait_done) = mpsc::channel();
        // Bound a broken regression too: a flood must not leave the test or child running.
        let watchdog = std::thread::spawn(move || {
            if wait_done.recv_timeout(Duration::from_secs(6)).is_err() {
                let trees: Vec<_> = watchdog_registry
                    .lock()
                    .unwrap()
                    .values()
                    .cloned()
                    .collect();
                for tree in trees {
                    tree.kill();
                }
            }
        });
        let mut child_pid = None;
        let start = Instant::now();
        let result = execute_registered(
            &mut command,
            "pipe-flood",
            &AtomicBool::new(false),
            Duration::from_secs(4),
            |line| {
                if let Some(value) = line.trim().strip_prefix("CHILD:") {
                    child_pid = value.parse::<u32>().ok();
                }
            },
            |_| {},
            Some(&registry),
        )
        .unwrap();
        let _ = done.send(());
        watchdog.join().unwrap();
        assert!(start.elapsed() < Duration::from_secs(4));
        assert!(result.ok);
        assert!(registry.lock().unwrap().is_empty());
        assert!(
            crate::server::process_name(child_pid.expect("parent reported its child PID"))
                .is_none()
        );
    }
    #[test]
    fn parses_real_junit_summary_and_failure() {
        let mut r = JavaRunResult::default();
        assert!(parse_test_line(
            "NCFORGE_TEST_SUMMARY\tYS5UZXN0I21ldGhvZA==\t2\t1\t0\n",
            &mut r
        ));
        assert_eq!(r.tests[0].target, "a.Test#method");
        assert_eq!(r.tests[0].count, 2);
        assert!(parse_test_line(
            "NCFORGE_TEST_FAILURE\tYS5UZXN0\tbWV0aG9k\tZmFpbGVk",
            &mut r
        ));
        assert_eq!(r.failures[0].trace, "failed");
        assert!(!parse_test_line(
            "NCFORGE_TEST_SUMMARY\tbad\t2\t1\t0",
            &mut r
        ));
    }
    #[test]
    fn config_rejects_ambiguous_main_and_invalid_names() {
        let mut r = JavaRunRequest {
            id: "test-1".into(),
            path: "x".into(),
            mode: "main".into(),
            classes: vec!["a.Main".into()],
            args: vec!["literal;argument".into()],
            debug: false,
            coverage: false,
            extra_classpath: vec![],
        };
        assert!(validate(&r).is_ok());
        r.classes = vec!["a.Test#test".into()];
        assert!(validate(&r).is_err());
        r.mode = "test".into();
        assert!(validate(&r).is_ok());
        r.classes = vec!["-version".into()];
        assert!(validate(&r).is_err());
    }
    #[test]
    fn machine_results_cannot_bypass_output_limits() {
        let mut result = JavaRunResult::default();
        for _ in 0..1001 {
            assert!(parse_test_line(
                "NCFORGE_TEST_SUMMARY\tYS5UZXN0\t1\t0\t0",
                &mut result
            ));
            assert!(parse_test_line(
                "NCFORGE_TEST_FAILURE\tYS5UZXN0\tbWV0aG9k\tZmFpbGVk",
                &mut result
            ));
        }
        assert_eq!(result.tests.len(), 1000);
        assert_eq!(result.failures.len(), 1000);
        assert!(result.results_truncated);
        let oversized = base64::engine::general_purpose::STANDARD.encode("a".repeat(801));
        let mut invalid = JavaRunResult::default();
        assert!(parse_test_line(
            &format!("NCFORGE_TEST_SUMMARY\t{oversized}\t1\t0\t0"),
            &mut invalid
        ));
        assert!(invalid.results_truncated);
        assert!(invalid.tests.is_empty());
    }
    #[test]
    fn coverage_prefers_running_class_and_does_not_copy_runner() {
        let temp = tempfile::tempdir().unwrap();
        let current = temp.path().join("current");
        let stale = temp.path().join("stale");
        std::fs::create_dir_all(current.join("nc/demo")).unwrap();
        std::fs::create_dir_all(stale.join("nc/demo")).unwrap();
        std::fs::write(current.join("nc/demo/Price.class"), b"current").unwrap();
        std::fs::write(stale.join("nc/demo/Price.class"), b"stale").unwrap();
        std::fs::write(stale.join("nc/demo/Other.class"), b"other").unwrap();
        std::fs::write(current.join("NcJavaTestRunner.class"), b"runner").unwrap();
        let target =
            coverage_classes(temp.path(), &[current, stale], &AtomicBool::new(false)).unwrap();
        assert_eq!(
            std::fs::read(target.join("nc/demo/Price.class")).unwrap(),
            b"current"
        );
        assert!(target.join("nc/demo/Other.class").is_file());
        assert!(!target.join("NcJavaTestRunner.class").exists());
    }
    #[test]
    fn cache_cleanup_preserves_unowned_directories() {
        let temp = tempfile::tempdir().unwrap();
        let unknown = temp.path().join("user-data");
        std::fs::create_dir(&unknown).unwrap();
        std::fs::write(unknown.join("important"), b"keep").unwrap();
        for index in 0..13 {
            prepare_run_directory(temp.path(), &format!("run-{index}")).unwrap();
        }
        assert_eq!(std::fs::read(unknown.join("important")).unwrap(), b"keep");
        let owned = std::fs::read_dir(temp.path())
            .unwrap()
            .flatten()
            .filter(|entry| entry.path().join(".ncforge-java-run").is_file())
            .count();
        assert_eq!(owned, 12);
        assert!(prepare_run_directory(temp.path(), "run-12").is_err());
    }
    #[test]
    fn registered_cancelled_process_is_removed_from_registry() {
        #[cfg(windows)]
        let mut command = {
            let mut cmd = Command::new("powershell.exe");
            cmd.args(["-NoProfile", "-Command", "Start-Sleep -Seconds 10"]);
            cmd
        };
        #[cfg(not(windows))]
        let mut command = {
            let mut cmd = Command::new("sleep");
            cmd.arg("10");
            cmd
        };
        let registry = Mutex::new(HashMap::new());
        let cancel = AtomicBool::new(false);
        let result = execute_registered(
            &mut command,
            "cancel-test",
            &cancel,
            Duration::from_secs(15),
            |_| {},
            |pid| {
                assert_eq!(
                    registry
                        .lock()
                        .unwrap()
                        .get("cancel-test")
                        .map(|tree| tree.pid),
                    Some(pid)
                );
                cancel.store(true, Ordering::Relaxed);
            },
            Some(&registry),
        )
        .unwrap();
        assert!(result.cancelled);
        assert!(!result.ok);
        assert!(registry.lock().unwrap().is_empty());
    }
}
