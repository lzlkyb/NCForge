//! 从 Java 源码里抽出「会打到数据库」的表名与字段引用。
//!
//! 为什么不是对源码跑正则：NC 二开的 SQL 全是拼接的，一条语句被切成七八段字符串，
//! 中间还隔着 Java 表达式：
//!
//! ```text
//! where.append(" pam_equip.pk_used_status not in (select pk_status from pam_status where status_type = "
//!         + type + ")");
//! ```
//!
//! 所以顺序是：**去注释 → 把字符串常量按出现顺序拼回去 → 在拼接结果上切词解析**。
//! 拼接时每段之间补一个空格，`"from " + "bd_material"` 与 `"from" + "bd_material"` 两种写法都能接上。
//!
//! 已知局限（界面上要说清，别让人误以为它能查全）：
//! - 表名本身是变量的（`from " + tableName`）抽不出来，这是纯动态 SQL；
//! - 拼接处被 Java 表达式切断的表名（`"... from bd_" + mid + "material"`）同样抽不出来；
//! - 注释掉的 SQL 不算——这是有意的，注释里的表名不该参与核对。

use std::collections::{BTreeMap, BTreeSet};

// ───────────────────────── 结果结构 ─────────────────────────

/// 一处表名引用。同一个表名只保留第一次出现的位置。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TableHit {
    pub name: String,
    /// 源码行号（1 基）。指向**这段字符串开始的那一行**，不是表名本身所在行——
    /// 一段 SQL 字符串通常就一行，误差可以接受。
    pub line: usize,
}

/// 一处 `别名.字段` 或 `表名.字段` 引用。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColumnHit {
    /// 点号前半段，原样大小写：`t`、`pam_equip`。
    pub qualifier: String,
    /// 点号后半段。
    pub column: String,
    pub line: usize,
}

/// 一个文件的抽取结果。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FileRefs {
    pub tables: Vec<TableHit>,
    pub columns: Vec<ColumnHit>,
    /// 别名（小写）→ 它可能是哪几张表（小写）。同一别名在不同语句里指不同表时会有多个。
    pub aliases: BTreeMap<String, Vec<String>>,
}

/// 裸列（`select asset_code from fa_card` 里没有表名前缀的列）归属的表。
///
/// 只有在「这段语句里正好只有一张表」时才认：多表 join 时裸列归谁看不出来，
/// 硬猜会造成大量误报，不如不报。`qualifier` 填表名（小写）。
fn own_by_single(tables: &[String]) -> Option<&String> {
    if tables.len() == 1 {
        tables.first()
    } else {
        None
    }
}

// ───────────────────────── 抽取 ─────────────────────────

