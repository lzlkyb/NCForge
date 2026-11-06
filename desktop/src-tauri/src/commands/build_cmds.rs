//! 构建维护命令：清理、清理并重编、重建索引、临时文件、缓存统计与历史。
//!
//! 编译本身在 `build_engine`（纯逻辑 + 闸门），这里只做参数解析、拿编译闸、把结果
//! 原样交给前端。**每个命令的语义必须和方案里的表一致**：清理不等于删除源码，
//! 重建索引不等于清产物——混在一起会让用户以为「点一下全没了」。

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::build_state::{self, CleanReport, HistoryEntry};
use crate::compile::CompileResult;
use crate::state::AppState;

use super::build_engine;
use super::compile_cmds::CompileSlot;

/// 编译闸被占用时的统一文案：清理与编译互斥，不能一边删 class 一边写 class。
fn busy() -> String {
    "已有一次编译在进行，等它完成再试（或点「取消」）".to_string()
}

/// 清理一个模块的编译产物（`dryRun=true` 只算不删，给确认框用）。
#[tauri::command]
pub async fn build_clean_module(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    path: String,
    dry_run: Option<bool>,
) -> Result<CleanReport, String> {
    let (_, module, _) = super::compile_cmds::resolve_module(&state, &path).await?;
    let ctx = build_engine::context(app, state.inner()).await?;
    let dry = dry_run.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        let _slot = CompileSlot::acquire().ok_or_else(busy)?;
        Ok(build_engine::clean_one(&ctx, &module, dry))
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 清理工作区里全部模块的产物。
#[tauri::command]
pub async fn build_clean_all(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    dry_run: Option<bool>,
) -> Result<Vec<CleanReport>, String> {
    let ctx = build_engine::context(app, state.inner()).await?;
    let dry = dry_run.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        let _slot = CompileSlot::acquire().ok_or_else(busy)?;
        let mut out = Vec::new();
        for module in build_engine::all_modules(&ctx) {
            ctx.log(&format!("[{module}] 清理编译产物…"));
            out.push(build_engine::clean_one(&ctx, &module, dry));
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 清理并重编一个模块。
#[tauri::command]
pub async fn build_rebuild_module(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    path: String,
) -> Result<CompileResult, String> {
    let (_, module, _) = super::compile_cmds::resolve_module(&state, &path).await?;
    let ctx = build_engine::context(app, state.inner()).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let _slot = CompileSlot::acquire().ok_or_else(busy)?;
        ctx.st
            .compile_cancel
            .store(false, std::sync::atomic::Ordering::SeqCst);
        let report = build_engine::clean_one(&ctx, &module, false);
        ctx.log(&format!(
            "[{module}] 已清理 {} 个 class，开始全量重编",
            report.removed
        ));
        if !report.failed.is_empty() {
            return Err(format!(
                "清理时有 {} 个文件删不掉，已停止重编（避免新旧产物混在一起）：{}",
                report.failed.len(),
                report.failed.join("；")
            ));
        }
        build_engine::build_one(
            &ctx,
            &module,
            build_engine::Mode::Full,
            true,
            report.removed,
        )
        .map(|b| b.result)
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 清理并重编全部模块。
#[tauri::command]
pub async fn build_rebuild_all(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<CompileResult, String> {
    let ctx = build_engine::context(app, state.inner()).await?;
    tauri::async_runtime::spawn_blocking(move || build_engine::build_all_impl(&ctx, true, true))
        .await
        .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 重建类索引：清进程内索引、磁盘 `class-index*.bin` 与构建清单。
///
/// **不删产物**：索引只影响「挑哪些 jar」，产物是另一件事。下次编译会重新扫描 jar，
/// 清单没了就自动全量，清完不会留下半套账本。
#[tauri::command]
pub async fn build_reindex(state: State<'_, Arc<AppState>>) -> Result<String, String> {
    let (_, root) = super::compile_cmds::workspace_roots(&state).await?;
    let config_dir = state.config_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _slot = CompileSlot::acquire().ok_or_else(busy)?;
        super::compile_cmds::invalidate_index();
        let mut index_files = 0usize;
        if let Ok(rd) = std::fs::read_dir(&config_dir) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().to_ascii_lowercase();
                if name.starts_with("class-index")
                    && name.ends_with(".bin")
                    && std::fs::remove_file(e.path()).is_ok()
                {
                    index_files += 1;
                }
            }
        }
        let manifests = build_state::clear_manifests(&build_state::build_dir(&config_dir, &root));
        Ok(format!(
            "已重建类索引：删除 {index_files} 个索引文件、{manifests} 份构建清单；下次编译会重新扫描 jar"
        ))
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanTmpReport {
    pub removed: usize,
    pub bytes: u64,
}

/// 清理编译临时文件（崩溃残留的参数文件、原子写残留）。
///
/// 只动 `{config_dir}/tmp` 下我们自己生成的文件，不碰工作区。
#[tauri::command]
pub async fn build_clean_tmp(state: State<'_, Arc<AppState>>) -> Result<CleanTmpReport, String> {
    let dir = state.config_dir.join("tmp");
    tauri::async_runtime::spawn_blocking(move || {
        let mut report = CleanTmpReport {
            removed: 0,
            bytes: 0,
        };
        let Ok(rd) = std::fs::read_dir(&dir) else {
            return Ok(report);
        };
        for e in rd.flatten() {
            let p = e.path();
            if !p.is_file() {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_ascii_lowercase();
            let ours = (name.starts_with("ecj-") && name.ends_with(".args"))
                || name.contains(".tmp");
            if !ours {
                continue;
            }
            let len = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
            if std::fs::remove_file(&p).is_ok() {
                report.removed += 1;
                report.bytes += len;
            }
        }
        Ok(report)
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildCacheInfo {
    /// 类索引文件（按 NC home 分文件）总大小
    pub index_bytes: u64,
    pub index_files: usize,
    /// 构建清单目录总大小
    pub manifest_bytes: u64,
    pub manifest_modules: usize,
    /// 临时文件目录大小
    pub tmp_bytes: u64,
    pub tracked_classes: usize,
    pub untracked_classes: Vec<String>,
    pub last_success_ms: Option<u64>,
    pub last_build: Option<HistoryEntry>,
    pub history: Vec<HistoryEntry>,
    /// 当前并行上限（1 = 串行）
    pub parallel: u8,
    /// 常驻 worker / 一次一进程的累计计数与耗时分布（进程内，重启清零）
    pub worker: crate::ecj_worker::WorkerStats,
}

/// 设置页「维护」卡片：缓存占用、上次构建、未跟踪产物。
#[tauri::command]
pub async fn build_cache_info(
    state: State<'_, Arc<AppState>>,
) -> Result<BuildCacheInfo, String> {
    let (_, root) = super::compile_cmds::workspace_roots(&state).await?;
    let config_dir = state.config_dir.clone();
    let parallel = {
        let cfg = state.config.read().await;
        cfg.build_parallel.clamp(1, 4)
    };
    tauri::async_runtime::spawn_blocking(move || {
        let (mut index_bytes, mut index_files) = (0u64, 0usize);
        if let Ok(rd) = std::fs::read_dir(&config_dir) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().to_ascii_lowercase();
                if name.starts_with("class-index") && name.ends_with(".bin") {
                    index_files += 1;
                    index_bytes += e.metadata().map(|m| m.len()).unwrap_or(0);
                }
            }
        }
        let build_dir = build_state::build_dir(&config_dir, &root);
        let manifest_bytes = build_state::dir_size(&build_dir);
        let manifests = build_state::list_manifests(&build_dir);
        let mut tracked_classes = 0usize;
        let mut untracked_classes = Vec::new();
        let mut last_success_ms = None;
        for m in &manifests {
            tracked_classes += m.sources.iter().map(|s| s.classes.len()).sum::<usize>();
            if m.last_success_ms > 0 {
                last_success_ms = Some(
                    last_success_ms
                        .map(|v: u64| v.max(m.last_success_ms))
                        .unwrap_or(m.last_success_ms),
                );
            }
            let layout = crate::build_layout::ModuleLayout::resolve(&root, &m.module);
            untracked_classes.extend(build_state::untracked_classes(&layout, Some(m)));
        }
        untracked_classes.truncate(100);
        let history = build_state::read_history(&config_dir, &root);
        let last_build = history.last().cloned();
        Ok(BuildCacheInfo {
            index_bytes,
            index_files,
            manifest_bytes,
            manifest_modules: manifests.len(),
            tmp_bytes: build_state::dir_size(&config_dir.join("tmp")),
            tracked_classes,
            untracked_classes,
            last_success_ms,
            last_build,
            history,
            parallel,
            worker: crate::ecj_worker::stats(),
        })
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 构建历史（最近 50 条模块结果）。
#[tauri::command]
pub async fn build_history(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<HistoryEntry>, String> {
    let (_, root) = super::compile_cmds::workspace_roots(&state).await?;
    let config_dir: PathBuf = state.config_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        Ok::<_, String>(build_state::read_history(&config_dir, &root))
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}
