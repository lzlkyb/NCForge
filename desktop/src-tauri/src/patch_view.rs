//! 补丁出包规则 —— 纯逻辑，不落盘。
//!
//! 规则来源是 `D:\AItool\aiwork\nc-patch\build-nc-patch.sh`（363 行、可运行、已出过十几个
//! 正式包）。这个文件只做「路径 → 落位」「基线 → 增删行数 / 涉及方法」的推导与文本拼装；
//! 真正扫磁盘、复制、打 zip 在 `patch_build.rs`。
//!
//! 之所以把规则单独拆出来：出一次包要几十秒，规则错了只能靠人眼看 zip 才发现，
//! 而「层判错」意味着补丁装到服务器上根本不生效——代价远高于一个单测。

use std::path::PathBuf;
use std::sync::OnceLock;

use serde::Serialize;

/// 规范化：反斜杠→正斜杠，盘符转小写由调用方决定（这里只统一分隔符）。
///
/// 脚本用 `sed 's|\\|/|g; s|^\([A-Za-z]\):|/\L\1|'` 同时把 `C:` 变成 `/c`；
/// 我们用 `PathBuf` 表示根，不需要 MSYS 风格，只统一分隔符。
pub fn norm(p: &str) -> String {
    p.replace('\\', "/")
}

/// 文件在 zip 里的落位段，与脚本的 `sec` 一一对应。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Section {
    Public,
    Private,
    Client,
    Upm,
    Hotwebs,
}

impl Section {
    pub fn as_str(self) -> &'static str {
        match self {
            Section::Public => "public",
            Section::Private => "private",
            Section::Client => "client",
            Section::Upm => "upm",
            Section::Hotwebs => "hotwebs",
        }
    }

    /// 源码段（需要编译产物）；upm / hotwebs 是整文件替换。
    pub fn needs_class(self) -> bool {
        matches!(self, Section::Public | Section::Private | Section::Client)
    }
}

/// 解析结果：源码根 / 模块 / 段 / 包内相对路径。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Parsed {
    /// 源码根（`.../newar`）。hotwebs 推不出来，为空。
    pub root: PathBuf,
    pub module: String,
    pub section: Section,
    /// 包内相对路径，含文件名：`nc/bs/ic/eye/Foo.java`。
    pub pkg_rel: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum ParseError {
    /// 不在 `src/public|private|client` 下，也不是 upm / hotwebs。
    NotInSrc,
    /// upm 必须直接放在 `<模块>/META-INF/` 下。
    UpmNotAtModuleRoot,
    /// 没有模块段（例如 `<根>/src/public/x.java`）。
    NoModule,
}

impl ParseError {
    pub fn message(&self) -> String {
        match self {
            ParseError::NotInSrc => "路径里必须含 /src/public/ 、/src/private/ 、/src/client/ ，\
                 或是 <模块>/META-INF/*.upm 、.../hotwebs/..."
                .to_string(),
            ParseError::UpmNotAtModuleRoot => "upm 必须直接在 <模块>/META-INF/ 下".to_string(),
            ParseError::NoModule => "路径里没有模块名（<源码根>/<模块>/src/<段>/…）".to_string(),
        }
    }
}

/// 解析一个文件的落位。判定顺序与脚本一致：先 src 三段，再 upm，最后 hotwebs。
pub fn parse_path(raw: &str) -> Result<Parsed, ParseError> {
    let p = norm(raw);

    // /src/public/ 这类分隔符的第一个出现处，等价于 bash 的 ${p%%/src/$sec/*}
    for (tag, section) in [
        ("/src/public/", Section::Public),
        ("/src/private/", Section::Private),
        ("/src/client/", Section::Client),
    ] {
        if let Some(idx) = p.find(tag) {
            let before = &p[..idx];
            let rest = &p[idx + tag.len()..];
            if rest.is_empty() {
                return Err(ParseError::NotInSrc);
            }
            let (root, module) = split_module(before)?;
            return Ok(Parsed {
                root,
                module,
                section,
                pkg_rel: rest.to_string(),
            });
        }
    }

    // upm：<源码根>/<模块>/META-INF/xxx.upm，且 META-INF 后不能再有子目录
    if p.to_lowercase().ends_with(".upm") {
        if let Some(idx) = p.rfind("/META-INF/") {
            let rest = &p[idx + "/META-INF/".len()..];
            if rest.contains('/') {
                return Err(ParseError::UpmNotAtModuleRoot);
            }
            let (root, module) = split_module(&p[..idx])?;
            return Ok(Parsed {
                root,
                module,
                section: Section::Upm,
                pkg_rel: rest.to_string(),
            });
        }
    }

    // hotwebs：任意路径下 .../hotwebs/<相对路径>，来自 NC home，不参与「同一源码根」检查
    if let Some(idx) = p.find("/hotwebs/") {
        let rest = &p[idx + "/hotwebs/".len()..];
        if !rest.is_empty() {
            return Ok(Parsed {
                root: PathBuf::new(),
                module: "hotwebs".to_string(),
                section: Section::Hotwebs,
                pkg_rel: rest.to_string(),
            });
        }
    }

    Err(ParseError::NotInSrc)
}

