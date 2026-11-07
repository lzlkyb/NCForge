//! 自有模板 Excel（.xlsx）导入 / 导出。
//!
//! 目标是「导出当前字段 → 在 Excel 里增改 → 导入预览 → 逐条 diff 后写入」这条闭环，
//! **不是** UAP PDM 官方模板。官方格式的列名与语义要等真实样本，届时另做适配器；
//! 这里生成的表头只服务于本工具自己。
//!
//! 为什么手写 OOXML 而不是引表格库：只用到 inlineStr / 数字两种单元格，zip 已在依赖里；
//! 引入 calamine / rust_xlsxwriter 会为一张 12 列的字段表多背一整套解析器。
//!
//! 导入只规划、不写盘：返回逐行状态与 `EditOp`，由前端展示后再走 `bmf_edit_save`
//! （SHA 校验、备份、原子写、diff 都在那条既有路径上）。

use std::collections::{HashMap, HashSet};
use std::io::{Cursor, Read, Write};
use std::path::Path;

use serde::Serialize;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::bmf_model::{parse, BmfDoc, XmlNode};
use crate::bmf_write::{is_field_ident, sha256, EditOp};

pub const SHEET: &str = "字段";
const NOTE_SHEET: &str = "说明";
const HEADERS: [&str; 12] = [
    "实体",
    "字段名",
    "列名",
    "显示名",
    "类型",
    "数据类型",
    "数据库类型",
    "长度",
    "精度",
    "可空",
    "默认值",
    "主键",
];
const MAX_PART: u64 = 32 * 1024 * 1024;
/// Excel 的列上限（XFD = 16384）。`r="ZZZZZZ1"` 这类畸形引用不能按真实值去分配。
const MAX_COLS: usize = 16_384;

#[derive(Debug, Clone)]
enum Cell {
    Text(String),
    Int(Option<u32>),
}

fn text(s: &str) -> Cell {
    Cell::Text(s.to_string())
}
fn flag(b: bool) -> Cell {
    text(if b { "是" } else { "否" })
}

/// 生成自有模板：第一张表是当前组件的字段清单，第二张是使用说明。
pub fn template_bytes(doc: &BmfDoc) -> Result<Vec<u8>, String> {
    let mut rows: Vec<Vec<Cell>> = vec![HEADERS.iter().map(|h| text(h)).collect()];
    for e in &doc.entities {
        for a in &e.attrs {
            rows.push(vec![
                text(&e.name),
                text(&a.name),
                text(&a.field),
                text(&a.display_name),
                text(&a.type_name),
                text(&a.data_type),
                text(&a.db_type),
                Cell::Int(a.length),
                Cell::Int(a.precision),
                flag(a.nullable),
                text(&a.default_value),
                flag(a.is_key),
            ]);
        }
    }
    let notes: Vec<Vec<Cell>> = [
        "NCForge 自有字段模板（不是官方 PDM 导入格式；官方格式等样本到位后另做适配器）。",
        "用法：导出 → 在 Excel 里增改字段 → 回到元数据页「导入导出」预览差异 → 确认后写入。",
        "空单元格 = 不修改（新增行的空值按默认：类型 String、可空、非主键）。",
        "新增字段不能直接设主键；取消已有主键、删除字段请在结构页显式操作。",
        "保存后不要改表头文字；列顺序可以调整，导入按表头识别列。",
        "写入仍走受控编辑：校验原件 SHA、备份、原子写、给出 unified diff。",
    ]
    .into_iter()
    .map(|s| vec![text(s)])
    .collect();
    write_xlsx(&[(SHEET, rows), (NOTE_SHEET, notes)])
}

