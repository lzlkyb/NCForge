//! 全库按值反查的纯逻辑：校验、转义、SQL 拼装。取数在
//! `commands/db_search_cmds.rs`，这里全部是能单测的函数。
//!
//! **为什么 SQL 要在这里拼**：桥的 `exec` 没有参数绑定（`exec(sql, rows, timeout)`），
//! 所有字面量只能拼进语句。上游插件（ncdevplugin 的 `SearchFullDatabase`）同样是拼的，
//! 但它把表名、列名、用户输入原样拼进去——碰到带引号/中文的表名就是语法错，碰到
//! 恶意表名就是注入。这里的边界：
//!
//! - 表名、列名**只来自 Oracle 数据字典**（`user_tables` / `user_tab_columns`），
//!   逐个过 [`is_safe_ident`] 才加双引号；其余跳过并计数。
//! - 用户输入只出现在**字符串字面量**里：单引号翻倍，`%` `_` `\` 用 `ESCAPE '\'`
//!   转义成普通字符——用户搜 `50%` 不应该变成「以 50 开头」。
//!
//! 与上游的另一个差别是查询形状：上游对「每个可搜索列」各发一条
//! `select 1 ... rownum = 1`，一张 40 列的表就是 40 次往返；这里**每表一条**，
//! 用 `CASE WHEN ... THEN 1 ELSE 0 END` 同时拿到「哪列命中」和「样本值」，
//! 列多的表少几十次全表扫描。

use std::collections::{BTreeMap, BTreeSet};

/// 一次搜索的文本上限。再长就不是「按值反查」而是导出条件了。
pub const MAX_TEXT_CHARS: usize = 200;
/// 每张命中表取几行做样本。只要够判断「命中哪些列」，不要拖 CLOB 出来。
pub const SAMPLE_ROWS: usize = 3;
/// 样本值 / `SUBSTR` 的长度。NC 的文本列常有几百字，界面一行放不下。
pub const SAMPLE_CHARS: usize = 200;

/// 表清单：排除回收站里的 `BIN$…`（它们没有主键、也会让用户一脸问号）。
pub const TABLES_SQL: &str =
    "SELECT TABLE_NAME FROM USER_TABLES WHERE TABLE_NAME NOT LIKE 'BIN$%' ORDER BY TABLE_NAME";
/// 一次取回全库列元数据：`COLUMN_ID` 决定列顺序，样本按这个顺序展示。
pub const COLUMNS_SQL: &str = "SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE FROM USER_TAB_COLUMNS \
     ORDER BY TABLE_NAME, COLUMN_ID";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchMode {
    Contains,
    Equals,
    Prefix,
    Suffix,
}

impl MatchMode {
    /// 前端传 0..=3；越界要报错而不是默默按「包含」跑。
    pub fn parse(v: u8) -> Result<Self, String> {
        match v {
            0 => Ok(Self::Contains),
            1 => Ok(Self::Equals),
            2 => Ok(Self::Prefix),
            3 => Ok(Self::Suffix),
            other => Err(format!("不认识的匹配方式：{other}")),
        }
    }
}

/// 校验并规整用户输入：去首尾空白、非空、长度受限、不含 NUL。
pub fn validate_text(s: &str) -> Result<String, String> {
    let t = s.trim();
    if t.is_empty() {
        return Err("要查的文本是空的".to_string());
    }
    let n = t.chars().count();
    if n > MAX_TEXT_CHARS {
        return Err(format!(
            "文本太长（{n} 个字符），最多 {MAX_TEXT_CHARS} 个字符：再长就不该按值反查，请用 SQL 加条件"
        ));
    }
    if t.contains('\0') {
        return Err("文本里有 NUL 字符".to_string());
    }
    Ok(t.to_string())
}

/// 能安全加双引号拼进 SQL 的标识符。
///
/// 只接受 ASCII 字母/数字/`_$#`、首字符是字母或 `_`、长度 ≤128。中文表名、带空格或
/// 引号的对象一律跳过——不是它们不存在，而是拼进去要么语法错要么改变语义，宁可少查。
pub fn is_safe_ident(s: &str) -> bool {
    if s.is_empty() || s.len() > 128 {
        return false;
    }
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '$' | '#'))
}

