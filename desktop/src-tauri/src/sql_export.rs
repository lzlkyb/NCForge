//! 把查询结果渲染成可回放的 `insert` 脚本（NC 基础数据迁移用）。
//!
//! 这里只做**纯文本生成**：不连库、不读配置，输入是「结果集列 + 表元数据 + 行值」。
//! 连库与取数在 `commands::db_export_cmds` 里，两边分开是为了这三条规则能被单测钉住。
//!
//! 三条格式规则来自 NC 官方 `nc.uap.studio.pub.db.ScriptHelper.convert2InsertSqls`
//! （`idea_plugin_ncdevplugin` 从 NC 发行包反编译出来的那份，见该仓库 `src/nc/uap/studio/pub/db/`）：
//!
//! 1. **主键列排最前**，且不出重。复制数据时先写主键，目标库的索引/约束校验顺序稳定，
//!    人排查「这条到底插进去没有」时也一眼能对。
//! 2. **blob / image 列一律写 `null`**。二进制列动辄几十兆，塞进 .sql 既跑不动也没人读；
//!    而且 NC 的图片/附件基本都能在目标环境重新挂。想搬二进制另走 exp/imp 或单独工具。
//! 3. **多语列只写基础列并填 `'~'`，`X2`..`X6` 整族不导**。NC 的多语字段是列族
//!    （`name` + `name2`…`name6`，6 个语种各一列），`'~'` 是「待翻译，按基础语种取」的标记。
//!    只写基础列能让目标环境按自己的语种重新出内容；把 6 列原样搬过去，看起来完整，
//!    实际会把源库的语种顺序带过去，多语切换反而乱。
//!
//! **多语判定不猜列名**。参考实现里 `isMultColumn` 的判据来自 NC 元数据（`mlTableInfo`），
//! 不是「列名末尾不是数字」——那句只是「在已判定为多语之后，认出哪一列是基础列」。
//! 我们拿不到那份元数据，就退一步用**列族存在性**判定：基础列是字符类型，且 `X2`..`X6`
//! 里至少存在 3 列。这条口径宁可漏判（少写 `'~'`，数据还能用）也不误判（误判会丢数据），
//! 界面上会把检测到的族显式列出来给人确认。
//!
//! 日期/时间**不用裸字符串拼**：JDBC 出来的 `DATE` 常带 `.0` 尾巴，裸拼进 insert 会
//! ORA-01830（参考实现的 `SqlUtil.formatSql` 就是这个毛病，见借鉴文档 4.3）。这里统一
//! 走显式 `to_date` / `to_timestamp`。

use std::collections::{HashMap, HashSet};

/// 多语列族的语种列后缀：NC 固定 `X2`..`X6`。
const ML_SUFFIXES: [&str; 5] = ["2", "3", "4", "5", "6"];
/// 至少存在这么多个语种列，才认这一族是多语列（真实的多语字段是 5 个齐全的）。
const ML_MIN_SIBLINGS: usize = 3;

// ───────────────────────── 输入结构 ─────────────────────────

/// 表里一列的元数据（来自 `user_tab_columns` + 主键约束）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColMeta {
    pub name: String,
    /// 完整类型，如 `VARCHAR2(20)` / `NUMBER(10,2)` / `DATE`。
    pub ty: String,
    pub pk: bool,
}

/// 结果集里的一列（名字 + 类型，按结果集顺序）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResultCol {
    pub name: String,
    pub ty: String,
}

// ───────────────────────── 输出结构 ─────────────────────────

/// 要写进 `insert` 的一列。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmitCol {
    /// 在结果行里的下标（不是表里的位置）。
    pub src: usize,
    pub name: String,
    pub ty: String,
    /// 二进制列：值一律写 `null`。
    pub blob: bool,
    /// 多语基础列：值一律写 `'~'`。
    pub ml_base: bool,
}

/// 识别出的一族多语列。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MlFamily {
    pub base: String,
    pub skipped: Vec<String>,
}

/// 一次导出的列计划。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    /// `schema.table`（已按需加引号）。
    pub target: String,
    /// 按输出顺序排好的列。
    pub cols: Vec<EmitCol>,
    pub ml: Vec<MlFamily>,
    /// 因为多语规则被丢掉的列名（给界面显示，别让人以为数据莫名少了）。
    pub dropped: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Stats {
    pub rows: usize,
    pub blob_nulls: usize,
    /// RAW 列取不到完整十六进制、只能写 null 的个数（被 64 字节预览截断）。
    pub raw_nulls: usize,
    pub ml_tildes: usize,
}