fn col_letters(mut n: usize) -> String {
    let mut out = Vec::new();
    while n > 0 {
        let rem = (n - 1) % 26;
        out.push((b'A' + rem as u8) as char);
        n = (n - 1) / 26;
    }
    out.iter().rev().collect()
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn cell_xml(row: usize, col: usize, cell: &Cell, header: bool) -> String {
    let style = if header { r#" s="1""# } else { "" };
    match cell {
        Cell::Text(t) if t.is_empty() => String::new(),
        Cell::Text(t) => format!(
            r#"<c r="{}{}" t="inlineStr"{}><is><t xml:space="preserve">{}</t></is></c>"#,
            col_letters(col),
            row,
            style,
            esc(t)
        ),
        Cell::Int(Some(v)) => {
            format!(
                r#"<c r="{}{}"{}><v>{v}</v></c>"#,
                col_letters(col),
                row,
                style
            )
        }
        Cell::Int(None) => String::new(),
    }
}

fn sheet_xml(rows: &[Vec<Cell>]) -> String {
    let max_col = rows.iter().map(Vec::len).max().unwrap_or(1).max(1);
    let mut body = String::new();
    for (ri, row) in rows.iter().enumerate() {
        let r = ri + 1;
        body.push_str(&format!(r#"<row r="{r}">"#));
        for (ci, cell) in row.iter().enumerate() {
            body.push_str(&cell_xml(r, ci + 1, cell, ri == 0));
        }
        body.push_str("</row>");
    }
    let height = rows.len().max(1);
    let range = format!("A1:{}{height}", col_letters(max_col));
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="{range}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="{max_col}" width="16" customWidth="1"/></cols><sheetData>{body}</sheetData></worksheet>"#
    )
}

const STYLES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>"#;

fn write_xlsx(sheets: &[(&str, Vec<Vec<Cell>>)]) -> Result<Vec<u8>, String> {
    let n = sheets.len();
    let mut types = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>"#,
    );
    let mut workbook = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>"#,
    );
    let mut rels = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">"#,
    );
    for (i, (name, _)) in sheets.iter().enumerate() {
        let id = i + 1;
        types.push_str(&format!(
            r#"<Override PartName="/xl/worksheets/sheet{id}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>"#
        ));
        workbook.push_str(&format!(
            r#"<sheet name="{}" sheetId="{id}" r:id="rId{id}"/>"#,
            esc(name)
        ));
        rels.push_str(&format!(
            r#"<Relationship Id="rId{id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{id}.xml"/>"#
        ));
    }
    types.push_str("</Types>");
    workbook.push_str("</sheets></workbook>");
    rels.push_str(&format!(
        r#"<Relationship Id="rId{}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>"#,
        n + 1
    ));

    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let mut put = |name: &str, data: &[u8]| -> Result<(), String> {
        zip.start_file(name, opts)
            .map_err(|e| format!("写 xlsx 失败（{name}）：{e}"))?;
        zip.write_all(data)
            .map_err(|e| format!("写 xlsx 失败（{name}）：{e}"))
    };
    put("[Content_Types].xml", types.as_bytes())?;
    put(
        "_rels/.rels",
        br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#,
    )?;
    put("xl/workbook.xml", workbook.as_bytes())?;
    put("xl/_rels/workbook.xml.rels", rels.as_bytes())?;
    put("xl/styles.xml", STYLES.as_bytes())?;
    for (i, (_, rows)) in sheets.iter().enumerate() {
        put(
            &format!("xl/worksheets/sheet{}.xml", i + 1),
            sheet_xml(rows).as_bytes(),
        )?;
    }
    let cursor = zip.finish().map_err(|e| format!("打包 xlsx 失败：{e}"))?;
    Ok(cursor.into_inner())
}

// ───────────────────────────── 读取 ─────────────────────────────

#[derive(Debug, Clone)]
pub struct SheetRows {
    pub name: String,
    pub rows: Vec<(u32, Vec<String>)>,
}

fn read_part(zip: &mut ZipArchive<Cursor<&[u8]>>, name: &str) -> Result<Vec<u8>, String> {
    let f = zip
        .by_name(name)
        .map_err(|_| format!("xlsx 里缺少 {name}"))?;
    if f.size() > MAX_PART {
        return Err(format!(
            "{name} 解压后超过 {} MB，拒绝读取",
            MAX_PART / 1024 / 1024
        ));
    }
    // 头里的 size 是压缩包自报的，可以撒谎；真正解压时再按上限截断，避免 32MB
    // 的 zip 声明 1KB、实际解出几个 GB 把内存顶满。
    let mut buf = Vec::new();
    f.take(MAX_PART + 1)
        .read_to_end(&mut buf)
        .map_err(|e| format!("读取 {name} 失败：{e}"))?;
    if buf.len() as u64 > MAX_PART {
        return Err(format!(
            "{name} 解压后超过 {} MB，拒绝读取",
            MAX_PART / 1024 / 1024
        ));
    }
    Ok(buf)
}

fn node_text(n: &XmlNode, bytes: &[u8]) -> String {
    if n.self_closing {
        return String::new();
    }
    let close = n.name.len() + 3;
    let end = n
        .end
        .saturating_sub(close)
        .max(n.start_tag_end)
        .min(bytes.len());
    String::from_utf8_lossy(&bytes[n.start_tag_end.min(bytes.len())..end]).into_owned()
}

