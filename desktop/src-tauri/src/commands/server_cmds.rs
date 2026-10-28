//! NC 服务的命令层：状态、启动、停止、日志增量、命令行预览、NC home 选择。
//!
//! 真正的进程与日志逻辑在 `server.rs`，classpath 与 VM 参数在 `launch.rs`，
//! NC home 探测在 `nc_home.rs`——这里只负责「拿配置 → 调它们 → 包成前端要的形状」。
//!
//! 三条约定：
//! 1. **所有起停操作都在 `spawn_blocking` 里做**。写 pathing jar 要 0.6 秒、杀进程树要
//!    等几百毫秒，放在 async 线程上会把整个 IPC 队列卡住（界面表现为所有按钮一起失灵）。
//! 2. **日志用「偏移 + 增量」而不是推事件**。前端每次带上次的 offset 拉新内容，
//!    天然幂等：漏一次轮询只是晚一拍，不会重复也不会丢行；事件方式丢一次就永久丢。
//! 3. **不在持锁时做慢操作**。锁只圈住「读/写运行态」，写 jar、起进程、查 netstat 都在锁外。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::config::AppConfig;
use crate::launch::{self, MIDDLEWARE_MAIN_CLASS};
use crate::nc_home::{self, NcHome, ServerEndpoints};
use crate::nc_port::{self, PortApplied, PortPlan};
use crate::server::{self, PortOwner, ServerProcess, ServerRun, StopOutcome};
use crate::state::AppState;

/// 一次增量读的上限。256KB 够看几千行；更大的批次对界面没有意义（人读不过来）。
const LOG_CHUNK: u64 = 256 * 1024;

/// 服务状态快照（前端每次轮询拿这一份，界面不自己拼状态）。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    /// `stopped` / `starting` / `running`。
    pub state: &'static str,
    pub pid: Option<u32>,
    pub started_at_ms: Option<u64>,
    pub uptime_ms: Option<u64>,
    /// 中间件的监听端口（读自 `ierp/bin/prop.xml`，不是写死的 80）。
    pub port: u16,
    /// 监听地址；`127.0.0.1` 表示只有本机能访问。
    pub port_address: Option<String>,
    /// 端口是从配置文件读到的（false = 没读到，用的是默认 80）。
    pub port_from_config: bool,
    /// 端口配置文件的路径，界面用来显示「端口从哪来」。
    pub port_config_path: String,
    /// 该端口的占用者（netstat 查到的，可能不是我们）。
    pub port_owner: Option<PortOwner>,
    /// 占用者是不是本应用起的那个 java。
    pub port_owned_by_self: bool,
    pub log_path: String,
    pub log_size: u64,
    pub java: Option<String>,
    /// 上次启动装进 classpath 的条目数（含工程 classes 与 7000+ 个 jar）。
    pub classpath_entries: usize,
    pub main_class: String,
    pub command_line: String,
    pub exit_code: Option<i32>,
    /// 最近一次停止/失败的原因。
    pub reason: Option<String>,
    /// 当前工作区（工程根）；未选择时启动不会带上工程 classes，改代码不生效。
    pub project_root: Option<String>,
    /// 配置里的 NC home（可能为空 = 用默认位置）。
    pub nc_home: Option<String>,
    /// 实际会写进命令行的堆上限（MB，已收口，见 `launch::effective_heap_mb`）。
    /// 界面显示生效值而不是配置原值：手改过配置的同事才知道 JVM 真正拿到多少。
    pub heap_mb: u32,
    /// 堆上限的默认值（MB），界面用来标「默认」。
    pub default_heap_mb: u32,
}

/// 日志增量。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogChunk {
    pub text: String,
    pub offset: u64,
}

/// 启动前的命令行预览（不真启动）。排错时对照 Eclipse 的启动配置用。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchPreview {
    pub command_line: String,
    pub classpath_jar: String,
    pub entry_count: usize,
    pub work_dir: String,
    pub java: String,
    /// 中间件会监听哪个端口（读自 prop.xml），对话框里一并显示，
    /// 方便和 Eclipse 的启动配置逐项对照。
    pub endpoints: ServerEndpoints,
    /// 这次会用的堆上限（MB），对话框里标出来「在服务页可改」。
    pub heap_mb: u32,
}

