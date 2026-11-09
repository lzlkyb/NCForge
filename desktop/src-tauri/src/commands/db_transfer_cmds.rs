//! Native destination selection and a separate, query-only, streaming transfer session.
use serde_json::{json, Value};
use std::fs::File;
use std::io::BufWriter;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

use super::db_cmds::{
    call, drop_bridge, find_conn, open_temp_session, prop_password_ready, PROBE_CONF,
};
use crate::db_engine::{EngineHandle, EngineKind};
use crate::db_transfer::{
    self as transfer, Layout, TextWriter, TransferColumn, TransferData, TransferFormat,
    TransferOptions, TransferOut, TransferReq,
};
use crate::db_transfer_destination::{self as destination, DestinationGrant, DestinationRegistry};
use crate::db_transfer_job::{probe_has_more, CancelRegistration};
use crate::db_transfer_xlsx::XlsxWriter;
use crate::state::AppState;

const PAGE: usize = 5000;
const MAX_ROWS: usize = 2_000_000;
const MAX_SHEETS: usize = 128;

#[tauri::command]
pub async fn db_transfer_pick(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    registry: tauri::State<'_, DestinationRegistry>,
    format: TransferFormat,
    file_name: Option<String>,
) -> Result<Option<DestinationGrant>, String> {
    let dir = super::db_export_cmds::export_dir(&state);
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&dir).map_err(|e| format!("建立导出目录失败：{e}"))?;
        let owner = app.get_webview_window("main");
        let mut dialog = app
            .dialog()
            .file()
            .set_title("保存查询结果")
            .set_directory(&dir)
            .set_file_name(destination::file_name(file_name.as_deref(), format))
            .add_filter(format.ext().to_uppercase(), &[format.ext()]);
        if let Some(w) = &owner {
            dialog = dialog.set_parent(w);
        }
        let Some(picked) = dialog.blocking_save_file() else {
            return Ok(None);
        };
        let path = picked
            .into_path()
            .map_err(|e| format!("保存位置不是本地文件：{e}"))?;
        destination::verify_extension(&path, format)?;
        registry.grant(&path).map(Some)
    })
    .await
    .map_err(|e| format!("保存选择器异常：{e}"))?
}

#[tauri::command]
pub async fn db_transfer_open(
    app: AppHandle,
    registry: tauri::State<'_, DestinationRegistry>,
    token: String,
    reveal: bool,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let path = registry.resolve(&token)?;
        if !path.is_file() {
            return Err("导出文件不存在".into());
        }
        if reveal {
            app.opener()
                .reveal_item_in_dir(&path)
                .map_err(|e| format!("打开所在目录失败：{e}"))
        } else {
            app.opener()
                .open_path(crate::security::path::display_path(&path), None::<&str>)
                .map_err(|e| format!("打开导出文件失败：{e}"))
        }
    })
    .await
    .map_err(|e| format!("打开文件任务失败：{e}"))?
}

