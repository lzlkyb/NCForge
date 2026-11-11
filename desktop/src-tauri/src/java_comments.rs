//! Java 源码里的注释提取（供 jar 内源码注释索引用）。
//!
//! 为什么要它：`class` 文件**物理上不含注释**（javac 编译时剥离），所以「搜 jar 内
//! 注释」只能走 NC 随包发布的 `_src.jar`——里面是带注释的原始 `.java`。本模块负责
//! 把注释从源码里抽出来，且**不被字符串字面量里的注释形态骗到**（`"http://x"`、
//! `"/* not a comment */"` 在 NC 的 SQL 常量里遍地都是）。
//!
//! 行注释与块注释（含 javadoc）都收；多行注释拼成一行——搜索是子串匹配，
//! 保留换行会让「跨两行的注释」永远搜不中。

/// 一条注释。`line` 是 1-based 的起始行号（点搜索结果时跳到这）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Note {
    pub text: String,
    pub line: usize,
}

/// 单个源码文件的大小上限。超过的跳过：注释搜索不需要为巨文件付代价。
pub const MAX_JAVA_BYTES: u64 = 2 * 1024 * 1024;

/// NC home 下的全部源码包（`modules/**/*_src.jar`）。
///
/// 🔴 与 `nc_index::classpath_jars` 是两批东西：那个按 Eclipse classpath 语义
/// **有意排除** `_src.jar`（源码包不是编译单元）。这里反过来只要源码包——
/// 注释只存在于它们里面。
pub fn source_jars(nc_home: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    let modules = nc_home.join("modules");
    let mut stack = vec![modules];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else {
            continue;
        };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.to_ascii_lowercase().ends_with("_src.jar"))
            {
                out.push(p);
            }
        }
    }
    out.sort();
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum St {
    Code,
    Line,
    Block,
}

/// 抽出全部注释。`src` 必须是已解码的文本。
///
/// 扫描器只认四种状态，转义按字符字面量处理（`'\''`、`'"'`、`'\\'`）——
/// Java 里没有模板字符串，引号配对就是全部。
pub fn extract_notes(src: &str) -> Vec<Note> {
    let b = src.as_bytes();
    let mut out: Vec<Note> = Vec::new();
    let mut st = St::Code;
    let mut i = 0usize;
    let mut line = 1usize;
    let mut start = 0usize;
    let mut note_line = 1usize;

    while i < b.len() {
        match st {
            St::Code => {
                if b[i] == b'\n' {
                    line += 1;
                    i += 1;
                    continue;
                }
                if b[i] == b'/' && i + 1 < b.len() && b[i + 1] == b'/' {
                    st = St::Line;
                    start = i + 2;
                    note_line = line;
                    i += 2;
                    continue;
                }
                if b[i] == b'/' && i + 1 < b.len() && b[i + 1] == b'*' {
                    st = St::Block;
                    start = i + 2;
                    note_line = line;
                    i += 2;
                    continue;
                }
                if b[i] == b'"' || b[i] == b'\'' {
                    let q = b[i];
                    i += 1;
                    while i < b.len() {
                        if b[i] == b'\\' {
                            // 🔴 `i + 1 < b.len()` 不能省：`\` 是文件最后一个字节时
                            // （被截断的源码、异常编码）越界读会 panic，而后台建索引的
                            // 线程一死，「在飞」标志就永远不复位（见 src_note_cmds）。
                            if i + 1 < b.len() && b[i + 1] == b'\n' {
                                line += 1;
                            }
                            i += 2;
                            continue;
                        }
                        if b[i] == b'\n' {
                            // 未闭合的字符串：不当注释起始，退回代码态
                            break;
                        }
                        if b[i] == q {
                            i += 1;
                            break;
                        }
                        i += 1;
                    }
                    continue;
                }
                i += 1;
            }
            St::Line => {
                if b[i] == b'\n' {
                    push_note(&mut out, &src[start..i], false, note_line);
                    st = St::Code;
                    line += 1;
                    i += 1;
                } else {
                    i += 1;
                }
            }
            St::Block => {
                if b[i] == b'*' && i + 1 < b.len() && b[i + 1] == b'/' {
                    push_note(&mut out, &src[start..i], true, note_line);
                    st = St::Code;
                    i += 2;
                    continue;
                }
                if b[i] == b'\n' {
                    line += 1;
                }
                i += 1;
            }
        }
    }
    // 文件尾未闭合的注释也收（源码被截断时不该丢内容）
    match st {
        St::Line => push_note(&mut out, &src[start..], false, note_line),
        St::Block => push_note(&mut out, &src[start..], true, note_line),
        St::Code => {}
    }
    out
}

