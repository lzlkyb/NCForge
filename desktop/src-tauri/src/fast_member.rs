//! 成员级跳转：`vo.getCode()` → `DeliveryVO.java:88`，`this.billType` → 字段行。
//!
//! 为什么单独一层：类型级（`fast_definition`）只回答「这个类在哪」，而 NC 二开时
//! 用户点下去的多数是**成员** —— `vo.getCode()`、`this.billType`、局部变量 `vo`。
//! jdt.ls 就绪后这些由 binding 精确解析；窗口期只能靠这里的启发式。
//!
//! 判据从确定到猜测：
//! 1. `接收者.成员`，接收者是**类型名** → import/同包/通配/兜底消歧出全限定名，查其成员
//! 2. `变量.成员` → 在当前方法里找 `Type 变量` 的声明，得到类型后再查
//! 3. 裸词 → 先找当前方法的局部变量/参数声明，再找当前类型的成员
//!
//! 刻意**不做**的两件事：
//! - **父类/接口的成员**：索引没存 `extends`，查不到就返回空，让前端退回内容搜索。
//!   猜一个父类去跳，落到错地方的代价比跳不到大得多。
//! - **泛型实参推断**：`List<Foo> xs; xs.get(0)` 里的 `get` 不追（`xs` 的类型是 `List`）。
//!
//! 返回 `Some(目标)` 表示「这条我接了」，`None` 表示「没答上，交给类型级」。
//!
//! 🔴 只有**非空**时才返回 `Some`。第一版不是这样：限定访问一律认领、答不上也返回
//! `Some(空)`，结果 `import com.x.y.Itf;` 里的 `Itf` 被当成「`y.Itf` 成员访问」而
//! 彻底不回退 —— 类型级本来一猜就中的全限定名引用反而跳不走了。
//! 代价是成员没命中时会多跑一次类型级（微秒级），换的是「漏跳」变成「多查一次」。

use std::path::Path;

use crate::decl_index::{Decl, DeclIndex};
use crate::fast_definition::{self, Target};

/// 方法体里往上找局部变量声明的最大行数。够覆盖 NC 里几百行的大方法，
/// 又不至于扫整个文件（那是几十毫秒，而每次悬停都要跑一次）。
const SEARCH_LINES: usize = 400;

/// 原始类型。它们不是「类型名」，但确实出现在声明位置（`int i = 0`）。
const PRIMITIVES: [&str; 8] = [
    "int", "long", "short", "byte", "char", "boolean", "float", "double",
];

/// 长得像类型但不是类型的词。少一个就会被 `return x;` / `new X()` 骗过去。
const NOT_A_TYPE: [&str; 13] = [
    "return",
    "new",
    "throw",
    "case",
    "else",
    "this",
    "super",
    "null",
    "true",
    "false",
    "package",
    "import",
    "instanceof",
];

/// 解析一次跳转。`None` = 不归本模块管。
///
/// `cur_module` 只用于「同模块优先」排序，拿不到传空串。
pub fn resolve(
    src: &str,
    offset: usize,
    idx: &DeclIndex,
    file: &Path,
    cur_module: &str,
) -> Option<Vec<Target>> {
    let (w_start, _, word) = fast_definition::word_at(src, offset)?;
    // 单字符多半是循环变量 `i`、泛型 `T`，查了也是噪音；`$` 开头是合成的访问器
    if word.len() < 2 || word.starts_with('$') {
        return None;
    }
    let head = src.get(..w_start)?;
    // 紧跟 `.` ⇒ 限定访问。取不到接收者（`foo().bar()`）时不认领，
    // 让类型级按全限定名再猜一次（`a.b.C` 与 import 语句都长这样）。
    if head.trim_end().ends_with('.') {
        let q = qualifier_before(head);
        return q.and_then(|q| non_empty(qualified(src, w_start, q, word, idx, cur_module)));
    }
    // 裸的大写词是类型名，交给类型级（那边有完整的 import 消歧）
    if type_like(word) {
        return None;
    }
    non_empty(unqualified(src, w_start, word, idx, file))
}

