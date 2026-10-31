//! Eclipse `.classpath` 解析 —— 工程类路径的唯一真源。
//!
//! 背景见 `docs/NCForge-多工程关联与启动链路-方案设计-20261031.md` §2–§3。
//! 编译、启动、语言服务三处共用的 `launch::project_class_dirs` 过去靠**猜目录**：
//! 只认 `<模块>/classes` 与 `out/<模块>`，兄弟工程按字典序无条件全收。实测出的三个后果：
//!
//! - `pm/bin` 里 339 个 class 从来没进过类路径。`pm/.classpath` 有 4 条 src 没写
//!   `output=`，按 Eclipse 规则落到工程默认输出 `bin`（`pm/bin` 存在的同名类与
//!   `newar/out/uapbd` 内容不同，运行时永远加载 newar 那份）；
//! - `TestBill` / `aierhh` / `epuip` 里也有 `nc/bs/**`，谁生效只看目录名字母序；
//! - 依赖顺序同样是字典序，`newar` 的 18 个同名类压过 `pm`，本该 pm 赢。
//!
//! 这些信息 `.classpath` 里本来就写全了（谁依赖谁、什么顺序、产物落在哪）。
//! 本模块只做一件事：读它，别猜。

use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// 一个工程在 `.classpath` 里的引用：`kind="src"` 且 `path="/X"`。
///
/// `exported` 不是装饰：`EyePortal` 有 95 个类只能经 `pm --exported--> newar` 拿到，
/// 只连直接依赖的话它编译立刻挂。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CpRef {
    pub name: String,
    pub exported: bool,
}

/// 解析后的 `.classpath`。`outputs` 是**相对工程根**的路径，保序、已去重。
#[derive(Debug, Clone)]
pub struct ProjectCp {
    pub name: String,
    pub default_output: Option<PathBuf>,
    pub outputs: Vec<PathBuf>,
    pub refs: Vec<CpRef>,
}

impl ProjectCp {
    /// 读 `<root>/.classpath`；文件不存在（不是 Eclipse 工程）或读不出来时返回 `None`，
    /// 调用方据此回落到老启发式。
    pub fn load(root: &Path) -> Option<Self> {
        let xml = std::fs::read_to_string(root.join(".classpath")).ok()?;
        Some(Self::parse(root, &xml))
    }

    pub fn parse(root: &Path, xml: &str) -> Self {
        let mut default_output: Option<PathBuf> = None;
        // 先只收集「每条 src 的 output 声明」，**不立刻算**最终目录：默认 output
        // （`kind="output"`）在文件里是最后一行，边扫边算会让前面所有 src 拿到 None。
        let mut src_outputs: Vec<Option<PathBuf>> = Vec::new();
        let mut refs: Vec<CpRef> = Vec::new();

        for tag in classpathentry_tags(xml) {
            match attr(tag, "kind") {
                Some("output") => {
                    if let Some(p) = attr(tag, "path").filter(|p| !p.is_empty()) {
                        default_output = Some(PathBuf::from(p));
                    }
                }
                Some("src") => {
                    let Some(path) = attr(tag, "path").filter(|p| !p.is_empty()) else {
                        continue;
                    };
                    if let Some(name) = path.strip_prefix('/') {
                        refs.push(CpRef {
                            name: name.to_string(),
                            exported: attr(tag, "exported") == Some("true"),
                        });
                    } else {
                        src_outputs.push(
                            attr(tag, "output")
                                .filter(|o| !o.is_empty())
                                .map(PathBuf::from),
                        );
                    }
                }
                // kind="con"（容器）/ "lib"（jar）与类目录无关：jar 由
                // `middleware_classpath` 从 NC home 收，容器是 Eclipse 内部概念。
                _ => {}
            }
        }

        let mut outputs: Vec<PathBuf> = Vec::new();
        for o in src_outputs {
            let p = o.or_else(|| default_output.clone());
            if let Some(p) = p {
                if !outputs.contains(&p) {
                    outputs.push(p);
                }
            }
        }
        // 一条 src 都没有的工程：默认输出仍是有效信息（Eclipse 会往里编译）
        if outputs.is_empty() {
            if let Some(d) = &default_output {
                outputs.push(d.clone());
            }
        }

        Self {
            name: root
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default(),
            default_output,
            outputs,
            refs,
        }
    }
}