/// 能不能用 `LIKE` 搜。BLOB/RAW 不能；`LONG` 也不能（Oracle 不允许在 WHERE 里引用
/// LONG 列，会直接 ORA-00932），日期/数字按值反查没有意义。
pub fn is_searchable_type(ty: &str) -> bool {
    matches!(
        ty.trim().to_ascii_uppercase().as_str(),
        "CHAR" | "VARCHAR2" | "NCHAR" | "NVARCHAR2" | "CLOB" | "NCLOB"
    )
}

fn is_lob_type(ty: &str) -> bool {
    matches!(ty.trim().to_ascii_uppercase().as_str(), "CLOB" | "NCLOB")
}

/// 用户文本 → LIKE 模式串（不含引号）：通配符按字面量转义，两端按模式补 `%`。
pub fn like_pattern(text: &str, mode: MatchMode) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    if matches!(mode, MatchMode::Contains | MatchMode::Suffix) {
        out.push('%');
    }
    for c in text.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    if matches!(mode, MatchMode::Contains | MatchMode::Prefix) {
        out.push('%');
    }
    out
}

/// 字符串字面量：Oracle 里单引号用两个单引号转义；反斜杠在默认设置下不特殊。
pub fn sql_literal(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// 已验证的标识符 → 双引号形式。未通过校验直接报错（调用方应已过滤，这里是兜底）。
pub fn quote_ident(s: &str) -> Result<String, String> {
    if !is_safe_ident(s) {
        return Err(format!("标识符不能安全拼进 SQL，已跳过：{s}"));
    }
    Ok(format!("\"{s}\""))
}

/// `"COL" LIKE '%x%' ESCAPE '\'`。
pub fn like_pred(col: &str, pattern: &str) -> String {
    format!("{col} LIKE {} ESCAPE '\\'", sql_literal(pattern))
}

/// 按类型选样本表达式：CLOB 走 `DBMS_LOB.SUBSTR`（直接 SUBSTR 返回 CLOB，桥那边会
/// 把整段读出来），其余按普通字符串截断。
fn sample_expr(col: &str, ty: &str) -> String {
    if is_lob_type(ty) {
        format!("DBMS_LOB.SUBSTR({col}, {SAMPLE_CHARS}, 1)")
    } else {
        format!("SUBSTR({col}, 1, {SAMPLE_CHARS})")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchCol {
    pub name: String,
    pub ty: String,
}

/// 一张表的查询：命中列的 `M{i}` 标志 + 样本值 `V{i}`，最多 [`SAMPLE_ROWS`] 行。
///
/// 结果列顺序固定是 `M0..M{n-1}, V0..V{n-1}`，调用方按下标解析即可。
pub fn table_scan_sql(table: &str, cols: &[SearchCol], pattern: &str) -> Result<String, String> {
    if cols.is_empty() {
        return Err("这张表没有可搜索的列".to_string());
    }
    let t = quote_ident(table)?;
    let mut flags = Vec::with_capacity(cols.len());
    let mut vals = Vec::with_capacity(cols.len());
    let mut preds = Vec::with_capacity(cols.len());
    for (i, c) in cols.iter().enumerate() {
        let q = quote_ident(&c.name)?;
        let p = like_pred(&q, pattern);
        flags.push(format!("CASE WHEN {p} THEN 1 ELSE 0 END \"M{i}\""));
        vals.push(format!("{} \"V{i}\"", sample_expr(&q, &c.ty)));
        preds.push(p);
    }
    let mut select = flags;
    select.extend(vals);
    Ok(format!(
        "SELECT * FROM (SELECT {} FROM {} WHERE ({})) WHERE ROWNUM <= {SAMPLE_ROWS}",
        select.join(", "),
        t,
        preds.join(" OR ")
    ))
}

/// 单列命中的可复制 SQL（界面「复制 SQL」用）。`ROWNUM <= 100` 只是给个上限，
/// 用户拿去改条件时不会一上来就把整表拉出来。
pub fn hit_sql(table: &str, col: &str, pattern: &str) -> Result<String, String> {
    let t = quote_ident(table)?;
    let c = quote_ident(col)?;
    Ok(format!(
        "SELECT * FROM {t} WHERE {} AND ROWNUM <= 100",
        like_pred(&c, pattern)
    ))
}

#[derive(Debug, Default)]
pub struct Catalog {
    /// 字典里的表名（保持 `user_tables` 的顺序）。
    pub tables: Vec<String>,
    /// 每张表的可搜索列（按 `COLUMN_ID` 顺序）。
    pub cols: BTreeMap<String, Vec<SearchCol>>,
    /// 因名字不安全被跳过的表/列数。
    pub skipped_tables: usize,
    pub skipped_columns: usize,
}

/// 把两个字典结果集拼成按表索引的列清单。
pub fn build_catalog(tables: &[Vec<String>], columns: &[Vec<String>]) -> Catalog {
    let mut cat = Catalog::default();
    let mut seen = BTreeSet::new();
    for row in tables {
        let Some(name) = row.first().map(String::as_str).map(str::trim) else {
            continue;
        };
        if !is_safe_ident(name) {
            cat.skipped_tables += 1;
            continue;
        }
        if seen.insert(name.to_string()) {
            cat.tables.push(name.to_string());
        }
    }
    for row in columns {
        let (Some(table), Some(col), Some(ty)) = (
            row.first().map(String::as_str).map(str::trim),
            row.get(1).map(String::as_str).map(str::trim),
            row.get(2).map(String::as_str).map(str::trim),
        ) else {
            cat.skipped_columns += 1;
            continue;
        };
        if !seen.contains(table) {
            continue;
        }
        if !is_safe_ident(col) || !is_searchable_type(ty) {
            cat.skipped_columns += 1;
            continue;
        }
        cat.cols
            .entry(table.to_string())
            .or_default()
            .push(SearchCol {
                name: col.to_string(),
                ty: ty.to_ascii_uppercase(),
            });
    }
    cat
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cols(pairs: &[(&str, &str)]) -> Vec<SearchCol> {
        pairs
            .iter()
            .map(|(n, t)| SearchCol {
                name: n.to_string(),
                ty: t.to_string(),
            })
            .collect()
    }

    #[test]
    fn 文本校验去空白且限长() {
        assert_eq!(validate_text("  hello  ").unwrap(), "hello");
        assert!(validate_text("").is_err());
        assert!(validate_text("   ").is_err());
        assert!(validate_text("a").is_ok());
        let long = "字".repeat(MAX_TEXT_CHARS);
        assert!(validate_text(&long).is_ok(), "正好 200 个字要允许");
        let longer = "字".repeat(MAX_TEXT_CHARS + 1);
        assert!(validate_text(&longer).is_err());
        assert!(validate_text("a\0b").is_err());
    }

    #[test]
    fn 标识符只认安全字符() {
        for ok in ["uapbd", "UAP_BD$1", "_T", "A#1"] {
            assert!(is_safe_ident(ok), "{ok} 应该允许");
        }
        for bad in [
            "",
            "1abc",
            "../evil",
            "a/b",
            "a\\b",
            "C:x",
            "a b",
            "中文表",
            "a\"b",
            "a-b",
        ] {
            assert!(!is_safe_ident(bad), "{bad} 应该拒绝");
        }
        assert!(!is_safe_ident(&"a".repeat(129)));
    }

    #[test]
    fn 可搜索类型只认文本列() {
        for ok in [
            "VARCHAR2",
            "varchar2",
            " CHAR ",
            "NVARCHAR2",
            "NCHAR",
            "CLOB",
            "NCLOB",
        ] {
            assert!(is_searchable_type(ok), "{ok} 应该可搜");
        }
        for bad in [
            "BLOB",
            "RAW",
            "LONG",
            "LONG RAW",
            "DATE",
            "NUMBER",
            "TIMESTAMP(6)",
        ] {
            assert!(!is_searchable_type(bad), "{bad} 不该可搜");
        }
    }

    #[test]
    fn 匹配方式越界要报错() {
        assert_eq!(MatchMode::parse(0).unwrap(), MatchMode::Contains);
        assert_eq!(MatchMode::parse(3).unwrap(), MatchMode::Suffix);
        assert!(MatchMode::parse(4).is_err());
    }

    #[test]
    fn 四种模式的百分号位置() {
        assert_eq!(like_pattern("abc", MatchMode::Contains), "%abc%");
        assert_eq!(like_pattern("abc", MatchMode::Equals), "abc");
        assert_eq!(like_pattern("abc", MatchMode::Prefix), "abc%");
        assert_eq!(like_pattern("abc", MatchMode::Suffix), "%abc");
    }

    #[test]
    fn 通配符与反斜杠都按字面量转义() {
        assert_eq!(like_pattern("50%", MatchMode::Contains), "%50\\%%");
        assert_eq!(like_pattern("a_b", MatchMode::Equals), "a\\_b");
        assert_eq!(like_pattern("c:\\tmp", MatchMode::Contains), "%c:\\\\tmp%");
        assert_eq!(like_pattern("100%_x", MatchMode::Prefix), "100\\%\\_x%");
    }

    #[test]
    fn 字符串字面量翻倍单引号() {
        assert_eq!(sql_literal("it's"), "'it''s'");
        assert_eq!(sql_literal("a\\b"), "'a\\b'");
    }

    #[test]
    fn 表查询含转义与标志列() {
        let cs = cols(&[("NAME", "VARCHAR2"), ("MEMO", "CLOB")]);
        let sql = table_scan_sql("BD_STOCK", &cs, "%abc%").unwrap();
        assert!(sql.contains("FROM \"BD_STOCK\""), "{sql}");
        assert!(sql.contains("\"NAME\" LIKE '%abc%' ESCAPE '\\'"), "{sql}");
        assert!(sql.contains("\"M0\""), "{sql}");
        assert!(sql.contains("\"M1\""), "{sql}");
        // VARCHAR2 用 SUBSTR，CLOB 走 DBMS_LOB.SUBSTR
        assert!(sql.contains("SUBSTR(\"NAME\", 1, 200) \"V0\""), "{sql}");
        assert!(
            sql.contains("DBMS_LOB.SUBSTR(\"MEMO\", 200, 1) \"V1\""),
            "{sql}"
        );
        assert!(sql.contains("WHERE ROWNUM <= 3"), "{sql}");
        // 标志位必须在样本值之前：解析按下标切
        assert!(
            sql.find("\"M1\"").unwrap() < sql.find("\"V0\"").unwrap(),
            "{sql}"
        );
    }

    #[test]
    fn 表查询拒绝不安全列名() {
        let cs = cols(&[("A\"B", "VARCHAR2")]);
        assert!(table_scan_sql("T", &cs, "%x%").is_err());
        assert!(table_scan_sql("T", &[], "%x%").is_err());
        assert!(table_scan_sql("T; DROP TABLE X", &cols(&[("A", "CHAR")]), "%x%").is_err());
    }

    #[test]
    fn 命中sql带转义与上限() {
        let sql = hit_sql("BD_STOCK", "NAME", "%50\\%%").unwrap();
        assert_eq!(
            sql,
            "SELECT * FROM \"BD_STOCK\" WHERE \"NAME\" LIKE '%50\\%%' ESCAPE '\\' AND ROWNUM <= 100"
        );
    }

    #[test]
    fn 目录过滤不安全表列与不可搜索类型() {
        let tables = vec![
            vec!["BD_STOCK".to_string()],
            vec!["中文表".to_string()],
            vec!["BD_STOCK".to_string()],
            vec!["BIN$x".to_string()],
        ];
        let columns = vec![
            vec!["BD_STOCK".into(), "NAME".into(), "VARCHAR2".into()],
            vec!["BD_STOCK".into(), "AMOUNT".into(), "NUMBER".into()],
            vec!["BD_STOCK".into(), "RAW_COL".into(), "BLOB".into()],
            vec!["BD_STOCK".into(), "BAD COL".into(), "VARCHAR2".into()],
            vec!["不存在".into(), "X".into(), "VARCHAR2".into()],
            vec!["BD_STOCK".into()],
            vec!["中文表".into(), "Y".into(), "VARCHAR2".into()],
        ];
        let cat = build_catalog(&tables, &columns);
        assert_eq!(
            cat.tables,
            vec!["BD_STOCK", "BIN$x"],
            "重复去掉、中文表跳过"
        );
        assert_eq!(cat.skipped_tables, 1);
        let got = &cat.cols["BD_STOCK"];
        assert_eq!(got.len(), 1, "{got:?}");
        assert_eq!(got[0].name, "NAME");
        assert_eq!(got[0].ty, "VARCHAR2");
        // NUMBER/BLOB/带空格列名/缺列的行都记进跳过数
        assert_eq!(cat.skipped_columns, 4);
        assert!(!cat.cols.contains_key("不存在"));
    }
}
