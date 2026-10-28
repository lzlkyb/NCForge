//! 语言服务（jdt.ls 0.57）的 JSON-RPC 客户端：分帧编解码、常驻进程、请求超时与崩溃处置。
//!
//! 协议是 LSP 的 `Content-Length: N\r\n\r\n<N 字节 UTF-8 JSON>`。**N 是字节数不是字符数**，
//! 中文注释/诊断文案会让两者不等，按字符算就会把后面的帧全部读错位。
//!
//! 进程策略与 `java_bridge.rs` 一致：读取放独立线程，请求带超时；进程退出时让所有还在等的
//! 请求立刻失败（而不是各自傻等到超时），由上层决定是否重新拉起，本模块不缓存坏状态。
//!
//! initialize 的参数细节来自 M4 复核探针（`docs/NCForge-代码智能-M4-方案设计-20261028.md` 第 1.2 节）：
//! - 必须声明 `extendedClientCapabilities.classFileContentsSupport`，否则跳到 jar 内的类一律 0 命中；
//! - `initializationOptions` 可以嵌套，但其中的 `workspaceFolders` 若出现必须是 URI **字符串**数组；
//! - 必须配 `java.configuration.runtimes`（JavaSE-1.8 → NC 自带 ufjdk）。
//!
//! 纯逻辑模块，不含 tauri 类型（原因见 workspace.rs 头注释）。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

// ───────────────────────── 分帧 ─────────────────────────

/// 把一条 JSON 消息编码成带头的帧。
pub fn encode_message(msg: &Value) -> Vec<u8> {
    let body = msg.to_string();
    let mut out = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    out.extend_from_slice(body.as_bytes());
    out
}

/// 流式解码器：喂入任意切分的字节，吐出已经完整的消息。
#[derive(Default)]
pub struct FrameDecoder {
    buf: Vec<u8>,
}

impl FrameDecoder {
    /// 喂入新读到的字节，返回其中凑齐的所有消息。
    /// 头部格式不对或正文不是合法 JSON 时返回 Err——协议已经错位，继续读只会越错越远，
    /// 调用方应当丢弃这个进程重来。
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<Value>, String> {
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        while let Some(head_end) = find_subslice(&self.buf, b"\r\n\r\n") {
            let len = parse_content_length(&self.buf[..head_end])?;
            let start = head_end + 4;
            if self.buf.len() < start + len {
                break; // 正文还没收齐
            }
            let value: Value = serde_json::from_slice(&self.buf[start..start + len])
                .map_err(|e| format!("语言服务返回了无法解析的消息: {e}"))?;
            out.push(value);
            self.buf.drain(..start + len);
        }
        Ok(out)
    }
}