/// 主工程 + `.classpath` 声明的依赖闭包 + NC home 的类目录，按加载优先级排列。
///
/// 三条硬规则（写死在实现里，不提供旋钮）：
///
/// 1. **主工程永远在最前**：改自己的代码必须立刻生效，不能被任何关联工程覆盖；
/// 2. **依赖顺序 = `.classpath` 里的出现顺序**，不是字典序、也不是字母序；
/// 3. **`exported="true"` 才继续往下传递**，`NC home` 永远在最后兜底。
pub fn class_roots(primary: &Path, nc_home: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let workspace = primary.parent().unwrap_or(primary);

    match ProjectCp::load(primary) {
        Some(cp) => {
            let mut seen: HashSet<PathBuf> = HashSet::new();
            seen.insert(dir_key(primary));
            push_outputs(&cp, primary, &mut out);
            visit_refs(&cp, workspace, &mut out, &mut seen);
        }
        None => legacy_roots(primary, &mut out),
    }

    out.extend(crate::nc_index::module_class_dirs(nc_home));
    dedupe(out)
}

/// 把 `/X` 解析成工程根目录。
///
/// 三路，顺序不能换——`newar/.project` 自称 `ar`，先按 `.project` 匹配的话
/// `/newar` 直接解析失败（§2.2(2)）：
///
/// 1. 工作区下的同名目录；
/// 2. 工作区下某个工程的 `.project` 里 `<name>` 等于 X；
/// 3. 工作区 `.metadata/.../.projects/X/.location` 里的 URI（工程不在默认位置时）
pub fn resolve_ref(name: &str, workspace: &Path) -> Option<PathBuf> {
    if name.is_empty() {
        return None;
    }
    let direct = workspace.join(name);
    if direct.is_dir() {
        return Some(direct);
    }
    if let Ok(rd) = std::fs::read_dir(workspace) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() && project_name(&p).as_deref() == Some(name) {
                return Some(p);
            }
        }
    }
    let reg = workspace
        .join(".metadata")
        .join("plugins")
        .join("org.eclipse.core.resources")
        .join(".projects")
        .join(name);
    let loc = std::fs::read_to_string(reg.join(".location")).ok()?;
    let p = location_path(&loc)?;
    p.is_dir().then_some(p)
}

fn visit_refs(
    cp: &ProjectCp,
    workspace: &Path,
    out: &mut Vec<PathBuf>,
    seen: &mut HashSet<PathBuf>,
) {
    for r in &cp.refs {
        let Some(root) = resolve_ref(&r.name, workspace) else {
            continue;
        };
        // 环（A→B→A）与菱形（A→B、A→C、B→C）都在这里收敛
        if !seen.insert(dir_key(&root)) {
            continue;
        }
        match ProjectCp::load(&root) {
            Some(child) => {
                // 直接依赖总进类路径，`exported` 只决定「要不要继续往下走」
                push_outputs(&child, &root, out);
                if r.exported {
                    visit_refs(&child, workspace, out, seen);
                }
            }
            // 被引用但不是 Eclipse 工程：按老规则扫它自己的产物
            None => legacy_own_dirs(&root, out),
        }
    }
}

fn push_outputs(cp: &ProjectCp, root: &Path, out: &mut Vec<PathBuf>) {
    for rel in &cp.outputs {
        let p = root.join(rel);
        if p.is_dir() {
            out.push(p);
        }
    }
}