/// 空结果一律降级成 `None`：交回类型级总比「明明还有一条路却不肯走」好。
fn non_empty(v: Vec<Target>) -> Option<Vec<Target>> {
    (!v.is_empty()).then_some(v)
}

/// 限定访问：`q.word`。接收者先定类型，再在类型里找成员。
fn qualified(
    src: &str,
    at: usize,
    q: &str,
    word: &str,
    idx: &DeclIndex,
    cur_module: &str,
) -> Vec<Target> {
    let cursor_line = line_of(src, at);
    let Some(decl) = type_of_qualifier(src, q, cursor_line, idx, cur_module) else {
        return Vec::new();
    };
    members_of(decl, word)
}

/// 接收者标识符 → 它所属的类型声明。
fn type_of_qualifier<'a>(
    src: &str,
    q: &str,
    cursor_line: u32,
    idx: &'a DeclIndex,
    cur_module: &str,
) -> Option<&'a Decl> {
    // `this.x`：当前类型（含嵌套时是最内层那个）
    if q == "this" {
        return enclosing_decl(src, cursor_line, idx);
    }
    // `super.x` 落在父类，索引没有继承信息 —— 只能放弃
    if q == "super" {
        return None;
    }
    if type_like(q) {
        let fq = fq_of_simple(src, q, idx, cur_module)?;
        return idx.find(&fq).or_else(|| idx.by_simple(q).next());
    }
    // 变量：先找它的声明类型
    let ty = declared_type_of(src, q, cursor_line)?;
    let fq = fq_of_simple(src, &ty, idx, cur_module);
    match fq {
        Some(fq) => idx.find(&fq).or_else(|| idx.by_simple(&ty).next()),
        None => idx.by_simple(&ty).next(),
    }
}

/// 裸词（`getCode()`、`count`、`vo`）：先局部变量，再当前类型的成员。
fn unqualified(src: &str, at: usize, word: &str, idx: &DeclIndex, file: &Path) -> Vec<Target> {
    let cursor_line = line_of(src, at);
    // 1. 局部变量 / 参数：跳到本文件里的声明行。
    //    与光标同一行的声明（`DeliveryVO vo = f(); vo.getCode();`）不算 —— 跳回本行没意义。
    if let Some(line) = local_decl_line(src, word, cursor_line) {
        if line != cursor_line {
            return vec![Target {
                // `#` 前缀标记「成员/局部」目标，`fast_decl` 据此走成员行号校正
                name: format!("#{word}"),
                path: file.to_string_lossy().into_owned(),
                line,
                character: 0,
                from_jar: false,
            }];
        }
    }
    // 2. 当前类型的字段 / 方法
    match enclosing_decl(src, cursor_line, idx) {
        Some(d) => members_of(d, word),
        None => Vec::new(),
    }
}

/// 在类型里找同名方法或字段，命中就产出目标（两者都命中时都给，前端会弹一个小列表）。
fn members_of(d: &Decl, word: &str) -> Vec<Target> {
    let mut out = Vec::new();
    for line in [d.method_line(word), d.field_line(word)]
        .into_iter()
        .flatten()
    {
        out.push(Target {
            // `类型#成员`：README 里约定的记号，`fast_decl::definition` 按 `#` 分流
            name: format!("{}#{word}", d.name),
            path: d.path.clone(),
            line: line as u32,
            character: 0,
            from_jar: d.from_jar,
        });
    }
    out
}

// ---- 名字消歧 -----------------------------------------------------------