fn unescape(s: &str) -> String {
    // Excel / openpyxl 会把中文写成 `&#23454;` 这样的十进制字符引用，不能只处理五个命名实体。
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        let decoded = tail.find(';').filter(|n| *n <= 12).and_then(|semi| {
            let ent = &tail[1..semi];
            let ch = match ent {
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "amp" => Some('&'),
                _ => ent
                    .strip_prefix('#')
                    .and_then(
                        |n| match n.strip_prefix('x').or_else(|| n.strip_prefix('X')) {
                            Some(hex) => u32::from_str_radix(hex, 16).ok(),
                            None => n.parse::<u32>().ok(),
                        },
                    )
                    .and_then(char::from_u32),
            };
            ch.map(|c| (c, semi))
        });
        match decoded {
            Some((ch, semi)) => {
                out.push(ch);
                rest = &tail[semi + 1..];
            }
            None => {
                out.push('&');
                rest = tail.get(1..).unwrap_or("");
            }
        }
    }
    out.push_str(rest);
    out
}

fn collect_texts(node: &XmlNode, bytes: &[u8], out: &mut String) {
    if node.name == "t" {
        out.push_str(&unescape(&node_text(node, bytes)));
        return;
    }
    for c in &node.children {
        collect_texts(c, bytes, out);
    }
}

/// 列字母 → 1 起的列号。`r="ZZZZZZ1"` 这类畸形引用不按真实值分配，
/// 超出 Excel 列上限或算术溢出都返回 `None`。
fn col_index(letters: &str) -> Option<usize> {
    let mut col = 0usize;
    for ch in letters.chars() {
        if !ch.is_ascii_alphabetic() {
            return None;
        }
        let digit = ch.to_ascii_uppercase() as usize - 'A' as usize + 1;
        col = col.checked_mul(26)?.checked_add(digit)?;
        if col > MAX_COLS {
            return None;
        }
    }
    (col > 0).then_some(col)
}

fn cell_col(cell: &XmlNode, fallback: usize) -> Result<(usize, u32), String> {
    let Some(r) = cell.attr("r") else {
        return Ok((fallback, 0));
    };
    let letters: String = r.chars().take_while(|c| c.is_ascii_alphabetic()).collect();
    let digits: String = r.chars().skip_while(|c| c.is_ascii_alphabetic()).collect();
    let row = digits.parse::<u32>().unwrap_or(0);
    if letters.is_empty() {
        return Ok((fallback, row));
    }
    match col_index(&letters) {
        Some(col) => Ok((col, row)),
        None => Err(format!(
            "单元格引用 {r:?} 的列超出 Excel 上限（{MAX_COLS} 列）"
        )),
    }
}

fn cell_value(cell: &XmlNode, bytes: &[u8], shared: &[String]) -> Result<String, String> {
    match cell.attr_or("t", "").as_str() {
        "inlineStr" => {
            let mut s = String::new();
            if let Some(is) = cell.child("is") {
                collect_texts(is, bytes, &mut s);
            }
            Ok(s)
        }
        "s" => {
            let idx = cell
                .child("v")
                .map(|v| node_text(v, bytes).trim().to_string())
                .unwrap_or_default()
                .parse::<usize>()
                .map_err(|_| "共享字符串索引无效".to_string())?;
            shared
                .get(idx)
                .cloned()
                .ok_or_else(|| format!("共享字符串索引越界：{idx}"))
        }
        _ => Ok(cell
            .child("v")
            .map(|v| node_text(v, bytes))
            .unwrap_or_default()),
    }
}

fn parse_shared_strings(bytes: &[u8]) -> Vec<String> {
    let Ok(root) = parse(bytes) else {
        return Vec::new();
    };
    root.children
        .iter()
        .filter(|n| n.name == "si")
        .map(|si| {
            let mut s = String::new();
            collect_texts(si, bytes, &mut s);
            s
        })
        .collect()
}

