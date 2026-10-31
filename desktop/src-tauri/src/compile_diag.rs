//! D4：编译失败的「未编译归因」，以及产物的「陈旧检测」。
//!
//! 解决的是两类**静默**问题（都比「编译报错」难查）：
//!
//! 1. ecj 报 `IVoucherQuery cannot be resolved to a type`，用户分不清是代码写错了，
//!    还是关联工程 `newar` 改了却没编译。这里去各工程（含关联工程）的
//!    `<模块>/src/{public,client,private}` 下找这个类的源码：找到源码但产物里没有
//!    对应的 `.class` ⇒ 追加一条「它在 B 里有源码，但没编译产物，先编译 B」。
//!    原文报错**照旧保留**，诊断只是追加，不替换。
//! 2. 产物比源码旧（比「不存在」更危险，因为编译会静默通过、运行时才用旧类）。
//!    只提示、不阻断——「我只想先编主工程」是正常用法。
//!
//! 判产物目录**不写死目录名**：直接取依赖链解析出来的 `classDirs`
//! （`Eclipse .classpath` 里每条 src 条目实际的 `output`，含 `out/x` 与 `bin` 两种布局，
//! 本机 `pm` 的 339 个 class 就在 `pm/bin`）。
//!
//! 纯逻辑模块，不含 tauri 类型（同 `compile.rs` 的头注释）。

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::Serialize;

use crate::compile::{extract_imports, extract_package, parse_problems, Problem};
use crate::eclipse_cp::LinkedProject;
use crate::workspace::decode_lossy;

/// 源码子目录（与 `compile::SRC_DIRS` 同口径；那边是私有常量，这里按需另写一份，
/// 两边都是「模块根的固定三级」，改口径要一起改）。
const SRC_DIRS: [&str; 3] = ["src/public", "src/client", "src/private"];

/// 一次编译最多给多少条诊断。一个类找不到会牵出一串（几十条同因），
/// 界面上一屏塞满诊断反而盖住真正的 ecj 报错。
const MAX_DIAG: usize = 12;

/// 一条编译诊断。与 `Problem` 分开：`Problem` 是 ecj 的原文（有行列、可跳转），
/// 诊断是**我们的推断**，不该混进错误计数里。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    /// `uncompiled`（有源码没产物）| `disabled`（所在工程被覆盖表停用）
    /// | `stale`（产物比源码旧）| `no-output`（一个产物都没有）
    pub kind: &'static str,
    /// 相关工程名
    pub project: String,
    /// 给人看的一句话
    pub message: String,
    /// 相关文件（源码路径，界面可点开）
    pub file: Option<String>,
}

/// ecj 报错里「这个名字找不到」的四种形态统一剥成一个名字：
///
/// - `IVoucherQuery cannot be resolved to a type`
/// - `The import a.b.C cannot be resolved`
/// - `The type X cannot be resolved. It is indirectly referenced from required .class files`
/// - `foo cannot be resolved`（变量）
///
/// `import a.b.*` 报出来的名字带 `*`（那是包名，不是类），跳过——按包找不到源码。
fn missing_of(message: &str) -> Option<String> {
    let msg = message.trim();
    let msg = msg
        .strip_prefix("The import ")
        .or_else(|| msg.strip_prefix("The type "))
        .unwrap_or(msg);
    let name = msg.split_once(" cannot be resolved")?.0.trim();
    if name.is_empty()
        || name.contains('*')
        || name.contains(char::is_whitespace)
        || name.contains('"')
    {
        return None;
    }
    Some(name.to_string())
}

/// 从一份 ecj 输出里取「找不到的名字」，按出现顺序去重。第二个值是要去读
/// import 的那份源码（报错的所在文件）。
pub fn unresolved_names(output: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for p in parse_problems(output) {
        if p.severity != "error" {
            continue;
        }
        let Some(name) = missing_of(&p.message) else {
            continue;
        };
        if !out.iter().any(|(n, _)| n == &name) {
            out.push((name, p.file));
        }
    }
    out
}

