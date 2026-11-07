//! Java 成员声明（方法 / 字段 / 构造器 / 枚举常量）的轻量解析。
//!
//! 只服务「工作区符号搜索」：把源码里的顶层成员摘出来，让快速面板不必等 jdt.ls
//! 建完索引也能按方法名 / 字段名搜。输入必须是
//! `build_state::strip_comments_and_literals` 之后的文本（注释已删、字符串已抹平），
//! 所以这里不需要再处理引号与注释，但仍要防住 `Foo.class`、`new Foo()` 这类
//! 带关键字/点号的样子货。
//!
//! 定位是**粗解析**：认方法签名、字段声明、枚举常量，不建 AST、不解析类型、
//! 不管局部变量（它们不在类型体第一层）。判错的代价是索引里多一条或少一条，
//! 不会影响编译与跳转。

/// 一条成员声明。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MemberDecl {
    pub name: String,
    /// LSP SymbolKind：6 方法 / 8 字段 / 9 构造器 / 14 常量 / 22 枚举成员
    pub kind: u8,
    /// 名字在 clean 文本里的字节偏移（用于算行列）。
    pub offset: usize,
    /// 所在类型的点号路径（嵌套类是 `Outer.Inner`）。
    pub container: String,
}

/// 单个文件最多记这么多成员。生成代码里的巨型类不值得把索引撑大，
/// 真要在那种类里找成员，jdt.ls 那条路仍在（面板会兜底）。
const MAX_PER_FILE: usize = 400;

/// 不是方法名的关键字：它们后面也会跟 `(`，但那是语句不是声明。
const NOT_METHOD: [&str; 12] = [
    "if",
    "for",
    "while",
    "switch",
    "catch",
    "return",
    "throw",
    "new",
    "assert",
    "synchronized",
    "super",
    "this",
];

/// 声明修饰符。出现在字段语句里要剥掉，避免被当成类型名。
const MODIFIERS: [&str; 11] = [
    "public",
    "private",
    "protected",
    "static",
    "final",
    "transient",
    "volatile",
    "abstract",
    "native",
    "strictfp",
    "default",
];

struct Tok<'a> {
    text: &'a str,
    off: usize,
    ident: bool,
}

impl<'a> Tok<'a> {
    fn is(&self, s: &str) -> bool {
        self.text == s
    }
}

fn tokenize(src: &str) -> Vec<Tok<'_>> {
    let mut out = Vec::with_capacity(src.len() / 4);
    let mut it = src.char_indices().peekable();
    while let Some((i, c)) = it.next() {
        if c.is_whitespace() {
            continue;
        }
        if c.is_alphanumeric() || c == '_' || c == '$' {
            let mut end = i + c.len_utf8();
            while let Some(&(j, n)) = it.peek() {
                if n.is_alphanumeric() || n == '_' || n == '$' {
                    end = j + n.len_utf8();
                    it.next();
                } else {
                    break;
                }
            }
            out.push(Tok {
                text: &src[i..end],
                off: i,
                ident: true,
            });
        } else {
            out.push(Tok {
                text: &src[i..i + c.len_utf8()],
                off: i,
                ident: false,
            });
        }
    }
    out
}

/// 从 `open` 处的开括号找到配对的闭括号下标；找不到返回 `to - 1`。
fn matching(toks: &[Tok], open: usize, to: usize, o: &str, c: &str) -> usize {
    let mut depth = 0usize;
    let mut i = open;
    while i < to {
        if !toks[i].ident {
            if toks[i].is(o) {
                depth += 1;
            } else if toks[i].is(c) {
                depth -= 1;
                if depth == 0 {
                    return i;
                }
            }
        }
        i += 1;
    }
    to.saturating_sub(1)
}

fn prev_is_dot(toks: &[Tok], i: usize) -> bool {
    i > 0 && !toks[i - 1].ident && toks[i - 1].is(".")
}

/// `toks[i]` 是类型声明关键字时，返回 (简单名, 是否枚举, body 的 `{` 下标, 配对 `}` 下标)。
fn type_at(toks: &[Tok], i: usize, to: usize) -> Option<(String, bool, usize, usize)> {
    let kw = toks.get(i)?;
    if !kw.ident || prev_is_dot(toks, i) {
        return None;
    }
    let is_enum = match kw.text {
        "class" | "interface" | "record" => false,
        "enum" => true,
        _ => return None,
    };
    let name = toks.get(i + 1)?;
    if !name.ident {
        return None;
    }
    // 名字之后到 body `{`：泛型参数、record 组件、extends / implements 列表都跳过
    let mut j = i + 2;
    while j < to {
        let t = &toks[j];
        if !t.ident {
            match t.text {
                "{" => {
                    let close = matching(toks, j, to, "{", "}");
                    return Some((name.text.to_string(), is_enum, j, close));
                }
                ";" => return None,
                "(" | "<" => {
                    let (o, c) = if t.text == "(" {
                        ("(", ")")
                    } else {
                        ("<", ">")
                    };
                    j = matching(toks, j, to, o, c) + 1;
                    continue;
                }
                _ => {}
            }
        }
        j += 1;
    }
    None
}

