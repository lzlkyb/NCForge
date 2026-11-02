//! 全库按值反查：拿一段文本，在「当前用户所有表的所有文本列」里找它。
//!
//! 纯逻辑（校验、转义、每表一条的查询拼装）在 [`crate::db_value_search`]，这里负责取数：
//!
//! 1. 读表清单与全库列元数据（各一次，分页读完）；
//! 2. 逐表发**一条**查询（命中标志 + 样本值，最多 3 行），命中表按列产出结果；
//! 3. 每表发一次进度事件 `db:value-search-progress`，可随时取消。
//!
//! **一定开独立会话**（开不出来才降级复用现有句柄）：搜索会把游标读到空，
//! 用 primary 会把控制台的「加载更多」吃掉。降级时结果里 `sharedSession=true`，
//! 界面要说出来。
//!
//! **只读**：只发 `SELECT`，不写、不锁表（`SELECT` 在 Oracle 里不会产生需要提交的事务）。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::commands::db_cmds::{
    call, drop_bridge, existing_bridge, find_conn, open_temp_session, prop_password_ready, PROBE,
};
use crate::db_engine::{EngineHandle, EngineKind};
use crate::db_value_search::{self as vs, MatchMode, SearchCol};
use crate::state::{AppState, ValueSearchJob};