/// 解析一个 Java 源文件。
///
/// 分两层：先把整份文件切成语句，再逐条语句解析。切语句是必须的——裸列只有在
/// 「本句只有一张表」时才能确定归属，混着一堆语句一起看就永远不止一张表。
pub fn parse(src: &str) -> FileRefs {
    let clean = strip_comments(src);
    let (joined, marks) = concat_strings(&clean);
    let toks = tokenize(&joined);

    let mut tables: Vec<TableHit> = Vec::new();
    let mut seen_t: BTreeSet<String> = BTreeSet::new();
    let mut aliases: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut columns: Vec<ColumnHit> = Vec::new();
    let mut seen_c: BTreeSet<(String, String)> = BTreeSet::new();

    for seg in split_statements(&toks) {
        // ① 本句涉及的表与别名
        let mut seg_tables: Vec<String> = Vec::new();
        let mut seg_alias: BTreeMap<String, String> = BTreeMap::new();
        for (i, t) in seg.iter().enumerate() {
            if t.kind != Kind::Ident || !is_table_intro(&t.lower) {
                continue;
            }
            let Some(name_tok) = seg.get(i + 1) else { continue };
            // `from (...)` 是子查询或函数调用，子查询会被切到下一段单独解析
            if name_tok.kind != Kind::Ident || !is_table_name(&name_tok.text) {
                continue;
            }
            let lname = name_tok.text.to_lowercase();
            if seen_t.insert(lname.clone()) {
                tables.push(TableHit {
                    name: name_tok.text.clone(),
                    line: line_at(&marks, t.at),
                });
            }
            seg_tables.push(lname.clone());
            if let Some(a) = alias_after(seg, i + 1) {
                seg_alias.entry(a.to_lowercase()).or_insert(lname.clone());
                aliases.entry(a.to_lowercase()).or_default().insert(lname);
            }
        }

        // ② `别名.列` / `表名.列`
        let mut k = 0;
        while k + 2 < seg.len() {
            let (a, dot, b) = (&seg[k], &seg[k + 1], &seg[k + 2]);
            if a.kind == Kind::Ident && dot.text == "." && b.kind == Kind::Ident {
                let (q, c) = (a.lower.clone(), b.lower.clone());
                if seen_c.insert((q, c)) {
                    columns.push(ColumnHit {
                        qualifier: a.text.clone(),
                        column: b.text.clone(),
                        line: line_at(&marks, a.at),
                    });
                }
                k += 3;
                continue;
            }
            k += 1;
        }

        // ③ 裸列：本句只有一张表时才归属它
        let Some(owner) = own_by_single(&seg_tables).cloned() else {
            continue;
        };
        for (k, t) in seg.iter().enumerate() {
            if t.kind != Kind::Ident {
                continue;
            }
            let l = t.lower.as_str();
            if STOP_WORDS.contains(&l)
                || is_table_intro(l)
                || l == "dual"
                || l == "level"
                || l == "prior"
                || seg_tables.iter().any(|x| x == l)
                || seg_alias.contains_key(l)
            {
                continue;
            }
            // 前后是点号 → 属于 `x.y`，已在 ② 处理；后面是括号 → 函数名
            if k > 0 && seg[k - 1].text == "." {
                continue;
            }
            if k + 1 < seg.len() && (seg[k + 1].text == "." || seg[k + 1].text == "(") {
                continue;
            }
            if seen_c.insert((owner.clone(), l.to_string())) {
                columns.push(ColumnHit {
                    qualifier: owner.clone(),
                    column: t.text.clone(),
                    line: line_at(&marks, t.at),
                });
            }
        }
    }

    FileRefs {
        tables,
        columns,
        aliases: aliases
            .into_iter()
            .map(|(k, v)| (k, v.into_iter().collect()))
            .collect(),
    }
}

/// 按 `select / insert / update / delete` 切语句。子查询自成一段（它的裸列归它自己的表）。
fn split_statements(toks: &[Tok]) -> Vec<&[Tok]> {
    let mut out = Vec::new();
    let mut start = 0;
    for (i, t) in toks.iter().enumerate() {
        if i == 0 {
            continue;
        }
        if t.kind == Kind::Ident && is_stmt_start(&t.lower) {
            out.push(&toks[start..i]);
            start = i;
        }
    }
    if start < toks.len() {
        out.push(&toks[start..]);
    }
    out
}

fn is_stmt_start(lower: &str) -> bool {
    matches!(lower, "select" | "insert" | "update" | "delete")
}

/// `from` / `join` / `into` / `update` 这几个后面跟表名。
fn is_table_intro(lower: &str) -> bool {
    matches!(lower, "from" | "join" | "into" | "update")
}

