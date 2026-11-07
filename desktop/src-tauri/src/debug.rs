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

/// 调试目标。中间件和客户端是两个独立 JVM，各自一条 DAP 会话：
/// 同一条会话不能同时 attach 两个 JDWP，否则线程列表和断点会互相污染。
/// `Remote` 是用户手工填地址的第三个槽：远端 JVM 不归工作台启动，只附加。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DebugTarget {
    /// NC 中间件（Tomcat）。
    Server,
    /// NC 客户端（Swing `JStarter`）。
    Client,
    /// 远程 JVM（地址由用户填写，通常经 SSH 隧道连本机回环端口）。
    Remote,
}

impl DebugTarget {
    /// 命令参数是字符串（前端 invoke 的 `target`），这里给出能直接显示的报错。
    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw {
            "server" => Ok(Self::Server),
            "client" => Ok(Self::Client),
            "remote" => Ok(Self::Remote),
            other => Err(format!(
                "未知调试目标「{other}」：只能是 server（中间件）、client（客户端）或 remote（远程）"
            )),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Server => "server",
            Self::Client => "client",
            Self::Remote => "remote",
        }
    }

    /// 错误文案里用的中文名。
    pub fn label(self) -> &'static str {
        match self {
            Self::Server => "中间件",
            Self::Client => "客户端",
            Self::Remote => "远程",
        }
    }
}

impl std::fmt::Display for DebugTarget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 适配器在 `initialize` 回复里给出的异常断点过滤器（java-debug 0.32 是 caught / uncaught）。
///
/// 不写死在前端：过滤器是适配器的能力，版本换了名字就得跟着变。UI 只按这份清单渲染开关。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExceptionFilter {
    pub filter: String,
    pub label: String,
    pub default: bool,
}

/// 前端能看到的调试状态（`debug-status` 事件与 `debug_status` 命令共用）。
///
/// `target` 随状态一起下发：前端有两个会话槽，事件不带目标就不知道该更新哪一个。
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DebugStatus {
    pub target: DebugTarget,
    /// `stopped` / `attached`。
    pub state: String,
    pub module: Option<String>,
    /// java-debug 的 DAP 端口（调试器与适配器之间）。
    pub dap_port: Option<u16>,
    /// 被调试 JVM 的 JDWP 端口（适配器与调试目标之间）。
    pub jdwp_port: Option<u16>,
    /// 被调试 JVM 的 JDWP 主机。本机附加是 127.0.0.1，远程附加是用户填的地址。
    pub jdwp_host: Option<String>,
    /// 最近一次断开/失败的原因（正常停止时为空）。
    pub message: String,
    /// 适配器支持的异常断点过滤器（未附加时为空）。
    pub exception_filters: Vec<ExceptionFilter>,
}

