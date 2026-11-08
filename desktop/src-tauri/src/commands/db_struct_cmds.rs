//! 表结构对比（DDL diff）：两侧各开一条临时只读会话读数据字典，比对与 DDL 生成在
//! [`crate::db_struct`] 里做（纯逻辑，有单测）。
//!
//! **为什么两侧都开临时会话**：对比经常是「这个连接 vs 另一个连接」，用 primary 会话会
//! 把用户正在编辑的未提交改动牵进来；临时会话跑完即断，也不影响事务条。
//!
//! 只读：这里只发 4 条数据字典 select，不执行任何 DDL。生成的脚本回传给界面由人自己跑。

use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;

use crate::commands::db_cmds::{call, drop_bridge, find_conn, open_temp_session};
use crate::db_conns::valid_schema;
use crate::db_engine::{EngineHandle, EngineKind};
use crate::db_struct::{
    body_rows, columns_sql, comment_sql, diff, drop_pk_index, indexes_sql, parse_columns,
    parse_indexes, parse_pk, pk_sql, StructDiff, TableStruct,
};
use crate::state::AppState;

/// 数据字典查询超时。字典视图偶尔被 DDL 锁住，但不该等太久。
const META_TIMEOUT: Duration = Duration::from_secs(60);
/// 元数据取多少行就够：一张表最多 1000 列、几十个索引，2000 行有富余。
const META_ROWS: &str = "2000";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructSide {
    pub id: String,
    pub owner: String,
    pub table: String,
}

/// 比两张表的结构。`left` 是基准——脚本把 `right` 改成 `left` 的样子。
#[tauri::command]
pub async fn db_struct_diff(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    left: StructSide,
    right: StructSide,
) -> Result<StructDiff, String> {
    let st = state.inner().clone();
    let cfg = st.config.read().await.clone();
    let l = read_side(&app, &st, &cfg, &left).await?;
    let r = read_side(&app, &st, &cfg, &right).await?;
    Ok(diff(l, r))
}

async fn read_side(
    app: &tauri::AppHandle,
    st: &AppState,
    cfg: &crate::config::AppConfig,
    side: &StructSide,
) -> Result<TableStruct, String> {
    let owner = side.owner.trim().to_ascii_uppercase();
    let table = side.table.trim().to_ascii_uppercase();
    if !valid_schema(&owner) {
        return Err(format!("schema 名不合法：{}", side.owner));
    }
    if !valid_schema(&table) {
        return Err(format!("表名不合法：{}", side.table));
    }
    let conn = find_conn(cfg, &side.id)?;
    let engine = EngineKind::parse(&conn.engine);
    let (key, bridge) = open_temp_session(app, st, cfg, &conn, engine, "struct")
        .await
        .ok_or_else(|| {
            format!(
                "开不了读取 {} 结构用的会话（连接没连上或口令失效）",
                side.id
            )
        })?;

    let out = read_struct(&bridge, &owner, &table).await;
    // 成败都断开：留着临时会话会白占一个库会话
    drop_bridge(st, &key);
    out
}

async fn read_struct(
    bridge: &Arc<EngineHandle>,
    owner: &str,
    table: &str,
) -> Result<TableStruct, String> {
    let col_rows = query(bridge, columns_sql(owner, table)).await?;
    if col_rows.is_empty() {
        return Err(format!(
            "{owner}.{table} 在库里不存在（或者是当前账号看不到的对象）"
        ));
    }
    let (pk_name, pk) = parse_pk(&query(bridge, pk_sql(owner, table)).await?);
    let indexes = drop_pk_index(
        parse_indexes(&query(bridge, indexes_sql(owner, table)).await?),
        &pk,
    );
    let comment = query(bridge, comment_sql(owner, table))
        .await?
        .first()
        .and_then(|r| r.first().cloned().flatten())
        .filter(|c| !c.trim().is_empty());

    Ok(TableStruct {
        label: format!("{owner}.{table}"),
        columns: parse_columns(&col_rows),
        pk,
        pk_name,
        indexes,
        comment,
    })
}

async fn query(
    bridge: &Arc<EngineHandle>,
    sql: String,
) -> Result<Vec<Vec<Option<String>>>, String> {
    let body = call(
        bridge.clone(),
        "exec",
        vec![sql, META_ROWS.into(), "60".into()],
        META_TIMEOUT,
    )
    .await?;
    body_rows(&body)
}
