//! 把一张表（或一条 select）的数据导出成 `insert` 脚本。
//!
//! **为什么要单独开一个会话**：导出要把游标读到空，会吃掉连接上「加载更多」用的那个游标。
//! 所以能开新会话就开（同一套配置、同一条口令），只读跑完立刻断开；只有拿不到口令
//! （手动连接且没勾「记住」）时才退回复用现有句柄——那时控制台的「加载更多」会失效，
//! 这是有意的降级，比导不出脚本好。
//!
//! **为什么导出是后端做的**：结果网格里只有当前一页（默认 500 行），前端拼 `insert` 等于
//! 「导出你看见的那点数据」。这里要的是整表，还得拿到主键与 blob/多语列的元数据。
//!
//! 三条格式规则在 [`crate::sql_export`]，那边是纯函数、有单测；这里只负责取数与拼装。

use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::commands::db_cmds::{
    bridge_for, call, connect_args, drop_bridge, existing_bridge, find_conn, prop_password_ready,
    PROBE, T_CONNECT,
};
use crate::config::{AppConfig, DbConnConfig};
use crate::db_engine::{EngineHandle, EngineKind};
use crate::db_file_export::{safe_file_name, Format, RowWriter};
use crate::sql_export::{self, ColMeta, Plan, ResultCol};
use crate::state::AppState;