/// 摘出源码里的全部成员声明。
pub(crate) fn members(clean: &str) -> Vec<MemberDecl> {
    let toks = tokenize(clean);
    let mut out = Vec::new();
    collect_types(&toks, 0, toks.len(), "", &mut out);
    out.truncate(MAX_PER_FILE);
    out
}

fn collect_types(toks: &[Tok], from: usize, to: usize, prefix: &str, out: &mut Vec<MemberDecl>) {
    let mut i = from;
    while i < to {
        let Some((name, is_enum, open, close)) = type_at(toks, i, to) else {
            i += 1;
            continue;
        };
        let container = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}.{name}")
        };
        parse_body(toks, open + 1, close, &container, is_enum, i, out);
        collect_types(toks, open + 1, close, &container, out);
        i = close + 1;
    }
}

/// 接口里的字段隐式 `public static final`，都按常量记；枚举的字段不是常量
/// （`private int code;` 是普通字段），所以这里只认 `interface`。
fn is_iface_like(toks: &[Tok], kw_at: usize) -> bool {
    toks.get(kw_at).is_some_and(|t| t.is("interface"))
}

/// 解析一个类型体里的直接成员（子类型的成员由 `collect_types` 递归处理）。
fn parse_body(
    toks: &[Tok],
    from: usize,
    to: usize,
    container: &str,
    is_enum: bool,
    kw_at: usize,
    out: &mut Vec<MemberDecl>,
) {
    let iface_like = is_iface_like(toks, kw_at);
    let mut i = from;
    // 枚举常量段：第一个顶层 `;` 之前，逗号分隔
    if is_enum {
        let mut j = from;
        let mut depth = 0usize;
        while j < to {
            let t = &toks[j];
            if !t.ident {
                match t.text {
                    "(" | "{" | "[" => depth += 1,
                    ")" | "}" | "]" => depth = depth.saturating_sub(1),
                    ";" if depth == 0 => break,
                    _ => {}
                }
            }
            j += 1;
        }
        let mut seg = from;
        let mut k = from;
        while k <= j && k < to {
            let t = &toks[k];
            let cut = !t.ident && depth_at(toks, from, k) == 0 && (t.is(",") || t.is(";"));
            if cut || k == j {
                if let Some(first) = toks[seg..k].iter().find(|t| t.ident && !t.is("@")) {
                    out.push(MemberDecl {
                        name: first.text.to_string(),
                        kind: 22,
                        offset: first.off,
                        container: container.to_string(),
                    });
                }
                seg = k + 1;
            }
            k += 1;
        }
        i = (j + 1).min(to);
    }

    let mut seg = i;
    while i < to {
        let t = &toks[i];
        if t.ident
            && matches!(t.text, "class" | "interface" | "enum" | "record")
            && !prev_is_dot(toks, i)
        {
            if let Some((_, _, _, close)) = type_at(toks, i, to) {
                i = close + 1;
                seg = i;
                continue;
            }
        }
        if !t.ident {
            match t.text {
                "{" => {
                    // 初始化块（`static {`）或数组初始化表达式（`= {`）：都整段跳过
                    let close = matching(toks, i, to, "{", "}");
                    let expr = toks[seg..i].iter().any(|x| !x.ident && x.is("="));
                    i = close + 1;
                    if !expr {
                        seg = i;
                    }
                    continue;
                }
                ";" => {
                    emit_field(toks, seg, i, container, iface_like, out);
                    i += 1;
                    seg = i;
                    continue;
                }
                "(" => {
                    if let Some((name_at, body_after)) = method_at(toks, i, container, to) {
                        let name = &toks[name_at];
                        out.push(MemberDecl {
                            name: name.text.to_string(),
                            kind: if container.rsplit('.').next().is_some_and(|c| c == name.text) {
                                9
                            } else {
                                6
                            },
                            offset: name.off,
                            container: container.to_string(),
                        });
                        i = body_after;
                        seg = i;
                        continue;
                    }
                    i = matching(toks, i, to, "(", ")") + 1;
                    continue;
                }
                _ => {}
            }
        }
        i += 1;
    }
}

