//! 「热替换」命令层：编译后的推送入口 + 状态查询 + 手动推送。
//!
//! 算法在 `hotswap.rs`（纯逻辑、可单测）；这里只管三件事：取配置、把阻塞的推送放到后台线程、
//! 把结果记进 `AppState.hotswap` / `hotswap_client` 并以 `hotswap-result` 事件发给前端。
//!
//! 中间件和客户端是两个 JVM，各挂各的 agent、各记各的状态（[`Target`]）。一个源文件推给谁，
//! 由它所在的源码目录决定（`hotswap::targets_for_source`）。
//!
//! 事件：
//! - `hotswap-result`：一次有效推送的 [`hotswap::Report`]（带 `target`；`unavailable` 不发，那是常态）；
//! - `hotswap-pending`：手动模式下待推类数变化（载荷是两个目标的总数）。

use std::path::Path;
use std::sync::Arc;

use serde::Serialize;
use tauri::Emitter;

use crate::hotswap::{self, Batch, Report, Target};
use crate::state::AppState;

/// 编译成功后调用（`build_engine::compile_files`）。不阻塞：推送走一次性后台线程。
///
/// 没有就绪文件时什么都不做，也不攒待推列表：那个 JVM 没跑（或没挂 agent），
/// 下次启动加载的就是磁盘上的新产物，没什么可推的。两个目标互不影响：
/// 客户端没开不妨碍中间件照常推送。
pub(super) fn after_compile(
    app: &tauri::AppHandle,
    st: &Arc<AppState>,
    config_dir: &Path,
    enabled: bool,
    auto: bool,
    server: Batch,
    client: Batch,
) {
    if !enabled {
        return;
    }
    for (target, batch) in [(Target::Server, server), (Target::Client, client)] {
        if batch.is_empty() {
            continue;
        }
        let session = target.session_file(config_dir);
        if hotswap::read_ready(&session).is_none() {
            continue;
        }
        if !auto {
            if queue_pending(st, target, batch) {
                let _ = app.emit("hotswap-pending", pending_total(st));
            }
            continue;
        }
        let app = app.clone();
        let st = st.clone();
        let spawned = std::thread::Builder::new()
            .name(format!("ncforge-hotswap-push-{}", target.as_str()))
            .spawn(move || {
                let report = hotswap::push(&session, &batch);
                publish(&app, &st, target, report);
            });
        if let Err(e) = spawned {
            log::warn!("热替换推送线程起不来（{}）：{e}", target.label());
        }
    }
}

/// 手动模式：把一批编译产物攒进该目标的待推列表。锁坏了返回 false（不通知前端）。
fn queue_pending(st: &AppState, target: Target, batch: Batch) -> bool {
    match st.hotswap_of(target).lock() {
        Ok(mut h) => {
            h.pending.merge(batch);
            true
        }
        Err(_) => false,
    }
}

/// 取走两个目标各自攒着的批次（空批次不返回）。先取出再推：推送期间编译出的新类进入下一批。
fn take_pending(st: &AppState) -> Result<Vec<(Target, Batch)>, String> {
    let mut batches = Vec::new();
    for target in Target::ALL {
        let mut h = st
            .hotswap_of(target)
            .lock()
            .map_err(|_| "热替换状态异常".to_string())?;
        let batch = std::mem::take(&mut h.pending);
        if !batch.is_empty() {
            batches.push((target, batch));
        }
    }
    Ok(batches)
}

/// 丢掉两个目标攒着的待推类。
fn clear_pending(st: &AppState) -> Result<(), String> {
    for target in Target::ALL {
        st.hotswap_of(target)
            .lock()
            .map_err(|_| "热替换状态异常".to_string())?
            .pending = Batch::default();
    }
    Ok(())
}

/// 两个目标的待推类数之和（`hotswap-pending` 事件的载荷）。
fn pending_total(st: &AppState) -> usize {
    Target::ALL
        .iter()
        .map(|t| {
            st.hotswap_of(*t)
                .lock()
                .map(|h| h.pending.classes.len())
                .unwrap_or(0)
        })
        .sum()
}

