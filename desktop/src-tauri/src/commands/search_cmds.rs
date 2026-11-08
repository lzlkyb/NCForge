//! 搜索命令：把 `search::search` 包成 IPC 命令。
//!
//! 路径解析、工作区白名单、阻塞线程的范式都沿用 `workspace_cmds`：
//! 这里只取当前工作区根（搜索天然覆盖整个工作区，不需要单文件路径参数），
//! 然后把纯逻辑丢进 spawn_blocking，避免一次全量扫盘卡住 async 运行时。

use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, OnceLock};
use std::time::Instant;

use serde::Serialize;

use crate::search::{self, ReplaceOutcome, SearchGate, SearchOptions, SearchOutcome};
use crate::state::AppState;

#[derive(serde::Deserialize)]
pub struct OverlayRef {
    path: String,
    key: String,
}
fn resolve_overlay(
    root: &Path,
    options: &mut SearchOptions,
    refs: Option<Vec<OverlayRef>>,
) -> Result<(), String> {
    use std::collections::BTreeMap;
    use std::sync::Mutex;
    static CACHE: OnceLock<Mutex<BTreeMap<(PathBuf, String), String>>> = OnceLock::new();
    let mut cache = CACHE
        .get_or_init(|| Mutex::new(BTreeMap::new()))
        .lock()
        .map_err(|_| "overlay cache lock")?;
    let refs = refs.unwrap_or_default();
    // Resolve into request-owned strings while locked: later edits cannot alter an in-flight search.
    for reference in refs {
        let key = (root.to_path_buf(), reference.key);
        if let Some(doc) = options
            .overlay
            .iter()
            .find(|doc| doc.path == reference.path)
        {
            cache.insert(key, doc.text.clone());
        } else {
            let text = cache.get(&key).ok_or("OVERLAY_CACHE_MISS")?.clone();
            options.overlay.push(search::OverlayDoc {
                path: reference.path,
                text,
            });
        }
    }
    let mut bytes: usize = cache.values().map(|text| text.len()).sum();
    while bytes > 16 * 1024 * 1024 {
        let Some(key) = cache.keys().next().cloned() else {
            break;
        };
        if let Some(text) = cache.remove(&key) {
            bytes -= text.len();
        }
    }
    Ok(())
}

/// 同时运行的全量扫描上限。单次扫描已经 8 线程，2 个足够让「搜索页 + 快速面板」
/// 互不阻塞，又不至于几个积压的旧搜索一起抢磁盘。
const SCAN_SLOTS: usize = 2;

fn gate() -> &'static SearchGate {
    static GATE: OnceLock<SearchGate> = OnceLock::new();
    GATE.get_or_init(|| SearchGate::new(SCAN_SLOTS))
}

/// 取消某个来源正在跑的搜索（快速面板关闭时调用）。没有在跑的就什么也不做。
#[tauri::command]
pub fn search_cancel(source: String) {
    gate().cancel(&source);
}

/// 「全部工程搜索」的总预算：工程一多，逐个 20 秒会变成几分钟。
/// 单个工程仍按 20 秒封顶，剩余预算不够就按剩下的跑，跑完再标记截断。
const MULTI_PROJECT_BUDGET_MS: u128 = 60_000;
const PER_PROJECT_BUDGET_MS: u128 = 20_000;

