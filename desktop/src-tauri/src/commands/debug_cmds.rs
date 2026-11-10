//! 调试命令层：建立 DAP 会话（经 jdt.ls 里的 java-debug）、断点、步进、栈与变量。
//!
//! 链路与分工见 `debug.rs` 头注释。这里只做四件事：
//! 1. 向 jdt.ls 要一个调试适配器端口（`vscode.java.startDebugSession`），再 attach 到目标 JVM；
//! 2. 真实文件路径 → 影子工程路径（断点要落在 jdt.ls 认识的工程里）；
//! 3. 适配器事件里影子路径 → 真实路径后再发给前端（插件与事件同一条映射规则）；
//! 4. 会话的生命周期与状态（`debug-status` / `debug-event`，都带 `target`）。
//!
//! **所有 DAP 请求都进 `spawn_blocking`**：读回复是带超时的阻塞等待，放 async 线程会
//! 在适配器卡住时钉死一条 tokio 工作线程（与 `lang_request` 同一条纪律）。
//!
//! 目标（`server` / `client`）是命令的必填参数：两个 JVM 各一条会话，
//! 中间件和客户端可以同时附加，互不干扰。

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::Emitter;

use crate::debug::{self, DebugRun, DebugSession, DebugStatus, DebugTarget};
use crate::lang::LangSession;
use crate::lsp::uri_to_path;
use crate::shadow;
use crate::state::AppState;

fn lock_debug(state: &AppState) -> std::sync::MutexGuard<'_, DebugRun> {
    state.debug.lock().unwrap_or_else(|e| e.into_inner())
}

fn current(state: &AppState, target: DebugTarget) -> Result<Arc<DebugSession>, String> {
    lock_debug(state)
        .slot_ref(target)
        .session
        .clone()
        .ok_or_else(|| {
            format!(
                "{}调试会话未启动：先在服务页用「调试模式」启动{}，再附加调试器",
                target.label(),
                target.label()
            )
        })
}

fn emit_status(app: &tauri::AppHandle, state: &AppState, target: DebugTarget) {
    let status = lock_debug(state).slot_ref(target).status.clone();
    let _ = app.emit("debug-status", status);
}

/// 目标 JVM 的 JDWP 端口。两个本地进程的启动参数都由工作台生成，端口从这里取。
/// 远程目标不归工作台启动，端口由用户填写（见 `debug_start`）。
fn jdwp_port_for(state: &AppState, target: DebugTarget) -> Result<u16, String> {
    match target {
        DebugTarget::Server => {
            let mut run = state
                .server
                .lock()
                .map_err(|_| "服务状态异常".to_string())?;
            if !run.is_alive() {
                return Err("中间件没在运行：请先在服务页用「调试模式」启动".to_string());
            }
            run.debug_port
                .ok_or_else(|| "这次启动没开调试：先停止服务，勾选「调试模式」再启动".to_string())
        }
        DebugTarget::Client => {
            let mut run = state
                .client
                .lock()
                .map_err(|_| "客户端状态异常".to_string())?;
            if !run.is_alive() {
                return Err("客户端没在运行：请先在服务页的客户端卡用「调试模式」启动".to_string());
            }
            run.debug_port.ok_or_else(|| {
                "这次客户端启动没开调试：先停止客户端，勾选「调试模式」再启动".to_string()
            })
        }
        DebugTarget::Remote => Err("远程目标没有本地进程端口，请手工填写".to_string()),
    }
}

/// 适配器事件处理器：路径映射与状态收尾都在这。
struct Handler {
    app: tauri::AppHandle,
    state: Arc<AppState>,
    target: DebugTarget,
    /// 连接代数（见 `TargetRun::generation`）。
    generation: u64,
    lang: Arc<LangSession>,
}

impl Handler {
    /// 会话结束（目标退出 / 适配器断开 / 主动停止的收尾）：只有当前这一代才动状态。
    fn finish(&self, message: &str) {
        let cleared = {
            let mut run = lock_debug(&self.state);
            let slot = run.slot(self.target);
            if slot.generation == self.generation && slot.session.is_some() {
                slot.session = None;
                slot.status = DebugStatus::stopped(self.target);
                slot.status.message = message.to_string();
                true
            } else {
                false
            }
        };
        if cleared {
            emit_status(&self.app, &self.state, self.target);
        }
    }
}

