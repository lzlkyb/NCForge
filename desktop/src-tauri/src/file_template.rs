//! 新建 Java 文件时写入的骨架：包名按所在源码根推出，类名取文件名，换行符跟随同目录现有文件。
//!
//! 只写 ASCII：骨架里不放中文注释，这样无论工程是 GBK 还是 UTF-8，写出去的字节都一样，
//! 不会造成「编码写错」。换行符不同（aier 的 Java 源码多是 CRLF），所以必须探测。
//!
//! NC 标准件（后台插件等）的签名都对照过本仓 `C:\work\aier\newar` 里的真实写法，不凭记忆写。

use std::path::{Path, PathBuf};

/// 可选的骨架种类。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JavaKind {
    Class,
    Interface,
    Enum,
    /// NC 后台任务插件：`implements IBackgroundWorkPlugin`。
    #[serde(rename = "bgplugin")]
    BgPlugin,
}

/// 源码根下有意义的作用域目录。
const SCOPES: [&str; 4] = ["public", "client", "private", "test"];

fn is_ident(s: &str) -> bool {
    let mut chars = s.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_' || c == '$')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

const KEYWORDS: [&str; 20] = [
    "abstract",
    "class",
    "default",
    "enum",
    "final",
    "import",
    "int",
    "interface",
    "native",
    "new",
    "null",
    "package",
    "private",
    "protected",
    "public",
    "static",
    "switch",
    "this",
    "void",
    "while",
];

/// `dir` 所在的包名。按「最后一个 `src`」切分：`src/<作用域>/…` 或 `src/main|test/java/…` 之后的部分；
/// 目录就是源码根本身、找不到 `src`、或有段不是合法标识符时返回 `None`（写默认包）。
pub fn package_of_dir(dir: &Path) -> Option<String> {
    let parts: Vec<String> = dir
        .components()
        .filter_map(|c| match c {
            std::path::Component::Normal(s) => Some(s.to_string_lossy().to_string()),
            _ => None,
        })
        .collect();
    let src = parts.iter().rposition(|p| p.eq_ignore_ascii_case("src"))?;
    let mut start = src + 1;
    let scope = parts.get(start)?;
    if SCOPES.iter().any(|s| scope.eq_ignore_ascii_case(s)) {
        start += 1;
    } else if (scope.eq_ignore_ascii_case("main") || scope.eq_ignore_ascii_case("test"))
        && parts
            .get(start + 1)
            .is_some_and(|p| p.eq_ignore_ascii_case("java"))
    {
        start += 2;
    }
    let pkg = &parts[start.min(parts.len())..];
    if pkg.is_empty()
        || pkg
            .iter()
            .any(|p| !is_ident(p) || KEYWORDS.contains(&p.as_str()))
    {
        return None;
    }
    Some(pkg.join("."))
}

/// 同目录（不够就沿父目录往上找几层）现有 `.java` 的换行符：多数 CRLF 就 CRLF，否则 LF；
/// 一个样本都找不到时按 CRLF（Windows 工程惯例，与 `workspace::detect_eol` 的缺省一致）。
pub fn detect_dir_eol(dir: &Path) -> &'static str {
    let (mut crlf, mut lf, mut seen) = (0usize, 0usize, 0usize);
    let mut cur: Option<PathBuf> = Some(dir.to_path_buf());
    for _ in 0..4 {
        let Some(d) = cur else { break };
        if let Ok(rd) = std::fs::read_dir(&d) {
            for e in rd.flatten() {
                let p = e.path();
                if !p.is_file()
                    || p.extension()
                        .is_none_or(|x| !x.eq_ignore_ascii_case("java"))
                {
                    continue;
                }
                let Ok(bytes) = read_head(&p) else { continue };
                let (c, l) = count_eol(&bytes);
                if c + l == 0 {
                    continue;
                }
                if c >= l {
                    crlf += 1;
                } else {
                    lf += 1;
                }
                seen += 1;
                if seen >= 5 {
                    break;
                }
            }
        }
        if seen > 0 {
            break;
        }
        cur = d.parent().map(Path::to_path_buf);
    }
    if lf > crlf {
        "\n"
    } else {
        "\r\n"
    }
}

fn read_head(p: &Path) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let mut buf = Vec::new();
    std::fs::File::open(p)?
        .take(64 * 1024)
        .read_to_end(&mut buf)?;
    Ok(buf)
}

/// 返回 (CRLF 个数, 孤立 LF 个数)。
fn count_eol(bytes: &[u8]) -> (usize, usize) {
    let (mut crlf, mut lf) = (0, 0);
    for (i, b) in bytes.iter().enumerate() {
        if *b == b'\n' {
            if i > 0 && bytes[i - 1] == b'\r' {
                crlf += 1;
            } else {
                lf += 1;
            }
        }
    }
    (crlf, lf)
}

