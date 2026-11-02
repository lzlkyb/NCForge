//! 数据字典：把库里的 `md_*` 元数据组装成「表 / 列 / 中文名 / 实体」。
//!
//! 输入是三条 SQL 的结果（见 [`crate::md_dict_sql`]），输出是可直接交付的字典。
//! 这一层全是纯逻辑，**不碰库**，所以所有坑都能用夹具测出来。
//!
//! ## 为什么中文名要从库里取
//!
//! NC 的字段名大量是 `f1`…`f60`、`def1`…`def20`，光看名字没有语义。
//! 中文名不在 Oracle 的 `USER_COL_COMMENTS`（实测基本是空的），也不在 HOME 里的
//! `.bmf`（那是设计态、且不含二开），而在**库里的 `md_table` / `md_column`**——
//! 元数据发布时按关系写进去的，二开也走发布，所以这份是全的。
//! 实测 `md_column` 223 413 行里 99% 有中文名，二开扩展表 100%。
//!
//! ## 三个"不报错但会给出错数据"的点（都在这里兜住）
//!
//! 1. **`md_ormap` 是 1:N**：`bd_billtype` 的 41 列 join 后是 96 行。直接吐出去，
//!    字典会凭空多出 55 行、列数虚高，而且**不报错**。所以按 `(表, 列名)` 折叠，
//!    多出来的属性名并进同一行。
//! 2. **`sqldatetype` 会被当成类型名填进参照档案**：实测 42 列里是
//!    `'供应商档案'`、`'借款单位项目(自定义档案)'` 这种值。当类型直接输出会误导人，
//!    所以非 ASCII 的一律标成 `参照:xxx`。
//! 3. **表 ↔ 实体不是一对一**：`bd_billtype` 有 3 个类映射到它。给单一 VO 类名是撒谎，
//!    所以实体是**候选列表**，多于一个时写进 `notes`。
//!
//! ## 中文判定：SQL 侧与 Rust 侧口径不同，别混用
//!
//! SQL 里判断"有没有中文"只能用 `lengthb(x) > length(x)`——本库是 ZHS16GBK，
//! `regexp_like(x, '[\u4e00-\u9fa5]')` 会**严重漏判**（实测把 99% 判成 69%，而且漏判不均匀，
//! 看起来像"部分模块没填中文"，直接导致误判）。Rust 侧能精确到 CJK 范围，所以用
//! [`has_cjk`]。两者用途不同：前者是库端粗筛，后者是统计"缺多少中文名"。

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ───────────────────────── 桥返回的表格 ─────────────────────────

/// 一段查询结果。
///
/// 行是**数组**、列单独给一份——两个引擎（JVM 桥 / Rust 原生驱动）都这样，
/// 所以必须按列名下标对齐，不能按对象键取值。
///
/// 列的形状随引擎不同：JVM 桥与 Rust 驱动给的是 `{"name":"ID","type":"VARCHAR2",…}`
/// 对象（见 `NcDbBridge.columnsJson` / `db_rust::column_json`），而别的地方见过纯字符串。
/// **两种都收**；但收不出来必须报错——否则每列都读成空串，字典会安静地变成一堆空表。
pub struct Grid {
    index: HashMap<String, usize>,
    rows: Vec<Value>,
}

impl Grid {
    pub fn parse(v: &Value) -> Result<Self, String> {
        let mut index = HashMap::new();
        if let Some(raw) = v.get("columns").and_then(Value::as_array) {
            for (i, c) in raw.iter().enumerate() {
                if let Some(name) = column_name(c) {
                    index.insert(name.to_lowercase(), i);
                }
            }
            if index.is_empty() && !raw.is_empty() {
                return Err(format!(
                    "查询结果有 {} 列，但列名一个都没解析出来（既不是字符串也不是 {{name}} 对象）",
                    raw.len()
                ));
            }
        }
        let rows = v
            .get("rows")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        Ok(Self { index, rows })
    }

    pub fn iter(&self) -> impl Iterator<Item = Row<'_>> {
        self.rows.iter().map(move |r| Row {
            grid: self,
            cells: r,
        })
    }

    /// 结果里有没有这一列。用来在"读到了空结果"和"列名对不上"之间分清。
    pub fn has(&self, key: &str) -> bool {
        self.index.contains_key(&key.to_lowercase())
    }

    pub fn len(&self) -> usize {
        self.rows.len()
    }

    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }
}

fn column_name(c: &Value) -> Option<String> {
    match c {
        Value::String(s) => Some(s.clone()),
        _ => c.get("name").and_then(Value::as_str).map(str::to_string),
    }
}

pub struct Row<'a> {
    grid: &'a Grid,
    cells: &'a Value,
}

impl<'a> Row<'a> {
    fn cell(&self, key: &str) -> Option<&'a Value> {
        let arr = self.cells.as_array()?;
        let i = *self.grid.index.get(&key.to_lowercase())?;
        arr.get(i)
    }

    /// 字符串列。NULL 与"列不存在"都给空串——字典里两者没区别。
    pub fn text(&self, key: &str) -> &'a str {
        match self.cell(key) {
            Some(Value::String(s)) => s.as_str(),
            _ => "",
        }
    }

    /// 数值列。两个引擎给的类型不一样（原生驱动可能为保精度给字符串），两边都吃。
    pub fn num(&self, key: &str) -> Option<i64> {
        match self.cell(key)? {
            Value::Number(n) => n.as_i64(),
            Value::String(s) => s.trim().parse().ok(),
            _ => None,
        }
    }

    /// `'Y'` / `'1'` / `'true'` 都算真。NC 的布尔列用 `'Y'`，但别处见过 `'1'`。
    pub fn flag(&self, key: &str) -> bool {
        let t = self.text(key).trim();
        t.eq_ignore_ascii_case("y") || t == "1" || t.eq_ignore_ascii_case("true")
    }
}

