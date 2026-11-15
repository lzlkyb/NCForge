//! Only declared foreign keys and explicit NC class references become navigable links.
use super::db_cmds::{call, drop_bridge, find_conn, open_temp_session, slot_bridge};
use crate::{db_engine::EngineKind, state::AppState};
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tauri::AppHandle;
const FOREIGN_KEYS: &str = "select f.constraint_name RELATION, f.table_name SOURCE_TABLE, fc.column_name SOURCE_COLUMN, p.table_name TARGET_TABLE, pc.column_name TARGET_COLUMN, fc.position POSITION from all_constraints f join all_constraints p on p.constraint_name=f.r_constraint_name and p.owner=f.r_owner join all_cons_columns fc on fc.constraint_name=f.constraint_name and fc.owner=f.owner join all_cons_columns pc on pc.constraint_name=p.constraint_name and pc.owner=p.owner and pc.position=fc.position where f.constraint_type='R' and f.owner=sys_context('userenv','current_schema') and p.owner=f.owner and (f.table_name=:1 or p.table_name=:2) order by f.constraint_name, fc.position";
/// `{attr}` 是 `MD_ORMAP` 指向 `MD_PROPERTY` 的那一列：NC6 系列叫 `ATTRIBUTEID`，
/// 早期按 `PROPERTYID` 写死在这套库上直接 ORA-00904，关系恒空（用户看不到任何标注）。
const NC_REFS_TEMPLATE: &str = "select distinct p.id RELATION, st.name SOURCE_TABLE, sc.name SOURCE_COLUMN, tt.name TARGET_TABLE, tc.name TARGET_COLUMN, 1 POSITION from md_property p join md_class cl on cl.id=p.datatype join md_ormap sm on sm.{attr}=p.id join md_column sc on sc.id=sm.columnid join md_table st on st.id=sc.tableid join md_ormap tm on tm.classid=cl.id join md_column tc on tc.id=tm.columnid join md_table tt on tt.id=tc.tableid where nvl(p.dr,0)=0 and nvl(sm.dr,0)=0 and nvl(tm.dr,0)=0 and nvl(sc.dr,0)=0 and nvl(tc.dr,0)=0 and nvl(st.dr,0)=0 and nvl(tt.dr,0)=0 and upper(tc.pkey) in ('Y','TRUE','1') and not exists (select 1 from md_column otherkey where otherkey.tableid=tc.tableid and otherkey.id<>tc.id and nvl(otherkey.dr,0)=0 and upper(otherkey.pkey) in ('Y','TRUE','1')) and (upper(st.name)=:1 or upper(tt.name)=:2)";
/// 元数据表清单：一次查完，后面按需取列名（不同 NC 版本列名不一样）。
const META_TABLES: &str =
    "('MD_ENUM','MD_ENUMCLASS','MD_ENUMVALUE','MD_ORMAP','MD_PROPERTY','MD_COLUMN','MD_TABLE')";