#[tauri::command]
pub async fn db_transfer_file(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    registry: tauri::State<'_, DestinationRegistry>,
    mut req: TransferReq,
) -> Result<Option<TransferOut>, String> {
    let st = state.inner().clone();
    // Register before the first await so an early stop can target connection setup and the first fetch.
    let cancel = CancelRegistration::register(st.clone(), req.export_id)?;
    let t0 = Instant::now();
    let mut progress = Progress::new(app.clone(), &req, t0);
    progress.emit(0, 0, "preparing", true);
    let remote = req.data.is_none() && req.sheets.is_none() && req.text.is_none();
    if req.text.is_some() {
        if req.format != TransferFormat::Insert || req.data.is_some() || req.sheets.is_some() {
            return Err("已生成文本只能通过 INSERT 文件保存入口保存".into());
        }
    } else {
        transfer::validate_options(req.format, &req.options, remote)?;
    }
    if req.data.is_some() && req.sheets.is_some() {
        return Err("不能同时提供单个结果和多个结果集".into());
    }
    if req
        .sheets
        .as_ref()
        .is_some_and(|s| s.is_empty() || s.len() > MAX_SHEETS)
    {
        return Err("多结果集导出需要 1 到 128 个结果集".into());
    }
    if req.sheets.is_some() && req.format != TransferFormat::Xlsx {
        return Err("多个结果集只能保存为 XLSX".into());
    }
    if req.sheets.is_some() && req.options.transpose {
        return Err("多个结果集不支持转置，请分别导出".into());
    }
    if remote && !crate::db_engine::readonly_query(&req.sql) {
        return Err("全量导出只允许单条只读 SELECT 查询，不允许写语句、锁定或 PL/SQL".into());
    }
    if remote && req.expected_columns.as_ref().is_none_or(|c| c.is_empty()) {
        return Err("全量导出缺少来源列布局，请重新执行查询".into());
    }
    if remote {
        validate_params(req.params.as_deref().unwrap_or(&[]))?;
    }
    let registry = registry.inner().clone();
    let dir = super::db_export_cmds::export_dir(&st);
    let default_name = destination::file_name(req.file_name.as_deref(), req.format);
    let selected_token = req.destination_token.clone();
    let destination = tauri::async_runtime::spawn_blocking({
        let registry = registry.clone();
        move || {
            let token = match selected_token {
                Some(token) => token,
                None => {
                    std::fs::create_dir_all(&dir).map_err(|e| format!("建立导出目录失败：{e}"))?;
                    registry.grant(&dir.join(default_name))?.token
                }
            };
            let lease = registry.lease(&token)?;
            destination::verify_extension(lease.path(), req.format)?;
            Ok::<_, String>(lease)
        }
    })
    .await
    .map_err(|e| format!("保存位置检查失败：{e}"))??;
    if cancel.token.load(Ordering::SeqCst) {
        return Ok(None);
    }
    let limit = match req.max_rows.unwrap_or(0) {
        0 => MAX_ROWS,
        n => n.min(MAX_ROWS),
    };
    if !remote {
        let token = cancel.token.clone();
        return tauri::async_runtime::spawn_blocking(move || {
            if let Some(text) = req.text.take() {
                return save_text(&req, &text, destination, registry, &token, progress);
            }
            let source = if let Some(data) = req.data.take() {
                Source::Local(vec![("查询结果".into(), data)], false)
            } else {
                Source::Local(
                    req.sheets
                        .take()
                        .unwrap()
                        .into_iter()
                        .map(|s| (s.name, s.data))
                        .collect(),
                    true,
                )
            };
            run_transfer(req, source, destination, registry, token, progress, limit)
        })
        .await
        .map_err(|e| format!("本地导出任务失败：{e}"))?;
    }
    let cfg = st.config.read().await.clone();
    if cancel.token.load(Ordering::SeqCst) {
        return Ok(None);
    }
    let mut conn = find_conn(&cfg, &req.id)?;
    validate_source_connection(req.source_connection_key.as_deref(), &conn)?;
    if let Some(schema) = req.source_schema.as_deref() {
        let normalized = crate::db_conns::normalize_schema(schema);
        if !normalized.is_empty() && !crate::db_conns::valid_schema(&normalized) {
            return Err("查询来源 schema 无效，请重新执行查询后导出".into());
        }
    }
    let engine = EngineKind::parse(&conn.engine);
    if engine != EngineKind::Java && conn.source == "prop" {
        prop_password_ready(&app, &st, &cfg, &mut conn, None, PROBE_CONF).await?;
    }
    if cancel.token.load(Ordering::SeqCst) {
        return Ok(None);
    }
    let (key, handle) = open_temp_session(&app, &st, &cfg, &conn, engine, "transfer")
        .await
        .ok_or("无法建立独立导出会话，请连接数据库并记住口令后重试")?;
    let timeout = req.timeout_sec.unwrap_or(600).clamp(5, 3600);
    let result = async {
        if cancel.token.load(Ordering::SeqCst) {
            return Ok(None);
        }
        // The export owns a fresh session. Pin the result's schema instead of inheriting a later
        // connection-level schema change, which could otherwise export same-shaped data from another tenant.
        if let Some(schema) = req.source_schema.as_deref() {
            call(
                handle.clone(),
                "setSchema",
                vec![schema.to_string()],
                Duration::from_secs(30),
            )
            .await?;
        }
        call(
            handle.clone(),
            "readOnly",
            vec!["true".into()],
            Duration::from_secs(u64::from(timeout) + 30),
        )
        .await?;
        if cancel.token.load(Ordering::SeqCst) {
            return Ok(None);
        }
        let source = Source::Remote {
            handle: handle.clone(),
            timeout,
        };
        let token = cancel.token.clone();
        tauri::async_runtime::spawn_blocking(move || {
            run_transfer(req, source, destination, registry, token, progress, limit)
        })
        .await
        .map_err(|e| format!("流式导出任务失败：{e}"))?
    }
    .await;
    // Disconnect on success, cancellation, encoder failure and read-only setup failure alike.
    let _ = call(handle, "disconnect", vec![], Duration::from_secs(10)).await;
    drop_bridge(&st, &key);
    result
}