/// 表名像不像表名：字母开头、含下划线或全小写、不是 SQL 关键字、不是 `dual`。
///
/// 真实 NC 表名全是 `bd_material` / `pam_equip` 这种。刻意**不要求必须有下划线**——
/// `fa_card` 有，但也存在 `ic_onhand` 之外的无下划线表；宁可多收，核对阶段再判存在性。
fn is_table_name(name: &str) -> bool {
    if name.len() < 2 || !name.starts_with(|c: char| c.is_ascii_alphabetic()) {
        return false;
    }
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$' || c == '#') {
        return false;
    }
    let l = name.to_lowercase();
    if l == "dual" || l == "select" || STOP_WORDS.contains(&l.as_str()) {
        return false;
    }
    // 全大写的多半是常量名（`FROM` 关键字已被小写比较吃掉，这里是 `PK_ORG` 这类）：
    // 表名在 NC 里一律小写，出现纯大写当表名基本是误判。只看字母，`_` 不参与判断。
    let letters: Vec<char> = name.chars().filter(|c| c.is_ascii_alphabetic()).collect();
    if !letters.is_empty() && !letters.iter().any(|c| c.is_ascii_lowercase()) {
        return false;
    }
    true
}

/// 表名后面的别名。`from t a` / `from t as a` / `from t`（后面是 where 之类）。
fn alias_after(toks: &[Tok], table_at: usize) -> Option<String> {
    let mut j = table_at + 1;
    if toks.get(j)?.kind != Kind::Ident {
        return None;
    }
    if toks[j].lower == "as" {
        j += 1;
        let t = toks.get(j)?;
        if t.kind != Kind::Ident || STOP_WORDS.contains(&t.lower.as_str()) {
            return None;
        }
        return Some(t.text.clone());
    }
    if STOP_WORDS.contains(&toks[j].lower.as_str()) {
        return None;
    }
    Some(toks[j].text.clone())
}

/// 会终止「别名/表名槽位」的关键字。少一个就会出现 `from t where` 把 `where` 当别名。
const STOP_WORDS: &[&str] = &[
    "where", "on", "group", "order", "having", "left", "right", "inner", "outer", "full",
    "cross", "join", "union", "all", "and", "or", "set", "values", "select", "from", "into",
    "update", "delete", "insert", "as", "using", "when", "then", "else", "end", "case", "by",
    "limit", "start", "connect", "with", "not", "in", "exists", "like", "between", "is", "null",
    "isnull", "nvl", "distinct", "rownum", "asc", "desc", "add", "modify",
];

// ───────────────────────── 词法：去注释 / 抽字符串 / 切词 ─────────────────────────

/// 去掉 Java 注释，**保留行号与字符串字面量**。
///
/// 注释内容替换成空格、换行原样留着，这样后面算出来的行号与源文件一致。
/// 字符串里的 `//` 不当注释（`"http://..."` 在 NC 代码里不少）。
fn strip_comments(src: &str) -> String {
    let b = src.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        // 字符串 / 字符字面量：原样搬，只处理转义
        if c == b'"' || c == b'\'' {
            out.push(c);
            i += 1;
            while i < b.len() {
                if b[i] == b'\\' && i + 1 < b.len() {
                    out.push(b[i]);
                    out.push(b[i + 1]);
                    i += 2;
                    continue;
                }
                out.push(b[i]);
                let done = b[i] == c;
                i += 1;
                if done {
                    break;
                }
            }
            continue;
        }
        if c == b'/' && i + 1 < b.len() && b[i + 1] == b'/' {
            while i < b.len() && b[i] != b'\n' {
                out.push(b' ');
                i += 1;
            }
            continue;
        }
        if c == b'/' && i + 1 < b.len() && b[i + 1] == b'*' {
            out.push(b' ');
            out.push(b' ');
            i += 2;
            while i < b.len() {
                if b[i] == b'*' && i + 1 < b.len() && b[i + 1] == b'/' {
                    out.push(b' ');
                    out.push(b' ');
                    i += 2;
                    break;
                }
                out.push(if b[i] == b'\n' { b'\n' } else { b' ' });
                i += 1;
            }
            continue;
        }
        out.push(c);
        i += 1;
    }
    // 只替换过 ASCII 字节，多字节序列保持完整；中文注释已被换成空格，不会破坏 UTF-8 边界
    String::from_utf8_lossy(&out).into_owned()
}