/// 简单名 → 全限定名。与 `fast_definition::resolve` 同一套优先级，
/// 区别只是这里没有「光标位置」可用（类型名是从声明里推出来的）。
fn fq_of_simple(src: &str, simple: &str, idx: &DeclIndex, cur_module: &str) -> Option<String> {
    let imports = crate::compile::extract_imports(src);
    for (imp, wildcard) in &imports {
        if !*wildcard && imp.rsplit('.').next() == Some(simple) && idx.find(imp).is_some() {
            return Some(imp.clone());
        }
    }
    if let Some(p) = fast_definition::package_of(src) {
        let fq = format!("{p}.{simple}");
        if idx.find(&fq).is_some() {
            return Some(fq);
        }
    }
    for (imp, wildcard) in &imports {
        if *wildcard {
            let fq = format!("{imp}.{simple}");
            if idx.find(&fq).is_some() {
                return Some(fq);
            }
        }
    }
    let needle = if cur_module.is_empty() {
        String::new()
    } else {
        format!("\\{}\\", cur_module.to_ascii_lowercase())
    };
    let mut cands: Vec<&Decl> = idx.by_simple(simple).collect();
    cands.sort_by(|a, b| fast_definition::rank(a, &needle).cmp(&fast_definition::rank(b, &needle)));
    cands.first().map(|d| d.name.clone())
}

/// 光标所在的类型声明。嵌套类按 `Outer$Inner` 逐级尝试。
fn enclosing_decl<'a>(src: &str, cursor_line: u32, idx: &'a DeclIndex) -> Option<&'a Decl> {
    let names = enclosing_types(src, cursor_line);
    let pkg = fast_definition::package_of(src).unwrap_or("");
    // 由外到内拼：先试最长的 `Outer$Inner`，退到 `Outer`
    for k in (1..=names.len()).rev() {
        let chain = names[..k].join("$");
        let fq = if pkg.is_empty() {
            chain
        } else {
            format!("{pkg}.{chain}")
        };
        if let Some(d) = idx.find(&fq) {
            return Some(d);
        }
    }
    names.last().and_then(|n| idx.by_simple(n).next())
}

/// 从光标往上收集类型声明，返回**由外到内**。
///
/// 用缩进区分「外层」与「同级」：第一个命中的是内层，之后只收缩进严格更小的。
/// 少了这条，同一文件里的 `class A {}` `class B {}` 会拼成 `A$B`（不存在）。
fn enclosing_types(src: &str, cursor_line: u32) -> Vec<String> {
    let mut inner_first: Vec<(String, usize)> = Vec::new();
    let mut limit = usize::MAX;
    let lines: Vec<&str> = src.split('\n').collect();
    let cur = (cursor_line as usize).min(lines.len());
    for l in lines[..cur].iter().rev() {
        if let Some((name, ind)) = type_decl_in(l) {
            if inner_first.is_empty() || ind < limit {
                limit = ind;
                inner_first.push((name, ind));
            }
        }
    }
    inner_first.reverse();
    inner_first.into_iter().map(|(n, _)| n).collect()
}

/// 一行里的类型声明：返回（简单名，缩进）。
fn type_decl_in(l: &str) -> Option<(String, usize)> {
    let t = l.trim_start();
    if t.starts_with("//")
        || t.starts_with('*')
        || t.starts_with("import ")
        || t.starts_with("package ")
    {
        return None;
    }
    let indent = l.len() - t.len();
    for kw in ["@interface ", "class ", "interface ", "enum "] {
        let rest = match t.strip_prefix(kw) {
            Some(r) => r,
            None => match t.find(&format!(" {kw}")) {
                // `public final class Foo`：关键字前面至少有空白
                Some(p) => &t[p + 1 + kw.len()..],
                None => continue,
            },
        };
        let name: String = rest
            .chars()
            .take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '$')
            .collect();
        if !name.is_empty() && name.chars().next().is_some_and(|c| c.is_alphabetic()) {
            return Some((name, indent));
        }
    }
    None
}

// ---- 变量声明推断 -------------------------------------------------------

