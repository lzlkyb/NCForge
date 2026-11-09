//! 「热替换」命令层：编译后的推送入口 + 状态查询 + 手动推送。
//!
//! 算法在 `hotswap.rs`（纯逻辑、可单测）；这里只管三件事：取配置、把阻塞的推送放到后台线程、
//! 把结果记进 `AppState.hotswap` 并以 `hotswap-result` 事件发给前端。
//!
//! 事件：
//! - `hotswap-result`：一次有效推送的 [`hotswap::Report`]（`unavailable` 不发，那是常态）；
//! - `hotswap-pending`：手动模式下待推类数变化（载荷是数字）。

use std::path::Path;
use std::sync::Arc;

use serde::Serialize;
use tauri::Emitter;

use crate::hotswap::{self, Batch, Report};
use crate::state::AppState;

/// 编译成功后调用（`build_engine::compile_files`）。不阻塞：推送走一次性后台线程。
///
/// 没有就绪文件时什么都不做，也不攒待推列表：服务没跑（或没挂 agent），
/// 下次启动加载的就是磁盘上的新产物，没什么可推的。
pub(super) fn after_compile(
    app: &tauri::AppHandle,
    st: &Arc<AppState>,
    config_dir: &Path,
    enabled: bool,
    auto: bool,
    batch: Batch,
) {
    if !enabled || batch.is_empty() {
        return;
    }
    let session = hotswap::launch_session_file(config_dir);
    if hotswap::read_ready(&session).is_none() {
        return;
    }
    if !auto {
        let n = match st.hotswap.lock() {
            Ok(mut h) => {
                h.pending.merge(batch);
                h.pending.classes.len()
            }
            Err(_) => return,
        };
        let _ = app.emit("hotswap-pending", n);
        return;
    }
    let app = app.clone();
    let st = st.clone();
    let spawned = std::thread::Builder::new()
        .name("ncforge-hotswap-push".into())
        .spawn(move || {
            let report = hotswap::push(&session, &batch);
            publish(&app, &st, report);
        });
    if let Err(e) = spawned {
        log::warn!("热替换推送线程起不来：{e}");
    }
}

/// 记录并通知前端。`unavailable` 只记调试日志（服务刚停、agent 还没就绪都会走到这里），
/// 例外：服务活着、就绪文件在却送不到 agent 时升级为可见的失败。
fn publish(app: &tauri::AppHandle, st: &AppState, report: Report) {
    let report = if report.state == "unavailable" {
        // 带失败码 = 就绪文件在却送不到。服务还活着时这不是「没在跑」的常态：
        // class 已写盘而 JVM 里是旧的，静默会让人以为换过了（重启后首次保存没推送就是没法查）。
        // 服务已停时就绪文件会留着，照旧静默。
        let alive = st.server.lock().map(|mut s| s.is_alive()).unwrap_or(false);
        if report.code.is_none() || !alive {
            log::debug!("热替换未执行：{}", report.message.as_deref().unwrap_or(""));
            return;
        }
        log::warn!(
            "热替换送不到 agent（{}）：{}",
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
    if let Ok(mut h) = st.hotswap.lock() {
        h.record(report.clone());
    }
    // 同步写进服务日志：翻日志时能对上「这次请求之前换没换过代码」。写失败不影响推送结果。
    let _ = crate::server::append_log(
        &super::server_cmds::log_path(&st.config_dir),
        &report.log_line(),
    );
    let _ = app.emit("hotswap-result", &report);
}

/// 前端状态栏 / 服务页用的热替换状态。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotswapStatus {
    /// 配置开关：启动时挂 agent。
    pub enabled: bool,
    /// 配置开关：编译后自动推送。
    pub auto: bool,
    /// agent 此刻是否可达（ping 通）。
    pub agent_online: bool,
    /// 本次启动带了 agent（还没就绪时 `agent_online` 为 false，靠它区分「准备中」与「没挂」）。
    pub agent_attached: bool,
    /// 运行中的代码不是最新（有推送失败或被遮蔽，重启后清除）。
    pub stale: bool,
    /// 手动模式下待推的类数。
    pub pending: usize,
    /// 待推类名（弹出卡展示用，最多 [`PENDING_NAMES_MAX`] 个）。
    pub pending_classes: Vec<String>,
    pub last: Option<Report>,
    /// 让 `stale` 置位的那次结果（服务页告警条讲的是它，不是最近一次）。
    pub stale_report: Option<Report>,
}

/// 弹出卡最多列这么多个待推类；再多只显示总数。
const PENDING_NAMES_MAX: usize = 50;

/// 查询热替换状态。会 ping 一次 agent（本机回环，毫秒级；连不上最多等 1.5 秒）。
#[tauri::command]
pub async fn hotswap_status(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<HotswapStatus, String> {
    let (enabled, auto) = {
        let cfg = state.config.read().await;
        (cfg.hotswap_enabled, cfg.hotswap_auto)
    };
    let session = hotswap::launch_session_file(&state.config_dir);
    let agent_online = tauri::async_runtime::spawn_blocking(move || hotswap::ping(&session))
        .await
        .unwrap_or(false);
    let h = state
        .hotswap
        .lock()
        .map_err(|_| "热替换状态异常".to_string())?;
    Ok(HotswapStatus {
        enabled,
        auto,
        agent_online,
        agent_attached: h.attached || agent_online,
        stale: h.stale,
        pending: h.pending.classes.len(),
        pending_classes: h
            .pending
            .classes
            .iter()
            .take(PENDING_NAMES_MAX)
            .map(|c| c.name.clone())
            .collect(),
        last: h.last.clone(),
        stale_report: h.stale_report.clone(),
    })
}

/// 手动模式：丢掉攒着的待推类（磁盘上的产物不动，下次重启照样加载新代码）。
#[tauri::command]
pub async fn hotswap_clear_pending(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    state
        .hotswap
        .lock()
        .map_err(|_| "热替换状态异常".to_string())?
        .pending = Batch::default();
    let _ = app.emit("hotswap-pending", 0usize);
    Ok(())
}

/// 手动模式：把攒着的类一次推给运行中的服务。
///
/// 待推列表先取出再推：推送期间编译出的新类进入下一批，不会被这次的结果吞掉。
/// 服务已停（`unavailable`）时不把批次放回去：下次启动会加载磁盘上的最新产物。
#[tauri::command]
pub async fn hotswap_push_pending(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Report, String> {
    let batch = {
        let mut h = state
            .hotswap
            .lock()
            .map_err(|_| "热替换状态异常".to_string())?;
        std::mem::take(&mut h.pending)
    };
    if batch.is_empty() {
        return Err("没有待热替换的类".to_string());
    }
    let session = hotswap::launch_session_file(&state.config_dir);
    let report = tauri::async_runtime::spawn_blocking(move || hotswap::push(&session, &batch))
        .await
        .map_err(|e| format!("后台任务失败: {e}"))?;
    publish(&app, state.inner(), report.clone());
    let _ = app.emit("hotswap-pending", 0usize);
    Ok(report)
}
