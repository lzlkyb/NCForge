//! Read bounded stdout windows by an exact, stable file identity. Export preserves original bytes.
use serde::{Deserialize, Serialize};
use std::fs::{File, Metadata};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;
#[cfg(not(unix))]
use std::time::UNIX_EPOCH;

pub const PAGE_BYTES: usize = 256 * 1024;
#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LogTarget {
    Middleware,
    Client,
}
impl LogTarget {
    pub fn name(self) -> &'static str {
        match self {
            Self::Middleware => "middleware",
            Self::Client => "client",
        }
    }
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogPage {
    pub text: String,
    pub start_offset: u64,
    pub offset: u64,
    pub file_id: String,
    pub size: u64,
    pub eof: bool,
    pub reset: bool,
    pub truncated: bool,
    pub line_offsets: Vec<u64>,
}
pub fn source_path(
    config_dir: &Path,
    target: LogTarget,
    previous: bool,
) -> Result<PathBuf, String> {
    let path = config_dir.join("logs").join(format!(
        "{}.log{}",
        target.name(),
        if previous { ".1" } else { "" }
    ));
    if path
        .try_exists()
        .map_err(|e| format!("日志路径无法访问：{e}"))?
    {
        let canonical = path
            .canonicalize()
            .map_err(|e| format!("日志路径无法访问：{e}"))?;
        let root = config_dir
            .canonicalize()
            .map_err(|e| format!("配置目录无法访问：{e}"))?;
        if !canonical.starts_with(&root) {
            return Err("日志文件不在应用配置目录内，已拒绝读取".into());
        }
        if !canonical.is_file() {
            return Err("日志来源不是普通文件".into());
        }
    }
    Ok(path)
}
pub fn identity(file: &File, meta: &Metadata) -> Result<String, String> {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetFileInformationByHandle(handle: *mut std::ffi::c_void, info: *mut u32) -> i32;
        }
        // BY_HANDLE_FILE_INFORMATION is 13 DWORDs. Handle remains owned and live during this call.
        let mut info = [0u32; 13];
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) } == 0 {
            return Err(format!(
                "读取日志文件标识失败：{}",
                std::io::Error::last_os_error()
            ));
        }
        let created = meta
            .created()
            .ok()
            .and_then(|v| v.duration_since(UNIX_EPOCH).ok())
            .map(|v| v.as_nanos())
            .unwrap_or(0);
        Ok(format!("{}-{}-{}-{created}", info[7], info[11], info[12]))
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let _ = file;
        Ok(format!("{}-{}", meta.dev(), meta.ino()))
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = file;
        let created = meta
            .created()
            .map_err(|e| format!("文件系统无法提供日志身份：{e}"))?
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos();
        Ok(created.to_string())
    }
}
/// 清空日志内容但**不换文件**：返回清掉的字节数。文件不存在返回 0（不凭空建出来）。
///
/// 用 `set_len(0)` 而不是「删了再建」：中间件/客户端的 stdout 直接接在这个文件上
/// （`ServerSpec::spawn` 用 `Stdio::from` 传的是同一句柄），删掉重建会让运行中的进程
/// 继续写进那个「已删除」的旧句柄——界面读新文件永远是空的，之后的日志等于全丢。
/// 截断则两边落在同一个文件对象上：进程下一次写从 0 开始，读取端也会因
/// `offset > size` 判定 `reset` 自动重读。
pub fn truncate(path: &Path) -> Result<u64, String> {
    if !path
        .try_exists()
        .map_err(|e| format!("日志路径无法访问：{e}"))?
    {
        return Ok(0);
    }
    if !path.is_file() {
        return Err("日志来源不是普通文件".into());
    }
    let file = File::options()
        .write(true)
        .open(path)
        .map_err(|e| format!("打开日志失败：{e}"))?;
    let len = file
        .metadata()
        .map_err(|e| format!("读取日志信息失败：{e}"))?
        .len();
    file.set_len(0).map_err(|e| format!("清空日志失败：{e}"))?;
    Ok(len)
}

/// 删掉上次运行的归档（`*.log.1`）。不存在视为已清，返回是否真的删了。
pub fn remove_archive(path: &Path) -> Result<bool, String> {
    if !path
        .try_exists()
        .map_err(|e| format!("日志路径无法访问：{e}"))?
    {
        return Ok(false);
    }
    if !path.is_file() {
        return Err("日志来源不是普通文件".into());
    }
    std::fs::remove_file(path).map_err(|e| format!("删除上次运行日志失败：{e}"))?;
    Ok(true)
}