enum Source {
    Local(Vec<(String, TransferData)>, bool),
    Remote {
        handle: Arc<EngineHandle>,
        timeout: u32,
    },
}

fn validate_source_connection(
    expected: Option<&str>,
    conn: &crate::config::DbConnConfig,
) -> Result<(), String> {
    let Some(expected) = expected else {
        return Ok(());
    };
    let actual = json!([
        conn.url,
        conn.user,
        if conn.engine.is_empty() {
            "java"
        } else {
            &conn.engine
        },
        conn.source,
        conn.prop_ds
    ]);
    if serde_json::from_str::<Value>(expected).ok().as_ref() != Some(&actual) {
        return Err("连接目标已变化，请重新执行查询后导出；已加载的数据仍可导出".into());
    }
    Ok(())
}
struct Progress {
    app: AppHandle,
    id: String,
    export_id: u64,
    start: Instant,
    last: Option<Instant>,
    total: Option<usize>,
    xlsx: bool,
    final_bytes: bool,
}
impl Progress {
    fn new(app: AppHandle, req: &TransferReq, start: Instant) -> Self {
        let total = req.data.as_ref().map(|d| d.rows.len()).or_else(|| {
            req.sheets
                .as_ref()
                .map(|s| s.iter().map(|s| s.data.rows.len()).sum())
        });
        Self {
            app,
            id: req.id.clone(),
            export_id: req.export_id,
            start,
            last: None,
            total,
            xlsx: req.format == TransferFormat::Xlsx,
            final_bytes: false,
        }
    }
    fn emit(&mut self, rows: usize, bytes: u64, phase: &str, force: bool) {
        let now = Instant::now();
        if !force
            && self
                .last
                .is_some_and(|t| now.duration_since(t) < Duration::from_millis(250))
        {
            return;
        }
        self.last = Some(now);
        let elapsed = self.start.elapsed();
        let seconds = elapsed.as_secs_f64().max(0.001);
        let buffered = self.xlsx && !self.final_bytes;
        let mut event = json!({"id":self.id,"exportId":self.export_id,"rows":rows,"bytes":if buffered { 0 } else { bytes },"processedBytes":bytes,"bytesKind":if buffered { "buffered" } else { "file" },"elapsedMs":elapsed.as_millis() as u64,"rowsPerSec":rows as f64/seconds,"bytesPerSec":if buffered { 0.0 } else { bytes as f64/seconds },"phase":phase});
        if let Some(total) = self.total {
            event["totalRows"] = json!(total);
        }
        let _ = self.app.emit("db:export-progress", event);
    }
}
enum Writer {
    Text(Box<TextWriter<BufWriter<File>>>),
    Xlsx(Box<XlsxWriter>),
}
impl Writer {
    fn new(
        path: &Path,
        fmt: TransferFormat,
        layout: &Layout,
        o: &TransferOptions,
        query: &str,
        name: &str,
    ) -> Result<Self, String> {
        if fmt == TransferFormat::Xlsx {
            let mut x = XlsxWriter::new(path.parent().ok_or("文件无上级目录")?)?;
            x.set_null_text(o.null_text.clone());
            x.begin_sheet(
                name,
                layout.columns.clone(),
                transfer::header_rows(&layout.columns, &layout.labels, &o.header),
            )?;
            if o.include_query && !query.is_empty() {
                x.add_note(format!("查询：{query}"));
            }
            Ok(Self::Xlsx(Box::new(x)))
        } else {
            let file = File::create(path).map_err(|e| format!("建立临时导出文件失败：{e}"))?;
            Ok(Self::Text(Box::new(TextWriter::new(
                BufWriter::with_capacity(64 * 1024, file),
                fmt,
                layout.columns.clone(),
                &layout.labels,
                o,
                query,
            )?)))
        }
    }
    fn push(&mut self, row: &[Value]) -> Result<(), String> {
        match self {
            Self::Text(w) => w.push(row),
            Self::Xlsx(w) => w.push(row),
        }
    }
    fn bytes(&self) -> u64 {
        match self {
            Self::Text(w) => w.bytes(),
            Self::Xlsx(w) => w.bytes(),
        }
    }
    fn note(&mut self, text: String) {
        if let Self::Xlsx(w) = self {
            w.add_note(text);
        }
    }
    fn finish(self, path: &Path) -> Result<Vec<String>, String> {
        let (file, warnings) = match self {
            Self::Text(w) => {
                let out = (*w).finish()?;
                (
                    out.into_inner()
                        .map_err(|e| format!("刷新文件缓冲失败：{e}"))?,
                    vec![],
                )
            }
            Self::Xlsx(w) => {
                let warnings = w.warnings();
                let file =
                    File::create(path).map_err(|e| format!("建立 XLSX 临时文件失败：{e}"))?;
                ((*w).finish(file)?, warnings)
            }
        };
        file.sync_all()
            .map_err(|e| format!("导出文件写入磁盘失败：{e}"))?;
        drop(file);
        Ok(warnings)
    }
}