/// 读取第一张工作表。优先走 `workbook.xml` + rels 解析表名与目标，失败再退回
/// 「按文件名排序的第一个 worksheet」——Excel 另存过的文件两者都可能出现差异。
pub fn read_sheet(bytes: &[u8]) -> Result<SheetRows, String> {
    let mut zip = ZipArchive::new(Cursor::new(bytes))
        .map_err(|e| format!("不是有效的 .xlsx（zip 打不开）：{e}"))?;
    let mut sheet_name = String::new();
    let mut target = String::new();
    if let Ok(wb) = read_part(&mut zip, "xl/workbook.xml") {
        if let Ok(root) = parse(&wb) {
            if let Some(sheet) = root.child("sheets").and_then(|s| s.child("sheet")) {
                sheet_name = unescape(&sheet.attr_or("name", ""));
                let rid = sheet.attr_or("r:id", "");
                if let Ok(rels) = read_part(&mut zip, "xl/_rels/workbook.xml.rels") {
                    if let Ok(rroot) = parse(&rels) {
                        if let Some(rel) = rroot
                            .children
                            .iter()
                            .find(|r| r.name == "Relationship" && r.attr_or("Id", "") == rid)
                        {
                            target = rel.attr_or("Target", "");
                        }
                    }
                }
            }
        }
    }
    let part = if target.is_empty() {
        zip.file_names()
            .filter(|n| n.starts_with("xl/worksheets/") && n.ends_with(".xml"))
            .min()
            .map(str::to_string)
            .ok_or("xlsx 里没有工作表")?
    } else if target.starts_with('/') {
        target.trim_start_matches('/').to_string()
    } else {
        format!("xl/{target}")
    };
    let xml = read_part(&mut zip, &part)?;
    let shared = read_part(&mut zip, "xl/sharedStrings.xml")
        .ok()
        .map(|b| parse_shared_strings(&b))
        .unwrap_or_default();
    let root = parse(&xml)?;
    let data = root.child("sheetData").ok_or("工作表里没有 sheetData")?;
    let mut rows = Vec::new();
    let mut next_row = 1u32;
    for row in &data.children {
        if row.name != "row" {
            continue;
        }
        let row_no = row
            .attr("r")
            .and_then(|s| s.parse::<u32>().ok())
            .unwrap_or(next_row);
        next_row = row_no + 1;
        let mut cells: Vec<(usize, String)> = Vec::new();
        let mut next_col = 1usize;
        for c in &row.children {
            if c.name != "c" {
                continue;
            }
            let (col, _) = cell_col(c, next_col)?;
            next_col = col + 1;
            cells.push((col, cell_value(c, &xml, &shared)?));
        }
        let width = cells.iter().map(|(c, _)| *c).max().unwrap_or(0);
        let mut values = vec![String::new(); width];
        for (col, v) in cells {
            if col > 0 && col <= width {
                values[col - 1] = v;
            }
        }
        rows.push((row_no, values));
    }
    Ok(SheetRows {
        name: sheet_name,
        rows,
    })
}

// ───────────────────────────── 导入规划 ─────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportChange {
    pub field: String,
    pub before: String,
    pub after: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRow {
    pub row: u32,
    pub entity: String,
    pub attr_name: String,
    pub status: String,
    pub changes: Vec<ImportChange>,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub file: String,
    pub sheet: String,
    pub sha256: String,
    pub rows: Vec<ImportRow>,
    pub ops: Vec<EditOp>,
    pub add: u32,
    pub update: u32,
    pub same: u32,
    pub errors: u32,
}

#[derive(Default)]
struct Desired {
    name: Option<String>,
    field: Option<String>,
    display_name: Option<String>,
    type_name: Option<String>,
    data_type: Option<String>,
    db_type: Option<String>,
    length: Option<u32>,
    precision: Option<u32>,
    nullable: Option<bool>,
    default_value: Option<String>,
    is_key: Option<bool>,
}

fn parse_u32(label: &str, raw: &str) -> Result<Option<u32>, String> {
    let v = raw.trim();
    if v.is_empty() {
        return Ok(None);
    }
    v.parse::<u32>()
        .map(Some)
        .map_err(|_| format!("{label} 必须是整数：{raw}"))
}

fn parse_flag(label: &str, raw: &str) -> Result<Option<bool>, String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "" => Ok(None),
        "是" | "y" | "yes" | "true" | "1" => Ok(Some(true)),
        "否" | "n" | "no" | "false" | "0" => Ok(Some(false)),
        v => Err(format!("{label} 只能填 是/否：{v}")),
    }
}

fn opt(raw: &str) -> Option<String> {
    let v = raw.trim();
    (!v.is_empty()).then(|| v.to_string())
}

fn change(field: &str, before: String, after: String) -> ImportChange {
    ImportChange {
        field: field.to_string(),
        before,
        after,
    }
}