pub fn open_source(path: &Path) -> Result<(File, u64, String), String> {
    let file = File::open(path).map_err(|e| format!("打开日志失败：{e}"))?;
    let meta = file
        .metadata()
        .map_err(|e| format!("读取日志信息失败：{e}"))?;
    if !meta.is_file() {
        return Err("日志来源不是普通文件".into());
    }
    let id = identity(&file, &meta)?;
    Ok((file, meta.len(), id))
}
fn decode(bytes: &[u8]) -> String {
    // Launcher messages use UTF-8 while NC stdout may be GBK in the same file; choose per line.
    bytes
        .split_inclusive(|b| *b == b'\n')
        .map(|line| match std::str::from_utf8(line) {
            Ok(text) => text.to_owned(),
            Err(_) => encoding_rs::GBK.decode(line).0.into_owned(),
        })
        .collect()
}
fn complete_bytes(bytes: &[u8]) -> usize {
    // Earlier complete lines may use another encoding; only the unfinished final line owns the tail.
    let start = bytes
        .iter()
        .rposition(|b| *b == b'\n')
        .map_or(0, |at| at + 1);
    let tail = &bytes[start..];
    start
        + match std::str::from_utf8(tail) {
            Ok(_) => tail.len(),
            Err(e) if e.error_len().is_none() => e.valid_up_to(),
            Err(_) => {
                let mut at = 0;
                while at < tail.len() {
                    if tail[at] >= 0x81 && tail[at] <= 0xfe {
                        if at + 1 == tail.len() {
                            break;
                        }
                        at += 2;
                    } else {
                        at += 1;
                    }
                }
                at
            }
        }
}
pub fn read_page(
    path: &Path,
    offset: u64,
    before: Option<u64>,
    expected: Option<&str>,
    tail: bool,
) -> Result<LogPage, String> {
    let (mut file, size, id) = match open_source(path) {
        Ok(v) => v,
        Err(_) if matches!(path.try_exists(), Ok(false)) => {
            return Ok(LogPage {
                text: String::new(),
                start_offset: 0,
                offset: 0,
                file_id: "missing".into(),
                size: 0,
                eof: true,
                reset: expected.is_some_and(|v| v != "missing"),
                truncated: false,
                line_offsets: vec![0],
            })
        }
        Err(e) => return Err(e),
    };
    let reset = expected.is_some_and(|v| v != id) || (!tail && offset > size);
    let end = if tail {
        if reset {
            size
        } else {
            before.unwrap_or(size).min(size)
        }
    } else {
        size
    };
    let mut start = if tail {
        end.saturating_sub(PAGE_BYTES as u64)
    } else if reset {
        0
    } else {
        offset
    };
    file.seek(SeekFrom::Start(start))
        .map_err(|e| format!("定位日志失败：{e}"))?;
    let mut bytes = vec![0u8; (end - start).min(PAGE_BYTES as u64) as usize];
    file.read_exact(&mut bytes)
        .map_err(|e| format!("读取日志窗口失败：{e}"))?;
    let mut truncated = false;
    if tail && start > 0 {
        // Backward windows start on a whole line. An oversized line is explicitly marked partial.
        match bytes.iter().position(|b| *b == b'\n') {
            Some(at) => {
                bytes.drain(..=at);
                start += (at + 1) as u64;
            }
            None => truncated = true,
        }
    }
    if tail && end < size && bytes.last() != Some(&b'\n') {
        if let Some(at) = bytes.iter().rposition(|b| *b == b'\n') {
            bytes.truncate(at + 1);
        } else {
            truncated = true;
        }
    }
    let complete = complete_bytes(&bytes);
    bytes.truncate(complete);
    let offset = start + bytes.len() as u64;
    // The descriptor protects us during rename; flag a replaced path so the caller discards stale bytes.
    let changed = open_source(path)
        .map(|(_, _, other)| other != id)
        .unwrap_or(true);
    if changed {
        return Err("日志在读取时已轮转，请重试读取新文件".into());
    }
    let mut line_offsets = vec![start];
    line_offsets.extend(
        bytes
            .iter()
            .enumerate()
            .filter(|(_, b)| **b == b'\n')
            .map(|(at, _)| start + at as u64 + 1),
    );
    Ok(LogPage {
        text: decode(&bytes),
        start_offset: start,
        offset,
        file_id: id,
        size,
        eof: offset >= size,
        reset,
        truncated,
        line_offsets,
    })
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogExportResult {
    pub path: String,
    pub bytes: u64,
    pub canceled: bool,
    pub ms: u64,
}
pub fn copy_snapshot(
    mut source: impl Read,
    size: u64,
    output: &Path,
    cancel: &AtomicBool,
    verify: impl Fn() -> Result<(), String>,
    mut progress: impl FnMut(u64),
) -> Result<Option<LogExportResult>, String> {
    let started = Instant::now();
    if cancel.load(Ordering::SeqCst) {
        return Ok(None);
    }
    let mut temp = tempfile::Builder::new()
        .prefix(".ncforge-log-")
        .suffix(".tmp")
        .tempfile_in(output.parent().ok_or("保存路径无上级目录")?)
        .map_err(|e| format!("建立日志导出临时文件失败：{e}"))?;
    let mut bytes = 0u64;
    let mut buf = [0u8; 64 * 1024];
    // Every iteration blocks on bounded file IO; snapshot size is the finite loop limit.
    while bytes < size {
        if cancel.load(Ordering::SeqCst) {
            return Ok(None);
        }
        let take = (size - bytes).min(buf.len() as u64) as usize;
        let read = source
            .read(&mut buf[..take])
            .map_err(|e| format!("读取导出日志失败：{e}"))?;
        if read == 0 {
            return Err("日志在导出时被截断，请重新选择本次或上次运行".into());
        }
        temp.write_all(&buf[..read])
            .map_err(|e| format!("写入导出日志失败：{e}"))?;
        bytes += read as u64;
        progress(bytes);
    }
    temp.as_file()
        .sync_all()
        .map_err(|e| format!("日志导出写入磁盘失败：{e}"))?;
    if cancel.load(Ordering::SeqCst) {
        return Ok(None);
    }
    verify()?;
    temp.persist(output)
        .map_err(|e| format!("保存日志文件失败：{}", e.error))?;
    Ok(Some(LogExportResult {
        path: crate::security::path::display_path(output),
        bytes,
        canceled: false,
        ms: started.elapsed().as_millis() as u64,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn utf8_gbk_and_identity_append_rotation() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("x.log");
        std::fs::write(&path, "中文\n").unwrap();
        let a = read_page(&path, 0, None, None, false).unwrap();
        assert_eq!(a.text, "中文\n");
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"next\n")
            .unwrap();
        let b = read_page(&path, a.offset, None, Some(&a.file_id), false).unwrap();
        assert_eq!(a.file_id, b.file_id);
        assert!(!b.reset);
        std::fs::rename(&path, path.with_extension("log.1")).unwrap();
        std::fs::write(&path, encoding_rs::GBK.encode("汉字\n").0).unwrap();
        let c = read_page(&path, a.offset, None, Some(&a.file_id), false).unwrap();
        assert!(c.reset);
        assert_eq!(c.text, "汉字\n");
    }
    #[test]
    fn bounded_tail_has_whole_lines_and_backward_range() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("x.log");
        let data = "123456789\n".repeat(PAGE_BYTES / 5);
        std::fs::write(&path, data).unwrap();
        let tail = read_page(&path, 0, None, None, true).unwrap();
        assert!(tail.start_offset > 0);
        assert!(tail.text.starts_with("123456789\n"));
        assert!(tail.text.len() <= PAGE_BYTES);
        let older =
            read_page(&path, 0, Some(tail.start_offset), Some(&tail.file_id), true).unwrap();
        assert_eq!(older.offset, tail.start_offset);
        assert!(!older.eof);
    }
    #[test]
    fn mixed_encoding_keeps_incomplete_utf8_tail_for_next_read() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("x.log");
        let mut bytes = encoding_rs::GBK.encode("汉字\n").0.into_owned();
        bytes.extend_from_slice("测试".as_bytes());
        let complete = bytes.len();
        bytes.extend_from_slice(&"中".as_bytes()[..2]);
        std::fs::write(&path, bytes).unwrap();
        let first = read_page(&path, 0, None, None, false).unwrap();
        assert_eq!(first.text, "汉字\n测试");
        assert_eq!(first.offset, complete as u64);
        assert!(!first.eof);
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(&["中".as_bytes()[2], b'\n'])
            .unwrap();
        let next = read_page(&path, first.offset, None, Some(&first.file_id), false).unwrap();
        assert_eq!(next.text, "中\n");
        assert_eq!(next.line_offsets, vec![first.offset, next.offset]);
        assert!(next.eof);
    }
    #[test]
    fn missing_or_truncated_file_resets_stale_cursor() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("x.log");
        let missing = read_page(&path, 20, None, Some("old"), false).unwrap();
        assert!(missing.reset);
        assert_eq!(missing.file_id, "missing");
        std::fs::write(&path, "old long text\n").unwrap();
        let old = read_page(&path, 0, None, None, false).unwrap();
        std::fs::write(&path, "new\n").unwrap();
        let new = read_page(&path, old.offset, None, Some(&old.file_id), false).unwrap();
        assert!(new.reset);
        assert_eq!(new.start_offset, 0);
        assert_eq!(new.text, "new\n");
    }
    #[test]
    fn truncate_keeps_file_identity_and_open_writer() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("x.log");
        std::fs::write(&path, "第一行\n").unwrap();
        let before = read_page(&path, 0, None, None, false).unwrap();
        // 模拟正在跑的中间件：它拿着同一个文件的 append 句柄
        let mut appender = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        assert_eq!(truncate(&path).unwrap(), "第一行\n".len() as u64);
        appender.write_all(b"after\n").unwrap();
        let after = read_page(&path, before.offset, None, Some(&before.file_id), false).unwrap();
        assert!(after.reset, "截断后旧 offset 必须触发重读");
        assert_eq!(after.text, "after\n", "截断之后的新输出要能读到");
        assert_eq!(before.file_id, after.file_id, "换文件会丢日志，只准截断");
    }
    #[test]
    fn truncating_missing_file_is_noop_and_archive_removal_repeats_safely() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("x.log");
        assert_eq!(truncate(&path).unwrap(), 0);
        assert!(!path.exists(), "不存在的日志不该被凭空创建");
        let archive = path.with_extension("log.1");
        std::fs::write(&archive, "old\n").unwrap();
        assert!(remove_archive(&archive).unwrap());
        assert!(!archive.exists());
        assert!(!remove_archive(&archive).unwrap(), "已清过再删不报错");
    }
    #[test]
    fn successful_snapshot_preserves_original_bytes_and_initial_size() {
        let d = tempfile::tempdir().unwrap();
        let output = d.path().join("out.log");
        let bytes = encoding_rs::GBK.encode("原始日志\r\n").0.into_owned();
        let mut appended = bytes.clone();
        appended.extend_from_slice(b"later\n");
        let result = copy_snapshot(
            std::io::Cursor::new(appended),
            bytes.len() as u64,
            &output,
            &AtomicBool::new(false),
            || Ok(()),
            |_| {},
        )
        .unwrap()
        .unwrap();
        assert_eq!(result.bytes, bytes.len() as u64);
        assert_eq!(std::fs::read(&output).unwrap(), bytes);
        assert_eq!(std::fs::read_dir(d.path()).unwrap().count(), 1);
    }
    #[test]
    fn truncated_snapshot_preserves_destination_and_cleans_temp() {
        let d = tempfile::tempdir().unwrap();
        let output = d.path().join("out.log");
        std::fs::write(&output, "keep").unwrap();
        let result = copy_snapshot(
            std::io::Cursor::new(b"short"),
            30,
            &output,
            &AtomicBool::new(false),
            || Ok(()),
            |_| {},
        );
        assert!(result.unwrap_err().contains("截断"));
        assert_eq!(std::fs::read_to_string(&output).unwrap(), "keep");
        assert_eq!(std::fs::read_dir(d.path()).unwrap().count(), 1);
    }
    #[test]
    fn canceled_snapshot_preserves_existing_file_and_cleans_temp() {
        let d = tempfile::tempdir().unwrap();
        let source = d.path().join("source.log");
        let output = d.path().join("out.log");
        std::fs::write(&source, vec![b'x'; 128 * 1024]).unwrap();
        std::fs::write(&output, "old").unwrap();
        let cancel = AtomicBool::new(false);
        let result = copy_snapshot(
            File::open(source).unwrap(),
            128 * 1024,
            &output,
            &cancel,
            || Ok(()),
            |_| cancel.store(true, Ordering::SeqCst),
        )
        .unwrap();
        assert!(result.is_none());
        assert_eq!(std::fs::read_to_string(&output).unwrap(), "old");
        assert_eq!(std::fs::read_dir(d.path()).unwrap().count(), 2);
    }
}