/// `source`：调用方标识（如 `palette`）。同来源的新搜索会取消旧的；不传则互不影响。
#[tauri::command]
pub async fn search_workspace(
    state: tauri::State<'_, Arc<AppState>>,
    mut options: SearchOptions,
    overlay_refs: Option<Vec<OverlayRef>>,
    source: Option<String>,
) -> Result<SearchOutcome, String> {
    let request = gate().register(source.as_deref());
    let root = state
        .config
        .read()
        .await
        .workspace_root
        .clone()
        .ok_or_else(|| "尚未选择工作区目录".to_string())?;
    let root = PathBuf::from(root);
    resolve_overlay(&root, &mut options, overlay_refs)?;
    // 没有包就在这里排一次后台建包：本次搜索仍走磁盘，下一次开始走包。
    // 放在命令入口而不是 `search` 模块里——建包要 config_dir，纯逻辑模块不碰配置。
    // 主工作区要登记成 primary：文件监听只重建它，依赖工程的包各自排队。
    crate::content_pack::ensure_primary(&root, &state.config_dir);
    tauri::async_runtime::spawn_blocking(move || {
        request.run(|cancel| {
            search::search_cancellable(&root, &options, search::TIME_BUDGET_MS, cancel)
        })
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 流式搜索：每扫到一批就推一次事件，边扫边出结果。
///
/// 快速面板的 `#内容` 用它：以前是「点完等到扫完才一次性返回」，newar 上要 1~3 秒，
/// 面板上只有一行「查询中…」。现在第一批命中几十毫秒就到，用户能看到列表在长。
///
/// `stream` 是调用方生成的标识：前端拿它把事件分给对应的那次查询（连续敲键会有
/// 多个搜索在飞，旧的被 `source` 取消）。最终结果仍由命令返回值给出，事件只是预览。
#[tauri::command]
pub async fn search_workspace_stream(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    mut options: SearchOptions,
    overlay_refs: Option<Vec<OverlayRef>>,
    source: Option<String>,
    stream: String,
) -> Result<SearchOutcome, String> {
    use tauri::Emitter;
    let request = gate().register(source.as_deref());
    let root = state
        .config
        .read()
        .await
        .workspace_root
        .clone()
        .ok_or_else(|| "尚未选择工作区目录".to_string())?;
    let root = PathBuf::from(root);
    resolve_overlay(&root, &mut options, overlay_refs)?;
    crate::content_pack::ensure_primary(&root, &state.config_dir);
    tauri::async_runtime::spawn_blocking(move || {
        request.run(|cancel| {
            search::search_stream(&root, &options, search::TIME_BUDGET_MS, cancel, &|batch| {
                let _ = app.emit(
                    "search:batch",
                    serde_json::json!({ "stream": stream, "hits": batch }),
                );
            })
        })
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 在工作区内替换全部命中。范围与 `search_workspace` 完全一致（同一套候选收集）。
///
/// 为什么不让前端逐个文件改：编码与换行必须按原文件还原（NC 工程 GBK/UTF-8 混放、
/// 还有混合换行的老文件），这些逻辑后端已经有一份且被单测覆盖；前端再来一份必然分叉。
#[tauri::command]
pub async fn search_replace(
    state: tauri::State<'_, Arc<AppState>>,
    options: SearchOptions,
    replacement: String,
) -> Result<ReplaceOutcome, String> {
    let root = state
        .config
        .read()
        .await
        .workspace_root
        .clone()
        .ok_or_else(|| "尚未选择工作区目录".to_string())?;
    let root = PathBuf::from(root);
    tauri::async_runtime::spawn_blocking(move || search::replace(&root, &options, &replacement))
        .await
        .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 工作区文件清单（「转到文件」用）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileList {
    /// 相对工作区根、`/` 分隔。
    pub files: Vec<String>,
    pub truncated: bool,
}

#[tauri::command]
pub async fn search_list_files(state: tauri::State<'_, Arc<AppState>>) -> Result<FileList, String> {
    let root = state
        .config
        .read()
        .await
        .workspace_root
        .clone()
        .ok_or_else(|| "尚未选择工作区目录".to_string())?;
    let root = PathBuf::from(root);
    let cache_dir = state.config_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // 带缓存：面板打开时立即出结果，全树扫描只在缓存全空或后台校准时发生
        let (files, truncated) = search::list_files_cached(&root, &cache_dir);
        FileList { files, truncated }
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))
}

/// 丢掉文件清单缓存（文件树里新建 / 改名 / 删除后调用）。
///
/// 只清进程内那份：磁盘缓存会由下一次取清单的后台校准覆盖，不值得在这里同步写盘。
#[tauri::command]
pub fn search_invalidate_files() {
    search::invalidate_list_cache();
}

/// 搜索内容包的状态（状态栏 / 排查用）。
///
/// `ready == false && building == true` 表示首次建包还在跑，此时搜索走磁盘完整扫描。
#[tauri::command]
pub fn search_pack_status(
    state: tauri::State<'_, Arc<AppState>>,
) -> crate::content_pack::PackStatus {
    crate::content_pack::set_cache_dir(&state.config_dir);
    crate::content_pack::status()
}

/// 启动预热内容包：磁盘上有包就加载，没有就排一次后台建包。
///
/// 不阻塞窗口显示：`ensure` 只加载索引 + 排任务，真正的建包在 `content_pack` 的
/// 后台线程里做（首次两分钟左右，期间搜索走磁盘路径）。
pub fn spawn_prewarm_search_pack(state: Arc<AppState>) {
    tauri::async_runtime::spawn(async move {
        let root = {
            let cfg = state.config.read().await;
            cfg.workspace_root.clone()
        };
        let Some(root) = root else { return };
        let cache = state.config_dir.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            let _budget = crate::prewarm_budget::acquire();
            // A queued warmup must not build an obsolete workspace after a switch.
            if state.config.blocking_read().workspace_root.as_deref() != Some(root.as_str()) {
                return;
            }
            crate::content_pack::ensure_primary(&PathBuf::from(root), &cache);
        })
        .await;
    });
}

/// 一个工程的搜索结果。`path` 仍是相对该工程根的路径，打开时要配上 `root`。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSearch {
    pub project: String,
    pub root: String,
    pub outcome: SearchOutcome,
}

/// 全部关联工程的一次搜索：按工程分组返回，附上没搜成的工程原因。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectsSearchOutcome {
    pub projects: Vec<ProjectSearch>,
    /// 某个工程读盘失败（权限、盘符掉线）不会让整次搜索失败，列在这里。
    pub errors: Vec<String>,
    pub truncated: bool,
    pub elapsed_ms: u64,
    /// 被同来源的新搜索或显式取消打断；此时结果不完整。
    pub cancelled: bool,
}

/// 搜索依赖闭包里的全部工程（默认范围）。
///
/// 逐个工程跑同一套 `search_with_budget`：并行读多个工程会把机械盘打满，
/// 而且结果顺序不稳定；串行的代价由总预算兜住。工程根仍由后端从 `.classpath`
/// 解析，前端不能传任意路径进来。
///
/// 不接受 `dirs`（按组件范围）：manifest 的组件只属于**当前工作区**，把它套到
/// 依赖工程上会得到「每个工程都少搜一堆文件」的静默错范围。宁可明确拒绝。
#[tauri::command]
pub async fn search_projects(
    state: tauri::State<'_, Arc<AppState>>,
    options: SearchOptions,
    source: Option<String>,
) -> Result<ProjectsSearchOutcome, String> {
    let request = gate().register(source.as_deref());
    if !options.dirs.is_empty() {
        return Err("按组件搜索只支持当前工作区，请把范围切到「当前工程」或「组件」".to_string());
    }
    let cfg = state.config.read().await.clone();
    let primary = cfg
        .workspace_root
        .clone()
        .ok_or_else(|| "尚未选择工作区目录".to_string())?;
    let primary_path = PathBuf::from(&primary);
    if !primary_path.is_dir() {
        return Err(format!("工作区目录不存在：{primary}"));
    }
    // 每个工程根都有自己的包：`ensure` 把没建好的排进串行队列，本次仍走磁盘。
    // 只在命令入口登记 primary，队列里的都是依赖工程，不会同时开几次全量读盘。
    crate::content_pack::ensure_primary(&primary_path, &state.config_dir);
    let overrides = crate::eclipse_cp::active_overrides(&cfg.linked_overrides);
    let cache = state.config_dir.clone();

    tauri::async_runtime::spawn_blocking(move || {
        request.run(|cancel| {
            let mut roots: Vec<(String, String)> = Vec::new();
            for p in crate::eclipse_cp::projects(&primary_path, &overrides) {
                let Some(root) = p.root else { continue };
                if !Path::new(&root).is_dir() {
                    continue;
                }
                if roots.iter().any(|(_, r)| r.eq_ignore_ascii_case(&root)) {
                    continue;
                }
                roots.push((p.name, root));
            }
            // 覆盖表解析异常时至少还要能搜当前工作区
            if !roots.iter().any(|(_, r)| r.eq_ignore_ascii_case(&primary)) {
                let name = primary_path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| primary.clone());
                roots.insert(0, (name, primary.clone()));
            }

            // 给每个工程排队：第一次「全部工程」搜索付一次建包成本，之后都是毫秒级。
            // 放循环前，搜索过程中不再改队列状态。
            for (_, root) in &roots {
                crate::content_pack::ensure(Path::new(root), &cache);
            }

            let started = Instant::now();
            let mut projects = Vec::new();
            let mut errors = Vec::new();
            let mut truncated = false;
            for (project, root) in roots {
                if cancel.load(Ordering::Relaxed) {
                    truncated = true;
                    break;
                }
                let used = started.elapsed().as_millis();
                if used >= MULTI_PROJECT_BUDGET_MS {
                    truncated = true;
                    break;
                }
                let budget = PER_PROJECT_BUDGET_MS.min(MULTI_PROJECT_BUDGET_MS - used);
                match search::search_cancellable(Path::new(&root), &options, budget, cancel) {
                    Ok(outcome) => {
                        truncated |= outcome.truncated;
                        projects.push(ProjectSearch {
                            project,
                            root,
                            outcome,
                        });
                    }
                    Err(e) => errors.push(format!("{project}: {e}")),
                }
            }
            ProjectsSearchOutcome {
                projects,
                errors,
                truncated,
                elapsed_ms: started.elapsed().as_millis() as u64,
                cancelled: cancel.load(Ordering::Relaxed),
            }
        })
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))
}

#[cfg(test)]
mod overlay_cache_tests {
    use super::*;
    #[test]
    fn references_resolve_to_independent_request_snapshots() {
        let root = Path::new("overlay-cache-test");
        let mut initial = SearchOptions::default();
        initial.overlay.push(search::OverlayDoc {
            path: "A.java".into(),
            text: "old".into(),
        });
        let reference = || {
            Some(vec![OverlayRef {
                path: "A.java".into(),
                key: "v1".into(),
            }])
        };
        resolve_overlay(root, &mut initial, reference()).unwrap();
        let mut next = SearchOptions::default();
        resolve_overlay(root, &mut next, reference()).unwrap();
        assert_eq!(next.overlay[0].text, "old");
        initial.overlay[0].text = "new".into();
        assert_eq!(next.overlay[0].text, "old");
        let missing = Some(vec![OverlayRef {
            path: "A.java".into(),
            key: "missing".into(),
        }]);
        assert_eq!(
            resolve_overlay(root, &mut SearchOptions::default(), missing).unwrap_err(),
            "OVERLAY_CACHE_MISS"
        );
    }
}
