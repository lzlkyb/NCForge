//! 代码智能命令：启停 jdt.ls，并把前端的 LSP 请求/通知透传过去。
//!
//! 这里不做 LSP 与 Monaco 的语义转换（前端做），只管三件事：
//! 1. 拉起：影子工程生成 → 启动 jdt.ls → 握手；
//! 2. 路径：真实文件路径与影子工程 URI 互转（见 `lang.rs`），前端永远只看到真实路径；
//! 3. 事件：`lang-status`（状态）、`lang-notify`（诊断等通知，URI 已换回真实路径）。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{Emitter, Manager};

use super::compile_cmds::{cached_index, resolve_module};
use crate::lang::{LangSession, LangStatus};
use crate::lsp::{
    build_initialize_params, build_settings, path_to_uri, JdtlsLaunch, LspClient, LspHandler,
};
use crate::nc_home::{self, NcHome};
use crate::shadow::{self, ShadowSpec};
use crate::state::AppState;

/// jdt.ls 默认堆上限（MB）。实测 gl 模块实际用 656MB。
const DEFAULT_XMX_MB: u32 = 1024;

fn lock_lang(state: &AppState) -> std::sync::MutexGuard<'_, crate::lang::LangRun> {
    state.lang.lock().unwrap_or_else(|e| e.into_inner())
}

/// 更新状态并通知前端。
fn set_status(app: &tauri::AppHandle, state: &AppState, status: LangStatus) {
    lock_lang(state).status = status.clone();
    let _ = app.emit("lang-status", status);
}

/// jdt.ls 目录：安装包资源 → 源码树资源 → 配置目录 → 环境变量 `NCFORGE_JDTLS_DIR`。
fn find_jdtls(app: &tauri::AppHandle, config_dir: &Path) -> Result<PathBuf, String> {
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Ok(env_dir) = std::env::var("NCFORGE_JDTLS_DIR") {
        cands.push(PathBuf::from(env_dir));
    }
    if let Ok(dir) = app.path().resource_dir() {
        cands.push(dir.join("jdtls"));
    }
    cands.push(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("jdtls"),
    );
    cands.push(config_dir.join("jdtls"));
    cands
        .into_iter()
        .find(|p| p.join("plugins").is_dir())
        .ok_or_else(|| {
            "找不到内置的 jdt.ls（需要 resources/jdtls，或设置环境变量 NCFORGE_JDTLS_DIR）"
                .to_string()
        })
}

/// 处理 jdt.ls 主动发来的通知：记录状态、把诊断转给前端。
struct Handler {
    app: tauri::AppHandle,
    state: Arc<AppState>,
    module: String,
    real_prefix: String,
    shadow_prefix: String,
}

impl LspHandler for Handler {
    fn on_notification(&self, method: &str, params: Value) {
        match method {
            "language/status" => {
                let kind = params["type"].as_str().unwrap_or_default();
                let message = params["message"].as_str().unwrap_or_default().to_string();
                let mut cur = lock_lang(&self.state).status.clone();
                // 只改本模块的状态：旧会话收尾时的通知不能覆盖新会话
                if cur.module.as_deref() != Some(&self.module)
                    || !matches!(cur.state.as_str(), "indexing" | "ready")
                {
                    return;
                }
                if kind == "ServiceReady" {
                    cur.state = "ready".into();
                }
                if !message.is_empty() {
                    cur.message = message;
                }
                set_status(&self.app, &self.state, cur);
            }
            "textDocument/publishDiagnostics" => {
                let mapped =
                    crate::lang::swap_prefix(&params, &self.shadow_prefix, &self.real_prefix);
                let _ = self
                    .app
                    .emit("lang-notify", json!({ "method": method, "params": mapped }));
            }
            _ => {}
        }
    }
}

fn start_blocking(
    app: tauri::AppHandle,
    state: Arc<AppState>,
    root: PathBuf,
    module: String,
    home: NcHome,
) -> Result<LangStatus, String> {
    // 同模块已在跑（或正在拉起）就不重复拉起
    let old = {
        let mut run = lock_lang(&state);
        let same = run.status.module.as_deref() == Some(&module)
            && matches!(run.status.state.as_str(), "starting" | "indexing" | "ready");
        if same {
            return Ok(run.status.clone());
        }
        run.status = LangStatus {
            state: "starting".into(),
            module: Some(module.clone()),
            message: "正在准备…".into(),
            ..LangStatus::stopped()
        };
        run.session.take()
    };
    let _ = app.emit("lang-status", lock_lang(&state).status.clone());
    // 切模块 = 重启（已验证的做法；在原进程里换 classpath 未验证）
    if let Some(s) = old {
        s.client.shutdown();
    }
    match launch(&app, &state, &root, &module, &home) {
        Ok(st) => Ok(st),
        Err(e) => {
            set_status(
                &app,
                &state,
                LangStatus {
                    state: "error".into(),
                    module: Some(module),
                    message: e.clone(),
                    ..LangStatus::stopped()
                },
            );
            Err(e)
        }
    }
}