fn run_transfer(
    req: TransferReq,
    source: Source,
    lease: destination::DestinationLease,
    registry: DestinationRegistry,
    cancel: Arc<AtomicBool>,
    mut progress: Progress,
    limit: usize,
) -> Result<Option<TransferOut>, String> {
    if cancel.load(Ordering::SeqCst) {
        return Ok(None);
    }
    let path = lease.path();
    let temp = tempfile::Builder::new()
        .prefix(".ncforge-transfer-")
        .suffix(".tmp")
        .tempfile_in(path.parent().ok_or("保存路径无上级目录")?)
        .map_err(|e| format!("建立导出临时文件失败：{e}"))?;
    let mut stats = Stats::default();
    let mut writer = match source {
        Source::Local(sheets, multi) => write_local(
            &req,
            sheets,
            multi,
            temp.path(),
            &cancel,
            &mut progress,
            limit,
            &mut stats,
        )?,
        Source::Remote { handle, timeout } => write_remote(
            &req,
            &handle,
            timeout,
            temp.path(),
            &cancel,
            &mut progress,
            limit,
            &mut stats,
        )?,
    };
    if req.options.include_query {
        if let Some(context) = &req.context {
            writer.note(format!("来源：{}\n范围：{}", context.source, context.scope));
        }
    }
    stats.canceled |= cancel.load(Ordering::SeqCst);
    if stats.canceled && stats.rows == 0 {
        return Ok(None);
    }
    if stats.canceled || stats.truncated {
        writer.note(format!(
            "部分结果：{}，包含 {} 行。",
            if stats.canceled {
                "用户取消"
            } else {
                "达到行数上限"
            },
            stats.rows
        ));
    }
    if stats.long_values > 0 {
        stats.warnings.push(format!(
            "{} 个超长文本超过单值读取上限，目标文件里这些值只保留了前面的部分（末尾带截断提示）；\
             保存的是单独命名的部分结果。需要完整内容请缩小范围后分段导出",
            stats.long_values
        ));
    }
    progress.emit(stats.rows, writer.bytes(), "finalizing", true);
    let mut warnings = writer.finish(temp.path())?;
    stats.canceled |= cancel.load(Ordering::SeqCst);
    warnings.extend(stats.warnings);
    if stats.truncated {
        warnings.push(format!("已达到 {limit} 行上限；保存的是单独命名的部分结果"));
    }
    if stats.canceled {
        warnings.push("导出已取消；保存的是单独命名的部分结果".into());
    }
    lease.verify()?;
    // 长文本被截断同样算「部分结果」：文件里那些值不完整，不能顶掉同名的完整旧文件。
    let partial = stats.canceled || stats.truncated || stats.long_values > 0;
    let actual = if partial {
        destination::persist_partial(temp, path, req.export_id)?
    } else {
        temp.persist(path)
            .map_err(|e| format!("替换导出文件失败：{}", e.error))?;
        path.to_path_buf()
    };
    let grant = registry.grant(&actual)?;
    let bytes = std::fs::metadata(&actual)
        .map_err(|e| format!("读取导出文件大小失败：{e}"))?
        .len();
    progress.final_bytes = true;
    progress.emit(stats.rows, bytes, "finalizing", true);
    Ok(Some(TransferOut {
        path: grant.path,
        file_name: actual
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into(),
        rows: stats.rows,
        bytes,
        truncated: stats.truncated,
        canceled: stats.canceled,
        ms: progress.start.elapsed().as_millis() as u64,
        destination_token: grant.token,
        warnings,
    }))
}
fn save_text(
    req: &TransferReq,
    text: &str,
    lease: destination::DestinationLease,
    registry: DestinationRegistry,
    cancel: &AtomicBool,
    mut progress: Progress,
) -> Result<Option<TransferOut>, String> {
    if cancel.load(Ordering::SeqCst) {
        return Ok(None);
    }
    let path = lease.path();
    let mut temp = tempfile::Builder::new()
        .prefix(".ncforge-transfer-")
        .suffix(".tmp")
        .tempfile_in(path.parent().ok_or("目标路径无上级目录")?)
        .map_err(|e| format!("建立导出临时文件失败：{e}"))?;
    let rows = req.text_rows.unwrap_or(0);
    progress.total = Some(rows);
    let mut bytes = 0;
    for chunk in text.as_bytes().chunks(64 * 1024) {
        // Canceling a preassembled SQL save abandons the temp file, preserving only complete statements.
        if cancel.load(Ordering::SeqCst) {
            return Ok(None);
        }
        temp.write_all(chunk)
            .map_err(|e| format!("写导出文件失败：{e}"))?;
        bytes += chunk.len() as u64;
        progress.emit(0, bytes, "writing", false);
    }
    progress.emit(rows, bytes, "finalizing", true);
    temp.as_file()
        .sync_all()
        .map_err(|e| format!("导出文件写入磁盘失败：{e}"))?;
    if cancel.load(Ordering::SeqCst) {
        return Ok(None);
    }
    lease.verify()?;
    let truncated = req.text_truncated.unwrap_or(false);
    let actual = if truncated {
        destination::persist_partial(temp, path, req.export_id)?
    } else {
        temp.persist(path)
            .map_err(|e| format!("替换导出文件失败：{}", e.error))?;
        path.to_path_buf()
    };
    let grant = registry.grant(&actual)?;
    Ok(Some(TransferOut {
        path: grant.path,
        file_name: actual
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into(),
        rows,
        bytes,
        truncated,
        canceled: false,
        ms: progress.start.elapsed().as_millis() as u64,
        destination_token: grant.token,
        warnings: req.text_warnings.clone().unwrap_or_default(),
    }))
}
#[derive(Default)]
struct Stats {
    rows: usize,
    truncated: bool,
    canceled: bool,
    long_values: usize,
    warnings: Vec<String>,
}
fn count_long(row: &[Value], stats: &mut Stats) {
    // 判据看截断文案，不看长度：网格通道 8K、全量通道 1M，拿固定长度当阈值两头都会判错。
    // 尾部文案是唯一可靠信号（`is_lob_preview`）。
    stats.long_values += row
        .iter()
        .filter(|v| v.as_str().is_some_and(crate::db_rust::is_lob_preview))
        .count();
}