/// 按出现顺序把字符串常量的正文拼成一条长文本，同时记下「拼接偏移 → 源文件行号」。
///
/// 段与段之间补一个空格：`"from "` + `"bd_x"` 与 `"from"` + `"bd_x"` 都要能拼出 `from bd_x`。
fn concat_strings(src: &str) -> (String, Vec<(usize, usize)>) {
    let mut joined = String::new();
    let mut marks: Vec<(usize, usize)> = Vec::new();
    let mut line = 1usize;
    let mut in_str = false;
    let mut escaped = false;

    for ch in src.chars() {
        if ch == '\n' {
            line += 1;
        }
        if !in_str {
            if ch == '"' {
                in_str = true;
                escaped = false;
                if !joined.is_empty() && !joined.ends_with(' ') {
                    joined.push(' ');
                }
                marks.push((joined.len(), line));
            }
            continue;
        }
        if escaped {
            match ch {
                // SQL 里换行与制表符只当空白
                'n' | 't' | 'r' => joined.push(' '),
                '"' | '\'' | '\\' => joined.push(ch),
                other => joined.push(other),
            }
            escaped = false;
            continue;
        }
        match ch {
            '\\' => escaped = true,
            '"' => in_str = false,
            _ => joined.push(ch),
        }
    }
    (joined, marks)
}

/// 二分找 `at` 落在哪一段字符串里，返回那一行。
fn line_at(marks: &[(usize, usize)], at: usize) -> usize {
    match marks.binary_search_by(|m| m.0.cmp(&at)) {
        Ok(i) => marks[i].1,
        Err(0) => marks.first().map(|m| m.1).unwrap_or(1),
        Err(i) => marks[i - 1].1,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Ident,
    Num,
    Punct,
}

struct Tok {
    text: String,
    lower: String,
    kind: Kind,
    at: usize,
}

fn is_ident_start(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_' || c == '$' || c == '#'
}

fn is_ident_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '$' || c == '#'
}

fn tokenize(s: &str) -> Vec<Tok> {
    let mut out = Vec::new();
    let mut it = s.char_indices().peekable();
    while let Some((i, c)) = it.next() {
        if c.is_whitespace() {
            continue;
        }
        if is_ident_start(c) {
            let mut end = i + c.len_utf8();
            while let Some(&(j, c2)) = it.peek() {
                if is_ident_char(c2) {
                    end = j + c2.len_utf8();
                    it.next();
                } else {
                    break;
                }
            }
            let text = s[i..end].to_string();
            out.push(Tok {
                lower: text.to_lowercase(),
                text,
                kind: Kind::Ident,
                at: i,
            });
            continue;
        }
        if c.is_ascii_digit() {
            let mut end = i + 1;
            while let Some(&(j, c2)) = it.peek() {
                if c2.is_ascii_digit() || c2 == '.' {
                    end = j + 1;
                    it.next();
                } else {
                    break;
                }
            }
            out.push(Tok {
                text: s[i..end].to_string(),
                lower: s[i..end].to_string(),
                kind: Kind::Num,
                at: i,
            });
            continue;
        }
        out.push(Tok {
            text: c.to_string(),
            lower: c.to_string(),
            kind: Kind::Punct,
            at: i,
        });
    }
    out
}

// ───────────────────────── 核对 ─────────────────────────

/// 一张表在库里的样子。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TableShape {
    pub kind: String,
    /// 列名（小写）→ 带长度的类型名，如 `VARCHAR2(40)`。长度只作展示，不参与判定。
    pub columns: BTreeMap<String, String>,
}

/// 表结构索引：小写表名 → 形状。
#[derive(Debug, Clone, Default)]
pub struct SchemaIndex {
    pub tables: BTreeMap<String, TableShape>,
}

impl SchemaIndex {
    pub fn table_names(&self) -> Vec<String> {
        self.tables.keys().cloned().collect()
    }

