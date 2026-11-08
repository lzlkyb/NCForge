//! Query transfer protocol and row-at-a-time text encoders. Database acquisition lives in commands.
use std::collections::HashSet;
use std::io::Write;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TransferFormat {
    Csv,
    Tsv,
    Json,
    Jsonl,
    Markdown,
    Html,
    Insert,
    Xlsx,
    Update,
    #[serde(rename = "where", alias = "condition")]
    Condition,
}
impl TransferFormat {
    pub fn ext(self) -> &'static str {
        match self {
            Self::Csv => "csv",
            Self::Tsv => "tsv",
            Self::Json => "json",
            Self::Jsonl => "jsonl",
            Self::Markdown => "md",
            Self::Html => "html",
            Self::Xlsx => "xlsx",
            Self::Insert | Self::Update | Self::Condition => "sql",
        }
    }
}
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TransferColumn {
    pub name: String,
    #[serde(rename = "type", default)]
    pub ty: String,
    #[serde(default)]
    pub precision: Option<i32>,
    #[serde(default)]
    pub scale: Option<i32>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferData {
    pub columns: Vec<TransferColumn>,
    pub rows: Vec<Vec<Value>>,
    pub original_rows: Option<Vec<Vec<Value>>>,
    pub query: Option<String>,
}
#[derive(Debug, Clone, Deserialize)]
pub struct TransferSheet {
    pub name: String,
    pub data: TransferData,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TransferOptions {
    pub format: String,
    pub header: String,
    pub null_text: String,
    pub delimiter: String,
    pub line_ending: String,
    pub bom: bool,
    pub spreadsheet_safe: bool,
    pub transpose: bool,
    pub json_structure: String,
    pub table: String,
    pub schema: String,
    pub keys: Vec<usize>,
    pub keys_confirmed: bool,
    pub column_indices: Vec<usize>,
    pub column_labels: Vec<String>,
    pub include_query: bool,
    pub nc: bool,
    pub commit_every: usize,
    pub condition: Option<String>,
    pub include_null: bool,
}
impl Default for TransferOptions {
    fn default() -> Self {
        Self {
            format: String::new(),
            header: "name".into(),
            null_text: String::new(),
            delimiter: ",".into(),
            line_ending: "lf".into(),
            bom: false,
            spreadsheet_safe: true,
            transpose: false,
            json_structure: "objects".into(),
            table: String::new(),
            schema: String::new(),
            keys: vec![],
            keys_confirmed: false,
            column_indices: vec![],
            column_labels: vec![],
            include_query: false,
            nc: false,
            commit_every: 0,
            condition: None,
            include_null: false,
        }
    }
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferReq {
    pub id: String,
    #[serde(default)]
    pub sql: String,
    pub format: TransferFormat,
    pub file_name: Option<String>,
    pub max_rows: Option<usize>,
    pub timeout_sec: Option<u32>,
    pub export_id: u64,
    pub destination_token: Option<String>,
    pub options: TransferOptions,
    pub data: Option<TransferData>,
    pub sheets: Option<Vec<TransferSheet>>,
    pub expected_columns: Option<Vec<String>>,
    pub source_schema: Option<String>,
    pub source_connection_key: Option<String>,
    pub params: Option<Vec<Value>>,
    pub context: Option<TransferContext>,
    pub text: Option<String>,
    pub text_rows: Option<usize>,
    pub text_truncated: Option<bool>,
    pub text_warnings: Option<Vec<String>>,
}
#[derive(Debug, Deserialize)]
pub struct TransferContext {
    pub source: String,
    pub scope: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferOut {
    pub path: String,
    pub file_name: String,
    pub rows: usize,
    pub bytes: u64,
    pub truncated: bool,
    pub canceled: bool,
    pub ms: u64,
    pub destination_token: String,
    pub warnings: Vec<String>,
}

pub fn cell_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        _ => v.to_string(),
    }
}
pub fn validate_cell(v: &Value) -> Result<(), String> {
    if let Value::Number(n) = v {
        if n.as_f64().is_some_and(|n| {
            !n.is_finite() || (n.fract() == 0.0 && n.abs() > 9_007_199_254_740_991.0)
        }) {
            return Err("数值已超出 JavaScript 安全精度，请重新读取为字符串后输出".into());
        }
    }
    if matches!(v, Value::Array(_) | Value::Object(_)) {
        Err("单元格必须是字符串、数字、布尔或 NULL".into())
    } else {
        Ok(())
    }
}
pub fn validate_options(
    fmt: TransferFormat,
    o: &TransferOptions,
    remote: bool,
) -> Result<(), String> {
    if !o.format.is_empty() {
        let declared = serde_json::from_value::<TransferFormat>(Value::String(o.format.clone()))
            .map_err(|_| "格式设置无效")?;
        if declared != fmt {
            return Err("文件格式与输出设置不一致".into());
        }
    }
    if !matches!(o.header.as_str(), "name" | "zh" | "both" | "none") {
        return Err("表头设置无效".into());
    }
    if !matches!(o.line_ending.as_str(), "lf" | "crlf") {
        return Err("换行设置无效".into());
    }
    if !matches!(o.json_structure.as_str(), "objects" | "columns") {
        return Err("JSON 结构设置无效".into());
    }
    if matches!(fmt, TransferFormat::Csv | TransferFormat::Tsv)
        && (o.delimiter.is_empty() || o.delimiter.contains(['"', '\r', '\n', '\0']))
    {
        return Err("分隔符不能为空或包含引号、换行".into());
    }
    if o.nc {
        return Err("NC 迁移请使用专用 INSERT 导出窗口，以保留主键和多语规则".into());
    }
    if matches!(fmt, TransferFormat::Insert | TransferFormat::Update) && o.table.trim().is_empty() {
        return Err("SQL 输出需要目标表名".into());
    }
    if o.commit_every > 100_000 {
        return Err("提交间隔不能超过 100000 行".into());
    }
    if remote && (o.transpose || matches!(fmt, TransferFormat::Update | TransferFormat::Condition))
    {
        return Err("全量查询不支持转置、条件或 UPDATE；请先选择已加载数据".into());
    }
    if o.transpose
        && !matches!(
            fmt,
            TransferFormat::Csv
                | TransferFormat::Tsv
                | TransferFormat::Markdown
                | TransferFormat::Html
                | TransferFormat::Xlsx
        )
    {
        return Err("此格式不支持转置".into());
    }
    if o.condition
        .as_deref()
        .is_some_and(|s| !matches!(s, "in" | "notIn" | "where"))
    {
        return Err("条件设置无效".into());
    }
    Ok(())
}

/// Indices and labels refer to the original query layout; selected output never changes key semantics.
#[derive(Debug, Clone)]
pub struct Layout {
    pub indices: Vec<usize>,
    pub columns: Vec<TransferColumn>,
    pub labels: Vec<String>,
}
impl Layout {
    pub fn new(cols: &[TransferColumn], o: &TransferOptions) -> Result<Self, String> {
        if cols.is_empty() {
            return Err("结果集没有列元数据".into());
        }
        let indices = if o.column_indices.is_empty() {
            (0..cols.len()).collect()
        } else {
            o.column_indices.clone()
        };
        let mut seen = HashSet::new();
        if indices.iter().any(|i| *i >= cols.len() || !seen.insert(*i)) {
            return Err("选择列与来源列布局不匹配".into());
        }
        if !o.column_labels.is_empty() && o.column_labels.len() != cols.len() {
            return Err("列标签与来源列布局不匹配".into());
        }
        if o.keys.iter().any(|i| *i >= cols.len())
            || o.keys.iter().copied().collect::<HashSet<_>>().len() != o.keys.len()
        {
            return Err("键列与来源列布局不匹配".into());
        }
        let columns: Vec<_> = indices.iter().map(|i| cols[*i].clone()).collect();
        let labels = indices
            .iter()
            .map(|i| {
                let name = &cols[*i].name;
                let zh = o
                    .column_labels
                    .get(*i)
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or(name);
                if matches!(o.header.as_str(), "zh" | "both") {
                    zh.trim().to_string()
                } else {
                    name.clone()
                }
            })
            .collect();
        Ok(Self {
            indices,
            columns,
            labels,
        })
    }
    pub fn row(&self, row: &[Value]) -> Vec<Value> {
        self.indices.iter().map(|i| row[*i].clone()).collect()
    }
}
pub fn validate_rows(data: &TransferData) -> Result<(), String> {
    for row in data.rows.iter().chain(data.original_rows.iter().flatten()) {
        if row.len() != data.columns.len() {
            return Err("结果行与来源列数不一致".into());
        }
        for c in row {
            validate_cell(c)?;
        }
    }
    if data
        .original_rows
        .as_ref()
        .is_some_and(|r| r.len() != data.rows.len())
    {
        return Err("原始行与修改行数量不一致".into());
    }
    Ok(())
}
pub fn validate_update(data: &TransferData, o: &TransferOptions) -> Result<(), String> {
    if !o.keys_confirmed || o.keys.is_empty() {
        return Err("UPDATE 需要确认唯一且非空的键列".into());
    }
    let original = data
        .original_rows
        .as_ref()
        .ok_or("UPDATE 需要编辑前的原始行")?;
    let mut seen = HashSet::new();
    for row in original {
        let mut key = Vec::new();
        for i in &o.keys {
            let v = row.get(*i).ok_or("键列下标无效")?;
            if v.is_null() || matches!(v, Value::String(s) if s.is_empty()) {
                return Err("UPDATE 键列包含 NULL 或空字符串".into());
            }
            if !valid_sql_value(v, &data.columns[*i]) {
                return Err("UPDATE 原始键值无法生成可靠 SQL 字面量".into());
            }
            validate_cell(v)?;
            let lit = key_identity(v, &data.columns[*i])?;
            if lit == "NULL" {
                return Err("UPDATE 键列不能转换为 NULL".into());
            }
            key.push(lit);
        }
        if !seen.insert(key) {
            return Err("UPDATE 键列在原始数据中重复".into());
        }
    }
    Ok(())
}
pub fn sql_literal(v: &Value, col: &TransferColumn) -> String {
    if v.is_null() || matches!(v,Value::String(s) if s.is_empty()) {
        return if !v.is_null() && !numeric_column(col) && !date_column(col) {
            "''".into()
        } else {
            "NULL".into()
        };
    }
    let text = cell_text(v);
    if date_column(col) {
        if let Some(parts) = date_pattern().captures(&text) {
            let day = &parts[1];
            let time = parts.get(2).map(|m| m.as_str());
            let fraction = parts.get(3).map(|m| m.as_str()).unwrap_or("");
            let zone = parts.get(4).map(|m| m.as_str());
            let mut date = format!(
                "{day}{}{fraction}",
                time.map(|t| format!(" {t}")).unwrap_or_default()
            );
            let mut mask = format!(
                "YYYY-MM-DD{}{}",
                if time.is_some() { " HH24:MI:SS" } else { "" },
                if fraction.is_empty() { "" } else { ".FF" }
            );
            if let Some(z) = zone {
                date.push(' ');
                date.push_str(if z == "Z" { "+00:00" } else { z });
                mask.push_str(if z == "Z" || z.starts_with(['+', '-']) {
                    " TZH:TZM"
                } else {
                    " TZR"
                });
            }
            let function = if zone.is_some() {
                "TO_TIMESTAMP_TZ"
            } else if crate::sql_export::base_type(&col.ty).starts_with("TIMESTAMP")
                || !fraction.is_empty()
            {
                "TO_TIMESTAMP"
            } else {
                "TO_DATE"
            };
            return format!("{function}({}, '{}')", sql_quote(&date), mask);
        }
    }
    if v.is_number() || (numeric_column(col) && numeric_syntax(&text)) {
        return text;
    }
    if let Value::Bool(b) = v {
        return if *b { "1" } else { "0" }.into();
    }
    sql_quote(&text)
}
fn sql_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}
fn date_column(c: &TransferColumn) -> bool {
    let ty = crate::sql_export::base_type(&c.ty);
    ty.starts_with("DATE") || ty.starts_with("TIMESTAMP")
}
fn date_pattern() -> &'static regex::Regex {
    static PATTERN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    PATTERN.get_or_init(|| regex::Regex::new(r"^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}:\d{2})(\.\d{1,9})?)?(?:\s*(Z|[+-]\d{2}:\d{2}|[A-Za-z]+(?:/[A-Za-z_]+)+))?$").expect("constant date regex"))
}
fn identifier_pattern() -> &'static regex::Regex {
    static PATTERN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    PATTERN.get_or_init(|| {
        regex::Regex::new(r#"^(?:[A-Za-z_][\w$#]*|"(?:[^"\r\n]|"")+")$"#)
            .expect("constant identifier regex")
    })
}
fn valid_identifier(s: &str) -> bool {
    identifier_pattern().is_match(s)
}
fn valid_target(s: &str) -> bool {
    if valid_identifier(s) {
        return true;
    }
    for (i, c) in s.char_indices() {
        if c == '.' && valid_identifier(&s[..i]) && valid_identifier(&s[i + 1..]) {
            return true;
        }
    }
    false
}
pub fn validate_sql_layout(
    cols: &[TransferColumn],
    layout: &Layout,
    o: &TransferOptions,
    fmt: TransferFormat,
) -> Result<(), String> {
    if fmt != TransferFormat::Condition
        && (!valid_target(&o.table)
            || (!o.schema.is_empty()
                && (!valid_identifier(&o.schema) || !valid_identifier(&o.table))))
    {
        return Err("Schema 或目标表名无效，请确认表映射".into());
    }
    let mut names = HashSet::new();
    let referenced: HashSet<_> = layout
        .indices
        .iter()
        .chain(if fmt == TransferFormat::Update {
            o.keys.iter()
        } else {
            [].iter()
        })
        .copied()
        .collect();
    for i in referenced {
        let name = &cols[i].name;
        if !valid_identifier(name) {
            return Err("SQL 列名无效，请确认目标列映射".into());
        }
        let identity = if name.starts_with('"') {
            name[1..name.len() - 1].replace("\"\"", "\"")
        } else {
            name.to_uppercase()
        };
        if !names.insert(identity) {
            return Err("SQL 输出含重复目标列名，请确认列映射".into());
        }
    }
    Ok(())
}
fn valid_sql_value(v: &Value, c: &TransferColumn) -> bool {
    v.is_null()
        || matches!(v,Value::String(s) if s.is_empty())
        || ((!numeric_column(c) || numeric_syntax(&cell_text(v)))
            && (!date_column(c) || date_pattern().is_match(&cell_text(v))))
}
pub fn validate_sql_row(
    row: &[Value],
    cols: &[TransferColumn],
    indices: &[usize],
) -> Result<(), String> {
    if indices
        .iter()
        .any(|i| !valid_sql_value(&row[*i], &cols[*i]))
    {
        Err("数字或日期列存在无法生成可靠 SQL 字面量的值".into())
    } else {
        Ok(())
    }
}
fn target_name(o: &TransferOptions) -> String {
    if o.schema.is_empty() {
        o.table.clone()
    } else {
        format!("{}.{}", o.schema, o.table)
    }
}
fn key_identity(v: &Value, c: &TransferColumn) -> Result<String, String> {
    let text = cell_text(v);
    if !numeric_column(c) || !numeric_syntax(&text) {
        return Ok(sql_literal(v, c));
    }
    let negative = text.starts_with('-');
    let unsigned = text.trim_start_matches(['+', '-']);
    let mut pieces = unsigned.split(['e', 'E']);
    let mantissa = pieces.next().unwrap();
    let exponent = pieces
        .next()
        .unwrap_or("0")
        .parse::<i128>()
        .map_err(|_| "UPDATE 键值指数过大，不能确认唯一记录")?;
    let fractional = mantissa.split_once('.').map(|(_, f)| f.len()).unwrap_or(0);
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let significant = digits.trim_start_matches('0');
    if significant.is_empty() {
        return Ok("0".into());
    }
    let trimmed = significant.trim_end_matches('0');
    let e = exponent
        .checked_sub(fractional as i128)
        .and_then(|e| e.checked_add((significant.len() - trimmed.len()) as i128))
        .ok_or("UPDATE 键值指数过大，不能确认唯一记录")?;
    Ok(format!("{}{trimmed}e{e}", if negative { "-" } else { "" }))
}
pub fn xml_text(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
pub fn json_keys(cols: &[TransferColumn]) -> Vec<String> {
    let reserved: HashSet<_> = cols.iter().map(|c| c.name.as_str()).collect();
    let mut used = HashSet::new();
    cols.iter()
        .map(|c| {
            let mut key = c.name.clone();
            if used.contains(&key) {
                let mut n = 2;
                loop {
                    key = format!("{}_{n}", c.name);
                    if !used.contains(&key) && !reserved.contains(key.as_str()) {
                        break;
                    }
                    n += 1;
                }
            }
            used.insert(key.clone());
            key
        })
        .collect()
}
fn formula_safe(s: String, enabled: bool) -> String {
    let t = s.trim_start_matches([' ', '\t', '\r', '\n']);
    let finite = t.trim().parse::<f64>().is_ok_and(f64::is_finite);
    let numeric = numeric_syntax(s.trim());
    let mantissa = s
        .trim()
        .trim_start_matches(['+', '-'])
        .split(['e', 'E'])
        .next()
        .unwrap_or("");
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let protected_number = numeric
        && ((mantissa.starts_with('0')
            && mantissa.chars().nth(1).is_some_and(|c| c.is_ascii_digit()))
            || digits.trim_start_matches('0').len() > 15
            || !finite);
    let risk = matches!(t.chars().next(), Some('=' | '@'))
        || (matches!(t.chars().next(), Some('+' | '-')) && !finite)
        || protected_number;
    if enabled && risk {
        format!("'{s}")
    } else {
        s
    }
}
fn delimited(s: String, delimiter: &str, safe: bool) -> String {
    let guarded = formula_safe(s.clone(), safe);
    if guarded != s || guarded.contains(delimiter) || guarded.contains(['"', '\n', '\r']) {
        format!("\"{}\"", guarded.replace('"', "\"\""))
    } else {
        guarded
    }
}

pub fn header_rows(
    columns: &[TransferColumn],
    labels: &[String],
    header: &str,
) -> Vec<Vec<String>> {
    let names: Vec<_> = columns.iter().map(|c| c.name.clone()).collect();
    match header {
        "none" => vec![],
        "both" => vec![names, labels.to_vec()],
        "zh" => vec![labels.to_vec()],
        _ => vec![names],
    }
}
fn html_text(s: &str) -> String {
    xml_text(s).replace("&apos;", "&#39;")
}
pub(crate) fn numeric_syntax(s: &str) -> bool {
    // Same decimal/scientific grammar as the spreadsheet preset, without converting the actual output.
    let body = s.strip_prefix(['+', '-']).unwrap_or(s);
    let mut parts = body.split(['e', 'E']);
    let mantissa = parts.next().unwrap_or("");
    let mut dot = false;
    let mut digit = false;
    for c in mantissa.chars() {
        if c.is_ascii_digit() {
            digit = true;
        } else if c == '.' && !dot {
            dot = true;
        } else {
            return false;
        }
    }
    if !digit {
        return false;
    }
    if let Some(e) = parts.next() {
        let e = e.strip_prefix(['+', '-']).unwrap_or(e);
        if e.is_empty() || !e.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
    }
    parts.next().is_none()
}
pub fn numeric_column(c: &TransferColumn) -> bool {
    matches!(
        crate::sql_export::base_type(&c.ty).as_str(),
        "NUMBER"
            | "INTEGER"
            | "INT"
            | "SMALLINT"
            | "DECIMAL"
            | "NUMERIC"
            | "FLOAT"
            | "REAL"
            | "DOUBLE"
            | "DOUBLE PRECISION"
            | "BINARY_DOUBLE"
            | "BINARY_FLOAT"
    )
}
fn json_cell(v: &Value, c: &TransferColumn) -> Value {
    let Some(s) = v.as_str().filter(|_| numeric_column(c)) else {
        return v.clone();
    };
    let Ok(n) = serde_json::from_str::<serde_json::Number>(s) else {
        return v.clone();
    };
    let Some(number) = n.as_f64().filter(|n| n.is_finite()) else {
        return v.clone();
    };
    if !s.contains(['.', 'e', 'E']) {
        return if number.abs() <= 9_007_199_254_740_991.0 {
            Value::Number(n)
        } else {
            v.clone()
        };
    }
    let digits: String = s
        .trim_start_matches('-')
        .split(['e', 'E'])
        .next()
        .unwrap_or(s)
        .chars()
        .filter(char::is_ascii_digit)
        .collect();
    let digits = digits.trim_start_matches('0');
    if digits.len() <= 15
        && (number != 0.0 || !digits.contains(['1', '2', '3', '4', '5', '6', '7', '8', '9']))
        && (number.fract() != 0.0 || number.abs() <= 9_007_199_254_740_991.0)
    {
        Value::Number(n)
    } else {
        v.clone()
    }
}

/// Writes only one row of temporary strings; JSON envelopes and HTML tables are closed on finish.
pub struct TextWriter<W: Write> {
    out: W,
    fmt: TransferFormat,
    cols: Vec<TransferColumn>,
    options: TransferOptions,
    keys: Vec<String>,
    rows: usize,
    bytes: u64,
    line_started: bool,
}
impl<W: Write> TextWriter<W> {
    pub fn new(
        out: W,
        fmt: TransferFormat,
        cols: Vec<TransferColumn>,
        labels: &[String],
        o: &TransferOptions,
        query: &str,
    ) -> Result<Self, String> {
        let mut w = Self {
            out,
            fmt,
            keys: json_keys(&cols),
            cols,
            options: o.clone(),
            rows: 0,
            bytes: 0,
            line_started: false,
        };
        if o.bom && matches!(fmt, TransferFormat::Csv | TransferFormat::Tsv) {
            w.write("\u{feff}")?;
        }
        match fmt {
            TransferFormat::Json if o.json_structure == "columns" => {
                w.write("{\"columns\":")?;
                w.write(
                    &serde_json::to_string(&w.cols.iter().map(|c| &c.name).collect::<Vec<_>>())
                        .map_err(|e| e.to_string())?,
                )?;
                w.write(",\"rows\":[")?;
            }
            TransferFormat::Json => w.write("[")?,
            TransferFormat::Html => {
                w.write("<meta charset=\"utf-8\"><table>")?;
                if o.include_query && !query.is_empty() {
                    w.write(&format!("<caption>{}</caption>", html_text(query)))?;
                }
            }
            TransferFormat::Insert | TransferFormat::Update if o.include_query => {
                for line in query.lines() {
                    w.line(&format!("-- {line}"))?;
                }
            }
            _ => {}
        }
        let headers = header_rows(&w.cols, labels, &o.header);
        if !headers.is_empty() {
            match fmt {
                TransferFormat::Csv | TransferFormat::Tsv => {
                    for row in &headers {
                        w.delimited_row(row)?;
                    }
                }
                TransferFormat::Markdown => {
                    let text = (0..labels.len())
                        .map(|i| {
                            headers
                                .iter()
                                .map(|r| markdown_text(&r[i]))
                                .collect::<Vec<_>>()
                                .join("<br>")
                        })
                        .collect::<Vec<_>>();
                    w.markdown_raw_row(&text)?;
                    w.line(&format!(
                        "| {} |",
                        w.cols
                            .iter()
                            .map(|c| if numeric_column(c) { "---:" } else { "---" })
                            .collect::<Vec<_>>()
                            .join(" | "),
                    ))?;
                }
                TransferFormat::Html => {
                    w.write("<thead>")?;
                    for row in &headers {
                        w.write("<tr>")?;
                        for s in row {
                            w.write(&format!(
                                "<th>{}</th>",
                                html_text(s)
                                    .replace("\r\n", "<br>")
                                    .replace(['\r', '\n'], "<br>")
                            ))?;
                        }
                        w.write("</tr>")?;
                    }
                    w.write("</thead>")?;
                }
                _ => {}
            }
        } else if fmt == TransferFormat::Markdown {
            // Markdown requires a separator row. Empty headings retain the user's header-none intent.
            w.markdown_row(&vec![String::new(); labels.len()])?;
            w.line(&format!(
                "| {} |",
                w.cols
                    .iter()
                    .map(|c| if numeric_column(c) { "---:" } else { "---" })
                    .collect::<Vec<_>>()
                    .join(" | "),
            ))?;
        }
        if fmt == TransferFormat::Html {
            w.write("<tbody>")?;
        }
        Ok(w)
    }
    fn eol(&self) -> &'static str {
        if self.options.line_ending == "crlf" {
            "\r\n"
        } else {
            "\n"
        }
    }
    fn write(&mut self, s: &str) -> Result<(), String> {
        self.out
            .write_all(s.as_bytes())
            .map_err(|e| format!("写导出文件失败：{e}"))?;
        self.bytes += s.len() as u64;
        Ok(())
    }
    fn line(&mut self, s: &str) -> Result<(), String> {
        if self.line_started {
            self.write(self.eol())?;
        }
        self.line_started = true;
        self.write(s)
    }
    fn delimited_row(&mut self, values: &[String]) -> Result<(), String> {
        let d = self.options.delimiter.as_str();
        let line = values
            .iter()
            .map(|s| delimited(s.clone(), d, self.options.spreadsheet_safe))
            .collect::<Vec<_>>()
            .join(d);
        self.line(&line)
    }
    fn markdown_row(&mut self, values: &[String]) -> Result<(), String> {
        self.markdown_raw_row(&values.iter().map(|s| markdown_text(s)).collect::<Vec<_>>())
    }
    fn markdown_raw_row(&mut self, values: &[String]) -> Result<(), String> {
        let line = values.join(" | ");
        self.line(&format!("| {line} |"))
    }
    pub fn push(&mut self, row: &[Value]) -> Result<(), String> {
        if row.len() != self.cols.len() {
            return Err("输出行与列数不一致".into());
        }
        for v in row {
            validate_cell(v)?;
        }
        match self.fmt {
            TransferFormat::Csv
            | TransferFormat::Tsv
            | TransferFormat::Markdown
            | TransferFormat::Html => {
                let values: Vec<_> = row
                    .iter()
                    .map(|v| {
                        if v.is_null() {
                            self.options.null_text.clone()
                        } else {
                            cell_text(v)
                        }
                    })
                    .collect();
                match self.fmt {
                    TransferFormat::Csv | TransferFormat::Tsv => self.delimited_row(&values)?,
                    TransferFormat::Markdown => self.markdown_row(&values)?,
                    _ => {
                        self.write("<tr>")?;
                        for s in &values {
                            self.write(&format!(
                                "<td>{}</td>",
                                html_text(s)
                                    .replace("\r\n", "<br>")
                                    .replace(['\r', '\n'], "<br>")
                            ))?;
                        }
                        self.write("</tr>")?;
                    }
                }
            }
            TransferFormat::Json | TransferFormat::Jsonl => {
                if self.fmt == TransferFormat::Json && self.rows > 0 {
                    self.write(",")?;
                }
                let values: Vec<_> = row
                    .iter()
                    .zip(&self.cols)
                    .map(|(v, c)| json_cell(v, c))
                    .collect();
                let text = if self.options.json_structure == "columns" {
                    if self.fmt == TransferFormat::Jsonl { serde_json::to_string(&serde_json::json!({"columns":self.cols.iter().map(|c| &c.name).collect::<Vec<_>>(), "row":values})) } else { serde_json::to_string(&values) }
                } else {
                    // Emit in query order; duplicate aliases must never discard an earlier value.
                    let fields: Vec<_> = self
                        .keys
                        .iter()
                        .zip(&values)
                        .map(|(k, v)| format!("{}:{}", json_string(k), v))
                        .collect();
                    Ok(format!("{{{}}}", fields.join(",")))
                }
                .map_err(|e: serde_json::Error| e.to_string())?;
                if self.fmt == TransferFormat::Jsonl {
                    self.line(&text)?;
                } else {
                    self.write(&text)?;
                }
            }
            TransferFormat::Insert => {
                let target = target_name(&self.options);
                let names = self
                    .cols
                    .iter()
                    .map(|c| c.name.clone())
                    .collect::<Vec<_>>()
                    .join(", ");
                let values = row
                    .iter()
                    .zip(&self.cols)
                    .map(|(v, c)| sql_literal(v, c))
                    .collect::<Vec<_>>()
                    .join(", ");
                validate_sql_row(row, &self.cols, &(0..self.cols.len()).collect::<Vec<_>>())?;
                self.line(&format!(
                    "INSERT INTO {target} ({names}) VALUES ({values});"
                ))?;
            }
            _ => return Err("此格式需要专用写入器".into()),
        }
        self.rows += 1;
        self.commit_periodic()
    }
    pub fn push_update(
        &mut self,
        row: &[Value],
        original: &[Value],
        source: &[TransferColumn],
        indices: &[usize],
    ) -> Result<(), String> {
        let assignments: Vec<_> = indices
            .iter()
            .filter(|i| !self.options.keys.contains(i) || row[**i] != original[**i])
            .map(|i| {
                format!(
                    "{} = {}",
                    source[*i].name,
                    sql_literal(&row[*i], &source[*i])
                )
            })
            .collect();
        if !assignments.is_empty() {
            let conditions = self
                .options
                .keys
                .iter()
                .map(|i| {
                    format!(
                        "{} = {}",
                        source[*i].name,
                        sql_literal(&original[*i], &source[*i])
                    )
                })
                .collect::<Vec<_>>()
                .join(" AND ");
            let target = target_name(&self.options);
            self.line(&format!(
                "UPDATE {target} SET {} WHERE {conditions};",
                assignments.join(", ")
            ))?;
        } else {
            return Err("没有可更新的字段，请选择非键列或修改键值".into());
        }
        self.rows += 1;
        self.commit_periodic()
    }
    fn commit_periodic(&mut self) -> Result<(), String> {
        if matches!(self.fmt, TransferFormat::Insert | TransferFormat::Update)
            && self.options.commit_every > 0
            && self.rows.is_multiple_of(self.options.commit_every)
        {
            self.line("COMMIT;")?;
        }
        Ok(())
    }
    pub fn raw(&mut self, text: &str) -> Result<(), String> {
        self.write(text)
    }
    pub fn bytes(&self) -> u64 {
        self.bytes
    }
    pub fn finish(mut self) -> Result<W, String> {
        match self.fmt {
            TransferFormat::Json => self.write(if self.options.json_structure == "columns" {
                "]}"
            } else {
                "]"
            })?,
            TransferFormat::Html => self.write("</tbody></table>")?,
            TransferFormat::Insert | TransferFormat::Update
                if self.rows > 0
                    && self.options.commit_every > 0
                    && !self.rows.is_multiple_of(self.options.commit_every) =>
            {
                self.line("COMMIT;")?
            }
            _ => {}
        }
        self.out
            .flush()
            .map_err(|e| format!("刷新导出文件失败：{e}"))?;
        Ok(self.out)
    }
}
fn json_string(s: &str) -> String {
    serde_json::to_string(s).expect("string serialization is infallible")
}
fn markdown_text(s: &str) -> String {
    html_text(s)
        .replace('\\', "\\\\")
        .replace('|', "\\|")
        .replace("\r\n", "<br>")
        .replace(['\r', '\n'], "<br>")
}