fn log_path(config_dir: &Path) -> PathBuf {
    config_dir.join("logs").join("middleware.log")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 从运行态里抄出来的一份不可变快照。
///
/// 分开的理由：查端口要跑 netstat（几十毫秒），不该在持锁时做——否则每秒一次的状态
/// 轮询会把「启动」按钮多压几十毫秒。
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
    }
}

fn build_status(cfg: &AppConfig, config_dir: &Path, s: Snap, ep: &ServerEndpoints) -> ServerStatus {
    let path = log_path(config_dir);
    let port = ep.http_port;
    let owner = server::port_owner(port);
    let owned_by_self = match (&owner, s.pid) {
        (Some(o), Some(p)) => o.pid == p,
        _ => false,
    };
    // 端口通了才算真的起来了：进程起来到 Tomcat 开始监听之间有一大段（NC 加载模块很慢），
    // 这段时间界面该显示「启动中」，而不是让用户以为已经能用。
    let state = if s.alive {
        if owned_by_self && server::port_reachable(port) {
            "running"
        } else {
            "starting"
        }
    } else if s.starting {
        "starting"
    } else {
        "stopped"
    };

    ServerStatus {
        state,
        pid: s.pid,
        started_at_ms: s.started_at_ms,
        uptime_ms: s.started_at_ms.map(|t| now_ms().saturating_sub(t)),
        port,
        port_address: ep.http_address.clone(),
        port_from_config: ep.from_config,
        port_config_path: ep.config_path.clone(),
        port_owner: owner,
        port_owned_by_self: owned_by_self,
        log_path: path.to_string_lossy().to_string(),
        log_size: path.metadata().map(|m| m.len()).unwrap_or(0),
        java: s.java,
        classpath_entries: s.classpath_entries,
        main_class: MIDDLEWARE_MAIN_CLASS.to_string(),
        command_line: s.command_line,
        exit_code: s.exit_code,
        reason: s.reason,
        project_root: cfg.workspace_root.clone(),
        nc_home: cfg.nc_home.clone(),
        heap_mb: launch::effective_heap_mb(cfg.server_heap_mb),
        default_heap_mb: launch::DEFAULT_HEAP_MB,
    }
}

