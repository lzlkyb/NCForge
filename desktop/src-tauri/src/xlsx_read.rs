//! 只读最小 XLSX：把第一张工作表读成二维文本，给「从 Excel 导入」用。
//!
//! 不引第三方表格库：我们只要 xlsx（OOXML zip）里三个文件——sharedStrings、workbook、
//! 第一张 sheet 的 XML。写一个几十行的扫描器比拖进一个几 MB 的解析库划算，也避免
//! 「库把日期转成 1900 序列号 / 把 18 位单据号转成 f64」这类静默失真：这里一律给文本。
//!
//! 明确不支持：合并单元格（值只取左上角存的那一格）、公式重算（只读缓存值）、
//! 日期格式（Excel 里是数字 + 样式，这里按数字原样给出）、多工作表（只读第一张）。

use std::io::{Read, Seek};
use std::path::Path;

/// 一次最多读多少行：给前端一个明确上限，避免用户把 100 万行的表拖进导入窗口。
pub const MAX_ROWS: usize = 200_000;
/// 单个 XML 解压后最多读多少字节。zip 头可以谎报体积，光看 `entry.size()` 挡不住
/// 「1KB 的压缩包解开是 1GB」；这里按字节读并硬性截断，避免一次导入吃光内存。
const MAX_XML_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug)]
pub struct SheetData {
    pub sheet: String,
    pub rows: Vec<Vec<String>>,
}

pub fn read_xlsx(path: &Path, max_rows: usize) -> Result<SheetData, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("打不开文件：{e}"))?;
    read_xlsx_from(file, max_rows)
}

/// 从内存字节读（前端用 `<input type=file>` 选的文件走这条，避免为一次导入开放任意路径读取）。
pub fn read_xlsx_from<R: Read + Seek>(reader: R, max_rows: usize) -> Result<SheetData, String> {
    let mut zip = zip::ZipArchive::new(reader)
        .map_err(|e| format!("不是有效的 XLSX（zip 读取失败）：{e}"))?;
    let shared = match read_entry(&mut zip, "xl/sharedStrings.xml") {
        Ok(xml) => parse_shared(&xml),
        // 没有共享字符串表是合法的（全部用 inlineStr 的导出工具就这样）。
        Err(_) => Vec::new(),
    };
    let (sheet, sheet_path) = first_sheet(&mut zip)?;
    let xml =
        read_entry(&mut zip, &sheet_path).map_err(|e| format!("读不到工作表 {sheet}：{e}"))?;
    let rows = parse_sheet(&xml, &shared, max_rows)?;
    Ok(SheetData { sheet, rows })
}

fn read_entry<R: Read + Seek>(zip: &mut zip::ZipArchive<R>, name: &str) -> Result<String, String> {
    read_entry_limited(zip, name, MAX_XML_BYTES)
}

/// `limit` 可传小值给单测，不必真的造一个 64MB 的样本。
fn read_entry_limited<R: Read + Seek>(
    zip: &mut zip::ZipArchive<R>,
    name: &str,
    limit: u64,
) -> Result<String, String> {
    let entry = zip.by_name(name).map_err(|e| format!("{name}：{e}"))?;
    let too_big = || format!("{name} 解压后超过 {limit} 字节，文件太大或不是有效的 XLSX");
    if entry.size() > limit {
        return Err(too_big());
    }
    let mut bytes = Vec::new();
    entry
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("读 {name} 失败：{e}"))?;
    if bytes.len() as u64 > limit {
        return Err(too_big());
    }
    String::from_utf8(bytes).map_err(|e| format!("{name} 不是 UTF-8 文本：{e}"))
}

/// 第一张工作表的显示名 + zip 内路径。
///
/// 路径必须从 `workbook.xml.rels` 里查：真实文件的 sheet 文件名可能是 `sheet2.xml`
/// （删过表之后 Excel 不重排），写死 `sheet1.xml` 会读错表。
fn first_sheet<R: Read + Seek>(zip: &mut zip::ZipArchive<R>) -> Result<(String, String), String> {
    let book = read_entry(zip, "xl/workbook.xml").unwrap_or_default();
    let name = attr_from(&book, "<sheet", "name").unwrap_or_else(|| "Sheet1".into());
    let rid = attr_from(&book, "<sheet", "r:id").or_else(|| attr_from(&book, "<sheet", "id"));
    let rels = read_entry(zip, "xl/_rels/workbook.xml.rels").unwrap_or_default();
    let target = rid
        .and_then(|rid| rel_target(&rels, &rid))
        .unwrap_or_else(|| "worksheets/sheet1.xml".into());
    let path = if target.starts_with('/') {
        target.trim_start_matches('/').to_string()
    } else {
        format!("xl/{}", target.trim_start_matches("xl/"))
    };
    Ok((name, path))
}

fn rel_target(rels: &str, rid: &str) -> Option<String> {
    for chunk in rels.split("<Relationship").skip(1) {
        if attr_of(chunk, "Id").as_deref() != Some(rid) {
            continue;
        }
        return attr_of(chunk, "Target");
    }
    None
}

