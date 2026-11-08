//! 表 → 表 直连搬运（A 库表 → B 库表）：不落文件中转，边读边写。
//!
//! NC 现场搬基础数据（建账套、测试库刷数据）目前的路径是「导出成脚本 → 到另一个库跑」，
//! 中间那个文件既是手工步骤也是失真点（编码、日期格式、CLOB 截断）。这里直接两条会话对着搬。
//!
//! 三条设计约束：
//! 1. **两条临时会话**：源只读、目标自管事务。绝不借 primary——用户在自己标签里未提交的
//!    改动不能被这次搬运连带提交。
//! 2. **逐批提交**：每 `BATCH` 行一个事务。中途失败时前面的批已经在目标库里，返回结果里
//!    `copied` 就是真实落库行数——不能让用户以为「失败了所以一行都没进去」。
//! 3. **LOB 列直接拒绝**：源表读取虽然走 `execFull` 全量通道，但 CLOB 仍有 1M 上限，
//!    超限会挂上「只取前 1M」的中文标记。搬运是照着结果集文本拼 insert 的，那句标记
//!    会被当成正文写进目标库。宁可明确报错让人走导出脚本，也不给「看起来成功」的半个字段。
//!
//! 值一律按目标列类型拼字面量（复用 [`crate::sql_export::literal`]，与导入/导出同一条规则）。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::Emitter;

use crate::commands::db_cmds::{call, drop_bridge, find_conn, open_temp_session_tx};
use crate::db_conns::valid_schema;
use crate::db_engine::{EngineHandle, EngineKind};
use crate::sql_export::literal;
use crate::state::AppState;

/// 一批多少行提交一次。太大则中途失败丢得多，太小则提交次数太多拖慢。
const BATCH: usize = 200;
/// 源表每页取多少行。与导出同量级：一页几百行不会把内存顶起来。
const PAGE: &str = "500";
/// 单条 insert 的超时。
const T_EXEC: Duration = Duration::from_secs(120);
/// 取页超时。
const T_PAGE: Duration = Duration::from_secs(300);
/// 搬运会话名序号。
static SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    pub id: String,
    pub owner: String,
    pub table: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferRowsReq {
    pub from: Endpoint,
    pub to: Endpoint,
    /// 源里的过滤条件（拼在 `where` 后面）；含分号直接拒绝。
    pub filter: Option<String>,
    /// `append`（默认）/ `replace`（先清空目标表）。
    pub mode: Option<String>,
    pub transfer_id: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnPair {
    pub from: String,
    pub to: String,
    /// 目标列类型（拼字面量用），如 `DATE` / `NUMBER`。
    pub ty: String,
}

/// 搬运计划：同名同序的列会被搬，其余留在源里。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferPlan {
    pub pairs: Vec<ColumnPair>,
    /// 源有、目标没有的列（不搬）。
    pub skipped: Vec<String>,
    /// 目标有、源没有的列（写 null）。只用来提示，不阻断。
    pub extra: Vec<String>,
    /// 两侧都有的 LOB 列（有值就搬不了，见模块注释）。
    pub lobs: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferRowsOut {
    pub copied: usize,
    pub batches: usize,
    pub cleared: bool,
    pub canceled: bool,
    pub ms: u64,
}

/// 只读地算一遍计划：界面在真正搬运前要把「搬哪些列、哪些不搬」给人看。
#[tauri::command]
pub async fn db_transfer_plan(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    from: Endpoint,
    to: Endpoint,
) -> Result<TransferPlan, String> {
    let st = state.inner().clone();
    let cfg = st.config.read().await.clone();
    let src = read_columns(&app, &st, &cfg, &from).await?;
    let dst = read_columns(&app, &st, &cfg, &to).await?;
    Ok(plan_pairs(&src, &dst))
}

#[tauri::command]
pub async fn db_transfer_rows(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    req: TransferRowsReq,
) -> Result<TransferRowsOut, String> {
    let st = state.inner().clone();
    let t0 = Instant::now();
    let cfg = st.config.read().await.clone();
    let filter = req.filter.as_deref().unwrap_or("").trim().to_string();
    check_filter(&filter)?;
    let replace = req
        .mode
        .as_deref()
        .unwrap_or("append")
        .eq_ignore_ascii_case("replace");

    let src_cols = read_columns(&app, &st, &cfg, &req.from).await?;
    let dst_cols = read_columns(&app, &st, &cfg, &req.to).await?;
    let plan = plan_pairs(&src_cols, &dst_cols);
    if plan.pairs.is_empty() {
        return Err("两侧没有同名同序列，无法搬运（先对比结构，或用手工映射）".to_string());
    }
    if !plan.lobs.is_empty() {
        return Err(format!(
            concat!(
                "源表这些列是大对象（{}）：全量取数通道对 CLOB 仍有 1M 上限，超过后会带截断标记，",
                "搬运会把「标记 + 前半段正文」一起写进目标库。请改用「导出 INSERT 脚本」在目标库执行，",
                "或先把这些列排除掉"
            ),
            plan.lobs.join("、")
        ));
    }

    let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
    st.transfer_cancels
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(req.transfer_id, cancel.clone());

    let out = run_transfer(&app, &st, &cfg, &req, &plan, &filter, replace, &cancel).await;
    st.transfer_cancels
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&req.transfer_id);
    out.map(|(copied, batches, cleared, canceled)| TransferRowsOut {
        copied,
        batches,
        cleared,
        canceled,
        ms: t0.elapsed().as_millis() as u64,
    })
}

