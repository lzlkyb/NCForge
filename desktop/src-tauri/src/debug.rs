//! 调试适配器协议（DAP）客户端与调试会话状态。
//!
//! 链路：本模块 ↔ TCP `127.0.0.1:<java-debug 端口>`（jdt.ls 里的 java-debug bundle）
//! ↔ JDWP `127.0.0.1:<启动时分配的端口>`（NC 中间件 JVM）。
//!
//! 分帧与 LSP 相同（`Content-Length`），直接复用 `lsp` 的编解码；但 DAP 是**有状态会话**：
//! `initialize` → `attach` → `setBreakpoints` → `configurationDone`，之后由适配器主动推
//! `stopped` / `output` / `terminated` 事件。事件必须原样转给前端，丢掉一个 `stopped`
//! 界面就会一直停在「运行中」。
//!
//! 纯逻辑模块，不含 tauri 类型：命令层（`commands/debug_cmds.rs`）负责发事件与路径映射。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde_json::{json, Value};

use crate::lsp::{encode_message, FrameDecoder};

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// 适配器主动发来的事件。
pub trait DapHandler: Send + Sync {
    /// `stopped` / `output` / `terminated` / `thread` / `breakpoint` 等。在读取线程里调用，别做重活。
    fn on_event(&self, event: &str, body: Value);
    /// 连接断开或协议出错后调用一次（主动 `close` 也会触发，由调用方按代数判断是否意外）。
    fn on_exit(&self, _reason: &str) {}
}

type Pending = Arc<Mutex<HashMap<i64, Sender<Result<Value, String>>>>>;

/// 与 java-debug 的一条 DAP 连接。
///
/// 读写共用同一把写锁（`stream` 存 `Arc<Mutex<_>>` 而不是各拿一个克隆的 `TcpStream`）：
/// 请求线程与读取线程（回应反向请求时）都会写，两份句柄各带一把锁时两个帧会交错，
/// 适配器收到半帧就整条连接报协议错。
pub struct DapClient {
    stream: Arc<Mutex<TcpStream>>,
    next_seq: AtomicI64,
    pending: Pending,
    alive: Arc<AtomicBool>,
}