/// `toks[seg..i]` 里 `(` 左侧的括号深度（用于枚举段的逗号切分）。
fn depth_at(toks: &[Tok], from: usize, upto: usize) -> usize {
    let mut d = 0usize;
    for t in &toks[from..upto] {
        if t.ident {
            continue;
        }
        match t.text {
            "(" | "{" | "[" => d += 1,
            ")" | "}" | "]" => d = d.saturating_sub(1),
            _ => {}
        }
    }
    d
}

/// `toks[paren]` 是 `(`：判断它是不是方法 / 构造器声明。
///
/// 是则返回 (名字 token 下标, 声明结束后的下标)；否则 `None`（由调用方跳过括号）。
fn method_at(toks: &[Tok], paren: usize, container: &str, to: usize) -> Option<(usize, usize)> {
    if paren == 0 {
        return None;
    }
    let name_at = paren - 1;
    let name = toks.get(name_at)?;
    if !name.ident || NOT_METHOD.contains(&name.text) {
        return None;
    }
    if name_at > 0 {
        let prev = &toks[name_at - 1];
        let ok = if prev.ident {
            // `void foo(` / `String foo(` / `int foo(`；`new Foo(` 与 `x.foo(` 已排除
            !NOT_METHOD.contains(&prev.text) && !prev.is("new")
        } else {
            // `> foo(` / `] foo(`；语句开头的构造器 `{ Foo(`
            matches!(prev.text, ">" | "]" | "{" | "}" | ";" | ")" | "(" | ",")
        };
        if !ok {
            return None;
        }
    } else if name.text != container.rsplit('.').next().unwrap_or("") {
        return None;
    }

    let close = matching(toks, paren, to, "(", ")");
    let mut j = close + 1;
    // `throws A, B.c` 之后再找 `{` 或 `;`
    while j < to {
        let t = &toks[j];
        if t.ident {
            j += 1;
            continue;
        }
        match t.text {
            "{" => {
                let end = matching(toks, j, to, "{", "}") + 1;
                return Some((name_at, end));
            }
            ";" => return Some((name_at, j + 1)),
            "." | "," | "<" | ">" | "[" | "]" => j += 1,
            _ => return None,
        }
    }
    None
}

/// 去掉注解（连同参数括号里的内容）。`@SuppressWarnings("x") String s;` 里
/// 那个括号会让「有括号 = 调用」的判断误伤字段声明。
fn strip_annotations<'a>(stmt: &[&'a Tok<'a>]) -> Vec<&'a Tok<'a>> {
    let mut out = Vec::with_capacity(stmt.len());
    let mut i = 0;
    while i < stmt.len() {
        let t = stmt[i];
        if !t.ident && t.is("@") {
            i += 1;
            // 注解名（可能是 `a.b.C` 形式）
            while i < stmt.len() && stmt[i].ident {
                i += 1;
                if i < stmt.len() && !stmt[i].ident && stmt[i].is(".") {
                    i += 1;
                } else {
                    break;
                }
            }
            // 参数列表
            if i < stmt.len() && !stmt[i].ident && stmt[i].is("(") {
                let mut depth = 0usize;
                while i < stmt.len() {
                    if !stmt[i].ident {
                        if stmt[i].is("(") {
                            depth += 1;
                        } else if stmt[i].is(")") {
                            depth -= 1;
                            if depth == 0 {
                                i += 1;
                                break;
                            }
                        }
                    }
                    i += 1;
                }
            }
            continue;
        }
        out.push(t);
        i += 1;
    }
    out
}