/// 没有 `.classpath` 的工程：保留老规则（模块 classes → out/*），并补上 `<根>/bin`
/// （D0 漏点一：Eclipse 工程的默认输出就叫 `bin`，手工工程也常把它当产物目录）。
fn legacy_roots(project_root: &Path, out: &mut Vec<PathBuf>) {
    legacy_own_dirs(project_root, out);

    if let Some(workspace) = project_root.parent() {
        let mut sibling: Vec<PathBuf> = Vec::new();
        for group in std::fs::read_dir(workspace)
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
        {
            if !group.is_dir() || group == project_root {
                continue;
            }
            for m in std::fs::read_dir(&group).into_iter().flatten().flatten() {
                let c = m.path().join("classes");
                if c.is_dir() {
                    sibling.push(c);
                }
            }
        }
        sibling.sort();
        out.extend(sibling);
    }
}

fn legacy_own_dirs(root: &Path, out: &mut Vec<PathBuf>) {
    let mut modules: Vec<PathBuf> = std::fs::read_dir(root)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path().join("classes"))
                .filter(|p| p.is_dir())
                .collect()
        })
        .unwrap_or_default();
    modules.sort();
    out.extend(modules);

    let mut outs: Vec<PathBuf> = std::fs::read_dir(root.join("out"))
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect()
        })
        .unwrap_or_default();
    outs.sort();
    out.extend(outs);

    let bin = root.join("bin");
    if bin.is_dir() {
        out.push(bin);
    }
}

/// 保序去重。同一输出目录被多条 src 条目共享时（`newar` 223 条 src → 35 个目录）
/// 只留一次，否则类路径里会出现几十份重复项。
fn dedupe(dirs: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut out: Vec<PathBuf> = Vec::with_capacity(dirs.len());
    for d in dirs {
        if seen.insert(d.clone()) {
            out.push(d);
        }
    }
    out
}

/// 目录身份：`canonicalize` 能把 `\\?\C:\a\..\b`、大小写不同的同一目录归一。
fn dir_key(p: &Path) -> PathBuf {
    p.canonicalize().unwrap_or_else(|_| p.to_path_buf())
}

fn project_name(dir: &Path) -> Option<String> {
    let xml = std::fs::read_to_string(dir.join(".project")).ok()?;
    let start = xml.find("<name>")? + "<name>".len();
    let end = xml[start..].find("</name>")? + start;
    Some(xml[start..end].trim().to_string())
}

