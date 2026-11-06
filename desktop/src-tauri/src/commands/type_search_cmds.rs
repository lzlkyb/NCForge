//! 类型搜索（快速面板「类」模式）：工作区源码走本地索引，依赖 jar 复用全库类名目录。
//!
//! 以前只有 `workspace/symbol` 一条路，第一次搜类要等 jdt.ls 建完索引。现在工作区命中
//! 是纯磁盘扫描（毫秒级），jar 段从 `TypeCatalog` 取；两条都不依赖语言服务的就绪状态。
//! jdt.ls 仍由前端在「后端没给出任何结果」时兜底。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use serde::Serialize;

use super::compile_cmds::{lookup_index, workspace_roots};
use crate::java_types::TypeCatalog;
use crate::nc_home;
use crate::nc_index::ClassIndex;
use crate::state::AppState;
use crate::workspace_types::TypeHit;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeSearchOut {
    pub workspace: Vec<TypeHit>,
    pub jars: Vec<TypeHit>,
    /// 依赖 jar 目录还没建好（首次建类索引很慢，或语言服务刚拉起）。本次先只给工作区结果。
    pub jars_pending: bool,
    pub elapsed_ms: u64,
}

/// 「已经有人在后台建 jar 目录」的在飞标记：连续敲键时不要排一队重复构建。
static CATALOG_WARMING: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub async fn search_types(
    state: tauri::State<'_, Arc<AppState>>,
    query: String,
    limit: Option<usize>,
) -> Result<TypeSearchOut, String> {
    let started = Instant::now();
    let q = query.trim().to_string();
    let limit = limit.unwrap_or(30).clamp(1, 100);
    if q.is_empty() {
        return Ok(TypeSearchOut {
            workspace: Vec::new(),
            jars: Vec::new(),
            jars_pending: false,
            elapsed_ms: 0,
        });
    }
    let (_, root) = workspace_roots(&state).await?;
    let cache_dir = state.config_dir.join("type-index");
    let query_for_index = q.clone();
    let workspace = tauri::async_runtime::spawn_blocking(move || {
        crate::workspace_types::shared(&root, &cache_dir).search(&query_for_index, limit)
    })
    .await
    .map_err(|e| format!("工作区类型索引任务失败：{e}"))?;

    let (mut jars, jars_pending) = match jar_catalog(&state).await {
        Some((index, Some(catalog))) => (
            search_jars(&index, &catalog, &q, limit, &workspace),
            false,
        ),
        Some((_, None)) => (Vec::new(), true),
        None => (Vec::new(), true),
    };
    // 工作区源码优先：jar 里同名的类不再重复列一遍
    jars.retain(|j| !workspace.iter().any(|w| w.name == j.name));

    Ok(TypeSearchOut {
        workspace,
        jars,
        jars_pending,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// 找一份可用于 jar 搜索的类目录。第三种返回值：目录正在后台构建。
async fn jar_catalog(
    state: &Arc<AppState>,
) -> Option<(Arc<ClassIndex>, Option<Arc<TypeCatalog>>)> {
    {
        let run = state.lang.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((index, catalog, _)) = run
            .session
            .as_ref()
            .and_then(|s| s.completion_catalog.as_ref())
        {
            return Some((index.clone(), Some(catalog.clone())));
        }
    }
    let home_cfg = state.config.read().await.nc_home.clone();
    let home = nc_home::resolve(home_cfg.as_deref()).ok()?;
    let (index, _) = lookup_index(&PathBuf::from(home.root), "").ok()??;
    if let Some(catalog) = TypeCatalog::shared_existing(&index) {
        return Some((index, Some(catalog)));
    }
    warm_catalog(state, index.clone());
    Some((index, None))
}

/// 后台把 `type-names.json` 载入进程内目录；下一次查询就能直接用上。
fn warm_catalog(state: &Arc<AppState>, index: Arc<ClassIndex>) {
    if CATALOG_WARMING.swap(true, Ordering::SeqCst) {
        return;
    }
    let cache = state.config_dir.join("lang").join("type-names.json");
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(parent) = cache.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = TypeCatalog::shared_cancellable(&index, &cache, &|_, _| {}, &|| false);
        CATALOG_WARMING.store(false, Ordering::SeqCst);
    });
}

fn search_jars(
    index: &Arc<ClassIndex>,
    catalog: &Arc<TypeCatalog>,
    query: &str,
    limit: usize,
    workspace: &[TypeHit],
) -> Vec<TypeHit> {
    catalog
        .search_fuzzy(index, query, limit.saturating_mul(2).min(100))
        .into_iter()
        .filter(|c| !workspace.iter().any(|w| w.name == c.name))
        .map(|c| {
            let (package, simple) = match c.name.rsplit_once('.') {
                Some((p, s)) => (p.to_string(), s.to_string()),
                None => (String::new(), c.name.clone()),
            };
            let jar = index
                .jars
                .get(c.jar as usize)
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            TypeHit {
                name: c.name,
                simple,
                package,
                // TypeCatalog 给的是 CompletionItemKind（7/8/13），前端按 LSP SymbolKind 取字母
                kind: match c.kind {
                    8 => 11,
                    13 => 10,
                    _ => 5,
                },
                file: String::new(),
                module: String::new(),
                jar,
                line: 1,
                column: 1,
            }
        })
        .take(limit)
        .collect()
}