fn plan_row(
    doc: &BmfDoc,
    get: &dyn Fn(&str) -> String,
) -> Result<(String, Vec<ImportChange>, Vec<EditOp>), String> {
    let entity_name = get("实体");
    let name = get("字段名");
    if entity_name.is_empty() {
        return Err("「实体」不能为空".to_string());
    }
    if name.is_empty() {
        return Err("「字段名」不能为空".to_string());
    }
    let ent = doc
        .entities
        .iter()
        .find(|e| e.name == entity_name || e.id == entity_name)
        .ok_or_else(|| format!("实体 {entity_name} 不在这个组件里"))?;
    let desired = Desired {
        name: opt(&name),
        field: opt(&get("列名")),
        display_name: opt(&get("显示名")),
        type_name: opt(&get("类型")),
        data_type: opt(&get("数据类型")),
        db_type: opt(&get("数据库类型")),
        length: parse_u32("长度", &get("长度"))?,
        precision: parse_u32("精度", &get("精度"))?,
        nullable: parse_flag("可空", &get("可空"))?,
        default_value: opt(&get("默认值")),
        is_key: parse_flag("主键", &get("主键"))?,
    };

    let Some(attr) = ent.attrs.iter().find(|a| a.name == name) else {
        if !is_field_ident(&name) {
            return Err(format!(
                "字段名只能以小写字母开头，且只含小写字母、数字、下划线：{name}"
            ));
        }
        if desired.is_key == Some(true) {
            return Err("新增字段不能直接设主键；先新增，再到结构页改主键".to_string());
        }
        let mut changes = vec![change("字段名", String::new(), name.clone())];
        if let Some(v) = &desired.field {
            changes.push(change("列名", String::new(), v.clone()));
        }
        if let Some(v) = &desired.display_name {
            changes.push(change("显示名", String::new(), v.clone()));
        }
        if let Some(v) = &desired.type_name {
            changes.push(change("类型", String::new(), v.clone()));
        }
        if let Some(v) = &desired.data_type {
            changes.push(change("数据类型", String::new(), v.clone()));
        }
        if let Some(v) = &desired.db_type {
            changes.push(change("数据库类型", String::new(), v.clone()));
        }
        if desired.length.is_some() {
            changes.push(change(
                "长度",
                String::new(),
                desired.length.unwrap_or_default().to_string(),
            ));
        }
        if desired.nullable == Some(false) {
            changes.push(change("可空", "是".to_string(), "否".to_string()));
        }
        if let Some(v) = &desired.default_value {
            changes.push(change("默认值", String::new(), v.clone()));
        }
        let op = EditOp::AddAttribute {
            entity: ent.id.clone(),
            name: name.clone(),
            display_name: desired.display_name.clone().unwrap_or_else(|| name.clone()),
            style: "SINGLE".to_string(),
            type_name: desired
                .type_name
                .clone()
                .unwrap_or_else(|| "String".to_string()),
            data_type: desired.data_type.clone().unwrap_or_default(),
            db_type: desired.db_type.clone().unwrap_or_default(),
            length: desired.length,
            nullable: desired.nullable.unwrap_or(true),
            default_value: desired.default_value.clone().unwrap_or_default(),
            is_key: false,
            id: String::new(),
        };
        return Ok(("add".to_string(), changes, vec![op]));
    };

    let mut changes = Vec::new();
    let mut ops = Vec::new();
    let mut set = |label: &str, before: String, after: String, xml_name: &str| {
        if before != after {
            changes.push(change(label, before, after.clone()));
            ops.push(EditOp::SetAttr {
                id: attr.id.clone(),
                name: xml_name.to_string(),
                value: after,
            });
        }
    };
    if let Some(v) = &desired.name {
        if !is_field_ident(v) {
            return Err(format!(
                "字段名只能以小写字母开头，且只含小写字母、数字、下划线：{v}"
            ));
        }
        set("字段名", attr.name.clone(), v.clone(), "name");
    }
    if let Some(v) = &desired.field {
        set("列名", attr.field.clone(), v.clone(), "fieldName");
    }
    if let Some(v) = &desired.display_name {
        set(
            "显示名",
            attr.display_name.clone(),
            v.clone(),
            "displayName",
        );
    }
    if let Some(v) = &desired.type_name {
        set("类型", attr.type_name.clone(), v.clone(), "typeName");
    }
    if let Some(v) = &desired.data_type {
        set("数据类型", attr.data_type.clone(), v.clone(), "dataType");
    }
    if let Some(v) = &desired.db_type {
        set("数据库类型", attr.db_type.clone(), v.clone(), "dbtype");
    }
    if let Some(v) = desired.length {
        set(
            "长度",
            attr.length.map(|n| n.to_string()).unwrap_or_default(),
            v.to_string(),
            "length",
        );
    }
    if let Some(v) = desired.precision {
        set(
            "精度",
            attr.precision.map(|n| n.to_string()).unwrap_or_default(),
            v.to_string(),
            "precise",
        );
    }
    if let Some(v) = desired.nullable {
        set(
            "可空",
            if attr.nullable { "是" } else { "否" }.to_string(),
            if v { "是" } else { "否" }.to_string(),
            "isNullable",
        );
    }
    if let Some(v) = &desired.default_value {
        set(
            "默认值",
            attr.default_value.clone(),
            v.clone(),
            "defaultValue",
        );
    }
    if let Some(v) = desired.is_key {
        if v && !attr.is_key {
            changes.push(change("主键", "否".to_string(), "是".to_string()));
            ops.push(EditOp::SetEntityKey {
                entity: ent.id.clone(),
                attr_id: attr.id.clone(),
            });
            ops.push(EditOp::SetAttr {
                id: attr.id.clone(),
                name: "isKey".to_string(),
                value: "true".to_string(),
            });
        } else if !v && attr.is_key {
            if ent.key_attr_id == attr.id {
                return Err("不能通过模板取消实体主键；请在结构页显式改主键".to_string());
            }
            set("主键", "是".to_string(), "否".to_string(), "isKey");
        }
    }
    let status = if ops.is_empty() { "same" } else { "update" };
    Ok((status.to_string(), changes, ops))
}