// ───────────────────────── 取数 → 平铺结构 ─────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TableRow {
    pub id: String,
    pub name: String,
    pub display_name: String,
    pub is_extend: bool,
    /// `isactive` 本库全为 NULL（= 启用），NULL 不算停用。
    pub active: bool,
    pub resid: String,
    pub res_module: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColRow {
    pub table_id: String,
    pub name: String,
    pub display_name: String,
    pub raw_type: String,
    pub len: i64,
    pub scale: i64,
    pub pkey: bool,
    pub nullable: bool,
    pub seq: Option<i64>,
    pub prop_name: String,
    pub prop_display: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntRow {
    pub table_id: String,
    pub class_name: String,
    pub full_class: String,
    pub columns: i64,
}

pub fn read_tables(g: &Grid) -> Vec<TableRow> {
    g.iter()
        .map(|r| TableRow {
            id: r.text("id").to_string(),
            name: r.text("name").to_string(),
            display_name: r.text("displayname").to_string(),
            is_extend: r.flag("isextendtable"),
            // 只有明确写了 N 才算停用；NULL 是本库的常态（5876 行全是 NULL）
            active: !r.text("isactive").trim().eq_ignore_ascii_case("n"),
            resid: r.text("resid").to_string(),
            res_module: r.text("resmodule").to_string(),
        })
        .collect()
}

pub fn read_columns(g: &Grid) -> Vec<ColRow> {
    g.iter()
        .map(|r| ColRow {
            table_id: r.text("tid").to_string(),
            name: r.text("cname").to_string(),
            display_name: r.text("cdisp").to_string(),
            raw_type: r.text("ctype").to_string(),
            len: r.num("clen").unwrap_or(0),
            scale: r.num("cscale").unwrap_or(0),
            pkey: r.flag("cpkey"),
            nullable: r.flag("cnull"),
            seq: r.num("cseq"),
            prop_name: r.text("pname").to_string(),
            prop_display: r.text("pdisp").to_string(),
        })
        .collect()
}

pub fn read_entities(g: &Grid) -> Vec<EntRow> {
    g.iter()
        .map(|r| EntRow {
            table_id: r.text("tid").to_string(),
            class_name: r.text("cname").to_string(),
            full_class: r.text("cfull").to_string(),
            columns: r.num("ccols").unwrap_or(0),
        })
        .collect()
}

// ───────────────────────── 交付结构 ─────────────────────────

// `Deserialize` 只为 C 批的导出：界面把**当前屏幕上这份**字典传回来渲染，
// 而不是让后端重查一次库（那要多等 2~3 秒，还会导出一份与屏幕上不一样的字典）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PropRef {
    pub name: String,
    pub display_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDict {
    pub name: String,
    pub display_name: String,
    #[serde(rename = "type")]
    pub type_name: String,
    pub pkey: bool,
    pub nullable: bool,
    pub seq: Option<i64>,
    /// 映射到这一列的实体属性。可能有多个（`md_ormap` 是 1:N），也可能为空。
    pub props: Vec<PropRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityRef {
    pub class_name: String,
    pub full_class_name: String,
    pub columns: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDict {
    pub name: String,
    pub display_name: String,
    pub is_extend: bool,
    pub module: String,
    pub resid: String,
    pub entities: Vec<EntityRef>,
    pub columns: Vec<ColumnDict>,
    /// 组装时发现的问题。**这不是装饰**：字典要能自己说明哪里不可信
    /// （缺中文、多实体、没有列定义），否则用户没法判断该不该依赖它。
    pub notes: Vec<String>,
}

impl TableDict {
    fn new(t: &TableRow) -> Self {
        Self {
            name: t.name.clone(),
            display_name: t.display_name.clone(),
            is_extend: t.is_extend,
            module: t.res_module.trim().to_string(),
            resid: t.resid.trim().to_string(),
            entities: Vec::new(),
            columns: Vec::new(),
            notes: Vec::new(),
        }
    }
}

/// 把三条查询的结果拼成字典。纯函数：不吃库、不看环境，全部可用夹具测。
///
/// 排序：表按名、列按 `columnsequence`（空值排最后）再按名——单据上的字段顺序
/// 才是开发者找东西时的心理顺序，字母序会把它打散。
pub fn build(tables: &[TableRow], columns: &[ColRow], entities: &[EntRow]) -> Vec<TableDict> {
    let mut out: Vec<TableDict> = tables.iter().map(TableDict::new).collect();
    let by_id: HashMap<&str, usize> = tables
        .iter()
        .enumerate()
        .map(|(i, t)| (t.id.as_str(), i))
        .collect();

    // 列：按 (表, 列名) 折叠，属性并入。md_ormap 的 1:N 就是在这里被收掉的
    let mut seen: HashMap<(usize, String), usize> = HashMap::new();
    for c in columns {
        let Some(&ti) = by_id.get(c.table_id.as_str()) else {
            // 列指向的表不在本次选取里（被过滤掉或已删），不往结果里塞
            continue;
        };
        let key = (ti, c.name.to_lowercase());
        if let Some(&ci) = seen.get(&key) {
            // 同一个属性被多条实体映射时，中文名可能不一样（实测 bd_billtype.billstyle：
            // 「单据大类」/「系统类别(单据大类)」）。名字只留一份，中文名并列——
            // 输出两个 billstyle 会让人以为字典写重了。
            let col = &mut out[ti].columns[ci];
            merge_prop(&mut col.props, &c.prop_name, &c.prop_display);
            continue;
        }
        out[ti].columns.push(ColumnDict {
            name: c.name.clone(),
            display_name: c.display_name.trim().to_string(),
            type_name: fmt_type(&c.raw_type, c.len, c.scale),
            pkey: c.pkey,
            nullable: c.nullable,
            seq: c.seq,
            props: {
                let mut v = Vec::new();
                merge_prop(&mut v, &c.prop_name, &c.prop_display);
                v
            },
        });
        seen.insert(key, out[ti].columns.len() - 1);
    }

    for e in entities {
        if let Some(&ti) = by_id.get(e.table_id.as_str()) {
            out[ti].entities.push(EntityRef {
                class_name: e.class_name.clone(),
                full_class_name: e.full_class.clone(),
                columns: e.columns,
            });
        }
    }

    for t in &mut out {
        t.columns.sort_by(|a, b| {
            a.seq
                .unwrap_or(i64::MAX)
                .cmp(&b.seq.unwrap_or(i64::MAX))
                .then_with(|| a.name.cmp(&b.name))
        });
        // 列多的实体排在前面：它更可能是主实体
        t.entities.sort_by(|a, b| {
            b.columns
                .cmp(&a.columns)
                .then_with(|| a.class_name.cmp(&b.class_name))
        });
        t.notes = notes_for(t);
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// 并入一个属性：同名只留一条，中文名并列。
///
/// 为什么要并列而不是"后到的覆盖"：同一列被不同实体映射时，两个实体对它的叫法
/// 都可能有用（`billstyle` → 「单据大类」/「系统类别(单据大类)」），丢掉任一个，
/// 用户按那个词搜就搜不到这一列。
fn merge_prop(props: &mut Vec<PropRef>, name: &str, display: &str) {
    let name = name.trim();
    let disp = display.trim();
    if name.is_empty() && disp.is_empty() {
        return;
    }
    if let Some(p) = props.iter_mut().find(|p| p.name == name) {
        if !disp.is_empty() && p.display_name != disp {
            if p.display_name.is_empty() {
                p.display_name = disp.to_string();
            } else if !p.display_name.split(" / ").any(|s| s == disp) {
                p.display_name = format!("{} / {}", p.display_name, disp);
            }
        }
        return;
    }
    props.push(PropRef {
        name: name.to_string(),
        display_name: disp.to_string(),
    });
}

fn notes_for(t: &TableDict) -> Vec<String> {
    let mut notes = Vec::new();
    if t.columns.is_empty() {
        notes.push("库里没有这张表的列定义（元数据可能只发布了表头）".to_string());
        return notes;
    }
    let missing = t
        .columns
        .iter()
        .filter(|c| !has_cjk(&c.display_name))
        .count();
    if missing > 0 {
        notes.push(format!("{} 列中 {} 列没有中文名", t.columns.len(), missing));
    }
    let mut fulls: Vec<&str> = t
        .entities
        .iter()
        .map(|e| e.full_class_name.as_str())
        .filter(|s| !s.is_empty())
        .collect();
    fulls.sort_unstable();
    fulls.dedup();
    if t.entities.is_empty() {
        notes.push("库里没有实体映射（属性 ↔ 列），所以「属性」为空".to_string());
    } else if fulls.len() > 1 {
        notes.push(format!(
            "本表被 {} 个实体映射：{}。字典以列为准，实体只是候选",
            fulls.len(),
            fulls.join("、")
        ));
    }
    notes
}

/// 有没有汉字。**按 CJK 范围判，不要用 `!s.is_ascii()`**：后者把德文、越南文也算"有中文"，
/// 而这列的意义正是"这个中文字段名到底填了没有"。
pub fn has_cjk(s: &str) -> bool {
    s.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c))
}

/// 元数据里的类型名拼成展示名。
///
/// 实测 `sqldatetype` 的取值比想象中脏：`varchar` / `char` / `decimal` / `int` 是正常的，
/// 但还有 `varchar2(100)`（已经带长度）、`100`（只有长度？？），以及 42 列填的是
/// **参照档案名**（`供应商档案`、`借款单位项目(自定义档案)`）。
/// 所以：非 ASCII 一律标成 `参照:xxx`，别让人以为那是 SQL 类型。
pub fn fmt_type(raw: &str, len: i64, scale: i64) -> String {
    let t = raw.trim();
    if t.is_empty() {
        return String::new();
    }
    if !t.is_ascii() {
        return format!("参照:{t}");
    }
    let up = t.to_ascii_uppercase();
    if up.contains('(') {
        return up;
    }
    let with_len = matches!(
        up.as_str(),
        "VARCHAR" | "VARCHAR2" | "NVARCHAR" | "NVARCHAR2" | "CHAR" | "NCHAR"
    );
    if with_len && len > 0 {
        return format!("{up}({len})");
    }
    let numeric = matches!(up.as_str(), "DECIMAL" | "NUMBER" | "NUMERIC");
    if numeric && len > 0 {
        return if scale > 0 {
            format!("{up}({len},{scale})")
        } else {
            format!("{up}({len})")
        };
    }
    up
}

// ───────────────────────── 产出：CSV / Markdown ─────────────────────────

/// 文档抬头。生成时间由调用方传入，测试才能断言确定的结果。
#[derive(Debug, Clone)]
pub struct DocMeta {
    pub source: String,
    pub generated: String,
    pub selection: String,
}

/// 产出格式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocFormat {
    Csv,
    Markdown,
}

impl DocFormat {
    /// 前端传的是 `"csv"` / `"markdown"`（也收 `"md"`，省得两边各记一套）。
    pub fn parse(s: &str) -> Result<Self, String> {
        match s.trim().to_ascii_lowercase().as_str() {
            "csv" => Ok(Self::Csv),
            "md" | "markdown" => Ok(Self::Markdown),
            other => Err(format!(
                "不认识的导出格式 `{other}`：只有 csv / markdown 两种"
            )),
        }
    }

    pub fn ext(self) -> &'static str {
        match self {
            Self::Csv => "csv",
            Self::Markdown => "md",
        }
    }
}

/// 一份字典 → 文本。**CSV 与 Markdown 都只在这里生成**：界面上的「复制」与
/// 「导出文件」走同一条路径，两份格式才不会各自漂移。
pub fn render(tables: &[TableDict], meta: &DocMeta, f: DocFormat) -> String {
    match f {
        DocFormat::Csv => to_csv(tables),
        DocFormat::Markdown => to_markdown(tables, meta),
    }
}

/// 导出文件名的主体（不含扩展名）：`NC数据字典-前缀-bd_-202611021220`。
///
/// 拼进去的两段都是"外面来的"（`selection` 由后端按选取条件拼，`generated` 由界面给），
/// 所以要先过一遍白名单：只留 ASCII 字母数字、下划线与汉字，其余一律换成 `-`。
/// 不这么做的话 `关键词 a/b`、`指定 "x"` 这类会带出 Windows 文件名非法字符，
/// 写文件时才失败，而且报的是让人看不懂的系统错误。
pub fn doc_stem(selection: &str, generated: &str) -> String {
    let scope = |s: &str| -> String {
        let mut out = String::new();
        let mut last_dash = true; // 开头不吃 '-'
        for c in s.chars() {
            let ok =
                c.is_ascii_alphanumeric() || c == '_' || ('\u{4e00}'..='\u{9fff}').contains(&c);
            if ok {
                out.push(c);
                last_dash = false;
            } else if !last_dash {
                out.push('-');
                last_dash = true;
            }
            if out.chars().count() >= 40 {
                break;
            }
        }
        out.trim_matches('-').to_string()
    };
    // 时间戳只取数字：`2026-11-02 12:20` → `202611021220`。
    let stamp: String = generated.chars().filter(char::is_ascii_digit).collect();
    let stamp = if stamp.len() >= 12 {
        stamp[..12].to_string()
    } else {
        "undated".to_string()
    };
    let s = scope(selection);
    if s.is_empty() {
        format!("NC数据字典-{stamp}")
    } else {
        format!("NC数据字典-{s}-{stamp}")
    }
}

pub const CSV_HEADER: [&str; 13] = [
    "表名",
    "表中文名",
    "是否扩展表",
    "模块",
    "列名",
    "列中文名",
    "类型",
    "主键",
    "可空",
    "序号",
    "属性名",
    "属性中文名",
    "实体",
];

/// CSV（UTF-8 带 BOM、CRLF）。
///
/// - BOM：不带它，Excel 双击打开中文全是乱码，而"给甲方一份字典"最常见的下一步
///   就是双击打开。加 BOM 后 Excel 与 LibreOffice 都正常。
/// - CRLF：Excel 对 LF 的兼容性看版本，CRLF 是 CSV 的规范写法。
/// - 扁平结构一行一列：甲方拿到要自己透视，扁平的才好做数据透视表。
pub fn to_csv(tables: &[TableDict]) -> String {
    let mut s = String::from("\u{feff}");
    s.push_str(&CSV_HEADER.join(","));
    s.push_str("\r\n");
    for t in tables {
        let ents = t
            .entities
            .iter()
            .map(|e| e.class_name.as_str())
            .collect::<Vec<_>>()
            .join(" / ");
        for c in &t.columns {
            let props = c
                .props
                .iter()
                .map(|p| p.name.as_str())
                .collect::<Vec<_>>()
                .join(" / ");
            let prop_disp = c
                .props
                .iter()
                .map(|p| p.display_name.as_str())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(" / ");
            let fields = [
                t.name.as_str(),
                t.display_name.as_str(),
                if t.is_extend { "是" } else { "" },
                t.module.as_str(),
                c.name.as_str(),
                c.display_name.as_str(),
                c.type_name.as_str(),
                if c.pkey { "Y" } else { "" },
                if c.nullable { "Y" } else { "N" },
                &c.seq.map(|v| v.to_string()).unwrap_or_default(),
                props.as_str(),
                prop_disp.as_str(),
                ents.as_str(),
            ];
            s.push_str(
                &fields
                    .iter()
                    .map(|f| csv_field(f))
                    .collect::<Vec<_>>()
                    .join(","),
            );
            s.push_str("\r\n");
        }
    }
    s
}

/// CSV 字段转义：含逗号/引号/换行的加引号，内部引号翻倍。
fn csv_field(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// Markdown：一表一节。给人看的那份，所以把 `notes` 放在表格前面——
/// 先说明"哪里不可信"，再看数据。
pub fn to_markdown(tables: &[TableDict], meta: &DocMeta) -> String {
    let cols: usize = tables.iter().map(|t| t.columns.len()).sum();
    let mut s = String::from("# NC 数据字典\n\n");
    s.push_str(&format!("- 数据源：{}\n", meta.source));
    s.push_str(&format!("- 生成时间：{}\n", meta.generated));
    s.push_str(&format!("- 选取：{}\n", meta.selection));
    s.push_str(&format!("- 共 {} 张表、{} 列\n\n", tables.len(), cols));
    s.push_str(
        "> 说明：中文名取自库里 `md_table` / `md_column` 的元数据（发布时写入，含二开），\
         不是 Oracle 的表/列注释。标「参照:」的类型是元数据里填成了参照档案名，不是 SQL 类型。\n",
    );
    for t in tables {
        s.push_str(&format!("\n## {}　{}\n\n", t.name, t.display_name));
        let mut head = Vec::new();
        if !t.module.is_empty() {
            head.push(format!("模块 `{}`", t.module));
        }
        if t.is_extend {
            head.push("**二开扩展表**".to_string());
        }
        if !head.is_empty() {
            s.push_str(&format!("{}\n\n", head.join(" · ")));
        }
        if !t.entities.is_empty() {
            let e = t
                .entities
                .iter()
                .map(|e| format!("`{}`（{} 列）", e.class_name, e.columns))
                .collect::<Vec<_>>()
                .join("、");
            s.push_str(&format!("实体：{e}\n\n"));
        }
        for n in &t.notes {
            s.push_str(&format!("- ⚠️ {n}\n"));
        }
        if !t.notes.is_empty() {
            s.push('\n');
        }
        if t.columns.is_empty() {
            continue;
        }
        s.push_str("| # | 列名 | 中文名 | 类型 | 主键 | 可空 | 属性 |\n");
        s.push_str("|---|---|---|---|---|---|---|\n");
        for c in &t.columns {
            let props = c
                .props
                .iter()
                .map(|p| {
                    if p.display_name.is_empty() {
                        p.name.clone()
                    } else {
                        format!("{}（{}）", p.name, p.display_name)
                    }
                })
                .collect::<Vec<_>>()
                .join(" / ");
            s.push_str(&format!(
                "| {} | {} | {} | {} | {} | {} | {} |\n",
                c.seq.map(|v| v.to_string()).unwrap_or_default(),
                md_cell(&c.name),
                md_cell(&c.display_name),
                md_cell(&c.type_name),
                if c.pkey { "√" } else { "" },
                if c.nullable { "√" } else { "否" },
                md_cell(&props),
            ));
        }
    }
    s
}

fn md_cell(s: &str) -> String {
    s.replace('|', "\\|").replace('\n', " ")
}

/// 统计：表数、列数、缺中文名的列数。界面上用一行说明"这份字典有多完整"。
pub fn stats(tables: &[TableDict]) -> (usize, usize, usize) {
    let cols: usize = tables.iter().map(|t| t.columns.len()).sum();
    let missing = tables
        .iter()
        .flat_map(|t| t.columns.iter())
        .filter(|c| !has_cjk(&c.display_name))
        .count();
    (tables.len(), cols, missing)
}

/// 请求了但库里没有的表。**必须报出来**：用户从补丁草稿带过来的表可能在元数据里
/// 不存在（手工建的表、或名字写错），静默丢掉等于让人以为"这张表没字段"。
pub fn missing_tables(requested: &[String], built: &[TableDict]) -> Vec<String> {
    let got: Vec<String> = built.iter().map(|t| t.name.to_lowercase()).collect();
    requested
        .iter()
        .map(|r| r.trim().to_string())
        .filter(|r| !r.is_empty() && !got.contains(&r.to_lowercase()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grid(columns: &[&str], rows: Vec<Vec<Value>>) -> Grid {
        // 真实形状：列是 `{name, type, …}` 对象，不是字符串
        let cols: Vec<Value> = columns
            .iter()
            .map(|c| serde_json::json!({ "name": c, "type": "VARCHAR2", "scale": 0 }))
            .collect();
        Grid::parse(&serde_json::json!({ "columns": cols, "rows": rows })).unwrap()
    }

    #[test]
    fn 列名解析不出来时报错而不是每列读成空() {
        // 形状变了却静默返回空串，会让字典变成一堆空表——这种失败比报错坏得多
        let bad = serde_json::json!({ "columns": [1, 2], "rows": [[1, 2]] });
        assert!(Grid::parse(&bad).is_err());
    }

    #[test]
    fn 列名也给纯字符串时同样能读() {
        let g = Grid::parse(&serde_json::json!({
            "columns": ["ID", "NAME"],
            "rows": [["t1", "bd_billtype"]],
        }))
        .unwrap();
        assert_eq!(read_tables(&g)[0].name, "bd_billtype");
    }

    #[test]
    fn 空结果不算错但能分辨出列名对不上() {
        let g = Grid::parse(&serde_json::json!({ "columns": [], "rows": [] })).unwrap();
        assert!(g.is_empty());
        assert!(!g.has("id"));
    }

    fn table(id: &str, name: &str, disp: &str) -> TableRow {
        TableRow {
            id: id.into(),
            name: name.into(),
            display_name: disp.into(),
            is_extend: false,
            active: true,
            resid: String::new(),
            res_module: "busitype".into(),
        }
    }

    fn col(table: &str, name: &str, disp: &str) -> ColRow {
        ColRow {
            table_id: table.into(),
            name: name.into(),
            display_name: disp.into(),
            raw_type: "varchar".into(),
            len: 50,
            scale: 0,
            pkey: false,
            nullable: true,
            seq: Some(1),
            prop_name: String::new(),
            prop_display: String::new(),
        }
    }

    #[test]
    fn 行是数组时按列名下标取值() {
        // 两个引擎都回 {columns, rows:[[...]]}，列名大小写随驱动变
        let g = grid(
            &["ID", "NAME", "ISEXTENDTABLE", "ISACTIVE"],
            vec![vec![
                Value::String("t1".into()),
                Value::String("bd_billtype".into()),
                Value::String("Y".into()),
                Value::Null,
            ]],
        );
        let rows = read_tables(&g);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].name, "bd_billtype");
        assert!(rows[0].is_extend, "'Y' 是真");
        assert!(
            rows[0].active,
            "isactive 为 NULL 必须算启用，本库 5876 行全是 NULL"
        );
    }

    #[test]
    fn 数值列字符串与数字都吃() {
        let g = grid(
            &["CLEN", "CSCALE", "CSEQ"],
            vec![vec![
                Value::String("50".into()),
                serde_json::json!(8),
                Value::Null,
            ]],
        );
        let c = read_columns(&g).remove(0);
        assert_eq!(c.len, 50);
        assert_eq!(c.scale, 8);
        assert_eq!(c.seq, None, "NULL 序号要能区分出来");
    }

    #[test]
    fn ormap_的一对多被折叠成一行() {
        // bd_billtype 实测：41 列 join 后 96 行，其中 29 列有多个属性
        let t = vec![table("t1", "bd_billtype", "交易类型")];
        let mut base = col("t1", "billtypename", "名称");
        base.prop_name = "billtypename".into();
        base.prop_display = "名称".into();
        let other = ColRow {
            prop_name: "transtypename".into(),
            prop_display: "交易类型名称".into(),
            ..base.clone()
        };
        let out = build(&t, &[base, other.clone(), other], &[]);
        assert_eq!(out[0].columns.len(), 1, "三行同列必须折叠成一行");
        assert_eq!(out[0].columns[0].props.len(), 2, "两个属性都要留下");
        assert_eq!(out[0].columns[0].props[1].name, "transtypename");
    }

    #[test]
    fn 重复属性不会重复出现() {
        let t = vec![table("t1", "x", "X")];
        let mut c = col("t1", "a", "A");
        c.prop_name = "p".into();
        let out = build(&t, &[c.clone(), c], &[]);
        assert_eq!(out[0].columns[0].props.len(), 1);
    }

    #[test]
    fn 同名属性中文名不同时并列而不是输出两行() {
        // 实测 bd_billtype.billstyle：BilltypeVO 叫「单据大类」，
        // transtype 叫「系统类别(单据大类)」
        let t = vec![table("t1", "bd_billtype", "交易类型")];
        let mut a = col("t1", "billstyle", "单据大类");
        a.prop_name = "billstyle".into();
        a.prop_display = "单据大类".into();
        let mut b = a.clone();
        b.prop_display = "系统类别(单据大类)".into();
        let out = build(&t, &[a, b], &[]);
        let props = &out[0].columns[0].props;
        assert_eq!(props.len(), 1, "同一个属性名只该出现一次");
        assert_eq!(props[0].display_name, "单据大类 / 系统类别(单据大类)");
    }

    #[test]
    fn 列按序号排且空序号排最后() {
        let t = vec![table("t1", "x", "X")];
        let mut a = col("t1", "z_col", "Z");
        a.seq = None;
        let mut b = col("t1", "b_col", "B");
        b.seq = Some(2);
        let mut c = col("t1", "a_col", "A");
        c.seq = Some(1);
        let out = build(&t, &[a, b, c], &[]);
        let names: Vec<&str> = out[0].columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["a_col", "b_col", "z_col"]);
    }

    #[test]
    fn 指向未选表的列被丢弃而不是报错() {
        let t = vec![table("t1", "x", "X")];
        let out = build(&t, &[col("t1", "a", "A"), col("t9", "b", "B")], &[]);
        assert_eq!(out[0].columns.len(), 1);
    }

    #[test]
    fn 表被多个实体映射时写进_notes() {
        let t = vec![table("t1", "bd_billtype", "交易类型")];
        let ents = vec![
            EntRow {
                table_id: "t1".into(),
                class_name: "transtype".into(),
                full_class: "nc.vo.pub.billtype.BilltypeVO".into(),
                columns: 35,
            },
            EntRow {
                table_id: "t1".into(),
                class_name: "BilltypeVO".into(),
                full_class: "nc.vo.pub.billtype.BilltypeVO".into(),
                columns: 30,
            },
            EntRow {
                table_id: "t1".into(),
                class_name: "出入库类型".into(),
                full_class: "nc.vo.ia.pub.transtype.TranstypeVO".into(),
                columns: 26,
            },
        ];
        let out = build(&t, &[col("t1", "a", "A")], &ents);
        assert_eq!(out[0].entities.len(), 3);
        assert_eq!(out[0].entities[0].class_name, "transtype", "列多的排前面");
        let note = out[0].notes.iter().find(|n| n.contains("实体")).unwrap();
        assert!(note.contains("2 个实体"), "同一个 VO 类不该算两个：{note}");
        assert!(note.contains("TranstypeVO"));
    }

    #[test]
    fn 同一个_vo_类不算多实体() {
        let t = vec![table("t1", "x", "X")];
        let ents = vec![
            EntRow {
                table_id: "t1".into(),
                class_name: "a".into(),
                full_class: "nc.A".into(),
                columns: 5,
            },
            EntRow {
                table_id: "t1".into(),
                class_name: "b".into(),
                full_class: "nc.A".into(),
                columns: 3,
            },
        ];
        let out = build(&t, &[col("t1", "c", "C")], &ents);
        assert!(
            !out[0].notes.iter().any(|n| n.contains("个实体")),
            "两个类名共用一个 VO 类不构成歧义"
        );
    }

    #[test]
    fn 缺中文名要自己说出来() {
        let t = vec![table("t1", "x", "X")];
        let out = build(
            &t,
            &[
                col("t1", "a", "名称"),
                col("t1", "b", ""),
                col("t1", "c", "x2"),
            ],
            &[],
        );
        let note = out[0]
            .notes
            .iter()
            .find(|n| n.contains("没有中文名"))
            .unwrap();
        assert!(note.contains("3 列中 2 列"), "{note}");
    }

    #[test]
    fn 没有列定义的表给出明确提示() {
        let out = build(&[table("t1", "gl_docfree2", "")], &[], &[]);
        assert!(out[0].notes[0].contains("没有这张表的列定义"));
    }

    #[test]
    fn 中文判定只认汉字() {
        assert!(has_cjk("交易类型"));
        assert!(!has_cjk("BilltypeVO"), "纯英文不算有中文名");
        assert!(!has_cjk("Größe"), "德文不是中文，!is_ascii 会误判");
        assert!(!has_cjk(""));
    }

    #[test]
    fn 类型拼装覆盖实测的四种脏值() {
        assert_eq!(fmt_type("varchar", 50, 0), "VARCHAR(50)");
        assert_eq!(fmt_type("DECIMAL", 28, 8), "DECIMAL(28,8)");
        assert_eq!(fmt_type("decimal", 10, 0), "DECIMAL(10)");
        assert_eq!(fmt_type("int", 0, 0), "INT");
        // 已经带长度的原样保留
        assert_eq!(fmt_type("varchar2(100)", 100, 0), "VARCHAR2(100)");
        // 42 列填的是参照档案名，不能当类型输出
        assert_eq!(fmt_type("供应商档案", 20, 0), "参照:供应商档案");
        assert_eq!(
            fmt_type("借款单位项目(自定义档案)", 20, 0),
            "参照:借款单位项目(自定义档案)"
        );
        assert_eq!(fmt_type("", 0, 0), "");
    }

    #[test]
    fn csv_带_bom_与_crlf_且转义() {
        let t = vec![table("t1", "x", "带,逗号")];
        let csv = to_csv(&build(&t, &[col("t1", "a", "引\"号")], &[]));
        assert!(
            csv.starts_with('\u{feff}'),
            "没有 BOM 时 Excel 打开中文乱码"
        );
        assert!(csv.contains("\r\n"));
        assert!(csv.contains("\"带,逗号\""));
        assert!(csv.contains("\"引\"\"号\""));
    }

    #[test]
    fn csv_表头与数据行字段数一致() {
        // 用不带逗号的值来数字段：含逗号的字段本身会被引号包住，按逗号切会多切一段
        let t = vec![table("t1", "x", "交易类型")];
        let csv = to_csv(&build(&t, &[col("t1", "a", "名称")], &[]));
        let head = csv.lines().next().unwrap().trim_start_matches('\u{feff}');
        let data = csv.lines().nth(1).unwrap();
        assert_eq!(head.split(',').count(), CSV_HEADER.len());
        assert_eq!(
            data.split(',').count(),
            CSV_HEADER.len(),
            "多一列少一列都会让透视错位"
        );
    }

    #[test]
    fn markdown_抬头有意外的表时表格不破() {
        let t = vec![table("t1", "x", "X")];
        let md = to_markdown(
            &build(&t, &[col("t1", "a", "含|竖线")], &[]),
            &DocMeta {
                source: "aier260824".into(),
                generated: "2026-11-02 10:00".into(),
                selection: "前缀 bd_".into(),
            },
        );
        assert!(md.contains("含\\|竖线"), "竖线必须转义，否则表格错列");
        assert!(md.contains("前缀 bd_"));
    }

    #[test]
    fn 请求了库里没有的表要报出来() {
        let built = build(&[table("t1", "bd_billtype", "")], &[], &[]);
        let miss = missing_tables(
            &["bd_billtype".into(), "zz_not_exist".into(), "  ".into()],
            &built,
        );
        assert_eq!(miss, vec!["zz_not_exist"], "空白项不算缺表");
    }

    #[test]
    fn 统计三件套() {
        let t = vec![table("t1", "x", "X")];
        let st = stats(&build(
            &t,
            &[col("t1", "a", "名称"), col("t1", "b", "")],
            &[],
        ));
        assert_eq!(st, (1, 2, 1));
    }

    #[test]
    fn 导出的字典能原样回传解析() {
        // C 批的导出/复制是「前端把屏幕上这份整体传回后端渲染」，所以这一组结构
        // 既要 Serialize 又要 Deserialize，且**字段名必须对称**。
        // 最容易错的是 `type`：Rust 里字段叫 type_name，序列化被 rename 成 `type`，
        // 前端类型里也写的 `type`；哪天 rename 丢了，前端回传时这一列会解析失败。
        let t = TableDict {
            name: "bd_material".into(),
            display_name: "物料".into(),
            is_extend: true,
            module: "bd".into(),
            resid: "bd_material".into(),
            entities: vec![EntityRef {
                class_name: "MaterialVO".into(),
                full_class_name: "nc.vo.bd.material.MaterialVO".into(),
                columns: 2,
            }],
            columns: vec![ColumnDict {
                name: "code".into(),
                display_name: "编码".into(),
                type_name: "VARCHAR2(40)".into(),
                pkey: false,
                nullable: false,
                seq: Some(2),
                props: vec![PropRef {
                    name: "code".into(),
                    display_name: "编码".into(),
                }],
            }],
            notes: vec!["缺中文名".into()],
        };
        let json = serde_json::to_value(&t).unwrap();
        assert_eq!(json["columns"][0]["type"], "VARCHAR2(40)");
        assert_eq!(
            json["entities"][0]["fullClassName"],
            "nc.vo.bd.material.MaterialVO"
        );
        let back: TableDict = serde_json::from_value(json).unwrap();
        assert_eq!(back, t);
    }

    #[test]
    fn 导出格式只认两种() {
        assert_eq!(DocFormat::parse("csv").unwrap(), DocFormat::Csv);
        assert_eq!(DocFormat::parse(" Markdown ").unwrap(), DocFormat::Markdown);
        assert_eq!(DocFormat::parse("md").unwrap(), DocFormat::Markdown);
        // 拼错就报错，别退化成"默认导出 CSV"——文件名是 .csv，内容也是，但用户要的是 md
        assert!(DocFormat::parse("excel").is_err());
        assert_eq!(DocFormat::Csv.ext(), "csv");
        assert_eq!(DocFormat::Markdown.ext(), "md");
    }

    #[test]
    fn 两种格式都从同一份字典渲染() {
        let t = build(
            &[table("t1", "bd_billtype", "单据类型")],
            &[col("t1", "f1", "名称")],
            &[],
        );
        let meta = DocMeta {
            source: "u@db".into(),
            generated: "2026-11-02 12:20".into(),
            selection: "指定 1 张表".into(),
        };
        let csv = render(&t, &meta, DocFormat::Csv);
        let md = render(&t, &meta, DocFormat::Markdown);
        assert!(
            csv.starts_with('\u{feff}'),
            "CSV 必须带 BOM，否则 Excel 打开中文乱码"
        );
        assert!(csv.contains("bd_billtype") && csv.contains("名称"));
        assert!(md.starts_with("# NC 数据字典"));
        assert!(md.contains("## bd_billtype") && md.contains("指定 1 张表"));
    }

    #[test]
    fn 文件名只留安全字符() {
        // `selection` 是后端拼的、`generated` 是界面给的，都当外部输入处理：
        // Windows 文件名非法字符留在里面，要到写文件时才炸，报的还是系统错误
        assert_eq!(
            doc_stem("前缀 bd_", "2026-11-02 12:20"),
            "NC数据字典-前缀-bd_-202611021220"
        );
        assert_eq!(
            doc_stem("关键词 a/b", "2026-11-02 12:20"),
            "NC数据字典-关键词-a-b-202611021220"
        );
        assert_eq!(
            doc_stem("指定 3 张表", "2026-11-02 12:20"),
            "NC数据字典-指定-3-张表-202611021220"
        );
    }

    #[test]
    fn 文件名不会因为脏输入变成空或超长() {
        // 全是非法字符 → 拿不到片段就只留时间，不能出现 `NC数据字典--2026…`
        assert_eq!(
            doc_stem("///", "2026-11-02 12:20"),
            "NC数据字典-202611021220"
        );
        // 时间给不出来时也要有个稳定后缀，不能生成 `NC数据字典-bd_.`
        assert!(doc_stem("bd_", "").ends_with("-undated"));
        // 长名字截断，别把 Windows 的 260 字符路径挤爆
        let long = doc_stem(&"长".repeat(200), "2026-11-02 12:20");
        assert!(long.chars().count() <= 40 + "NC数据字典-".chars().count() + 13);
    }
}