/// 字段语句：`String name = ...;` → 变量名取 `=` 之前最后一个标识符。
fn emit_field(
    toks: &[Tok],
    from: usize,
    to: usize,
    container: &str,
    iface_like: bool,
    out: &mut Vec<MemberDecl>,
) {
    if to <= from {
        return;
    }
    let refs: Vec<&Tok> = toks[from..to].iter().collect();
    let stmt = strip_annotations(&refs);
    let eq = stmt
        .iter()
        .position(|t| !t.ident && t.is("="))
        .unwrap_or(stmt.len());
    let head = &stmt[..eq];
    // 类型 + 名字之间不会有括号；有就说明这是调用或残留的方法签名
    if head.iter().any(|t| !t.ident && t.is("(")) {
        return;
    }
    let mut has_static = false;
    let mut has_final = false;
    let mut last: Option<&Tok> = None;
    let mut idents = 0usize;
    for t in head {
        if t.ident {
            if t.is("static") {
                has_static = true;
                continue;
            }
            if t.is("final") {
                has_final = true;
                continue;
            }
            if MODIFIERS.contains(&t.text) {
                continue;
            }
            idents += 1;
            last = Some(t);
        }
    }
    let Some(name) = last else { return };
    if idents < 2 || NOT_METHOD.contains(&name.text) {
        return;
    }
    let is_const = iface_like || (has_static && has_final);
    out.push(MemberDecl {
        name: name.text.to_string(),
        kind: if is_const { 14 } else { 8 },
        offset: name.off,
        container: container.to_string(),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(src: &str) -> Vec<(String, u8, String)> {
        let clean = crate::build_state::strip_comments_and_literals(src);
        members(&clean)
            .into_iter()
            .map(|m| (m.name, m.kind, m.container))
            .collect()
    }

    fn find<'a>(list: &'a [(String, u8, String)], name: &str) -> Option<&'a (String, u8, String)> {
        list.iter().find(|m| m.0 == name)
    }

    #[test]
    fn finds_methods_fields_and_constructors() {
        let list = names(
            r#"
package nc.vo;
public class Bill {
    private static final String TABLE = "bd_bill";
    private int count;
    public Bill() {}
    public String getName() { return name; }
    protected void setName(String n) throws IllegalArgumentException { this.name = n; }
    static { count = 0; }
    public abstract void flush();
}
"#,
        );
        assert_eq!(find(&list, "TABLE").map(|m| m.1), Some(14));
        assert_eq!(find(&list, "count").map(|m| m.1), Some(8));
        assert_eq!(find(&list, "Bill").map(|m| m.1), Some(9));
        assert_eq!(find(&list, "getName").map(|m| m.1), Some(6));
        assert_eq!(find(&list, "setName").map(|m| m.1), Some(6));
        assert_eq!(find(&list, "flush").map(|m| m.1), Some(6));
        assert!(
            find(&list, "IllegalArgumentException").is_none(),
            "throws 里的类型不是方法"
        );
    }

    #[test]
    fn ignores_calls_lambdas_and_keywords() {
        let list = names(
            r#"
class A {
    void run() {
        if (x) { helper(a); }
        list.forEach(v -> use(v));
        Object o = new Object() { public void inner() {} };
    }
    void helper(int a) {}
}
"#,
        );
        assert!(find(&list, "if").is_none());
        assert!(find(&list, "forEach").is_none(), "调用不是声明");
        assert!(find(&list, "use").is_none(), "lambda 里的调用不是声明");
        assert!(find(&list, "inner").is_none(), "匿名类成员不属于外层");
        assert!(find(&list, "helper").is_some());
    }

    #[test]
    fn nested_types_get_qualified_container() {
        let list = names(
            r#"
class Outer {
    class Inner {
        void deep() {}
    }
    void shallow() {}
}
"#,
        );
        assert_eq!(
            find(&list, "deep").map(|m| m.2.as_str()),
            Some("Outer.Inner")
        );
        assert_eq!(find(&list, "shallow").map(|m| m.2.as_str()), Some("Outer"));
    }

    #[test]
    fn enum_constants_are_indexed_once() {
        let list = names(
            r#"
public enum Kind {
    A, B(2), C {
        void extra() {}
    };
    private int code;
    public int code() { return code; }
}
"#,
        );
        for c in ["A", "B", "C"] {
            assert_eq!(find(&list, c).map(|m| m.1), Some(22), "{c} 应是枚举常量");
        }
        assert_eq!(find(&list, "code").map(|m| m.1), Some(8));
        assert_eq!(find(&list, "code()").map(|m| m.1), None);
    }

    #[test]
    fn array_initializer_does_not_break_field_name() {
        let list = names(
            r#"
class T {
    static final int[] NONE = {};
    private String[] tags = { "a", "b" };
}
"#,
        );
        assert!(find(&list, "NONE").is_some());
        assert!(find(&list, "tags").is_some());
    }

    #[test]
    fn comments_and_literals_do_not_create_members() {
        let list = names(
            r#"
class C {
    // void fake() {}
    /* int ghost; */
    String s = "void alsoFake() { int x; }";
    void real() {}
}
"#,
        );
        assert!(find(&list, "fake").is_none());
        assert!(find(&list, "ghost").is_none());
        assert!(find(&list, "alsoFake").is_none());
        assert!(find(&list, "real").is_some());
        assert!(find(&list, "s").is_some());
    }
}