fn launch(
    app: &tauri::AppHandle,
    state: &Arc<AppState>,
    root: &Path,
    module: &str,
    home: &NcHome,
) -> Result<LangStatus, String> {
    let nc_home = PathBuf::from(&home.root);
    let java = PathBuf::from(&home.java);
    // java = <home>/ufjdk/bin/java.exe，运行时根 = 它的上上级
    let runtime = java
        .parent()
        .and_then(Path::parent)
        .ok_or("无法确定 NC 自带 JDK 的根目录")?
        .to_path_buf();
    let ls_dir = find_jdtls(app, &state.config_dir)?;
    let (index, seed) = cached_index(
        &nc_home,
        &state.config_dir.join("class-index.bin"),
        module,
        &|s| {
            let _ = app.emit(
                "lang-status",
                LangStatus {
                    state: "starting".into(),
                    module: Some(module.to_string()),
                    message: s.to_string(),
                    ..LangStatus::stopped()
                },
            );
        },
    )?;

    let base = state.config_dir.join("lang");
    let shadow_dir = base.join("shadow");
    let data_dir = base.join("jdtls-data");
    // 上次用的是另一个模块时清掉 jdt.ls 的工作区缓存，避免旧索引混进来。
    // data_dir 在影子目录之外、里面没有 junction，递归删除是安全的。
    let last_file = base.join("last-module.txt");
    if std::fs::read_to_string(&last_file).ok().as_deref() != Some(module) {
        let _ = std::fs::remove_dir_all(&data_dir);
    }
    std::fs::create_dir_all(&base).map_err(|e| format!("无法创建代码智能目录: {e}"))?;
    let _ = std::fs::write(&last_file, module);

    let project = shadow::generate(&ShadowSpec {
        workspace_root: root,
        module,
        nc_home: &nc_home,
        shadow_dir: &shadow_dir,
        index: &index,
        extra_jars: &seed,
    })?;

    let real_dir = root.join(module);
    let shadow_module = shadow_dir.join(module);
    let handler = Handler {
        app: app.clone(),
        state: state.clone(),
        module: module.to_string(),
        real_prefix: path_to_uri(&real_dir.to_string_lossy()),
        shadow_prefix: path_to_uri(&shadow_module.to_string_lossy()),
    };
    let cmd = JdtlsLaunch {
        java_exe: &java,
        ls_dir: &ls_dir,
        data_dir: &data_dir,
        xmx_mb: DEFAULT_XMX_MB,
    }
    .command()?;
    let client = LspClient::spawn(cmd, Arc::new(handler))?;
    let runtime_s = runtime.to_string_lossy().into_owned();
    let root_s = shadow_dir.to_string_lossy().into_owned();
    client.request(
        "initialize",
        build_initialize_params(&root_s, &runtime_s, std::process::id()),
        Duration::from_secs(120),
    )?;
    client.notify("initialized", json!({}))?;
    client.notify(
        "workspace/didChangeConfiguration",
        json!({ "settings": build_settings(&runtime_s) }),
    )?;

    let status = LangStatus {
        state: "indexing".into(),
        module: Some(module.to_string()),
        message: "正在建立索引…".into(),
        source_files: project.source_files,
        jar_count: project.jar_count,
    };
    lock_lang(state).session = Some(Arc::new(LangSession::new(
        client,
        module,
        &real_dir,
        &shadow_module,
    )));
    set_status(app, state, status.clone());
    Ok(status)
}

/// 为 `path` 所在的模块启动代码智能。拉起与握手约 3~5 秒后返回（`indexing`），
/// 真正就绪要等 `lang-status` 事件变成 `ready`（真实 gl 模块首次约 40 秒）。
#[tauri::command]
pub async fn lang_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
) -> Result<LangStatus, String> {
    let (root, module) = resolve_module(&state, &path).await?;
    let home = nc_home::resolve(state.config.read().await.nc_home.as_deref())?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || start_blocking(app, state, root, module, home))
        .await
        .map_err(|e| format!("后台任务失败: {e}"))?
}

#[tauri::command]
pub async fn lang_stop(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let old = lock_lang(&state).session.take();
        if let Some(s) = old {
            s.client.shutdown();
        }
        set_status(&app, &state, LangStatus::stopped());
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))
}

#[tauri::command]
pub fn lang_status(state: tauri::State<'_, Arc<AppState>>) -> LangStatus {
    lock_lang(&state).status.clone()
}

/// 取当前会话，并把 `path`（真实文件路径）换成 `textDocument.uri` 填进参数。
fn prepare(
    state: &AppState,
    path: Option<&str>,
    params: &Value,
) -> Result<(Arc<LangSession>, Value), String> {
    let session = lock_lang(state)
        .session
        .clone()
        .ok_or_else(|| "代码智能未运行".to_string())?;
    let mut p = session.to_server(params);
    if let Some(path) = path {
        let uri = session.shadow_uri_of(path)?;
        p["textDocument"]["uri"] = Value::String(uri);
    }
    Ok((session, p))
}

/// 透传一个 LSP 请求。`path` 给出时按它填 `textDocument.uri`；结果里的影子 URI 会换回真实路径。
#[tauri::command]
pub async fn lang_request(
    state: tauri::State<'_, Arc<AppState>>,
    method: String,
    path: Option<String>,
    params: Value,
    timeout_ms: Option<u64>,
) -> Result<Value, String> {
    let (session, p) = prepare(&state, path.as_deref(), &params)?;
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(30_000));
    tauri::async_runtime::spawn_blocking(move || {
        let out = session.client.request(&method, p, timeout)?;
        Ok(session.from_server(&out))
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 透传一个 LSP 通知（didOpen / didChange / didClose 等）。
#[tauri::command]
pub fn lang_notify(
    state: tauri::State<'_, Arc<AppState>>,
    method: String,
    path: Option<String>,
    params: Value,
) -> Result<(), String> {
    let (session, p) = prepare(&state, path.as_deref(), &params)?;
    session.client.notify(&method, p)
}