/// 取消一次搬运：只置标志，当前批写完就停（在飞的 insert 必须知道结果）。
#[tauri::command]
pub fn db_transfer_rows_cancel(state: tauri::State<'_, Arc<AppState>>, id: u64) {
    if let Some(flag) = state
        .transfer_cancels
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&id)
    {
        flag.store(true, Ordering::SeqCst);
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_transfer(
    app: &tauri::AppHandle,
    st: &AppState,
    cfg: &crate::config::AppConfig,
    req: &TransferRowsReq,
    plan: &TransferPlan,
    filter: &str,
    replace: bool,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<(usize, usize, bool, bool), String> {
    // 源只读 → 自动提交；目标要逐批 commit / 出错 rollback → 必须关掉自动提交。
    // 用同一个工厂、只差这一个布尔：两边都跟随运行期 schema，不会因为搬运跑到别的库。
    let src = open(app, st, cfg, &req.from, true).await?;
    let dst = match open(app, st, cfg, &req.to, false).await {
        Ok(v) => v,
        Err(e) => {
            drop_bridge(st, &src.0);
            return Err(e);
        }
    };
    let result = transfer_inner(app, &src, &dst, req, plan, filter, replace, cancel).await;
    if result.is_err() {
        // 断开时驱动本来就会回滚，但显式做一次：replace 的 delete 可能还在事务里，
        // 不能指望「close 一定回滚」在各引擎各版本上口径一致。
        let _ = call(dst.1.clone(), "rollback", vec![], T_EXEC).await;
    }
    drop_bridge(st, &src.0);
    drop_bridge(st, &dst.0);
    result
}

#[allow(clippy::too_many_arguments)]
async fn transfer_inner(
    app: &tauri::AppHandle,
    src: &(String, Arc<EngineHandle>),
    dst: &(String, Arc<EngineHandle>),
    req: &TransferRowsReq,
    plan: &TransferPlan,
    filter: &str,
    replace: bool,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<(usize, usize, bool, bool), String> {
    let target = format!("{}.{}", ident(&req.to.owner), ident(&req.to.table));
    let mut cleared = false;
    if replace {
        call(
            dst.1.clone(),
            "exec",
            vec![format!("delete from {target}")],
            T_EXEC,
        )
        .await
        .map_err(|e| format!("清空目标表失败：{e}"))?;
        cleared = true;
    }

    let select = format!(
        "select {} from {}.{}{}",
        plan.pairs
            .iter()
            .map(|p| ident(&p.from))
            .collect::<Vec<_>>()
            .join(", "),
        ident(&req.from.owner),
        ident(&req.from.table),
        if filter.is_empty() {
            String::new()
        } else {
            format!(" where {filter}")
        }
    );

    // 🔴 源表读取走全量通道：只搬 8K 预览的 CLOB 会静默丢掉正文。
    // 目标表的 delete / 插入和列元数据查询都不涉及 CLOB 取数，保持普通 exec。
    let mut body = call(
        src.1.clone(),
        "execFull",
        vec![select, PAGE.to_string(), "300".to_string()],
        T_PAGE,
    )
    .await
    .map_err(|e| format!("读源表失败：{e}"))?;
    if body.get("kind").and_then(|k| k.as_str()) != Some("rows") {
        return Err("源表查询没有返回结果集".to_string());
    }

    let mut pending: Vec<Vec<Option<String>>> = Vec::new();
    let mut copied = 0usize;
    let mut batches = 0usize;
    let mut canceled = false;
    loop {
        if cancel.load(Ordering::SeqCst) {
            canceled = true;
            break;
        }
        let has_more = body
            .get("hasMore")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        for row in body
            .get("rows")
            .and_then(|r| r.as_array())
            .into_iter()
            .flatten()
        {
            let cells: Vec<Option<String>> = row
                .as_array()
                .map(|a| a.iter().map(text_of).collect())
                .unwrap_or_default();
            pending.push(cells);
            if pending.len() >= BATCH {
                copied += flush(app, dst, &target, plan, &mut pending, req.transfer_id).await?;
                batches += 1;
            }
        }
        if !has_more {
            break;
        }
        body = call(src.1.clone(), "more", vec![PAGE.to_string()], T_PAGE)
            .await
            .map_err(|e| format!("继续读源表失败：{e}"))?;
    }
    if !pending.is_empty() {
        copied += flush(app, dst, &target, plan, &mut pending, req.transfer_id).await?;
        batches += 1;
    }
    // 空表 + 清空模式：delete 也要落地，否则用户以为表被清了
    call(dst.1.clone(), "commit", vec![], T_EXEC)
        .await
        .map_err(|e| format!("提交失败：{e}"))?;
    Ok((copied, batches, cleared, canceled))
}

/// 把攒下的行逐条写进目标库，然后提交。返回写成功的行数。
async fn flush(
    app: &tauri::AppHandle,
    dst: &(String, Arc<EngineHandle>),
    target: &str,
    plan: &TransferPlan,
    rows: &mut Vec<Vec<Option<String>>>,
    transfer_id: u64,
) -> Result<usize, String> {
    let mut done = 0usize;
    for row in rows.drain(..) {
        let sql = insert_sql(target, plan, &row);
        match call(dst.1.clone(), "exec", vec![sql], T_EXEC).await {
            Ok(_) => done += 1,
            Err(e) => {
                let _ = call(dst.1.clone(), "rollback", vec![], T_EXEC).await;
                let _ = app.emit(
                    "db:transfer-progress",
                    serde_json::json!({ "rows": done, "failed": true, "transferId": transfer_id }),
                );
                return Err(format!("第 {} 行写入失败，本批已回滚：{e}", done + 1));
            }
        }
    }
    call(dst.1.clone(), "commit", vec![], T_EXEC)
        .await
        .map_err(|e| format!("提交本批失败（{done} 行未落库）：{e}"))?;
    let _ = app.emit(
        "db:transfer-progress",
        serde_json::json!({ "rows": done, "transferId": transfer_id }),
    );
    Ok(done)
}

/// 一条 insert。值按目标列类型走 `literal`，与导入/导出同一套日期与数字写法。
pub fn insert_sql(target: &str, plan: &TransferPlan, row: &[Option<String>]) -> String {
    let cols: Vec<String> = plan.pairs.iter().map(|p| ident(&p.to)).collect();
    let vals: Vec<String> = plan
        .pairs
        .iter()
        .enumerate()
        .map(|(i, p)| match row.get(i).and_then(|v| v.as_deref()) {
            // 空串在 Oracle 里就是 NULL，显式写 null 更诚实
            Some(s) if !s.is_empty() => literal(Some(s), &p.ty),
            _ => "null".to_string(),
        })
        .collect();
    format!(
        "insert into {target} ({}) values ({})",
        cols.join(", "),
        vals.join(", ")
    )
}

/// 过滤条件只拼在 `where` 后面，所以分号必须挡掉（多语句），DML 开头也挡掉
/// ——这不是安全边界（源会话只读、账号权限才是），而是别让人把 `delete` 手滑贴进来。
pub fn check_filter(filter: &str) -> Result<(), String> {
    if filter.contains(';') {
        return Err("过滤条件里不能有分号（只支持单个 where 表达式）".to_string());
    }
    let head = filter.trim_start().to_ascii_lowercase();
    for kw in [
        "delete ",
        "update ",
        "insert ",
        "drop ",
        "truncate ",
        "alter ",
        "commit",
        "rollback",
    ] {
        if head.starts_with(kw) {
            return Err("过滤条件只能是 where 表达式，不能是另一条语句".to_string());
        }
    }
    Ok(())
}

/// 两侧列清单求交：按列名（大小写不敏感）配对，顺序跟源表。
pub fn plan_pairs(src: &[(String, String)], dst: &[(String, String)]) -> TransferPlan {
    let mut pairs = Vec::new();
    let mut skipped = Vec::new();
    let mut lobs = Vec::new();
    for (name, ty) in src {
        match dst.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)) {
            Some((to, dst_ty)) => {
                if is_lob(ty) {
                    lobs.push(name.clone());
                }
                pairs.push(ColumnPair {
                    from: name.clone(),
                    to: to.clone(),
                    ty: dst_ty.clone(),
                });
            }
            None => skipped.push(name.clone()),
        }
    }
    let extra = dst
        .iter()
        .filter(|(n, _)| !src.iter().any(|(s, _)| s.eq_ignore_ascii_case(n)))
        .map(|(n, _)| n.clone())
        .collect();
    TransferPlan {
        pairs,
        skipped,
        extra,
        lobs,
    }
}

fn is_lob(ty: &str) -> bool {
    let t = ty.trim().to_ascii_uppercase();
    matches!(
        t.as_str(),
        "CLOB" | "NCLOB" | "BLOB" | "LONG" | "LONG RAW" | "XMLTYPE"
    )
}

/// 标识符加双引号（表里存的都是大写，加引号正好对上；内部引号翻倍防拼断）。
fn ident(raw: &str) -> String {
    format!("\"{}\"", raw.trim().replace('"', "\"\""))
}

async fn open(
    app: &tauri::AppHandle,
    st: &AppState,
    cfg: &crate::config::AppConfig,
    ep: &Endpoint,
    auto_commit: bool,
) -> Result<(String, Arc<EngineHandle>), String> {
    let conn = find_conn(cfg, &ep.id)?;
    let engine = EngineKind::parse(&conn.engine);
    // 名字要能进 SQL：owner 走 schema 校验，表名同字符集
    for v in [&ep.owner, &ep.table] {
        if !valid_schema(v.trim()) {
            return Err(format!("名字不合法：{v}"));
        }
    }
    let kind = format!("transfer{}", SEQ.fetch_add(1, Ordering::Relaxed));
    open_temp_session_tx(app, st, cfg, &conn, engine, &kind, auto_commit)
        .await
        .ok_or_else(|| format!("开不了搬运用的会话（{} 没连上或口令失效）", ep.id))
}

/// 读一侧的 `(列名, 类型)`。
async fn read_columns(
    app: &tauri::AppHandle,
    st: &AppState,
    cfg: &crate::config::AppConfig,
    ep: &Endpoint,
) -> Result<Vec<(String, String)>, String> {
    let (key, bridge) = open(app, st, cfg, ep, true).await?;
    let sql = format!(
        "select column_name, data_type from all_tab_columns \
         where owner = {} and table_name = {} order by column_id",
        literal(Some(ep.owner.trim()), "VARCHAR2"),
        literal(Some(ep.table.trim()), "VARCHAR2")
    );
    let out = call(
        bridge.clone(),
        "exec",
        vec![sql, "4000".into(), "60".into()],
        T_EXEC,
    )
    .await;
    drop_bridge(st, &key);
    let body = out?;
    let rows = crate::db_struct::body_rows(&body)?;
    if rows.is_empty() {
        return Err(format!(
            "{}.{} 在库里不存在（或者是当前账号看不到的对象）",
            ep.owner, ep.table
        ));
    }
    Ok(rows
        .iter()
        .filter_map(|r| {
            let name = r.first()?.clone()?;
            let ty = r.get(1).and_then(|v| v.clone()).unwrap_or_default();
            Some((name.trim().to_string(), ty.trim().to_string()))
        })
        .collect())
}

fn text_of(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::Null => None,
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        serde_json::Value::Bool(b) => Some(b.to_string()),
        other => Some(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cols(v: &[(&str, &str)]) -> Vec<(String, String)> {
        v.iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect()
    }

    #[test]
    fn 按列名配对_源独有进_skipped_目标独有进_extra() {
        let src = cols(&[("ID", "NUMBER"), ("NAME", "VARCHAR2"), ("MEMO", "VARCHAR2")]);
        let dst = cols(&[("name", "VARCHAR2"), ("ID", "NUMBER"), ("OLD", "DATE")]);
        let p = plan_pairs(&src, &dst);
        // 顺序跟源表：插入语句的列序稳定，出问题好对照
        assert_eq!(
            p.pairs.iter().map(|c| c.from.as_str()).collect::<Vec<_>>(),
            vec!["ID", "NAME"]
        );
        // 目标列名大小写不同也要配上，但写回去用目标的写法
        assert_eq!(p.pairs[1].to, "name");
        assert_eq!(p.skipped, vec!["MEMO".to_string()]);
        assert_eq!(p.extra, vec!["OLD".to_string()]);
    }

    #[test]
    fn lob_列被点名_用来挡住整次搬运() {
        let src = cols(&[("ID", "NUMBER"), ("ATTACH", "BLOB"), ("NOTE", "CLOB")]);
        let dst = cols(&[("ID", "NUMBER"), ("ATTACH", "BLOB"), ("NOTE", "CLOB")]);
        let p = plan_pairs(&src, &dst);
        assert_eq!(p.lobs, vec!["ATTACH".to_string(), "NOTE".to_string()]);
    }

    #[test]
    fn insert_按目标类型写字面量_空值写_null() {
        let p = TransferPlan {
            pairs: vec![
                ColumnPair {
                    from: "ID".into(),
                    to: "ID".into(),
                    ty: "NUMBER".into(),
                },
                ColumnPair {
                    from: "MAKEDATE".into(),
                    to: "MAKEDATE".into(),
                    ty: "DATE".into(),
                },
                ColumnPair {
                    from: "MEMO".into(),
                    to: "MEMO".into(),
                    ty: "VARCHAR2".into(),
                },
            ],
            skipped: vec![],
            extra: vec![],
            lobs: vec![],
        };
        let sql = insert_sql(
            "\"NC65\".\"BD_MATERIAL\"",
            &p,
            &[Some("7".into()), Some("2026-11-08 10:00:00".into()), None],
        );
        assert_eq!(
            sql,
            "insert into \"NC65\".\"BD_MATERIAL\" (\"ID\", \"MAKEDATE\", \"MEMO\") values \
             (7, to_date('2026-11-08 10:00:00', 'YYYY-MM-DD HH24:MI:SS'), null)"
        );
    }

    #[test]
    fn 过滤条件挡分号与_dml_开头() {
        assert!(check_filter("code like 'A%'").is_ok());
        assert!(check_filter("rownum <= 10").is_ok());
        assert!(check_filter("1=1; delete from t").is_err());
        assert!(check_filter("delete from t").is_err());
        assert!(check_filter("  DELETE from t").is_err());
    }
}