fn find_subslice(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// 从头部里取 Content-Length；头名不区分大小写，允许带 `Content-Type` 等其他头。
fn parse_content_length(head: &[u8]) -> Result<usize, String> {
    let text = String::from_utf8_lossy(head);
    for line in text.split("\r\n") {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.trim().eq_ignore_ascii_case("content-length") {
            return value
                .trim()
                .parse()
                .map_err(|_| format!("Content-Length 不是数字: {value}"));
        }
    }
    Err("消息头里没有 Content-Length".to_string())
}

// ───────────────────────── 路径 ↔ URI ─────────────────────────

/// 本地路径 → `file:///D:/x/y` 形式的 URI。非 ASCII 与空格按字节做百分号编码
/// （NC 工程路径里常有中文）。
pub fn path_to_uri(path: &str) -> String {
    let p = path
        .strip_prefix(r"\\?\")
        .unwrap_or(path)
        .replace(char::from(92), "/");
    let mut out = String::from("file://");
    if !p.starts_with('/') {
        out.push('/');
    }
    for b in p.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' | b':' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// `file:///D:/x/y` → `D:\x\y`。不是 file 协议（如 `jdt://`）返回 None。
pub fn uri_to_path(uri: &str) -> Option<String> {
    let raw = uri.strip_prefix("file://")?.as_bytes();
    let mut bytes = Vec::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == b'%' && i + 2 < raw.len() {
            let hex = std::str::from_utf8(&raw[i + 1..i + 3]).ok()?;
            bytes.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            bytes.push(raw[i]);
            i += 1;
        }
    }
    let decoded = String::from_utf8(bytes).ok()?;
    // `/D:/x` → `D:/x`（盘符路径去掉开头的斜杠）
    let trimmed = match decoded.as_bytes() {
        [b'/', d, b':', ..] if d.is_ascii_alphabetic() => &decoded[1..],
        _ => decoded.as_str(),
    };
    let is_drive = matches!(trimmed.as_bytes(), [d, b':', ..] if d.is_ascii_alphabetic());
    Some(if is_drive {
        trimmed.replace('/', &char::from(92).to_string())
    } else {
        trimmed.to_string()
    })
}

// ───────────────────────── 启动与初始化参数 ─────────────────────────

/// jdt.ls 的启动要素。
pub struct JdtlsLaunch<'a> {
    pub java_exe: &'a Path,
    /// jdt.ls 解压目录（含 `plugins/`、`config_win/`）。
    pub ls_dir: &'a Path,
    /// jdt.ls 的工作区数据目录（独立于用户的工作副本，见方案第 3 节）。
    pub data_dir: &'a Path,
    pub xmx_mb: u32,
}

impl JdtlsLaunch<'_> {
    pub fn command(&self) -> Result<Command, String> {
        let plugins = self.ls_dir.join("plugins");
        // 注意前缀带下划线：同目录还有 `org.eclipse.equinox.launcher.win32...`，不是启动 jar
        let launcher: PathBuf = std::fs::read_dir(&plugins)
            .map_err(|e| {
                format!(
                    "读取 jdt.ls 的 plugins 目录失败（{}）: {e}",
                    plugins.display()
                )
            })?
            .flatten()
            .map(|e| e.path())
            .find(|p| {
                p.file_name().is_some_and(|n| {
                    let n = n.to_string_lossy();
                    n.starts_with("org.eclipse.equinox.launcher_") && n.ends_with(".jar")
                })
            })
            .ok_or_else(|| format!("{} 里没有 equinox launcher jar", plugins.display()))?;
        let config = self.ls_dir.join(if cfg!(windows) {
            "config_win"
        } else {
            "config_linux"
        });
        let mut cmd = Command::new(self.java_exe);
        cmd.args([
            "-Declipse.application=org.eclipse.jdt.ls.core.id1",
            "-Dosgi.bundles.defaultStartLevel=4",
            "-Declipse.product=org.eclipse.jdt.ls.core.product",
            "-noverify",
        ])
        .arg(format!("-Xmx{}m", self.xmx_mb))
        .arg("-jar")
        .arg(launcher)
        .arg("-configuration")
        .arg(config)
        .arg("-data")
        .arg(self.data_dir);
        Ok(cmd)
    }
}

/// 发给 jdt.ls 的 `java.*` 配置（initialize 与 didChangeConfiguration 共用）。
///
/// - `autobuild` 关：红线「禁止 jdt.ls 写用户文件」，也省 CPU；
/// - `format` 关：NC 代码是 CRLF + 制表符风格，任何自动格式化都是灾难；
/// - `.svn` 排除：不排除时索引会卡在 35% 一分钟以上（NC 工作副本每层都有 `.svn`）。
pub fn build_settings(runtime_home: &str) -> Value {
    json!({
        "java": {
            "configuration": { "runtimes": [{ "name": "JavaSE-1.8", "path": runtime_home, "default": true }] },
            "autobuild": { "enabled": false },
            "format": { "enabled": false },
            "import": { "exclusions": ["**/.svn/**"] },
            "errors": { "incompleteClasspath": { "severity": "ignore" } },
            "completion": { "maxResults": 50 }
        }
    })
}