#[allow(clippy::too_many_arguments)]
fn write_local(
    req: &TransferReq,
    sheets: Vec<(String, TransferData)>,
    multi: bool,
    path: &Path,
    cancel: &AtomicBool,
    progress: &mut Progress,
    limit: usize,
    stats: &mut Stats,
) -> Result<Writer, String> {
    let total: usize = sheets.iter().map(|(_, d)| d.rows.len()).sum();
    progress.total = Some(total.min(limit));
    let mut writer: Option<Writer> = None;
    for (name, data) in &sheets {
        transfer::validate_rows(data)?;
        if req.format == TransferFormat::Update {
            transfer::validate_update(data, &req.options)?;
        }
        let mut options = req.options.clone();
        if multi {
            options.column_indices.clear();
            options.column_labels.clear();
            options.keys.clear();
        }
        let layout = Layout::new(&data.columns, &options)?;
        if matches!(
            req.format,
            TransferFormat::Insert | TransferFormat::Update | TransferFormat::Condition
        ) {
            transfer::validate_sql_layout(&data.columns, &layout, &options, req.format)?;
            for row in &data.rows {
                transfer::validate_sql_row(row, &data.columns, &layout.indices)?;
            }
        }
        let count = data.rows.len().min(limit.saturating_sub(stats.rows));
        let query = data.query.as_deref().unwrap_or(&req.sql);
        if options.transpose {
            return write_transposed(req, data, &layout, path, cancel, progress, limit, stats);
        }
        if let Some(Writer::Xlsx(x)) = &mut writer {
            x.begin_sheet(
                name,
                layout.columns.clone(),
                transfer::header_rows(&layout.columns, &layout.labels, &options.header),
            )?;
            if options.include_query && !query.is_empty() {
                x.add_note(format!("{name} 查询：{query}"));
            }
        } else if writer.is_none() {
            writer = Some(Writer::new(
                path, req.format, &layout, &options, query, name,
            )?);
        }
        let w = writer.as_mut().ok_or("导出写入器没有建立")?;
        if req.format == TransferFormat::Condition {
            if cancel.load(Ordering::SeqCst) {
                stats.canceled = true;
                break;
            }
            let text = transfer::condition_text(data, &layout, &options, count)?;
            if let Writer::Text(out) = w {
                out.raw(&text)?;
            }
            stats.rows += count;
        } else {
            for (i, row) in data.rows.iter().take(count).enumerate() {
                if cancel.load(Ordering::SeqCst) {
                    stats.canceled = true;
                    break;
                }
                if req.format == TransferFormat::Update {
                    if let Writer::Text(out) = w {
                        out.push_update(
                            row,
                            &data.original_rows.as_ref().unwrap()[i],
                            &data.columns,
                            &layout.indices,
                        )?;
                    }
                } else {
                    w.push(&layout.row(row))?;
                }
                count_long(row, stats);
                stats.rows += 1;
                progress.emit(stats.rows, w.bytes(), "writing", false);
            }
        }
        progress.emit(stats.rows, w.bytes(), "writing", false);
        if stats.canceled || stats.rows >= limit {
            break;
        }
    }
    stats.truncated = !stats.canceled && stats.rows < total;
    writer.ok_or("结果集为空或没有列元数据".into())
}