/// `.../newar/ic` → (root=`.../newar`, module=`ic`)
fn split_module(before: &str) -> Result<(PathBuf, String), ParseError> {
    let trimmed = before.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(i) => {
            let module = &trimmed[i + 1..];
            if module.is_empty() {
                return Err(ParseError::NoModule);
            }
            Ok((PathBuf::from(&trimmed[..i]), module.to_string()))
        }
        None => Err(ParseError::NoModule),
    }
}

/// 这四个模块的层默认是 hyext，脚本明确「不查 jar」。
pub const DEFAULT_HYEXT_MODULES: [&str; 4] = ["ic", "pu", "so", "arap"];

pub fn is_default_hyext(module: &str) -> bool {
    DEFAULT_HYEXT_MODULES
        .iter()
        .any(|m| m.eq_ignore_ascii_case(module))
}

/// zip 内的目录（不带文件名，结尾无斜杠）。
///
/// ```text
/// public  → replacement/modules/<mod>/[hyext/]classes/<pkgdir>
/// private → replacement/modules/<mod>/META-INF/[hyext/]classes/<pkgdir>
/// client  → replacement/modules/<mod>/client/[hyext/]classes/<pkgdir>
/// upm     → replacement/modules/<mod>/META-INF
/// hotwebs → replacement/hotwebs/<pkgdir>
/// ```
pub fn target_dir(module: &str, section: Section, hyext: bool, pkg_dir: &str) -> String {
    let layer = if hyext { "hyext/" } else { "" };
    let pkg = pkg_dir.trim_matches('/');
    match section {
        Section::Public => join(&format!("replacement/modules/{module}/{layer}classes"), pkg),
        Section::Private => join(
            &format!("replacement/modules/{module}/META-INF/{layer}classes"),
            pkg,
        ),
        Section::Client => join(
            &format!("replacement/modules/{module}/client/{layer}classes"),
            pkg,
        ),
        Section::Upm => format!("replacement/modules/{module}/META-INF"),
        Section::Hotwebs => join("replacement/hotwebs", pkg),
    }
}

fn join(base: &str, tail: &str) -> String {
    if tail.is_empty() {
        base.to_string()
    } else {
        format!("{base}/{tail}")
    }
}

/// `a/b/C.java` → `a/b`；无目录时返回空串。
pub fn pkg_dir_of(pkg_rel: &str) -> String {
    match pkg_rel.rfind('/') {
        Some(i) => pkg_rel[..i].to_string(),
        None => String::new(),
    }
}

/// `a/b/C.java` → `C`（不含扩展名）；`a/b/x.xml` → `x`。
pub fn stem_of(pkg_rel: &str) -> String {
    let name = pkg_rel.rsplit('/').next().unwrap_or(pkg_rel);
    match name.rfind('.') {
        Some(i) => name[..i].to_string(),
        None => name.to_string(),
    }
}

/// `.java` 对应的 class 条目名（`nc/bs/C.java` → `nc/bs/C.class`）。
pub fn class_entry(pkg_rel: &str) -> Option<String> {
    if pkg_rel.to_lowercase().ends_with(".java") {
        Some(format!("{}.class", &pkg_rel[..pkg_rel.len() - 5]))
    } else {
        None
    }
}

/// 补丁包文件名：`<描述>_<年月日>.zip`。描述里的路径分隔符会毁掉文件名，替换掉。
pub fn zip_file_name(desc: &str, yyyymmdd: &str) -> String {
    let safe: String = desc
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c => c,
        })
        .collect();
    let safe = safe.trim();
    let safe = if safe.is_empty() { "补丁" } else { safe };
    format!("{safe}_{yyyymmdd}.zip")
}

