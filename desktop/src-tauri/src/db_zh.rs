//! 列中文名（`表名|列名` → 中文名）的 SQL 拼装与结果组装。
//!
//! **只有这一处**：两个引擎执行 SQL 的方式不同（Rust 引擎用绑定变量，JVM 桥走
//! `query` 命令），但「查什么」和「怎么拼成 `{names}`」必须是同一份，否则就是
//! 两套实现各自漂移 —— 2026-11-02 那次事故正是 Java 侧手拼 JSON 多包了一层
//! `names`：整行 JSON 不合法 ⇒ Rust 当「非协议输出」丢弃 ⇒ 命令干等 60 秒超时
//! ⇒ 前端把失败当「查不到」静默 ⇒ 界面上和「功能没做」一模一样。
//!
//! 所以这里刻意**只产出数据**，序列化交给 `serde_json`，任何一边都不再手拼字符串。

use serde_json::{json, Map, Value};

use crate::java_bridge::BridgeError;

/// 一次最多认几张表。Oracle 的 `in (...)` 上限是 1000，而这是「一条 SQL 里出现的表」，
/// 正常不会超；超了也只影响这一屏的中文名，不影响查询本身。
pub const MAX_TABLES: usize = 80;

/// `query` 一次最多取这么多行：80 张表 × 列数，正常远小于此，超了也只是少几个中文名。
const MAX_ROWS: usize = 5000;

/// 逗号分隔的表名 → 干净的表名列表（小写、去重、只留 `[a-z0-9_$#]`）。
///
/// 表名来自用户 SQL 的文本扫描，**不能直接拼进 SQL**：`query` 命令没有绑定变量，
/// 这里是唯一一道防线。认不出的名字直接丢掉（它本来也查不到中文名）。
pub fn sanitize(csv: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in csv.split(',') {
        let name = raw.trim().to_ascii_lowercase();
        if name.is_empty() || out.len() >= MAX_TABLES {
            continue;
        }
        let ok = name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$' || c == '#');
        if !ok || out.contains(&name) {
            continue;
        }
        out.push(name);
    }
    out
}

/// 查这批表的列中文名。表名已由 [`sanitize`] 洗过，直接拼字面量。
pub fn select_sql(names: &[String]) -> String {
    let list = names
        .iter()
        .map(|n| format!("'{n}'"))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "select lower(c.tableid), lower(c.name), c.displayname from md_column c \
         where lower(c.tableid) in ({list}) and c.displayname is not null"
    )
}

/// `{columns:[...], rows:[[t,c,zh],...]}` → `{names:{"表|列":中文名}, count:N}`。
///
/// 同一列可能有多版本：先到的留下（与桥里 `ncColumnNames`、Rust 引擎的口径一致）。
pub fn names_from_rows(rows_value: &Value) -> Result<Value, BridgeError> {
    let rows = rows_value
        .get("rows")
        .and_then(Value::as_array)
        .ok_or_else(|| BridgeError::new("other", "查询结果里没有 rows"))?;
    let mut map = Map::new();
    for row in rows {
        let Some(cells) = row.as_array() else {
            continue;
        };
        let (Some(t), Some(c), Some(zh)) = (
            cells.first().and_then(text_of),
            cells.get(1).and_then(text_of),
            cells.get(2).and_then(text_of),
        ) else {
            continue;
        };
        if zh.trim().is_empty() {
            continue;
        }
        let key = format!("{}|{}", t.trim().to_lowercase(), c.trim().to_lowercase());
        map.entry(key)
            .or_insert_with(|| Value::String(zh.to_string()));
    }
    let count = map.len();
    Ok(json!({ "names": Value::Object(map), "count": count }))
}

/// 行里的单元格 → 文本。桥把数字/日期都序列化成字符串，但 `null` 会是 `Null`。
fn text_of(v: &Value) -> Option<&str> {
    match v {
        Value::String(s) => Some(s.as_str()),
        _ => None,
    }
}

/// `query` 命令的取行上限（给调用方拼参数用）。
pub fn max_rows() -> String {
    MAX_ROWS.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn csv(s: &str) -> Vec<String> {
        sanitize(s)
    }

    #[test]
    fn 洗表名_小写去重去空() {
        assert_eq!(
            csv(" BD_MATERIAL , bd_material, ,bd_b,BD_B"),
            vec!["bd_material", "bd_b"]
        );
    }

    #[test]
    fn 洗表名_丢掉拼不进字面量的字符() {
        // 表名来自用户 SQL 文本，引号/空格/注释符一律不认 —— 这是唯一一道注入防线
        assert_eq!(csv("bd_x' or '1'='1"), Vec::<String>::new());
        assert_eq!(csv("bd_material; drop table x"), Vec::<String>::new());
        assert_eq!(csv("aier.bd_material"), Vec::<String>::new());
        assert_eq!(csv("bd_ok$#1"), vec!["bd_ok$#1"]);
    }

    #[test]
    fn 洗表名_超过上限截断() {
        let many: Vec<String> = (0..(MAX_TABLES + 10)).map(|i| format!("t{i}")).collect();
        assert_eq!(csv(&many.join(",")).len(), MAX_TABLES);
    }

    #[test]
    fn sql_用字面量列表() {
        let sql = select_sql(&["bd_material".into(), "bd_b".into()]);
        assert!(sql.contains("in ('bd_material', 'bd_b')"));
        assert!(sql.contains("lower(c.tableid)"));
        assert!(sql.contains("displayname is not null"));
    }

    #[test]
    fn 组装_键是小写表名列名() {
        let v = json!({
            "columns": [{"name": "X", "type": "VARCHAR2(1)", "precision": 1, "scale": 0}],
            "rows": [["bd_material", "code", "物料编码"], ["bd_material", "name", "物料名称"]],
        });
        let out = names_from_rows(&v).unwrap();
        assert_eq!(out["count"], 2);
        assert_eq!(out["names"]["bd_material|code"], "物料编码");
        assert_eq!(out["names"]["bd_material|name"], "物料名称");
    }

    #[test]
    fn 组装_同列多版本先到的赢_空中文名丢掉() {
        let v = json!({
            "rows": [
                ["bd_material", "code", "物料编码"],
                ["bd_material", "code", "旧版本"],
                ["bd_material", "name", "  "],
                ["bd_material", null, "无列名"],
            ],
        });
        let out = names_from_rows(&v).unwrap();
        assert_eq!(out["count"], 1);
        assert_eq!(out["names"]["bd_material|code"], "物料编码");
    }

    #[test]
    fn 组装_没有_rows要报错而不是当空() {
        assert!(names_from_rows(&json!({ "kind": "update" })).is_err());
    }
}