#[allow(clippy::too_many_arguments)]
fn write_transposed(
    req: &TransferReq,
    data: &TransferData,
    layout: &Layout,
    path: &Path,
    cancel: &AtomicBool,
    progress: &mut Progress,
    limit: usize,
    stats: &mut Stats,
) -> Result<Writer, String> {
    let count = data.rows.len().min(limit);
    let (l, headers) = transfer::transpose_columns(data, layout, &req.options, count);
    if l.columns.is_empty() && req.format == TransferFormat::Xlsx {
        return Err("转置后没有可写入 XLSX 的列".into());
    }
    let mut options = req.options.clone();
    options.header = "none".into();
    let mut w = Writer::new(
        path,
        req.format,
        &l,
        &options,
        data.query.as_deref().unwrap_or(&req.sql),
        "查询结果",
    )?;
    progress.total = Some(layout.indices.len());
    for j in 0..layout.indices.len() {
        if cancel.load(Ordering::SeqCst) {
            stats.canceled = true;
            break;
        }
        let row = transfer::transposed_row(data, layout, &headers, &req.options, count, j);
        w.push(&row)?;
        stats.rows += 1;
        progress.emit(stats.rows, w.bytes(), "writing", false);
    }
    stats.truncated = count < data.rows.len();
    Ok(w)
}

