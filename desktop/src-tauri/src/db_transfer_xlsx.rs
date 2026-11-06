//! Minimal streaming OOXML. Sheet XML is spooled on disk; no shared-string table or all-row buffer.
use crate::db_transfer::{cell_text, xml_text, TransferColumn};
use serde_json::Value;
use std::collections::HashSet;
use std::fs::File;
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::path::Path;
use tempfile::{NamedTempFile, TempDir};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

const DATA_ROWS_PER_SHEET: usize = 1_048_575;
const MAX_COLUMNS: usize = 16_384;
const MAX_CELL_UNITS: usize = 32_767;

struct Sheet {
    name: String,
    file: NamedTempFile,
}
struct ActiveSheet {
    name: String,
    out: BufWriter<NamedTempFile>,
    data_rows: usize,
    row_number: usize,
}
pub struct XlsxWriter {
    dir: TempDir,
    sheets: Vec<Sheet>,
    active: Option<ActiveSheet>,
    used_names: HashSet<String>,
    columns: Vec<TransferColumn>,
    headers: Vec<Vec<String>>,
    base_name: String,
    limit: usize,
    bytes: u64,
    text_numbers: usize,
    notes: Vec<String>,
    null_text: String,
}
impl XlsxWriter {
    pub fn new(parent: &Path) -> Result<Self, String> {
        Self::with_limit(parent, DATA_ROWS_PER_SHEET)
    }
    fn with_limit(parent: &Path, limit: usize) -> Result<Self, String> {
        let dir = tempfile::Builder::new()
            .prefix(".ncforge-xlsx-")
            .tempdir_in(parent)
            .map_err(|e| format!("建 XLSX 工作目录失败：{e}"))?;
        Ok(Self {
            dir,
            sheets: vec![],
            active: None,
            used_names: HashSet::new(),
            columns: vec![],
            headers: vec![],
            base_name: String::new(),
            limit: limit.max(1),
            bytes: 0,
            text_numbers: 0,
            notes: vec![],
            null_text: String::new(),
        })
    }
    pub fn begin_sheet(
        &mut self,
        name: &str,
        columns: Vec<TransferColumn>,
        headers: Vec<Vec<String>>,
    ) -> Result<(), String> {
        if columns.is_empty() || columns.len() > MAX_COLUMNS {
            return Err("XLSX 每张表需要 1 到 16384 列".into());
        }
        if headers.iter().any(|row| row.len() != columns.len()) || headers.len() > 2 {
            return Err("XLSX 表头与列数不一致".into());
        }
        self.seal()?;
        self.base_name = name.into();
        self.columns = columns;
        self.headers = headers;
        self.start_sheet()
    }
    pub fn set_null_text(&mut self, text: String) {
        self.null_text = text;
    }
    fn start_sheet(&mut self) -> Result<(), String> {
        let name = unique_sheet_name(&self.base_name, &mut self.used_names);
        let file = NamedTempFile::new_in(self.dir.path())
            .map_err(|e| format!("建工作表临时文件失败：{e}"))?;
        self.active = Some(ActiveSheet {
            name,
            out: BufWriter::with_capacity(64 * 1024, file),
            data_rows: 0,
            row_number: 0,
        });
        self.write("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData>")?;
        for header in self.headers.clone() {
            let row: Vec<_> = header.into_iter().map(Value::String).collect();
            self.write_row(&row, true)?;
        }
        Ok(())
    }
    fn write(&mut self, text: &str) -> Result<(), String> {
        self.active
            .as_mut()
            .ok_or("没有活动工作表")?
            .out
            .write_all(text.as_bytes())
            .map_err(|e| format!("写 XLSX 工作表失败：{e}"))?;
        self.bytes += text.len() as u64;
        Ok(())
    }
    pub fn push(&mut self, row: &[Value]) -> Result<(), String> {
        if self.active.as_ref().ok_or("没有活动工作表")?.data_rows
            >= self.limit.min(1_048_576 - self.headers.len())
        {
            self.seal()?;
            self.start_sheet()?;
        }
        self.write_row(row, false)?;
        self.active.as_mut().unwrap().data_rows += 1;
        Ok(())
    }
    fn write_row(&mut self, row: &[Value], header: bool) -> Result<(), String> {
        if row.len() != self.columns.len() {
            return Err("XLSX 行与列数不一致".into());
        }
        let n = self.active.as_ref().ok_or("没有活动工作表")?.row_number + 1;
        let mut xml = format!("<row r=\"{n}\">");
        for (i, value) in row.iter().enumerate() {
            let reference = format!("{}{n}", col_letters(i + 1));
            if value.is_null() {
                if !self.null_text.is_empty() {
                    let escaped = excel_text(&self.null_text)?;
                    xml.push_str(&format!("<c r=\"{reference}\" t=\"inlineStr\"><is><t xml:space=\"preserve\">{escaped}</t></is></c>"));
                }
                continue;
            }
            if !header && value.is_boolean() {
                xml.push_str(&format!(
                    "<c r=\"{reference}\" t=\"b\"><v>{}</v></c>",
                    usize::from(value == &Value::Bool(true))
                ));
                continue;
            }
            let text = cell_text(value);
            if !header && safe_number(value, &self.columns[i]) {
                xml.push_str(&format!("<c r=\"{reference}\"><v>{text}</v></c>"));
            } else {
                if !header
                    && numeric_column(&self.columns[i])
                    && crate::db_transfer::numeric_syntax(&text)
                {
                    self.text_numbers += 1;
                }
                let escaped = excel_text(&text)
                    .map_err(|e| format!("工作表第 {n} 行第 {} 列：{e}", i + 1))?;
                // inlineStr is deliberately used even for strings beginning '=': Excel must not evaluate them.
                xml.push_str(&format!("<c r=\"{reference}\" t=\"inlineStr\"><is><t xml:space=\"preserve\">{escaped}</t></is></c>"));
            }
        }
        xml.push_str("</row>");
        self.write(&xml)?;
        self.active.as_mut().unwrap().row_number = n;
        Ok(())
    }
    fn seal(&mut self) -> Result<(), String> {
        if self.active.is_none() {
            return Ok(());
        }
        self.write("</sheetData></worksheet>")?;
        let mut active = self.active.take().unwrap();
        active
            .out
            .flush()
            .map_err(|e| format!("刷新 XLSX 工作表失败：{e}"))?;
        let file = active
            .out
            .into_inner()
            .map_err(|e| format!("关闭 XLSX 工作表失败：{e}"))?;
        self.sheets.push(Sheet {
            name: active.name,
            file,
        });
        Ok(())
    }
    pub fn add_note(&mut self, note: String) {
        self.notes.push(note);
    }
    pub fn bytes(&self) -> u64 {
        self.bytes
    }
    pub fn warnings(&self) -> Vec<String> {
        if self.text_numbers > 0 {
            vec![format!(
                "{} 个数字为保留原始编码、15 位以上精度或可表示范围，已按文本保存",
                self.text_numbers
            )]
        } else {
            vec![]
        }
    }
    pub fn finish(mut self, file: File) -> Result<File, String> {
        if !self.notes.is_empty() {
            let notes = std::mem::take(&mut self.notes);
            let c = TransferColumn {
                name: "说明".into(),
                ty: "VARCHAR2".into(),
                precision: None,
                scale: None,
            };
            self.begin_sheet("导出说明", vec![c], vec![vec!["说明".into()]])?;
            for note in notes {
                // Each note chunk is a valid cell; a long SQL note does not force a giant buffer.
                let mut part = String::new();
                let mut units = 0;
                for ch in note.chars() {
                    if units + ch.len_utf16() > MAX_CELL_UNITS {
                        self.push(&[Value::String(std::mem::take(&mut part))])?;
                        units = 0;
                    }
                    part.push(ch);
                    units += ch.len_utf16();
                }
                self.push(&[Value::String(part)])?;
            }
        }
        self.seal()?;
        if self.sheets.is_empty() {
            return Err("XLSX 没有工作表".into());
        }
        let mut zip = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        let mut types = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/>");
        let mut workbook = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?><workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><sheets>");
        let mut relationships = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">");
        for (i, sheet) in self.sheets.iter_mut().enumerate() {
            let n = i + 1;
            types.push_str(&format!("<Override PartName=\"/xl/worksheets/sheet{n}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>"));
            workbook.push_str(&format!(
                "<sheet name=\"{}\" sheetId=\"{n}\" r:id=\"rId{n}\"/>",
                xml_text(&sheet.name)
            ));
            relationships.push_str(&format!("<Relationship Id=\"rId{n}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet{n}.xml\"/>"));
            zip.start_file(format!("xl/worksheets/sheet{n}.xml"), options)
                .map_err(zip_error)?;
            sheet
                .file
                .as_file_mut()
                .seek(SeekFrom::Start(0))
                .map_err(io_error)?;
            std::io::copy(sheet.file.as_file_mut(), &mut zip).map_err(io_error)?;
        }
        types.push_str("</Types>");
        workbook.push_str("</sheets></workbook>");
        relationships.push_str("</Relationships>");
        for (name,text) in [("[Content_Types].xml", types), ("xl/workbook.xml", workbook), ("xl/_rels/workbook.xml.rels", relationships), ("_rels/.rels", "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/></Relationships>".into())] {
            zip.start_file(name,options).map_err(zip_error)?; zip.write_all(text.as_bytes()).map_err(io_error)?;
        }
        zip.finish().map_err(zip_error)
    }
}
fn zip_error(e: zip::result::ZipError) -> String {
    format!("封装 XLSX 失败：{e}")
}
fn io_error(e: std::io::Error) -> String {
    format!("写 XLSX 失败：{e}")
}
fn col_letters(mut n: usize) -> String {
    let mut chars = Vec::new();
    while n > 0 {
        chars.push((b'A' + ((n - 1) % 26) as u8) as char);
        n = (n - 1) / 26;
    }
    chars.into_iter().rev().collect()
}
fn numeric_column(c: &TransferColumn) -> bool {
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
fn is_numeric(s: &str) -> bool {
    !s.trim().is_empty() && s.trim().parse::<f64>().is_ok_and(f64::is_finite)
}
fn safe_number(v: &Value, c: &TransferColumn) -> bool {
    if !v.is_number() && (!v.is_string() || !numeric_column(c)) {
        return false;
    }
    let s = cell_text(v);
    let text = s.trim();
    if text != s
        || !is_numeric(text)
        || c.precision.is_some_and(|p| p > 15)
        || c.scale.is_some_and(|p| p > 15)
    {
        return false;
    }
    let mantissa = text.split(['e', 'E']).next().unwrap_or(text);
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    // Codes such as '000123' cannot be represented numerically without losing their original text.
    let unsigned = mantissa.trim_start_matches(['+', '-']);
    if unsigned.starts_with('0') && unsigned.chars().nth(1).is_some_and(|c| c.is_ascii_digit()) {
        return false;
    }
    let significant = digits.trim_start_matches('0').len();
    let n = text.parse::<f64>().unwrap();
    significant <= 15
        && (n != 0.0 || !digits.contains(['1', '2', '3', '4', '5', '6', '7', '8', '9']))
        && (n == 0.0
            || (n.abs() >= 2.225_073_858_507_201_4e-308 && n.abs() <= 1.797_693_134_862_315_7e308))
}
fn excel_text(s: &str) -> Result<String, String> {
    if s.encode_utf16().count() > MAX_CELL_UNITS {
        return Err("文本超过 Excel 单元格 32767 字符限制，已停止导出；请改用 JSONL / CSV".into());
    }
    if s.chars().any(|c| {
        (c < '\u{20}' && !matches!(c, '\t' | '\n' | '\r')) || matches!(c, '\u{fffe}' | '\u{ffff}')
    }) {
        return Err("文本含 XML 不允许的控制字符，已停止导出；请改用 JSONL".into());
    }
    let mut encoded = String::new();
    let bytes = s.as_bytes();
    let mut cursor = 0;
    for (i, c) in s.char_indices() {
        if c == '_'
            && bytes.get(i + 1) == Some(&b'x')
            && bytes.get(i + 6) == Some(&b'_')
            && bytes
                .get(i + 2..i + 6)
                .is_some_and(|v| v.iter().all(u8::is_ascii_hexdigit))
        {
            encoded.push_str(&s[cursor..i]);
            encoded.push_str("_x005F_");
            cursor = i + 1;
        }
    }
    encoded.push_str(&s[cursor..]);
    Ok(xml_text(&encoded).replace('\r', "&#13;"))
}
fn unique_sheet_name(raw: &str, used: &mut HashSet<String>) -> String {
    let safe: String = raw
        .chars()
        .map(|c| {
            if c.is_control() || "[]:*?/\\".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let base = safe.trim().trim_matches('\'');
    let base = if base.is_empty() { "结果" } else { base };
    let mut n = 1;
    loop {
        let suffix = if n == 1 {
            String::new()
        } else {
            format!("_{n}")
        };
        let cap = 31 - suffix.encode_utf16().count();
        let mut units = 0;
        let head: String = base
            .chars()
            .take_while(|c| {
                units += c.len_utf16();
                units <= cap
            })
            .collect();
        // Truncation can expose an interior apostrophe at the end, which Excel disallows in sheet names.
        let name = format!("{}{suffix}", head.trim_end_matches('\''));
        if used.insert(name.to_lowercase()) {
            return name;
        }
        n += 1;
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    fn col(ty: &str) -> TransferColumn {
        TransferColumn {
            name: "值".into(),
            ty: ty.into(),
            precision: None,
            scale: None,
        }
    }
    #[test]
    fn splits_with_small_injected_row_limit_and_keeps_strings_inline() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("a.xlsx");
        let mut w = XlsxWriter::with_limit(d.path(), 2).unwrap();
        w.begin_sheet("结果/一", vec![col("NUMBER")], vec![vec!["值".into()]])
            .unwrap();
        for v in [
            Value::String("12345678901234567890".into()),
            Value::String("=SUM(1,2)".into()),
            Value::from(12),
        ] {
            w.push(&[v]).unwrap();
        }
        assert_eq!(w.warnings().len(), 1);
        w.finish(File::create(&path).unwrap()).unwrap();
        let mut zip = zip::ZipArchive::new(File::open(&path).unwrap()).unwrap();
        let mut xml = String::new();
        zip.by_name("xl/worksheets/sheet1.xml")
            .unwrap()
            .read_to_string(&mut xml)
            .unwrap();
        assert!(xml.contains("t=\"inlineStr\""));
        assert!(xml.contains("12345678901234567890"));
        assert!(xml.contains("=SUM(1,2)"));
        assert!(!xml.contains("<f>"));
        assert!(xml.ends_with("</worksheet>"));
        xml.clear();
        zip.by_name("xl/worksheets/sheet2.xml")
            .unwrap()
            .read_to_string(&mut xml)
            .unwrap();
        assert!(xml.contains("<v>12</v>"));
        xml.clear();
        zip.by_name("xl/workbook.xml")
            .unwrap()
            .read_to_string(&mut xml)
            .unwrap();
        assert!(xml.contains("结果_一_2"));
    }
    #[test]
    fn preserves_precision_codes_and_ooxml_escape_literals() {
        assert!(!safe_number(&Value::String("00012".into()), &col("NUMBER")));
        assert!(!safe_number(
            &Value::String("9007199254740993".into()),
            &col("NUMBER")
        ));
        assert!(!safe_number(&Value::String("12".into()), &col("VARCHAR2")));
        assert_eq!(
            excel_text("_x000D_\r &").unwrap(),
            "_x005F_x000D_&#13; &amp;"
        );
        assert!(excel_text(&"a".repeat(32768)).is_err());
        assert!(excel_text("\u{0}").is_err());
        let mut c = col("NUMBER");
        c.precision = Some(30);
        assert!(!safe_number(&Value::from(1), &c));
        assert!(!safe_number(
            &Value::String("1e-1000".into()),
            &col("NUMBER")
        ));
        assert!(excel_text(&"😀".repeat(16384)).is_err());
    }
    #[test]
    fn empty_worksheet_and_unique_names_are_valid() {
        let mut names = HashSet::new();
        assert_eq!(unique_sheet_name("Sheet", &mut names), "Sheet");
        assert_eq!(unique_sheet_name("sheet", &mut names), "sheet_2");
        assert!(
            !unique_sheet_name(&format!("{}'tail", "a".repeat(30)), &mut names).ends_with('\'')
        );
        let d = tempfile::tempdir().unwrap();
        let mut w = XlsxWriter::new(d.path()).unwrap();
        w.begin_sheet("空结果", vec![col("DATE")], vec![vec!["日期".into()]])
            .unwrap();
        w.finish(File::create(d.path().join("empty.xlsx")).unwrap())
            .unwrap();
        assert_eq!(
            std::fs::read_dir(d.path()).unwrap().count(),
            1,
            "spool directory must be reclaimed"
        );
    }
    #[test]
    fn encoder_failure_reclaims_spool_and_leaves_complete_destination_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("kept.xlsx");
        std::fs::write(&dest, "previous complete").unwrap();
        {
            let mut w = XlsxWriter::new(dir.path()).unwrap();
            w.begin_sheet("结果", vec![col("VARCHAR2")], vec![])
                .unwrap();
            assert!(w.push(&[Value::String("a".repeat(32768))]).is_err());
        }
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "previous complete");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
    #[test]
    fn both_headers_and_explicit_null_text_survive_xml() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.xlsx");
        let mut w = XlsxWriter::new(dir.path()).unwrap();
        w.set_null_text("NULL".into());
        w.begin_sheet(
            "结果",
            vec![col("VARCHAR2")],
            vec![vec!["VALUE".into()], vec!["值".into()]],
        )
        .unwrap();
        w.push(&[Value::Null]).unwrap();
        w.finish(File::create(&path).unwrap()).unwrap();
        let mut zip = zip::ZipArchive::new(File::open(path).unwrap()).unwrap();
        let mut xml = String::new();
        zip.by_name("xl/worksheets/sheet1.xml")
            .unwrap()
            .read_to_string(&mut xml)
            .unwrap();
        assert!(xml.contains("VALUE"));
        assert!(xml.contains("r=\"A2\""));
        assert!(xml.contains("NULL"));
        assert!(xml.contains("r=\"A3\""));
    }
}
