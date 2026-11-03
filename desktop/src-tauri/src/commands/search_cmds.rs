//! 搜索命令：把 `search::search` 包成 IPC 命令。
//!
//! 路径解析、工作区白名单、阻塞线程的范式都沿用 `workspace_cmds`：
//! 这里只取当前工作区根（搜索天然覆盖整个工作区，不需要单文件路径参数），
//! 然后把纯逻辑丢进 spawn_blocking，避免一次全量扫盘卡住 async 运行时。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use serde::Serialize;

use crate::search::{self, ReplaceOutcome, SearchOptions, SearchOutcome};
use crate::state::AppState;

/// 「全部工程搜索」的总预算：工程一多，逐个 20 秒会变成几分钟。
/// 单个工程仍按 20 秒封顶，剩余预算不够就按剩下的跑，跑完再标记截断。
const MULTI_PROJECT_BUDGET_MS: u128 = 60_000;
const PER_PROJECT_BUDGET_MS: u128 = 20_000;

#[tauri::command]
pub async fn search_workspace(
    state: tauri::State<'_, Arc<AppState>>,
    options: SearchOptions,
) -> Result<SearchOutcome, String> {
    let root = state
        .config
        .read()
        .await
        .workspace_root
        .clone()
        .ok_or_else(|| "尚未选择工作区目录".to_string())?;
    let root = PathBuf::from(root);
    tauri::async_runtime::spawn_blocking(move || search::search(&root, &options))
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
    tauri::async_runtime::spawn_blocking(move || {
        let (files, truncated) = search::list_files(&root);
        FileList { files, truncated }
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))
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
}

/// 搜索依赖闭包里的全部工程（默认范围）。
///
/// 逐个工程跑同一套 `search_with_budget`：并行读多个工程会把机械盘打满，
/// 而且结果顺序不稳定；串行的代价由总预算兜住。工程根仍由后端从 `.classpath`
/// 解析，前端不能传任意路径进来。
#[tauri::command]
pub async fn search_projects(
    state: tauri::State<'_, Arc<AppState>>,
    options: SearchOptions,
) -> Result<ProjectsSearchOutcome, String> {
    let cfg = state.config.read().await.clone();
    let primary = cfg
        .workspace_root
        .clone()
        .ok_or_else(|| "尚未选择工作区目录".to_string())?;
    let primary_path = PathBuf::from(&primary);
    if !primary_path.is_dir() {
        return Err(format!("工作区目录不存在：{primary}"));
    }
    let overrides = crate::eclipse_cp::active_overrides(&cfg.linked_overrides);

    tauri::async_runtime::spawn_blocking(move || {
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

        let started = Instant::now();
        let mut projects = Vec::new();
        let mut errors = Vec::new();
        let mut truncated = false;
        for (project, root) in roots {
            let used = started.elapsed().as_millis();
            if used >= MULTI_PROJECT_BUDGET_MS {
                truncated = true;
                break;
            }
            let budget = PER_PROJECT_BUDGET_MS.min(MULTI_PROJECT_BUDGET_MS - used);
            match search::search_with_budget(Path::new(&root), &options, budget) {
                Ok(outcome) => {
                    truncated |= outcome.truncated;
                    projects.push(ProjectSearch { project, root, outcome });
                }
                Err(e) => errors.push(format!("{project}: {e}")),
            }
        }
        ProjectsSearchOutcome {
            projects,
            errors,
            truncated,
            elapsed_ms: started.elapsed().as_millis() as u64,
        }
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))
}