/// 把简单类名还原成全限定名：显式 `import` 优先，其次同包（同包不需要 import）。
/// 已经带点的名字原样返回。
pub fn qualify(name: &str, source_text: &str) -> Option<String> {
    if name.contains('.') {
        return Some(name.to_string());
    }
    let imports = extract_imports(source_text);
    if let Some((full, _)) = imports
        .iter()
        .find(|(i, wildcard)| !*wildcard && i.rsplit('.').next() == Some(name))
    {
        return Some(full.clone());
    }
    extract_package(source_text).map(|pkg| format!("{pkg}.{name}"))
}

/// 工程根下带 `src/` 的子目录 = 模块目录（与 `compile::module_of` 的「第一级目录」同口径，
/// 多一道 `src` 判断，避免把 `.settings` 之类也算成模块）。
pub fn module_dirs(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(root) else {
        return out;
    };
    for e in rd.flatten() {
        let p = e.path();
        if p.join("src").is_dir() {
            out.push(p);
        }
    }
    out.sort();
    out
}

/// 在 `root/<模块>/src/{public,client,private}/<rel>` 下找源码。`rel` 形如 `nc/bs/foo/X.java`。
pub fn find_source(root: &Path, rel: &Path) -> Option<PathBuf> {
    for m in module_dirs(root) {
        for d in SRC_DIRS {
            let p = m.join(d).join(rel);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// FQCN → 相对路径。逐段 push 而不是拼字符串：Windows 上 `a\b/c` 这种混写能访问，
/// 但界面上看着像坏了。
fn rel_path(fqcn: &str, ext: &str) -> PathBuf {
    let mut p = PathBuf::new();
    for seg in fqcn.split('.') {
        p.push(seg);
    }
    p.set_extension(ext);
    p
}

/// 这个工程贡献的产物目录里的这个类。
fn find_class(project: &LinkedProject, fqcn: &str) -> Option<PathBuf> {
    let rel = rel_path(fqcn, "class");
    project
        .class_dirs
        .iter()
        .map(|d| Path::new(d).join(&rel))
        .find(|p| p.is_file())
}

/// 两个文件的 mtime（任一取不到就返回 None）。
fn mtimes(class_file: &Path, source: &Path) -> Option<(SystemTime, SystemTime)> {
    let c = std::fs::metadata(class_file).ok()?.modified().ok()?;
    let s = std::fs::metadata(source).ok()?.modified().ok()?;
    Some((c, s))
}

/// 编译失败时的归因：名字 → FQCN → 在哪个工程的哪份源码里。
///
/// 三种结论：有源码没产物（`uncompiled`）/ 源码所在工程被停用（`disabled`）/
/// 有产物但比源码旧（`stale-class`，最隐蔽——类在，用的是改之前的版本）。
///
/// 只做**按类**判断（每个命中一次 stat），不扫整棵树：编译本身是秒级操作，
/// 不能因为诊断再多花 8 秒（实测数字见 `stale_diagnostics` 的注释）。
pub fn uncompiled_diagnostics(projects: &[LinkedProject], problems: &[Problem]) -> Vec<Diagnostic> {
    let mut out = Vec::new();
    // (工程, 源码) 去重：同一个类在 A 里报 8 次错，只该出一条诊断
    let mut seen: Vec<(String, String)> = Vec::new();
    for p in problems.iter().filter(|p| p.severity == "error") {
        let Some(name) = missing_of(&p.message) else {
            continue;
        };
        let Ok(bytes) = std::fs::read(&p.file) else {
            continue;
        };
        let Some(fqcn) = qualify(&name, &decode_lossy(&bytes)) else {
            continue;
        };
        let rel = rel_path(&fqcn, "java");
        for pr in projects {
            let Some(root) = pr.root.as_deref().map(Path::new) else {
                continue;
            };
            let Some(src) = find_source(root, &rel) else {
                continue;
            };
            let file = src.to_string_lossy().into_owned();
            if seen.iter().any(|(n, f)| n == &pr.name && f == &file) {
                continue;
            }
            seen.push((pr.name.clone(), file.clone()));
            let class = find_class(pr, &fqcn);
            if pr.disabled {
                out.push(Diagnostic {
                    kind: "disabled",
                    project: pr.name.clone(),
                    message: format!(
                        "「{}」里有 {fqcn} 的源码，但这个工程被覆盖表停用了，它的类目录不进本次编译（要恢复就去「工程关联」页取消停用）",
                        pr.name
                    ),
                    file: Some(file),
                });
            } else if class.is_none() {
                out.push(Diagnostic {
                    kind: "uncompiled",
                    project: pr.name.clone(),
                    message: format!(
                        "「{}」里有 {fqcn} 的源码，但没有编译产物（缺 {}.class），先编译「{}」再试",
                        pr.name,
                        fqcn.replace('.', "/"),
                        pr.name
                    ),
                    file: Some(file),
                });
            } else if let Some((c, s)) = class.as_deref().and_then(|c| mtimes(c, &src)) {
                // 类在，但比源码旧：编译会静默通过、跑的是旧版本，比「找不到」更难查
                if c < s {
                    out.push(Diagnostic {
                        kind: "stale-class",
                        project: pr.name.clone(),
                        message: format!(
                            "「{}」有 {fqcn}，但产物比源码旧（class 比 .java 早 {}），本次编译用的是改动前的版本",
                            pr.name,
                            human_gap(c, s)
                        ),
                        file: Some(file),
                    });
                }
            }
            if out.len() >= MAX_DIAG {
                return out;
            }
        }
    }
    out
}

/// 目录扫描的累加结果：最新 mtime + 文件数。
#[derive(Default)]
struct Walk {
    newest: Option<SystemTime>,
    count: usize,
}

/// 递归扫某个扩展名的文件。`DirEntry::metadata` 不跟随符号链接（Windows 上是重解析点），
/// 所以这里不会绕进环里。
fn scan(dir: &Path, ext: &str, acc: &mut Walk) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let Ok(md) = e.metadata() else {
            continue;
        };
        let p = e.path();
        if md.is_dir() {
            scan(&p, ext, acc);
        } else if p.extension().is_some_and(|x| x == ext) {
            acc.count += 1;
            if let Ok(t) = md.modified() {
                if acc.newest.is_none_or(|n| t > n) {
                    acc.newest = Some(t);
                }
            }
        }
    }
}

/// 「最新 class 比最新 .java 早多久」的人话版本。
fn human_gap(class_time: SystemTime, source_time: SystemTime) -> String {
    let secs = source_time
        .duration_since(class_time)
        .unwrap_or_default()
        .as_secs();
    match secs {
        0..=59 => format!("{secs} 秒"),
        60..=3599 => format!("{} 分钟", secs / 60),
        3600..=86_399 => format!("{} 小时", secs / 3600),
        _ => format!("{} 天", secs / 86400),
    }
}

/// 产物新旧检测（**全量**：每个工程扫一遍源码树与产物树）。
///
/// 产物目录取 `classDirs`——它是 `.classpath` 里每条 src 条目实际的 `output`，
/// `out/<模块>` 与 `<根>/bin` 两种布局都覆盖到了。写死目录名会把 `pm`（产物全在
/// `pm/bin`）误判成「根本没编过」。
///
/// 🔴 **这是按需调用的，不要塞进编译流程**。2026-10-31 真机实测（`C:\work\aier`
/// 三工程、12k 个 java、13k 个 class）：整树枚举 149k 条目耗时 **8.3 秒**（release
/// 与 debug 基本一样，也不是 `metadata` 的锅：纯 `read_dir` 遍历同样 9 秒，本机目录
/// 枚举约 15k 条目/秒）。挂到「每次编译后」等于每次编译白等 8 秒。
/// 编译流程里只做按类的判断（`uncompiled_diagnostics`，每命中一次 stat），
/// 全量的由 `check_artifacts` 命令在用户点按钮时跑。
pub fn stale_diagnostics(projects: &[LinkedProject]) -> Vec<Diagnostic> {
    let mut out = Vec::new();
    for pr in projects {
        if pr.disabled {
            continue;
        }
        let Some(root) = pr.root.as_deref().map(Path::new) else {
            continue;
        };
        let mut src = Walk::default();
        for m in module_dirs(root) {
            for d in SRC_DIRS {
                scan(&m.join(d), "java", &mut src);
            }
        }
        if src.count == 0 {
            continue; // 没有源码的工程（纯 jar 壳）不谈新旧
        }
        let mut cls = Walk::default();
        for d in &pr.class_dirs {
            scan(Path::new(d), "class", &mut cls);
        }
        if cls.count == 0 {
            out.push(Diagnostic {
                kind: "no-output",
                project: pr.name.clone(),
                message: format!(
                    "「{}」有 {} 个源文件，但产物目录里一个 class 都没有，启动时会用 jar 里的旧类、或者直接找不到类",
                    pr.name, src.count
                ),
                file: None,
            });
            continue;
        }
        let (Some(class_time), Some(source_time)) = (cls.newest, src.newest) else {
            continue;
        };
        if class_time < source_time {
            out.push(Diagnostic {
                kind: "stale",
                project: pr.name.clone(),
                message: format!(
                    "「{}」的产物比源码旧（最新 class 比最新 .java 早 {}），本次编译/启动可能用到旧类",
                    pr.name,
                    human_gap(class_time, source_time)
                ),
                file: None,
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::Duration;

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("ncforge-diag-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    /// 造一个工程：`root/<module>/src/<scope>/<rel>` 放源码，`dirs` 作为产物目录。
    fn project(name: &str, root: &Path, dirs: &[&Path], disabled: bool) -> LinkedProject {
        LinkedProject {
            name: name.to_string(),
            root: Some(root.to_string_lossy().into_owned()),
            origin: "classpath".to_string(),
            depth: 1,
            exported: true,
            class_dirs: dirs
                .iter()
                .map(|d| d.to_string_lossy().into_owned())
                .collect(),
            disabled,
            has_classpath: true,
        }
    }

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    /// 写一个文件并把 mtime 拨到 `ago` 秒之前。
    fn write_aged(path: &Path, text: &str, ago: u64) {
        write(path, text);
        let f = fs::OpenOptions::new().write(true).open(path).unwrap();
        f.set_modified(SystemTime::now() - Duration::from_secs(ago))
            .unwrap();
    }

    #[test]
    fn missing_names_come_in_four_shapes() {
        let out = "1. ERROR in C:/w/A.java (at line 3)\n\tIVoucherQuery s = x;\n\t^^^^^^^^^^^^^\nIVoucherQuery cannot be resolved to a type\n----------\n2. ERROR in C:/w/B.java (at line 1)\n\timport a.b.C;\n\t       ^^^^^\nThe import a.b.C cannot be resolved\n----------\n3. ERROR in C:/w/C.java (at line 5)\n\tx\n\t^\nThe type D cannot be resolved. It is indirectly referenced from required .class files\n----------\n4. ERROR in C:/w/D.java (at line 7)\n\tv = foo;\n\t    ^^^\nfoo cannot be resolved\n----------\n5. ERROR in C:/w/E.java (at line 2)\n\timport x.*;\n\t      ^^\nThe import x.* cannot be resolved\n----------\n6. WARNING in C:/w/F.java (at line 2)\n\tint a;\n\t    ^\nThe value of the local variable a is not used\n----------\n";
        let got: Vec<String> = unresolved_names(out).into_iter().map(|(n, _)| n).collect();
        // 通配包名（带 *）与非「找不到」的警告都不该进来
        assert_eq!(got, vec!["IVoucherQuery", "a.b.C", "D", "foo"]);
        assert_eq!(unresolved_names(out)[1].1, "C:/w/B.java");
    }

    #[test]
    fn simple_name_qualifies_by_import_then_package() {
        let src = "package a.b;\nimport x.y.Base;\nclass Foo extends Base {}";
        assert_eq!(qualify("Base", src).as_deref(), Some("x.y.Base"));
        assert_eq!(qualify("Same", src).as_deref(), Some("a.b.Same"));
        // 已经带点的原样返回
        assert_eq!(qualify("p.q.R", "class A {}").as_deref(), Some("p.q.R"));
        // 既没 import 也没 package：推不出来，宁可不诊断
        assert_eq!(qualify("X", "class A {}"), None);
    }

    #[test]
    fn finds_source_only_under_module_src_scopes() {
        let base = tmp("find");
        let p = base.join("newar");
        let hit = p
            .join("gl")
            .join("src")
            .join("private")
            .join("nc")
            .join("bs")
            .join("foo")
            .join("X.java");
        write(&hit, "package nc.bs.foo;\nclass X {}");
        // 不在 src/{public,client,private} 下的同名文件不算
        write(
            &p.join("gl")
                .join("out")
                .join("nc")
                .join("bs")
                .join("foo")
                .join("X.java"),
            "x",
        );
        assert_eq!(
            find_source(&p, Path::new("nc/bs/foo/X.java")).as_deref(),
            Some(hit.as_path())
        );
        assert_eq!(find_source(&p, Path::new("nc/bs/foo/Y.java")), None);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn error_in_primary_blames_dependency_without_output() {
        let base = tmp("attr");
        // 主工程：报错文件（有 package/import，供推 FQCN）
        let main = base.join("EyePortal");
        let err_file = main.join("mod").join("src").join("public").join("A.java");
        write(
            &err_file,
            "package nc.bs.a;\nimport nc.bs.foo.X;\nclass A { X x; }",
        );
        // 关联工程：有源码、没有产物
        let dep = base.join("newar");
        let dep_src = dep
            .join("gl")
            .join("src")
            .join("private")
            .join("nc")
            .join("bs")
            .join("foo")
            .join("X.java");
        write(&dep_src, "package nc.bs.foo;\npublic class X {}");
        let projects = vec![
            project(
                "EyePortal",
                &main,
                &[&main.join("mod").join("classes")],
                false,
            ),
            project("newar", &dep, &[&dep.join("bin")], false),
        ];
        let problems = vec![Problem {
            severity: "error".to_string(),
            file: err_file.to_string_lossy().into_owned(),
            line: 2,
            message: "nc.bs.foo.X cannot be resolved to a type".to_string(),
        }];

        let d = uncompiled_diagnostics(&projects, &problems);
        assert_eq!(d.len(), 1, "只该有 newar 这一条（主工程没有这个类的源码）");
        assert_eq!(d[0].kind, "uncompiled");
        assert_eq!(d[0].project, "newar");
        assert!(d[0].message.contains("nc.bs.foo.X"));
        // 路径按分量比较：Windows 上分隔符写法不影响相等性
        assert_eq!(d[0].file.as_deref().map(Path::new), Some(dep_src.as_path()));

        // 产物补上（class 存在）⇒ 不再报「没编译」
        write(
            &dep.join("bin")
                .join("nc")
                .join("bs")
                .join("foo")
                .join("X.class"),
            "",
        );
        assert!(uncompiled_diagnostics(&projects, &problems).is_empty());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn class_older_than_source_is_reported_as_stale() {
        let base = tmp("stale-class");
        let main = base.join("EyePortal");
        let err_file = main.join("mod").join("src").join("public").join("A.java");
        write(
            &err_file,
            "package nc.bs.a;\nimport nc.bs.foo.X;\nclass A { X x; }",
        );
        let dep = base.join("newar");
        let src = dep
            .join("gl")
            .join("src")
            .join("private")
            .join("nc")
            .join("bs")
            .join("foo")
            .join("X.java");
        let cls = dep
            .join("bin")
            .join("nc")
            .join("bs")
            .join("foo")
            .join("X.class");
        // 类在，但比源码旧 2 小时：编译会静默通过、用的是改动前的版本
        write_aged(&cls, "", 7200);
        write_aged(&src, "package nc.bs.foo;\npublic class X {}", 0);
        let projects = vec![project("newar", &dep, &[&dep.join("bin")], false)];
        let problems = vec![Problem {
            severity: "error".to_string(),
            file: err_file.to_string_lossy().into_owned(),
            line: 2,
            message: "X cannot be resolved to a type".to_string(),
        }];

        let d = uncompiled_diagnostics(&projects, &problems);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].kind, "stale-class");
        assert!(d[0].message.contains("改动前"), "{}", d[0].message);
        assert!(d[0].message.contains("2 小时"), "{}", d[0].message);

        // 产物重新编过（比源码新）⇒ 不报
        write_aged(&cls, "", 0);
        assert!(uncompiled_diagnostics(&projects, &problems).is_empty());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn disabled_project_is_reported_as_disabled_not_uncompiled() {
        let base = tmp("disabled");
        let main = base.join("EyePortal");
        let err_file = main.join("mod").join("src").join("public").join("A.java");
        write(
            &err_file,
            "package nc.bs.a;\nimport nc.bs.foo.X;\nclass A { X x; }",
        );
        let dep = base.join("newar");
        let dep_src = dep
            .join("gl")
            .join("src")
            .join("public")
            .join("nc")
            .join("bs")
            .join("foo")
            .join("X.java");
        write(&dep_src, "package nc.bs.foo;\npublic class X {}");
        let projects = vec![project("newar", &dep, &[], true)];
        let problems = vec![Problem {
            severity: "error".to_string(),
            file: err_file.to_string_lossy().into_owned(),
            line: 2,
            message: "X cannot be resolved to a type".to_string(),
        }];
        let d = uncompiled_diagnostics(&projects, &problems);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].kind, "disabled");
        assert!(d[0].message.contains("停用"));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn stale_needs_class_older_than_source() {
        let base = tmp("stale");
        let root = base.join("newar");
        let java = root.join("gl").join("src").join("public").join("A.java");
        let class_file = root.join("bin").join("A.class");
        // class 比源码旧 2 小时 ⇒ 报陈旧
        write_aged(&class_file, "", 7200);
        write_aged(&java, "package a;", 0);
        let projects = vec![project("newar", &root, &[&root.join("bin")], false)];
        let d = stale_diagnostics(&projects);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].kind, "stale");
        assert!(d[0].message.contains("2 小时"), "{}", d[0].message);

        // class 比源码新 ⇒ 不报
        write_aged(&class_file, "", 0);
        assert!(stale_diagnostics(&projects).is_empty());

        // 一个产物都没有 ⇒ no-output（不是 stale）
        fs::remove_file(&class_file).unwrap();
        let d = stale_diagnostics(&projects);
        assert_eq!(d[0].kind, "no-output");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn disabled_project_is_skipped_by_stale_check() {
        let base = tmp("stale-disabled");
        let root = base.join("newar");
        write_aged(
            &root.join("gl").join("src").join("public").join("A.java"),
            "x",
            0,
        );
        // 停用的工程连产物都不看（它本来就不参与本次编译）
        let projects = vec![project("newar", &root, &[&root.join("bin")], true)];
        assert!(stale_diagnostics(&projects).is_empty());
        let _ = fs::remove_dir_all(&base);
    }
}
