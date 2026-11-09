//! Only declared foreign keys and explicit NC class references become navigable links.
use super::db_cmds::{call, drop_bridge, find_conn, open_temp_session, slot_bridge};
use crate::{db_engine::EngineKind, state::AppState};
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tauri::AppHandle;
const FOREIGN_KEYS: &str = "select f.constraint_name RELATION, f.table_name SOURCE_TABLE, fc.column_name SOURCE_COLUMN, p.table_name TARGET_TABLE, pc.column_name TARGET_COLUMN, fc.position POSITION from user_constraints f join user_constraints p on p.constraint_name=f.r_constraint_name join user_cons_columns fc on fc.constraint_name=f.constraint_name join user_cons_columns pc on pc.constraint_name=p.constraint_name and pc.position=fc.position where f.constraint_type='R' and f.r_owner=user and (f.table_name=:1 or p.table_name=:2) order by f.constraint_name, fc.position";
const NC_REFS: &str = "select distinct p.id RELATION, st.name SOURCE_TABLE, sc.name SOURCE_COLUMN, tt.name TARGET_TABLE, tc.name TARGET_COLUMN, 1 POSITION from md_property p join md_class cl on cl.id=p.datatype join md_ormap sm on sm.propertyid=p.id join md_column sc on sc.id=sm.columnid join md_table st on st.id=sc.tableid join md_ormap tm on tm.classid=cl.id join md_column tc on tc.id=tm.columnid join md_table tt on tt.id=tc.tableid where nvl(p.dr,0)=0 and nvl(sm.dr,0)=0 and nvl(tm.dr,0)=0 and nvl(sc.dr,0)=0 and nvl(tc.dr,0)=0 and nvl(st.dr,0)=0 and nvl(tt.dr,0)=0 and upper(tc.pkey) in ('Y','TRUE','1') and not exists (select 1 from md_column otherkey where otherkey.tableid=tc.tableid and otherkey.id<>tc.id and nvl(otherkey.dr,0)=0 and upper(otherkey.pkey) in ('Y','TRUE','1')) and (upper(st.name)=:1 or upper(tt.name)=:2)";
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
    let shared = temporary.is_none();
    let b = if let Some((_, ref b)) = temporary {
        b.clone()
    } else {
        slot_bridge(&state, &id, None)?
    };
    let fk = read(b.clone(), FOREIGN_KEYS, &table.to_uppercase()).await;
    // Missing/older metadata schemas remain usable through the declared-FK path.
    let nc = read(b.clone(), NC_REFS, &table.to_uppercase()).await;
    let enums = read_enums(b.clone(), &table.to_uppercase()).await;
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
async fn read_enums(b: Arc<crate::db_engine::EngineHandle>, table: &str) -> Result<Value, String> {
    let schema=call(b.clone(),"exec",vec!["select table_name, column_name from user_tab_columns where table_name in ('MD_ENUM','MD_ENUMCLASS','MD_ENUMVALUE')".into(),"200".into(),"60".into()],Duration::from_secs(90)).await?;
    let has = |t: &str, c: &str| {
        schema["rows"].as_array().is_some_and(|rows| {
            rows.iter()
                .any(|r| r[0].as_str() == Some(t) && r[1].as_str() == Some(c))
        })
    };
    let enum_table = ["MD_ENUM", "MD_ENUMCLASS"]
        .into_iter()
        .find(|t| has(t, "ID"))
        .ok_or("此库没有受支持的 NC 枚举定义表")?;
    let reference = ["ENUMID", "ENUMCLASSID"]
        .into_iter()
        .find(|c| has("MD_ENUMVALUE", c))
        .ok_or("此库的 NC 枚举值未提供可确认的枚举引用列")?;
    let value = ["VALUE", "ENUMVALUE"]
        .into_iter()
        .find(|c| has("MD_ENUMVALUE", c))
        .ok_or("此库的 NC 枚举值结构不受支持")?;
    let label = ["DISPLAYNAME", "NAME"]
        .into_iter()
        .find(|c| has("MD_ENUMVALUE", c))
        .ok_or("此库的 NC 枚举值没有显示名")?;
    // Identifiers come exclusively from the verified schema whitelist; the selected table stays bound.
    let sql=format!("select distinct sc.name FIELD, ev.\"{value}\" ENUM_VALUE, ev.\"{label}\" ENUM_LABEL from md_property p join {enum_table} en on en.id=p.datatype join md_ormap sm on sm.propertyid=p.id join md_column sc on sc.id=sm.columnid join md_table st on st.id=sc.tableid join MD_ENUMVALUE ev on ev.\"{reference}\"=en.id where nvl(p.dr,0)=0 and nvl(sm.dr,0)=0 and nvl(sc.dr,0)=0 and nvl(st.dr,0)=0 and upper(st.name)=:1 and upper(st.name)=:2");
    let deleted = [(enum_table, "en"), ("MD_ENUMVALUE", "ev")]
        .into_iter()
        .filter(|(t, _)| has(t, "DR"))
        .map(|(_, alias)| format!(" and nvl({alias}.dr,0)=0"))
        .collect::<String>();
    read(b, &format!("{sql}{deleted}"), table).await
}

// clippy::items_after_test_module：测试模块必须放在文件末尾
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn compound_keys_join_by_position() {
        assert!(FOREIGN_KEYS.contains("pc.position=fc.position"));
        assert!(FOREIGN_KEYS.contains("f.r_owner=user"));
    }
    #[test]
    fn nc_reference_requires_real_class_mapping() {
        assert!(NC_REFS.contains("cl.id=p.datatype"));
        assert!(NC_REFS.contains("tc.pkey"));
        assert!(!NC_REFS.contains("pk_org"));
    }
}