/// Local-only conditions are bounded by the supplied page and deduplicate literal tuples.
pub fn condition_text(
    data: &TransferData,
    layout: &Layout,
    o: &TransferOptions,
    count: usize,
) -> Result<String, String> {
    let kind = o.condition.as_deref().unwrap_or("in");
    let mut seen = HashSet::new();
    let mut tuples = Vec::new();
    let mut saw_null = false;
    for row in data.rows.iter().take(count) {
        let values: Vec<_> = layout
            .indices
            .iter()
            .map(|i| sql_literal(&row[*i], &data.columns[*i]))
            .collect();
        if kind != "where" && values.len() != 1 {
            return Err("IN / NOT IN 只能选择一列".into());
        }
        if values.iter().any(|v| v == "NULL" || v == "''") && kind != "where" {
            saw_null = true;
            continue;
        }
        if seen.insert(values.clone()) {
            tuples.push(values);
        }
    }
    let names: Vec<_> = layout.columns.iter().map(|c| c.name.clone()).collect();
    if kind == "where" {
        let conditions: Vec<_> = tuples
            .iter()
            .map(|t| {
                format!(
                    "({})",
                    t.iter()
                        .zip(&names)
                        .map(|(v, n)| if v == "NULL" || v == "''" {
                            format!("{n} IS NULL")
                        } else {
                            format!("{n} = {v}")
                        })
                        .collect::<Vec<_>>()
                        .join(" AND ")
                )
            })
            .collect();
        return Ok(format!(
            "WHERE {}",
            if conditions.is_empty() {
                "1 = 0".into()
            } else {
                conditions.join(&format!(
                    "{}OR ",
                    if o.line_ending == "crlf" {
                        "\r\n"
                    } else {
                        "\n"
                    }
                ))
            }
        ));
    }
    let negated = kind == "notIn";
    if tuples.is_empty() {
        return Ok(if saw_null && o.include_null {
            format!("{} IS {}NULL", names[0], if negated { "NOT " } else { "" })
        } else if negated {
            "1 = 1".into()
        } else {
            "1 = 0".into()
        });
    }
    // Oracle 11g IN has a 1000-expression limit. Join batches without changing NOT IN semantics.
    let mut chunks: Vec<_> = tuples
        .chunks(1000)
        .map(|chunk| {
            format!(
                "{} {} ({})",
                names[0],
                if negated { "NOT IN" } else { "IN" },
                chunk
                    .iter()
                    .map(|v| v[0].as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })
        .collect();
    if saw_null && o.include_null {
        chunks.push(format!(
            "{} IS {}NULL",
            names[0],
            if negated { "NOT " } else { "" }
        ));
    }
    Ok(if chunks.len() == 1 {
        chunks.remove(0)
    } else {
        format!(
            "({})",
            chunks.join(&format!(
                "{}{} ",
                if o.line_ending == "crlf" {
                    "\r\n"
                } else {
                    "\n"
                },
                if negated { "AND" } else { "OR" }
            ))
        )
    })
}

pub fn transpose_columns(
    data: &TransferData,
    layout: &Layout,
    o: &TransferOptions,
    count: usize,
) -> (Layout, Vec<Vec<String>>) {
    let headers = header_rows(&layout.columns, &layout.labels, &o.header);
    let width = headers.len() + count.min(data.rows.len());
    let columns = (0..width)
        .map(|_| TransferColumn {
            name: String::new(),
            ty: "VARCHAR2".into(),
            precision: None,
            scale: None,
        })
        .collect();
    (
        Layout {
            indices: (0..width).collect(),
            columns,
            labels: vec![String::new(); width],
        },
        headers,
    )
}
pub fn transposed_row(
    data: &TransferData,
    layout: &Layout,
    headers: &[Vec<String>],
    o: &TransferOptions,
    count: usize,
    i: usize,
) -> Vec<Value> {
    headers
        .iter()
        .map(|r| Value::String(r[i].clone()))
        .chain(data.rows.iter().take(count).map(|r| {
            let v = &r[layout.indices[i]];
            Value::String(if v.is_null() {
                o.null_text.clone()
            } else {
                cell_text(v)
            })
        }))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn col(name: &str, ty: &str) -> TransferColumn {
        TransferColumn {
            name: name.into(),
            ty: ty.into(),
            precision: None,
            scale: None,
        }
    }
    fn render(fmt: TransferFormat, o: &TransferOptions, rows: &[Vec<Value>]) -> String {
        let cols = vec![col("ID", "VARCHAR2"), col("NOTE", "VARCHAR2")];
        let mut w = TextWriter::new(
            Vec::new(),
            fmt,
            cols,
            &["ID".into(), "NOTE".into()],
            o,
            "select 1",
        )
        .unwrap();
        for r in rows {
            w.push(r).unwrap();
        }
        String::from_utf8(w.finish().unwrap()).unwrap()
    }
    #[test]
    fn closes_empty_and_partial_json_and_html() {
        let o = TransferOptions::default();
        assert_eq!(render(TransferFormat::Json, &o, &[]), "[]");
        let text = render(
            TransferFormat::Json,
            &o,
            &[vec![Value::Null, Value::String("line\n\"".into())]],
        );
        assert_eq!(
            serde_json::from_str::<Value>(&text).unwrap()[0]["NOTE"],
            "line\n\""
        );
        assert!(render(TransferFormat::Html, &o, &[]).ends_with("</tbody></table>"));
    }
    #[test]
    fn csv_round_trip_quoting_and_formula_guard() {
        let mut o = TransferOptions {
            delimiter: ";".into(),
            line_ending: "crlf".into(),
            ..Default::default()
        };
        let row = vec![
            Value::String("a;b\n\"x\"".into()),
            Value::String(" =1+1".into()),
        ];
        let safe = render(TransferFormat::Csv, &o, std::slice::from_ref(&row));
        assert!(safe.contains("\"a;b\n\"\"x\"\"\";\"' =1+1\""));
        o.spreadsheet_safe = false;
        assert!(render(TransferFormat::Csv, &o, &[row]).contains("; =1+1"));
    }
    #[test]
    fn writes_one_hundred_thousand_wide_rows_to_sink_without_retaining_the_result() {
        let columns: Vec<_> = (0..52)
            .map(|i| col(&format!("C{i:02}"), "VARCHAR2"))
            .collect();
        let labels: Vec<_> = columns.iter().map(|c| c.name.clone()).collect();
        let options = TransferOptions {
            spreadsheet_safe: false,
            ..Default::default()
        };
        let mut writer = TextWriter::new(
            std::io::sink(),
            TransferFormat::Csv,
            columns,
            &labels,
            &options,
            "",
        )
        .unwrap();
        let row = vec![Value::String("value".into()); 52];
        for _ in 0..100_000 {
            writer.push(&row).unwrap();
        }
        assert_eq!(writer.rows, 100_000);
        // Only the fixed input row and the current formatted row exist; sink discards every write.
        // Header = 52 three-byte labels + 51 separators; each row = 52 values + 51 separators + LF.
        assert_eq!(writer.bytes(), 52 * 3 + 51 + 100_000 * (52 * 5 + 51 + 1));
        writer.finish().unwrap();
    }
    struct FailingWrite {
        remaining: usize,
    }
    impl std::io::Write for FailingWrite {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            if self.remaining == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::StorageFull,
                    "injected disk write failure",
                ));
            }
            let count = self.remaining.min(buf.len());
            self.remaining -= count;
            Ok(count)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    #[test]
    fn propagates_mid_row_disk_write_failure_without_counting_an_incomplete_row() {
        let options = TransferOptions {
            header: "none".into(),
            ..Default::default()
        };
        let mut writer = TextWriter::new(
            FailingWrite { remaining: 3 },
            TransferFormat::Csv,
            vec![col("VALUE", "VARCHAR2")],
            &["VALUE".into()],
            &options,
            "",
        )
        .unwrap();
        let error = writer
            .push(&[Value::String("longer than budget".into())])
            .unwrap_err();
        assert!(error.contains("injected disk write failure"));
        assert_eq!(
            writer.rows, 0,
            "a partially written row is not a completed row"
        );
    }
    #[test]
    fn selected_layout_and_duplicate_json_names_preserve_every_value() {
        let cols = vec![
            col("ID", "NUMBER"),
            col("ID", "NUMBER"),
            col("ID_2", "NUMBER"),
        ];
        assert_eq!(json_keys(&cols), vec!["ID", "ID_3", "ID_2"]);
        let o = TransferOptions {
            column_indices: vec![2, 0],
            ..Default::default()
        };
        let l = Layout::new(&cols, &o).unwrap();
        assert_eq!(l.indices, vec![2, 0]);
        assert!(Layout::new(
            &cols,
            &TransferOptions {
                column_indices: vec![3],
                ..Default::default()
            }
        )
        .is_err());
    }
    #[test]
    fn update_requires_unique_original_non_null_keys() {
        let mut d = TransferData {
            columns: vec![col("ID", "NUMBER")],
            rows: vec![vec![Value::from(2)]],
            original_rows: Some(vec![vec![Value::from(1)]]),
            query: None,
        };
        let o = TransferOptions {
            keys: vec![0],
            keys_confirmed: true,
            ..Default::default()
        };
        assert!(validate_update(&d, &o).is_ok());
        d.original_rows.as_mut().unwrap().push(vec![Value::from(1)]);
        assert!(validate_update(&d, &o).is_err());
        d.original_rows = Some(vec![vec![Value::Null]]);
        assert!(validate_update(&d, &o).is_err());
    }
    #[test]
    fn remote_dangerous_modes_rejected() {
        assert!(validate_options(
            TransferFormat::Xlsx,
            &TransferOptions {
                transpose: true,
                ..Default::default()
            },
            true
        )
        .is_err());
        assert!(validate_options(
            TransferFormat::Update,
            &TransferOptions {
                table: "T".into(),
                ..Default::default()
            },
            true
        )
        .is_err());
    }
    fn json_equal(actual: &Value, expected: &Value) -> bool {
        match (actual, expected) {
            (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
            (Value::Array(a), Value::Array(b)) => {
                a.len() == b.len() && a.iter().zip(b).all(|(a, b)| json_equal(a, b))
            }
            (Value::Object(a), Value::Object(b)) => {
                a.len() == b.len()
                    && a.iter()
                        .all(|(k, v)| b.get(k).is_some_and(|e| json_equal(v, e)))
            }
            _ => actual == expected,
        }
    }
    #[test]
    fn frontend_generated_fixtures_match_native_formats() {
        let fixture: Value =
            serde_json::from_str(include_str!("../tests/fixtures/db-transfer/格式样本.json"))
                .unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let data: TransferData = serde_json::from_value(case["data"].clone()).unwrap();
            let options: TransferOptions = serde_json::from_value(case["options"].clone()).unwrap();
            let fmt: TransferFormat =
                serde_json::from_value(case["options"]["format"].clone()).unwrap();
            validate_options(fmt, &options, false).unwrap();
            validate_rows(&data).unwrap();
            let layout = Layout::new(&data.columns, &options).unwrap();
            if matches!(
                fmt,
                TransferFormat::Insert | TransferFormat::Update | TransferFormat::Condition
            ) {
                validate_sql_layout(&data.columns, &layout, &options, fmt).unwrap();
            }
            let actual = if fmt == TransferFormat::Condition {
                condition_text(&data, &layout, &options, data.rows.len()).unwrap()
            } else {
                let mut native_options = options.clone();
                let (native_layout, headers) = if options.transpose {
                    native_options.header = "none".into();
                    transpose_columns(&data, &layout, &options, data.rows.len())
                } else {
                    (layout.clone(), vec![])
                };
                let mut writer = TextWriter::new(
                    Vec::new(),
                    fmt,
                    native_layout.columns,
                    &native_layout.labels,
                    &native_options,
                    data.query.as_deref().unwrap_or(""),
                )
                .unwrap();
                if options.transpose {
                    for i in 0..layout.indices.len() {
                        writer
                            .push(&transposed_row(
                                &data,
                                &layout,
                                &headers,
                                &options,
                                data.rows.len(),
                                i,
                            ))
                            .unwrap();
                    }
                } else if fmt == TransferFormat::Update {
                    validate_update(&data, &options).unwrap();
                    for (i, row) in data.rows.iter().enumerate() {
                        writer
                            .push_update(
                                row,
                                &data.original_rows.as_ref().unwrap()[i],
                                &data.columns,
                                &layout.indices,
                            )
                            .unwrap();
                    }
                } else {
                    for row in &data.rows {
                        writer.push(&layout.row(row)).unwrap();
                    }
                }
                String::from_utf8(writer.finish().unwrap()).unwrap()
            };
            let expected = case["expected"].as_str().unwrap();
            if fmt == TransferFormat::Json {
                assert!(
                    json_equal(
                        &serde_json::from_str::<Value>(&actual).unwrap(),
                        &serde_json::from_str::<Value>(expected).unwrap()
                    ),
                    "{name}: {actual}"
                );
            } else if fmt == TransferFormat::Jsonl {
                let a: Vec<Value> = actual
                    .lines()
                    .map(|s| serde_json::from_str(s).unwrap())
                    .collect();
                let b: Vec<Value> = expected
                    .lines()
                    .map(|s| serde_json::from_str(s).unwrap())
                    .collect();
                assert!(json_equal(&json!(a), &json!(b)), "{name}: {actual}");
            } else {
                assert_eq!(actual, expected, "{name}");
            }
        }
    }
    #[test]
    fn update_numeric_key_identity_is_exact_without_float_rounding() {
        let mut d = TransferData {
            columns: vec![col("ID", "NUMBER")],
            rows: vec![
                vec![Value::String("1".into())],
                vec![Value::String("1.00".into())],
            ],
            original_rows: Some(vec![
                vec![Value::String("1".into())],
                vec![Value::String("1e0".into())],
            ]),
            query: None,
        };
        let o = TransferOptions {
            keys: vec![0],
            keys_confirmed: true,
            ..Default::default()
        };
        assert!(validate_update(&d, &o).is_err());
        d.original_rows = Some(vec![
            vec![Value::String("12345678901234567890".into())],
            vec![Value::String("12345678901234567891".into())],
        ]);
        assert!(validate_update(&d, &o).is_ok());
    }
}