// ───────────────────────────── 代码改动统计 ─────────────────────────────

/// 按 `\n` 切行并去掉行尾 `\r`：NC 源码是 CRLF，SVN 基线也是，
/// 不剥掉的话「只改了换行」会被算成整文件重写。
fn split_lines(data: &[u8]) -> Vec<&[u8]> {
    // 空文件必须是 0 行：`b"".split()` 会给一个空 slice，直接用会让
    // 「新增文件」凭空多出 1 行删除。
    if data.is_empty() {
        return Vec::new();
    }
    let mut parts: Vec<&[u8]> = data.split(|b| *b == b'\n').collect();
    if data.last() == Some(&b'\n') {
        parts.pop();
    }
    parts
        .into_iter()
        .map(|l| match l.last() {
            Some(b'\r') => &l[..l.len() - 1],
            _ => l,
        })
        .collect()
}

/// 增删行数。按 diff 算子统计（脚本是数 `^+` / `^-` 行，遇到代码本身以 `++` 开头会少算一行；
/// 这里按 real diff 的长度算，更准）。
pub fn count_changes(base: &[u8], working: &[u8]) -> (usize, usize) {
    let old = split_lines(base);
    let new = split_lines(working);
    let ops = similar::capture_diff_slices(similar::Algorithm::Myers, &old, &new);
    let mut add = 0usize;
    let mut del = 0usize;
    for op in ops {
        if op.tag() == similar::DiffTag::Equal {
            continue;
        }
        del += op.old_range().len();
        add += op.new_range().len();
    }
    (add, del)
}

fn method_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| {
        // 与脚本 diff -F 的 METHOD_RE 等价：这几个修饰词开头、不是赋值/声明结尾、带左括号
        regex::Regex::new(r"^\s*(public|private|protected|static|void|boolean|String)[^=;]*\(")
            .expect("方法签名正则不该编译失败")
    })
}

/// 从 `from` 行往上找最近的方法签名（跳过注释行与非 ASCII 行）。
fn method_at(lines: &[&[u8]], from: usize) -> Option<String> {
    let mut i = from.min(lines.len());
    while i > 0 {
        i -= 1;
        let line = lines[i];
        // 脚本用 LC_ALL=C grep -v '[^ -~]' 过滤掉非 ASCII 行：GBK 注释解不成 UTF-8，
        // 但方法签名本身是 ASCII，所以这一步只会滤掉注释与中文字符串。
        if !line.is_ascii() {
            continue;
        }
        let text = String::from_utf8_lossy(line);
        let t = text.trim();
        if t.is_empty() || t.starts_with("//") || t.starts_with('*') || t.starts_with("/*") {
            continue;
        }
        if method_re().is_match(&text) {
            // 去掉行首缩进与行尾的 `{`，跟脚本的 sed 一致
            let cleaned = text.trim().trim_end_matches('{').trim_end();
            return Some(cleaned.to_string());
        }
    }
    None
}

/// 每处改动「所属的方法」。脚本借 `diff -F` 的 hunk 头，但 hunk 头有长度上限会截断
/// （真实包里就有 `private String getFirstRowMaterial(SaleO` 这种半截）；
/// 这里直接回原文向上扫，拿到完整签名。
pub fn methods_touched(base: &[u8], working: &[u8]) -> Vec<String> {
    let old = split_lines(base);
    let new = split_lines(working);
    let ops = similar::capture_diff_slices(similar::Algorithm::Myers, &old, &new);
    let mut out: Vec<String> = Vec::new();
    for op in ops {
        if op.tag() == similar::DiffTag::Equal {
            continue;
        }
        // 锚点取新文本里的位置（工作副本才是当前状态）；整份删空时退回旧文本
        let (source, anchor) = if new.is_empty() {
            (&old, op.old_range().start)
        } else {
            (&new, op.new_range().start.min(new.len()))
        };
        if let Some(m) = method_at(source, anchor) {
            if !out.contains(&m) {
                out.push(m);
            }
        }
        if out.len() >= 40 {
            break;
        }
    }
    out
}

