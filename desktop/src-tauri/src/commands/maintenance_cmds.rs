use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::app_error::AppError;
use crate::maintenance_memory::{self, MemorySnapshot};
use crate::maintenance_storage::{self, CleanReport, Plan, Preview, Scope, Usage};
use crate::state::AppState;

#[derive(Default)]
pub(crate) struct Maintenance {
    next: AtomicU64,
    plan: Mutex<Option<Plan>>,
    run: Mutex<Option<(u64, Arc<AtomicBool>)>>,
}

struct CleanupRun {
    state: Arc<AppState>,
    cancelled: Arc<AtomicBool>,
}

impl Drop for CleanupRun {
    fn drop(&mut self) {
        *self
            .state
            .maintenance
            .run
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
    }
}

fn begin(state: Arc<AppState>, id: u64) -> Result<CleanupRun, AppError> {
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut slot = state
            .maintenance
            .run
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if slot.is_some() {
            return Err(AppError::unavailable(
                "storage.busy",
                "已有一项清理正在运行，请稍后重试",
            ));
        }
        *slot = Some((id, Arc::clone(&cancelled)));
    }
    Ok(CleanupRun { state, cancelled })
}

use super::lang_cache::in_use as language_busy;

async fn background<T: Send + 'static>(
    task: impl FnOnce() -> T + Send + 'static,
) -> Result<T, AppError> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| AppError::env("storage.task", format!("维护后台任务失败：{error}")))
}

#[tauri::command]
pub async fn storage_usage(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<Usage, AppError> {
    let state = state.inner().clone();
    let auxiliary = [app.path().app_local_data_dir(), app.path().app_cache_dir()]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    background(move || {
        let busy = state
            .lang
            .try_lock()
            .map_or(true, |run| language_busy(&run));
        maintenance_storage::usage(&state.config_dir, &auxiliary, busy)
            .map_err(|error| AppError::env("storage.scan", format!("无法读取本机存储：{error}")))
    })
    .await?
}

#[tauri::command]
pub async fn storage_preview(
    state: State<'_, Arc<AppState>>,
    scope: Scope,
) -> Result<Preview, AppError> {
    let state = state.inner().clone();
    background(move || {
        if scope == Scope::Language
            && state
                .lang
                .try_lock()
                .map_or(true, |run| language_busy(&run))
        {
            return Err(AppError::unavailable(
                "storage.indexBusy",
                "请在代码智能停止后清理索引",
            ));
        }
        let id = state.maintenance.next.fetch_add(1, Ordering::Relaxed) + 1;
        let (plan, preview) = maintenance_storage::preview(&state.config_dir, id, scope);
        let mut slot = state
            .maintenance
            .plan
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if slot.as_ref().is_none_or(|previous| previous.id < id) {
            *slot = Some(plan);
        }
        Ok(preview)
    })
    .await?
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StorageProgress {
    plan_id: u64,
    done: usize,
    total: usize,
}

#[tauri::command]
pub async fn storage_apply(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    plan_id: u64,
    selected: Vec<usize>,
) -> Result<CleanReport, AppError> {
    let run = begin(state.inner().clone(), plan_id)?;
    background(move || {
        let plan = {
            let mut slot = run
                .state
                .maintenance
                .plan
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if !slot.as_ref().is_some_and(|plan| {
                plan.id == plan_id && !plan.expired() && plan.valid_selection(&selected)
            }) {
                return Err(AppError::input(
                    "storage.previewExpired",
                    "清理预览已过期，请重新扫描",
                ));
            }
            slot.take().unwrap()
        };
        let _language = if plan.scope == Scope::Language {
            let cache = run.state.language_cache.try_write().map_err(|_| {
                AppError::unavailable("storage.indexBusy", "代码智能正在准备索引，请稍后重试")
            })?;
            // Hold admission across cleanup so a new JDT session cannot acquire this index meanwhile.
            let guard = run
                .state
                .lang
                .try_lock()
                .ok()
                .filter(|lang| !language_busy(lang))
                .ok_or_else(|| {
                    AppError::unavailable("storage.indexBusy", "代码智能正在使用索引，请稍后重试")
                })?;
            Some((cache, guard))
        } else {
            None
        };
        Ok(maintenance_storage::apply(
            &run.state.config_dir,
            plan,
            Some(&selected),
            || run.cancelled.load(Ordering::Acquire),
            |done, total| {
                let _ = app.emit(
                    "storage-clean-progress",
                    StorageProgress {
                        plan_id,
                        done,
                        total,
                    },
                );
            },
        ))
    })
    .await?
}

#[tauri::command]
pub fn storage_cancel(state: State<'_, Arc<AppState>>, plan_id: u64) {
    let slot = state
        .maintenance
        .run
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some((id, cancelled)) = slot.as_ref() {
        if *id == plan_id {
            cancelled.store(true, Ordering::Release);
        }
    }
}

#[tauri::command]
pub async fn storage_idle_cleanup(
    state: State<'_, Arc<AppState>>,
) -> Result<CleanReport, AppError> {
    let run = begin(state.inner().clone(), 0)?;
    background(move || {
        let cancelled = || run.cancelled.load(Ordering::Acquire);
        let (plan, _) = maintenance_storage::preview_interruptible(
            &run.state.config_dir,
            0,
            Scope::Recommended,
            &cancelled,
        );
        maintenance_storage::apply(&run.state.config_dir, plan, None, cancelled, |_, _| {
            std::thread::yield_now()
        })
    })
    .await
}

#[tauri::command]
pub async fn storage_memory(state: State<'_, Arc<AppState>>) -> Result<MemorySnapshot, AppError> {
    let state = state.inner().clone();
    background(move || maintenance_memory::sample(&state)).await
}

#[tauri::command]
pub async fn storage_release_compilers() -> Result<usize, AppError> {
    background(crate::ecj_worker::release_idle).await
}