    /// 某张表的全部列名（小写），没有这张表返回空。
    pub fn columns_of(&self, table: &str) -> Vec<String> {
        self.tables
            .get(&table.to_lowercase())
            .map(|s| s.columns.keys().cloned().collect())
            .unwrap_or_default()
    }

    /// 别名解析成候选表：别名表里查得到就用别名，否则把 qualifier 本身当表名。
    fn candidates(&self, refs: &FileRefs, qualifier: &str) -> Vec<String> {
        let q = qualifier.to_lowercase();
        if let Some(list) = refs.aliases.get(&q) {
            return list.clone();
        }
        if self.tables.contains_key(&q) {
            return vec![q];
        }
        Vec::new()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IssueKind {
    /// 表不存在。
    MissingTable,
    /// 表存在，但这个列在它（及别名可能指的其它表）里都没有。
    MissingColumn,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TableIssue {
    pub kind: IssueKind,
    pub table: String,
    pub column: Option<String>,
    /// 源文件路径（调用方给的，这里只透传）。
    pub file: String,
    pub line: usize,
    /// 库里名字相近的表，给用户判断是「拼错」还是「这个库根本没有这张表」。
    pub suggestions: Vec<String>,
}

/// 一个文件里「表/字段对不上」的问题清单。
///
/// 判定刻意从严：只有在**所有**可能归属的表里都找不到这个列时才报（别名冲突时会
/// 有多个候选表）。宁可漏报也不误报——一次误报就会让人不再看这个功能。
pub fn check_file(file: &str, refs: &FileRefs, schema: &SchemaIndex) -> Vec<TableIssue> {
    let mut out = Vec::new();
    for t in &refs.tables {
        if !schema.tables.contains_key(&t.name.to_lowercase()) {
            out.push(TableIssue {
                kind: IssueKind::MissingTable,
                table: t.name.clone(),
                column: None,
                file: file.to_string(),
                line: t.line,
                suggestions: similar_tables(&t.name, &schema.table_names(), 3),
            });
        }
    }
    for c in &refs.columns {
        let cands = schema.candidates(refs, &c.qualifier);
        if cands.is_empty() {
            // qualifier 既不是别名也不是表名：多半是 Java 对象字段访问（`this.pk_org`、
            // `vo.def1`），与数据库无关，不报。
            continue;
        }
        let col = c.column.to_lowercase();
        let hit = cands
            .iter()
            .any(|t| schema.tables.get(t).is_some_and(|s| s.columns.contains_key(&col)));
        if hit {
            continue;
        }
        out.push(TableIssue {
            kind: IssueKind::MissingColumn,
            table: cands.first().cloned().unwrap_or_default(),
            column: Some(c.column.clone()),
            file: file.to_string(),
            line: c.line,
            suggestions: Vec::new(),
        });
    }
    out
}

/// 名字相近的表：前缀/包含关系，按相近程度排。够用即可，不做编辑距离。
pub fn similar_tables(given: &str, known: &[String], limit: usize) -> Vec<String> {
    let g = given.to_lowercase();
    let mut scored: Vec<(i32, String)> = Vec::new();
    for k in known {
        let score = if k == &g {
            continue;
        } else if k.starts_with(&g) {
            100 - (k.len() as i32 - g.len() as i32)
        } else if g.starts_with(k.as_str()) {
            90 - (g.len() as i32 - k.len() as i32)
        } else if k.contains(&g) || g.contains(k.as_str()) {
            50
        } else {
            0
        };
        if score > 0 {
            scored.push((score, k.clone()));
        }
    }
    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    scored.into_iter().take(limit).map(|x| x.1).collect()
}

// ───────────────────────── 测试 ─────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn shape(cols: &[(&str, &str)]) -> TableShape {
        TableShape {
            kind: "TABLE".into(),
            columns: cols
                .iter()
                .map(|(n, t)| (n.to_lowercase(), t.to_string()))
                .collect(),
        }
    }

    fn idx(pairs: &[(&str, &[(&str, &str)])]) -> SchemaIndex {
        SchemaIndex {
            tables: pairs
                .iter()
                .map(|(n, c)| (n.to_lowercase(), shape(c)))
                .collect(),
        }
    }

    #[test]
    fn 单段字符串里的_from_能抽出来() {
        let src = r#"String sql = " select asset_code from fa_card where dr=0";"#;
        let r = parse(src);
        assert_eq!(r.tables.len(), 1);
        assert_eq!(r.tables[0].name, "fa_card");
        assert_eq!(r.tables[0].line, 1);
    }

    #[test]
    fn 拼接断开的表名能接上() {
        // `"from "` 换行 `+ "bd_material where"`：拼接后必须是 from bd_material
        let src = "sb.append(\"select pk from \"\n  + \"bd_material where dr=0\");";
        let r = parse(src);
        assert_eq!(r.tables[0].name, "bd_material");
    }

    #[test]
    fn 表名紧跟关键字不带空格也能接上() {
        let src = "String s = \"select * from\" + \" pam_equip where 1=1\";";
        let r = parse(src);
        assert!(r.tables.iter().any(|t| t.name == "pam_equip"));
    }

    #[test]
    fn 子查询里的表也算() {
        let src = r#"w.append(" pk in (select pk_status from pam_status where t=1) ");"#;
        let r = parse(src);
        assert!(r.tables.iter().any(|t| t.name == "pam_status"));
    }

    #[test]
    fn 三个关键字都认() {
        let src = r#"
            String a = "delete from bd_psndoc where 1=1";
            String b = "insert into org_dept(code) values(1)";
            String c = "update bd_supplier set name='x'";
        "#;
        let r = parse(src);
        let names: Vec<&str> = r.tables.iter().map(|t| t.name.as_str()).collect();
        assert!(names.contains(&"bd_psndoc"));
        assert!(names.contains(&"org_dept"));
        assert!(names.contains(&"bd_supplier"));
    }

    #[test]
    fn dual_与_join_关键字不当表名() {
        let src = r#"String a = "select 1 from dual"; String b = "left join org_orgs a on 1=1";"#;
        let r = parse(src);
        let names: Vec<&str> = r.tables.iter().map(|t| t.name.as_str()).collect();
        assert!(!names.contains(&"dual"));
        assert!(names.contains(&"org_orgs"));
    }

    #[test]
    fn 注释掉的_sql_不算() {
        let src = r#"
            // String a = "select * from bd_dead_table";
            /* String b = "select * from another_dead"; */
            String c = "select * from real_table_x";
        "#;
        let r = parse(src);
        let names: Vec<&str> = r.tables.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, vec!["real_table_x"]);
    }