/// 按文件名猜一个默认种类：NC 的接口都叫 `IXxx`，其余当类。
pub fn guess_kind(stem: &str) -> JavaKind {
    let mut c = stem.chars();
    if c.next() == Some('I') && c.next().is_some_and(|x| x.is_ascii_uppercase()) {
        JavaKind::Interface
    } else {
        JavaKind::Class
    }
}

/// 渲染骨架。`eol` 是 `"\n"` 或 `"\r\n"`；最后以一个换行结尾。
pub fn render_java(kind: JavaKind, name: &str, package: Option<&str>, eol: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    if let Some(p) = package {
        lines.push(format!("package {p};"));
        lines.push(String::new());
    }
    match kind {
        JavaKind::Class => {
            lines.push(format!("public class {name} {{"));
            lines.push(String::new());
            lines.push("}".into());
        }
        JavaKind::Interface => {
            lines.push(format!("public interface {name} {{"));
            lines.push(String::new());
            lines.push("}".into());
        }
        JavaKind::Enum => {
            lines.push(format!("public enum {name} {{"));
            lines.push(String::new());
            lines.push("}".into());
        }
        JavaKind::BgPlugin => {
            // 签名对照 newar 里的真实插件（ali/GenerateLXJTandDYJTPlugin、aim/WarConSysPlugin）
            lines.push("import nc.bs.pub.pa.PreAlertObject;".into());
            lines.push("import nc.bs.pub.taskcenter.BgWorkingContext;".into());
            lines.push("import nc.bs.pub.taskcenter.IBackgroundWorkPlugin;".into());
            lines.push("import nc.vo.pub.BusinessException;".into());
            lines.push(String::new());
            lines.push(format!(
                "public class {name} implements IBackgroundWorkPlugin {{"
            ));
            lines.push(String::new());
            lines.push("\t@Override".into());
            lines.push(
                "\tpublic PreAlertObject executeTask(BgWorkingContext bgwc) throws BusinessException {"
                    .into(),
            );
            lines.push("\t\treturn null;".into());
            lines.push("\t}".into());
            lines.push(String::new());
            lines.push("}".into());
        }
    }
    let mut out = lines.join(eol);
    out.push_str(eol);
    out
}

/// 「在文件树里新建 `X.java`」时要写进去的内容；不是普通类名的文件（`package-info`、小写开头、不是 `.java`）返回 `None`，维持空文件。
pub fn skeleton_for_new_file(parent: &Path, file_name: &str) -> Option<String> {
    let stem = file_name.strip_suffix(".java")?;
    if !is_ident(stem)
        || KEYWORDS.contains(&stem)
        || !stem.starts_with(|c: char| c.is_ascii_uppercase())
    {
        return None;
    }
    let pkg = package_of_dir(parent);
    Some(render_java(
        guess_kind(stem),
        stem,
        pkg.as_deref(),
        detect_dir_eol(parent),
    ))
}

/// 「新建 Java 类型」对话框的预览：包名、将写入的内容、换行符，以及不能创建的原因。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JavaPreview {
    /// 由目录推出的包名；`None` = 写入默认包。
    pub package: Option<String>,
    pub file_name: String,
    /// 将写入文件的内容（有 `error` 时为空）。
    pub text: String,
    /// `"CRLF"` 或 `"LF"`（跟随同目录现有文件）。
    pub eol: String,
    pub error: Option<String>,
}

/// 类名是否能建：大写字母开头、只含字母数字下划线美元符、不是关键字。
fn check_type_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("请输入名字".into());
    }
    if !is_ident(name)
        || KEYWORDS.contains(&name)
        || !name.starts_with(|c: char| c.is_ascii_uppercase())
    {
        return Err("名字需以大写字母开头，只含字母、数字、下划线".into());
    }
    Ok(())
}