/// 一页取多少行。页太小则往返多，太大则单个 IPC 报文过重。
const PAGE: usize = 5000;
/// 行数默认上限。整表几十万行的场景要走 `exp`，不是这里。
const MAX_ROWS_DEFAULT: usize = 5000;
const MAX_ROWS_LIMIT: usize = 100_000;
/// 与 `db_rust` / Java 桥的 CLOB 读取上限一致：到了这个长度说明值被截断了。
const CLOB_LIMIT: usize = 1024 * 1024;
/// 会话名的序号，避免两次导出撞同一个临时会话。
static SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportInsertReq {
    pub id: String,
    /// 取数语句。整表导出就是 `select * from <表>`。
    pub sql: String,
    /// 目标表名：脚本 `insert into` 后面写的那个（通常与源表同名）。
    pub table: String,
    pub schema: Option<String>,
    /// `false` = 不按 NC 多语约定处理，`X2`..`X6` 原样导出。
    pub multilang: Option<bool>,
    /// 每 N 行插一条 `commit;`，0 = 不插。
    pub commit_every: Option<usize>,
    pub max_rows: Option<usize>,
    pub timeout_sec: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportInsertOut {
    pub file_name: String,
    pub sql_text: String,
    pub rows: usize,
    /// 达到行数上限还有剩余（脚本不是全量）。
    pub truncated: bool,
    pub blob_nulls: usize,
    pub ml_tildes: usize,
    /// 识别到的多语列族，如 `name（跳过 name2..name6）`。
    pub multilang: Vec<String>,
    /// 因多语规则被丢掉的列名。
    pub dropped: Vec<String>,
    pub warnings: Vec<String>,
    pub ms: u64,
}

/// 把一张表（或一条 select）的数据导出成 `insert` 脚本。
#[tauri::command]
pub async fn db_export_insert(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    req: ExportInsertReq,
) -> Result<ExportInsertOut, String> {
    let st = state.inner().clone();
    let cfg = st.config.read().await.clone();
    let t0 = Instant::now();
    let mut conn = find_conn(&cfg, &req.id)?;
    let engine = EngineKind::parse(&conn.engine);
    if engine != EngineKind::Java && conn.source == "prop" {
        // 纯 Rust 驱动解不了 prop.xml：第一次得让 JVM 解一次再落 DPAPI，和连库时同一套
        prop_password_ready(&app, &st, &cfg, &mut conn, None, PROBE).await?;
    }

    let timeout = req.timeout_sec.unwrap_or(300).clamp(5, 3600);
    let max_rows = req
        .max_rows
        .unwrap_or(MAX_ROWS_DEFAULT)
        .clamp(1, MAX_ROWS_LIMIT);
    let sql = req.sql.trim().to_string();
    if sql.is_empty() {
        return Err("取数语句是空的".to_string());
    }

    // 优先独立会话；拿不到口令就退回现有句柄（见模块文档）
    let owned = open_session(&app, &st, &cfg, &conn, engine).await;
    let handle = match &owned {
        Some((_, h)) => h.clone(),
        None => existing_bridge(&st, &req.id).map_err(|_| {
            "导不出来：这个连接还没连上（或口令没记住，开不了临时会话）".to_string()
        })?,
    };

    let res = fetch(&handle, &sql, max_rows, timeout).await;
    // 元数据必须赶在断开临时会话之前读：它走的是同一个句柄，先断再读只会恒为 None
    let meta = match &res {
        Ok(_) => table_meta(&handle, &req.table).await,
        Err(_) => None,
    };
    // 临时会话用完就断，不留在服务端占连接
    if let Some((key, _)) = &owned {
        let _ = call(
            handle.clone(),
            "disconnect",
            vec![],
            Duration::from_secs(10),
        )
        .await;
        drop_bridge(&st, key);
    }
    let fetched = res?;
    let target = sql_export::qualified(req.schema.as_deref(), &req.table);
    let plan = sql_export::build_plan(
        target.clone(),
        &fetched.columns,
        meta.as_deref(),
        req.multilang.unwrap_or(true),
    );
    if plan.cols.is_empty() {
        return Err("结果集里没有可导出的列".to_string());
    }

    let commit_every = req.commit_every.unwrap_or(0).min(100_000);
    let (body, stats) = sql_export::render(&plan, &fetched.rows, commit_every);
    let sql_text = assemble(&conn, &target, &plan, &body, commit_every, stats.rows);

    let mut warnings = Vec::new();
    if fetched.truncated {
        warnings.push(format!(
            "行数到了上限 {max_rows}，脚本只是前 {max_rows} 行；要全量就调大上限，或用 where 把范围收窄"
        ));
    }
    if fetched.long_values > 0 {
        warnings.push(format!(
            "有 {} 个值达到 1MB 读取上限被截断，脚本里的这些值不完整",
            fetched.long_values
        ));
    }
    if plan.ml.is_empty() && req.multilang.unwrap_or(true) && meta.is_some() {
        warnings.push("没识别到多语列（基础列 + X2..X6 至少 3 列才算）".to_string());
    }
    if meta.is_none() {
        // 没有元数据 = 没有主键、也没有多语判据，脚本会「看起来正常」但少了 '~'。
        // 这种静默降级必须说出来，否则用户拿它去导多语表会丢语种标记。
        warnings.push(format!(
            "读不到 {} 的列元数据：主键前置与多语判定都没生效。检查表名是否与源库一致（Schema 里别写错）",
            req.table
        ));
    }

    Ok(ExportInsertOut {
        file_name: file_name(req.schema.as_deref(), &req.table),
        sql_text,
        rows: stats.rows,
        truncated: fetched.truncated,
        blob_nulls: stats.blob_nulls,
        ml_tildes: stats.ml_tildes,
        multilang: plan
            .ml
            .iter()
            .map(|f| {
                let first = f.skipped.first().cloned().unwrap_or_default();
                let last = f.skipped.last().cloned().unwrap_or_default();
                format!("{}（跳过 {}..{}）", f.base, first, last)
            })
            .collect(),
        dropped: plan.dropped.clone(),
        warnings,
        ms: t0.elapsed().as_millis() as u64,
    })
}

/// 开一个临时会话跑导出。`None` 表示拿不到可直接连接的条件，调用方退回现有句柄。
async fn open_session(
    app: &AppHandle,
    st: &Arc<AppState>,
    cfg: &AppConfig,
    conn: &DbConnConfig,
    engine: EngineKind,
) -> Option<(String, Arc<EngineHandle>)> {
    // 读操作不需要事务：自动提交，跑完断开也不留未提交状态
    let (cmd, args) = connect_args(cfg, conn, None, true, engine).ok()?;
    let key = format!(
        "__export:{}:{}",
        conn.id,
        SEQ.fetch_add(1, Ordering::Relaxed)
    );
    let bridge = bridge_for(app, st, cfg, &key, engine).ok()?;
    match call(bridge.clone(), cmd, args, T_CONNECT).await {
        Ok(_) => Some((key, bridge)),
        Err(_) => {
            drop_bridge(st, &key);
            None
        }
    }
}

struct Fetched {
    columns: Vec<ResultCol>,
    rows: Vec<Vec<String>>,
    truncated: bool,
    /// 长到 CLOB 上限、可能已被截断的值个数。
    long_values: usize,
}

async fn fetch(
    handle: &Arc<EngineHandle>,
    sql: &str,
    max_rows: usize,
    timeout: u32,
) -> Result<Fetched, String> {
    let page = PAGE.min(max_rows).to_string();
    let mut body = call(
        handle.clone(),
        "exec",
        vec![sql.to_string(), page, timeout.to_string()],
        Duration::from_secs(u64::from(timeout) + 30),
    )
    .await?;
    let kind = body.get("kind").and_then(Value::as_str).unwrap_or("");
    if kind != "rows" {
        return Err("这条语句不返回结果集（导出要 select）".to_string());
    }
    let columns: Vec<ResultCol> = body
        .get("columns")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .map(|c| ResultCol {
                    name: c
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    ty: c
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                })
                .collect()
        })
        .unwrap_or_default();
    if columns.is_empty() {
        return Err("结果集没有列元数据，导出不了".to_string());
    }

    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut long_values = 0usize;
    let mut truncated = false;
    loop {
        collect_rows(&body, &mut rows, &mut long_values, max_rows);
        let more = body
            .get("hasMore")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !more {
            break;
        }
        if rows.len() >= max_rows {
            truncated = true;
            break;
        }
        let left = (max_rows - rows.len()).min(PAGE).to_string();
        // `more` 只回 rows（不带 columns），行结构与首页一致，直接接着收
        body = call(handle.clone(), "more", vec![left], Duration::from_secs(300)).await?;
    }
    // 正好卡在上限、且服务端还有更多：也算截断
    if rows.len() >= max_rows && body.get("hasMore").and_then(Value::as_bool) == Some(true) {
        truncated = true;
    }
    Ok(Fetched {
        columns,
        rows,
        truncated,
        long_values,
    })
}