fn push_note(out: &mut Vec<Note>, raw: &str, block: bool, line: usize) {
    let mut text = String::new();
    for seg in raw.split('\n') {
        let s = seg.trim();
        // 块注释每行以 `*` 续排（javadoc 的对齐星）；行注释没有
        let s = if block {
            s.trim_start_matches('*').trim()
        } else {
            s
        };
        if s.is_empty() {
            continue;
        }
        if !text.is_empty() {
            text.push(' ');
        }
        text.push_str(s);
    }
    if text.len() < 2 {
        return;
    }
    out.push(Note { text, line });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 行注释与块注释都抽出来() {
        let src = "class A {\n  // 设置创建时间\n  int x; /* 内联说明 */\n}\n";
        let n = extract_notes(src);
        assert_eq!(n.len(), 2, "{n:?}");
        assert_eq!(n[0].text, "设置创建时间");
        assert_eq!(n[0].line, 2);
        assert_eq!(n[1].text, "内联说明");
        assert_eq!(n[1].line, 3);
    }

    #[test]
    fn javadoc_去掉对齐星并拼成一行() {
        let src = "/**\n * 从数据库中获得模块为8004的公司建账信息\n * @param rs 结果集\n */\nclass X {}\n";
        let n = extract_notes(src);
        assert_eq!(n.len(), 1, "{n:?}");
        assert_eq!(
            n[0].text,
            "从数据库中获得模块为8004的公司建账信息 @param rs 结果集"
        );
        assert_eq!(n[0].line, 1);
    }

    #[test]
    fn 字符串里的注释形态不算注释() {
        // NC 的 SQL 常量里遍地是 `//` 与 `/*`，认错了会把整条 SQL 当注释
        let src = "class A {\n  String u = \"http://x/a\";\n  String s = \"/* not a comment */\";\n  String c = \"// 也不是\";\n}\n";
        let n = extract_notes(src);
        assert!(n.is_empty(), "字符串里的注释形态被误认：{n:?}");
    }

    #[test]
    fn 字符字面量里的引号和斜杠不捣乱() {
        let src =
            "class A {\n  char q = '\"';\n  char s = '/';\n  char b = '\\\\';\n  // 真注释\n}\n";
        let n = extract_notes(src);
        assert_eq!(n.len(), 1, "{n:?}");
        assert_eq!(n[0].text, "真注释");
    }

    #[test]
    fn 未闭合注释在文件尾也收() {
        let a = extract_notes("class A {\n  // 收尾说明");
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].text, "收尾说明");
        let b = extract_notes("class A {\n  /* 收尾说明");
        assert_eq!(b.len(), 1);
        assert_eq!(b[0].text, "收尾说明");
    }

    #[test]
    fn 行号按注释起始算且跨行正确() {
        let src = "// 一\n\n\n// 二\n";
        let n = extract_notes(src);
        assert_eq!(n.len(), 2);
        assert_eq!(n[0].line, 1);
        assert_eq!(n[1].line, 4);
    }

    #[test]
    fn 空注释与纯符号注释跳过() {
        // 单字符注释也跳过（`len() < 2`）：那更可能是分隔线而不是说明
        let src = "//\n//   \n/* */\n/**\n */\n// x\n// .\n// 真说明\n";
        let n = extract_notes(src);
        assert_eq!(n.len(), 1, "{n:?}");
        assert_eq!(n[0].text, "真说明");
    }

    #[test]
    fn 字符串以反斜杠结尾不越界() {
        // 🔴 回归：`\` 是文件最后一个字节时，转义分支读 `b[i+1]` 会 panic。
        // 后台建索引的线程一死，「在飞」标志永远不复位（功能卡在「建索引」）。
        let src = "class A {\n  String s = \"abc\\";
        let n = extract_notes(src);
        assert!(n.is_empty(), "{n:?}");
        // 对照组：转义的 `\\` 之后引号正常闭合字符串，后面的 `//` 才是真注释
        // （`\<换行>` 在 Java 里是续行，会把下一行并进字符串，那不算注释）
        let src2 = "class A {\n  String s = \"a\\\\b\";\n  // 真注释\n}\n";
        let n2 = extract_notes(src2);
        assert_eq!(n2.len(), 1, "{n2:?}");
        assert_eq!(n2[0].text, "真注释");
        assert_eq!(n2[0].line, 3);
    }

    #[test]
    fn 源码包枚举只认_src_jar() {
        let root = crate::test_support::tmp("src-jars");
        let lib = root.join("modules/aeam/lib");
        std::fs::create_dir_all(&lib).unwrap();
        std::fs::write(lib.join("pubaeam-1.jar"), b"x").unwrap();
        std::fs::write(lib.join("pubaeam-1_src.jar"), b"x").unwrap();
        std::fs::create_dir_all(root.join("modules/aeam/client/lib")).unwrap();
        std::fs::write(root.join("modules/aeam/client/lib/uiaeam-1_SRC.JAR"), b"x").unwrap();
        let got = source_jars(&root);
        let names: Vec<String> = got
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        // 全路径排序：`client/lib` 字典序在 `lib` 前，与目录遍历顺序无关
        assert_eq!(
            names,
            vec!["uiaeam-1_SRC.JAR", "pubaeam-1_src.jar"],
            "{names:?}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