/// 在光标所在方法里往上找 `name` 的声明，返回声明类型（简单名）。
fn declared_type_of(src: &str, name: &str, cursor_line: u32) -> Option<String> {
    let lines: Vec<&str> = src.split('\n').collect();
    let cur = (cursor_line as usize).min(lines.len());
    let start = cur.saturating_sub(SEARCH_LINES);
    for l in lines[start..cur].iter().rev() {
        if method_closed(l) {
            break;
        }
        if let Some(t) = declared_type_in(l, name) {
            return Some(t);
        }
    }
    None
}

/// `name` 在当前方法的声明行（1 基）。声明在光标同一行时也返回。
/// `commands::lang_binding_cmds` 的 local 目标复用同一套启发式（binding 只给名字，
/// 声明行照旧要在这里找）。
pub(crate) fn local_decl_line(src: &str, name: &str, cursor_line: u32) -> Option<u32> {
    let lines: Vec<&str> = src.split('\n').collect();
    let cur = (cursor_line as usize).min(lines.len());
    let start = cur.saturating_sub(SEARCH_LINES);
    for i in (start..cur).rev() {
        if method_closed(lines[i]) {
            break;
        }
        if declared_type_in(lines[i], name).is_some() {
            return Some(i as u32 + 1);
        }
    }
    None
}

/// 方法体结束：缩进 ≤ 4 的 `}`。再往上是别的方法，同名局部变量不该再认。
fn method_closed(l: &str) -> bool {
    let ind = l.len() - l.trim_start().len();
    l.trim_start().starts_with('}') && ind <= 4
}

/// 这一行是不是 `Type name` 形式的声明，是就返回类型简单名。
fn declared_type_in(l: &str, name: &str) -> Option<String> {
    let mut from = 0usize;
    while let Some(p) = l[from..].find(name) {
        let s = from + p;
        let e = s + name.len();
        from = e;
        if !word_bounds(l, s, e) {
            continue;
        }
        // `name` 后面必须是分隔符：`=`（初始化）、`;`（无初值）、`,`（多变量）、
        // `)`/`:`（参数、foreach）。是 `.` 就是成员访问，是 `(` 就是方法调用。
        let after = l[e..].trim_start();
        let ok = after.is_empty()
            || after.starts_with('=')
            || after.starts_with(';')
            || after.starts_with(',')
            || after.starts_with(')')
            || after.starts_with(':');
        if !ok {
            continue;
        }
        if let Some(t) = type_before(l, s) {
            return Some(t.rsplit('.').next().unwrap_or(t).to_string());
        }
    }
    None
}

/// `name` 前面那个类型词（`DeliveryVO vo` → `DeliveryVO`，`List<Foo> xs` → `List`）。
fn type_before(l: &str, s: usize) -> Option<&str> {
    let mut head = l[..s].trim_end();
    // 数组后缀 `Foo[] x`
    while head.ends_with(']') {
        head = head[..head.rfind('[')?].trim_end();
    }
    // 泛型实参 `Map<K,V> m`
    if head.ends_with('>') {
        head = strip_generic(head);
    }
    let b = head.as_bytes();
    let mut start = head.len();
    while start > 0 && (is_ident(b[start - 1]) || b[start - 1] == b'.') {
        start -= 1;
    }
    let tok = &head[start..];
    if tok.is_empty() {
        return None;
    }
    let simple = tok.rsplit('.').next().unwrap_or(tok);
    type_like(simple).then_some(tok)
}

/// 去掉结尾的泛型实参，兼容嵌套 `Map<String,List<Foo>>`。
fn strip_generic(h: &str) -> &str {
    let b = h.as_bytes();
    let mut depth = 0i32;
    for i in (0..b.len()).rev() {
        match b[i] {
            b'>' => depth += 1,
            b'<' => {
                depth -= 1;
                if depth == 0 {
                    return h[..i].trim_end();
                }
            }
            _ => {}
        }
    }
    h
}

// ---- 小工具 -------------------------------------------------------------

/// 去掉光标前的 `.` 后取标识符。`a.b.C.` → `C`。
fn qualifier_before(head: &str) -> Option<&str> {
    let t = head.trim_end().strip_suffix('.')?.trim_end();
    let b = t.as_bytes();
    let mut i = t.len();
    while i > 0 && is_ident(b[i - 1]) {
        i -= 1;
    }
    (i < t.len()).then(|| &t[i..])
}

