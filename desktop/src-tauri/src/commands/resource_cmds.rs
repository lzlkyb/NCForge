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
///
/// **`async` + `spawn_blocking`**：非 async 的 Tauri 命令跑在主线程，而这里要读状态
/// JSON、再检查每个包的关键文件。冷启动时那几毫秒正是窗口刚出来的时候，
/// 走主线程就是肉眼可见的一下卡顿（同文件 `ensure_resources_async` 已是这个范式）。
#[tauri::command]
pub async fn resources_status(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<PackStatus>, String> {
    let config_dir = state.config_dir.clone();
    let legacy_dir = app.path().resource_dir().ok();
    tauri::async_runtime::spawn_blocking(move || {
        read_pack_statuses(&config_dir, legacy_dir.as_deref())
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))
}

fn read_pack_statuses(
    config_dir: &std::path::Path,
    legacy_dir: Option<&std::path::Path>,
) -> Vec<PackStatus> {
    let packs_state = resource_pack::PacksState::load(config_dir);
    resource_pack::ALL_PACKS
        .iter()
        .map(|m| {
            let rec = packs_state.packs.get(m.id);
            let (st, version, size) = match rec {
                Some(r)
                    if !r.legacy
                        && resource_pack::pack_probe_ok(
                            &resource_pack::pack_dir(config_dir, m.id, &r.version),
                            m.id,
                        ) =>
                {
                    ("installed".to_string(), Some(r.version.clone()), r.size)
                }
                _ if legacy_dir.is_some_and(|dir| resource_pack::legacy_present(dir, m.id)) => {
                    // 启动不再主动认领旧资源；只读快照也要与 finder 的物理回退一致。
                    (
                        "legacy".to_string(),
                        None,
                        rec.filter(|r| r.legacy).and_then(|r| r.size),
                    )
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
/// 拆成普通函数 + 薄命令两层，集成测试能直接驱动同一条置备链路。
/// 泛型 `R: Runtime`：命令路径是 Wry（`AppHandle` 即 `AppHandle<Wry>`），
/// 集成测试用 `AppHandle<MockRuntime>`。体内只用到与 Runtime 无关的
/// `Manager`/`Emitter` 方法与 `async_runtime::spawn`，泛型化无副作用。
pub fn ensure_resources_async<R: tauri::Runtime>(app: tauri::AppHandle<R>, force: bool) {
    if let Err(error) = ensure_selected_resources_async(app, force, None) {
        log::warn!("资源置备未启动：{error}");
    }
}

/// 手动请求只置备选中的组件，入口错误同步返回，避免界面永久等待未启动的任务。
pub fn ensure_selected_resources_async<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    force: bool,
    ids: Option<Vec<String>>,
) -> Result<(), String> {
    if let Some(ids) = &ids {
        resource_pack::validate_pack_selection(ids)?;
    }
    static RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    let guard = SingleFlight::acquire(&RUNNING)
        .ok_or("已有组件下载正在进行，请查看下载面板并等待当前任务结束")?;
    // config_dir 从托管状态取。命令在 app.manage 之后调用，正常一定有；
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
        return Err("应用状态尚未就绪，请稍后重试".to_string());
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
            PackEvent::Verifying { id } => {
                emit("resource:verifying", serde_json::json!({ "id": id }))
            }
            PackEvent::Installing { id } => {
                emit("resource:installing", serde_json::json!({ "id": id }))
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

        let result = resource_pack::ensure_selected_packs(
            &config_dir,
            legacy_dir.as_deref(),
            force,
            ids.as_deref(),
            on_event,
        )
        .await;
        // 终态事件的监听者可能立即发起下一次下载，先释放闸再通知完成。
        drop(_guard);
        match result {
            Ok(outcome) => {
                emit(
                    "resource:ready",
                    serde_json::json!({
                        "installed": outcome.installed.iter().map(|(id, v)| serde_json::json!({"id": id, "version": v})).collect::<Vec<_>>(),
                        "adoptedLegacy": !outcome.adopted_legacy.is_empty(),
                        "adoptedLegacyIds": outcome.adopted_legacy,
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
    Ok(())
}

/// IPC 包装（前端 invoke 用）。
#[tauri::command]
pub fn resources_ensure(
    app: tauri::AppHandle,
    force: Option<bool>,
    ids: Option<Vec<String>>,
) -> Result<(), String> {
    ensure_selected_resources_async(app, force.unwrap_or(false), ids)
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
    fn single_flight_rejects_overlap_and_releases_on_drop() {
        static FLAG: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
        let guard = SingleFlight::acquire(&FLAG).expect("首个任务应获取单飞闸");
        assert!(SingleFlight::acquire(&FLAG).is_none());
        drop(guard);
        assert!(SingleFlight::acquire(&FLAG).is_some());
    }

    #[test]
    fn status_recognizes_bundled_resources_without_adoption_record() {
        let temp = tempfile::tempdir().unwrap();
        let config_dir = temp.path().join("config");
        let legacy_dir = temp.path().join("legacy");
        let ecj_dir = legacy_dir.join(resource_pack::PACK_ECJ);
        std::fs::create_dir_all(&ecj_dir).unwrap();
        std::fs::write(ecj_dir.join("ecj-3.17.jar"), b"x").unwrap();
        let status = read_pack_statuses(&config_dir, Some(&legacy_dir));
        let ecj = status
            .iter()
            .find(|pack| pack.id == resource_pack::PACK_ECJ)
            .unwrap();
        assert_eq!(ecj.state, "legacy");
        assert!(ecj.version.is_none());
        assert!(ecj.size.is_none());
        assert!(resource_pack::PacksState::load(&config_dir)
            .packs
            .is_empty());
    }

    #[test]
    fn status_rechecks_legacy_and_installed_key_files() {
        let config_dir =
            std::env::temp_dir().join(format!("ncforge-resource-status-{}", std::process::id()));
        let legacy_dir = config_dir.join("legacy");
        std::fs::create_dir_all(&config_dir).unwrap();
        let mut state = resource_pack::PacksState::default();
        state.packs.insert(
            resource_pack::PACK_ECJ.to_string(),
            resource_pack::InstalledPack {
                version: String::new(),
                legacy: true,
                size: Some(1),
            },
        );
        state.packs.insert(
            resource_pack::PACK_CFR.to_string(),
            resource_pack::InstalledPack {
                version: "v1".to_string(),
                legacy: false,
                size: Some(1),
            },
        );
        state.save(&config_dir).unwrap();
        let cfr_dir = resource_pack::pack_dir(&config_dir, resource_pack::PACK_CFR, "v1");
        std::fs::create_dir_all(&cfr_dir).unwrap();
        let status = |id: &str| {
            read_pack_statuses(&config_dir, Some(&legacy_dir))
                .into_iter()
                .find(|pack| pack.id == id)
                .unwrap()
        };
        assert_eq!(status(resource_pack::PACK_ECJ).state, "missing");
        assert_eq!(status(resource_pack::PACK_CFR).state, "missing");
        let ecj_dir = legacy_dir.join(resource_pack::PACK_ECJ);
        std::fs::create_dir_all(&ecj_dir).unwrap();
        std::fs::write(ecj_dir.join("ecj-3.17.jar"), b"x").unwrap();
        std::fs::write(cfr_dir.join("cfr-0.152.jar"), b"x").unwrap();
        assert_eq!(status(resource_pack::PACK_ECJ).state, "legacy");
        assert_eq!(status(resource_pack::PACK_CFR).state, "installed");
        std::fs::remove_file(ecj_dir.join("ecj-3.17.jar")).unwrap();
        std::fs::remove_file(cfr_dir.join("cfr-0.152.jar")).unwrap();
        assert_eq!(status(resource_pack::PACK_ECJ).state, "missing");
        assert_eq!(status(resource_pack::PACK_CFR).state, "missing");
        std::fs::remove_dir_all(config_dir).ok();
    }

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