/// 那个 JVM 的进程还活着吗。
fn jvm_alive(st: &AppState, target: Target) -> bool {
    let run = match target {
        Target::Server => &st.server,
        Target::Client => &st.client,
    };
    run.lock().map(|mut s| s.is_alive()).unwrap_or(false)
}

/// 该目标的服务日志（热替换结果同步写一行进去）。
fn log_file(config_dir: &Path, target: Target) -> std::path::PathBuf {
    match target {
        Target::Server => super::server_cmds::log_path(config_dir),
        Target::Client => super::client_cmds::log_path(config_dir),
    }
}

/// 记录并通知前端。`unavailable` 只记调试日志（服务刚停、agent 还没就绪都会走到这里），
/// 例外：JVM 活着、就绪文件在却送不到 agent 时升级为可见的失败。
fn publish(app: &tauri::AppHandle, st: &AppState, target: Target, report: Report) {
    let report = report.for_target(target);
    let report = if report.state == "unavailable" {
        // 带失败码 = 就绪文件在却送不到。JVM 还活着时这不是「没在跑」的常态：
        // class 已写盘而 JVM 里是旧的，静默会让人以为换过了（重启后首次保存没推送就是没法查）。
        // JVM 已停时就绪文件会留着，照旧静默。
        let alive = jvm_alive(st, target);
        if report.code.is_none() || !alive {
            log::debug!(
                "热替换未执行（{}）：{}",
                target.label(),
                report.message.as_deref().unwrap_or("")
            );
            return;
        }
        log::warn!(
            "热替换送不到 agent（{}，{}）：{}",
            target.label(),
            report.code.as_deref().unwrap_or(""),
            report.message.as_deref().unwrap_or("")
        );
        let mut r = report.escalate();
        r.message = Some(format!(
            "没能连上运行中的热替换 agent：{}",
            r.message.as_deref().unwrap_or("未知原因")
        ));
        r
    } else {
        report
    };
    if let Ok(mut h) = st.hotswap_of(target).lock() {
        h.record(report.clone());
    }
    // 同步写进该 JVM 的日志：翻日志时能对上「这次请求之前换没换过代码」。写失败不影响推送结果。
    let _ = crate::server::append_log(&log_file(&st.config_dir, target), &report.log_line());
    let _ = app.emit("hotswap-result", &report);
}

/// 客户端那一侧的状态（中间件的字段在 [`HotswapStatus`] 顶层，保持老接口不变）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientHotswapStatus {
    /// 客户端进程是否在运行。没开客户端时前端不讲它。
    pub running: bool,
    /// agent 此刻是否可达（ping 通）。
    pub agent_online: bool,
    /// 本次启动带了 agent（还没就绪时 `agent_online` 为 false）。
    pub agent_attached: bool,
    /// 客户端里运行的代码不是最新（客户端重启后清除）。
    pub stale: bool,
}

/// 前端状态栏 / 服务页用的热替换状态。
///
/// 顶层的 `agent_*` 是中间件的；`stale` / `pending` / `last` / `stale_report` 是**两个 JVM 合并后**的：
/// 状态栏只有一个小签，要的是「有没有哪边出了问题」「最近一次发生了什么」，
/// 具体是哪边看报告里的 `target`。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotswapStatus {
    /// 配置开关：启动时挂 agent。
    pub enabled: bool,
    /// 配置开关：编译后自动推送。
    pub auto: bool,
    /// 中间件 agent 此刻是否可达（ping 通）。
    pub agent_online: bool,
    /// 本次启动带了 agent（还没就绪时 `agent_online` 为 false，靠它区分「准备中」与「没挂」）。
    pub agent_attached: bool,
    /// 运行中的代码不是最新（任一 JVM 有推送失败或被遮蔽，对应 JVM 重启后清除）。
    pub stale: bool,
    /// 手动模式下待推的类数（两个 JVM 之和）。
    pub pending: usize,
    /// 待推类名（弹出卡展示用，最多 [`PENDING_NAMES_MAX`] 个）。
    pub pending_classes: Vec<String>,
    /// 两个 JVM 里最近一次有效推送的结果。
    pub last: Option<Report>,
    /// 让 `stale` 置位的那次结果（服务页告警条讲的是它，不是最近一次）。
    pub stale_report: Option<Report>,
    pub client: ClientHotswapStatus,
}