async fn read(
    b: Arc<crate::db_engine::EngineHandle>,
    sql: &str,
    table: &str,
) -> Result<Value, String> {
    call(
        b,
        "execBound",
        vec![
            sql.into(),
            "1000".into(),
            "60".into(),
            "string".into(),
            table.into(),
            "string".into(),
            table.into(),
        ],
        Duration::from_secs(90),
    )
    .await
}
#[tauri::command]
pub async fn db_relations(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
    table: String,
    isolated_only: Option<bool>,
) -> Result<Value, String> {
    if !table
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '$' | '#'))
        || table.is_empty()
    {
        return Err("不支持的表名称".into());
    }
    let cfg = state.config.read().await.clone();
    let conn = find_conn(&cfg, &id)?;
    let temporary = open_temp_session(
        &app,
        &state,
        &cfg,
        &conn,
        EngineKind::parse(&conn.engine),
        "relations",
    )
    .await;
    // Completion runs during typing: failure to open an isolated session must never
    // fall back to the user's query session and replace its pagination cursor.
    require_relation_session(temporary.is_some(), isolated_only.unwrap_or(false))?;
    let shared = temporary.is_none();
    let b = if let Some((_, ref b)) = temporary {
        b.clone()
    } else {
        slot_bridge(&state, &id, None)?
    };
    // 列名只能来自库自己：同一段 SQL 在 NC5/NC6 上叫法不同，猜错就是整块关系静默为空。
    let meta = metadata_columns(b.clone()).await;
    let upper = table.to_uppercase();
    let fk = read(b.clone(), FOREIGN_KEYS, &upper).await;
    let nc = match &meta {
        Ok(columns) => match ormap_attribute(columns) {
            Some(attr) => read(b.clone(), &NC_REFS_TEMPLATE.replace("{attr}", attr), &upper).await,
            None => Err("此库的 MD_ORMAP 没有可确认的属性列".into()),
        },
        Err(error) => Err(error.clone()),
    };
    let enums = read_enums(b.clone(), &upper, meta.as_deref().unwrap_or(&[])).await;
    if let Some((key, engine)) = temporary {
        let _ = call(engine, "disconnect", vec![], Duration::from_secs(10)).await;
        drop_bridge(&state, &key);
    }
    let mut notes = Vec::new();
    // 任何一块读不出来都置位：只把原因塞进 notes（折叠在「不可用原因」里），
    // 前端会当成「关系为空」正常渲染，用户看到的是「没有可确认的关联」。
    let mut partial = false;
    let foreign = match fk {
        Ok(v) => v,
        Err(e) => {
            notes.push(format!("数据库外键读取失败：{e}"));
            partial = true;
            json!({"rows":[]})
        }
    };
    let references = match nc {
        Ok(v) => v,
        Err(e) => {
            notes.push(format!(
                "NC 显式类引用不可用（此库元数据版本或权限不支持）：{e}"
            ));
            partial = true;
            json!({"rows":[]})
        }
    };
    let enumerations = match enums {
        Ok(v) => v,
        Err(e) => {
            notes.push(e);
            partial = true;
            json!({"kind":"rows","columns":[],"rows":[]})
        }
    };
    Ok(
        json!({"foreign":foreign,"references":references,"enums":enumerations,"notes":notes,"partial":partial,"sharedSession":shared}),
    )
}
fn require_relation_session(temporary: bool, isolated_only: bool) -> Result<(), String> {
    if !temporary && isolated_only {
        return Err("无法创建独立的元数据会话，本次不提供业务补全".into());
    }
    Ok(())
}
/// 本库元数据表的 `(表名, 列名)` 全表，列名来自 `all_tab_columns`，不是猜的。
async fn metadata_columns(
    b: Arc<crate::db_engine::EngineHandle>,
) -> Result<Vec<(String, String)>, String> {
    let sql = format!("select table_name, column_name from all_tab_columns where owner=sys_context('userenv','current_schema') and table_name in {META_TABLES}");
    let out = call(
        b,
        "exec",
        vec![sql, "800".into(), "60".into()],
        Duration::from_secs(90),
    )
    .await?;
    let rows = out["rows"].as_array().ok_or("元数据列清单读取失败")?;
    Ok(rows
        .iter()
        .filter_map(|r| Some((r[0].as_str()?.to_string(), r[1].as_str()?.to_string())))
        .collect())
}
fn has(columns: &[(String, String)], table: &str, column: &str) -> bool {
    columns.iter().any(|(t, c)| t == table && c == column)
}
/// `MD_ORMAP` 指向 `MD_PROPERTY` 的外键列：优先 `ATTRIBUTEID`（NC6），退回 `PROPERTYID`。
fn ormap_attribute(columns: &[(String, String)]) -> Option<&'static str> {
    ["ATTRIBUTEID", "PROPERTYID"]
        .into_iter()
        .find(|c| has(columns, "MD_ORMAP", c))
}
async fn read_enums(
    b: Arc<crate::db_engine::EngineHandle>,
    table: &str,
    columns: &[(String, String)],
) -> Result<Value, String> {
    let enum_table = ["MD_ENUM", "MD_ENUMCLASS"]
        .into_iter()
        .find(|t| has(columns, t, "ID"))
        .ok_or("此库没有受支持的 NC 枚举定义表")?;
    let reference = ["ENUMID", "ENUMCLASSID"]
        .into_iter()
        .find(|c| has(columns, "MD_ENUMVALUE", c))
        .ok_or("此库的 NC 枚举值未提供可确认的枚举引用列")?;
    let value = ["VALUE", "ENUMVALUE"]
        .into_iter()
        .find(|c| has(columns, "MD_ENUMVALUE", c))
        .ok_or("此库的 NC 枚举值结构不受支持")?;
    let label = ["DISPLAYNAME", "NAME"]
        .into_iter()
        .find(|c| has(columns, "MD_ENUMVALUE", c))
        .ok_or("此库的 NC 枚举值没有显示名")?;
    let attr = ormap_attribute(columns).ok_or("此库的 MD_ORMAP 没有可确认的属性列")?;
    // Identifiers come exclusively from the verified schema whitelist; the selected table stays bound.
    let sql=format!("select distinct sc.name FIELD, ev.\"{value}\" ENUM_VALUE, ev.\"{label}\" ENUM_LABEL from md_property p join {enum_table} en on en.id=p.datatype join md_ormap sm on sm.{attr}=p.id join md_column sc on sc.id=sm.columnid join md_table st on st.id=sc.tableid join MD_ENUMVALUE ev on ev.\"{reference}\"=en.id where nvl(p.dr,0)=0 and nvl(sm.dr,0)=0 and nvl(sc.dr,0)=0 and nvl(st.dr,0)=0 and upper(st.name)=:1 and upper(st.name)=:2");
    let deleted = [(enum_table, "en"), ("MD_ENUMVALUE", "ev")]
        .into_iter()
        .filter(|(t, _)| has(columns, t, "DR"))
        .map(|(_, alias)| format!(" and nvl({alias}.dr,0)=0"))
        .collect::<String>();
    read(b, &format!("{sql}{deleted}"), table).await
}