fn line_of(src: &str, offset: usize) -> u32 {
    let end = offset.min(src.len());
    src.as_bytes()[..end]
        .iter()
        .filter(|b| **b == b'\n')
        .count() as u32
        + 1
}

fn word_bounds(l: &str, s: usize, e: usize) -> bool {
    let b = l.as_bytes();
    (s == 0 || !is_ident(b[s - 1])) && (e >= b.len() || !is_ident(b[e]))
}

fn is_ident(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_' || c == b'$'
}

/// 长得像类型名吗？Java 约定类型首字母大写，原始类型单独列。
fn type_like(w: &str) -> bool {
    if PRIMITIVES.contains(&w) {
        return true;
    }
    if NOT_A_TYPE.contains(&w) {
        return false;
    }
    w.chars().next().is_some_and(|c| c.is_ascii_uppercase())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decl_index::from_decls;
    use crate::decl_index::Member;

    fn decl(
        name: &str,
        path: &str,
        line: i32,
        methods: &[(&str, i32)],
        fields: &[(&str, i32)],
    ) -> Decl {
        Decl {
            name: name.to_string(),
            kind: 1,
            from_jar: path.ends_with(".jar"),
            path: path.to_string(),
            line,
            methods: methods
                .iter()
                .map(|(n, l)| Member {
                    name: n.to_string(),
                    line: *l,
                })
                .collect(),
            fields: fields
                .iter()
                .map(|(n, l)| Member {
                    name: n.to_string(),
                    line: *l,
                })
                .collect(),
        }
    }

    fn fixture() -> DeclIndex {
        from_decls(vec![
            decl(
                "nc.vo.so.DeliveryVO",
                "C:\\ws\\so\\src\\private\\nc\\vo\\so\\DeliveryVO.java",
                12,
                &[("getCode()", 88), ("setCode(String)", 92), ("build()", 100)],
                &[("code", 30), ("name", 32)],
            ),
            decl(
                "com.lib.Helper",
                "D:\\ncc\\lib\\common.jar",
                0,
                &[("run()", 0)],
                &[],
            ),
        ])
    }

    fn file() -> &'static Path {
        Path::new("C:\\ws\\so\\src\\private\\nc\\vo\\so\\Bill.java")
    }

    #[test]
    fn 变量点方法跳到声明行() {
        let idx = fixture();
        let src = "package nc.vo.so;\nclass A {\n  void f() {\n    DeliveryVO vo = new DeliveryVO();\n    vo.getCode();\n  }\n}\n";
        let off = src.find("getCode").unwrap();
        let t = resolve(src, off, &idx, file(), "so").expect("限定访问应认领");
        assert_eq!(t.len(), 1, "{t:?}");
        assert_eq!(t[0].line, 88);
        assert_eq!(
            t[0].path,
            "C:\\ws\\so\\src\\private\\nc\\vo\\so\\DeliveryVO.java"
        );
        assert_eq!(t[0].name, "nc.vo.so.DeliveryVO#getCode");
        assert!(!t[0].from_jar);
    }

    #[test]
    fn 字段也能跳且与方法同名时都给() {
        let idx = fixture();
        let src = "package nc.vo.so;\nclass A {\n  void f(DeliveryVO d) {\n    d.code.length();\n  }\n}\n";
        let off = src.find("code.length").unwrap();
        let t = resolve(src, off, &idx, file(), "so").expect("应认领");
        assert_eq!(t.len(), 1, "{t:?}");
        assert_eq!(t[0].line, 30);
    }

    #[test]
    fn 静态调用按类型名查成员() {
        let idx = fixture();
        let src = "package nc.vo.so;\nclass A {\n  void f() {\n    DeliveryVO.build();\n  }\n}\n";
        let off = src.find("build").unwrap();
        let t = resolve(src, off, &idx, file(), "so").expect("应认领");
        assert_eq!(t.len(), 1, "{t:?}");
        assert_eq!(t[0].line, 100);
    }

    #[test]
    fn this点字段走当前类型() {
        let idx = fixture();
        let src = "package nc.vo.so;\nclass DeliveryVO {\n  private String code;\n  void f() {\n    this.code = null;\n  }\n}\n";
        let off = src.find("code = null").unwrap();
        let t = resolve(src, off, &idx, file(), "so").expect("应认领");
        assert_eq!(t.len(), 1, "{t:?}");
        assert_eq!(t[0].line, 30, "跳到索引里的字段声明行");
    }

    #[test]
    fn 裸局部变量跳到本文件声明() {
        let idx = fixture();
        let src = "package nc.vo.so;\nclass A {\n  void f() {\n    DeliveryVO vo = new DeliveryVO();\n    use(vo);\n  }\n}\n";
        let off = src.find("use(vo)").unwrap() + 4;
        let t = resolve(src, off, &idx, file(), "so").expect("应认领");
        assert_eq!(t.len(), 1, "{t:?}");
        assert_eq!(t[0].line, 4, "跳到 `DeliveryVO vo` 那一行");
        assert_eq!(t[0].path, file().to_string_lossy());
        assert_eq!(t[0].name, "#vo");
    }

    #[test]
    fn 裸方法名走当前类型的成员() {
        let idx = fixture();
        let src = "package nc.vo.so;\nclass DeliveryVO {\n  void f() {\n    getCode();\n  }\n}\n";
        let off = src.find("getCode").unwrap();
        let t = resolve(src, off, &idx, file(), "so").expect("应认领");
        assert_eq!(t.len(), 1, "{t:?}");
        assert_eq!(t[0].line, 88);
    }

    #[test]
    fn 大写裸词不归我管() {
        let idx = fixture();
        let src = "package nc.vo.so;\nclass A { DeliveryVO v; }\n";
        let off = src.find("DeliveryVO v").unwrap();
        assert!(
            resolve(src, off, &idx, file(), "so").is_none(),
            "类型名要交给 fast_definition"
        );
    }

    #[test]
    fn 链式调用不猜也不乱跳() {
        let idx = fixture();
        let src = "package nc.vo.so;\nclass A {\n  void f() {\n    buildVo().getCode();\n  }\n}\n";
        let off = src.find("getCode").unwrap();
        // 不认领（交回类型级），但也不能因为这一跳就跳到一个同名类上
        assert!(
            resolve(src, off, &idx, file(), "so").is_none_or(|t| t.is_empty()),
            "接收者是方法返回值，不猜"
        );
    }

    #[test]
    fn jar类型成员不返回_行号对不上源码() {
        let idx = fixture();
        let src = "package nc.vo.so;\nclass A {\n  void f(Helper h) {\n    h.run();\n  }\n}\n";
        let off = src.find("run").unwrap();
        assert!(
            resolve(src, off, &idx, file(), "so").is_none_or(|t| t.is_empty()),
            "jar 侧成员行号恒 0，跳过去也落不到点上"
        );
    }

    #[test]
    fn 无声明线索时交给类型级而不是乱跳() {
        let idx = fixture();
        let src = "package nc.vo.so;\nclass A {\n  void f() {\n    unknown.method();\n  }\n}\n";
        let off = src.find("method").unwrap();
        assert!(resolve(src, off, &idx, file(), "so").is_none_or(|t| t.is_empty()));
    }

    /// 🔴 回归：`import com.x.y.Itf;` 的 `Itf` 前面也是 `.`，
    /// 第一版把它当成「`y.Itf` 成员访问」并且**不认领就不回退**，全限定名引用全跳不了。
    #[test]
    fn import里的全限定名交回类型级() {
        let idx = fixture();
        let src = "package nc.vo.so;\nimport nc.vo.so.DeliveryVO;\nclass A {}\n";
        let off = src.find("DeliveryVO").unwrap();
        assert!(
            resolve(src, off, &idx, file(), "so").is_none(),
            "import 语句里的类名不是成员访问，必须交回类型级"
        );
    }

    /// 静态字段（`Type.CONSTANT`）要认领：qualifier 是类型名，成员路径能查。
    #[test]
    fn 静态字段按类型名认领() {
        let idx = from_decls(vec![decl(
            "p.Cfg",
            "C:\\ws\\m\\src\\private\\p\\Cfg.java",
            5,
            &[],
            &[("MAX", 9)],
        )]);
        let src = "package p;\nclass A {\n  void f() {\n    int n = Cfg.MAX;\n  }\n}\n";
        let off = src.find("MAX").unwrap();
        let t = resolve(
            src,
            off,
            &idx,
            Path::new("C:\\ws\\m\\src\\private\\p\\A.java"),
            "m",
        )
        .expect("静态字段应认领");
        assert_eq!(t.len(), 1, "{t:?}");
        assert_eq!(t[0].line, 9);
    }

    #[test]
    fn 类型推断认得出泛型数组与限定名() {
        assert_eq!(
            declared_type_of("  List<Foo> xs = null;", "xs", 1).unwrap(),
            "List"
        );
        assert_eq!(
            declared_type_of("  java.util.Map<String,List<Foo>> m;", "m", 1).unwrap(),
            "Map"
        );
        assert_eq!(
            declared_type_of("  DeliveryVO[] arr;", "arr", 1).unwrap(),
            "DeliveryVO"
        );
        assert_eq!(declared_type_of("  int i = 0;", "i", 1).unwrap(), "int");
        // 参数、foreach、catch 都要认
        assert_eq!(
            declared_type_of("void f(final DeliveryVO vo) {", "vo", 1).unwrap(),
            "DeliveryVO"
        );
        assert_eq!(
            declared_type_of("for (DeliveryVO v : list) {", "v", 1).unwrap(),
            "DeliveryVO"
        );
        // 不是声明：成员访问、方法调用、返回值
        assert!(declared_type_of("    vo.getCode();", "vo", 1).is_none());
        assert!(declared_type_of("    foo(vo);", "vo", 1).is_none());
        assert!(declared_type_of("    return vo;", "vo", 1).is_none());
    }

    #[test]
    fn 局部变量不跨方法误认() {
        let src = "class A {\n  void f() {\n    DeliveryVO vo = null;\n  }\n  void g() {\n    use(vo);\n  }\n}\n";
        let cur = src.lines().position(|l| l.contains("use(vo)")).unwrap() as u32 + 1;
        assert!(
            local_decl_line(src, "vo", cur).is_none(),
            "上一个方法的同名局部变量不该被认成声明"
        );
    }

    #[test]
    fn 嵌套类的接收者按_dollar_拼() {
        let idx = from_decls(vec![decl(
            "p.Outer$Inner",
            "C:\\ws\\m\\src\\private\\p\\Outer.java",
            20,
            &[("go()", 24)],
            &[],
        )]);
        let src = "package p;\nclass Outer {\n  static class Inner {\n    void f() {\n      this.go();\n    }\n  }\n}\n";
        let off = src.find("go()").unwrap();
        let t = resolve(
            src,
            off,
            &idx,
            Path::new("C:\\ws\\m\\src\\private\\p\\Outer.java"),
            "m",
        )
        .expect("应认领");
        assert_eq!(t.len(), 1, "{t:?}");
        assert_eq!(t[0].line, 24);
    }

    #[test]
    fn 取接收者只认紧邻的标识符() {
        assert_eq!(qualifier_before("vo."), Some("vo"));
        assert_eq!(qualifier_before("a.b.C."), Some("C"));
        assert_eq!(qualifier_before("this."), Some("this"));
        assert_eq!(
            qualifier_before(") ."),
            None,
            "方法返回值的 `.` 取不到接收者"
        );
    }
}