pub fn preview(parent: &Path, name: &str, kind: JavaKind) -> JavaPreview {
    let file_name = format!("{name}.java");
    let package = package_of_dir(parent);
    let eol = detect_dir_eol(parent);
    let eol_label = if eol == "\n" { "LF" } else { "CRLF" }.to_string();
    let error = check_type_name(name).err().or_else(|| {
        parent
            .join(&file_name)
            .exists()
            .then(|| format!("该目录下已有 {file_name}"))
    });
    let text = if error.is_none() {
        render_java(kind, name, package.as_deref(), eol)
    } else {
        String::new()
    };
    JavaPreview {
        package,
        file_name,
        text,
        eol: eol_label,
        error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    #[test]
    fn 包名按最后一个_src_和作用域切分() {
        assert_eq!(
            package_of_dir(&p("C:/work/aier/newar/aim/src/private/nc/bs/pub/plguin")).as_deref(),
            Some("nc.bs.pub.plguin")
        );
        // 绝对路径里早先出现的 src 不干扰
        assert_eq!(
            package_of_dir(&p("D:/src/ws/gl/src/client/nc/ui/gl")).as_deref(),
            Some("nc.ui.gl")
        );
        assert_eq!(
            package_of_dir(&p("proj/src/main/java/com/acme")).as_deref(),
            Some("com.acme")
        );
        // 没有作用域的普通 src
        assert_eq!(
            package_of_dir(&p("proj/src/com/acme")).as_deref(),
            Some("com.acme")
        );
    }

    #[test]
    fn 源码根本身和非法段都不猜包名() {
        assert_eq!(package_of_dir(&p("gl/src/public")), None);
        assert_eq!(package_of_dir(&p("gl/src")), None);
        assert_eq!(package_of_dir(&p("gl/resources/x")), None);
        assert_eq!(package_of_dir(&p("gl/src/public/nc/my-pkg")), None);
        assert_eq!(package_of_dir(&p("gl/src/public/nc/class")), None);
    }

    #[test]
    fn 接口按_i_开头的命名惯例猜() {
        assert_eq!(guess_kind("IUserService"), JavaKind::Interface);
        assert_eq!(guess_kind("Item"), JavaKind::Class);
        assert_eq!(guess_kind("I"), JavaKind::Class);
        assert_eq!(guess_kind("Index"), JavaKind::Class);
    }

    #[test]
    fn 骨架换行符一致且以换行结尾() {
        let s = render_java(JavaKind::Class, "Foo", Some("a.b"), "\r\n");
        assert_eq!(s, "package a.b;\r\n\r\npublic class Foo {\r\n\r\n}\r\n");
        assert!(!s.replace("\r\n", "").contains('\n'));
        let s = render_java(JavaKind::Enum, "E", None, "\n");
        assert_eq!(s, "public enum E {\n\n}\n");
    }

    #[test]
    fn 后台插件骨架符合_nc_签名() {
        let s = render_java(JavaKind::BgPlugin, "MyPlugin", Some("nc.bs.x"), "\n");
        assert!(s.contains("public class MyPlugin implements IBackgroundWorkPlugin {"));
        assert!(s.contains(
            "public PreAlertObject executeTask(BgWorkingContext bgwc) throws BusinessException {"
        ));
        assert!(s.contains("import nc.bs.pub.taskcenter.IBackgroundWorkPlugin;"));
        assert!(s.is_ascii());
    }

    #[test]
    fn 只对普通_java_类名给骨架() {
        let d = crate::test_support::tmp("tpl-name");
        assert!(skeleton_for_new_file(&d, "Foo.java").is_some());
        assert!(skeleton_for_new_file(&d, "foo.java").is_none());
        assert!(skeleton_for_new_file(&d, "package-info.java").is_none());
        assert!(skeleton_for_new_file(&d, "Foo.xml").is_none());
        assert!(skeleton_for_new_file(&d, "中文.java").is_none());
    }

    #[test]
    fn 换行符跟随同目录现有文件() {
        let base = crate::test_support::tmp("tpl-eol");
        let dir = base.join("gl/src/public/nc/a");
        std::fs::create_dir_all(&dir).unwrap();
        // 没有样本：CRLF
        assert_eq!(detect_dir_eol(&dir), "\r\n");
        std::fs::write(dir.join("A.java"), b"class A {\n}\n").unwrap();
        std::fs::write(dir.join("B.java"), b"class B {\n}\n").unwrap();
        assert_eq!(detect_dir_eol(&dir), "\n");
        // 子目录没有样本时沿父目录找
        let sub = dir.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        assert_eq!(detect_dir_eol(&sub), "\n");
        let s = skeleton_for_new_file(&dir, "C.java").unwrap();
        assert_eq!(s, "package nc.a;\n\npublic class C {\n\n}\n");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn 预览给出包名内容与不能创建的原因() {
        let base = crate::test_support::tmp("tpl-preview");
        let dir = base.join("aim/src/private/nc/bs/pub/plguin");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("Exists.java"), b"class Exists {\r\n}\r\n").unwrap();

        let ok = preview(&dir, "MyJob", JavaKind::BgPlugin);
        assert!(ok.error.is_none());
        assert_eq!(ok.package.as_deref(), Some("nc.bs.pub.plguin"));
        assert_eq!(ok.file_name, "MyJob.java");
        assert_eq!(ok.eol, "CRLF");
        assert!(ok.text.contains("implements IBackgroundWorkPlugin"));

        let dup = preview(&dir, "Exists", JavaKind::Class);
        assert_eq!(dup.error.as_deref(), Some("该目录下已有 Exists.java"));
        assert!(dup.text.is_empty());
        for bad in ["", "foo", "1Foo", "My-Job", "class", "中文"] {
            assert!(preview(&dir, bad, JavaKind::Class).error.is_some(), "{bad}");
        }
        // 目录不在源码根下：默认包，但仍可创建
        let plain = base.join("aim/resources/tmp");
        std::fs::create_dir_all(&plain).unwrap();
        let p = preview(&plain, "IStock", JavaKind::Interface);
        assert!(p.error.is_none());
        assert_eq!(p.package, None);
        assert_eq!(p.text, "public interface IStock {\r\n\r\n}\r\n");
        let _ = std::fs::remove_dir_all(&base);
    }
}