/// `initialize` 请求的参数。
///
/// 客户端不声明 `workspace.applyEdit`：服务端的代码修复/重命名就不会向我们要写文件
/// （红线：jdt.ls 的修改只能落到编辑器 model，由用户自己保存）。
pub fn build_initialize_params(root_path: &str, runtime_home: &str, process_id: u32) -> Value {
    let root_uri = path_to_uri(root_path);
    json!({
        "processId": process_id,
        "rootUri": root_uri,
        "rootPath": root_path,
        "workspaceFolders": [{ "uri": root_uri, "name": "nc-forge" }],
        "capabilities": {
            "textDocument": {
                "completion": { "completionItem": { "snippetSupport": false } },
                "hover": { "contentFormat": ["markdown", "plaintext"] },
                "definition": { "linkSupport": false },
                "signatureHelp": {},
                "publishDiagnostics": {}
            },
            "workspace": {
                "workspaceFolders": true,
                "configuration": true,
                "didChangeConfiguration": { "dynamicRegistration": true },
                "applyEdit": false
            }
        },
        "initializationOptions": {
            "settings": build_settings(runtime_home),
            "extendedClientCapabilities": { "classFileContentsSupport": true, "progressReportProvider": false }
        }
    })
}

// ───────────────────────── 客户端 ─────────────────────────

/// 服务端主动发来的消息的处理方。
pub trait LspHandler: Send + Sync {
    /// 通知（`textDocument/publishDiagnostics`、`language/status` 等）。在读取线程里调用，别做重活。
    fn on_notification(&self, method: &str, params: Value);
    /// 服务端发来的请求（`client/registerCapability`、`workspace/configuration` 等），返回值作为 result。
    fn on_request(&self, _method: &str, _params: &Value) -> Value {
        Value::Null
    }
}

type Pending = Arc<Mutex<HashMap<i64, Sender<Result<Value, String>>>>>;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub struct LspClient {
    child: Mutex<Child>,
    stdin: Arc<Mutex<ChildStdin>>,
    next_id: AtomicI64,
    pending: Pending,
    alive: Arc<AtomicBool>,
}

fn write_frame(stdin: &Mutex<ChildStdin>, msg: &Value) -> Result<(), String> {
    let mut w = lock(stdin);
    w.write_all(&encode_message(msg))
        .and_then(|()| w.flush())
        .map_err(|e| format!("写入语言服务失败: {e}"))
}

impl LspClient {
    /// 拉起进程并开始读取。进程的 stderr 丢弃（jdt.ls 的日志量很大且对用户无用）。
    pub fn spawn(mut cmd: Command, handler: Arc<dyn LspHandler>) -> Result<Self, String> {
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW：不弹控制台窗口
        }
        let mut child = cmd.spawn().map_err(|e| format!("无法启动语言服务: {e}"))?;
        let stdin = Arc::new(Mutex::new(
            child.stdin.take().ok_or("无法取得语言服务的输入管道")?,
        ));
        let mut stdout = child.stdout.take().ok_or("无法取得语言服务的输出管道")?;
        let pending: Pending = Arc::default();
        let alive = Arc::new(AtomicBool::new(true));

        let (r_pending, r_alive, r_stdin) = (pending.clone(), alive.clone(), stdin.clone());
        std::thread::spawn(move || {
            let mut decoder = FrameDecoder::default();
            let mut buf = [0u8; 16 * 1024];
            let reason = loop {
                match stdout.read(&mut buf) {
                    Ok(0) => break "语言服务进程已退出".to_string(),
                    Err(e) => break format!("读取语言服务输出失败: {e}"),
                    Ok(n) => match decoder.push(&buf[..n]) {
                        Err(e) => break e,
                        Ok(messages) => {
                            for m in messages {
                                dispatch(&m, &*handler, &r_pending, &r_stdin);
                            }
                        }
                    },
                }
            };
            // 先标记不可用再清空等待者：否则新请求可能在清空之后才登记，永远等不到回复
            r_alive.store(false, Ordering::SeqCst);
            for (_, tx) in lock(&r_pending).drain() {
                let _ = tx.send(Err(reason.clone()));
            }
        });