fn cell_at(cells: &[String], idx: Option<&usize>) -> String {
    idx.and_then(|i| cells.get(*i)).cloned().unwrap_or_default()
}

/// 解析工作簿并对照当前文档规划 import。只读：返回逐行状态与待写 `EditOp`。
pub fn plan_import(doc: &BmfDoc, file: &str, bytes: &[u8]) -> Result<ImportPreview, String> {
    let sheet = read_sheet(bytes)?;
    let header_at = sheet
        .rows
        .iter()
        .position(|(_, cells)| cells.iter().any(|c| !c.trim().is_empty()))
        .ok_or("工作表是空的")?;
    let (_, header) = &sheet.rows[header_at];
    let mut cols: HashMap<String, usize> = HashMap::new();
    for (i, h) in header.iter().enumerate() {
        let key = h.trim();
        if key.is_empty() {
            continue;
        }
        if cols.insert(key.to_string(), i).is_some() {
            return Err(format!("表头「{key}」重复"));
        }
    }
    for req in ["实体", "字段名"] {
        if !cols.contains_key(req) {
            return Err(format!("缺少必需列「{req}」；请用 NCForge 导出的模板填写"));
        }
    }
    let mut rows = Vec::new();
    let mut ops = Vec::new();
    let mut seen: HashSet<(String, String)> = HashSet::new();
    let (mut add, mut update, mut same, mut errors) = (0u32, 0u32, 0u32, 0u32);
    for (row_no, cells) in sheet.rows.iter().skip(header_at + 1) {
        if cells.iter().all(|c| c.trim().is_empty()) {
            continue;
        }
        let get = |name: &str| cell_at(cells, cols.get(name));
        let entity = get("实体").trim().to_string();
        let attr_name = get("字段名").trim().to_string();
        let key = (entity.to_lowercase(), attr_name.clone());
        let (status, changes, message, row_ops) = match plan_row(doc, &get) {
            Ok((status, changes, row_ops)) => {
                if status != "same" && !seen.insert(key) {
                    (
                        "error".to_string(),
                        Vec::new(),
                        "模板里同一实体的同一字段出现了多次".to_string(),
                        Vec::new(),
                    )
                } else {
                    (status, changes, String::new(), row_ops)
                }
            }
            Err(e) => ("error".to_string(), Vec::new(), e, Vec::new()),
        };
        match status.as_str() {
            "add" => add += 1,
            "update" => update += 1,
            "same" => same += 1,
            _ => errors += 1,
        }
        ops.extend(row_ops);
        rows.push(ImportRow {
            row: *row_no,
            entity,
            attr_name,
            status,
            changes,
            message,
        });
    }
    Ok(ImportPreview {
        file: file.to_string(),
        sheet: sheet.name,
        sha256: sha256(&doc.bytes),
        rows,
        ops,
        add,
        update,
        same,
        errors,
    })
}

/// 组件名来自可编辑 XML，直接拼进文件名会让 `..\..\x` 逃出用户选的目录。
fn safe_file_stem(name: &str) -> String {
    let kept: String = name
        .trim()
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-')
        .take(60)
        .collect();
    let stem = kept.trim_matches(|c: char| c == '_' || c == '-');
    if stem.is_empty() {
        "component".to_string()
    } else {
        stem.to_string()
    }
}