fn bridge_call(
    handle: &EngineHandle,
    cmd: &str,
    args: &[String],
    timeout: u32,
) -> Result<Value, String> {
    let refs: Vec<_> = args.iter().map(String::as_str).collect();
    handle
        .call(cmd, &refs, Duration::from_secs(u64::from(timeout) + 30))
        .map_err(|e| super::db_cmds::map_sql_error(&e.message))
}
/// 重查导出用的取数命令。
///
/// 走 `execFull*`（单值上限 1M 的全量通道），不能用 `exec`/`execBound`：那条是网格的
/// 8K 预览通道，超长 CLOB 会带一句「…只取前 8192 个字符」的中文尾巴，而这条路把值直接
/// 拼进 INSERT/UPDATE/WHERE 脚本或数据文件——等于把提示文案当成数据写出去。
fn exec_args(
    req: &TransferReq,
    page: usize,
    timeout: u32,
) -> Result<(&'static str, Vec<String>), String> {
    let mut args = vec![req.sql.clone(), page.to_string(), timeout.to_string()];
    let Some(params) = req.params.as_ref().filter(|p| !p.is_empty()) else {
        return Ok(("execFull", args));
    };
    for v in params {
        let (kind, text) = bound_param(v)?;
        args.extend([kind.into(), text]);
    }
    Ok(("execFullBound", args))
}
pub(crate) fn bound_param(v: &Value) -> Result<(&'static str, String), String> {
    match v {
        Value::Null => Ok(("null", String::new())),
        Value::String(s) => Ok(("string", s.clone())),
        Value::Number(n) => Ok(("number", n.to_string())),
        Value::Bool(b) => Ok(("bool", b.to_string())),
        Value::Object(o) if o.len() == 1 => {
            let s = o
                .get("number")
                .and_then(Value::as_str)
                .ok_or("绑定参数必须是单值")?;
            if s.trim() != s || s.is_empty() || !s.parse::<f64>().is_ok_and(f64::is_finite) {
                return Err("数字绑定参数无效".into());
            }
            Ok(("number", s.into()))
        }
        _ => Err("绑定参数必须是单值".into()),
    }
}
fn validate_params(params: &[Value]) -> Result<(), String> {
    for v in params {
        bound_param(v)?;
    }
    Ok(())
}
fn parse_columns(body: &Value) -> Result<Vec<TransferColumn>, String> {
    let arr = body
        .get("columns")
        .and_then(Value::as_array)
        .ok_or("结果集没有列元数据")?;
    let mut columns = Vec::with_capacity(arr.len());
    for c in arr {
        columns.push(serde_json::from_value(c.clone()).map_err(|_| "结果集列元数据无效")?);
    }
    if columns.is_empty() {
        return Err("结果集没有列元数据".into());
    }
    Ok(columns)
}
fn page_rows(body: &Value) -> Result<&Vec<Value>, String> {
    body.get("rows")
        .and_then(Value::as_array)
        .ok_or_else(|| "数据库桥未返回结果行".to_string())
}
#[allow(clippy::too_many_arguments)]
fn write_remote(
    req: &TransferReq,
    handle: &EngineHandle,
    timeout: u32,
    path: &Path,
    cancel: &AtomicBool,
    progress: &mut Progress,
    limit: usize,
    stats: &mut Stats,
) -> Result<Writer, String> {
    let (cmd, args) = exec_args(req, PAGE.min(limit), timeout)?;
    let mut body = bridge_call(handle, cmd, &args, timeout)?;
    if body.get("kind").and_then(Value::as_str) != Some("rows") {
        return Err("查询没有返回单个结果集，不能重放为全量导出".into());
    }
    let columns = parse_columns(&body)?;
    let names: Vec<_> = columns.iter().map(|c| c.name.clone()).collect();
    if req.expected_columns.as_ref() != Some(&names) {
        return Err("来源列布局发生变化，请重新执行查询后导出".into());
    }
    let layout = Layout::new(&columns, &req.options)?;
    if req.format == TransferFormat::Insert {
        transfer::validate_sql_layout(&columns, &layout, &req.options, req.format)?;
    }
    let mut w = Writer::new(
        path,
        req.format,
        &layout,
        &req.options,
        &req.sql,
        "查询结果",
    )?;
    loop {
        if cancel.load(Ordering::SeqCst) {
            stats.canceled = true;
            break;
        }
        let more = body
            .get("hasMore")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let rows = page_rows(&body)?;
        if rows.is_empty() && more {
            return Err("数据库桥返回空页却声称仍有数据，已停止导出".into());
        }
        for row in rows {
            if stats.rows >= limit {
                stats.truncated = true;
                break;
            }
            if cancel.load(Ordering::SeqCst) {
                stats.canceled = true;
                break;
            }
            let row = row.as_array().ok_or("数据库桥返回了无效结果行")?;
            if row.len() != columns.len() {
                return Err("查询行与来源列数不一致，已停止导出".into());
            }
            for v in row {
                transfer::validate_cell(v)?;
            }
            count_long(row, stats);
            w.push(&layout.row(row))?;
            stats.rows += 1;
        }
        progress.emit(stats.rows, w.bytes(), "writing", false);
        if stats.canceled || stats.truncated || !more {
            break;
        }
        if stats.rows >= limit {
            if cancel.load(Ordering::SeqCst) {
                stats.canceled = true;
                break;
            }
            // Drivers may report hasMore when the page is exactly full. Probe EOF before labeling it partial.
            let probe = bridge_call(handle, "more", &["1".into()], timeout)?;
            stats.truncated = probe_has_more(&probe)?;
            break;
        }
        let next = limit.saturating_sub(stats.rows).min(PAGE);
        // Each loop iteration blocks in bounded network IO; EOF/error always exits, with no polling spin.
        body = bridge_call(handle, "more", &[next.to_string()], timeout)?;
    }
    Ok(w)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frozen_connection_target_survives_renames_but_rejects_other_accounts() {
        let mut conn: crate::config::DbConnConfig = serde_json::from_value(
            json!({"id":"c","name":"测试","source":"manual","url":"jdbc:test","user":"NC"}),
        )
        .unwrap();
        let expected = json!(["jdbc:test", "NC", "java", "manual", null]).to_string();
        assert!(validate_source_connection(Some(&expected), &conn).is_ok());
        conn.name = "已改名".into();
        assert!(validate_source_connection(Some(&expected), &conn).is_ok());
        conn.user = "OTHER".into();
        assert!(validate_source_connection(Some(&expected), &conn).is_err());
        assert!(validate_source_connection(Some("invalid"), &conn).is_err());
        assert!(validate_source_connection(None, &conn).is_ok());
    }
    #[test]
    fn bound_precision_preserved_and_complex_values_rejected() {
        let v = json!({"number":"123456789012345678901234567890.1234"});
        assert_eq!(
            bound_param(&v).unwrap(),
            ("number", "123456789012345678901234567890.1234".into())
        );
        assert!(bound_param(&json!({"number":"NaN"})).is_err());
        assert!(bound_param(&json!([1, 2])).is_err());
    }
    #[test]
    fn cancellation_instances_do_not_collide_and_cleanup_on_errors() {
        let d = tempfile::tempdir().unwrap();
        let st = AppState::new(crate::config::AppConfig::default(), d.path().to_path_buf());
        let a = CancelRegistration::register(st.clone(), 1).unwrap();
        let b = CancelRegistration::register(st.clone(), 2).unwrap();
        a.token.store(true, Ordering::SeqCst);
        assert!(!b.token.load(Ordering::SeqCst));
        assert!(CancelRegistration::register(st.clone(), 1).is_err());
        drop(a);
        assert!(!st.export_cancels.lock().unwrap().contains_key(&1));
        drop(b);
    }
    #[test]
    fn column_order_is_exact_and_empty_metadata_rejected() {
        assert!(parse_columns(&json!({"columns":[]})).is_err());
        let cols=parse_columns(&json!({"columns":[{"name":"A","type":"NUMBER","precision":20,"scale":0},{"name":"B","type":"VARCHAR2"}]})).unwrap();
        assert_eq!(cols[0].precision, Some(20));
        assert_eq!(cols[1].name, "B");
    }
    #[test]
    fn exact_limit_eof_is_complete_and_extra_row_is_partial() {
        assert!(!probe_has_more(&json!({"rows":[],"hasMore":false})).unwrap());
        assert!(probe_has_more(&json!({"rows":[[1]],"hasMore":true})).unwrap());
        assert!(probe_has_more(&json!({"rows":[],"hasMore":true})).is_err());
    }
}