        Ok(Self {
            child: Mutex::new(child),
            stdin,
            next_id: AtomicI64::new(1),
            pending,
            alive,
        })
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    /// 发请求并等回复。超时会向服务端发 `$/cancelRequest`，避免它继续为已放弃的请求算下去。
    pub fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        if !self.is_alive() {
            return Err("语言服务未在运行".to_string());
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();
        lock(&self.pending).insert(id, tx);
        // 登记之后再确认一次：进程若恰好在两步之间退出，读取线程已经清空过等待者了
        if !self.is_alive() {
            lock(&self.pending).remove(&id);
            return Err("语言服务未在运行".to_string());
        }
        if let Err(e) = write_frame(
            &self.stdin,
            &json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }),
        ) {
            lock(&self.pending).remove(&id);
            return Err(e);
        }
        match rx.recv_timeout(timeout) {
            Ok(result) => result,
            Err(RecvTimeoutError::Timeout) => {
                lock(&self.pending).remove(&id);
                let _ = self.notify("$/cancelRequest", json!({ "id": id }));
                Err(format!(
                    "语言服务请求超时（{method}，{:.1} 秒）",
                    timeout.as_secs_f32()
                ))
            }
            Err(RecvTimeoutError::Disconnected) => Err("语言服务进程已退出".to_string()),
        }
    }

    pub fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        if !self.is_alive() {
            return Err("语言服务未在运行".to_string());
        }
        write_frame(
            &self.stdin,
            &json!({ "jsonrpc": "2.0", "method": method, "params": params }),
        )
    }

    /// 礼貌退出：shutdown + exit，等几秒，还不走就杀。
    pub fn shutdown(&self) {
        if self.is_alive() {
            let _ = self.request("shutdown", Value::Null, Duration::from_secs(10));
            let _ = self.notify("exit", Value::Null);
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if matches!(lock(&self.child).try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        self.kill();
    }

    pub fn kill(&self) {
        let mut child = lock(&self.child);
        let _ = child.kill();
        let _ = child.wait();
    }
}

impl Drop for LspClient {
    /// 兜底：jdt.ls 常驻约 700MB，遗留成孤儿进程代价很大。
    fn drop(&mut self) {
        self.kill();
    }
}

/// 分派读到的一条消息：回复 → 唤醒等待者；服务端请求 → 应答；通知 → 交给处理方。
fn dispatch(m: &Value, handler: &dyn LspHandler, pending: &Pending, stdin: &Mutex<ChildStdin>) {
    let method = m.get("method").and_then(Value::as_str);
    let params = m.get("params").unwrap_or(&Value::Null);
    match (method, m.get("id")) {
        (Some(method), Some(id)) => {
            let result = handler.on_request(method, params);
            let _ = write_frame(
                stdin,
                &json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            );
        }
        (Some(method), None) => handler.on_notification(method, params.clone()),
        (None, Some(id)) => {
            let Some(id) = id.as_i64() else { return };
            let Some(tx) = lock(pending).remove(&id) else {
                return;
            };
            let outcome = match m.get("error") {
                Some(err) => Err(err
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("语言服务返回了错误")
                    .to_string()),
                None => Ok(m.get("result").cloned().unwrap_or(Value::Null)),
            };
            let _ = tx.send(outcome);
        }
        (None, None) => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_length_counts_bytes_not_chars() {
        let msg = json!({ "m": "中文诊断" });
        let frame = encode_message(&msg);
        let text = String::from_utf8(frame.clone()).unwrap();
        let body = text.split("\r\n\r\n").nth(1).unwrap();
        assert!(text.starts_with(&format!("Content-Length: {}\r\n", body.len())));
        assert!(body.len() > body.chars().count());
        assert_eq!(FrameDecoder::default().push(&frame).unwrap(), vec![msg]);
    }

    #[test]
    fn decoder_handles_byte_by_byte_and_glued_frames() {
        let (a, b) = (
            json!({ "id": 1, "result": "甲" }),
            json!({ "method": "x", "params": [1, 2] }),
        );
        let mut all = encode_message(&a);
        all.extend(encode_message(&b));

        // 一次一个字节：任意切分点都不能丢、不能错位
        let mut dec = FrameDecoder::default();
        let mut got = Vec::new();
        for byte in &all {
            got.extend(dec.push(std::slice::from_ref(byte)).unwrap());
        }
        assert_eq!(got, vec![a.clone(), b.clone()]);

        // 两帧粘在一起一次性到达
        assert_eq!(FrameDecoder::default().push(&all).unwrap(), vec![a, b]);
    }

    #[test]
    fn decoder_accepts_case_insensitive_and_extra_headers() {
        let body = br#"{"a":1}"#;
        let mut frame = format!(
            "content-length: {}\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n",
            body.len()
        )
        .into_bytes();
        frame.extend_from_slice(body);
        assert_eq!(
            FrameDecoder::default().push(&frame).unwrap(),
            vec![json!({ "a": 1 })]
        );
    }

    #[test]
    fn decoder_rejects_broken_protocol() {
        assert!(FrameDecoder::default().push(b"Foo: 1\r\n\r\n{}").is_err());
        assert!(FrameDecoder::default()
            .push(b"Content-Length: abc\r\n\r\n{}")
            .is_err());
        assert!(FrameDecoder::default()
            .push(b"Content-Length: 3\r\n\r\n{x}")
            .is_err());
    }

    #[test]
    fn uri_round_trip_with_chinese_and_spaces() {
        let path = r"D:\工程 一\newar\gl\A.java";
        let uri = path_to_uri(path);
        assert!(uri.starts_with("file:///D:/"));
        assert!(!uri.contains(' ') && uri.is_ascii());
        assert_eq!(uri_to_path(&uri).as_deref(), Some(path));
        assert_eq!(path_to_uri(r"\\?\C:\w"), "file:///C:/w");
        assert_eq!(
            uri_to_path("jdt://contents/rt.jar/java.util/List.class"),
            None
        );
        assert_eq!(
            uri_to_path("file:///home/a%20b").as_deref(),
            Some("/home/a b")
        );
    }

    #[test]
    fn initialize_params_follow_probe_findings() {
        let p = build_initialize_params(r"C:\shadow", r"D:\ncc\1909home\ufjdk", 7);
        let opts = &p["initializationOptions"];
        assert_eq!(
            opts["extendedClientCapabilities"]["classFileContentsSupport"],
            true
        );
        assert_eq!(
            opts["settings"]["java"]["configuration"]["runtimes"][0]["path"],
            r"D:\ncc\1909home\ufjdk"
        );
        assert_eq!(opts["settings"]["java"]["autobuild"]["enabled"], false);
        assert_eq!(opts["settings"]["java"]["format"]["enabled"], false);
        assert_eq!(
            opts["settings"]["java"]["import"]["exclusions"][0],
            "**/.svn/**"
        );
        // initializationOptions.workspaceFolders 一旦出现必须是字符串数组；我们干脆不放
        assert!(opts.get("workspaceFolders").is_none());
        // 红线：不声明 applyEdit，服务端就不会让我们写文件
        assert_eq!(p["capabilities"]["workspace"]["applyEdit"], false);
        assert_eq!(p["rootUri"], "file:///C:/shadow");
    }

    #[test]
    fn launch_command_finds_launcher_jar() {
        let dir = std::env::temp_dir().join(format!("nc-forge-lsp-launch-{}", std::process::id()));
        let plugins = dir.join("plugins");
        std::fs::create_dir_all(&plugins).unwrap();
        std::fs::write(
            plugins.join("org.eclipse.equinox.launcher.win32.win32.x86_64_1.jar"),
            b"",
        )
        .unwrap();
        let spec = JdtlsLaunch {
            java_exe: Path::new("java"),
            ls_dir: &dir,
            data_dir: Path::new("data"),
            xmx_mb: 1024,
        };
        assert!(
            spec.command().is_err(),
            "只有 win32 片段 jar 时不能当成启动 jar"
        );
        std::fs::write(
            plugins.join("org.eclipse.equinox.launcher_1.5.800.jar"),
            b"",
        )
        .unwrap();
        let cmd = spec.command().unwrap();
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(args.contains(&"-Xmx1024m".to_string()));
        assert!(args
            .iter()
            .any(|a| a.ends_with("org.eclipse.equinox.launcher_1.5.800.jar")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── 以下用本机真实的 jdt.ls 跑一遍进程层；机器上没有就跳过（CI 没有）。──

    struct Quiet;
    impl LspHandler for Quiet {
        fn on_notification(&self, _method: &str, _params: Value) {}
    }

    fn real_launch(tag: &str) -> Option<(PathBuf, PathBuf, PathBuf)> {
        let java = PathBuf::from(r"D:\ncc\1909home\ufjdk\bin\java.exe");
        let ls = PathBuf::from(r"D:\AItool\aiwork\nc-workbench-m0\jdtls\ls");
        if !java.is_file() || !ls.join("plugins").is_dir() {
            return None;
        }
        let data = std::env::temp_dir().join(format!("nc-forge-lsp-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        Some((java, ls, data))
    }

    fn start(java: &Path, ls: &Path, data: &Path) -> LspClient {
        let cmd = JdtlsLaunch {
            java_exe: java,
            ls_dir: ls,
            data_dir: data,
            xmx_mb: 512,
        }
        .command()
        .unwrap();
        LspClient::spawn(cmd, Arc::new(Quiet)).unwrap()
    }

    #[test]
    fn real_jdtls_initializes_and_shuts_down() {
        let Some((java, ls, data)) = real_launch("init") else {
            return;
        };
        let client = start(&java, &ls, &data);
        let root = std::env::temp_dir().to_string_lossy().into_owned();
        let res = client
            .request(
                "initialize",
                build_initialize_params(&root, r"D:\ncc\1909home\ufjdk", std::process::id()),
                Duration::from_secs(60),
            )
            .expect("initialize 应成功");
        assert_eq!(res["capabilities"]["definitionProvider"], true);
        client.shutdown();
        assert!(client
            .request(
                "workspace/symbol",
                json!({ "query": "x" }),
                Duration::from_secs(1)
            )
            .is_err());
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn real_jdtls_request_times_out_and_crash_fails_pending_fast() {
        let Some((java, ls, data)) = real_launch("crash") else {
            return;
        };
        let client = start(&java, &ls, &data);
        // 刚拉起的 jdt.ls 不可能 1 毫秒内回 initialize：必须是超时错误而不是卡死
        let err = client
            .request(
                "initialize",
                json!({ "processId": null, "rootUri": null, "capabilities": {} }),
                Duration::from_millis(1),
            )
            .unwrap_err();
        assert!(err.contains("超时"), "{err}");
        // 进程被杀后，请求应当立刻失败（而不是等满超时）
        client.kill();
        let started = Instant::now();
        let err = client
            .request(
                "workspace/symbol",
                json!({ "query": "x" }),
                Duration::from_secs(30),
            )
            .unwrap_err();
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "崩溃后请求应当快速失败: {err}"
        );
        assert!(!client.is_alive());
        let _ = std::fs::remove_dir_all(&data);
    }
}
