//! 结果集流式写文件（A4）：CSV / TSV / INSERT。
//!
//! **为什么在后端做**：前端 `toCsv` 是把整张表拼成一个字符串再落盘，十万行几百 MB，
//! 峰值内存 O(行数)；而且它只能导出「已经取到界面上的那一页」。这里按页取、按行写，
//! 峰值内存 O(一页 + 一行)。
//!
//! 本模块只做**格式**（纯函数，有单测）；取数与落盘在 `commands/db_export_cmds.rs`，
//! 文件路径/进度事件也在那里——这样格式能脱离数据库测。
//!
//! 三条格式约定（与前端 `resultExport.ts` 一致，用户在界面里复制、在文件里导出应该是同一份）：
//! - CSV：`,` 分隔、`"` 加倍转义、含分隔符/引号/换行的字段加引号、行尾 CRLF、开头带 BOM
//!   （Excel 开 UTF-8 CSV 不带 BOM 会乱码）；以 `=` `@` 等开头的自由文本前面加 `'`，
//!   否则 Excel 会把数据库里的值当公式执行（CSV 注入，CWE-1236）；
//! - TSV：制表符分隔、字段里的 tab/换行压成空格（否则粘进 Excel 会串行）；
//! - INSERT：`null` 关键字表 NULL，数字列不加引号，日期走 `to_date(...)` —— 直接复用
//!   `sql_export::literal`，与「导出 INSERT」那条路径同一个实现。

use std::borrow::Cow;
use std::io::{self, Write};

use crate::sql_export::{self, ResultCol};

/// CSV 的 BOM。Excel 认它，别去掉。
const BOM: &str = "\u{feff}";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Csv,
    Tsv,
    Insert,
}

impl Format {
    pub fn parse(s: &str) -> Result<Self, String> {
        match s.trim().to_ascii_lowercase().as_str() {
            "csv" => Ok(Format::Csv),
            "tsv" => Ok(Format::Tsv),
            "insert" | "sql" => Ok(Format::Insert),
            other => Err(format!(
                "不支持的导出格式：{other}（只有 csv / tsv / insert）"
            )),
        }
    }

    pub fn ext(self) -> &'static str {
        match self {
            Format::Csv => "csv",
            Format::Tsv => "tsv",
            Format::Insert => "insert.sql",
        }
    }
}

/// Excel / Sheets 把以这些字符开头的单元格当公式执行（CSV 注入，CWE-1236）。
///
/// `-` 与 `+` 只在后面不是纯数字时才算风险：负数是最常见的数据，给每个 `-1`
/// 前面加撇号会把整列数字变成文本，代价比防住公式大得多。
fn formula_risk(s: &str) -> bool {
    match s.chars().next() {
        Some('=' | '@' | '\t' | '\r') => true,
        Some('+' | '-') => s.trim().parse::<f64>().is_err(),
        _ => false,
    }
}

/// 需要防护时在值前面加一个单引号（Excel 的「按文本处理」标记）。
fn guard_formula(s: &str) -> Cow<'_, str> {
    if formula_risk(s) {
        Cow::Owned(format!("'{s}"))
    } else {
        Cow::Borrowed(s)
    }
}

/// CSV 单字段。只在**需要**时加引号：全加引号虽然也对，但文件会大一倍，
/// 而且 `less` / `diff` 里全是引号噪音。
pub fn csv_field(s: &str) -> Cow<'_, str> {
    let guarded = guard_formula(s);
    if s.contains([',', '"', '\n', '\r']) || guarded.len() != s.len() {
        Cow::Owned(format!("\"{}\"", guarded.replace('"', "\"\"")))
    } else {
        Cow::Borrowed(s)
    }
}

/// TSV 单字段：tab 与换行会破坏列对齐，压成空格（与前端 `toTsv` 一致）。
pub fn tsv_field(s: &str) -> Cow<'_, str> {
    let guarded = guard_formula(s);
    if s.contains(['\t', '\n', '\r']) {
        Cow::Owned(
            guarded
                .chars()
                .map(|c| {
                    if matches!(c, '\t' | '\n' | '\r') {
                        ' '
                    } else {
                        c
                    }
                })
                .collect(),
        )
    } else {
        guarded
    }
}

/// 逐行写出的写入器。`W` 一般是 `BufWriter<File>`。
pub struct RowWriter<W: Write> {
    out: W,
    fmt: Format,
    cols: Vec<ResultCol>,
    table: String,
    rows: usize,
    /// 复用同一块缓冲：十万行时逐行 `format!` 会产生十万次分配
    buf: String,
}

