//! 资源包 IPC 命令层（`resources_status` / `resources_ensure`）。
//!
//! 与 `commands/update.rs` 同款结构：命令 spawn 后立即返回，状态经 `resource:*`
//! 事件推给前端；单飞闸防连点双任务。实现在 crate 根的 `resource_pack.rs`
//! （纯逻辑、无 tauri 依赖、可单测），本文件只做「AppHandle → config_dir /
//! legacy 目录」的胶水与事件转发。

use tauri::{Emitter, Manager, State};

use crate::resource_pack::{self, PackEvent};
use crate::state::AppState;
use std::sync::Arc;

/// 单飞闸：同一时刻只允许一个 ensure 任务在跑（status 是纯读，不需要闸）。
/// RAII 式持有：任务（含所有提前 return 分支）结束自动释放。
struct SingleFlight(&'static std::sync::atomic::AtomicBool);

impl SingleFlight {
    fn acquire(flag: &'static std::sync::atomic::AtomicBool) -> Option<Self> {
        flag.compare_exchange(
            false,
            true,
            std::sync::atomic::Ordering::SeqCst,
            std::sync::atomic::Ordering::SeqCst,
        )
        .ok()
        .map(|_| Self(flag))
    }
}

impl Drop for SingleFlight {
    fn drop(&mut self) {
        self.0.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// 前端展示用的一个包状态（resources_status 的返回）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackStatus {
    pub id: String,
    pub title: String,
    pub notes: String,
    /// installed = 外部已安装（可用）；legacy = 旧安装包认领；missing = 缺失
    pub state: String,
    /// 已安装版本（内容寻址串）；legacy/missing 为 null
    pub version: Option<String>,
    /// 本地记录的实际字节数（下载成功 = 实收总长；legacy = 旧目录实测）；
    /// 老状态文件没记过大小、或包缺失时为 null
    pub size: Option<u64>,
}

/// 本地状态快照（不联网）。前端挂载时调一次，之后靠事件驱动。
/// `_app` 占位：命令签名保持 (app, state) 与其它命令一致，本实现只用 state。
#[tauri::command]
pub fn resources_status(
    _app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Vec<PackStatus> {
    let config_dir = state.config_dir.clone();
    let packs_state = resource_pack::PacksState::load(&config_dir);
    resource_pack::ALL_PACKS
        .iter()
        .map(|m| {
            let rec = packs_state.packs.get(m.id);
            let (st, version, size) = match rec {
                Some(r) if r.legacy => ("legacy".to_string(), None, r.size),
                Some(r) if resource_pack::pack_dir(&config_dir, m.id, &r.version).is_dir() => {
                    ("installed".to_string(), Some(r.version.clone()), r.size)
                }
                _ => ("missing".to_string(), None, None),
            };
            PackStatus {
                id: m.id.to_string(),
                title: m.title.to_string(),
                notes: m.notes.to_string(),
                state: st,
                version,
                size,
            }
        })
        .collect()
}

/// 置备资源包：拉清单 → 缺的下载安装。进度经 `resource:*` 事件推送。
///
/// `force`：设置页「重新下载组件」用——无视已有状态（含 legacy 认领）强制重下。
///
/// 拆成普通函数 + 薄命令两层：main.rs 的启动自检也要调它，而 `#[tauri::command]`
/// 的 `State<>` 参数只能在 invoke 路径里注入，启动路径够不着。
///
/// 泛型 `R: Runtime`：启动/命令路径是 Wry（`AppHandle` 即 `AppHandle<Wry>`），
/// 集成测试用 `AppHandle<MockRuntime>`。体内只用到与 Runtime 无关的
/// `Manager`/`Emitter` 方法与 `async_runtime::spawn`，泛型化无副作用。
pub fn ensure_resources_async<R: tauri::Runtime>(app: tauri::AppHandle<R>, force: bool) {
    static RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    let Some(guard) = SingleFlight::acquire(&RUNNING) else {
        log::info!("资源置备任务已在进行，忽略重复触发");
        return;
    };
    // dev 构建默认不自动置备（2026-10-29 审查 M1）：debug 构建跑启动自检会让首次
    // `tauri dev` 真下载 63MB 且必须联网，而开发期资源走源码树
    // （`npm run jdtls:fetch` 手动拉，finder 回退）更顺手。放行条件两个：
    // force（设置页「重新下载组件」，开发者主动要下）或设了
    // APP_RESOURCES_ENDPOINT（联调真实下载流程 / 集成测试的本地假源）。
    // 跳过时必须回发 uptodate：前端启动自检在等事件收尾，不发会卡在 checking。
    #[cfg(debug_assertions)]
    let dev_auto_skip =
        !force && std::env::var("APP_RESOURCES_ENDPOINT").map_or(true, |v| v.trim().is_empty());
    #[cfg(not(debug_assertions))]
    let dev_auto_skip = false;
    if dev_auto_skip {
        log::info!(
            "[Resource] dev 构建跳过启动自检（设 APP_RESOURCES_ENDPOINT 或手动重新下载可启用）"
        );
        let _ = app.emit("resource:uptodate", serde_json::json!({}));
        return;
    }
    // config_dir 从托管状态取。启动自检在 app.manage 之后调用，正常一定有；
    // 取不到（理论上只有单测里手动构造时）就明说，不静默失败。
    let Some(config_dir) = app
        .try_state::<Arc<AppState>>()
        .map(|s| s.config_dir.clone())
    else {
        log::error!("资源置备：AppState 尚未注入，放弃");
        let _ = app.emit(
            "resource:error",
            serde_json::json!({ "message": "应用状态尚未就绪，请稍后重试", "code": "config" }),
        );
        return;
    };
    // 旧安装包资源目录（认领用）。取不到不阻断：只是少了认领这条捷径，
    // 按缺失走下载。
    let legacy_dir = app.path().resource_dir().ok();

    tauri::async_runtime::spawn(async move {
        let _guard = guard;
        let emit = |name: &str, payload: serde_json::Value| {
            let _ = app.emit(name, payload);
        };
        let on_event = |ev: PackEvent| match ev {
            PackEvent::Checking => emit("resource:checking", serde_json::json!({})),
            PackEvent::Missing(packs) => emit(
                "resource:available",
                serde_json::json!({
                    "packs": packs.iter().map(|p| serde_json::json!({
                        "id": p.id, "title": p.title, "notes": p.notes, "size": p.size,
                    })).collect::<Vec<_>>(),
                    "totalBytes": packs.iter().map(|p| p.size).sum::<u64>(),
                }),
            ),
            PackEvent::Uptodate => emit("resource:uptodate", serde_json::json!({})),
            PackEvent::Downloading { id } => {
                emit("resource:downloading", serde_json::json!({ "id": id }))
            }
            PackEvent::Progress {
                id,
                downloaded,
                total,
                bytes_per_sec,
            } => emit(
                "resource:progress",
                serde_json::json!({
                    "id": id, "downloaded": downloaded, "total": total, "bytesPerSec": bytes_per_sec,
                }),
            ),
            PackEvent::Installed { id, version } => emit(
                "resource:installed",
                serde_json::json!({ "id": id, "version": version }),
            ),
        };

        match resource_pack::ensure_packs(&config_dir, legacy_dir.as_deref(), force, on_event).await
        {
            Ok(outcome) => {
                emit(
                    "resource:ready",
                    serde_json::json!({
                        "installed": outcome.installed.iter().map(|(id, v)| serde_json::json!({"id": id, "version": v})).collect::<Vec<_>>(),
                        "adoptedLegacy": outcome.adopted_legacy,
                    }),
                );
            }
            Err(failure) => {
                log::warn!("[Resource] 置备失败: {}", failure.message);
                // 带上已完成部分：前端错误区显示「N/3 已就绪」——已装好的包在
                // state 里，用户重试会自动跳过，别说成「全部失败」。
                emit(
                    "resource:error",
                    serde_json::json!({
                        "message": failure.message,
                        "code": classify(&failure.message),
                        "installed": failure.outcome.installed.iter().map(|(id, v)| serde_json::json!({"id": id, "version": v})).collect::<Vec<_>>(),
                        "adoptedLegacy": failure.outcome.adopted_legacy,
                    }),
                );
            }
        }
    });
}

/// IPC 包装（前端 invoke 用）。
#[tauri::command]
pub fn resources_ensure(app: tauri::AppHandle, force: Option<bool>) {
    ensure_resources_async(app, force.unwrap_or(false));
}

/// 错误分类（与 update.rs 的 classify_update_error 同款思路：机器可读码，
/// 前端只负责措辞）。资源链路的错误面比更新链路小，砍掉签名/安装两类。
fn classify(msg: &str) -> &'static str {
    let lower = msg.to_lowercase();
    if lower.contains("sha-256") || lower.contains("不完整") {
        // 包被篡改或下载损坏——与「网络不好」必须区分
        "signature"
    } else if lower.contains("zip-slip")
        || lower.contains("路径不合法")
        || lower.contains("内容不完整")
    {
        // 包本身有问题（或源被投毒）
        "corrupt"
    } else if lower.contains("停滞") || lower.contains("超时") || lower.contains("timeout") {
        "timeout"
    } else if lower.contains("http 4") || lower.contains("解析失败") || lower.contains("url 不合法")
    {
        // 源内容确定性坏：换个源也一样，重试无意义
        "manifest"
    } else if lower.contains("必须是 https")
        || lower.contains("endpoints 为空")
        || lower.contains("协议不支持")
    {
        "config"
    } else if lower.contains("全部资源源均失败")
        || lower.contains("连接")
        || lower.contains("下载失败")
    {
        "network"
    } else {
        "unknown"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_separates_integrity_from_network() {
        assert_eq!(classify("SHA-256 校验失败（期望 a，实得 b）"), "signature");
        assert_eq!(
            classify("下载不完整（声明 100 字节，实收 50 字节）"),
            "signature"
        );
        assert_eq!(
            classify("拒绝解压：第 3 个条目的路径不合法（含 ../ 或绝对路径，疑似 zip-slip）"),
            "corrupt"
        );
        assert_eq!(
            classify("下载停滞超过 60 秒，已中断（可重试或换源）"),
            "timeout"
        );
        assert_eq!(classify("资源清单返回 HTTP 404"), "manifest");
        assert_eq!(classify("resources.json 解析失败: xxx"), "manifest");
        assert_eq!(
            classify("资源源必须是 https（http://evil.com/x）；http 仅允许本机联调"),
            "config"
        );
        assert_eq!(
            classify("全部资源源均失败（已依次尝试）: 下载 ecj 失败: connection reset"),
            "network"
        );
        assert_eq!(classify("某个没见过的错误"), "unknown");
    }
}