// ───────────────────────── 类型判断 ─────────────────────────

/// 去掉长度/精度，只留大写基础类型名：`NUMBER(10,2)` → `NUMBER`。
pub fn base_type(ty: &str) -> String {
    let t = ty.trim();
    let head = t.split('(').next().unwrap_or(t).trim();
    head.to_uppercase()
}

fn is_text_type(base: &str) -> bool {
    matches!(
        base,
        "VARCHAR2" | "VARCHAR" | "CHAR" | "NVARCHAR2" | "NCHAR"
    )
}

fn is_number_type(base: &str) -> bool {
    matches!(
        base,
        "NUMBER"
            | "INTEGER"
            | "INT"
            | "SMALLINT"
            | "DECIMAL"
            | "NUMERIC"
            | "FLOAT"
            | "REAL"
            | "DOUBLE PRECISION"
            | "BINARY_DOUBLE"
            | "BINARY_FLOAT"
    )
}

/// 二进制列（参考实现里的 `isBlobColumn`：image / blob）。
fn is_blob_type(ty: &str) -> bool {
    matches!(
        base_type(ty).as_str(),
        "BLOB" | "IMAGE" | "LONG RAW" | "BFILE"
    )
}

fn is_raw_type(ty: &str) -> bool {
    base_type(ty) == "RAW"
}

/// RAW → `hextoraw('…')`。第二个返回值 = 这个值没能完整拿到（只能写 `null`）。
///
/// 判据必须是「整串都是十六进制且长度为偶数」。桥对超过 64 字节的 RAW 会截断并拼上
/// `…`，这种串落到 `literal()` 的 else 分支会静默变成 `null` —— 主键列变 NULL 是
/// 最难发现的一种数据损坏，所以单独拎出来计数。
fn raw_literal(v: Option<&str>) -> (String, bool) {
    let Some(text) = v.filter(|s| !s.is_empty()) else {
        return ("null".to_string(), false);
    };
    if text.len() % 2 == 0 && text.chars().all(|c| c.is_ascii_hexdigit()) {
        return (format!("hextoraw('{}')", text.to_uppercase()), false);
    }
    ("null".to_string(), true)
}

// ───────────────────────── 多语判定 ─────────────────────────

/// 从一张表的**全部列**里找出多语列族。
///
/// 判据：基础列是字符类型 + `X2`..`X6` 至少存在 [`ML_MIN_SIBLINGS`] 个。
/// 只用结果集的列做不到这件事（查询常常只 select 基础列），所以务必传表元数据。
pub fn detect_multilang(cols: &[ColMeta]) -> Vec<MlFamily> {
    let have: HashSet<String> = cols.iter().map(|c| c.name.to_lowercase()).collect();
    let mut out = Vec::new();
    for c in cols {
        let base = base_type(&c.ty);
        if !is_text_type(&base) {
            continue;
        }
        let low = c.name.to_lowercase();
        if low.ends_with(|ch: char| ch.is_ascii_digit()) {
            continue;
        }
        let skipped: Vec<String> = ML_SUFFIXES
            .iter()
            .map(|s| format!("{}{}", c.name, s))
            .filter(|n| have.contains(&n.to_lowercase()))
            .collect();
        if skipped.len() >= ML_MIN_SIBLINGS {
            out.push(MlFamily {
                base: c.name.clone(),
                skipped,
            });
        }
    }
    out
}

// ───────────────────────── 列计划 ─────────────────────────

/// 拼 `schema.table`。非普通标识符加双引号，避免带空格/保留字拼出非法语句。
pub fn qualified(schema: Option<&str>, table: &str) -> String {
    match schema.map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => format!("{}.{}", quote_ident(s), quote_ident(table)),
        None => quote_ident(table),
    }
}

/// 非普通标识符加双引号。`db_file_export` 的 INSERT 列清单也走这里——
/// 两处各写一份，迟早会有一处忘记转义列名里的双引号。
pub(crate) fn quote_ident(s: &str) -> String {
    let plain = !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$' || c == '#')
        && !s.chars().next().is_some_and(|c| c.is_ascii_digit());
    if plain {
        s.to_string()
    } else {
        format!("\"{}\"", s.replace('"', "\"\""))
    }
}