/// upm 的组件增删：`<interface>xxx</interface>`。
pub fn upm_interface_changes(base: &[u8], working: &[u8]) -> (Vec<String>, Vec<String>) {
    let old_names: Vec<String> = split_lines(base)
        .iter()
        .filter_map(|l| interface_of(l))
        .collect();
    let new_names: Vec<String> = split_lines(working)
        .iter()
        .filter_map(|l| interface_of(l))
        .collect();
    let added = new_names
        .iter()
        .filter(|n| !old_names.contains(n))
        .cloned()
        .collect();
    let removed = old_names
        .iter()
        .filter(|n| !new_names.contains(n))
        .cloned()
        .collect();
    (added, removed)
}

fn interface_of(line: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(line);
    let start = text.find("<interface>")? + "<interface>".len();
    let rest = &text[start..];
    let end = rest.find("</interface>")?;
    let name = rest[..end].trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

// ───────────────────────────── CHANGES.md ─────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MdKind {
    /// src 下的源码（要算增删行与方法）
    Source,
    /// <模块>/META-INF/*.upm（整文件替换，列组件增删）
    Upm,
    /// hotwebs 下的网页文件（无 SVN 基线）
    Hotwebs,
}

#[derive(Debug, Clone)]
pub struct MdEntry {
    /// 展示用路径：`ic/private/nc/bs/X.java` / `ic/META-INF/x.upm` / `hotwebs/a/b.jsp`
    pub label: String,
    pub kind: MdKind,
    /// 落位层说明（只有 Source 有）
    pub layer_note: Option<String>,
    /// SVN 基线；None = 新增文件或读不到 `.svn-base`
    pub base: Option<Vec<u8>>,
    pub working: Vec<u8>,
}