fn parse_shared(xml: &str) -> Vec<String> {
    let mut out = Vec::new();
    for chunk in xml.split("<si").skip(1) {
        // `<si/>` 是空字符串项，没有 `</si>`；按开头是否自闭合区分。
        if chunk.trim_start().starts_with("/>") {
            out.push(String::new());
            continue;
        }
        out.push(all_texts(chunk));
    }
    out
}

fn parse_sheet(xml: &str, shared: &[String], max_rows: usize) -> Result<Vec<Vec<String>>, String> {
    let mut rows: Vec<Vec<String>> = Vec::new();
    for chunk in xml.split("<row").skip(1) {
        let cells: Vec<&str> = chunk.split("<c").skip(1).collect();
        if cells.is_empty() {
            rows.push(Vec::new());
            continue;
        }
        let mut line: Vec<String> = Vec::new();
        for cell in cells {
            let reference = attr_of(cell, "r").unwrap_or_default();
            let column = column_index(&reference).unwrap_or(line.len());
            let kind = attr_of(cell, "t").unwrap_or_default();
            let text = if kind == "inlineStr" {
                all_texts(cell)
            } else {
                let raw = between(cell, "<v>", "</v>").unwrap_or_default();
                if kind == "s" {
                    raw.trim()
                        .parse::<usize>()
                        .ok()
                        .and_then(|i| shared.get(i).cloned())
                        .unwrap_or_default()
                } else {
                    unescape(raw)
                }
            };
            if column >= 16_384 {
                return Err(format!("单元格 {reference} 超出 XLSX 列上限"));
            }
            if line.len() <= column {
                line.resize(column + 1, String::new());
            }
            line[column] = text;
        }
        rows.push(line);
        if rows.len() > max_rows {
            return Err(format!(
                "工作表超过 {max_rows} 行，超过导入上限；请先在 Excel 里拆分，或另存为 CSV 分段导入"
            ));
        }
    }
    Ok(rows)
}

/// 取一段 XML 里第一个指定标签的某个属性值。
///
/// 标签名必须**整词命中**：`workbook.xml` 里是 `<sheets><sheet …>`，只找 `"<sheet"`
/// 会先撞上 `<sheets>`，`name` 永远返回 None，表名就悄悄退回 "Sheet1"。
fn attr_from(xml: &str, tag: &str, key: &str) -> Option<String> {
    let mut from = 0;
    while let Some(at) = xml[from..].find(tag) {
        let start = from + at;
        let rest = &xml[start..];
        let after = rest[tag.len()..].chars().next();
        let whole = matches!(after, Some(c) if c == '>' || c == '/' || c.is_whitespace());
        if whole {
            return attr_of(rest, key);
        }
        from = start + tag.len();
    }
    None
}

fn attr_of(chunk: &str, key: &str) -> Option<String> {
    let tag_end = chunk.find('>')?;
    let head = &chunk[..tag_end];
    let mut needle = String::with_capacity(key.len() + 2);
    needle.push_str(key);
    needle.push('=');
    let at = head.find(&needle)?;
    // 必须整词匹配，否则 `r` 会命中 `spans` 之类的属性名尾部。
    if at > 0 {
        let before = head.as_bytes()[at - 1];
        if !(before == b' ' || before == b'\t' || before == b'\n' || before == b'\r') {
            return None;
        }
    }
    let value = head[at + needle.len()..].trim_start();
    let quote = value.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let body = &value[1..];
    let end = body.find(quote)?;
    Some(unescape(&body[..end]))
}

fn between<'a>(text: &'a str, open: &str, close: &str) -> Option<&'a str> {
    let start = text.find(open)? + open.len();
    let rest = &text[start..];
    let end = rest.find(close)?;
    Some(&rest[..end])
}

/// 一个片段里所有 `<t>` 的内容拼起来（富文本 `<r><t>` 会分成多段）。
fn all_texts(chunk: &str) -> String {
    let mut out = String::new();
    let mut rest = chunk;
    while let Some(start) = rest.find("<t") {
        let after = &rest[start..];
        // `<t/>` 空文本，或 `<t xml:space="preserve">`。
        let Some(gt) = after.find('>') else { break };
        if after[..gt].ends_with('/') {
            rest = &after[gt..];
            continue;
        }
        let body = &after[gt + 1..];
        let Some(end) = body.find("</t>") else { break };
        out.push_str(&unescape(&body[..end]));
        rest = &body[end..];
    }
    out
}

/// `A1` / `AB12` → 0 基列号。
fn column_index(reference: &str) -> Option<usize> {
    let mut value = 0usize;
    let mut seen = false;
    for ch in reference.chars() {
        if !ch.is_ascii_alphabetic() {
            break;
        }
        let digit = (ch.to_ascii_uppercase() as usize).checked_sub('A' as usize)? + 1;
        value = value.checked_mul(26)? + digit;
        seen = true;
    }
    if seen {
        Some(value - 1)
    } else {
        None
    }
}