    #[test]
    fn 字符串里的双斜线不当注释() {
        let src = r#"String u = "http://x/y from fake_table"; String v = "select * from real_one";"#;
        let r = parse(src);
        let names: Vec<&str> = r.tables.iter().map(|t| t.name.as_str()).collect();
        assert!(names.contains(&"real_one"));
        // `from fake_table` 在字符串里，确实是一条会被扫到的引用——它是 URL 的一部分，
        // 属于误报。核对阶段 `fake_table` 在库里不存在，会报「表不存在」。
        // 这里只确认没因为 `//` 把整行当注释吞掉。
        assert!(names.contains(&"fake_table"));
    }

    #[test]
    fn 别名能对上表名() {
        let src = r#"String a = "select t.jobguid from bi_schd_taskqueue t where 1=1";"#;
        let r = parse(src);
        assert_eq!(r.aliases.get("t").unwrap(), &vec!["bi_schd_taskqueue".to_string()]);
    }

    #[test]
    fn as_别名() {
        let src = r#"String a = "select x.code from bd_material as x";"#;
        let r = parse(src);
        assert_eq!(r.aliases.get("x").unwrap(), &vec!["bd_material".to_string()]);
    }

    #[test]
    fn where_不会被当成别名() {
        let src = r#"String a = "select * from bd_material where dr=0";"#;
        let r = parse(src);
        assert!(r.aliases.is_empty());
    }