/// 解析 `.location` 里的工程 URI。文件形如 `URI//file:/C:/work/aier/newar`。
///
/// UNC（`file://server/share`）保留前导 `//` 交给 Windows 解析；百分号编码按 UTF-8 解，
/// 否则 `Program Files` 这类带空格的工程路径会被解析成不存在的目录。
fn location_path(text: &str) -> Option<PathBuf> {
    let i = text.find("file:")?;
    let rest = &text[i + 5..];
    let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
    let rest = &rest[..end];

    let raw = if let Some(r) = rest.strip_prefix("///") {
        r.to_string()
    } else if let Some(r) = rest.strip_prefix("//") {
        format!("//{r}")
    } else {
        rest.trim_start_matches('/').to_string()
    };
    let decoded = percent_decode(raw.trim_end_matches('/'));
    Some(PathBuf::from(decoded))
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// 逐个取出 `<classpathentry …>` 标签文本（到 `>` 为止）。
fn classpathentry_tags(xml: &str) -> Vec<&str> {
    let mut out: Vec<&str> = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find("<classpathentry") {
        let after = &rest[start..];
        let end = after.find('>').map(|i| i + 1).unwrap_or(after.len());
        out.push(&after[..end]);
        rest = &after[end..];
    }
    out
}

/// 取属性值。要求 `name=` 前面是空白，避免 `output="a"` 被当成 `put="a"` 之类的子串命中。
fn attr<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let needle = format!("{name}=\"");
    let mut from = 0;
    while let Some(i) = tag[from..].find(&needle) {
        let at = from + i;
        let boundary = tag[..at]
            .chars()
            .next_back()
            .is_none_or(|c| c.is_whitespace());
        if boundary {
            let vstart = at + needle.len();
            let vend = tag[vstart..].find('"')? + vstart;
            return Some(&tag[vstart..vend]);
        }
        from = at + needle.len();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(tag: &str) -> PathBuf {
        let mut d = std::env::temp_dir();
        d.push(format!("ncforge-cp-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn cleanup(d: &Path) {
        let _ = fs::remove_dir_all(d);
    }

    fn touch_class(dir: &Path) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join("A.class"), b"x").unwrap();
    }

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    /// 缺省 output 必须回落到 `kind="output"` 那行——它在文件最后，边扫边算就会漏。
    /// `pm` 的 `bin`（339 个 class）就是靠这条规则才进来。
    #[test]
    fn 缺省_output_回落到工程默认输出且保序去重() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<classpath>
	<classpathentry kind="src" output="cmp/classes" path="cmp/src/public"/>
	<classpathentry kind="src" output="cmp/classes" path="cmp/src/client"/>
	<classpathentry kind="src" path="uapbd/src/public"/>
	<classpathentry kind="src" path="uapbd/src/client"/>
	<classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/>
	<classpathentry kind="output" path="bin"/>
</classpath>"#;
        let cp = ProjectCp::parse(Path::new("D:/ws/pm"), xml);
        assert_eq!(cp.name, "pm");
        assert_eq!(cp.default_output, Some(PathBuf::from("bin")));
        assert_eq!(
            cp.outputs,
            vec![
                PathBuf::from("cmp/classes"),
                PathBuf::from("bin"), // 两条 src 共享同一个默认输出，只留一次
            ]
        );
        assert!(cp.refs.is_empty(), "本文件没有工程引用");
    }

    /// `path="/X"` 是工程引用不是源目录；`exported` 要原样保留。
    /// 引用顺序必须与文件里一致——顺序就是优先级（`pm` 要压过 `newar`）。
    #[test]
    fn 工程引用的顺序与_exported_原样保留() {
        let xml = r#"<classpath>
	<classpathentry kind="src" path="/newar" combineaccessrules="false" exported="true"/>
	<classpathentry kind="src" path="/zzz" combineaccessrules="false" exported="false"/>
	<classpathentry kind="output" path="bin"/>
</classpath>"#;
        let cp = ProjectCp::parse(Path::new("D:/ws/pm"), xml);
        assert_eq!(
            cp.refs,
            vec![
                CpRef {
                    name: "newar".into(),
                    exported: true
                },
                CpRef {
                    name: "zzz".into(),
                    exported: false
                },
            ]
        );
        // 没有 src 条目时默认输出仍然有效：Eclipse 会往这里编译，手工工程也常把
        // class 直接扔 bin。宁可多收一个存在的目录，也不要漏掉主工程自己的产物。
        assert_eq!(cp.outputs, vec![PathBuf::from("bin")]);
    }

    /// 端到端：主工程 9 → 直接依赖 8 → exported 传递 35 → NC home 兜底。
    /// 顺序 = `.classpath` 顺序，不是字典序（`pm/bin` 必须排在 `newar/out/uapbd` 之前）。
    #[test]
    fn 依赖闭包按_classpath_顺序展开且主工程在最前() {
        let base = temp_dir("closure");
        let ws = base.join("ws");
        let portal = ws.join("EyePortal");
        let pm = ws.join("pm");
        let newar = ws.join("newar");

        // EyePortal：2 个模块输出 + 引用 /pm（exported）
        touch_class(&portal.join("erm").join("classes"));
        touch_class(&portal.join("bin"));
        write(
            &portal.join(".classpath"),
            r#"<classpath>
	<classpathentry kind="src" output="erm/classes" path="erm/src/public"/>
	<classpathentry kind="src" path="avis/src/public"/>
	<classpathentry kind="src" path="/pm" exported="true"/>
	<classpathentry kind="output" path="bin"/>
</classpath>"#,
        );
        // pm：cmp/classes + 默认 bin + 引用 /newar（exported）
        touch_class(&pm.join("cmp").join("classes"));
        touch_class(&pm.join("bin"));
        write(
            &pm.join(".classpath"),
            r#"<classpath>
	<classpathentry kind="src" output="cmp/classes" path="cmp/src/public"/>
	<classpathentry kind="src" path="uapbd/src/public"/>
	<classpathentry kind="src" path="/newar" exported="true"/>
	<classpathentry kind="output" path="bin"/>
</classpath>"#,
        );
        // newar：out/uapbd + gl/classes，无引用
        touch_class(&newar.join("out").join("uapbd"));
        touch_class(&newar.join("gl").join("classes"));
        write(
            &newar.join(".classpath"),
            r#"<classpath>
	<classpathentry kind="src" output="out/uapbd" path="uapbd/src/public"/>
	<classpathentry kind="src" output="gl/classes" path="gl/src/public"/>
	<classpathentry kind="output" path="out/bin"/>
</classpath>"#,
        );

        // 未声明的兄弟工程：老实现会无条件收进来，新实现必须无视
        touch_class(&ws.join("TestBill").join("gl").join("classes"));

        let home = base.join("home");
        touch_class(&home.join("modules").join("gl").join("classes"));

        let dirs = class_roots(&portal, &home);
        let names: Vec<String> = dirs
            .iter()
            .map(|p| {
                p.strip_prefix(&ws)
                    .unwrap_or(p)
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect();

        assert_eq!(
            &names[..5],
            &[
                "EyePortal/erm/classes",
                "EyePortal/bin",
                // 直接依赖：pm 的输出，按 pm 的 .classpath 顺序
                "pm/cmp/classes",
                "pm/bin",
                // exported 传递：newar 的主工程段开头
                "newar/out/uapbd",
            ],
            "顺序错=同名类谁生效就错"
        );
        assert_eq!(
            dirs.last(),
            Some(&home.join("modules").join("gl").join("classes")),
            "NC home 永远最后兜底"
        );
        assert!(
            !names.iter().any(|n| n.contains("TestBill")),
            "未声明的兄弟工程不能进类路径：{names:?}"
        );
        cleanup(&base);
    }

    /// `exported="false"` 的边只走一层：能拿到对方的直接输出，拿不到对方的依赖。
    #[test]
    fn 非_exported_边不传递() {
        let base = temp_dir("noexport");
        let ws = base.join("ws");
        let a = ws.join("a");
        let b = ws.join("b");
        let c = ws.join("c");

        touch_class(&a.join("bin"));
        write(
            &a.join(".classpath"),
            r#"<classpath>
	<classpathentry kind="src" path="/b" exported="false"/>
	<classpathentry kind="output" path="bin"/>
</classpath>"#,
        );
        touch_class(&b.join("bin"));
        write(
            &b.join(".classpath"),
            r#"<classpath>
	<classpathentry kind="src" path="/c" exported="true"/>
	<classpathentry kind="output" path="bin"/>
</classpath>"#,
        );
        touch_class(&c.join("bin"));

        let dirs = class_roots(&a, &base.join("home"));
        assert!(dirs.contains(&b.join("bin")), "直接依赖要进：{dirs:?}");
        assert!(
            !dirs.contains(&c.join("bin")),
            "非 exported 不传递：{dirs:?}"
        );
        cleanup(&base);
    }

    /// 环（a→b→a）不能死循环，也不能把同一个工程收两遍。
    #[test]
    fn 依赖成环时不死循环() {
        let base = temp_dir("cycle");
        let ws = base.join("ws");
        let a = ws.join("a");
        let b = ws.join("b");
        for (p, other) in [(&a, "/b"), (&b, "/a")] {
            touch_class(&p.join("bin"));
            write(
                &p.join(".classpath"),
                &format!(
                    r#"<classpath>
	<classpathentry kind="src" path="{other}" exported="true"/>
	<classpathentry kind="output" path="bin"/>
</classpath>"#
                ),
            );
        }
        let dirs = class_roots(&a, &base.join("home"));
        let bins: Vec<&PathBuf> = dirs.iter().filter(|d| d.ends_with("bin")).collect();
        assert_eq!(bins.len(), 2, "只该有 a/bin 与 b/bin 各一次：{dirs:?}");
        cleanup(&base);
    }

    /// `newar` 的 `.project` 自称 `ar`，而 `/newar` 是目录名——先按目录名匹配才对。
    /// 反过来（先认 `.project`）会让本机 EyePortal 直接解析失败。
    #[test]
    fn 工程名解析_目录名优先_project_兜底() {
        let base = temp_dir("resolve");
        let ws = base.join("ws");
        // 目录名 newar，.project 名 ar
        touch_class(&ws.join("newar").join("bin"));
        write(
            &ws.join("newar").join(".project"),
            "<projectDescription><name>ar</name></projectDescription>",
        );
        assert_eq!(resolve_ref("newar", &ws), Some(ws.join("newar")));
        // 目录名不匹配时退到 .project 名
        assert_eq!(resolve_ref("ar", &ws), Some(ws.join("newar")));
        assert_eq!(resolve_ref("nonexistent", &ws), None);
        cleanup(&base);
    }

    /// 没有 `.classpath` 的老工程：保持原顺序，但要补上 `<根>/bin`（D0 漏点一）。
    #[test]
    fn 无_classpath_时走老规则并补扫_bin() {
        let base = temp_dir("legacy");
        let ws = base.join("ws");
        let proj = ws.join("old");
        touch_class(&proj.join("gl").join("classes"));
        touch_class(&proj.join("out").join("ic"));
        touch_class(&proj.join("bin"));
        touch_class(&ws.join("pm").join("phm").join("classes"));

        let dirs = class_roots(&proj, &base.join("home"));
        let names: Vec<String> = dirs
            .iter()
            .map(|p| {
                p.strip_prefix(&ws)
                    .unwrap_or(p)
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect();
        // 老顺序：模块 classes → out/*；bin 追加在自己那一段的末尾；兄弟排其后
        assert_eq!(
            names,
            vec!["old/gl/classes", "old/out/ic", "old/bin", "pm/phm/classes",]
        );
        cleanup(&base);
    }

    /// 属性抽取不能被 `output="…"` 里的 `path`/子串带偏，也不能漏掉多空格写法。
    #[test]
    fn 属性抽取按空白边界匹配() {
        let tag = r#"<classpathentry  kind="src"   output="a/b" path="x/y" exported="true">"#;
        assert_eq!(attr(tag, "kind"), Some("src"));
        assert_eq!(attr(tag, "output"), Some("a/b"));
        assert_eq!(attr(tag, "path"), Some("x/y"));
        assert_eq!(attr(tag, "exported"), Some("true"));
        assert_eq!(attr(tag, "nope"), None);
        // `path=` 不能命中 `output=` 的尾巴
        let only_output = r#"<classpathentry kind="src" output="o/p"/>"#;
        assert_eq!(attr(only_output, "path"), None);
    }

    #[test]
    fn location_uri_解析() {
        assert_eq!(
            location_path("URI//file:/C:/work/aier/newar"),
            Some(PathBuf::from("C:/work/aier/newar"))
        );
        assert_eq!(
            location_path("URI//file:///C:/work/aier/newar"),
            Some(PathBuf::from("C:/work/aier/newar"))
        );
        // 百分号编码：空格不解码就找不到目录
        assert_eq!(
            location_path("URI//file:/C:/Program%20Files/p"),
            Some(PathBuf::from("C:/Program Files/p"))
        );
        assert_eq!(location_path("garbage"), None);
    }
}