impl<W: Write> RowWriter<W> {
    /// 建写入器并写表头（CSV / TSV）或注释头（INSERT）。
    pub fn new(mut out: W, fmt: Format, cols: Vec<ResultCol>, table: &str) -> io::Result<Self> {
        if cols.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "结果集没有列元数据，导出不了",
            ));
        }
        match fmt {
            Format::Csv => {
                out.write_all(BOM.as_bytes())?;
                let head: Vec<String> = cols
                    .iter()
                    .map(|c| csv_field(&c.name).to_string())
                    .collect();
                out.write_all(head.join(",").as_bytes())?;
                out.write_all(b"\r\n")?;
            }
            Format::Tsv => {
                let head: Vec<&str> = cols.iter().map(|c| c.name.as_str()).collect();
                out.write_all(head.join("\t").as_bytes())?;
                out.write_all(b"\n")?;
            }
            Format::Insert => {
                out.write_all(
                    format!(
                        "-- NCForge 导出：{table}（{} 列，INSERT 脚本）\n-- 生成后请核对日期与 NULL 的写法是否符合目标库\n\n",
                        cols.len()
                    )
                    .as_bytes(),
                )?;
            }
        }
        Ok(Self {
            out,
            fmt,
            cols,
            table: table.to_string(),
            rows: 0,
            buf: String::new(),
        })
    }

    pub fn rows(&self) -> usize {
        self.rows
    }

    /// 写一行。`cells` 与 `cols` 对不上时按列数补/截（NULL 补齐）——
    /// 宁可少一个字段也不要因为一行异常让整次导出失败。
    pub fn push(&mut self, cells: &[Option<String>]) -> io::Result<()> {
        self.buf.clear();
        match self.fmt {
            Format::Csv => {
                for i in 0..self.cols.len() {
                    if i > 0 {
                        self.buf.push(',');
                    }
                    if let Some(v) = cells.get(i).and_then(|c| c.as_deref()) {
                        self.buf.push_str(&csv_field(v));
                    }
                }
                self.buf.push_str("\r\n");
            }
            Format::Tsv => {
                for i in 0..self.cols.len() {
                    if i > 0 {
                        self.buf.push('\t');
                    }
                    if let Some(v) = cells.get(i).and_then(|c| c.as_deref()) {
                        self.buf.push_str(&tsv_field(v));
                    }
                }
                self.buf.push('\n');
            }
            Format::Insert => {
                // 每条 insert 自带完整列清单：脚本可以单独摘一条出来跑，
                // 也避免了「前半段列清单对、后半段靠位置对齐」这种读不出来的错
                self.buf.push_str("insert into ");
                self.buf.push_str(&self.table);
                self.buf.push_str(" (");
                let names: Vec<&str> = self.cols.iter().map(|c| c.name.as_str()).collect();
                self.buf.push_str(&names.join(", "));
                self.buf.push_str(") values (");
                for i in 0..self.cols.len() {
                    if i > 0 {
                        self.buf.push_str(", ");
                    }
                    let v = cells.get(i).and_then(|c| c.as_deref());
                    let lit = sql_export::literal(v, &self.cols[i].ty);
                    self.buf.push_str(&lit);
                }
                self.buf.push_str(");\n");
            }
        }
        self.out.write_all(self.buf.as_bytes())?;
        self.rows += 1;
        Ok(())
    }

    /// 收尾：INSERT 补一条 `commit;`（否则脚本结尾是脏事务）。返回底层写入器。
    pub fn finish(mut self) -> io::Result<W> {
        if self.fmt == Format::Insert && self.rows > 0 {
            self.out.write_all(b"commit;\n")?;
        }
        self.out.flush()?;
        Ok(self.out)
    }
}

