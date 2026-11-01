//! 调试命令层：建立 DAP 会话（经 jdt.ls 里的 java-debug）、断点、步进、栈与变量。
//!
//! 链路与分工见 `debug.rs` 头注释。这里只做四件事：
//! 1. 向 jdt.ls 要一个调试适配器端口（`vscode.java.startDebugSession`），再 attch 到中间件的 JDWP；
//! 2. 真实文件路径 → 影子工程路径（断点要落在 jdt.ls 认识的工程里）；
//! 3. 适配器事件里影子路径 → 真实路径后再发给前端（插件与事件同一条映射规则）；
//! 4. 会话的生命周期与状态（`debug-status` / `debug-event`）。
//!
//! **所有 DAP 请求都进 `spawn_blocking`**：读回复是带超时的阻塞等待，放 async 线程会
//! 在适配器卡住时钉死一条 tokio 工作线程（与 `lang_request` 同一条纪律）。

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::Emitter;

use crate::debug::{self, DebugRun, DebugSession, DebugStatus};
use crate::lang::LangSession;
use crate::lsp::uri_to_path;
use crate::shadow;
use crate::state::AppState;

fn lock_debug(state: &AppState) -> std::sync::MutexGuard<'_, DebugRun> {
    state.debug.lock().unwrap_or_else(|e| e.into_inner())
}

fn current(state: &AppState) -> Result<Arc<DebugSession>, String> {
    lock_debug(state)
        .session
        .clone()
        .ok_or_else(|| "调试会话未启动：先用「调试模式」启动服务，再附加调试器".to_string())
}

fn emit_status(app: &tauri::AppHandle, state: &AppState) {
    let status = lock_debug(state).status.clone();
    let _ = app.emit("debug-status", status);
}

/// 适配器事件处理器：路径映射与状态收尾都在这。
struct Handler {
    app: tauri::AppHandle,
    state: Arc<AppState>,
    /// 连接代数（见 `DebugRun::generation`）。
    generation: u64,
    lang: Arc<LangSession>,
}

impl Handler {
    /// 会话结束（目标退出 / 适配器断开 / 主动停止的收尾）：只有当前这一代才动状态。
    fn finish(&self, message: &str) {
        let cleared = {
            let mut run = lock_debug(&self.state);
            if run.generation == self.generation && run.session.is_some() {
                run.session = None;
                run.status = DebugStatus::stopped();
                run.status.message = message.to_string();
                true
            } else {
                false
            }
        };
        if cleared {
            emit_status(&self.app, &self.state);
        }
    }
}

