//! Exact NC stdout sources; native selection authorizes only the chosen output file.
use crate::db_transfer_destination::DestinationRegistry;
use crate::service_log::{self, LogExportResult, LogPage, LogTarget};
use crate::state::AppState;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

type Jobs = Mutex<HashMap<String, Arc<AtomicBool>>>;
static JOBS: OnceLock<Jobs> = OnceLock::new();
struct ExportJob {
    id: String,
    canceled: Arc<AtomicBool>,
}
impl ExportJob {
    fn register(id: String) -> Result<Self, String> {
        if id.is_empty()
            || id.len() > 100
            || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err("日志导出任务标识无效".into());
        }
        let mut jobs = JOBS
            .get_or_init(Default::default)
            .lock()
            .map_err(|_| "日志导出状态异常")?;
        if jobs.len() >= 8 {
            return Err("日志导出任务过多，请等待现有任务结束".into());
        }
        if jobs.contains_key(&id) {
            return Err("此日志导出任务正在运行".into());
        }
        let canceled = Arc::new(AtomicBool::new(false));
        jobs.insert(id.clone(), canceled.clone());
        Ok(Self { id, canceled })
    }
}
impl Drop for ExportJob {
    fn drop(&mut self) {
        if let Ok(mut jobs) = JOBS.get_or_init(Default::default).lock() {
            jobs.remove(&self.id);
        }
    }
}

#[tauri::command]
pub async fn service_log_read(
    state: tauri::State<'_, Arc<AppState>>,
    target: LogTarget,
    previous: bool,
    offset: u64,
    file_id: Option<String>,
) -> Result<LogPage, String> {
    let root = state.config_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let path = service_log::source_path(&root, target, previous)?;
        service_log::read_page(&path, offset, None, file_id.as_deref(), false)
    })
    .await
    .map_err(|e| format!("日志读取任务失败：{e}"))?
}
#[tauri::command]
pub async fn service_log_tail(
    state: tauri::State<'_, Arc<AppState>>,
    target: LogTarget,
    previous: bool,
    before: Option<u64>,
    file_id: Option<String>,
) -> Result<LogPage, String> {
    let root = state.config_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let path = service_log::source_path(&root, target, previous)?;
        service_log::read_page(&path, 0, before, file_id.as_deref(), true)
    })
    .await
    .map_err(|e| format!("日志历史读取失败：{e}"))?
}
#[derive(serde::Serialize)]
pub struct LogViewClear {
    pub offset: u64,
    pub rotated: bool,
}
#[tauri::command]
pub async fn service_log_clear(
    state: tauri::State<'_, Arc<AppState>>,
    target: LogTarget,
) -> Result<LogViewClear, String> {
    let root = state.config_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let path = service_log::source_path(&root, target, false)?;
        let offset = if path.exists() {
            std::fs::metadata(path)
                .map_err(|e| format!("读取日志长度失败：{e}"))?
                .len()
        } else {
            0
        };
        Ok(LogViewClear {
            offset,
            rotated: false,
        })
    })
    .await
    .map_err(|e| format!("清屏任务失败：{e}"))?
}
#[tauri::command]
pub fn service_log_cancel_export(job_id: String) -> Result<(), String> {
    if let Some(token) = JOBS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "日志导出状态异常")?
        .get(&job_id)
    {
        token.store(true, Ordering::SeqCst);
    }
    Ok(())
}
#[tauri::command]
pub async fn service_log_export(
    app: AppHandle,
    registry: tauri::State<'_, DestinationRegistry>,
    target: LogTarget,
    previous: bool,
    file_id: Option<String>,
    job_id: String,
    text: Option<String>,
) -> Result<Option<LogExportResult>, String> {
    let root = app.state::<Arc<AppState>>().config_dir.clone();
    let registry = registry.inner().clone();
    // Register before launching the native picker; cancel remains meaningful while it is open.
    let job = ExportJob::register(job_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let (reader, size, source): (Box<dyn std::io::Read + Send>, u64, Option<std::path::PathBuf>) = if let Some(text) = text {
            if text.len() > 8 * 1024 * 1024 { return Err("已加载日志超过 8MB，请缩小过滤范围或导出完整日志文件".into()); }
            let size = text.len() as u64; (Box::new(std::io::Cursor::new(text.into_bytes())), size, None)
        } else {
            let source = service_log::source_path(&root, target, previous)?;
            let (file, size, id) = service_log::open_source(&source)?;
            if file_id.is_some_and(|expected| expected != id) { return Err("日志来源已轮转，请重新加载后导出".into()); }
            (Box::new(file), size, Some(source))
        };
        let owner = app.get_webview_window("main");
        let mut dialog = app.dialog().file().set_title(if source.is_some() { "保存完整控制台日志" } else { "保存已加载匹配日志" }).set_file_name(format!("{}-{}{}.log", target.name(), if previous { "previous" } else { "current" }, if source.is_some() { "" } else { "-loaded" })).add_filter("日志文件", &["log", "txt"]);
        if let Some(window) = &owner { dialog = dialog.set_parent(window); }
        let Some(picked) = dialog.blocking_save_file() else { return Ok(None); };
        if job.canceled.load(Ordering::SeqCst) { return Ok(None); }
        let output = picked.into_path().map_err(|e| format!("保存位置不是本地文件：{e}"))?;
        // Neither full-file nor cached-text export may replace an app-owned live/archive stdout file.
        for target in [LogTarget::Middleware, LogTarget::Client] {
            for previous in [false, true] {
                let protected = service_log::source_path(&root, target, previous)?;
                if protected.exists() && output.canonicalize().ok() == protected.canonicalize().ok() { return Err("不能用导出覆盖控制台原始日志，请选择其他文件".into()); }
            }
        }
        let grant = registry.grant(&output)?; let lease = registry.lease(&grant.token)?;
        if source.as_ref().is_some_and(|source| output.canonicalize().ok().as_ref() == source.canonicalize().ok().as_ref()) { return Err("不能用导出覆盖正在读取的日志，请选择其他文件".into()); }
        let mut last = Instant::now().checked_sub(Duration::from_secs(1)).unwrap_or_else(Instant::now);
        let result = service_log::copy_snapshot(reader, size, lease.path(), &job.canceled, || lease.verify(), |bytes| {
            if bytes == size || last.elapsed() >= Duration::from_millis(200) {
                let _ = app.emit("service:log-export", serde_json::json!({"jobId":job.id,"target":target.name(),"bytes":bytes,"totalBytes":size})); last = Instant::now();
            }
        })?;
        Ok(result)
    }).await.map_err(|e| format!("日志导出任务失败：{e}"))?
}