/// 建列计划：结果集的列决定「导哪些」，表元数据决定「类型、主键、多语」。
///
/// - 结果集里有、表元数据里没有的列（表达式、别名、join 出来的列）按结果集类型处理，
///   不参与主键前置与多语判定；
/// - `multilang = false` 时不做多语处理，`X2`..`X6` 原样导出。
pub fn build_plan(
    target: String,
    result: &[ResultCol],
    meta: Option<&[ColMeta]>,
    multilang: bool,
) -> Plan {
    let by_name: HashMap<String, &ColMeta> = meta
        .map(|m| {
            m.iter()
                .map(|c| (c.name.to_lowercase(), c))
                .collect::<HashMap<_, _>>()
        })
        .unwrap_or_default();

    let ml = match (multilang, meta) {
        (true, Some(m)) if !m.is_empty() => detect_multilang(m),
        (true, _) => {
            // 没有表元数据就只能拿结果集自己判——类型可能不准，但列族存在性还是可靠的
            let as_meta: Vec<ColMeta> = result
                .iter()
                .map(|c| ColMeta {
                    name: c.name.clone(),
                    ty: c.ty.clone(),
                    pk: false,
                })
                .collect();
            detect_multilang(&as_meta)
        }
        _ => Vec::new(),
    };

    let mut skip: HashSet<String> = HashSet::new();
    let mut family_of: HashMap<String, String> = HashMap::new();
    for f in &ml {
        family_of.insert(f.base.to_lowercase(), f.base.clone());
        for s in &f.skipped {
            skip.insert(s.to_lowercase());
        }
    }

    let mut cols: Vec<EmitCol> = Vec::new();
    let mut dropped: Vec<String> = Vec::new();
    for (i, rc) in result.iter().enumerate() {
        let low = rc.name.to_lowercase();
        if skip.contains(&low) {
            dropped.push(rc.name.clone());
            continue;
        }
        let ty = by_name
            .get(&low)
            .map(|m| m.ty.clone())
            .unwrap_or_else(|| rc.ty.clone());
        cols.push(EmitCol {
            src: i,
            name: rc.name.clone(),
            blob: is_blob_type(&ty),
            ml_base: family_of.contains_key(&low),
            ty,
        });
    }

    reorder_pk_first(&mut cols, &by_name);
    Plan {
        target,
        cols,
        ml,
        dropped,
    }
}

/// 主键列前置。主键之间的相对顺序按表里的列序（`user_tab_columns.column_id`），
/// 不按约束里的 `position`——复合主键的书写顺序对 `insert` 没有语义，稳定可预期更重要。
fn reorder_pk_first(cols: &mut Vec<EmitCol>, by_name: &HashMap<String, &ColMeta>) {
    let is_pk = |c: &EmitCol| {
        by_name
            .get(&c.name.to_lowercase())
            .map(|m| m.pk)
            .unwrap_or(false)
    };
    if !cols.iter().any(is_pk) {
        return;
    }
    let (mut pk, mut rest): (Vec<EmitCol>, Vec<EmitCol>) = cols.drain(..).partition(|c| is_pk(c));
    pk.append(&mut rest);
    *cols = pk;
}

// ───────────────────────── 值 → SQL 字面量 ─────────────────────────

/// 一个值渲染成 SQL 字面量。`None` 是 SQL NULL。
pub fn literal(v: Option<&str>, ty: &str) -> String {
    let Some(v) = v else {
        return "null".to_string();
    };
    let base = base_type(ty);
    if is_blob_type(ty) {
        return "null".to_string();
    }
    if base == "DATE" {
        return date_literal(v);
    }
    if base.starts_with("TIMESTAMP") {
        return timestamp_literal(v);
    }
    if is_number_type(&base) {
        return if is_numeric_text(v) {
            v.to_string()
        } else if v.trim().is_empty() {
            "null".to_string()
        } else {
            quote(v)
        };
    }
    if is_raw_type(ty) {
        return if !v.is_empty() && v.len() % 2 == 0 && v.chars().all(|c| c.is_ascii_hexdigit()) {
            format!("hextoraw('{}')", v.to_uppercase())
        } else {
            "null".to_string()
        };
    }
    if v.is_empty() {
        // Oracle 里 '' 就是 NULL，写 null 比写 '' 更直白
        return "null".to_string();
    }
    quote(v)
}

fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