/// 字典查询每页行数（`user_tab_columns` 在 NC 库上通常几万行）。
const CATALOG_PAGE: usize = 5000;
/// 字典读取的硬上限：超过说明库大得离谱，按值反查本来也不该走这个入口。
const CATALOG_MAX_ROWS: usize = 500_000;
/// 每张表的错误最多记这么多条，防止一张坏表刷屏。
const MAX_ERRORS: usize = 50;
/// 搜索实例序号（前端不给 `searchId` 时兜底）。
static SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValueSearchReq {
    pub id: String,
    /// 要找的文本（≤200 字符；`%`/`_` 按字面量处理）。
    pub text: String,
    /// 0 包含 / 1 等于 / 2 前缀 / 3 后缀。
    pub mode: u8,
    /// 只看表名包含这段文字的表（不区分大小写）。
    #[serde(default)]
    pub table_filter: Option<String>,
    /// 命中（表+列）上限，到上限就停。
    #[serde(default)]
    pub max_hits: Option<usize>,
    /// 单条查询的超时（秒）。大表全扫要放宽。
    #[serde(default)]
    pub timeout_sec: Option<u32>,
    /// 前端给的搜索实例号：进度事件与取消都按它定位。
    #[serde(default)]
    pub search_id: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValueHit {
    pub table: String,
    pub column: String,
    /// 命中值的样本（最多 200 字符；含不可见字符时界面按原样显示）。
    pub sample: String,
    /// 可以直接复制去跑的 SQL（带 ESCAPE，不是通配符）。
    pub sql: String,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValueSearchOut {
    pub hits: Vec<ValueHit>,
    pub tables_total: usize,
    pub tables_scanned: usize,
    /// 表名/列名不安全或类型不可搜而被跳过的数量（不是错误）。
    pub skipped_tables: usize,
    pub skipped_columns: usize,
    /// 到了命中上限，后面还有表没看。
    pub truncated: bool,
    pub canceled: bool,
    pub errors: Vec<String>,
    /// 没能开独立会话、复用了连接上现有会话（控制台的「加载更多」会失效）。
    pub shared_session: bool,
    pub ms: u64,
}

/// 全库按值反查。进度走 `db:value-search-progress`，取消用 [`db_value_search_cancel`]。
#[tauri::command]
pub async fn db_value_search(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    req: ValueSearchReq,
) -> Result<ValueSearchOut, String> {
    let st = state.inner().clone();
    let t0 = Instant::now();
    let text = vs::validate_text(&req.text)?;
    let mode = MatchMode::parse(req.mode)?;
    let filter = req
        .table_filter
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_uppercase();
    let max_hits = req.max_hits.unwrap_or(500).clamp(1, 5000);
    let timeout = req.timeout_sec.unwrap_or(120).clamp(5, 3600);
    let search_id = req
        .search_id
        .unwrap_or_else(|| SEQ.fetch_add(1, Ordering::Relaxed));

    let cfg = st.config.read().await.clone();
    let mut conn = find_conn(&cfg, &req.id)?;
    let engine = EngineKind::parse(&conn.engine);
    if engine != EngineKind::Java && conn.source == "prop" {
        prop_password_ready(&app, &st, &cfg, &mut conn, None, PROBE).await?;
    }

    let owned = open_temp_session(&app, &st, &cfg, &conn, engine, "search").await;
    let shared_session = owned.is_none();
    let (key, handle) = match owned {
        Some((k, h)) => (Some(k), h),
        None => {
            // 降级复用现有句柄：用户已经连上、但口令没记住时开不出临时会话。
            // 搜索是模态操作，此刻没人用控制台游标；代价写进结果告诉用户。
            let h = existing_bridge(&st, &req.id).map_err(|_| {
                "搜不了：这个连接还没连上，而且开不出临时会话（手动连接的口令没记住）".to_string()
            })?;
            (None, h)
        }
    };

    let cancel = Arc::new(AtomicBool::new(false));
    st.search_cancels
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(
            search_id,
            ValueSearchJob {
                cancel: cancel.clone(),
                engine: handle.clone(),
            },
        );
    let pattern = vs::like_pattern(&text, mode);
    let res = run_search(
        &app, &handle, &req.id, search_id, &pattern, &filter, max_hits, timeout, &cancel,
    )
    .await;
    st.search_cancels
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&search_id);
    if let Some(key) = key {
        let _ = call(handle, "disconnect", vec![], Duration::from_secs(10)).await;
        drop_bridge(&st, &key);
    }
    let mut out = res?;
    out.shared_session = shared_session;
    out.ms = t0.elapsed().as_millis() as u64;
    Ok(out)
}

/// 取消一次按值反查：置标志位，并直接把正在跑的那条查询打断。
///
/// 找不到 = 这次搜索已经结束（或还没登记），忽略即可——不能退化成「取消全部」。
#[tauri::command]
pub async fn db_value_search_cancel(
    state: tauri::State<'_, Arc<AppState>>,
    id: u64,
) -> Result<(), String> {
    let job = state
        .search_cancels
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&id)
        .map(|j| (j.cancel.clone(), j.engine.clone()));
    let Some((cancel, engine)) = job else {
        return Ok(());
    };
    cancel.store(true, Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move || engine.cancel())
        .await
        .map_err(|e| format!("发送取消失败：{e}"))?
        .map_err(|e| format!("发送取消失败：{}", e.message))
}