fn unescape(text: &str) -> String {
    if !text.contains('&') {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        let tail = &rest[at..];
        let Some(semi) = tail.find(';') else {
            out.push_str(tail);
            return out;
        };
        let entity = &tail[1..semi];
        let replaced = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => entity.strip_prefix('#').and_then(|n| {
                if let Some(hex) = n.strip_prefix('x').or_else(|| n.strip_prefix('X')) {
                    u32::from_str_radix(hex, 16).ok().and_then(char::from_u32)
                } else {
                    n.parse::<u32>().ok().and_then(char::from_u32)
                }
            }),
        };
        match replaced {
            Some(ch) => out.push(ch),
            None => out.push_str(&tail[..=semi]),
        }
        rest = &tail[semi + 1..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    /// 造一个最小 xlsx。测试不依赖外部样本文件，也顺带钉住 zip 布局。
    fn sample(shared: &[&str], sheet_xml: &str) -> tempfile::NamedTempFile {
        let file = tempfile::Builder::new().suffix(".xlsx").tempfile().unwrap();
        let mut zip = zip::ZipWriter::new(file.reopen().unwrap());
        let opt = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("xl/workbook.xml", opt).unwrap();
        // 工作表名带中文：这里必须是普通 raw string（`br#""#` 只收 ASCII）
        zip.write_all(r#"<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="数据" sheetId="1" r:id="rId1"/></sheets></workbook>"#.as_bytes()).unwrap();
        zip.start_file("xl/_rels/workbook.xml.rels", opt).unwrap();
        zip.write_all(br#"<?xml version="1.0"?><Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#).unwrap();
        zip.start_file("xl/sharedStrings.xml", opt).unwrap();
        let mut xml = String::from(r#"<?xml version="1.0"?><sst>"#);
        for s in shared {
            xml.push_str("<si><t>");
            xml.push_str(s);
            xml.push_str("</t></si>");
        }
        xml.push_str("</sst>");
        zip.write_all(xml.as_bytes()).unwrap();
        zip.start_file("xl/worksheets/sheet1.xml", opt).unwrap();
        zip.write_all(sheet_xml.as_bytes()).unwrap();
        zip.finish().unwrap();
        file
    }

    #[test]
    fn 共享字符串与稀疏列按位置还原() {
        let path = sample(
            &["编码", "名称", "A001"],
            r#"<?xml version="1.0"?><worksheet><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
<row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>12.5</v></c></row>
</sheetData></worksheet>"#,
        );
        let out = read_xlsx(path.path(), MAX_ROWS).unwrap();
        assert_eq!(out.sheet, "数据");
        assert_eq!(out.rows[0], vec!["编码", "名称"]);
        // 中间空着的 B 列补空，值落在 C 列
        assert_eq!(out.rows[1], vec!["A001", "", "12.5"]);
    }

    #[test]
    fn 内联字符串与实体转义() {
        let path = sample(
            &[],
            r#"<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>a&amp;b &lt;x&gt;</t></is></c><c r="B1" t="inlineStr"><is><t>&#65;</t></is></c></row></sheetData></worksheet>"#,
        );
        let out = read_xlsx(path.path(), MAX_ROWS).unwrap();
        assert_eq!(out.rows[0], vec!["a&b <x>", "A"]);
    }

    #[test]
    fn 超过行上限直接报错而不是静默截断() {
        let path = sample(
            &[],
            r#"<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="2"><c r="A2"><v>2</v></c></row></sheetData></worksheet>"#,
        );
        let err = read_xlsx(path.path(), 1).unwrap_err();
        assert!(err.contains("超过导入上限"), "{err}");
    }

    #[test]
    fn 刚好到行数上限不误拒() {
        let path = sample(
            &[],
            r#"<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="2"><c r="A2"><v>2</v></c></row></sheetData></worksheet>"#,
        );
        let out = read_xlsx(path.path(), 2).unwrap();
        assert_eq!(out.rows.len(), 2);
    }

    #[test]
    fn 解压体积超上限时报错而不是全量读进内存() {
        let path = sample(&[], r#"<worksheet><sheetData/></worksheet>"#);
        let mut zip = zip::ZipArchive::new(std::fs::File::open(path.path()).unwrap()).unwrap();
        // sheet 的 XML 显然超过 8 字节；zip 头 size 与实际读取两条路都要能挡住
        let err = read_entry_limited(&mut zip, "xl/worksheets/sheet1.xml", 8).unwrap_err();
        assert!(err.contains("超过 8 字节"), "{err}");
    }

    #[test]
    fn 列字母换算() {
        assert_eq!(column_index("A1"), Some(0));
        assert_eq!(column_index("Z9"), Some(25));
        assert_eq!(column_index("AA1"), Some(26));
        assert_eq!(column_index("AB1"), Some(27));
        assert_eq!(column_index("1"), None);
    }

    #[test]
    fn 不是xlsx时给出可读错误() {
        let file = tempfile::Builder::new().suffix(".xlsx").tempfile().unwrap();
        std::fs::write(file.path(), b"not a zip").unwrap();
        let err = read_xlsx(file.path(), MAX_ROWS).unwrap_err();
        assert!(err.contains("不是有效的 XLSX"), "{err}");
    }
}