/// 弹出卡最多列这么多个待推类；再多只显示总数。
const PENDING_NAMES_MAX: usize = 50;

/// 取较新的一份（`at_ms` 大者）。
fn newer(a: Option<Report>, b: Option<Report>) -> Option<Report> {
    match (a, b) {
        (Some(x), Some(y)) => Some(if y.at_ms > x.at_ms { y } else { x }),
        (x, None) => x,
        (None, y) => y,
    }
}

/// 查询热替换状态。会 ping 两个 agent 各一次（本机回环，毫秒级；连不上最多等 1.5 秒）。
#[tauri::command]
pub async fn hotswap_status(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<HotswapStatus, String> {
    let (enabled, auto) = {
        let cfg = state.config.read().await;
        (cfg.hotswap_enabled, cfg.hotswap_auto)
    };
    let server_session = Target::Server.session_file(&state.config_dir);
    let client_session = Target::Client.session_file(&state.config_dir);
    let client_running = jvm_alive(state.inner(), Target::Client);
    // 客户端没在跑就不 ping：就绪文件会留着，而端口可能已被别的进程占了
    let (agent_online, client_online) = tauri::async_runtime::spawn_blocking(move || {
        (
            hotswap::ping(&server_session),
            client_running && hotswap::ping(&client_session),
        )
    })
    .await
    .unwrap_or((false, false));
    let sh = state
        .hotswap
        .lock()
        .map_err(|_| "热替换状态异常".to_string())?;
    let ch = state
        .hotswap_client
        .lock()
        .map_err(|_| "热替换状态异常".to_string())?;
    // 客户端停了之后，它那份结果、过时标记都不再有意义：下次启动加载的就是磁盘上的新产物
    let client_stale = client_running && ch.stale;
    let pending_classes: Vec<String> = sh
        .pending
        .classes
        .iter()
        .chain(ch.pending.classes.iter())
        .take(PENDING_NAMES_MAX)
        .map(|c| c.name.clone())
        .collect();
    Ok(HotswapStatus {
        enabled,
        auto,
        agent_online,
        agent_attached: sh.attached || agent_online,
        stale: sh.stale || client_stale,
        pending: sh.pending.classes.len() + ch.pending.classes.len(),
        pending_classes,
        last: newer(
            sh.last.clone(),
            client_running.then(|| ch.last.clone()).flatten(),
        ),
        stale_report: newer(
            sh.stale.then(|| sh.stale_report.clone()).flatten(),
            client_stale.then(|| ch.stale_report.clone()).flatten(),
        ),
        client: ClientHotswapStatus {
            running: client_running,
            agent_online: client_online,
            agent_attached: ch.attached || client_online,
            stale: client_stale,
        },
    })
}

/// 手动模式：丢掉攒着的待推类（磁盘上的产物不动，下次重启照样加载新代码）。
#[tauri::command]
pub async fn hotswap_clear_pending(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    clear_pending(state.inner())?;
    let _ = app.emit("hotswap-pending", 0usize);
    Ok(())
}

/// 手动模式：把攒着的类一次推给运行中的 JVM（中间件、客户端各推各的那一批）。
///
/// 待推列表先取出再推：推送期间编译出的新类进入下一批，不会被这次的结果吞掉。
/// JVM 已停（`unavailable`）时不把批次放回去：下次启动会加载磁盘上的最新产物。
/// 返回最后一个目标的结果；两个目标都有时前端靠 `hotswap-result` 事件拿到各自的。
#[tauri::command]
pub async fn hotswap_push_pending(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Report, String> {
    let batches = take_pending(state.inner())?;
    if batches.is_empty() {
        return Err("没有待热替换的类".to_string());
    }
    let mut last = None;
    for (target, batch) in batches {
        let session = target.session_file(&state.config_dir);
        let report = tauri::async_runtime::spawn_blocking(move || hotswap::push(&session, &batch))
            .await
            .map_err(|e| format!("后台任务失败: {e}"))?
            .for_target(target);
        publish(&app, state.inner(), target, report.clone());
        last = Some(report);
    }
    let _ = app.emit("hotswap-pending", 0usize);
    last.ok_or_else(|| "没有待热替换的类".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AppConfig;
    use crate::hotswap::ClassItem;
    use std::path::PathBuf;

    fn batch(root: &str, names: &[&str]) -> Batch {
        let root = PathBuf::from(root);
        Batch {
            roots: vec![root.clone()],
            classes: names
                .iter()
                .map(|n| ClassItem {
                    name: n.to_string(),
                    file: root.join(format!("{}.class", n.replace('.', "/"))),
                })
                .collect(),
        }
    }

    fn state() -> (tempfile::TempDir, Arc<AppState>) {
        let d = tempfile::tempdir().unwrap();
        let st = AppState::new(AppConfig::default(), d.path().to_path_buf());
        (d, st)
    }

    #[test]
    fn 手动模式两个目标各攒各的() {
        let (_d, st) = state();
        assert!(queue_pending(
            &st,
            Target::Server,
            batch("s/classes", &["a.A", "a.B"])
        ));
        assert!(queue_pending(
            &st,
            Target::Client,
            batch("c/classes", &["c.C"])
        ));
        assert_eq!(pending_total(&st), 3);
        // 互不串：服务端那份里没有客户端的类
        let server = st.hotswap_of(Target::Server).lock().unwrap();
        assert!(server
            .pending
            .classes
            .iter()
            .all(|c| c.name.starts_with("a.")));
        let client = st.hotswap_of(Target::Client).lock().unwrap();
        assert_eq!(client.pending.classes.len(), 1);
    }

    #[test]
    fn 同一目标重复攒会去重() {
        let (_d, st) = state();
        queue_pending(&st, Target::Client, batch("c/classes", &["c.C"]));
        queue_pending(&st, Target::Client, batch("c/classes", &["c.C", "c.D"]));
        assert_eq!(pending_total(&st), 2);
    }

    #[test]
    fn 推送取走两边的批次并清空待推列表() {
        let (_d, st) = state();
        queue_pending(&st, Target::Server, batch("s/classes", &["a.A"]));
        queue_pending(&st, Target::Client, batch("c/classes", &["c.C"]));
        let taken = take_pending(&st).unwrap();
        let targets: Vec<Target> = taken.iter().map(|(t, _)| *t).collect();
        assert_eq!(targets, vec![Target::Server, Target::Client]);
        assert_eq!(pending_total(&st), 0);
        // 取走之后新编译出的类进下一批，不会被这一次吞掉
        queue_pending(&st, Target::Client, batch("c/classes", &["c.E"]));
        let next = take_pending(&st).unwrap();
        assert_eq!(next.len(), 1);
        assert_eq!(next[0].0, Target::Client);
    }

    #[test]
    fn 只有一边有待推类时只取那一边() {
        let (_d, st) = state();
        queue_pending(&st, Target::Client, batch("c/classes", &["c.C"]));
        let taken = take_pending(&st).unwrap();
        assert_eq!(taken.len(), 1);
        assert_eq!(taken[0].0, Target::Client);
        assert!(take_pending(&st).unwrap().is_empty());
    }

    #[test]
    fn 清空待推列表两边都清() {
        let (_d, st) = state();
        queue_pending(&st, Target::Server, batch("s/classes", &["a.A"]));
        queue_pending(&st, Target::Client, batch("c/classes", &["c.C"]));
        clear_pending(&st).unwrap();
        assert_eq!(pending_total(&st), 0);
        assert!(take_pending(&st).unwrap().is_empty());
    }
}