#[allow(clippy::too_many_arguments)]
async fn run_search(
    app: &AppHandle,
    handle: &Arc<EngineHandle>,
    conn_id: &str,
    search_id: u64,
    pattern: &str,
    filter: &str,
    max_hits: usize,
    timeout: u32,
    cancel: &AtomicBool,
) -> Result<ValueSearchOut, String> {
    emit(app, conn_id, search_id, "catalog", 0, 0, None, 0, 0);

    // 读表清单 / 列元数据期间点取消：真打正在跑的那条查询会带 ORA-01013 回来，
    // 这时的正确结论是「已取消」，不是给用户看一条红色错误。
    let table_rows = match exec_all(handle, vs::TABLES_SQL, timeout, cancel).await {
        Ok(v) => v,
        Err(_) if cancel.load(Ordering::Relaxed) => {
            emit(app, conn_id, search_id, "done", 0, 0, None, 0, 0);
            return Ok(ValueSearchOut {
                canceled: true,
                ..Default::default()
            });
        }
        Err(e) => return Err(e),
    };
    let col_rows = match exec_all(handle, vs::COLUMNS_SQL, timeout, cancel).await {
        Ok(v) => v,
        Err(_) if cancel.load(Ordering::Relaxed) => {
            emit(app, conn_id, search_id, "done", 0, 0, None, 0, 0);
            return Ok(ValueSearchOut {
                canceled: true,
                ..Default::default()
            });
        }
        Err(e) => return Err(e),
    };
    let catalog = vs::build_catalog(&table_rows, &col_rows);
    let tables: Vec<&String> = catalog
        .tables
        .iter()
        .filter(|t| filter.is_empty() || t.contains(filter))
        .collect();
    let total = tables.len();

    let mut out = ValueSearchOut {
        tables_total: total,
        skipped_tables: catalog.skipped_tables,
        skipped_columns: catalog.skipped_columns,
        ..Default::default()
    };
    for (i, table) in tables.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            out.canceled = true;
            break;
        }
        let Some(cols) = catalog.cols.get(*table) else {
            out.tables_scanned += 1;
            continue;
        };
        match scan_table(handle, table, cols, pattern, timeout).await {
            Ok(found) => {
                for (col, sample) in found {
                    let sql = vs::hit_sql(table, &col, pattern).unwrap_or_default();
                    out.hits.push(ValueHit {
                        table: (*table).clone(),
                        column: col,
                        sample,
                        sql,
                    });
                }
            }
            Err(_) if cancel.load(Ordering::Relaxed) => {
                // 取消时被打断的这条查询会返回 ORA-01013：那是「停了」，不是「表坏了」
                out.canceled = true;
                break;
            }
            Err(e) => {
                // 单表失败（权限、坏对象、超时）不中断整批：记下来继续。
                if out.errors.len() < MAX_ERRORS {
                    out.errors.push(format!("{table}：{e}"));
                }
            }
        }
        out.tables_scanned += 1;
        emit(
            app,
            conn_id,
            search_id,
            "table",
            i + 1,
            total,
            Some(table),
            out.hits.len(),
            out.errors.len(),
        );
        if out.hits.len() >= max_hits {
            out.truncated = true;
            break;
        }
    }
    emit(
        app,
        conn_id,
        search_id,
        "done",
        out.tables_scanned,
        total,
        None,
        out.hits.len(),
        out.errors.len(),
    );
    Ok(out)
}

/// 一张表一条查询：`M{i}` 命中标志 + `V{i}` 样本值，最多 [`vs::SAMPLE_ROWS`] 行。
async fn scan_table(
    handle: &Arc<EngineHandle>,
    table: &str,
    cols: &[SearchCol],
    pattern: &str,
    timeout: u32,
) -> Result<Vec<(String, String)>, String> {
    let sql = vs::table_scan_sql(table, cols, pattern)?;
    let body = call(
        handle.clone(),
        "exec",
        vec![sql, vs::SAMPLE_ROWS.to_string(), timeout.to_string()],
        Duration::from_secs(u64::from(timeout) + 30),
    )
    .await?;
    if body.get("kind").and_then(Value::as_str) != Some("rows") {
        return Err("这条查询没有返回结果集".to_string());
    }
    let rows = body
        .get("rows")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let n = cols.len();
    // 命中但取不到值的列（NULL / 读不到）也要留一格，别让它从结果里消失
    let mut samples: Vec<Option<String>> = vec![None; n];
    for row in &rows {
        let Some(cells) = row.as_array() else {
            continue;
        };
        for (i, slot) in samples.iter_mut().enumerate() {
            if !flag_set(cells.get(i)) {
                continue;
            }
            let sample = cell_text(cells.get(n + i)).unwrap_or_default();
            // 第一行可能是空串（CHAR 补空格后又裁掉），后面有非空的就换掉
            match slot {
                None => *slot = Some(sample),
                Some(old) if old.is_empty() && !sample.is_empty() => *slot = Some(sample),
                _ => {}
            }
        }
    }
    Ok(cols
        .iter()
        .zip(samples)
        .filter_map(|(c, s)| s.map(|s| (c.name.clone(), s)))
        .collect())
}