impl DebugStatus {
    pub fn stopped(target: DebugTarget) -> Self {
        Self {
            target,
            state: "stopped".into(),
            module: None,
            dap_port: None,
            jdwp_port: None,
            jdwp_host: None,
            message: String::new(),
            exception_filters: Vec::new(),
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

/// 单个调试目标的会话槽。
pub struct TargetRun {
    pub session: Option<Arc<DebugSession>>,
    pub status: DebugStatus,
    /// 每次拉起/停止自增。断开回调据此判断「断的是不是当前这一代」，
    /// 主动停止的收尾不会把刚建立的新会话误判成崩溃。
    pub generation: u64,
}

impl Default for TargetRun {
    fn default() -> Self {
        Self {
            session: None,
            status: DebugStatus::stopped(DebugTarget::Server),
            generation: 0,
        }
    }
}

/// `AppState.debug` 持有：三个目标各一个槽。
///
/// 分开存而不是「一个会话 + 当前目标」：中间件和客户端可以同时附加，
/// 远程 JVM 也能并行；任一边命中断点都要能独立停下来、独立断开，互不影响对方的线程与栈。
pub struct DebugRun {
    pub server: TargetRun,
    pub client: TargetRun,
    pub remote: TargetRun,
}

impl Default for DebugRun {
    fn default() -> Self {
        Self {
            server: TargetRun::default(),
            // `TargetRun::default` 的时间字段不区分目标，这里把状态里的目标改对，
            // 否则客户端从未附加时 `debug_status("client")` 会返回 target=server。
            client: TargetRun {
                status: DebugStatus::stopped(DebugTarget::Client),
                ..TargetRun::default()
            },
            remote: TargetRun {
                status: DebugStatus::stopped(DebugTarget::Remote),
                ..TargetRun::default()
            },
        }
    }
}

impl DebugRun {
    pub fn slot(&mut self, target: DebugTarget) -> &mut TargetRun {
        match target {
            DebugTarget::Server => &mut self.server,
            DebugTarget::Client => &mut self.client,
            DebugTarget::Remote => &mut self.remote,
        }
    }

    pub fn slot_ref(&self, target: DebugTarget) -> &TargetRun {
        match target {
            DebugTarget::Server => &self.server,
            DebugTarget::Client => &self.client,
            DebugTarget::Remote => &self.remote,
        }
    }
}

/// 摘掉某个目标的会话（连接在返回值 drop 时关闭），并把该目标状态置为已停止。
pub fn take_session(run: &mut DebugRun, target: DebugTarget) -> Option<Arc<DebugSession>> {
    let slot = run.slot(target);
    slot.generation += 1;
    slot.status = DebugStatus::stopped(target);
    slot.session.take()
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
/// `host` 本机固定 127.0.0.1；远程附加由用户填地址（通常是 SSH 隧道映射到本机的端口，
/// 这样远端 JDWP 仍只需绑它自己的回环，不必对网络敞开）。
///
/// `projectName` 必须是 jdt.ls 里的工程名（影子工程，见 `shadow::PROJECT_NAME`）：
/// java-debug 靠它向语言服务要 classpath，拿不到就解析不出类与源码的对应关系。
pub fn attach_args(
    host: &str,
    jdwp_port: u16,
    project_name: &str,
    source_paths: &[String],
) -> Value {
    json!({
        "request": "attach",
        "hostName": host,
        "port": jdwp_port,
        "projectName": project_name,
        "sourcePaths": source_paths,
        "timeout": 30_000,
    })
}

/// 远程附加的地址校验。主机缺省回落到回环（最常见的用法是 SSH 隧道映射到本机端口）。
///
/// 只做「能不能作为 socket 主机名」的基本检查：是否真的连得通由 attach 决定。
/// 端口不接受 0——那是让操作系统随机分配，对「连一个已经在跑的 JVM」没有意义。
pub fn remote_endpoint(host: Option<&str>, port: Option<u16>) -> Result<(String, u16), String> {
    let host = host
        .map(str::trim)
        .filter(|h| !h.is_empty())
        .unwrap_or("127.0.0.1");
    if host.len() > 253 || host.chars().any(char::is_whitespace) {
        return Err(format!("远程主机地址不合法：「{host}」"));
    }
    let port = port.filter(|p| *p > 0).ok_or_else(|| {
        "远程附加需要填 JDWP 端口：通常是 `ssh -L` 映射到本机的那个端口".to_string()
    })?;
    Ok((host.to_string(), port))
}

/// `setBreakpoints` 参数。行号 1 基（与编辑器一致）。
///
/// 条件 / 命中次数 / 日志消息都是可选的：空串按「没设置」处理，不发空字段——
/// java-debug 收到 `condition: ""` 会当成一个永远为假的表达式，断点就再也不会停。
pub fn set_breakpoints_args(source_path: &str, breakpoints: &[BreakpointSpec]) -> Value {
    let items: Vec<Value> = breakpoints
        .iter()
        .map(|b| {
            let mut m = serde_json::Map::new();
            m.insert("line".into(), json!(b.line));
            for (key, value) in [
                ("condition", b.condition.as_deref()),
                ("hitCondition", b.hit_condition.as_deref()),
                ("logMessage", b.log_message.as_deref()),
            ] {
                if let Some(text) = value.map(str::trim).filter(|s| !s.is_empty()) {
                    m.insert(key.into(), json!(text));
                }
            }
            Value::Object(m)
        })
        .collect();
    json!({
        "source": { "path": source_path, "name": source_path.rsplit(['\\', '/']).next().unwrap_or("") },
        "breakpoints": items,
        "sourceModified": false,
    })
}

/// 一条断点的可选语义。空 `None` = 普通行断点。
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BreakpointSpec {
    pub line: u32,
    #[serde(default)]
    pub condition: Option<String>,
    #[serde(default)]
    pub hit_condition: Option<String>,
    #[serde(default)]
    pub log_message: Option<String>,
}

/// 从 `initialize` 的回复里取异常断点过滤器。
///
/// 结构是 DAP 的 `ExceptionBreakpointsFilter[]`：`{ filter, label, default? }`。
/// 字段缺失时跳过而不是整份失败——少一个过滤器不影响其它调试功能。
pub fn parse_exception_filters(init_body: &Value) -> Vec<ExceptionFilter> {
    init_body
        .get("exceptionBreakpointFilters")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|f| {
                    let filter = f.get("filter")?.as_str()?.trim();
                    if filter.is_empty() {
                        return None;
                    }
                    Some(ExceptionFilter {
                        filter: filter.to_string(),
                        label: f
                            .get("label")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .unwrap_or(filter)
                            .to_string(),
                        default: f.get("default").and_then(Value::as_bool).unwrap_or(false),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// `setExceptionBreakpoints`：只发过滤器 id。java-debug 会按 caught / uncaught 在
/// 每次异常停靠时判断是否中断；空的 `filters` 就是全部关掉。
pub fn exception_breakpoints_args(filters: &[String]) -> Value {
    json!({ "filters": filters, "filterOptions": [] })
}

/// `variables`：`start` / `count` 只在父节点带 `indexedVariables` 时用于分页。
pub fn variables_args(reference: i64, start: Option<i64>, count: Option<i64>) -> Value {
    let mut args = json!({ "variablesReference": reference });
    if let Some(start) = start.filter(|n| *n >= 0) {
        args["start"] = json!(start);
    }
    if let Some(count) = count.filter(|n| *n > 0) {
        args["count"] = json!(count);
    }
    args
}

/// `setVariable`：暂停时改写当前帧可见变量（只改 JVM 里的值，不改源码）。
pub fn set_variable_args(reference: i64, name: &str, value: &str) -> Value {
    json!({ "variablesReference": reference, "name": name, "value": value })
}

/// `exceptionInfo`：停靠原因是 exception 时，向适配器要异常类型与消息。
pub fn exception_info_args(thread_id: i64) -> Value {
    json!({ "threadId": thread_id })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attach_带主机并默认回环() {
        let a = attach_args(
            "127.0.0.1",
            61539,
            "nc-forge-shadow",
            &[r"D:\shadow\gl".to_string()],
        );
        assert_eq!(a["hostName"], "127.0.0.1");
        assert_eq!(a["port"], 61539);
        assert_eq!(a["request"], "attach");
        assert_eq!(a["projectName"], "nc-forge-shadow");
        // sourcePaths 必须是数组：java-debug 对单个字符串会静默不解析
        assert!(a["sourcePaths"].is_array());

        // 远程附加把用户地址原样交给适配器（通常指向 SSH 隧道映射的本机端口）
        let r = attach_args("10.0.0.8", 5005, "nc-forge-shadow", &[]);
        assert_eq!(r["hostName"], "10.0.0.8");
        assert_eq!(r["port"], 5005);
    }

    #[test]
    fn 断点参数按行号逐条给出且源名取文件名() {
        let b = set_breakpoints_args(
            r"D:\ws\gl\src\A.java",
            &[
                BreakpointSpec {
                    line: 3,
                    ..Default::default()
                },
                BreakpointSpec {
                    line: 9,
                    ..Default::default()
                },
            ],
        );
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
    fn 条件断点只发非空字段() {
        let b = set_breakpoints_args(
            r"D:\ws\gl\src\A.java",
            &[
                BreakpointSpec {
                    line: 12,
                    condition: Some("  vo.getCode() != null  ".into()),
                    hit_condition: Some("5".into()),
                    log_message: None,
                },
                BreakpointSpec {
                    line: 13,
                    condition: Some("   ".into()),
                    hit_condition: None,
                    log_message: Some("code = {vo.getCode()}".into()),
                },
            ],
        );
        let first = &b["breakpoints"][0];
        assert_eq!(first["condition"], "vo.getCode() != null");
        assert_eq!(first["hitCondition"], "5");
        assert!(first.get("logMessage").is_none());
        // 空白条件不能下变成恒假表达式
        let second = &b["breakpoints"][1];
        assert!(second.get("condition").is_none());
        assert_eq!(second["logMessage"], "code = {vo.getCode()}");
    }

    #[test]
    fn 解析异常断点过滤器() {
        let init = json!({
            "supportsSetVariable": true,
            "exceptionBreakpointFilters": [
                { "filter": "caught", "label": "Caught Exceptions" },
                { "filter": "uncaught", "label": "Uncaught Exceptions", "default": true },
                { "label": "缺 filter 的条目应跳过" }
            ]
        });
        let filters = parse_exception_filters(&init);
        assert_eq!(filters.len(), 2);
        assert_eq!(filters[0].filter, "caught");
        assert_eq!(filters[0].label, "Caught Exceptions");
        assert!(!filters[0].default);
        assert!(filters[1].default);
        assert!(parse_exception_filters(&json!({})).is_empty());
        assert!(parse_exception_filters(&json!(null)).is_empty());
    }

    #[test]
    fn 变量分页与改写参数() {
        let all = variables_args(9, None, None);
        assert_eq!(all, json!({ "variablesReference": 9 }));
        let page = variables_args(9, Some(100), Some(50));
        assert_eq!(page["start"], 100);
        assert_eq!(page["count"], 50);
        // 非法分页值不能发出去：适配器对负 start 会报错
        let bad = variables_args(9, Some(-1), Some(0));
        assert!(bad.get("start").is_none());
        assert!(bad.get("count").is_none());

        let set = set_variable_args(9, "count", "42");
        assert_eq!(set["name"], "count");
        assert_eq!(set["value"], "42");
        assert_eq!(exception_info_args(7)["threadId"], 7);
    }

    #[test]
    fn 调试目标解析与序列化() {
        assert_eq!(DebugTarget::parse("server"), Ok(DebugTarget::Server));
        assert_eq!(DebugTarget::parse("client"), Ok(DebugTarget::Client));
        assert_eq!(DebugTarget::parse("remote"), Ok(DebugTarget::Remote));
        assert!(DebugTarget::parse("ui").unwrap_err().contains("server"));
        assert_eq!(
            serde_json::to_value(DebugTarget::Client).unwrap(),
            json!("client")
        );
        assert_eq!(
            serde_json::to_value(DebugTarget::Remote).unwrap(),
            json!("remote")
        );
    }

    #[test]
    fn 远程地址校验() {
        // 不填主机 = SSH 隧道到本机；端口必须有
        assert_eq!(
            remote_endpoint(None, Some(5005)),
            Ok(("127.0.0.1".into(), 5005))
        );
        assert_eq!(
            remote_endpoint(Some("  10.1.2.3  "), Some(5005)),
            Ok(("10.1.2.3".into(), 5005))
        );
        assert!(remote_endpoint(None, None).unwrap_err().contains("端口"));
        assert!(remote_endpoint(None, Some(0)).unwrap_err().contains("端口"));
        assert!(remote_endpoint(Some("a b"), Some(5005))
            .unwrap_err()
            .contains("不合法"));
    }

    #[test]
    fn 三个目标的调试槽互不影响() {
        let mut run = DebugRun::default();
        assert_eq!(run.server.status.target, DebugTarget::Server);
        assert_eq!(run.client.status.target, DebugTarget::Client);
        assert_eq!(run.remote.status.target, DebugTarget::Remote);

        // 只清 server：client / remote 的代数与状态不能被带着走
        let _ = take_session(&mut run, DebugTarget::Server);
        assert_eq!(run.server.generation, 1);
        assert_eq!(run.client.generation, 0);
        assert_eq!(run.remote.generation, 0);
        assert_eq!(run.client.status.target, DebugTarget::Client);
        assert_eq!(run.remote.status.target, DebugTarget::Remote);
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
