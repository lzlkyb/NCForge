//! B3：VO 类 → 表 → 字段的反向映射。
//!
//! 正向（表 → VO）早就有：数据字典里每张表都带「实体」一栏。反向没有——
//! 而现场更常见的问法是「我正在看这个 VO，它到底是哪张表、哪个字段」。
//! 数据源是同一张 `md_ormap`（一列一属性一行），入口换成类名而已。
//!
//! 不做命名推断：`CalbdocVO → bd_calbdoc` 这种约定在 NC 里成立九成，
//! 但剩下那一成会让用户对着错误的表改代码。**只认库里真的有的映射**。

use std::sync::Arc;
use std::time::Instant;

use serde::Serialize;
use tauri::State;

use crate::md_dict::{self, TableDict};
use crate::md_dict_sql::{self, TableFilter};
use crate::state::AppState;

use super::md_dict_cmds::{query, resolve};

/// 一个 VO 最多追到几张表。一个 VO 映射多张表是正常结构（主子表），
/// 但几十张就说明类名给得太泛（比如只给了 `IVO`），此时截断并明说。
const MAX_TABLES: usize = 50;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoTableOut {
    /// 用户给的那个类名（原样回显，便于核对是不是选对了）。
    pub class_name: String,
    /// 库里命中的全限定类名。可能不止一个（同名类在不同包）。
    pub vo_names: Vec<String>,
    pub tables: Vec<TableDict>,
    pub notes: Vec<String>,
    pub source: String,
    pub elapsed_ms: u64,
}

/// 查到 VO 对应的表与字段。
#[tauri::command]
pub async fn nc_vo_tables(
    state: State<'_, Arc<AppState>>,
    id: Option<String>,
    class_name: String,
) -> Result<VoTableOut, String> {
    let started = Instant::now();
    let (b, url, user) = resolve(&state, id.as_deref()).await?;
    let mut notes: Vec<String> = Vec::new();

    let sql = md_dict_sql::vo_tables_sql(&class_name)?;
    let grid = query(b.clone(), sql, &["cname", "tid", "tname"]).await?;

    let mut vo_names: Vec<String> = Vec::new();
    let mut table_names: Vec<String> = Vec::new();
    for row in grid.iter() {
        // 全限定名更适合当「这是哪个类」的凭据；取不到才退回简单名
        let full = row.text("cfull").trim();
        let name = row.text("cname").trim();
        let shown = if full.is_empty() { name } else { full };
        if !shown.is_empty() && !vo_names.iter().any(|v| v == shown) {
            vo_names.push(shown.to_string());
        }
        let table = row.text("tname").trim().to_lowercase();
        if !table.is_empty() && !table_names.contains(&table) {
            table_names.push(table);
        }
    }

    if table_names.is_empty() {
        notes.push(format!(
            "库里没有 {} 的映射。三种常见原因：这个类是纯前端 VO（没进 md_class）、\
             元数据还没发布（md_ormap 里没有行）、或者类名写成了内部类/带泛型的写法",
            class_name.trim()
        ));
        return Ok(VoTableOut {
            class_name: class_name.trim().to_string(),
            vo_names,
            tables: Vec::new(),
            notes,
            source: format!("{user}@{url}"),
            elapsed_ms: started.elapsed().as_millis() as u64,
        });
    }

    // 表行：复用字典那条 SQL（带 industry 放行 NULL、按 versiontype 取最新）
    let filter = TableFilter {
        names: table_names.clone(),
        ..Default::default()
    };
    let sql = md_dict_sql::tables_sql(&filter, MAX_TABLES + 1)?;
    let tables = md_dict::read_tables(&query(b.clone(), sql, &["id", "name"]).await?);
    if tables.len() > MAX_TABLES {
        notes.push(format!(
            "命中的表超过 {MAX_TABLES} 张，只显示前 {MAX_TABLES} 张：类名可能给得太泛，换全限定名再试"
        ));
    }
    let tables: Vec<_> = tables.into_iter().take(MAX_TABLES).collect();
    let ids: Vec<String> = tables.iter().map(|t| t.id.clone()).collect();

    // 列：一条 SQL 可能因为字面量太多被分片，逐片查再合并
    let mut columns = Vec::new();
    for one in md_dict_sql::columns_sqls(&ids) {
        columns.extend(md_dict::read_columns(
            &query(b.clone(), one, &["cname"]).await?,
        ));
    }

    // entities 传空：这一屏问的就是「这个 VO 对应什么表」，不需要再列其它候选实体
    let built = md_dict::build(&tables, &columns, &[]);
    if built.len() < table_names.len() {
        let found: Vec<&str> = built.iter().map(|t| t.name.as_str()).collect();
        let missing: Vec<&str> = table_names
            .iter()
            .map(String::as_str)
            .filter(|n| !found.contains(n))
            .collect();
        if !missing.is_empty() {
            notes.push(format!(
                "这些表在 md_table 里查不到（可能是临时表或已软删除）：{}",
                missing.join(", ")
            ));
        }
    }

    Ok(VoTableOut {
        class_name: class_name.trim().to_string(),
        vo_names,
        tables: built,
        notes,
        source: format!("{user}@{url}"),
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}