/// 分页读完一个字典查询（`exec` + `more`），受 [`CATALOG_MAX_ROWS`] 与取消标志约束。
async fn exec_all(
    handle: &Arc<EngineHandle>,
    sql: &str,
    timeout: u32,
    cancel: &AtomicBool,
) -> Result<Vec<Vec<String>>, String> {
    let wait = Duration::from_secs(u64::from(timeout) + 30);
    let mut body = call(
        handle.clone(),
        "exec",
        vec![
            sql.to_string(),
            CATALOG_PAGE.to_string(),
            timeout.to_string(),
        ],
        wait,
    )
    .await?;
    if body.get("kind").and_then(Value::as_str) != Some("rows") {
        return Err("读表清单时没有返回结果集".to_string());
    }
    let mut out: Vec<Vec<String>> = Vec::new();
    loop {
        collect(&body, &mut out);
        let more = body.get("hasMore").and_then(Value::as_bool) == Some(true);
        if !more || out.len() >= CATALOG_MAX_ROWS || cancel.load(Ordering::Relaxed) {
            break;
        }
        body = call(handle.clone(), "more", vec![CATALOG_PAGE.to_string()], wait).await?;
    }
    Ok(out)
}

fn collect(body: &Value, out: &mut Vec<Vec<String>>) {
    let Some(rows) = body.get("rows").and_then(Value::as_array) else {
        return;
    };
    for r in rows {
        if out.len() >= CATALOG_MAX_ROWS {
            return;
        }
        out.push(
            r.as_array()
                .map(|cells| {
                    cells
                        .iter()
                        .map(|c| cell_text(Some(c)).unwrap_or_default())
                        .collect()
                })
                .unwrap_or_default(),
        );
    }
}

pub(crate) fn cell_text(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        other => Some(other.to_string()),
    }
}

/// 标志位可能是 JSON 数字、字符串或布尔（两个引擎的序列化不完全一致）。
fn flag_set(v: Option<&Value>) -> bool {
    match v {
        Some(Value::Number(n)) => n.as_i64() == Some(1) || n.as_f64() == Some(1.0),
        Some(Value::String(s)) => {
            let s = s.trim();
            s == "1" || s.eq_ignore_ascii_case("true")
        }
        Some(Value::Bool(b)) => *b,
        _ => false,
    }
}

#[allow(clippy::too_many_arguments)]
fn emit(
    app: &AppHandle,
    conn_id: &str,
    search_id: u64,
    phase: &str,
    done: usize,
    total: usize,
    table: Option<&str>,
    hits: usize,
    errors: usize,
) {
    let _ = app.emit(
        "db:value-search-progress",
        serde_json::json!({
            "id": conn_id,
            "searchId": search_id,
            "phase": phase,
            "done": done,
            "total": total,
            "table": table,
            "hits": hits,
            "errors": errors,
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn 标志位兼容三种序列化() {
        assert!(flag_set(Some(&json!(1))));
        assert!(flag_set(Some(&json!("1"))));
        assert!(flag_set(Some(&json!(true))));
        assert!(!flag_set(Some(&json!(0))));
        assert!(!flag_set(Some(&json!(null))));
        assert!(!flag_set(None));
    }

    #[test]
    fn 单元格文本空值是none() {
        assert_eq!(cell_text(Some(&json!(null))), None);
        assert_eq!(cell_text(Some(&json!("x"))).as_deref(), Some("x"));
        assert_eq!(cell_text(Some(&json!(12))).as_deref(), Some("12"));
    }

    #[test]
    fn 目录分页收集不越过上限() {
        let body = json!({ "rows": [["A"], ["B"]] });
        let mut out = Vec::new();
        collect(&body, &mut out);
        assert_eq!(out, vec![vec!["A".to_string()], vec!["B".to_string()]]);
        // 没有 rows 键的响应（update）什么都不加，也不 panic
        collect(&json!({ "kind": "update" }), &mut out);
        assert_eq!(out.len(), 2);
    }
}
