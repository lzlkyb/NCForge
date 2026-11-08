//! 表结构对比（DDL diff）：读两侧结构 → 逐字段/主键/索引比对 → 生成「把右边改成左边」的 DDL。
//!
//! **为什么放 Rust 而不是前端**：比对规则（类型归一、主键列序、索引按「列组合 + 唯一性」配对）
//! 和 DDL 生成都是纯逻辑，放在没有任何 IO 的模块里才能用夹具锁住。前端只负责画。
//!
//! **生成 DDL 但绝不执行**：跨环境改表结构是最容易把生产库改坏的动作用户必须自己看过、
//! 挑着跑。这条与「重置口令只生成 SQL」同一个口径。
//!
//! 明确不比：分区、表空间、存储参数、触发器和视图定义。NC 现场核对结构关心的是
//! 「字段在不在、类型对不对、主键索引是否一致」，这几项比全量 DDL 文本 diff 稳得多
//! ——后者会被存储参数和格式差异淹没。

use serde::{Deserialize, Serialize};

use crate::sql_export::literal;

/// 一侧的完整结构快照。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableStruct {
    /// `OWNER.TABLE`（大写，界面上直接显示）。
    pub label: String,
    pub columns: Vec<StructColumn>,
    /// 主键列，按 `position` 排序；无主键是空数组。
    pub pk: Vec<String>,
    /// 主键约束名（右侧改名时 DDL 要用）。
    pub pk_name: Option<String>,
    pub indexes: Vec<StructIndex>,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructColumn {
    pub name: String,
    /// 归一后的类型文本，如 `VARCHAR2(40)` / `NUMBER(12,2)`。
    pub ty: String,
    pub nullable: bool,
    pub default_text: Option<String>,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructIndex {
    pub name: String,
    pub unique: bool,
    /// 列名（按索引内顺序）。
    pub columns: Vec<String>,
}

/// 一项对不上的属性。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldDiff {
    /// `类型` / `可空` / `默认值` / `注释` / `列名`。
    pub field: String,
    pub left: Option<String>,
    pub right: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiffStatus {
    /// 两侧一致。
    Same,
    /// 只在左边（右侧缺，需要 ADD）。
    OnlyLeft,
    /// 只在右边（左侧没有，需要 DROP）。
    OnlyRight,
    /// 名字相同但属性不同（需要 MODIFY）。
    Changed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDiff {
    pub name: String,
    pub status: DiffStatus,
    pub left: Option<StructColumn>,
    pub right: Option<StructColumn>,
    pub changes: Vec<FieldDiff>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexDiff {
    /// 左边索引名；只在右边时为右侧名。
    pub name: String,
    pub left_name: Option<String>,
    pub right_name: Option<String>,
    pub unique: bool,
    pub columns: Vec<String>,
    pub status: DiffStatus,
    /// 只有名字不同（列与唯一性一致）：不算差异，但值得提示。
    pub renamed: bool,
}

/// 一条待执行的 DDL。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructStmt {
    pub sql: String,
    /// 为什么有这条（界面上逐条显示，不让人对着裸 SQL 猜）。
    pub reason: String,
    /// 会删东西（DROP COLUMN / DROP INDEX / DROP PRIMARY KEY）：界面标红。
    pub destructive: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructDiff {
    pub left: TableStruct,
    pub right: TableStruct,
    pub columns: Vec<ColumnDiff>,
    pub indexes: Vec<IndexDiff>,
    pub pk_changed: bool,
    pub comment_changed: bool,
    /// 左侧独有 / 右侧独有 / 属性不同 的条数（含索引与主键）。
    pub only_left: usize,
    pub only_right: usize,
    pub changed: usize,
    pub ddl: Vec<StructStmt>,
}

impl StructDiff {
    /// 有没有任何差异（含主键改名这种「只差名字」的情况）。
    pub fn is_clean(&self) -> bool {
        self.only_left == 0
            && self.only_right == 0
            && self.changed == 0
            && !self.pk_changed
            && !self.comment_changed
    }
}

/// 数据字典查询：列（含注释）。
pub fn columns_sql(owner: &str, table: &str) -> String {
    format!(
        "select c.column_name, c.data_type, c.data_length, c.char_length, c.char_used, \
         c.data_precision, c.data_scale, c.nullable, c.data_default, cc.comments \
         from all_tab_columns c \
         left join all_col_comments cc on cc.owner = c.owner and cc.table_name = c.table_name \
         and cc.column_name = c.column_name \
         where c.owner = {} and c.table_name = {} order by c.column_id",
        literal(Some(owner), "VARCHAR2"),
        literal(Some(table), "VARCHAR2")
    )
}

/// 数据字典查询：主键列 + 主键约束名。
pub fn pk_sql(owner: &str, table: &str) -> String {
    format!(
        "select c.constraint_name, cc.column_name, cc.position \
         from all_constraints c join all_cons_columns cc \
         on cc.owner = c.owner and cc.constraint_name = c.constraint_name \
         where c.owner = {} and c.table_name = {} and c.constraint_type = 'P' \
         order by cc.position",
        literal(Some(owner), "VARCHAR2"),
        literal(Some(table), "VARCHAR2")
    )
}

/// 数据字典查询：索引及其列（LOB 索引不比）。函数索引的 `column_name` 是空的，
/// 由 [`parse_indexes`] 在解析阶段**整条丢弃**，这里不写 `is not null` 条件。
pub fn indexes_sql(owner: &str, table: &str) -> String {
    format!(
        "select i.index_name, i.uniqueness, ic.column_name, ic.column_position \
         from all_indexes i join all_ind_columns ic \
         on ic.index_owner = i.owner and ic.index_name = i.index_name \
         where i.table_owner = {} and i.table_name = {} and i.index_type <> 'LOB' \
         order by i.index_name, ic.column_position",
        literal(Some(owner), "VARCHAR2"),
        literal(Some(table), "VARCHAR2")
    )
}

/// 数据字典查询：表注释。
pub fn comment_sql(owner: &str, table: &str) -> String {
    format!(
        "select comments from all_tab_comments where owner = {} and table_name = {}",
        literal(Some(owner), "VARCHAR2"),
        literal(Some(table), "VARCHAR2")
    )
}

/// 单元格转文本：`None` 保持 `None`（NULL 与空串在数据字典里含义不同）。
fn text(v: Option<&serde_json::Value>) -> Option<String> {
    match v? {
        serde_json::Value::Null => None,
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        serde_json::Value::Bool(b) => Some(b.to_string()),
        other => Some(other.to_string()),
    }
}

/// 从 `exec` 的返回体里取二维文本表（`{kind:"rows", rows:[[...]]}`）。
pub fn body_rows(body: &serde_json::Value) -> Result<Vec<Vec<Option<String>>>, String> {
    if body.get("kind").and_then(|k| k.as_str()) != Some("rows") {
        return Err("这条元数据查询没有返回结果集".to_string());
    }
    Ok(body
        .get("rows")
        .and_then(|r| r.as_array())
        .map(|rows| {
            rows.iter()
                .map(|row| {
                    row.as_array()
                        .map(|c| c.iter().map(|v| text(Some(v))).collect())
                        .unwrap_or_default()
                })
                .collect()
        })
        .unwrap_or_default())
}

/// 归一后的类型文本。
///
/// `all_tab_columns` 给的是「类型 + 若干长度字段」，直接拿去比会把
/// `VARCHAR2(40)` 与 `VARCHAR2(40 BYTE)` 当成两种东西；这里统一成写 DDL 的写法。
pub fn format_type(
    data_type: &str,
    data_length: Option<i64>,
    char_length: Option<i64>,
    data_precision: Option<i64>,
    data_scale: Option<i64>,
) -> String {
    let ty = data_type.trim().to_ascii_uppercase();
    // 带括号的类型（TIMESTAMP(6) / INTERVAL DAY(2) TO SECOND(6)）自带精度，不能再拼
    if ty.contains('(') {
        return ty;
    }
    match ty.as_str() {
        "NUMBER" | "FLOAT" | "DECIMAL" | "NUMERIC" => match data_precision {
            Some(p) => match data_scale {
                Some(s) if s > 0 => format!("{ty}({p},{s})"),
                _ => format!("{ty}({p})"),
            },
            None => ty,
        },
        "VARCHAR2" | "NVARCHAR2" | "CHAR" | "NCHAR" => {
            // char_length 是「字符数」；两者都有时按字符给，和 DDL 里的默认口径一致
            let len = char_length.or(data_length);
            match len {
                Some(n) => format!("{ty}({n})"),
                None => ty,
            }
        }
        "RAW" => match data_length {
            Some(n) => format!("{ty}({n})"),
            None => ty,
        },
        _ => ty,
    }
}

/// 默认值归一：Oracle 会回带换行和一个尾空格，`NULL` 默认值视同没有默认值。
fn norm_default(v: Option<String>) -> Option<String> {
    let s = v?.trim().trim_end_matches('\n').trim().to_string();
    if s.is_empty() || s.eq_ignore_ascii_case("null") {
        None
    } else {
        Some(s)
    }
}

/// 把列查询结果转成结构列。
pub fn parse_columns(rows: &[Vec<Option<String>>]) -> Vec<StructColumn> {
    rows.iter()
        .filter_map(|r| {
            let name = r.first()?.as_deref()?.trim().to_string();
            if name.is_empty() {
                return None;
            }
            Some(StructColumn {
                ty: format_type(
                    r.get(1).and_then(|v| v.as_deref()).unwrap_or(""),
                    num(r.get(2)),
                    num(r.get(3)),
                    num(r.get(5)),
                    num(r.get(6)),
                ),
                nullable: r.get(7).and_then(|v| v.as_deref()).unwrap_or("Y").trim() == "Y",
                default_text: norm_default(r.get(8).and_then(|v| v.clone())),
                comment: r
                    .get(9)
                    .and_then(|v| v.clone())
                    .filter(|c| !c.trim().is_empty()),
                name,
            })
        })
        .collect()
}

fn num(v: Option<&Option<String>>) -> Option<i64> {
    v.and_then(|s| s.as_deref())
        .and_then(|s| s.trim().parse::<i64>().ok())
}

/// 主键列（按 position 排序）+ 约束名。
pub fn parse_pk(rows: &[Vec<Option<String>>]) -> (Option<String>, Vec<String>) {
    let name = rows
        .first()
        .and_then(|r| r.first().cloned().flatten())
        .filter(|s| !s.trim().is_empty());
    let cols = rows
        .iter()
        .filter_map(|r| r.get(1).cloned().flatten())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    (name, cols)
}

/// 索引（按名字分组，列按 position 排）。
///
/// 函数索引的 `column_name` 是空的（表达式在 `all_ind_expressions` 里）。整条丢掉而不是只丢
/// 那一列：少了表达式列的 `create index` 会造出一个**结构不同**的索引，比不生成更坏。
pub fn parse_indexes(rows: &[Vec<Option<String>>]) -> Vec<StructIndex> {
    let mut out: Vec<StructIndex> = Vec::new();
    let mut bad: Vec<String> = Vec::new();
    for r in rows {
        let Some(name) = r
            .first()
            .and_then(|v| v.clone())
            .filter(|s| !s.trim().is_empty())
        else {
            continue;
        };
        let unique = r.get(1).and_then(|v| v.as_deref()).unwrap_or("").trim() == "UNIQUE";
        let col = r
            .get(2)
            .and_then(|v| v.clone())
            .filter(|s| !s.trim().is_empty());
        let Some(col) = col else {
            if !bad.contains(&name) {
                bad.push(name);
            }
            continue;
        };
        // 一次查询里同一个索引的列是连续行；按名字找回同一条记录即可
        match out.iter_mut().find(|i| i.name == name) {
            Some(ix) => ix.columns.push(col.trim().to_string()),
            None => out.push(StructIndex {
                name,
                unique,
                columns: vec![col.trim().to_string()],
            }),
        }
    }
    out.retain(|i| !bad.contains(&i.name));
    out
}

/// 主键对应的索引要排掉：否则「只差一个主键索引」会被报成多一个索引。
pub fn drop_pk_index(mut indexes: Vec<StructIndex>, pk: &[String]) -> Vec<StructIndex> {
    if pk.is_empty() {
        return indexes;
    }
    indexes.retain(|i| !(i.unique && same_columns(&i.columns, pk)));
    indexes
}

fn same_columns(a: &[String], b: &[String]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x.eq_ignore_ascii_case(y))
}

/// 比较两侧结构。
pub fn diff(left: TableStruct, right: TableStruct) -> StructDiff {
    let mut columns: Vec<ColumnDiff> = Vec::new();
    for l in &left.columns {
        match right
            .columns
            .iter()
            .find(|r| r.name.eq_ignore_ascii_case(&l.name))
        {
            None => columns.push(ColumnDiff {
                name: l.name.clone(),
                status: DiffStatus::OnlyLeft,
                left: Some(l.clone()),
                right: None,
                changes: Vec::new(),
            }),
            Some(r) => {
                let changes = field_diffs(l, r);
                columns.push(ColumnDiff {
                    name: l.name.clone(),
                    status: if changes.is_empty() {
                        DiffStatus::Same
                    } else {
                        DiffStatus::Changed
                    },
                    left: Some(l.clone()),
                    right: Some(r.clone()),
                    changes,
                });
            }
        }
    }
    for r in &right.columns {
        if !left
            .columns
            .iter()
            .any(|l| l.name.eq_ignore_ascii_case(&r.name))
        {
            columns.push(ColumnDiff {
                name: r.name.clone(),
                status: DiffStatus::OnlyRight,
                left: None,
                right: Some(r.clone()),
                changes: Vec::new(),
            });
        }
    }

    let indexes = diff_indexes(&left.indexes, &right.indexes);
    let pk_changed = !same_columns(&left.pk, &right.pk);
    let comment_changed = norm_comment(&left.comment) != norm_comment(&right.comment);

    let only_left = columns
        .iter()
        .filter(|c| c.status == DiffStatus::OnlyLeft)
        .count()
        + indexes
            .iter()
            .filter(|i| i.status == DiffStatus::OnlyLeft)
            .count()
        + usize::from(pk_changed && right.pk.is_empty() && !left.pk.is_empty());
    let only_right = columns
        .iter()
        .filter(|c| c.status == DiffStatus::OnlyRight)
        .count()
        + indexes
            .iter()
            .filter(|i| i.status == DiffStatus::OnlyRight)
            .count()
        + usize::from(pk_changed && left.pk.is_empty() && !right.pk.is_empty());
    let changed = columns
        .iter()
        .filter(|c| c.status == DiffStatus::Changed)
        .count()
        + usize::from(pk_changed && !left.pk.is_empty() && !right.pk.is_empty());

    let mut out = StructDiff {
        left,
        right,
        columns,
        indexes,
        pk_changed,
        comment_changed,
        only_left,
        only_right,
        changed,
        ddl: Vec::new(),
    };
    out.ddl = plan_ddl(&out);
    out
}

fn norm_comment(c: &Option<String>) -> String {
    c.as_deref().unwrap_or("").trim().to_string()
}

fn field_diffs(l: &StructColumn, r: &StructColumn) -> Vec<FieldDiff> {
    let mut out = Vec::new();
    let mut push = |field: &str, a: Option<String>, b: Option<String>| {
        if a != b {
            out.push(FieldDiff {
                field: field.to_string(),
                left: a,
                right: b,
            });
        }
    };
    if !l.ty.eq_ignore_ascii_case(&r.ty) {
        push("类型", Some(l.ty.clone()), Some(r.ty.clone()));
    }
    push("可空", Some(yn(l.nullable)), Some(yn(r.nullable)));
    push("默认值", l.default_text.clone(), r.default_text.clone());
    push(
        "注释",
        l.comment.clone().filter(|c| !c.trim().is_empty()),
        r.comment.clone().filter(|c| !c.trim().is_empty()),
    );
    out
}

fn yn(b: bool) -> String {
    if b {
        "是".to_string()
    } else {
        "否".to_string()
    }
}

/// 索引配对按「列组合 + 唯一性」：跨环境索引名常不同（`IDX_A` vs `IDX_A1`），
/// 按名字配会把同一组列报成「左边多一个、右边多一个」。
fn diff_indexes(left: &[StructIndex], right: &[StructIndex]) -> Vec<IndexDiff> {
    let mut out = Vec::new();
    let mut used = vec![false; right.len()];
    for l in left {
        let hit = right.iter().enumerate().position(|(i, r)| {
            !used[i] && r.unique == l.unique && same_columns(&r.columns, &l.columns)
        });
        match hit {
            Some(i) => {
                used[i] = true;
                let r = &right[i];
                out.push(IndexDiff {
                    name: l.name.clone(),
                    left_name: Some(l.name.clone()),
                    right_name: Some(r.name.clone()),
                    unique: l.unique,
                    columns: l.columns.clone(),
                    status: DiffStatus::Same,
                    renamed: !r.name.eq_ignore_ascii_case(&l.name),
                });
            }
            None => out.push(IndexDiff {
                name: l.name.clone(),
                left_name: Some(l.name.clone()),
                right_name: None,
                unique: l.unique,
                columns: l.columns.clone(),
                status: DiffStatus::OnlyLeft,
                renamed: false,
            }),
        }
    }
    for (i, r) in right.iter().enumerate() {
        if used[i] {
            continue;
        }
        out.push(IndexDiff {
            name: r.name.clone(),
            left_name: None,
            right_name: Some(r.name.clone()),
            unique: r.unique,
            columns: r.columns.clone(),
            status: DiffStatus::OnlyRight,
            renamed: false,
        });
    }
    out
}

/// 标识符：只有「普通标识符」才裸写，其它一律加引号——不要为了好看的 DDL 赌一个语法错误。
fn q(name: &str) -> String {
    let plain = !name.is_empty()
        && name
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$' || c == '#');
    if plain {
        name.to_string()
    } else {
        format!("\"{}\"", name.replace('"', "\"\""))
    }
}

fn table_ref(t: &TableStruct) -> String {
    // `OWNER.TABLE`：左侧 label 是拼好的，这里按最后一个点切，避免 owner 里带点导致的歧义
    match t.label.rsplit_once('.') {
        Some((owner, name)) => format!("{}.{}", q(owner), q(name)),
        None => q(&t.label),
    }
}

/// 生成「把右边改成左边」的 DDL。
///
/// 执行顺序有讲究：先删主键/索引再改列（不然改列会被索引挡住），最后才建索引和主键
/// ——建在主键之前会让 PK 索引重名。
pub fn plan_ddl(d: &StructDiff) -> Vec<StructStmt> {
    let mut out: Vec<StructStmt> = Vec::new();
    let t = table_ref(&d.right);

    if d.pk_changed && !d.right.pk.is_empty() {
        out.push(StructStmt {
            sql: format!("alter table {t} drop primary key;"),
            reason: format!(
                "右侧主键是 ({})，左侧是 ({})",
                d.right.pk.join(", "),
                d.left.pk.join(", ")
            ),
            destructive: true,
        });
    }
    for c in &d.columns {
        if c.status != DiffStatus::OnlyRight {
            continue;
        }
        out.push(StructStmt {
            sql: format!("alter table {t} drop column {};", q(&c.name)),
            reason: format!(
                "右侧多出的列（{}）——删之前确认没有数据依赖",
                c.right.as_ref().map(type_of).unwrap_or_default()
            ),
            destructive: true,
        });
    }
    for ix in &d.indexes {
        if ix.status != DiffStatus::OnlyRight {
            continue;
        }
        let name = ix.right_name.clone().unwrap_or_else(|| ix.name.clone());
        out.push(StructStmt {
            sql: format!("drop index {}.{};", owner_of(&d.right), q(&name)),
            reason: format!("右侧多出的索引（列 {}）", ix.columns.join(", ")),
            destructive: true,
        });
    }
    for c in &d.columns {
        if c.status != DiffStatus::OnlyLeft {
            continue;
        }
        let col = c.left.as_ref().expect("onlyLeft 必有左侧列");
        out.push(StructStmt {
            sql: format!("alter table {t} add ({});", column_def(col)),
            reason: format!("右侧缺少这一列（{}）", col.ty),
            destructive: false,
        });
    }
    for c in &d.columns {
        if c.status != DiffStatus::Changed {
            continue;
        }
        let col = c.left.as_ref().expect("changed 必有左侧列");
        let fields: Vec<&str> = c.changes.iter().map(|f| f.field.as_str()).collect();
        if fields.iter().any(|f| *f != "注释") {
            out.push(StructStmt {
                sql: format!("alter table {t} modify ({});", column_def(col)),
                reason: format!("属性不一致：{}", fields.join("、")),
                destructive: false,
            });
        }
        if let Some(note) = comment_stmt(&d.right, col) {
            out.push(note);
        }
    }
    if d.comment_changed {
        out.push(StructStmt {
            sql: format!(
                "comment on table {t} is {};",
                match norm_comment(&d.left.comment) {
                    s if s.is_empty() => "''".to_string(),
                    s => literal(Some(&s), "VARCHAR2"),
                }
            ),
            reason: "表注释不一致".to_string(),
            destructive: false,
        });
    }
    for ix in &d.indexes {
        if ix.status != DiffStatus::OnlyLeft {
            continue;
        }
        let name = ix.left_name.clone().unwrap_or_else(|| ix.name.clone());
        out.push(StructStmt {
            sql: format!(
                "create {}index {}.{} on {t} ({});",
                if ix.unique { "unique " } else { "" },
                owner_of(&d.right),
                q(&name),
                ix.columns
                    .iter()
                    .map(|c| q(c))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            reason: format!("右侧缺少这个{}索引", if ix.unique { "唯一" } else { "" }),
            destructive: false,
        });
    }
    if d.pk_changed && !d.left.pk.is_empty() {
        let name = d
            .left
            .pk_name
            .clone()
            .unwrap_or_else(|| format!("PK_{}", d.left.label.replace('.', "_")));
        out.push(StructStmt {
            sql: format!(
                "alter table {t} add constraint {} primary key ({});",
                q(&name),
                d.left
                    .pk
                    .iter()
                    .map(|c| q(c))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            reason: format!("主键应为 ({})", d.left.pk.join(", ")),
            destructive: false,
        });
    }
    out
}

fn type_of(c: &StructColumn) -> String {
    c.ty.clone()
}

fn owner_of(t: &TableStruct) -> String {
    match t.label.rsplit_once('.') {
        Some((owner, _)) => q(owner),
        None => String::new(),
    }
}

/// `COL TYPE [default X] [not null]`。
fn column_def(c: &StructColumn) -> String {
    let mut s = format!("{} {}", q(&c.name), c.ty);
    if let Some(d) = &c.default_text {
        s.push_str(&format!(" default {d}"));
    }
    if !c.nullable {
        s.push_str(" not null");
    }
    s
}

/// 列注释和左侧不一致时给一条 `comment on column`。
fn comment_stmt(right: &TableStruct, col: &StructColumn) -> Option<StructStmt> {
    let want = norm_comment(&col.comment);
    if want.is_empty() {
        return None;
    }
    Some(StructStmt {
        sql: format!(
            "comment on column {}.{} is {};",
            table_ref(right),
            q(&col.name),
            literal(Some(&want), "VARCHAR2")
        ),
        reason: format!("列 {} 的注释不一致", col.name),
        destructive: false,
    })
}

#[cfg(test)]
#[path = "db_struct_tests.rs"]
mod tests;