/// 文件名安全化：留 Unicode 字母数字与 `_ - .`，其余换 `_`；带上扩展名。
///
/// **为什么用 `is_alphanumeric()` 而不是 `is_ascii_alphanumeric()`**：表名绝大多数是
/// `员工表` 这种中文，按 ASCII 白名单过滤会把整个名字压成 `____`，用户在一堆导出文件里
/// 根本认不出哪个是哪个。这里要挡的只是**路径分隔符与 Shell/Excel 敏感字符**
/// （`/ \ : * ? " < > |` 以及控制字符），中文、日文、重音字母都是合法文件名字符。
///
/// 时间戳由前端给（`new Date()`，本机时区）——后端没有 chrono，也**不该**在这里
/// 自己算日期：算成 UTC 会让文件名比用户手表差 8 小时，看起来像 bug。
pub fn safe_file_name(raw: Option<&str>, fallback: &str, fmt: Format) -> String {
    let base = raw
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(fallback);
    let mut s: String = base
        .chars()
        .map(|c| {
            // `is_alphanumeric()` 覆盖所有 Unicode 字母与数字（含中文）；
            // 控制字符不是字母数字，会被落到 `_` 分支。
            if c.is_alphanumeric() || matches!(c, '_' | '-' | '.') {
                c
            } else {
                '_'
            }
        })
        .collect();
    // 去掉用户给的后缀（可能是 .csv / .sql），统一按格式补
    for ext in [".csv", ".tsv", ".insert.sql", ".sql"] {
        if let Some(stripped) = s.strip_suffix(ext) {
            s = stripped.to_string();
            break;
        }
    }
    if s.is_empty() || s == "_" {
        s = "export".to_string();
    }
    format!("{s}.{}", fmt.ext())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cols() -> Vec<ResultCol> {
        vec![
            ResultCol {
                name: "ID".into(),
                ty: "NUMBER".into(),
            },
            ResultCol {
                name: "NAME".into(),
                ty: "VARCHAR2(50)".into(),
            },
        ]
    }

    fn render(fmt: Format, rows: &[Vec<Option<String>>]) -> String {
        let mut w = RowWriter::new(Vec::new(), fmt, cols(), "T").unwrap();
        for r in rows {
            w.push(r).unwrap();
        }
        String::from_utf8(w.finish().unwrap()).unwrap()
    }

    #[test]
    fn csv_只在该转义时加引号() {
        assert_eq!(csv_field("abc"), "abc");
        assert_eq!(csv_field("a,b"), "\"a,b\"");
        assert_eq!(csv_field("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(csv_field("a\nb"), "\"a\nb\"");
        // 反引号、单引号不该触发引号包裹
        assert_eq!(csv_field("it's"), "it's");
        // 负数照旧是数字：不能给每个 -1 加撇号，否则整列数字变文本
        assert_eq!(csv_field("-123.45"), "-123.45");
        assert_eq!(csv_field("+7"), "+7");
        assert_eq!(csv_field("1e5"), "1e5");
    }

    #[test]
    fn csv_公式注入被中和() {
        assert_eq!(csv_field("=cmd|' /C calc'!A0"), "\"'=cmd|' /C calc'!A0\"");
        assert_eq!(csv_field("@SUM(A1)"), "\"'@SUM(A1)\"");
        assert_eq!(csv_field("+CMD"), "\"'+CMD\"");
        assert_eq!(csv_field("-2+3"), "\"'-2+3\"");
        assert_eq!(tsv_field("=HYPERLINK(\"x\")"), "'=HYPERLINK(\"x\")");
        assert_eq!(tsv_field("-1"), "-1");
    }

    #[test]
    fn csv_带_bom_头与_crlf_行尾() {
        let out = render(Format::Csv, &[vec![Some("1".into()), Some("张三".into())]]);
        assert!(
            out.starts_with('\u{feff}'),
            "Excel 开 UTF-8 CSV 靠 BOM 认编码"
        );
        assert!(out.contains("ID,NAME\r\n"), "{out:?}");
        assert!(out.ends_with("1,张三\r\n"), "{out:?}");
    }

    #[test]
    fn csv_里_null_写空而不是_null() {
        let out = render(Format::Csv, &[vec![Some("1".into()), None]]);
        assert!(out.ends_with("1,\r\n"), "{out:?}");
    }

    #[test]
    fn tsv_把制表符与换行压成空格() {
        let out = render(
            Format::Tsv,
            &[vec![Some("1".into()), Some("a\tb\nc".into())]],
        );
        assert_eq!(out, "ID\tNAME\n1\ta b c\n");
    }

    #[test]
    fn insert_每条都带列清单并收尾_commit() {
        let out = render(
            Format::Insert,
            &[
                vec![Some("1".into()), Some("O'Brien".into())],
                vec![None, None],
            ],
        );
        assert!(out.contains("insert into T (ID, NAME) values (1, 'O''Brien');"));
        assert!(
            out.contains("insert into T (ID, NAME) values (null, null);"),
            "{out}"
        );
        assert!(out.trim_end().ends_with("commit;"), "{out}");
    }

    #[test]
    fn 列数不够时按空行补齐() {
        // 驱动偶尔会给出一行列数不足的行（对象类型取失败）：不能吞掉整次导出
        let out = render(Format::Csv, &[vec![Some("1".into())]]);
        assert!(out.ends_with("1,\r\n"), "{out:?}");
    }

    #[test]
    fn 格式名解析与扩展名() {
        assert_eq!(Format::parse("CSV").unwrap(), Format::Csv);
        assert_eq!(Format::parse("tsv").unwrap(), Format::Tsv);
        assert_eq!(Format::parse("insert").unwrap(), Format::Insert);
        assert!(Format::parse("xlsx").is_err());
        assert_eq!(Format::Csv.ext(), "csv");
        assert_eq!(Format::Insert.ext(), "insert.sql");
    }

    #[test]
    fn 文件名只留安全字符并统一后缀() {
        assert_eq!(
            safe_file_name(Some("bd_material-20261031-1635.csv"), "x", Format::Csv),
            "bd_material-20261031-1635.csv"
        );
        assert_eq!(
            safe_file_name(Some("员工表/2026:10"), "x", Format::Insert),
            "员工表_2026_10.insert.sql"
        );
        assert_eq!(safe_file_name(None, "result", Format::Tsv), "result.tsv");
        assert_eq!(
            safe_file_name(Some("   "), "result", Format::Csv),
            "result.csv"
        );
    }
}