/// 拼出 CHANGES.md。`note` 是用户手写的功能说明（原样放最前面）。
pub fn build_changes_md(note: &str, date: &str, entries: &[MdEntry], sqls: &[String]) -> String {
    let mut s = String::new();
    let head = note.replace("\r\n", "\n");
    if head.trim().is_empty() {
        s.push_str("# 补丁修改说明\n");
    } else {
        s.push_str(head.trim_end());
        s.push('\n');
    }
    s.push_str("\n## 代码改动（打包时对比 SVN 基线自动生成）\n\n");
    s.push_str(&format!("- 打包日期：{date}\n\n"));

    let layers: Vec<&MdEntry> = entries
        .iter()
        .filter(|e| e.layer_note.is_some() && e.kind == MdKind::Source)
        .collect();
    if !layers.is_empty() {
        s.push_str("- 落位层（按 NC home 原始 jar 判定）：\n");
        for e in layers {
            s.push_str(&format!(
                "  - {} → {}\n",
                e.label,
                e.layer_note.as_deref().unwrap_or("")
            ));
        }
        s.push('\n');
    }

    for e in entries {
        match e.kind {
            MdKind::Hotwebs => {
                s.push_str(&format!(
                    "- {} —— 部署到 NC home 的网页文件（无 SVN 基线）\n",
                    e.label
                ));
                continue;
            }
            MdKind::Source | MdKind::Upm => {}
        }
        let Some(base) = e.base.as_deref() else {
            s.push_str(&format!(
                "- {} —— 新增文件，或无 SVN 基线无法对比\n",
                e.label
            ));
            continue;
        };
        if base == e.working.as_slice() {
            s.push_str(&format!("- {} —— 与 SVN 基线一致（无改动）\n", e.label));
            continue;
        }
        let (add, del) = count_changes(base, &e.working);
        s.push_str(&format!("- {} —— 新增 {add} 行 / 删除 {del} 行\n", e.label));
        match e.kind {
            MdKind::Source => {
                for m in methods_touched(base, &e.working) {
                    s.push_str(&format!("  - 涉及方法：`{m}`\n"));
                }
            }
            MdKind::Upm => {
                let (added, removed) = upm_interface_changes(base, &e.working);
                for name in added {
                    s.push_str(&format!("  - 新增组件：`{name}`\n"));
                }
                for name in removed {
                    s.push_str(&format!("  - 删除组件：`{name}`\n"));
                }
            }
            MdKind::Hotwebs => {}
        }
    }

    for sql in sqls {
        s.push_str(&format!("- SQL（需人工执行，时机见上文影响范围）：{sql}\n"));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> Parsed {
        parse_path(s).expect("应当能解析")
    }

    #[test]
    fn 解析三段路径与根() {
        let r = p(r"C:\work\aier\newar\ic\src\private\nc\bs\ic\eye\Foo.java");
        assert_eq!(r.root, PathBuf::from("C:/work/aier/newar"));
        assert_eq!(r.module, "ic");
        assert_eq!(r.section, Section::Private);
        assert_eq!(r.pkg_rel, "nc/bs/ic/eye/Foo.java");

        let r = p("/c/work/aier/newar/uapbd/src/public/nc/itf/util/Util.java");
        assert_eq!(r.module, "uapbd");
        assert_eq!(r.section, Section::Public);
        assert_eq!(r.pkg_rel, "nc/itf/util/Util.java");

        let r = p(r"C:\ws\ic\src\client\nc\ui\H.java");
        assert_eq!(r.section, Section::Client);
        assert_eq!(r.pkg_rel, "nc/ui/H.java");
    }

    #[test]
    fn 解析_upm_与_hotwebs() {
        let r = p(r"C:\ws\ic\META-INF\aier.upm");
        assert_eq!(r.section, Section::Upm);
        assert_eq!(r.module, "ic");
        assert_eq!(r.pkg_rel, "aier.upm");
        assert_eq!(r.root, PathBuf::from("C:/ws"));

        // upm 必须在模块根下的 META-INF，再深一层就拒
        assert_eq!(
            parse_path(r"C:\ws\ic\META-INF\sub\aier.upm"),
            Err(ParseError::UpmNotAtModuleRoot)
        );

        let r = p(r"D:\ncc\1909home\hotwebs\eyeportal\order.jsp");
        assert_eq!(r.section, Section::Hotwebs);
        assert_eq!(r.module, "hotwebs");
        assert_eq!(r.pkg_rel, "eyeportal/order.jsp");
        assert!(r.root.as_os_str().is_empty());
    }

    #[test]
    fn 拒绝无法解析的路径() {
        assert_eq!(
            parse_path(r"C:\ws\ic\src\test\Foo.java"),
            Err(ParseError::NotInSrc)
        );
        assert_eq!(parse_path(r"C:\ws\random.txt"), Err(ParseError::NotInSrc));
    }

    #[test]
    fn 默认_hyext_模块() {
        assert!(is_default_hyext("ic"));
        assert!(is_default_hyext("PU"));
        assert!(is_default_hyext("so"));
        assert!(is_default_hyext("arap"));
        assert!(!is_default_hyext("uapbd"));
        assert!(!is_default_hyext("baseapp"));
    }

    #[test]
    fn 落位目录逐段对齐脚本() {
        assert_eq!(
            target_dir("ic", Section::Public, true, "nc/bs"),
            "replacement/modules/ic/hyext/classes/nc/bs"
        );
        assert_eq!(
            target_dir("ic", Section::Private, true, "nc/bs"),
            "replacement/modules/ic/META-INF/hyext/classes/nc/bs"
        );
        assert_eq!(
            target_dir("ic", Section::Client, true, "nc/ui"),
            "replacement/modules/ic/client/hyext/classes/nc/ui"
        );
        assert_eq!(
            target_dir("uapbd", Section::Public, false, "nc/itf/util"),
            "replacement/modules/uapbd/classes/nc/itf/util"
        );
        assert_eq!(
            target_dir("ic", Section::Upm, false, ""),
            "replacement/modules/ic/META-INF"
        );
        assert_eq!(
            target_dir("hotwebs", Section::Hotwebs, false, "eyeportal"),
            "replacement/hotwebs/eyeportal"
        );
        // 根下的文件（无包目录）
        assert_eq!(
            target_dir("ic", Section::Public, false, ""),
            "replacement/modules/ic/classes"
        );
    }

    #[test]
    fn 文件名与类名推导() {
        assert_eq!(pkg_dir_of("nc/bs/Foo.java"), "nc/bs");
        assert_eq!(pkg_dir_of("Foo.java"), "");
        assert_eq!(stem_of("nc/bs/Foo.java"), "Foo");
        assert_eq!(stem_of("a/b/c.xml"), "c");
        assert_eq!(
            class_entry("nc/bs/Foo.java"),
            Some("nc/bs/Foo.class".to_string())
        );
        assert_eq!(class_entry("a/b/x.xml"), None);
    }

    #[test]
    fn 包名过滤非法字符且补默认名() {
        assert_eq!(
            zip_file_name("库存借出/借入改造", "20261028"),
            "库存借出_借入改造_20261028.zip"
        );
        assert_eq!(zip_file_name("   ", "20261028"), "补丁_20261028.zip");
    }

    #[test]
    fn 增删行数按真实差异统计() {
        let base = b"a\nb\nc\nd\n";
        let work = b"a\nB\nc\nd\ne\n";
        // b→B 是 1 删 1 增，末尾加一行 e
        assert_eq!(count_changes(base, work), (2, 1));
        // 完全一致
        assert_eq!(count_changes(base, base), (0, 0));
        // 只改换行符：CRLF 与 LF 视为同一行，不算改动
        assert_eq!(count_changes(b"a\nb\n", b"a\r\nb\r\n"), (0, 0));
        // 新增文件（基线为空）
        assert_eq!(count_changes(b"", b"a\nb\n"), (2, 0));
    }

    #[test]
    fn 涉及方法向上取最近签名() {
        let base = "\
package x;

public class A {
    public void one() {
        int a = 1;
    }

    private String two(int v) {
        return \"a\";
    }
}
";
        // 把 two 里的返回改掉 → 应当识别到 two
        let work = base.replace("return \"a\";", "return \"b\";");
        let ms = methods_touched(base.as_bytes(), work.as_bytes());
        assert_eq!(ms, vec!["private String two(int v)".to_string()]);

        // 改 one 里的语句 → 识别到 one，且不带行尾的 `{`
        let work = base.replace("int a = 1;", "int a = 2;");
        assert_eq!(
            methods_touched(base.as_bytes(), work.as_bytes()),
            vec!["public void one()".to_string()]
        );
    }

    #[test]
    fn 方法识别跳过中文注释行() {
        // GBK 注释不是合法 UTF-8；不应把它当成方法签名
        let mut base = Vec::new();
        base.extend_from_slice(b"class A {\n");
        base.extend_from_slice(b"    // \xd6\xd0\xce\xc4\xd7\xa2\xca\xcd\n"); // GBK「中文注释」
        base.extend_from_slice(b"    public void run() {\n        int x = 1;\n    }\n}\n");
        let work = String::from_utf8_lossy(&base).replace("int x = 1;", "int x = 2;");
        let ms = methods_touched(&base, work.as_bytes());
        assert_eq!(ms, vec!["public void run()".to_string()]);
    }

    #[test]
    fn upm_组件增删() {
        let base = b"<module><interface>a.Foo</interface></module>";
        let work = b"<module><interface>a.Bar</interface></module>";
        let (add, del) = upm_interface_changes(base, work);
        assert_eq!(add, vec!["a.Bar".to_string()]);
        assert_eq!(del, vec!["a.Foo".to_string()]);
    }

    #[test]
    fn changes_md_结构与真实包一致() {
        let entries = vec![
            MdEntry {
                label: "ic/private/nc/X.java".into(),
                kind: MdKind::Source,
                layer_note: Some("hyext（默认模块 ic,不查 jar）".into()),
                base: Some(b"a\nb\n".to_vec()),
                working: b"a\nB\n".to_vec(),
            },
            MdEntry {
                label: "ic/private/nc/New.java".into(),
                kind: MdKind::Source,
                layer_note: Some("hyext（默认模块 ic,不查 jar）".into()),
                base: None,
                working: b"x\n".to_vec(),
            },
            MdEntry {
                label: "hotwebs/p/o.jsp".into(),
                kind: MdKind::Hotwebs,
                layer_note: None,
                base: None,
                working: b"<html>".to_vec(),
            },
        ];
        let md = build_changes_md(
            "功能说明一段\n\n## 影响范围\n无\n",
            "2026-10-28",
            &entries,
            &["x.sql".to_string()],
        );
        assert!(md.starts_with("功能说明一段"));
        assert!(md.contains("## 代码改动（打包时对比 SVN 基线自动生成）"));
        assert!(md.contains("- 打包日期：2026-10-28"));
        assert!(md.contains("  - ic/private/nc/X.java → hyext（默认模块 ic,不查 jar）"));
        assert!(md.contains("- ic/private/nc/X.java —— 新增 1 行 / 删除 1 行"));
        assert!(md.contains("- ic/private/nc/New.java —— 新增文件，或无 SVN 基线无法对比"));
        assert!(md.contains("- hotwebs/p/o.jsp —— 部署到 NC home 的网页文件（无 SVN 基线）"));
        assert!(md.contains("- SQL（需人工执行，时机见上文影响范围）：x.sql"));
        // 空说明回落到标题
        let md2 = build_changes_md("", "2026-10-28", &[], &[]);
        assert!(md2.starts_with("# 补丁修改说明"));
    }
}
