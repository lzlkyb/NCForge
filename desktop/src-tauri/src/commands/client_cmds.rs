//! NC 客户端（Swing `JStarter`）的命令层：状态、启动、停止、日志、命令行、堆上限。
//!
//! 客户端和中间件是两个独立进程，但生命周期操作完全同构，所以进程管理、日志读取、
//! pathing jar 都复用 `server.rs` 与 `launch.rs`，这里只负责「拿配置 → 调它们 → 包形状」。
//!
//! 与中间件的三个差异：
//! 1. **没有监听端口**。客户端是 Swing 界面，进程活着就是可用；`serverReachable` 只表示
//!    它连的中间件端口当前通不通（客户端可以先于服务启动，界面提示即可）。
//! 2. **classpath 规则不同**。Eclipse 的客户端 provider 只收「产品公共库 + 模块 public +
//!    模块 client + langlib」，不含 middleware/framework/ant（见 `launch::client_classpath`）。
//! 3. **连接地址来自 prop.xml**。`-Dnc.jstart.server/port` 必须跟着用户改过的端口走，
//!    不能写死 80（那正是旧注释里警告过的坑）。
//!
//! 三条约定与中间件相同：起停全在 `spawn_blocking`、日志按偏移增量读、不在持锁时做慢操作。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::Emitter;

use crate::config::AppConfig;
use crate::launch;
use crate::nc_home::{self, NcHome, ServerEndpoints};
use crate::server::{self, ServerProcess, ServerRun, StopOutcome};
use crate::state::AppState;

/// 一次增量读的上限（与中间件一致）。
const LOG_CHUNK: u64 = 256 * 1024;

/// 客户端状态快照（前端每秒轮询这一份）。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientStatus {
    /// `stopped` / `starting` / `running`。
    pub state: &'static str,
    pub pid: Option<u32>,
    pub started_at_ms: Option<u64>,
    pub run_id: Option<String>,
    pub launch_phase: Option<String>,
    pub launch_started_at_ms: Option<u64>,
    pub uptime_ms: Option<u64>,
    /// 客户端连接中间件用的地址（`-Dnc.jstart.server/port`）。
    pub host: String,
    pub port: u16,
    /// 中间件端口当前是否可连。客户端能起来但连不上服务时，界面要能指出原因。
    pub server_reachable: bool,
    pub log_path: String,
    pub log_size: u64,
    pub java: Option<String>,
    pub classpath_entries: usize,
    pub main_class: String,
    pub command_line: String,
    pub exit_code: Option<i32>,
    pub reason: Option<String>,
    pub project_root: Option<String>,
    pub nc_home: Option<String>,
    pub heap_mb: u32,
    pub default_heap_mb: u32,
    /// 本次启动开了 JDWP 时的回环端口（未开 = null）。
    pub debug_port: Option<u16>,
}

/// 客户端日志增量。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientLogChunk {
    pub text: String,
    pub offset: u64,
}

/// 客户端清空日志的结果。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientClearResult {
    /// 前端应把读取偏移设到这里。
    pub offset: u64,
    /// true = 旧日志已改名成 `.log.1`；false = 文件没动（客户端在跑）。
    pub rotated: bool,
}

/// 客户端启动命令行预览。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientPreview {
    pub command_line: String,
    pub classpath_jar: String,
    pub entry_count: usize,
    pub work_dir: String,
    pub java: String,
    pub endpoints: ServerEndpoints,
    pub heap_mb: u32,
    /// 复用上次启动写好的清单（true）还是这次新算的。
    pub reused: bool,
}