fn collect_rows(
    body: &Value,
    out: &mut Vec<Vec<String>>,
    long_values: &mut usize,
    max_rows: usize,
) {
    let Some(arr) = body.get("rows").and_then(Value::as_array) else {
        return;
    };
    for r in arr {
        if out.len() >= max_rows {
            return;
        }
        let cells: Vec<String> = r
            .as_array()
            .map(|cells| {
                cells
                    .iter()
                    .map(|c| {
                        let s = cell_text(c);
                        if s.as_ref().is_some_and(|v| v.len() >= CLOB_LIMIT) {
                            *long_values += 1;
                        }
                        s.unwrap_or_default()
                    })
                    .collect()
            })
            .unwrap_or_default();
        out.push(cells);
    }
}

fn cell_text(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => Some(v.to_string()),
    }
}

/// 表元数据（类型 / 主键）。读不到就返回 `None`：没有主键与多语判据，脚本照样能生成。
async fn table_meta(handle: &Arc<EngineHandle>, table: &str) -> Option<Vec<ColMeta>> {
    let out = call(
        handle.clone(),
        "columns",
        vec![table.to_string()],
        Duration::from_secs(60),
    )
    .await
    .ok()?;
    let arr = out.get("columns").and_then(Value::as_array)?;
    let cols: Vec<ColMeta> = arr
        .iter()
        .map(|c| ColMeta {
            name: c
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            ty: c
                .get("full")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            pk: c.get("pk").and_then(Value::as_bool).unwrap_or(false),
        })
        .collect();
    if cols.is_empty() {
        None
    } else {
        Some(cols)
    }
}