impl DapClient {
    /// 连上适配器并开始读事件。连接超时只罩住 TCP 握手（本机，正常是毫秒级）。
    pub fn connect(
        port: u16,
        handler: Arc<dyn DapHandler>,
        timeout: Duration,
    ) -> Result<Self, String> {
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        let stream = TcpStream::connect_timeout(&addr, timeout)
            .map_err(|e| format!("连不上调试适配器（127.0.0.1:{port}）：{e}"))?;
        let _ = stream.set_nodelay(true);
        let read_stream = stream
            .try_clone()
            .map_err(|e| format!("复制调试连接失败：{e}"))?;
        let pending: Pending = Arc::default();
        let alive = Arc::new(AtomicBool::new(true));
        let stream = Arc::new(Mutex::new(stream));
        let (r_pending, r_alive, writer) = (pending.clone(), alive.clone(), stream.clone());

        let (w_pending, w_alive) = (r_pending.clone(), r_alive.clone());
        std::thread::spawn(move || {
            let mut decoder = FrameDecoder::default();
            let mut buf = [0u8; 16 * 1024];
            let mut s = read_stream;
            let reason = loop {
                match s.read(&mut buf) {
                    Ok(0) => break "调试适配器已断开".to_string(),
                    Err(e) => break format!("读取调试适配器失败：{e}"),
                    Ok(n) => match decoder.push(&buf[..n]) {
                        Err(e) => break e,
                        Ok(msgs) => {
                            for m in msgs {
                                dispatch(&m, &*handler, &w_pending, &writer);
                            }
                        }
                    },
                }
            };
            w_alive.store(false, Ordering::SeqCst);
            for (_, tx) in lock(&w_pending).drain() {
                let _ = tx.send(Err(reason.clone()));
            }
            handler.on_exit(&reason);
        });

        Ok(Self {
            stream,
            next_seq: AtomicI64::new(1),
            pending,
            alive,
        })
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    /// 发请求并等回复，返回响应里的 `body`（没有 body 时为 `null`）。
    pub fn request(&self, command: &str, args: Value, timeout: Duration) -> Result<Value, String> {
        if !self.is_alive() {
            return Err("调试会话已结束".to_string());
        }
        let seq = self.next_seq.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();
        lock(&self.pending).insert(seq, tx);
        let frame = json!({
            "seq": seq,
            "type": "request",
            "command": command,
            "arguments": args,
        });
        if let Err(e) = write_frame(&self.stream, &frame) {
            lock(&self.pending).remove(&seq);
            return Err(e);
        }
        match rx.recv_timeout(timeout) {
            Ok(v) => v,
            Err(RecvTimeoutError::Timeout) => {
                lock(&self.pending).remove(&seq);
                Err(format!(
                    "调试请求超时（{command}，{:.0} 秒）",
                    timeout.as_secs_f32()
                ))
            }
            Err(RecvTimeoutError::Disconnected) => Err("调试会话已结束".to_string()),
        }
    }

    /// 结束会话：先礼貌 `disconnect`，再断开 socket（读取线程随之退出）。
    pub fn close(&self) {
        if self.is_alive() {
            let _ = self.request(
                "disconnect",
                json!({ "terminateDebuggee": false }),
                Duration::from_secs(2),
            );
        }
        self.kill();
    }

    /// 只断连接（不走 `disconnect` 请求），用于适配器已经自己断开的情形。
    pub fn kill(&self) {
        self.alive.store(false, Ordering::SeqCst);
        let _ = lock(&self.stream).shutdown(Shutdown::Both);
        for (_, tx) in lock(&self.pending).drain() {
            let _ = tx.send(Err("调试会话已结束".to_string()));
        }
    }
}

impl Drop for DapClient {
    fn drop(&mut self) {
        self.kill();
    }
}

fn write_frame(stream: &Mutex<TcpStream>, msg: &Value) -> Result<(), String> {
    let mut w = lock(stream);
    w.write_all(&encode_message(msg))
        .and_then(|()| w.flush())
        .map_err(|e| format!("写入调试适配器失败：{e}"))
}

/// 适配器可以反向发 `runInTerminal` 之类的请求；不支持的一律明确回失败，
/// 让它自己降级，而不是干等一个永远不来的结果。
fn dispatch(m: &Value, handler: &dyn DapHandler, pending: &Pending, stream: &Mutex<TcpStream>) {
    match m.get("type").and_then(Value::as_str) {
        Some("response") => {
            let Some(seq) = m.get("request_seq").and_then(Value::as_i64) else {
                return;
            };
            let Some(tx) = lock(pending).remove(&seq) else {
                return;
            };
            let ok = m.get("success").and_then(Value::as_bool).unwrap_or(false);
            let outcome = if ok {
                Ok(m.get("body").cloned().unwrap_or(Value::Null))
            } else {
                Err(m
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("调试适配器返回了错误")
                    .to_string())
            };
            let _ = tx.send(outcome);
        }
        Some("event") => {
            let event = m.get("event").and_then(Value::as_str).unwrap_or("");
            handler.on_event(event, m.get("body").cloned().unwrap_or(Value::Null));
        }
        Some("request") => {
            let seq = m.get("seq").and_then(Value::as_i64).unwrap_or(0);
            let command = m.get("command").and_then(Value::as_str).unwrap_or("");
            let _ = write_frame(
                stream,
                &json!({
                    "seq": 0,
                    "type": "response",
                    "request_seq": seq,
                    "success": false,
                    "command": command,
                    "message": "工作台不支持该反向请求",
                }),
            );
        }
        _ => {}
    }
}

// ───────────────────────── 会话状态 ─────────────────────────

/// 前端能看到的调试状态（`debug-status` 事件与 `debug_status` 命令共用）。
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DebugStatus {
    /// `stopped` / `attached`。
    pub state: String,
    pub module: Option<String>,
    /// java-debug 的 DAP 端口（调试器与适配器之间）。
    pub dap_port: Option<u16>,
    /// 中间件 JVM 的 JDWP 端口（适配器与调试目标之间）。
    pub jdwp_port: Option<u16>,
    /// 最近一次断开/失败的原因（正常停止时为空）。
    pub message: String,
}

impl DebugStatus {
    pub fn stopped() -> Self {
        Self {
            state: "stopped".into(),
            module: None,
            dap_port: None,
            jdwp_port: None,
            message: String::new(),
        }
    }
}

/// 一条已建立的调试会话。
pub struct DebugSession {
    pub client: DapClient,
    pub module: String,
    pub jdwp_port: u16,
    pub dap_port: u16,
    /// 建立时对应的语言服务会话：请求结果与事件都要按它的前缀映射回真实路径。
    /// 语言服务重启后前缀可能变，所以会话自己留一份，不每次现取。
    pub lang: Arc<crate::lang::LangSession>,
}

/// `AppState.debug` 持有。
pub struct DebugRun {
    pub session: Option<Arc<DebugSession>>,
    pub status: DebugStatus,
    /// 每次拉起/停止自增。断开回调据此判断「断的是不是当前这一代」，
    /// 主动停止的收尾不会把刚建立的新会话误判成崩溃。
    pub generation: u64,
}

impl Default for DebugRun {
    fn default() -> Self {
        Self {
            session: None,
            status: DebugStatus::stopped(),
            generation: 0,
        }
    }
}

/// 摘掉当前会话（连接在返回值 drop 时关闭），并把状态置为已停止。
pub fn take_session(run: &mut DebugRun) -> Option<Arc<DebugSession>> {
    run.generation += 1;
    run.status = DebugStatus::stopped();
    run.session.take()
}

// ───────────────────────── DAP 参数构造（纯函数，可单测） ─────────────────────────

/// `initialize` 参数。`pathFormat: "path"` 让适配器收发的都是本地路径而不是 URI。
///
/// 不声明 `supportsRunInTerminalRequest`：NC 中间件由工作台自己起，调试时只需要
/// attach，不需要适配器再帮我们拉进程。
pub fn initialize_args() -> Value {
    json!({
        "clientID": "nc-forge",
        "adapterID": "java",
        "pathFormat": "path",
        "linesStartAt1": true,
        "columnsStartAt1": true,
        "supportsVariableType": true,
        "supportsVariablePaging": true,
        "supportsRunInTerminalRequest": false,
        "supportsDelayedStackTraceLoading": false,
        "supportsHitConditionalBreakpoints": true,
    })
}

/// `attach` 参数：连上已经开着的 JDWP，`suspend=n` 的 JVM 不会停等。
///
/// `projectName` 必须是 jdt.ls 里的工程名（影子工程，见 `shadow::PROJECT_NAME`）：
/// java-debug 靠它向语言服务要 classpath，拿不到就解析不出类与源码的对应关系。
pub fn attach_args(jdwp_port: u16, project_name: &str, source_paths: &[String]) -> Value {
    json!({
        "request": "attach",
        "hostName": "127.0.0.1",
        "port": jdwp_port,
        "projectName": project_name,
        "sourcePaths": source_paths,
        "timeout": 30_000,
    })
}

/// `setBreakpoints` 参数。行号 1 基（与编辑器一致）。
pub fn set_breakpoints_args(source_path: &str, lines: &[u32]) -> Value {
    let breakpoints: Vec<Value> = lines.iter().map(|l| json!({ "line": l })).collect();
    json!({
        "source": { "path": source_path, "name": source_path.rsplit(['\\', '/']).next().unwrap_or("") },
        "breakpoints": breakpoints,
        "sourceModified": false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attach_只连回环并带影子工程名() {
        let a = attach_args(61539, "nc-forge-shadow", &[r"D:\shadow\gl".to_string()]);
        assert_eq!(a["hostName"], "127.0.0.1");
        assert_eq!(a["port"], 61539);
        assert_eq!(a["request"], "attach");
        assert_eq!(a["projectName"], "nc-forge-shadow");
        // sourcePaths 必须是数组：java-debug 对单个字符串会静默不解析
        assert!(a["sourcePaths"].is_array());
    }

    #[test]
    fn 断点参数按行号逐条给出且源名取文件名() {
        let b = set_breakpoints_args(r"D:\ws\gl\src\A.java", &[3, 9]);
        assert_eq!(b["source"]["path"], r"D:\ws\gl\src\A.java");
        assert_eq!(b["source"]["name"], "A.java");
        assert_eq!(b["breakpoints"][0]["line"], 3);
        assert_eq!(b["breakpoints"][1]["line"], 9);
        // 空行列表 = 清空该文件的所有断点，必须仍然是数组而不是缺失
        let none = set_breakpoints_args(r"C:/x/B.java", &[]);
        assert_eq!(none["breakpoints"], json!([]));
        assert_eq!(none["source"]["name"], "B.java");
    }

    #[test]
    fn initialize_用本地路径格式() {
        let i = initialize_args();
        assert_eq!(i["pathFormat"], "path");
        assert_eq!(i["adapterID"], "java");
        assert_eq!(i["linesStartAt1"], true);
        assert_eq!(i["supportsRunInTerminalRequest"], false);
    }
}