impl debug::DapHandler for Handler {
    fn on_event(&self, event: &str, body: Value) {
        // 目标退出后适配器连接仍在，主动收尾，别让界面停在「已暂停」
        if event == "terminated" {
            self.finish("调试目标已结束");
        }
        // breakpoint 等事件里的 source.path 也是普通路径，要和请求回包走同一条映射
        let body = self.lang.from_server_paths(&self.lang.from_server(&body));
        let _ = self.app.emit(
            "debug-event",
            json!({ "target": self.target, "event": event, "body": body }),
        );
    }

    fn on_exit(&self, reason: &str) {
        self.finish(reason);
    }
}

/// `workspace/executeCommand` 的结果可能是数字，也可能被序列化成字符串。
fn parse_port(v: &Value) -> Result<u16, String> {
    let port = v
        .as_u64()
        .and_then(|n| u16::try_from(n).ok())
        .or_else(|| v.as_str().and_then(|s| s.trim().parse::<u16>().ok()));
    port.filter(|p| *p > 0)
        .ok_or_else(|| format!("调试适配器没有返回可用端口（收到 {v}）"))
}

/// 建立调试会话。要求目标 JVM 以调试模式在跑（有 JDWP 端口）+ 代码智能已就绪。
///
/// `remote` 目标由用户填 `host` / `port`：远端 JVM 不归工作台启动，没法从进程状态取端口。
/// 本地目标的 `host` / `port` 参数被忽略，避免 UI 误传地址连到别的 JVM。
#[tauri::command]
pub async fn debug_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    target: String,
    host: Option<String>,
    port: Option<u16>,
) -> Result<DebugStatus, String> {
    let target = DebugTarget::parse(&target)?;
    let st = state.inner().clone();
    let (jdwp_host, jdwp_port) = match target {
        DebugTarget::Remote => debug::remote_endpoint(host.as_deref(), port)?,
        _ => ("127.0.0.1".to_string(), jdwp_port_for(&st, target)?),
    };
    let lang = {
        let run = st.lang.lock().map_err(|_| "代码智能状态异常".to_string())?;
        run.session
            .clone()
            .ok_or_else(|| "代码智能未运行：调试需要它解析类与源码的对应关系".to_string())?
    };

    tauri::async_runtime::spawn_blocking(move || -> Result<DebugStatus, String> {
        // 同一目标已有会话先收掉：同一时刻只保留一条，避免旧适配器会话在 jdt.ls 里堆积
        let (old, generation) = {
            let mut run = lock_debug(&st);
            let old = debug::take_session(&mut run, target);
            (old, run.slot_ref(target).generation)
        };
        if let Some(s) = old {
            s.client.close();
        }

        let dap_port = parse_port(&lang.client.request(
            "workspace/executeCommand",
            json!({ "command": "vscode.java.startDebugSession", "arguments": [] }),
            Duration::from_secs(30),
        )?)?;

        let handler = Arc::new(Handler {
            app: app.clone(),
            state: st.clone(),
            target,
            generation,
            lang: lang.clone(),
        });
        let client = debug::DapClient::connect(dap_port, handler, Duration::from_secs(10))?;

        // 先握手再 attach：attach 失败时要把错误原样带出来（最常见的是 JDWP 端口没开）
        let init = client.request(
            "initialize",
            debug::initialize_args(),
            Duration::from_secs(30),
        );
        let init_body = match init {
            Ok(body) => body,
            Err(e) => {
                client.kill();
                return Err(e);
            }
        };
        // 异常断点过滤器是适配器能力（java-debug 当前是 caught / uncaught），随状态下发给 UI
        let exception_filters = debug::parse_exception_filters(&init_body);
        let source_paths = vec![lang.shadow_root().to_string_lossy().into_owned()];
        if let Err(e) = client.request(
            "attach",
            debug::attach_args(&jdwp_host, jdwp_port, shadow::PROJECT_NAME, &source_paths),
            Duration::from_secs(40),
        ) {
            client.kill();
            // 远程失败最常见的原因是隧道没建/远端没开调试，把检查顺序直接写进报错
            return Err(if target == DebugTarget::Remote {
                format!(
                    "连不上远程 JDWP {jdwp_host}:{jdwp_port}：{e}\n请确认远端 JVM 已开调试、SSH 隧道已建立，且远端 JDWP 只绑 127.0.0.1"
                )
            } else {
                e
            });
        }

        // 不发 configurationDone，java-debug 就不开始消费 JDI 事件：断点已经把线程挂起了，
        // 界面却始终收不到 stopped（2026-11-10 用真实 HTTP 业务线程复现：jstack 里线程 at breakpoint，
        // 页面级监听 0 个 debug-event；手动「暂停」由请求处理器直接回 stopped，所以没受影响）。
        // 断点由前端在 attach 之后动态下发，java-debug 支持在 configurationDone 之后再设置。
        if let Err(e) = client.request("configurationDone", json!({}), Duration::from_secs(15)) {
            client.kill();
            return Err(format!("调试适配器没有完成配置：{e}"));
        }

        let status = DebugStatus {
            target,
            state: "attached".into(),
            module: Some(lang.module().to_string()),
            dap_port: Some(dap_port),
            jdwp_port: Some(jdwp_port),
            jdwp_host: Some(jdwp_host),
            message: String::new(),
            exception_filters,
        };
        // 准备期间用户点了停止（或又发起一次）：这一代已作废，别把会话塞回去
        {
            let mut run = lock_debug(&st);
            let slot = run.slot(target);
            if slot.generation != generation {
                drop(run);
                client.kill();
                return Err("调试已取消：建立会话期间收到停止/重连请求".to_string());
            }
            slot.session = Some(Arc::new(DebugSession {
                client,
                module: lang.module().to_string(),
                jdwp_port,
                dap_port,
                lang: lang.clone(),
            }));
            slot.status = status.clone();
        }
        emit_status(&app, &st, target);
        Ok(status)
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

#[tauri::command]
pub fn debug_status(
    state: tauri::State<'_, Arc<AppState>>,
    target: String,
) -> Result<DebugStatus, String> {
    let target = DebugTarget::parse(&target)?;
    Ok(lock_debug(&state).slot_ref(target).status.clone())
}

/// 断开某个目标的调试会话。不动被调试的进程。
#[tauri::command]
pub async fn debug_stop(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    target: String,
) -> Result<(), String> {
    let target = DebugTarget::parse(&target)?;
    let st = state.inner().clone();
    let session = {
        let mut run = lock_debug(&st);
        debug::take_session(&mut run, target)
    };
    emit_status(&app, &st, target);
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(s) = session {
            s.client.close();
        }
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?;
    Ok(())
}

/// 发一条 DAP 请求并等回复；结果里的影子路径换回真实路径。
async fn ask(
    state: Arc<AppState>,
    target: DebugTarget,
    command: &'static str,
    args: Value,
    timeout: Duration,
) -> Result<Value, String> {
    let session = current(&state, target)?;
    tauri::async_runtime::spawn_blocking(move || {
        let out = session.client.request(command, args, timeout)?;
        Ok(session
            .lang
            .from_server_paths(&session.lang.from_server(&out)))
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 设置某文件断点。空数组 = 清空该文件的所有断点。
///
/// 每条断点可带 `condition` / `hitCondition` / `logMessage`（触发语义），
/// 是否启用由前端决定：禁用的断点不会出现在这里，整文件都禁用时发空数组即可。
#[tauri::command]
pub async fn debug_set_breakpoints(
    state: tauri::State<'_, Arc<AppState>>,
    target: String,
    path: String,
    breakpoints: Vec<debug::BreakpointSpec>,
) -> Result<Value, String> {
    let target = DebugTarget::parse(&target)?;
    let session = current(&state, target)?;
    let shadow_path = uri_to_path(&session.lang.shadow_uri_of(&path)?)
        .ok_or_else(|| format!("无法转换断点路径：{path}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        let out = session.client.request(
            "setBreakpoints",
            debug::set_breakpoints_args(&shadow_path, &breakpoints),
            Duration::from_secs(15),
        )?;
        Ok(session
            .lang
            .from_server_paths(&session.lang.from_server(&out)))
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 异常断点：`filters` 是适配器给出的过滤器 id（caught / uncaught）。空数组 = 全部关闭。
#[tauri::command]
pub async fn debug_set_exception_breakpoints(
    state: tauri::State<'_, Arc<AppState>>,
    target: String,
    filters: Vec<String>,
) -> Result<Value, String> {
    ask(
        state.inner().clone(),
        DebugTarget::parse(&target)?,
        "setExceptionBreakpoints",
        debug::exception_breakpoints_args(&filters),
        Duration::from_secs(15),
    )
    .await
}

/// 继续运行到下一个断点。
#[tauri::command]
pub async fn debug_continue(
    state: tauri::State<'_, Arc<AppState>>,
    target: String,
    thread_id: i64,
) -> Result<Value, String> {
    ask(
        state.inner().clone(),
        DebugTarget::parse(&target)?,
        "continue",
        json!({ "threadId": thread_id }),
        Duration::from_secs(15),
    )
    .await
}

/// 步进：`over` / `into` / `out`。
#[tauri::command]
pub async fn debug_step(
    state: tauri::State<'_, Arc<AppState>>,
    target: String,
    thread_id: i64,
    kind: String,
) -> Result<Value, String> {
    let command = match kind.as_str() {
        "over" => "next",
        "into" => "stepIn",
        "out" => "stepOut",
        other => return Err(format!("未知的步进方式：{other}")),
    };
    ask(
        state.inner().clone(),
        DebugTarget::parse(&target)?,
        command,
        json!({ "threadId": thread_id }),
        Duration::from_secs(15),
    )
    .await
}

#[tauri::command]
pub async fn debug_pause(
    state: tauri::State<'_, Arc<AppState>>,
    target: String,
    thread_id: i64,
) -> Result<Value, String> {
    ask(
        state.inner().clone(),
        DebugTarget::parse(&target)?,
        "pause",
        json!({ "threadId": thread_id }),
        Duration::from_secs(15),
    )
    .await
}

/// 当前 JVM 的线程列表（暂停按钮要知道往哪个线程发 suspend）。
#[tauri::command]
pub async fn debug_threads(
    state: tauri::State<'_, Arc<AppState>>,
    target: String,
) -> Result<Value, String> {
    ask(
        state.inner().clone(),
        DebugTarget::parse(&target)?,
        "threads",
        json!({}),
        Duration::from_secs(10),
    )
    .await
}

#[tauri::command]
pub async fn debug_stack_trace(
    state: tauri::State<'_, Arc<AppState>>,
    target: String,
    thread_id: i64,
) -> Result<Value, String> {
    ask(
        state.inner().clone(),
        DebugTarget::parse(&target)?,
        "stackTrace",
        json!({ "threadId": thread_id, "startFrame": 0, "levels": 20 }),
        Duration::from_secs(15),
    )
    .await
}

#[tauri::command]
pub async fn debug_scopes(
    state: tauri::State<'_, Arc<AppState>>,
    target: String,
    frame_id: i64,
) -> Result<Value, String> {
    ask(
        state.inner().clone(),
        DebugTarget::parse(&target)?,
        "scopes",
        json!({ "frameId": frame_id }),
        Duration::from_secs(15),
    )
    .await
}

#[tauri::command]
pub async fn debug_variables(
    state: tauri::State<'_, Arc<AppState>>,
    target: String,
    variables_reference: i64,
    start: Option<i64>,
    count: Option<i64>,
) -> Result<Value, String> {
    ask(
        state.inner().clone(),
        DebugTarget::parse(&target)?,
        "variables",
        debug::variables_args(variables_reference, start, count),
        Duration::from_secs(20),
    )
    .await
}

/// 暂停时改写一个变量的值（DAP `setVariable`）。
#[tauri::command]
pub async fn debug_set_variable(
    state: tauri::State<'_, Arc<AppState>>,
    target: String,
    variables_reference: i64,
    name: String,
    value: String,
) -> Result<Value, String> {
    ask(
        state.inner().clone(),
        DebugTarget::parse(&target)?,
        "setVariable",
        debug::set_variable_args(variables_reference, &name, &value),
        Duration::from_secs(15),
    )
    .await
}

/// 异常停靠的详情（类型、消息、栈）。仅在 stopped 原因是 exception 时有意义。
#[tauri::command]
pub async fn debug_exception_info(
    state: tauri::State<'_, Arc<AppState>>,
    target: String,
    thread_id: i64,
) -> Result<Value, String> {
    ask(
        state.inner().clone(),
        DebugTarget::parse(&target)?,
        "exceptionInfo",
        debug::exception_info_args(thread_id),
        Duration::from_secs(10),
    )
    .await
}

/// 求值（选中表达式 / 悬停查看）。`frame_id` 为 0 时按全局上下文求值。
/// `context` 让适配器区分 repl / watch / hover（java-debug 主要影响类加载器选择）。
#[tauri::command]
pub async fn debug_evaluate(
    state: tauri::State<'_, Arc<AppState>>,
    target: String,
    expression: String,
    frame_id: Option<i64>,
    context: Option<String>,
) -> Result<Value, String> {
    let context = match context.as_deref() {
        Some("watch") => "watch",
        Some("hover") => "hover",
        _ => "repl",
    };
    let mut args = json!({ "expression": expression, "context": context });
    if let Some(f) = frame_id.filter(|f| *f > 0) {
        args["frameId"] = json!(f);
    }
    ask(
        state.inner().clone(),
        DebugTarget::parse(&target)?,
        "evaluate",
        args,
        Duration::from_secs(15),
    )
    .await
}