// clippy::items_after_test_module：测试模块必须放在文件末尾
#[cfg(test)]
mod tests {
    use super::*;
    fn meta(rows: &[(&str, &str)]) -> Vec<(String, String)> {
        rows.iter()
            .map(|(t, c)| (t.to_string(), c.to_string()))
            .collect()
    }
    #[test]
    fn compound_keys_join_by_position() {
        assert!(FOREIGN_KEYS.contains("pc.position=fc.position"));
        assert!(FOREIGN_KEYS.contains("p.owner=f.r_owner"));
        assert!(FOREIGN_KEYS.contains("p.owner=f.owner"));
        assert!(FOREIGN_KEYS.contains("f.owner=sys_context('userenv','current_schema')"));
        assert!(FOREIGN_KEYS.contains("fc.owner=f.owner"));
        assert!(FOREIGN_KEYS.contains("pc.owner=p.owner"));
    }
    #[test]
    fn nc_reference_requires_real_class_mapping() {
        assert!(NC_REFS_TEMPLATE.contains("cl.id=p.datatype"));
        assert!(NC_REFS_TEMPLATE.contains("tc.pkey"));
        assert!(!NC_REFS_TEMPLATE.contains("pk_org"));
    }
    /// 真实库的 `MD_ORMAP` 只有 `ATTRIBUTEID`：写死 `PROPERTYID` 会让整块关系静默为空。
    #[test]
    fn ormap_attribute_follows_the_library() {
        let nc6 = meta(&[("MD_ORMAP", "ATTRIBUTEID"), ("MD_ORMAP", "CLASSID")]);
        assert_eq!(ormap_attribute(&nc6), Some("ATTRIBUTEID"));
        let legacy = meta(&[("MD_ORMAP", "PROPERTYID")]);
        assert_eq!(ormap_attribute(&legacy), Some("PROPERTYID"));
        assert_eq!(ormap_attribute(&meta(&[("MD_ORMAP", "CLASSID")])), None);
        let sql = NC_REFS_TEMPLATE.replace("{attr}", "ATTRIBUTEID");
        assert!(sql.contains("sm.ATTRIBUTEID=p.id"));
        assert!(!sql.contains("{attr}"));
    }
    #[test]
    fn completion_requires_an_isolated_session_without_changing_table_page_fallback() {
        assert!(require_relation_session(false, true).is_err());
        assert!(require_relation_session(true, true).is_ok());
        assert!(require_relation_session(false, false).is_ok());
    }
}