fn is_numeric_text(s: &str) -> bool {
    let t = s.trim();
    if t.is_empty() {
        return false;
    }
    let body = t.strip_prefix('-').unwrap_or(t);
    let mut seen_dot = false;
    let mut seen_digit = false;
    for c in body.chars() {
        match c {
            '0'..='9' => seen_digit = true,
            '.' if !seen_dot => seen_dot = true,
            _ => return false,
        }
    }
    seen_digit
}

/// `2023-10-19` / `2023-10-19 12:13:45` → 显式格式的 `to_date`。
/// 认不出格式（时区、月份名等）就退回带引号的字符串，让导入方自己报错，不猜。
fn date_literal(v: &str) -> String {
    if is_date_only(v) {
        format!("to_date('{v}', 'YYYY-MM-DD')")
    } else if is_datetime(v) {
        format!("to_date('{v}', 'YYYY-MM-DD HH24:MI:SS')")
    } else {
        quote(v)
    }
}

fn timestamp_literal(v: &str) -> String {
    if is_timestamp(v) {
        format!("to_timestamp('{v}', 'YYYY-MM-DD HH24:MI:SS.FF')")
    } else if is_datetime(v) {
        format!("to_timestamp('{v}', 'YYYY-MM-DD HH24:MI:SS')")
    } else if is_date_only(v) {
        format!("to_timestamp('{v}', 'YYYY-MM-DD')")
    } else {
        quote(v)
    }
}

fn digits_at(s: &str, at: usize, n: usize) -> bool {
    s.len() >= at + n && s[at..at + n].bytes().all(|b| b.is_ascii_digit())
}

/// `YYYY-MM-DD`
fn is_date_only(s: &str) -> bool {
    // 先挡非 ASCII：下面的按字节切片只在纯 ASCII 上安全
    s.is_ascii()
        && s.len() == 10
        && digits_at(s, 0, 4)
        && &s[4..5] == "-"
        && digits_at(s, 5, 2)
        && &s[7..8] == "-"
        && digits_at(s, 8, 2)
}

/// `YYYY-MM-DD HH:MI:SS`
fn is_datetime(s: &str) -> bool {
    s.is_ascii()
        && s.len() == 19
        && is_date_only(&s[..10])
        && &s[10..11] == " "
        && digits_at(s, 11, 2)
        && &s[13..14] == ":"
        && digits_at(s, 14, 2)
        && &s[16..17] == ":"
        && digits_at(s, 17, 2)
}

/// `YYYY-MM-DD HH:MI:SS.FF…`
fn is_timestamp(s: &str) -> bool {
    let Some((head, frac)) = s.split_once('.') else {
        return false;
    };
    is_datetime(head)
        && !frac.is_empty()
        && frac.len() <= 9
        && frac.bytes().all(|b| b.is_ascii_digit())
}

// ───────────────────────── 渲染 ─────────────────────────

/// 渲染整批行。`commit_every > 0` 时每 N 行插一条 `commit;`（大表迁移别让 undo 撑爆）。
pub fn render(plan: &Plan, rows: &[Vec<String>], commit_every: usize) -> (String, Stats) {
    let mut out = String::with_capacity(rows.len() * plan.cols.len() * 16 + 256);
    let mut st = Stats::default();
    // 列名一律原样（大小写按元数据来）：加引号拼过的标识符一旦被改写就会变另一个人。
    let cols: Vec<&str> = plan.cols.iter().map(|c| c.name.as_str()).collect();
    let head = format!("insert into {} ({}) values (", plan.target, cols.join(", "));

    for (n, row) in rows.iter().enumerate() {
        out.push_str(&head);
        for (i, c) in plan.cols.iter().enumerate() {
            if i > 0 {
                out.push_str(", ");
            }
            if c.ml_base {
                out.push_str("'~'");
                st.ml_tildes += 1;
            } else if c.blob {
                out.push_str("null");
                st.blob_nulls += 1;
            } else if is_raw_type(&c.ty) {
                // RAW 单独走：桥只给前 64 字节并拼上 `…`，这种值不能当成完整二进制。
                // 以前它落到 `literal()` 的非 hex 分之直接写 null，脚本里主键就成 NULL 了，
                // 而且一个字的告警都没有。现在至少计数，由命令层报出来。
                let (sql, lost) = raw_literal(row.get(c.src).map(String::as_str));
                if lost {
                    st.raw_nulls += 1;
                }
                out.push_str(&sql);
            } else {
                out.push_str(&literal(row.get(c.src).map(String::as_str), &c.ty));
            }
        }
        out.push_str(");\n");
        if commit_every > 0 && (n + 1) % commit_every == 0 {
            out.push_str("commit;\n");
        }
    }
    st.rows = rows.len();
    (out, st)
}