/// 拼文件头 + 正文 + 收尾 commit。
fn assemble(
    conn: &DbConnConfig,
    target: &str,
    plan: &Plan,
    body: &str,
    commit_every: usize,
    rows: usize,
) -> String {
    let mut out = String::with_capacity(body.len() + 512);
    out.push_str(&format!("-- NCForge 导出：{target}\n"));
    out.push_str(&format!(
        "-- 来源：{}（{}@{}）\n",
        conn.name, conn.user, conn.url
    ));
    out.push_str(&format!(
        "-- {} 行，{} 列；主键前置、blob 写 null、多语列写 '~'\n",
        rows,
        plan.cols.len()
    ));
    if !plan.ml.is_empty() {
        out.push_str("-- 多语列：");
        out.push_str(
            &plan
                .ml
                .iter()
                .map(|f| format!("{}（跳过 {}）", f.base, f.skipped.join("/")))
                .collect::<Vec<_>>()
                .join("，"),
        );
        out.push('\n');
    }
    out.push('\n');
    out.push_str(body);
    // 最后一页没凑满一个 commit 批次时补一条，避免脚本结尾是脏事务
    if rows > 0 && (commit_every == 0 || !rows.is_multiple_of(commit_every)) {
        out.push_str("commit;\n");
    }
    out
}

fn file_name(schema: Option<&str>, table: &str) -> String {
    let safe = |s: &str| -> String {
        s.chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '_' {
                    c
                } else {
                    '_'
                }
            })
            .collect()
    };
    match schema.filter(|s| !s.trim().is_empty()) {
        Some(s) => format!("{}.{}.insert.sql", safe(s), safe(table)),
        None => format!("{}.insert.sql", safe(table)),
    }
}

// ───────────────────────── 流式导出（A4：CSV / TSV / INSERT 写文件） ─────────────────────────

/// 流式导出的分页行数：一次 IPC 传一页。太小往返多，太大单条 JSON 报文复制慢。
const STREAM_PAGE: usize = 5000;
/// 硬上限。再大就不该走这个入口了（该上数据泵），但**不能默默截断**：
/// 到上限时 `truncated=true`，界面明确告诉用户文件不是全量。
const STREAM_MAX_ROWS: usize = 2_000_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportFileReq {
    pub id: String,
    /// 取数语句。
    pub sql: String,
    /// `csv` / `tsv` / `insert`。
    pub format: String,
    /// INSERT 的目标表名（其余格式只用来命名文件）。
    pub table: Option<String>,
    /// 期望的文件名（不含目录）。**时间戳由前端给**：后端没有 chrono，
    /// 自己算成 UTC 会让文件名比用户手表差 8 小时，看起来像 bug。
    pub file_name: Option<String>,
    /// 行数上限；缺省 / 0 = 不限（仍受 [`STREAM_MAX_ROWS`] 约束）。
    pub max_rows: Option<usize>,
    pub timeout_sec: Option<u32>,
    /// 前端给的导出实例号（用于「只取消这一次导出」）。没给就由后端自增。
    #[serde(default)]
    pub export_id: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportFileOut {
    /// 落盘的绝对路径（界面显示「已导出到 …」，并给「打开所在文件夹」）。
    pub path: String,
    pub file_name: String,
    pub rows: usize,
    pub bytes: u64,
    /// 到行数上限还有剩余：文件不是全量。
    pub truncated: bool,
    /// 用户中途取消：已写入的行保留在文件里（是合法前缀，但不是全量）。
    pub canceled: bool,
    pub ms: u64,
}

/// 把一条查询的结果**边读边写**成文件，内存峰值 O(一页)。
///
/// 与 `db_export_insert`（那个要读表元数据、做多语列规则、一次拼出整段文本）的区别：
/// 这里只管「打印结果集」，不碰主键/多语/CLOB 语义，行数可以大得多。
///
/// **一定开独立会话**：导出要把游标读到空，用 primary 会把控制台的「加载更多」吃掉。
/// 开不出来就直接报错，不退回复用 primary——那会让用户在毫无察觉的情况下丢掉游标。
#[tauri::command]
pub async fn db_export_file(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    req: ExportFileReq,
) -> Result<ExportFileOut, String> {
    let st = state.inner().clone();
    let cfg = st.config.read().await.clone();
    let t0 = Instant::now();
    let fmt = Format::parse(&req.format)?;
    let sql = req.sql.trim().to_string();
    if sql.is_empty() {
        return Err("取数语句是空的".to_string());
    }
    let mut conn = find_conn(&cfg, &req.id)?;
    let engine = EngineKind::parse(&conn.engine);
    if engine != EngineKind::Java && conn.source == "prop" {
        prop_password_ready(&app, &st, &cfg, &mut conn, None, PROBE).await?;
    }
    let timeout = req.timeout_sec.unwrap_or(600).clamp(5, 3600);
    let limit = match req.max_rows.unwrap_or(0) {
        0 => STREAM_MAX_ROWS,
        n => n.min(STREAM_MAX_ROWS),
    };
    let table = req
        .table
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .unwrap_or("result");

    let dir = export_dir(&st);
    std::fs::create_dir_all(&dir).map_err(|e| format!("建导出目录失败 {}: {e}", dir.display()))?;
    let name = safe_file_name(req.file_name.as_deref(), table, fmt);
    let path = dir.join(&name);

    let (key, handle) = open_session(&app, &st, &cfg, &conn, engine)
        .await
        .ok_or_else(|| {
            "开不了导出用的独立会话（连接没连上，或手动连接的口令没记住）。请先连上这个库再导出"
                .to_string()
        })?;

    // 每次导出一个独立取消令牌：同时导出两个结果页时，取消 A 不能把 B 也停掉，
    // A 开跑时的复位也不能吞掉 B 刚点的取消（以前共用一个全局 AtomicBool，两个都中招）。
    let export_id = req
        .export_id
        .unwrap_or_else(|| SEQ.fetch_add(1, Ordering::Relaxed));
    let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
    st.export_cancels
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(export_id, cancel.clone());
    let res = stream_to_file(
        &app, &handle, &req.id, &sql, &path, fmt, table, limit, timeout, export_id, &cancel,
    )
    .await;
    st.export_cancels
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&export_id);
    // 导出会话用完就断，不留在服务端占连接
    let _ = call(handle, "disconnect", vec![], Duration::from_secs(10)).await;
    drop_bridge(&st, &key);
    let rows = res?;

    let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    Ok(ExportFileOut {
        path: path.to_string_lossy().to_string(),
        file_name: name,
        rows: rows.rows,
        bytes,
        truncated: rows.truncated,
        canceled: rows.canceled,
        ms: t0.elapsed().as_millis() as u64,
    })
}