pub(super) fn log_path(config_dir: &Path) -> PathBuf {
    config_dir.join("logs").join("client.log")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 从运行态抄出来的一份不可变快照（锁外做端点探测与状态拼装）。
struct Snap {
    starting: bool,
    alive: bool,
    pid: Option<u32>,
    started_at_ms: Option<u64>,
    java: Option<String>,
    classpath_entries: usize,
    command_line: String,
    exit_code: Option<i32>,
    reason: Option<String>,
    debug_port: Option<u16>,
    run_id: Option<String>,
    launch_phase: Option<String>,
    launch_started_at_ms: Option<u64>,
    project_root: Option<String>,
    nc_home: Option<String>,
}

fn snapshot(run: &mut ServerRun) -> Snap {
    let alive = run.is_alive();
    Snap {
        starting: run.starting,
        alive,
        pid: run.proc.as_ref().map(|p| p.pid),
        started_at_ms: run.proc.as_ref().map(|p| p.started_at_ms),
        java: run.java.as_ref().map(|p| p.to_string_lossy().to_string()),
        classpath_entries: run.classpath_entries,
        command_line: run.command_line.clone(),
        exit_code: run.exit_code,
        reason: run.reason.clone(),
        debug_port: run.debug_port,
        run_id: run.run_id.clone(),
        launch_phase: run.launch_phase.clone(),
        launch_started_at_ms: run.launch_started_at_ms,
        project_root: run
            .project_root
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned()),
        nc_home: run
            .nc_home
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned()),
    }
}

fn build_status(cfg: &AppConfig, config_dir: &Path, s: Snap, ep: &ServerEndpoints) -> ClientStatus {
    let path = log_path(config_dir);
    let (host, port) = launch::client_endpoint_host_port(ep);
    let state = if s.alive {
        "running"
    } else if s.starting {
        "starting"
    } else {
        "stopped"
    };
    ClientStatus {
        state,
        pid: s.pid,
        started_at_ms: s.started_at_ms,
        run_id: s.run_id,
        launch_phase: if state == "starting" {
            s.launch_phase
        } else {
            None
        },
        launch_started_at_ms: s.launch_started_at_ms,
        uptime_ms: s.started_at_ms.map(|t| now_ms().saturating_sub(t)),
        host,
        port,
        server_reachable: server::port_reachable(port, ep.http_address.as_deref()),
        log_path: path.to_string_lossy().to_string(),
        log_size: path.metadata().map(|m| m.len()).unwrap_or(0),
        java: s.java,
        classpath_entries: s.classpath_entries,
        main_class: launch::CLIENT_MAIN_CLASS.to_string(),
        command_line: s.command_line,
        exit_code: s.exit_code,
        reason: s.reason,
        project_root: if s.alive || s.starting {
            s.project_root
        } else {
            cfg.workspace_root.clone()
        },
        nc_home: if s.alive || s.starting {
            s.nc_home
        } else {
            cfg.nc_home.clone()
        },
        heap_mb: launch::effective_client_heap_mb(cfg.client_heap_mb),
        default_heap_mb: launch::DEFAULT_CLIENT_HEAP_MB,
        debug_port: s.debug_port,
    }
}

fn endpoints_for(home: Option<&NcHome>) -> ServerEndpoints {
    match home {
        Some(h) => nc_home::read_endpoints(Path::new(&h.root)),
        None => ServerEndpoints::fallback(nc_home::SERVER_PROP.to_string()),
    }
}

