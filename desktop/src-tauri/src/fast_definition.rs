//! Phase 1 快速跳转：**不启 jdt.ls**，直接用声明索引回答「这个标识符定义在哪」。
//!
//! 为什么需要：jdt.ls 从工作区打开到能回答 `definition` 要 99.3s（实测，见
//! `docs/NCForge-智能代码-实施方案-2026-11-21.md` §4.1），这段时间里前端只能走
//! `lightDefinition` —— 而它现在是**内容搜索**（`searchWorkspace` 正则扫全工作区）。
//!
//! 这里换成索引查询：光标词 → 消歧 → 候选，全程毫秒级，且带准确行号。
//!
//! 消歧顺序（命中即停，与 IDE 的解析直觉一致）：
//! 1. 显式 import：`import a.b.DeliveryVO;` + 光标词 `DeliveryVO`
//! 2. 同包：`package a.b;` + `a.b.DeliveryVO`
//! 3. 通配 import：`import a.b.*;` + `a.b.DeliveryVO`
//! 4. 全库简单名候选（同模块 > 源码优先于 jar > 全限定名字典序）
//!
//! **第四条可能命中多个同名类**（NC 二开常见）。LSP 的 `definition` 允许返回数组，
//! 前端会弹选择列表 —— 这比「猜一个然后跳错」好。等 Phase 2（jdt.ls）就绪后，
//! 请求会走原路径，精度自动补齐。
//!
//! 纯逻辑模块：不读磁盘、不含 tauri 类型（源码文本与索引都由调用方给）。

use std::collections::HashSet;

use crate::decl_index::{Decl, DeclIndex};

/// 一条跳转目标。行是 1 基（索引口径），列是 0 基（LSP 口径）。
///
/// 列恒为 0：`types.idx` 只存声明行不存列（ECJ AST 的 `getStartPosition` 有列信息，
/// 但要额外存 4 字节 × 20 万条）。跳到行首对「Ctrl+点击类名」完全够用。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub name: String,
    pub path: String,
    pub line: u32,
    pub character: u32,
    pub from_jar: bool,
}

/// 取光标下的 Java 标识符，返回「字节区间 + 词」。
///
/// `offset` 是**字节**偏移（Monaco 给的是行 + 字符列，调用方先换算）。
/// 光标通常停在词尾（插入点），所以两侧都要扩。
pub fn word_at(src: &str, offset: usize) -> Option<(usize, usize, &str)> {
    if offset > src.len() || !src.is_char_boundary(offset) {
        return None;
    }
    let b = src.as_bytes();
    let ident = |c: u8| c.is_ascii_alphanumeric() || c == b'_' || c == b'$';
    let mut start = offset;
    while start > 0 && ident(b[start - 1]) {
        start -= 1;
    }
    let mut end = offset;
    while end < b.len() && ident(b[end]) {
        end += 1;
    }
    if start == end {
        return None;
    }
    Some((start, end, &src[start..end]))
}

/// 当前文件的 package。只看文件头，遇到 import / 类型声明就停（package 必须在最前）。
pub fn package_of(src: &str) -> Option<&str> {
    for line in src.lines().take(100) {
        let t = line.trim_start();
        if let Some(rest) = t.strip_prefix("package ") {
            let name = rest.trim().trim_end_matches(';').trim();
            return (!name.is_empty()).then_some(name);
        }
        if t.starts_with("import ")
            || t.starts_with("public ")
            || t.starts_with("class ")
            || t.starts_with("abstract ")
            || t.starts_with("final ")
            || t.starts_with("@")
        {
            break;
        }
    }
    None
}