    #[test]
    fn 字段引用抽的是别名加列() {
        let src = r#"String a = "select t.jobguid, t.runstate from bi_schd_taskqueue t";"#;
        let r = parse(src);
        let cols: Vec<(&str, &str)> = r
            .columns
            .iter()
            .map(|c| (c.qualifier.as_str(), c.column.as_str()))
            .collect();
        assert!(cols.contains(&("t", "jobguid")));
        assert!(cols.contains(&("t", "runstate")));
    }

    #[test]
    fn 表不存在会报并给相近名() {
        let s = idx(&[
            ("bd_material", &[("pk_material", "CHAR(20)")]),
            ("bd_materialstock", &[("pk_material", "CHAR(20)")]),
        ]);
        let src = r#"String a = "select * from bd_materia where 1=1";"#;
        let issues = check_file("A.java", &parse(src), &s);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].kind, IssueKind::MissingTable);
        assert!(issues[0].suggestions.contains(&"bd_material".to_string()));
    }

    #[test]
    fn 字段不存在会报() {
        let s = idx(&[("fa_card", &[("pk_card", "CHAR(20)"), ("asset_code", "VARCHAR2(40)")])]);
        let src = r#"String a = "select asset_code, asset_nmae from fa_card";"#;
        let issues = check_file("A.java", &parse(src), &s);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].kind, IssueKind::MissingColumn);
        assert_eq!(issues[0].column.as_deref(), Some("asset_nmae"));
    }

    #[test]
    fn 别名解析后字段能对上就不报() {
        let s = idx(&[("pam_equip", &[("pk_used_status", "CHAR(20)"), ("dr", "NUMBER")])]);
        let src = r#"String a = "select e.pk_used_status from pam_equip e where e.dr=0";"#;
        assert!(check_file("A.java", &parse(src), &s).is_empty());
    }

    #[test]
    fn java_对象字段访问不报() {
        // this.pk_org / vo.def1 的 qualifier 既不是别名也不是表名，必须全部忽略
        let s = idx(&[("fa_card", &[("pk_card", "CHAR(20)")])]);
        let src = r#"
            this.pk_org = vo.def1;
            String a = "select pk_card from fa_card";
        "#;
        assert!(check_file("A.java", &parse(src), &s).is_empty());
    }

    #[test]
    fn 别名冲突时只要有一张表有这个列就不报() {
        // 同一个别名 t 在文件里指了两张表，列只在其中一张里有 → 不报
        let s = idx(&[
            ("bi_schd_jobqueue", &[("guid", "CHAR(20)")]),
            ("bi_schd_taskqueue", &[("jobguid", "CHAR(20)")]),
        ]);
        let src = r#"
            String a = "select t.jobguid from bi_schd_taskqueue t";
            String b = "select t.guid from bi_schd_jobqueue t";
        "#;
        let issues = check_file("A.java", &parse(src), &s);
        assert!(issues.is_empty(), "两个列都在各自的表里，不该报：{issues:?}");
    }

    #[test]
    fn 行号指向字符串所在行() {
        let src = "class A {\n  void f() {\n    String s = \"select * from gone_table\";\n  }\n}\n";
        let r = parse(src);
        assert_eq!(r.tables[0].line, 3);
    }

    #[test]
    fn 中文不影响行号() {
        let src = "// 中文注释\n\nString s = \"select * from bd_zh_table\";\n";
        let r = parse(src);
        assert_eq!(r.tables[0].line, 3);
        assert_eq!(r.tables[0].name, "bd_zh_table");
    }

    #[test]
    fn 全大写常量不当表名() {
        let src = r#"String a = "select * from PK_ORG where 1=1";"#;
        let r = parse(src);
        assert!(r.tables.is_empty());
    }
}