/// 当前服务状态（前端 1 秒轮询一次）。
///
/// **整段都在 `spawn_blocking` 里**：拿端点要 canonicalize + 扫 245 个模块目录，
/// 查端口要 fork `netstat`（实测 30ms），查进程名第一次还要 `tasklist`（170ms）。
/// 放在 async 线程上就是每秒钉住一个 tokio worker 小半拍，其它 IPC（点按钮、拉日志）
/// 全排在后面——这正是本模块头注释里那条「慢操作不许上 async 线程」。
#[tauri::command]
pub async fn server_status(state: tauri::State<'_, Arc<AppState>>) -> Result<ServerStatus, String> {
    let cfg = state.config.read().await.clone();
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let snap = {
            let mut run = st.server.lock().map_err(|_| "服务状态异常".to_string())?;
            snapshot(&mut run)
        };
        // NC home 定位失败时不能直接报错：服务页还得能显示「未找到 NC 安装目录」，
        // 此时端口按默认 80 显示，并标记「不是从配置读的」（界面据此不宣称端口可信）。
        let endpoints = match nc_home::resolve(cfg.nc_home.as_deref()) {
            Ok(home) => nc_home::read_endpoints(Path::new(&home.root)),
            Err(_) => ServerEndpoints::fallback(String::new()),
        };
        Ok(build_status(&cfg, &st.config_dir, snap, &endpoints))
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 启动中间件。端口被占、NC home 不可用、已在运行时直接返回可读的错误。
#[tauri::command]
pub async fn server_start(state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    let cfg = state.config.read().await.clone();
    let config_dir = state.config_dir.clone();
    let st = state.inner().clone();

    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let log = log_path(&config_dir);
        let home = nc_home::resolve(cfg.nc_home.as_deref())?;
        let nc_home = PathBuf::from(&home.root);
        let java = PathBuf::from(&home.java);

        // 锁只圈住「检查 + 置启动中」：写 jar 要 0.6 秒，持锁会让状态轮询一起卡住
        {
            let mut run = st.server.lock().map_err(|_| "服务状态异常".to_string())?;
            if run.is_alive() {
                return Err("服务已在运行，先停止再启动".to_string());
            }
            if run.starting {
                return Err("上一次启动还没完成，稍等一下".to_string());
            }
            // 端口以 NC 自己的配置为准（ierp/bin/prop.xml），不是写死的 80
            let port = nc_home::read_endpoints(&nc_home).http_port;
            if let Some(owner) = server::port_owner(port) {
                return Err(format!(
                    "端口 {port} 已被 {} (PID {}) 占用，服务起不来。\
                     如果那是上次没停干净的 NC 中间件，可点「结束占用进程」；否则先关掉它。",
                    owner.name, owner.pid
                ));
            }
            run.starting = true;
            run.stop_requested = false;
            run.reason = None;
        }

        // 没选工程也要能起服务：此时只用 NC home 自带的 jar（改代码不生效，界面会提示），
        // 比直接拒绝启动更有用——用户常常先要验证环境通不通。
        let project_root = cfg
            .workspace_root
            .clone()
            .map(PathBuf::from)
            .unwrap_or_else(|| nc_home.clone());
        // 堆上限取生效值（配置可能没设或被手改坏）；启动与命令行预览必须用同一份
        let heap_mb = launch::effective_heap_mb(cfg.server_heap_mb);
        // 慢的一步放锁外：写 7000 多条清单的 pathing jar 实测约 0.6 秒，
        // 持锁会让每秒一次的状态轮询一起卡住
        let prepared = launch::middleware_spec(
            &nc_home,
            &java,
            &project_root,
            &config_dir.join("tmp"),
            heap_mb,
        );
        let (spec, entry_count) = match prepared {
            Ok(v) => v,
            Err(e) => {
                if let Ok(mut run) = st.server.lock() {
                    run.starting = false;
                    run.reason = Some(e.clone());
                }
                let _ = server::append_log(&log, &format!("[nc-forge] 启动失败：{e}\n"));
                return Err(e);
            }
        };

        // 起进程很快（fork 几十毫秒），但必须在锁内**复查一次停止请求**：
        // 写 jar 的那一秒里用户可能已经点了停止，那时 proc 还不存在，
        // 只靠 proc.take() 的停止拦不住，服务会在他以为停掉之后照样起来。
        let mut run = st.server.lock().map_err(|_| "服务状态异常".to_string())?;
        if run.stop_requested {
            run.starting = false;
            run.stop_requested = false;
            run.reason = Some("启动已取消".to_string());
            drop(run);
            let _ = server::append_log(&log, "[nc-forge] 启动已取消（准备期间收到停止请求）\n");
            return Err("启动已取消：准备期间点了停止".to_string());
        }
        rotate_log(&log);
        match ServerProcess::spawn(&spec, &log) {
            Ok(proc) => {
                run.starting = false;
                run.java = Some(spec.java.clone());
                run.classpath_jar = Some(spec.classpath_jar.clone());
                run.classpath_entries = entry_count;
                run.command_line = server::describe(&spec);
                run.reason = None;
                run.exit_code = None;
                run.proc = Some(proc);
                drop(run);
                let _ = server::append_log(
                    &log,
                    &format!(
                        "[nc-forge] classpath 条目 {entry_count} 个（清单见 {}），堆上限 -Xmx{heap_mb}m\n",
                        spec.classpath_jar.display()
                    ),
                );
                Ok(())
            }
            Err(e) => {
                run.starting = false;
                run.reason = Some(e.clone());
                drop(run);
                let _ = server::append_log(&log, &format!("[nc-forge] 启动失败：{e}\n"));
                Err(e)
            }
        }
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 停止中间件（杀进程树）。
///
/// 返回三种结果而不是 bool：准备启动期间点停止既不是「停掉了」也不是「没东西可停」，
/// 界面要能分别提示，不能一律说「已停止」。
#[tauri::command]
pub async fn server_stop(state: tauri::State<'_, Arc<AppState>>) -> Result<StopOutcome, String> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let outcome = {
            let mut run = st.server.lock().map_err(|_| "服务状态异常".to_string())?;
            run.stop()
        };
        match outcome {
            StopOutcome::Stopped => {
                let _ = server::append_log(&log_path(&st.config_dir), "[nc-forge] 已停止\n");
            }
            StopOutcome::Cancelling => {
                let _ = server::append_log(
                    &log_path(&st.config_dir),
                    "[nc-forge] 收到停止请求（启动还在准备，已取消）\n",
                );
            }
            StopOutcome::Idle => {}
        }
        Ok(outcome)
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 读日志增量。`offset` 是上次返回的偏移，初次传 0。
#[tauri::command]
pub async fn server_log(
    state: tauri::State<'_, Arc<AppState>>,
    offset: u64,
) -> Result<LogChunk, String> {
    let path = log_path(&state.config_dir);
    tauri::async_runtime::spawn_blocking(move || {
        let (text, offset) = server::read_log_from(&path, offset, LOG_CHUNK)?;
        Ok(LogChunk { text, offset })
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 清空日志（把当前文件改名成 `.log.1` 再新建空的）。
///
/// 为什么不直接 truncate：中间件还持有 append 句柄，truncate 后写入位置在个别
/// 文件系统上会错乱；改名再新建最稳，且旧日志还能查。
#[tauri::command]
pub async fn server_clear_log(state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    let path = log_path(&state.config_dir);
    tauri::async_runtime::spawn_blocking(move || {
        if path.exists() {
            let _ = std::fs::rename(&path, path.with_extension("log.1"));
        }
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("建日志目录失败: {e}"))?;
        }
        std::fs::write(&path, b"").map_err(|e| format!("清空日志失败: {e}"))
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 预览将要执行的命令行（会写 pathing jar，但不起进程）。
#[tauri::command]
pub async fn server_command_line(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<LaunchPreview, String> {
    let cfg = state.config.read().await.clone();
    let config_dir = state.config_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let home: NcHome = nc_home::resolve(cfg.nc_home.as_deref())?;
        let nc_home = PathBuf::from(&home.root);
        let java = PathBuf::from(&home.java);
        let project_root = cfg
            .workspace_root
            .clone()
            .map(PathBuf::from)
            .unwrap_or_else(|| nc_home.clone());
        let heap_mb = launch::effective_heap_mb(cfg.server_heap_mb);
        let (spec, entry_count) = launch::middleware_spec(
            &nc_home,
            &java,
            &project_root,
            &config_dir.join("tmp"),
            heap_mb,
        )?;
        Ok(LaunchPreview {
            command_line: server::describe(&spec),
            classpath_jar: spec.classpath_jar.to_string_lossy().to_string(),
            entry_count,
            work_dir: spec.work_dir.to_string_lossy().to_string(),
            java: spec.java.to_string_lossy().to_string(),
            endpoints: nc_home::read_endpoints(&nc_home),
            heap_mb,
        })
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 在资源管理器里定位日志文件（文件还不存在时打开它所在目录）。
#[tauri::command]
pub fn server_reveal_log(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let path = log_path(&state.config_dir);
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

/// 结束占用中间件端口的 java 进程（残留的 NC 中间件）。
///
/// 端口取自 NC 自己的配置（`ierp/bin/prop.xml`），不是写死的 80。
/// **只杀 `java*` 进程**：80 端口是很敏感的位置，可能是 IIS、可能是别的服务；
/// 本应用没有资格替用户决定杀掉它们。前端会在调用前二次确认。
#[tauri::command]
pub async fn server_kill_port_owner(state: tauri::State<'_, Arc<AppState>>) -> Result<u32, String> {
    let cfg = state.config.read().await.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let home = nc_home::resolve(cfg.nc_home.as_deref())?;
        let port = nc_home::read_endpoints(Path::new(&home.root)).http_port;
        let owner =
            server::port_owner(port).ok_or_else(|| format!("端口 {port} 现在没有人占用"))?;
        // 重新实时查一次名字，**不用状态轮询里的缓存**：那个缓存有 10 秒有效期，
        // 而 PID 可能已经被系统复用给另一个程序。这里决定的是「要不要杀」，
        // 拿 10 秒前的判断去杀人是不可接受的。
        let name = server::process_name(owner.pid).unwrap_or(owner.name);
        if !server::is_java_name(&name) {
            return Err(format!(
                "占用 {port} 端口的是 {name} (PID {})，不是 java 进程，出于安全考虑不代你结束它",
                owner.pid
            ));
        }
        #[cfg(windows)]
        {
            server::kill_tree(owner.pid, true);
            Ok(owner.pid)
        }
        #[cfg(not(windows))]
        {
            Err("此操作只支持 Windows".to_string())
        }
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 探测一个目录是不是 NC home。`path` 为空时用配置值 / 默认位置。
#[tauri::command]
pub async fn nc_home_probe(
    state: tauri::State<'_, Arc<AppState>>,
    path: Option<String>,
) -> Result<NcHome, String> {
    let configured = match path {
        Some(p) if !p.trim().is_empty() => Some(p),
        Some(_) => None, // 显式传空 = 清空配置，回落到默认位置
        None => state.config.read().await.nc_home.clone(),
    };
    tauri::async_runtime::spawn_blocking(move || nc_home::resolve(configured.as_deref()))
        .await
        .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 选择 / 清空 NC home 并落盘。成功后返回探测结果。
#[tauri::command]
pub async fn nc_home_set(
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
) -> Result<NcHome, String> {
    let trimmed = path.trim().to_string();
    if trimmed.is_empty() {
        // 走 update_config：整份配置的读改写必须串行，否则会盖掉同一时刻别处的改动
        state
            .update_config(|cfg| {
                cfg.nc_home = None;
                Ok(())
            })
            .await?;
        return tauri::async_runtime::spawn_blocking(|| nc_home::resolve(None))
            .await
            .map_err(|e| format!("后台任务失败: {e}"))?;
    }
    let target = PathBuf::from(&trimmed);
    // 探测（canonicalize + 扫模块目录）放后台线程，与配置写入分开：探测失败不该动配置
    let home = tauri::async_runtime::spawn_blocking(move || nc_home::probe(&target))
        .await
        .map_err(|e| format!("后台任务失败: {e}"))??;
    let root = home.root.clone();
    state
        .update_config(move |cfg| {
            cfg.nc_home = Some(root);
            Ok(())
        })
        .await?;
    Ok(home)
}

/// 设置中间件堆上限（MB）。传 `None` = 恢复默认 4G。返回生效值。
///
/// 只写配置，不动正在跑的 JVM：堆是启动参数，`server_start` 才读它，所以改了要重启才生效
/// （界面负责把话说清楚，不假装已生效）。越界直接报错而不是静默夹边——用户敲了 70000
/// 却拿到 65536 才是更难查的问题。校验规则在 `launch::validate_heap_mb`（单一出处）。
#[tauri::command]
pub async fn server_heap_set(
    state: tauri::State<'_, Arc<AppState>>,
    heap_mb: Option<u32>,
) -> Result<u32, String> {
    launch::validate_heap_mb(heap_mb)?;
    state
        .update_config(|cfg| {
            cfg.server_heap_mb = heap_mb;
            Ok(())
        })
        .await?;
    Ok(launch::effective_heap_mb(heap_mb))
}

/// 改端口前的运行中检查，**预览与执行共用同一句判断与文案**。
///
/// 为什么要拦：已经起来的 JVM 不会重读 `prop.xml`。放着不管就会出现
/// 「界面显示 8081、服务实际还在 80」的错位——这类问题排查起来最费劲。
/// 两条命令必须认同一套规则：只拦执行不拦预览，用户签收完才发现被拒；
/// 只拦预览不拦执行，那预览就白设计了。文案分家也会有同样的毛病。
fn port_edit_blocked(run: &mut ServerRun) -> Option<String> {
    if run.is_alive() || run.starting {
        Some("服务正在运行，先停止再改端口（已经启动的 JVM 不会重读配置）".to_string())
    } else {
        None
    }
}

/// 改端口的方案预览（只读，不写任何文件）。
/// 为什么先预览再执行：改端口要动两份配置，用户看不见改了什么就只能盲信。
/// 预览把「哪个文件、原来是什么、改成什么」逐条列出来，签收后才落笔。
#[tauri::command]
pub async fn nc_port_preview(
    state: tauri::State<'_, Arc<AppState>>,
    port: u16,
) -> Result<PortPlan, String> {
    let cfg = state.config.read().await.clone();
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let home = nc_home::resolve(cfg.nc_home.as_deref())?;
        let root = PathBuf::from(&home.root);
        let mut plan = nc_port::plan(&root, port)?;

        // 已经在跑的 JVM 不会重读 prop.xml。放着不管就会出现「界面显示 8081、
        // 服务实际还在 80」的错位——这类问题排查起来最费劲，直接在入口挡掉。
        {
            let mut run = st.server.lock().map_err(|_| "服务状态异常".to_string())?;
            if let Some(why) = port_edit_blocked(&mut run) {
                plan.blocked = Some(match plan.blocked.take() {
                    Some(prev) => format!("{prev}；而且{why}"),
                    None => why,
                });
            }
        }

        // 目标端口被占：只提示不拦。用户要的可能正是「80 被占了，换到 8081」，
        // 也可能打算改完再腾端口，替他决定没有意义。
        if let Some(owner) = server::port_owner(port) {
            plan.warnings.push(format!(
                "端口 {port} 现在被 {} (PID {}) 占用，改完要先腾出来才能启动",
                owner.name, owner.pid
            ));
        }
        Ok(plan)
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 执行改端口：写 `ierp/bin/prop.xml` 与 web 端的 `system.properties`。
///
/// NC 安装目录是本机独立的（各人自己装），所以可以直接写；两份文件都会先备份成
/// `*.ncforge-bak`（已存在则不覆盖，保住最早的原件）。
#[tauri::command]
pub async fn nc_port_apply(
    state: tauri::State<'_, Arc<AppState>>,
    port: u16,
) -> Result<PortApplied, String> {
    let cfg = state.config.read().await.clone();
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let home = nc_home::resolve(cfg.nc_home.as_deref())?;
        let root = PathBuf::from(&home.root);
        {
            let mut run = st.server.lock().map_err(|_| "服务状态异常".to_string())?;
            if let Some(why) = port_edit_blocked(&mut run) {
                return Err(why);
            }
        }
        nc_port::apply(&root, port)
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 把上次日志轮转掉，给本次启动一个干净文件。
fn rotate_log(path: &Path) {
    let _ = std::fs::create_dir_all(path.parent().unwrap_or(Path::new(".")));
    if path.exists() {
        let _ = std::fs::rename(path, path.with_extension("log.1"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::ServerRun;

    /// 预览和执行拦「运行中改端口」必须是同一套规则。文案分家就会出现
    /// 「预览放行、执行被拒」——用户签收完才发现改不了，比一开始就拒更难查。
    #[test]
    fn 停止状态不拦改端口() {
        let mut run = ServerRun::default();
        assert!(port_edit_blocked(&mut run).is_none());
    }

    /// 写 pathing jar 的那一秒里 JVM 还不存在，但配置已经可能被用户盯着改——
    // 同样拦：启动完成的那一刻错位就出现了。
    #[test]
    fn 启动准备中也拦改端口() {
        let mut run = ServerRun {
            starting: true,
            ..ServerRun::default()
        };
        let why = port_edit_blocked(&mut run).expect("准备阶段同样会造成端口错位");
        assert!(why.contains("停止"), "要说清该怎么办：{why}");
    }
}