/// 解析跳转目标。
///
/// `cur_module` 是当前文件所属模块名（用于「同模块优先」排序），拿不到传空串。
/// `limit` 是候选上限（前端一次弹 5 个就够多了）。
pub fn resolve(
    src: &str,
    offset: usize,
    idx: &DeclIndex,
    cur_module: &str,
    limit: usize,
) -> Vec<Target> {
    let Some((_, _, word)) = word_at(src, offset) else {
        return Vec::new();
    };
    // 单字符不是类名；`$` 开头的是合成的访问器名，索引里也没有
    if word.len() < 2 || word.starts_with('$') {
        return Vec::new();
    }

    let mut out: Vec<Target> = Vec::new();
    let mut seen: HashSet<(&str, u32)> = HashSet::new();

    // 同一 (全限定名, 行) 只留一条：同名类在多个 jar 里重复出现是常态。
    // 用宏而不是闭包：闭包会同时可变借用 out 与 seen，连调两次就冲突。
    macro_rules! push {
        ($d:expr) => {{
            let d: &Decl = $d;
            let line = d.line.max(0) as u32;
            if seen.insert((d.name.as_str(), line)) {
                out.push(Target {
                    name: d.name.clone(),
                    path: d.path.clone(),
                    line,
                    character: 0,
                    from_jar: d.from_jar,
                });
            }
        }};
    }

    let pkg = package_of(src);
    let imports = crate::compile::extract_imports(src);

    // 1. 显式 import 命中（最可信：命中即定论，不再兜底返回同名类）
    for (imp, wildcard) in &imports {
        if *wildcard {
            continue;
        }
        if imp.rsplit('.').next() == Some(word) {
            if let Some(d) = idx.find(imp) {
                push!(d);
                return out;
            }
        }
    }

    // 2. 同包（没有 import 时，同包是 Java 可见性下唯一能直接引用的来源）
    if let Some(p) = pkg {
        let fq = format!("{p}.{word}");
        if let Some(d) = idx.find(&fq) {
            push!(d);
            return out;
        }
    }

    // 3. 通配 import
    for (imp, wildcard) in &imports {
        if !*wildcard {
            continue;
        }
        let fq = format!("{imp}.{word}");
        if let Some(d) = idx.find(&fq) {
            push!(d);
            return out;
        }
    }

    // 4. 全库简单名兜底：找不到 import 线索时（或光标在 import 语句本身里）靠这个
    let needle = if cur_module.is_empty() {
        String::new()
    } else {
        format!("\\{}\\", cur_module.to_ascii_lowercase())
    };
    let mut cands: Vec<&Decl> = idx.by_simple(word).collect();
    cands.sort_by(|a, b| rank(a, &needle).cmp(&rank(b, &needle)));
    for d in cands {
        push!(d);
        if out.len() >= limit {
            break;
        }
    }
    out
}