/// 当前客户端状态（前端在服务面板可见时每秒轮询）。
#[tauri::command]
pub async fn client_status(state: tauri::State<'_, Arc<AppState>>) -> Result<ClientStatus, String> {
    let cfg = state.config.read().await.clone();
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let snap = {
            let mut run = st.client.lock().map_err(|_| "客户端状态异常".to_string())?;
            snapshot(&mut run)
        };
        // NC home 定位失败不该让整个面板打不开：用回环 + 默认端口，界面会标「未从配置读到」
        let configured_home = if snap.alive || snap.starting {
            snap.nc_home.as_deref().or(cfg.nc_home.as_deref())
        } else {
            cfg.nc_home.as_deref()
        };
        let home = nc_home::resolve(configured_home).ok();
        let ep = endpoints_for(home.as_ref());
        Ok(build_status(&cfg, &st.config_dir, snap, &ep))
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 启动客户端。`debug` 为 true 时给 JVM 加 JDWP（只绑 127.0.0.1，端口由系统分配）。
fn launch_phase(state: &AppState, log: &Path, phase: &str) -> Result<(), String> {
    {
        let mut run = state
            .client
            .lock()
            .map_err(|_| "客户端状态异常".to_string())?;
        if run.stop_requested {
            return Err("CANCELLED:客户端启动已取消".into());
        }
        run.launch_phase = Some(phase.to_string());
    }
    let _ = server::append_log(log, &format!("[nc-forge] 客户端{phase}\n"));
    Ok(())
}
#[tauri::command]
pub async fn client_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    debug: Option<bool>,
    request_id: Option<String>,
) -> Result<String, String> {
    let st = state.inner().clone();
    let hotswap_jar = super::server_cmds::find_hotswap_jar(&app);
    let run_id = {
        let mut run = st.client.lock().map_err(|_| "客户端状态异常".to_string())?;
        run.begin_start(request_id.as_deref())?
    };
    let cfg = state.config.read().await.clone();
    let config_dir = state.config_dir.clone();

    st.client
        .lock()
        .map_err(|_| "客户端状态异常".to_string())?
        .project_root = cfg.workspace_root.as_ref().map(PathBuf::from);

    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let log = log_path(&config_dir);
        let result = (|| -> Result<(), String> {
            rotate_log(&log)?;
            launch_phase(&st, &log, "检查环境")?;
            let home = nc_home::resolve(cfg.nc_home.as_deref())?;
            let nc_home = PathBuf::from(&home.root);
            st.client
                .lock()
                .map_err(|_| "客户端状态异常".to_string())?
                .nc_home = Some(nc_home.clone());
            let java = PathBuf::from(&home.java);
            let debug_port = if debug == Some(true) {
                Some(server::free_loopback_port()?)
            } else {
                None
            };

            let project_root = cfg
                .workspace_root
                .clone()
                .map(PathBuf::from)
                .unwrap_or_else(|| nc_home.clone());
            let heap_mb = launch::effective_client_heap_mb(cfg.client_heap_mb);
            let overrides = crate::eclipse_cp::active_overrides(&cfg.linked_overrides);

            // 热替换 agent：换新令牌、清旧就绪文件。与中间件各用各的会话文件。
            // 任何失败都只记日志、按不挂 agent 启动——它不能变成「客户端起不来」的新原因。
            let java_agent = super::server_cmds::hotswap_agent_arg(
                crate::hotswap::Target::Client,
                &config_dir,
                hotswap_jar.as_deref(),
                cfg.hotswap_enabled,
                true,
                &log,
            );

            launch_phase(&st, &log, "准备 classpath")?;
            let prepared = launch::client_spec(
                &nc_home,
                &java,
                &project_root,
                &config_dir.join("tmp"),
                launch::ClientTuning {
                    heap_mb,
                    debug_port,
                    java_agent: java_agent.as_deref(),
                },
                &overrides,
            );
            let (spec, entry_count) = match prepared {
                Ok(v) => v,
                Err(e) => {
                    return Err(e);
                }
            };

            launch_phase(&st, &log, "创建 JVM")?;
            // Keep the summary within the reserved preparation so it cannot enter a later run.
            let (host, port) = launch::client_endpoint(&nc_home);
            let debug_note = debug_port.map(|p| format!("，JDWP 监听 127.0.0.1:{p}")).unwrap_or_default();
            let _ = server::append_log(&log, &format!(
                "[nc-forge] classpath 条目 {entry_count} 个（清单见 {}），连接 {host}:{port}，堆上限 -Xmx{heap_mb}m{debug_note}\n",
                spec.classpath_jar.display()
            ));
            let mut run = st.client.lock().map_err(|_| "客户端状态异常".to_string())?;
            if run.stop_requested {
                run.debug_port = None;
                drop(run);
                return Err("CANCELLED:启动已取消：准备期间点了停止".to_string());
            }
            match ServerProcess::spawn(&spec, &log) {
                Ok(proc) => {
                    run.starting = false;
                    run.java = Some(spec.java.clone());
                    run.classpath_jar = Some(spec.classpath_jar.clone());
                    run.classpath_entries = entry_count;
                    run.command_line = server::describe(&spec);
                    run.reason = None;
                    run.exit_code = None;
                    run.debug_port = debug_port;
                    run.proc = Some(proc);
                    run.launch_phase = None;
                    drop(run);
                    // 新的客户端 JVM 加载的就是磁盘上的最新产物：上一轮的热替换结果、
                    // 过时标记、待推列表都作废（中间件那份不动）
                    if let Ok(mut h) = st.hotswap_client.lock() {
                        h.reset();
                        h.attached = java_agent.is_some();
                    }
                    Ok(())
                }
                Err(e) => {
                    run.debug_port = None;
                    drop(run);
                    Err(e)
                }
            }
        })();
        if let Err(e) = &result {
            let _ = server::append_log(&log, &format!("[nc-forge] 客户端启动未完成：{e}\n"));
            if let Ok(mut run) = st.client.lock() {
                if run.run_id.as_deref() == Some(&run_id) {
                    run.starting = false;
                    run.launch_phase = None;
                    run.reason = Some(e.clone());
                }
            }
        }
        result.map(|_| run_id)
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 停止客户端（杀进程树）。
#[tauri::command]
pub async fn client_stop(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    expected_run_id: Option<String>,
) -> Result<StopOutcome, String> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (outcome, debug_session) = {
            let mut run = st.client.lock().map_err(|_| "客户端状态异常".to_string())?;
            let Some(outcome) = run.stop_for_run(expected_run_id.as_deref()) else {
                return Ok(StopOutcome::Idle);
            };
            // Session detachment and this single log line belong to the locked run identity.
            let session = {
                let mut debug = st.debug.lock().map_err(|_| "调试状态异常".to_string())?;
                crate::debug::take_session(&mut debug, crate::debug::DebugTarget::Client)
            };
            match outcome {
                StopOutcome::Stopped => {
                    let _ =
                        server::append_log(&log_path(&st.config_dir), "[nc-forge] 客户端已停止\n");
                }
                StopOutcome::Cancelling => {
                    let _ = server::append_log(
                        &log_path(&st.config_dir),
                        "[nc-forge] 收到客户端停止请求（启动还在准备，已取消）\n",
                    );
                }
                StopOutcome::Idle => {}
            }
            (outcome, session)
        };
        if let Some(s) = debug_session {
            s.client.close();
            let status = st
                .debug
                .lock()
                .map(|run| run.client.status.clone())
                .unwrap_or_else(|_| {
                    crate::debug::DebugStatus::stopped(crate::debug::DebugTarget::Client)
                });
            let _ = app.emit("debug-status", status);
        }
        Ok(outcome)
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 读客户端日志增量。
#[tauri::command]
pub async fn client_log(
    state: tauri::State<'_, Arc<AppState>>,
    offset: u64,
) -> Result<ClientLogChunk, String> {
    let path = log_path(&state.config_dir);
    tauri::async_runtime::spawn_blocking(move || {
        let (text, offset) = server::read_log_from(&path, offset, LOG_CHUNK)?;
        Ok(ClientLogChunk { text, offset })
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 清空客户端日志。规则与中间件相同：运行中只清屏、不动磁盘文件。
#[tauri::command]
pub async fn client_clear_log(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<ClientClearResult, String> {
    let path = log_path(&state.config_dir);
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let running = {
            let mut run = st.client.lock().map_err(|_| "客户端状态异常".to_string())?;
            run.is_alive() || run.starting
        };
        if running {
            let offset = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            return Ok(ClientClearResult {
                offset,
                rotated: false,
            });
        }
        if path.exists() {
            let _ = std::fs::rename(&path, path.with_extension("log.1"));
        }
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("建日志目录失败: {e}"))?;
        }
        std::fs::write(&path, b"").map_err(|e| format!("清空日志失败: {e}"))?;
        Ok(ClientClearResult {
            offset: 0,
            rotated: true,
        })
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 预览客户端命令行（不起进程、不重写 pathing jar）。
#[tauri::command]
pub async fn client_command_line(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<ClientPreview, String> {
    let cfg = state.config.read().await.clone();
    let config_dir = state.config_dir.clone();
    let st = state.inner().clone();
    let hotswap_jar = super::server_cmds::find_hotswap_jar(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let work_dir = config_dir.join("tmp");
        let (reuse, debug_port) = {
            let run = st.client.lock().map_err(|_| "客户端状态异常".to_string())?;
            if run.starting {
                return Err(
                    "上一次客户端启动还在准备 classpath 清单（约 1 秒），等它完成再看命令行"
                        .to_string(),
                );
            }
            (work_dir.join("client-cp.jar").is_file(), run.debug_port)
        };

        let home: NcHome = nc_home::resolve(cfg.nc_home.as_deref())?;
        let nc_home = PathBuf::from(&home.root);
        let java = PathBuf::from(&home.java);
        let project_root = cfg
            .workspace_root
            .clone()
            .map(PathBuf::from)
            .unwrap_or_else(|| nc_home.clone());
        let heap_mb = launch::effective_client_heap_mb(cfg.client_heap_mb);
        let overrides = crate::eclipse_cp::active_overrides(&cfg.linked_overrides);
        // 与启动同一份判断，但 write=false：预览要是顺手换了令牌，正在跑的客户端就连不上了
        let java_agent = crate::hotswap::launch_agent_arg_for(
            crate::hotswap::Target::Client,
            &config_dir,
            hotswap_jar.as_deref(),
            cfg.hotswap_enabled,
            false,
        )
        .unwrap_or(None);
        let tuning = launch::ClientTuning {
            heap_mb,
            debug_port,
            java_agent: java_agent.as_deref(),
        };
        let prepared = if reuse {
            launch::client_spec_preview(
                &nc_home,
                &java,
                &project_root,
                &work_dir,
                tuning,
                &overrides,
            )
        } else {
            launch::client_spec(
                &nc_home,
                &java,
                &project_root,
                &work_dir,
                tuning,
                &overrides,
            )
        };
        let (spec, entry_count) = prepared?;
        Ok(ClientPreview {
            command_line: server::describe(&spec),
            classpath_jar: spec.classpath_jar.to_string_lossy().to_string(),
            entry_count,
            work_dir: spec.work_dir.to_string_lossy().to_string(),
            java: spec.java.to_string_lossy().to_string(),
            endpoints: nc_home::read_endpoints(&nc_home),
            heap_mb,
            reused: reuse,
        })
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 在资源管理器里定位客户端日志。
#[tauri::command]
pub fn client_reveal_log(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    previous: Option<bool>,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let path = crate::service_log::source_path(
        &state.config_dir,
        crate::service_log::LogTarget::Client,
        previous.unwrap_or(false),
    )?;
    if path.exists() {
        return app
            .opener()
            .reveal_item_in_dir(&path)
            .map_err(|e| format!("打开日志位置失败: {e}"));
    }
    let dir = path.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir).map_err(|e| format!("建日志目录失败: {e}"))?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| format!("打开日志目录失败: {e}"))
}

/// 设置客户端堆上限（MB）。传 `None` = 恢复默认 768。返回生效值。
#[tauri::command]
pub async fn client_heap_set(
    state: tauri::State<'_, Arc<AppState>>,
    heap_mb: Option<u32>,
) -> Result<u32, String> {
    launch::validate_heap_mb(heap_mb)?;
    state
        .update_config(|cfg| {
            cfg.client_heap_mb = heap_mb;
            Ok(())
        })
        .await?;
    Ok(launch::effective_client_heap_mb(heap_mb))
}

/// 把上次日志轮转掉，给本次启动一个干净文件（与中间件同款）。
fn rotate_log(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path.parent().unwrap_or(Path::new(".")))
        .map_err(|e| format!("建立日志目录失败：{e}"))?;
    if path.exists() {
        std::fs::rename(path, path.with_extension("log.1"))
            .map_err(|e| format!("归档上次日志失败：{e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 客户端日志与中间件日志分文件() {
        let dir = Path::new(r"D:\config");
        assert!(log_path(dir).ends_with("client.log"));
        assert!(!log_path(dir).ends_with("middleware.log"));
    }

    #[test]
    fn 没有_nc_home_时端点回落默认() {
        let ep = endpoints_for(None);
        assert_eq!(ep.http_port, nc_home::DEFAULT_HTTP_PORT);
        assert!(!ep.from_config);
    }
    #[test]
    fn client_snapshot_captures_launch_context_instead_of_current_configuration() {
        let mut run = ServerRun {
            starting: true,
            project_root: Some(PathBuf::from("old-project")),
            nc_home: Some(PathBuf::from("old-nc")),
            ..ServerRun::default()
        };
        let snap = snapshot(&mut run);
        assert_eq!(snap.project_root.as_deref(), Some("old-project"));
        assert_eq!(snap.nc_home.as_deref(), Some("old-nc"));
    }
}