/// 导出模板到 `dir/<组件名>-字段模板.xlsx`；已存在则拒绝（不做静默覆盖）。
pub fn write_template(doc: &BmfDoc, dir: &Path) -> Result<std::path::PathBuf, String> {
    let name = safe_file_stem(&doc.component.name);
    let target = dir.join(format!("{name}-字段模板.xlsx"));
    if target.exists() {
        return Err(format!(
            "目标已存在：{}；换个目录或先删掉旧文件",
            target.display()
        ));
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("创建目录失败：{e}"))?;
    let bytes = template_bytes(doc)?;
    std::fs::write(&target, bytes).map_err(|e| format!("写模板失败：{e}"))?;
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const SAMPLE: &str = r#"<component id="c1" name="demo" displayName="演示" namespace="uapbd" ownModule="uapbd" version="3" mainEntity="e1"><celllist><entity id="e1" name="H" displayName="表头" tableName="t_h" fullClassName="nc.vo.uapbd.demo.H" keyAttributeId="a1"><attributelist><attribute id="a1" name="pk" fieldName="pk" displayName="主键" typeName="String" dataType="char" dbtype="char" dataTypeStyle="SINGLE" isKey="true" isNullable="false" sequence="0"/><attribute id="a2" name="memo" fieldName="memo" displayName="备注" typeName="String" dataTypeStyle="SINGLE" isKey="false" isNullable="true" sequence="1"/></attributelist></entity></celllist></component>"#;

    fn sample_doc() -> BmfDoc {
        BmfDoc::from_bytes(PathBuf::from("demo.bmf"), SAMPLE.as_bytes().to_vec()).unwrap()
    }

    #[test]
    fn template_round_trips_through_the_reader() {
        let doc = sample_doc();
        let bytes = template_bytes(&doc).unwrap();
        let sheet = read_sheet(&bytes).unwrap();
        assert_eq!(sheet.name, SHEET);
        assert_eq!(sheet.rows[0].1, HEADERS);
        assert_eq!(sheet.rows.len(), 3, "表头 + 两个字段");
        let row = &sheet.rows[1].1;
        assert_eq!(row[0], "H");
        assert_eq!(row[1], "pk");
        assert_eq!(row[2], "pk");
        assert_eq!(row[9], "否", "pk 不可空");
        assert_eq!(row[10], "");
        assert_eq!(row[11], "是");
        assert_eq!(sheet.rows[2].1[9], "是");
    }

    #[test]
    fn empty_values_are_omitted_cells_and_read_back_empty() {
        let doc = sample_doc();
        let sheet = read_sheet(&template_bytes(&doc).unwrap()).unwrap();
        let row = &sheet.rows[2].1;
        assert_eq!(row[7], "", "memo 没有 length");
        assert_eq!(row[9], "是");
    }

    #[test]
    fn plan_marks_added_updated_duplicated_and_bad_rows() {
        let doc = sample_doc();
        let rows: Vec<Vec<Cell>> = vec![
            HEADERS.iter().map(|h| text(h)).collect(),
            vec![
                text("H"),
                text("pk"),
                text("pk"),
                text("主键"),
                text("String"),
                text("char"),
                text("char"),
                Cell::Int(Some(32)),
                Cell::Int(None),
                text("否"),
                text(""),
                text("是"),
            ],
            vec![
                text("H"),
                text("new_field"),
                text("new_field"),
                text("新字段"),
                text("Integer"),
                Cell::Int(None),
                Cell::Int(None),
                Cell::Int(Some(8)),
                Cell::Int(None),
                text("否"),
                text("0"),
                text("否"),
            ],
            vec![
                text("H"),
                text("new_field"),
                text("new_field"),
                text("重复"),
                text("Integer"),
                Cell::Int(None),
                Cell::Int(None),
                Cell::Int(Some(8)),
                Cell::Int(None),
                text("否"),
                text("0"),
                text("否"),
            ],
            vec![text("Missing"), text("x")],
        ];
        let bytes = write_xlsx(&[(SHEET, rows)]).unwrap();
        let preview = plan_import(&doc, "t.xlsx", &bytes).unwrap();
        assert_eq!(preview.update, 1, "pk 的 length → 32");
        assert_eq!(preview.add, 1);
        assert_eq!(preview.errors, 2);
        assert_eq!(preview.rows[0].status, "update");
        assert!(preview.rows[0].changes.iter().any(|c| c.field == "长度"));
        assert_eq!(preview.rows[1].status, "add");
        assert!(preview.rows[2].message.contains("出现了多次"));
        assert!(preview.rows[3].message.contains("实体 Missing"));
        assert_eq!(preview.ops.len(), 2, "一条 SetAttr + 一条 AddAttribute");
    }

    #[test]
    fn unchanged_rows_produce_no_ops() {
        let doc = sample_doc();
        let sheet = read_sheet(&template_bytes(&doc).unwrap()).unwrap();
        let bytes = template_bytes(&doc).unwrap();
        let preview = plan_import(&doc, "t.xlsx", &bytes).unwrap();
        assert_eq!(preview.ops.len(), 0);
        assert_eq!(preview.same, sheet.rows.len() as u32 - 1);
        assert_eq!(preview.errors, 0);
    }

    #[test]
    fn unescape_decodes_named_and_numeric_references() {
        assert_eq!(
            unescape("&#23454;&#20307; &amp; &lt;x&gt; &#x4F60; &apos;q&apos;"),
            "实体 & <x> 你 'q'"
        );
        assert_eq!(unescape("a & b"), "a & b");
    }

    #[test]
    fn shared_strings_workbook_is_read() {
        let parts: [(&str, &str); 5] = [
            (
                "[Content_Types].xml",
                r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>"#,
            ),
            (
                "xl/workbook.xml",
                r#"<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="字段" sheetId="1" r:id="rId1"/></sheets></workbook>"#,
            ),
            (
                "xl/_rels/workbook.xml.rels",
                r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="worksheet" Target="/xl/worksheets/sheet1.xml"/></Relationships>"#,
            ),
            (
                "xl/sharedStrings.xml",
                r#"<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>&#23454;&#20307;</t></si><si><r><t>字</t></r><r><t>段名</t></r></si></sst>"#,
            ),
            (
                "xl/worksheets/sheet1.xml",
                r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row></sheetData></worksheet>"#,
            ),
        ];
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        let opts = SimpleFileOptions::default();
        for (name, data) in parts {
            zip.start_file(name, opts).unwrap();
            zip.write_all(data.as_bytes()).unwrap();
        }
        let bytes = zip.finish().unwrap().into_inner();
        let sheet = read_sheet(&bytes).unwrap();
        assert_eq!(sheet.name, "字段");
        assert_eq!(
            sheet.rows[0].1,
            vec!["实体".to_string(), "字段名".to_string()]
        );
    }

    #[test]
    fn missing_required_header_is_rejected() {
        let doc = sample_doc();
        let bytes = write_xlsx(&[(SHEET, vec![vec![text("实体"), text("显示名")]])]).unwrap();
        let err = plan_import(&doc, "t.xlsx", &bytes).unwrap_err();
        assert!(err.contains("字段名"), "{err}");
    }

    #[test]
    fn column_index_stops_at_excel_limit() {
        assert_eq!(col_index("A"), Some(1));
        assert_eq!(col_index("XFD"), Some(MAX_COLS), "XFD 是 Excel 的最后一列");
        assert_eq!(col_index("xfd"), Some(MAX_COLS), "小写也认");
        assert_eq!(col_index("XFE"), None, "超出上限一列就拒绝");
        assert_eq!(col_index("ZZZZZZ"), None, "畸形引用不能算出真实列号");
        assert_eq!(col_index(""), None);
    }

    #[test]
    fn absurd_cell_reference_is_an_error_not_a_huge_allocation() {
        let ok = parse(br#"<c r="B2"><v>1</v></c>"#).unwrap();
        assert_eq!(cell_col(&ok, 1).unwrap(), (2, 2));
        let absurd = parse(br#"<c r="ZZZZZZ1"><v>1</v></c>"#).unwrap();
        let err = cell_col(&absurd, 1).unwrap_err();
        assert!(err.contains("上限"), "{err}");
    }

    #[test]
    fn template_file_name_cannot_escape_the_chosen_dir() {
        let evil = SAMPLE.replace("name=\"demo\"", "name=\"..\\..\\evil\"");
        let doc = BmfDoc::from_bytes(PathBuf::from("evil.bmf"), evil.into_bytes()).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("out");
        let written = write_template(&doc, &out).unwrap();
        assert_eq!(written.parent().unwrap(), out.as_path());
        assert_eq!(
            written.file_name().unwrap().to_str(),
            Some("evil-字段模板.xlsx")
        );
        assert_eq!(safe_file_stem("..."), "component");
        assert_eq!(safe_file_stem("  "), "component");
    }
}