/// 候选排序键：同模块最前，其次源码优先于 jar，最后按全限定名保证结果稳定。
///
/// `needle` 是预先小写化的 `\模块名\`，避免每个候选都拼一次格式化串。
///
/// `pub(crate)`：`fast_member` 的接收者类型消歧要用同一套排序，
/// 抄一份的话两边迟早会给出不同的首选。
pub(crate) fn rank<'a>(d: &'a Decl, needle: &str) -> (u8, u8, &'a str) {
    let same_module = !needle.is_empty() && d.path.to_ascii_lowercase().contains(needle);
    (
        u8::from(!same_module),
        u8::from(d.from_jar),
        d.name.as_str(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decl_index::from_decls;

    fn decl(name: &str, path: &str, line: i32, from_jar: bool) -> Decl {
        Decl {
            name: name.to_string(),
            kind: 1,
            from_jar,
            path: path.to_string(),
            line,
            methods: Vec::new(),
            fields: Vec::new(),
        }
    }

    fn fixture() -> DeclIndex {
        from_decls(vec![
            decl(
                "nc.vo.so.DeliveryVO",
                "C:\\ws\\so\\src\\private\\nc\\vo\\so\\DeliveryVO.java",
                12,
                false,
            ),
            decl(
                "nc.vo.other.DeliveryVO",
                "C:\\ws\\other\\src\\private\\nc\\vo\\other\\DeliveryVO.java",
                30,
                false,
            ),
            decl(
                "nc.vo.so.DeliveryVO$Inner",
                "C:\\ws\\so\\src\\private\\nc\\vo\\so\\DeliveryVO.java",
                80,
                false,
            ),
            decl("com.lib.Helper", "D:\\ncc\\lib\\common.jar", 0, true),
        ])
    }

    #[test]
    fn 取词覆盖词中与词尾两种光标位置() {
        let src = "DeliveryVO vo = new DeliveryVO();";
        // 光标停在词中间
        assert_eq!(word_at(src, 4).map(|t| t.2), Some("DeliveryVO"));
        // 光标停在词尾的空格上（Monaco 的插入点多半落在这里）：要取到前面的词
        assert_eq!(word_at(src, 10).map(|t| t.2), Some("DeliveryVO"));
        // 光标在 "vo" 中间
        assert_eq!(word_at(src, 12).map(|t| t.2), Some("vo"));
        // 两侧都不是标识符字符：取不到词
        assert_eq!(word_at("a + b", 2), None, "运算符处应取不到词");
        // 越界 / 非字符边界
        assert_eq!(word_at(src, 999), None);
        assert_eq!(word_at("中文X", 3), None, "落在多字节字符中间要拒绝");
    }

    #[test]
    fn 取包名遇到类型声明就停() {
        assert_eq!(package_of("package a.b;\nimport x.Y;\n"), Some("a.b"));
        assert_eq!(package_of("// 注释\npackage a.b;\n"), Some("a.b"));
        assert_eq!(
            package_of("import x.Y;\npackage a.b;\n"),
            None,
            "import 之后不该再认 package"
        );
        assert_eq!(package_of("public class A {}\n"), None);
    }

    #[test]
    fn 显式import优先于同包与全库兜底() {
        let idx = fixture();
        let src = "package nc.vo.test;\nimport nc.vo.so.DeliveryVO;\nclass A { DeliveryVO v; }\n";
        let off = src.find("DeliveryVO v").unwrap();
        let t = resolve(src, off, &idx, "test", 5);
        assert_eq!(t.len(), 1, "显式 import 命中后不再兜底：{t:?}");
        assert_eq!(t[0].name, "nc.vo.so.DeliveryVO");
        assert_eq!(t[0].line, 12);
        assert_eq!(t[0].character, 0);
        assert!(!t[0].from_jar);
    }

    #[test]
    fn 无import线索时同包优先() {
        let idx = fixture();
        let src = "package nc.vo.other;\nclass A { DeliveryVO v; }\n";
        let off = src.find("DeliveryVO v").unwrap();
        let t = resolve(src, off, &idx, "other", 5);
        assert_eq!(t[0].name, "nc.vo.other.DeliveryVO");
    }

    #[test]
    fn 同名类多候选要把同模块的排前面() {
        let idx = fixture();
        // 没有 package 也没有 import：只能走全库兜底
        let src = "class A { DeliveryVO v; }\n";
        let off = src.find("DeliveryVO v").unwrap();
        let t = resolve(src, off, &idx, "so", 5);
        assert!(t.len() >= 2, "两个同名类都应返回：{t:?}");
        assert_eq!(t[0].name, "nc.vo.so.DeliveryVO", "同模块的排第一");
        // jar 里的排最后
        let last = t.last().unwrap();
        assert!(!last.from_jar);
    }

    #[test]
    fn 内部类短名能命中() {
        let idx = fixture();
        let src = "package nc.vo.so;\nclass A { Inner i; }\n";
        let off = src.find("Inner i").unwrap();
        let t = resolve(src, off, &idx, "so", 5);
        assert!(
            t.iter().any(|x| x.name == "nc.vo.so.DeliveryVO$Inner"),
            "短名 Inner 应命中内部类：{t:?}"
        );
    }

    #[test]
    fn 通配import能命中且找不到时返回空() {
        let idx = fixture();
        let src = "package p;\nimport nc.vo.so.*;\nclass A { DeliveryVO v; }\n";
        let off = src.find("DeliveryVO v").unwrap();
        let t = resolve(src, off, &idx, "p", 5);
        assert!(t.iter().any(|x| x.name == "nc.vo.so.DeliveryVO"), "{t:?}");

        let src2 = "package p;\nclass A { CompletelyUnknown v; }\n";
        let off2 = src2.find("CompletelyUnknown v").unwrap();
        assert!(resolve(src2, off2, &idx, "p", 5).is_empty());
    }

    #[test]
    fn limit生效且单字符不查() {
        let idx = fixture();
        let src = "class A { DeliveryVO v; }\n";
        let off = src.find("DeliveryVO v").unwrap();
        assert_eq!(resolve(src, off, &idx, "so", 1).len(), 1);
        assert!(
            resolve(src, 6, &idx, "so", 5).is_empty(),
            "单字符 'A' 不该去查索引"
        );
    }
}