impl debug::DapHandler for Handler {
    fn on_event(&self, event: &str, body: Value) {
        // 目标退出后适配器连接仍在，主动收尾，别让界面停在「已暂停」
        if event == "terminated" {
            self.finish("调试目标已结束");
        }
        let body = self.lang.from_server(&body);
        let _ = self
            .app
            .emit("debug-event", json!({ "event": event, "body": body }));
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

/// 建立调试会话。要求：服务以调试模式在跑（有 JDWP 端口）+ 代码智能已就绪。
#[tauri::command]
pub async fn debug_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<DebugStatus, String> {
    let st = state.inner().clone();
    let jdwp_port = {
        let mut run = st.server.lock().map_err(|_| "服务状态异常".to_string())?;
        if !run.is_alive() {
            return Err("服务没在运行：请先在服务页用「调试模式」启动".to_string());
        }
        run.debug_port
            .ok_or_else(|| "这次启动没开调试：先停止服务，勾选「调试模式」再启动".to_string())?
    };
    let lang = {
        let run = st.lang.lock().map_err(|_| "代码智能状态异常".to_string())?;
        run.session
            .clone()
            .ok_or_else(|| "代码智能未运行：调试需要它解析类与源码的对应关系".to_string())?
    };

    tauri::async_runtime::spawn_blocking(move || -> Result<DebugStatus, String> {
        // 已有会话先收掉：同一时刻只保留一条，避免旧适配器会话在 jdt.ls 里堆积
        let (old, generation) = {
            let mut run = lock_debug(&st);
            let old = debug::take_session(&mut run);
            (old, run.generation)
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
        if let Err(e) = init {
            client.kill();
            return Err(e);
        }
        let source_paths = vec![lang.shadow_root().to_string_lossy().into_owned()];
        if let Err(e) = client.request(
            "attach",
            debug::attach_args(jdwp_port, shadow::PROJECT_NAME, &source_paths),
            Duration::from_secs(40),
        ) {
            client.kill();
            return Err(e);
        }

        let status = DebugStatus {
            state: "attached".into(),
            module: Some(lang.module().to_string()),
            dap_port: Some(dap_port),
            jdwp_port: Some(jdwp_port),
            message: String::new(),
        };
        // 准备期间用户点了停止（或又发起一次）：这一代已作废，别把会话塞回去
        {
            let mut run = lock_debug(&st);
            if run.generation != generation {
                drop(run);
                client.kill();
                return Err("调试已取消：建立会话期间收到停止/重连请求".to_string());
            }
            run.session = Some(Arc::new(DebugSession {
                client,
                module: lang.module().to_string(),
                jdwp_port,
                dap_port,
                lang: lang.clone(),
            }));
            run.status = status.clone();
        }
        emit_status(&app, &st);
        Ok(status)
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

#[tauri::command]
pub fn debug_status(state: tauri::State<'_, Arc<AppState>>) -> DebugStatus {
    lock_debug(&state).status.clone()
}

/// 断开调试会话。不动服务本身。
#[tauri::command]
pub async fn debug_stop(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let st = state.inner().clone();
    let session = {
        let mut run = lock_debug(&st);
        debug::take_session(&mut run)
    };
    emit_status(&app, &st);
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
    command: &'static str,
    args: Value,
    timeout: Duration,
) -> Result<Value, String> {
    let session = current(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let out = session.client.request(command, args, timeout)?;
        Ok(session.lang.from_server(&out))
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 设置某文件断点。`lines` 为空 = 清空该文件的所有断点。
#[tauri::command]
pub async fn debug_set_breakpoints(
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
    lines: Vec<u32>,
) -> Result<Value, String> {
    let session = current(&state)?;
    let shadow_path = uri_to_path(&session.lang.shadow_uri_of(&path)?)
        .ok_or_else(|| format!("无法转换断点路径：{path}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        let out = session.client.request(
            "setBreakpoints",
            debug::set_breakpoints_args(&shadow_path, &lines),
            Duration::from_secs(15),
        )?;
        Ok(session.lang.from_server(&out))
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 继续运行到下一个断点。
#[tauri::command]
pub async fn debug_continue(
    state: tauri::State<'_, Arc<AppState>>,
    thread_id: i64,
) -> Result<Value, String> {
    ask(
        state.inner().clone(),
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
        command,
        json!({ "threadId": thread_id }),
        Duration::from_secs(15),
    )
    .await
}

#[tauri::command]
pub async fn debug_pause(
    state: tauri::State<'_, Arc<AppState>>,
    thread_id: i64,
) -> Result<Value, String> {
    ask(
        state.inner().clone(),
        "pause",
        json!({ "threadId": thread_id }),
        Duration::from_secs(15),
    )
    .await
}

/// 当前 JVM 的线程列表（暂停按钮要知道往哪个线程发 suspend）。
#[tauri::command]
pub async fn debug_threads(state: tauri::State<'_, Arc<AppState>>) -> Result<Value, String> {
    ask(
        state.inner().clone(),
        "threads",
        json!({}),
        Duration::from_secs(10),
    )
    .await
}

#[tauri::command]
pub async fn debug_stack_trace(
    state: tauri::State<'_, Arc<AppState>>,
    thread_id: i64,
) -> Result<Value, String> {
    ask(
        state.inner().clone(),
        "stackTrace",
        json!({ "threadId": thread_id, "startFrame": 0, "levels": 20 }),
        Duration::from_secs(15),
    )
    .await
}

#[tauri::command]
pub async fn debug_scopes(
    state: tauri::State<'_, Arc<AppState>>,
    frame_id: i64,
) -> Result<Value, String> {
    ask(
        state.inner().clone(),
        "scopes",
        json!({ "frameId": frame_id }),
        Duration::from_secs(15),
    )
    .await
}

#[tauri::command]
pub async fn debug_variables(
    state: tauri::State<'_, Arc<AppState>>,
    variables_reference: i64,
) -> Result<Value, String> {
    ask(
        state.inner().clone(),
        "variables",
        json!({ "variablesReference": variables_reference }),
        Duration::from_secs(15),
    )
    .await
}

/// 求值（选中表达式 / 悬停查看）。`frame_id` 为 0 时按全局上下文求值。
#[tauri::command]
pub async fn debug_evaluate(
    state: tauri::State<'_, Arc<AppState>>,
    expression: String,
    frame_id: Option<i64>,
) -> Result<Value, String> {
    let mut args = json!({ "expression": expression, "context": "repl" });
    if let Some(f) = frame_id.filter(|f| *f > 0) {
        args["frameId"] = json!(f);
    }
    ask(
        state.inner().clone(),
        "evaluate",
        args,
        Duration::from_secs(15),
    )
    .await
}