// ───────────────────────── 单测 ─────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(name: &str, ty: &str, pk: bool) -> ColMeta {
        ColMeta {
            name: name.into(),
            ty: ty.into(),
            pk,
        }
    }

    fn rc(name: &str, ty: &str) -> ResultCol {
        ResultCol {
            name: name.into(),
            ty: ty.into(),
        }
    }

    /// 规则一：主键列排最前，且不重复。
    #[test]
    fn pk_columns_come_first() {
        let table = vec![
            meta("CODE", "VARCHAR2(20)", false),
            meta("PK_MATERIAL", "CHAR(20)", true),
            meta("NAME", "VARCHAR2(200)", false),
        ];
        let result = vec![
            rc("CODE", "VARCHAR2"),
            rc("PK_MATERIAL", "CHAR"),
            rc("NAME", "VARCHAR2"),
        ];
        let plan = build_plan("bd_material".into(), &result, Some(&table), false);
        let names: Vec<&str> = plan.cols.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["PK_MATERIAL", "CODE", "NAME"]);

        let (sql, st) = render(&plan, &[vec!["01".into(), "1001".into(), "螺栓".into()]], 0);
        // 主键值必须跟着自己的列走（src 下标没串位）
        assert!(
            sql.contains("(PK_MATERIAL, CODE, NAME) values ('1001', '01', '螺栓')"),
            "{sql}"
        );
        assert_eq!(st.rows, 1);
        // 每个列名只出现一次
        assert_eq!(sql.matches("PK_MATERIAL").count(), 1);
    }

    /// 规则二：blob 列写 null，原有内容不进去。
    #[test]
    fn blob_written_as_null() {
        let table = vec![
            meta("PK_IMG", "CHAR(20)", true),
            meta("CONTENT", "BLOB", false),
        ];
        let result = vec![rc("PK_IMG", "CHAR"), rc("CONTENT", "BLOB")];
        let plan = build_plan("bd_img".into(), &result, Some(&table), false);
        let (sql, st) = render(&plan, &[vec!["1".into(), "<BLOB 4096B>".into()]], 0);
        assert!(sql.contains("values ('1', null)"), "{sql}");
        assert_eq!(st.blob_nulls, 1);
    }

    /// 规则三：多语基础列写 '~'，X2..X6 整族不导。
    #[test]
    fn multilang_base_tilde_and_siblings_skipped() {
        let mut table = vec![
            meta("PK_MAT", "CHAR(20)", true),
            meta("NAME", "VARCHAR2(200)", false),
        ];
        for s in ML_SUFFIXES {
            table.push(meta(&format!("NAME{s}"), "VARCHAR2(200)", false));
        }
        let mut result = vec![rc("PK_MAT", "CHAR"), rc("NAME", "VARCHAR2")];
        for s in ML_SUFFIXES {
            result.push(rc(&format!("NAME{s}"), "VARCHAR2"));
        }
        let plan = build_plan("bd_material".into(), &result, Some(&table), true);
        let names: Vec<&str> = plan.cols.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["PK_MAT", "NAME"],
            "语种列必须整族丢掉：{names:?}"
        );
        assert_eq!(plan.dropped.len(), 5);
        assert_eq!(plan.ml.len(), 1);
        assert_eq!(plan.ml[0].base, "NAME");

        let row: Vec<String> = std::iter::once("1".to_string())
            .chain(std::iter::once("螺栓".into()))
            .chain((2..=6).map(|i| format!("bolt{i}")))
            .collect();
        let (sql, st) = render(&plan, &[row], 0);
        assert!(sql.contains("(PK_MAT, NAME) values ('1', '~')"), "{sql}");
        assert_eq!(st.ml_tildes, 1);
        // 五个语种列一个都不许出现
        for s in ML_SUFFIXES {
            assert!(!sql.to_lowercase().contains(&format!("name{s}")), "{sql}");
        }
    }

    /// 关掉多语处理时，X2..X6 原样导出（对照：规则三真的起了作用，不是恒等变换）。
    #[test]
    fn multilang_off_keeps_siblings() {
        let mut table = vec![meta("NAME", "VARCHAR2(200)", false)];
        for s in ML_SUFFIXES {
            table.push(meta(&format!("NAME{s}"), "VARCHAR2(200)", false));
        }
        let mut result = vec![rc("NAME", "VARCHAR2")];
        for s in ML_SUFFIXES {
            result.push(rc(&format!("NAME{s}"), "VARCHAR2"));
        }
        let plan = build_plan("t".into(), &result, Some(&table), false);
        assert_eq!(plan.cols.len(), 6);
        assert!(plan.dropped.is_empty());
    }

    /// 多语判定看列族存在性，不是看列名长什么样：
    /// 只有 `NAME` 没有 `NAME2..` 的表，绝不能凭空写 '~'。
    #[test]
    fn no_siblings_means_not_multilang() {
        let table = vec![
            meta("NAME", "VARCHAR2(200)", false),
            meta("NAME2", "VARCHAR2(200)", false),
        ];
        let result = vec![rc("NAME", "VARCHAR2"), rc("NAME2", "VARCHAR2")];
        let plan = build_plan("t".into(), &result, Some(&table), true);
        assert!(plan.ml.is_empty());
        assert_eq!(plan.cols.len(), 2);
    }

    #[test]
    fn date_and_timestamp_are_explicit() {
        assert_eq!(
            literal(Some("2023-10-19"), "DATE"),
            "to_date('2023-10-19', 'YYYY-MM-DD')"
        );
        assert_eq!(
            literal(Some("2023-10-19 12:13:45"), "DATE"),
            "to_date('2023-10-19 12:13:45', 'YYYY-MM-DD HH24:MI:SS')"
        );
        assert_eq!(
            literal(Some("2023-10-19 12:13:45.123456"), "TIMESTAMP(6)"),
            "to_timestamp('2023-10-19 12:13:45.123456', 'YYYY-MM-DD HH24:MI:SS.FF')"
        );
        // 认不出的日期格式不硬套（否则拼出必然 ORA 错误的语句）
        assert_eq!(literal(Some("19-OCT-23"), "DATE"), "'19-OCT-23'");
        assert_eq!(
            literal(Some("2023-10-19 12:13:45.0"), "DATE"),
            "'2023-10-19 12:13:45.0'"
        );
    }

    #[test]
    fn numbers_quotes_and_nulls() {
        assert_eq!(literal(None, "VARCHAR2(10)"), "null");
        assert_eq!(literal(Some("-12.50"), "NUMBER(10,2)"), "-12.50");
        assert_eq!(literal(Some("0"), "NUMBER"), "0");
        assert_eq!(literal(Some("it's"), "VARCHAR2(10)"), "'it''s'");
        assert_eq!(literal(Some(""), "VARCHAR2(10)"), "null");
        assert_eq!(literal(Some("abc"), "NUMBER"), "'abc'");
    }

    #[test]
    fn commit_every_n() {
        let table = vec![meta("A", "VARCHAR2(10)", false)];
        let result = vec![rc("A", "VARCHAR2")];
        let plan = build_plan("t".into(), &result, Some(&table), false);
        let rows: Vec<Vec<String>> = (1..=5).map(|i| vec![i.to_string()]).collect();
        let (sql, st) = render(&plan, &rows, 2);
        assert_eq!(st.rows, 5);
        assert_eq!(sql.matches("commit;").count(), 2, "{sql}");
        assert_eq!(
            sql.lines().filter(|l| l.starts_with("insert into")).count(),
            5
        );
    }

    #[test]
    fn identifiers_are_guarded() {
        assert_eq!(qualified(None, "bd_material"), "bd_material");
        assert_eq!(qualified(Some("ncdb"), "bd_material"), "ncdb.bd_material");
        assert_eq!(qualified(None, "my table"), "\"my table\"");
        assert_eq!(qualified(None, "select"), "select");
    }

    /// 被桥截断过的 RAW（尾部带 `…`）必须报「拿不到完整值」，不能静默写成 NULL。
    ///
    /// 这条是 P0 的守卫：桥对 >64 字节的 RAW 只回前 64 字节 + `…`，它落到
    /// `literal()` 的非 hex 分支会变成 `null` —— 主键列静默变 NULL，重放才知道。
    #[test]
    fn truncated_raw_is_flagged_not_silently_null() {
        assert_eq!(
            raw_literal(Some("A1B2")),
            ("hextoraw('A1B2')".to_string(), false)
        );
        assert_eq!(raw_literal(Some("A1B2…")), ("null".to_string(), true));
        assert_eq!(raw_literal(Some("")), ("null".to_string(), false));
        assert_eq!(raw_literal(None), ("null".to_string(), false));
    }
}