/// 用户取消某一次流式导出：只置标志，真正的停止发生在下一页开始前。
///
/// `id` 来自前端（`ExportFileReq.exportId`）。找不到 = 这次导出已经结束，忽略即可；
/// 不能退回「取消所有导出」——那正是旧全局标志的问题。
#[tauri::command]
pub fn db_export_cancel(state: tauri::State<'_, Arc<AppState>>, id: u64) {
    let map = state
        .export_cancels
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some(token) = map.get(&id) {
        token.store(true, Ordering::SeqCst);
    }
}

struct Streamed {
    rows: usize,
    truncated: bool,
    canceled: bool,
}

/// 取第一页 → 逐页写盘 → 每页发一次进度；先写同目录临时文件，成功后再原子改名。
///
/// 不直接写目标文件的原因：中途失败（断连/磁盘满/进程被杀）会留下一个**截断但看起来正常**
/// 的 CSV，用户拿去用才发现少了半张表。临时文件 + 改名保证「出现即完整」；取消时也照常
/// 改名——已写入的行是合法前缀，文件里就是那部分数据。
#[allow(clippy::too_many_arguments)]
async fn stream_to_file(
    app: &AppHandle,
    handle: &Arc<EngineHandle>,
    conn_id: &str,
    sql: &str,
    path: &Path,
    fmt: Format,
    table: &str,
    limit: usize,
    timeout: u32,
    export_id: u64,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<Streamed, String> {
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("export");
    let tmp = path.with_file_name(format!(".{file_name}.{}.nc-tmp", std::process::id()));

    let res: Result<Streamed, String> = async {
        let mut body = call(
            handle.clone(),
            "exec",
            vec![
                sql.to_string(),
                STREAM_PAGE.to_string(),
                timeout.to_string(),
            ],
            Duration::from_secs(u64::from(timeout) + 30),
        )
        .await?;
        if body.get("kind").and_then(Value::as_str) != Some("rows") {
            return Err("这条语句不返回结果集（导出要 select）".to_string());
        }
        let cols = parse_cols(&body)?;

        let file = std::fs::File::create(&tmp)
            .map_err(|e| format!("建临时文件失败 {}: {e}", tmp.display()))?;
        let mut w = RowWriter::new(BufWriter::with_capacity(64 * 1024, file), fmt, cols, table)
            .map_err(|e| format!("写文件头失败：{e}"))?;

        let mut written = 0usize;
        let mut truncated = false;
        let mut canceled = false;
        loop {
            // 已取回的这一页照常写完再停：请求已经发出去，必须知道它成功没有。
            if cancel.load(Ordering::SeqCst) {
                canceled = true;
                break;
            }
            let has_more = body
                .get("hasMore")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            for row in body
                .get("rows")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if written >= limit {
                    truncated = true;
                    break;
                }
                let cells: Vec<Option<String>> = row
                    .as_array()
                    .map(|a| a.iter().map(cell_text).collect())
                    .unwrap_or_default();
                w.push(&cells).map_err(|e| format!("写文件失败：{e}"))?;
                written += 1;
            }
            // 每页一次进度：前端只需要「已经写了多少行」，不需要每一行
            let _ = app.emit(
                "db:export-progress",
                serde_json::json!({ "id": conn_id, "exportId": export_id, "rows": written }),
            );
            if truncated || !has_more {
                break;
            }
            let left = limit.saturating_sub(written).min(STREAM_PAGE);
            body = call(
                handle.clone(),
                "more",
                vec![left.max(1).to_string()],
                Duration::from_secs(u64::from(timeout) + 30),
            )
            .await?;
        }
        let out = w.finish().map_err(|e| format!("收尾写文件失败：{e}"))?;
        // sync_all 必须报出来：它失败说明数据可能还在系统缓存里，而下面马上就要
        // 把它当「已导出」报告给用户。
        let file = out
            .into_inner()
            .map_err(|e| format!("刷新缓冲区失败：{e}"))?;
        file.sync_all()
            .map_err(|e| format!("把导出文件刷到磁盘失败：{e}"))?;
        Ok(Streamed {
            rows: written,
            truncated,
            canceled,
        })
    }
    .await;

    match res {
        Ok(v) => {
            if let Err(e) = std::fs::rename(&tmp, path) {
                let _ = std::fs::remove_file(&tmp);
                return Err(format!(
                    "替换导出文件失败（{} 可能被别的程序占用）：{e}",
                    path.display()
                ));
            }
            Ok(v)
        }
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

fn parse_cols(body: &Value) -> Result<Vec<ResultCol>, String> {
    let cols: Vec<ResultCol> = body
        .get("columns")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .map(|c| ResultCol {
                    name: c
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    ty: c
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                })
                .collect()
        })
        .unwrap_or_default();
    if cols.is_empty() {
        return Err("结果集没有列元数据，导出不了".to_string());
    }
    Ok(cols)
}

/// 导出目录：`{config_dir}/exports`。放配置目录而不是临时目录——
/// 用户点完导出要能找回来，系统清理临时目录时不该把刚导的文件删掉。
pub(crate) fn export_dir(state: &AppState) -> PathBuf {
    state.config_dir.join("exports")
}

/// 在系统文件管理器里定位一个导出文件。
///
/// **只允许导出目录内的路径**：这个命令会调 `opener`，不校验等于给前端一个
/// 「打开任意路径」的入口（前端被注入时后果放大的地方就在这类命令上）。
#[tauri::command]
pub async fn db_export_reveal(
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = export_dir(&state);
    let canon_dir = dir.canonicalize().unwrap_or(dir);
    let canon = std::path::Path::new(&path)
        .canonicalize()
        .map_err(|e| format!("文件不存在或打不开：{e}"))?;
    if !canon.starts_with(&canon_dir) {
        return Err("只能打开导出目录里的文件".to_string());
    }
    // 定位到文件本身：Windows 资源管理器会选中它（打开的是父目录）
    state
        .app_handle
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .ok_or_else(|| "窗口还没准备好".to_string())?
        .opener()
        .reveal_item_in_dir(canon)
        .map_err(|e| format!("打开目录失败：{e}"))
}
