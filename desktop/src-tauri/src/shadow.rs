//! 影子工程：给 jdt.ls 用的、不碰用户工作副本的 Eclipse 工程描述（M4c）。
//!
//! 为什么要影子：jdt.ls 只认项目根下的 `.project` / `.classpath`，而用户的 `.classpath` 是 SVN 版本控制的文件，
//! 用的还是 UAP Studio 私有 container（`nc.uap.mde.library.container/*`），jdt.ls 没有那个插件。
//! 所以在工作台自己的目录里生成一份：源码用 junction 链过来（跳转照样 8ms 命中），其余全是我们写的文件。
//!
//! 复核探针已验证的要点（见 `docs/NCForge-代码智能-M4-方案设计-20261028.md`）：
//! - `.classpath` 里必须有 **JRE 容器条目**，否则工程里没有 JDK 的类，`List` 之类跳不过去；
//! - lib 条目写 `sourcepath="..._src.jar"` 后，NC 标准类能看到真实源码（不写就是反汇编桩）；
//! - 只有 `.classpath` 没有 `.project` 会退化成 invisible project，classpath 全部忽略。
//!
//! **安全**：本模块对工作副本只读。影子目录里唯一会被删的东西是「链接」本身（`remove_dir` 只摘链接、
//! 不碰目标），且仅限确实是链接的条目——绝不对影子目录里的任何路径做 `remove_dir_all`，那会沿 junction 删到用户源码。
//!
//! 纯逻辑模块，不含 tauri 类型（原因见 workspace.rs 头注释）。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
// 只有 Windows 的 create_link（mklink /J）用得到；非 Windows 平台导入会报 unused。
#[cfg(windows)]
use std::process::Command;

use crate::compile;
use crate::launch::project_class_dirs;
use crate::nc_index::ClassIndex;
use crate::workspace::{detect_encoding, TextEncoding};

/// 影子工程的工程名。
pub const PROJECT_NAME: &str = "nc-forge-shadow";
/// jdt.ls 的编译产物目录（相对影子根）。显式指定在影子目录内，否则会默认落到别处；
/// 再配合 `java.autobuild.enabled=false`，双保险不把 class 写进用户的工作副本。
const OUTPUT_DIR: &str = "shadow-bin";
const JRE_CONTAINER: &str =
    "org.eclipse.jdt.launching.JRE_CONTAINER/org.eclipse.jdt.internal.debug.ui.launcher.StandardVMType/JavaSE-1.8";
const SRC_DIRS: [&str; 3] = ["src/public", "src/client", "src/private"];

// ───────────────────────── 文件内容渲染（纯函数） ─────────────────────────

/// `.classpath` 的输入。
pub struct ClasspathInputs<'a> {
    /// 源码目录，相对影子根（如 `gl/src/private`）。
    pub src_dirs: &'a [String],
    /// 已编译的类目录（其他模块的二开类只在这里）。
    pub class_dirs: &'a [PathBuf],
    /// jar 与它的源码 jar（`xxx_src.jar`，没有就是 None），顺序即 classpath 顺序。
    pub jars: &'a [(PathBuf, Option<PathBuf>)],
}

fn forward(p: &Path) -> String {
    p.to_string_lossy().replace(char::from(92), "/")
}

fn xml_attr(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// 生成 `.classpath`。源码 → JRE → 类目录 → jar，最后是显式的 output。
pub fn render_classpath(inp: &ClasspathInputs) -> String {
    let mut out = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<classpath>\n");
    for d in inp.src_dirs {
        out.push_str(&format!(
            "\t<classpathentry kind=\"src\" path=\"{}\"/>\n",
            xml_attr(d)
        ));
    }
    out.push_str(&format!(
        "\t<classpathentry kind=\"con\" path=\"{JRE_CONTAINER}\"/>\n"
    ));
    for d in inp.class_dirs {
        out.push_str(&format!(
            "\t<classpathentry kind=\"lib\" path=\"{}\"/>\n",
            xml_attr(&forward(d))
        ));
    }
    for (jar, src) in inp.jars {
        match src {
            Some(s) => out.push_str(&format!(
                "\t<classpathentry kind=\"lib\" path=\"{}\" sourcepath=\"{}\"/>\n",
                xml_attr(&forward(jar)),
                xml_attr(&forward(s))
            )),
            None => out.push_str(&format!(
                "\t<classpathentry kind=\"lib\" path=\"{}\"/>\n",
                xml_attr(&forward(jar))
            )),
        }
    }
    out.push_str(&format!(
        "\t<classpathentry kind=\"output\" path=\"{OUTPUT_DIR}\"/>\n</classpath>\n"
    ));
    out
}

/// 生成 `.project`：只保留 java nature，去掉 `nc.uap.mde.*` 的 builder/nature（jdt.ls 没有那个插件）。
pub fn render_project() -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<projectDescription>\n\t<name>{PROJECT_NAME}</name>\n\t<comment></comment>\n\t<projects></projects>\n\t<buildSpec>\n\t\t<buildCommand><name>org.eclipse.jdt.core.javabuilder</name><arguments></arguments></buildCommand>\n\t</buildSpec>\n\t<natures><nature>org.eclipse.jdt.core.javanature</nature></natures>\n</projectDescription>\n"
    )
}

/// 生成 `.settings/org.eclipse.core.resources.prefs`：工程默认 GBK，探测为 UTF-8 的文件逐个登记。
///
/// 不照抄用户的 Eclipse 偏好：newar 有 53 个 UTF-8 文件没在那里登记（M0 实测），
/// 照抄会让 jdt.ls 按 GBK 读它们。键 `encoding/<project>` 里的 `<project>` 是字面值。
pub fn render_prefs(utf8_files: &[String]) -> String {
    let mut sorted: Vec<&String> = utf8_files.iter().collect();
    sorted.sort();
    let mut out = String::from("eclipse.preferences.version=1\n");
    for f in sorted {
        out.push_str(&format!("encoding//{f}=UTF-8\n"));
    }
    out.push_str("encoding/<project>=GBK\n");
    out
}

// ───────────────────────── 目录链接 ─────────────────────────

#[cfg(windows)]
fn create_link(link: &Path, target: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    // junction 不需要管理员权限（目录符号链接需要）。std 没有创建 junction 的接口，只能走 mklink
    let out = Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .creation_flags(0x0800_0000)
        .output()
        .map_err(|e| format!("无法调用 mklink: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!(
            "创建目录链接失败（{} → {}）",
            link.display(),
            target.display()
        ))
    }
}

#[cfg(not(windows))]
fn create_link(link: &Path, target: &Path) -> Result<(), String> {
    std::os::unix::fs::symlink(target, link).map_err(|e| format!("创建目录链接失败: {e}"))
}

/// 摘掉一个链接。只用 `remove_dir`（对 junction 只删链接本身），目标目录原样不动。
fn remove_link(link: &Path) -> Result<(), String> {
    std::fs::remove_dir(link)
        .or_else(|_| std::fs::remove_file(link))
        .map_err(|e| format!("摘除目录链接失败（{}）: {e}", link.display()))
}

fn is_link(p: &Path) -> bool {
    std::fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink())
}

/// 确保 `link` 是指向 `target` 的链接。返回是否有改动。
/// 已存在但不是链接的真目录/文件一律拒绝覆盖。
pub fn ensure_link(link: &Path, target: &Path) -> Result<bool, String> {
    if std::fs::symlink_metadata(link).is_ok() {
        if !is_link(link) {
            return Err(format!(
                "影子目录里的 {} 不是链接，拒绝覆盖（请检查是否手工改过影子目录）",
                link.display()
            ));
        }
        let same = matches!(
            (std::fs::canonicalize(link), std::fs::canonicalize(target)),
            (Ok(a), Ok(b)) if a == b
        );
        if same {
            return Ok(false);
        }
        remove_link(link)?;
    }
    create_link(link, target)?;
    Ok(true)
}

/// 清掉影子目录里除 `keep` 之外的所有链接（切模块时旧模块的链接）。真目录和文件不碰。
fn remove_other_links(shadow: &Path, keep: &str) -> Result<bool, String> {
    let mut removed = false;
    for e in std::fs::read_dir(shadow)
        .map_err(|e| format!("读取影子目录失败: {e}"))?
        .flatten()
    {
        let p = e.path();
        if is_link(&p) && p.file_name().is_some_and(|n| n != keep) {
            remove_link(&p)?;
            removed = true;
        }
    }
    Ok(removed)
}

/// 内容没变就不写：不然 jdt.ls 会每次都重新导入工程。返回是否写了。
fn write_if_changed(path: &Path, content: &str) -> Result<bool, String> {
    if std::fs::read_to_string(path).is_ok_and(|old| old == content) {
        return Ok(false);
    }
    std::fs::write(path, content).map_err(|e| format!("写 {} 失败: {e}", path.display()))?;
    Ok(true)
}

// ───────────────────────── 生成 ─────────────────────────

pub struct ShadowSpec<'a> {
    /// 工程根（如 `C:\work\aier\newar`），其下每个子目录是一个模块。
    pub workspace_root: &'a Path,
    pub module: &'a str,
    pub nc_home: &'a Path,
    /// 影子工程根（工作台自己的数据目录下，不在工作副本里）。
    pub shadow_dir: &'a Path,
    pub index: &'a ClassIndex,
    /// 该模块上次编译用到的 jar（按报错补出来的），并入后补全更完整。
    pub extra_jars: &'a [u32],
}

#[derive(Debug)]
pub struct ShadowProject {
    pub root: PathBuf,
    /// 本次是否有文件或链接发生变化。没变就不用让 jdt.ls 重新导入。
    pub changed: bool,
    pub source_files: usize,
    pub jar_count: usize,
    pub utf8_files: usize,
}

/// `lib` / `framework` / `middleware` 下的 jar（约 99 个，共 42MB）全放进 classpath：便宜，而且几乎每个文件都会用到。
fn common_jars(index: &ClassIndex, nc_home: &Path) -> Vec<u32> {
    let roots: Vec<PathBuf> = ["lib", "framework", "middleware"]
        .iter()
        .map(|d| nc_home.join(d))
        .collect();
    index
        .jars
        .iter()
        .enumerate()
        .filter(|(_, p)| roots.iter().any(|r| p.starts_with(r)))
        .map(|(i, _)| i as u32)
        .collect()
}

/// `xxx.jar` 同目录下的 `xxx_src.jar`。
fn src_jar_of(jar: &Path) -> Option<PathBuf> {
    let stem = jar.file_stem()?.to_string_lossy();
    let candidate = jar.with_file_name(format!("{stem}_src.jar"));
    candidate.is_file().then_some(candidate)
}

/// 为 `spec.module` 生成（或更新）影子工程。幂等：内容没变就什么都不写，`changed` 为 false。
pub fn generate(spec: &ShadowSpec) -> Result<ShadowProject, String> {
    let module_dir = spec.workspace_root.join(spec.module);
    if !module_dir.is_dir() {
        return Err(format!("模块目录不存在: {}", module_dir.display()));
    }
    let files = compile::collect_sources(&module_dir);
    if files.is_empty() {
        return Err(format!("模块 {} 下没有 .java 源文件", spec.module));
    }
    std::fs::create_dir_all(spec.shadow_dir.join(".settings"))
        .map_err(|e| format!("无法创建影子目录: {e}"))?;

    // 1. 源码链接：只链当前模块，切模块时摘掉旧的
    let mut changed = ensure_link(&spec.shadow_dir.join(spec.module), &module_dir)?;
    changed |= remove_other_links(spec.shadow_dir, spec.module)?;

    let src_dirs: Vec<String> = SRC_DIRS
        .iter()
        .filter(|d| module_dir.join(d).is_dir())
        .map(|d| format!("{}/{d}", spec.module))
        .collect();

    // 2. 类目录：规则与编译/启动服务共用。当前模块自己的 classes 要排除——那是它自己源码的
    //    旧产物，与源码重复，留着只会让跳转偏到旧 class。
    let own_classes = spec.workspace_root.join(spec.module).join("classes");
    let class_dirs: Vec<PathBuf> = project_class_dirs(spec.workspace_root, spec.nc_home)
        .into_iter()
        .filter(|d| *d != own_classes)
        .collect();

    // 3. jar：按当前模块全部源文件的 import / 同包 / 父类型链精选 + 公共库 + 上次编译的 jar 集
    let mut jar_ids: BTreeSet<u32> = compile::select_jars(spec.index, &files);
    jar_ids.extend(common_jars(spec.index, spec.nc_home));
    jar_ids.extend(spec.extra_jars.iter().copied());
    let jars: Vec<(PathBuf, Option<PathBuf>)> = jar_ids
        .iter()
        .filter_map(|&i| spec.index.jars.get(i as usize))
        .map(|j| (j.clone(), src_jar_of(j)))
        .collect();

    // 4. 编码：按内容探测 UTF-8 的文件逐个登记
    let mut utf8_files = Vec::new();
    for f in &files {
        let Ok(bytes) = std::fs::read(f) else {
            continue;
        };
        if detect_encoding(&bytes) == TextEncoding::Utf8 && !bytes.is_ascii() {
            if let Ok(rel) = f.strip_prefix(&module_dir) {
                utf8_files.push(format!("{}/{}", spec.module, forward(rel)));
            }
        }
    }

    let root = spec.shadow_dir;
    let classpath = render_classpath(&ClasspathInputs {
        src_dirs: &src_dirs,
        class_dirs: &class_dirs,
        jars: &jars,
    });
    changed |= write_if_changed(&root.join(".project"), &render_project())?;
    changed |= write_if_changed(&root.join(".classpath"), &classpath)?;
    changed |= write_if_changed(
        &root
            .join(".settings")
            .join("org.eclipse.core.resources.prefs"),
        &render_prefs(&utf8_files),
    )?;

    Ok(ShadowProject {
        root: root.to_path_buf(),
        changed,
        source_files: files.len(),
        jar_count: jars.len(),
        utf8_files: utf8_files.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nc-forge-shadow-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn classpath_has_jre_src_sourcepath_and_explicit_output() {
        let src_dirs = vec!["gl/src/private".to_string(), "gl/src/client".to_string()];
        let class_dirs = vec![PathBuf::from("C:/work/aier/newar/out/uapbd")];
        let jars = vec![
            (
                PathBuf::from("D:/ncc/a&b.jar"),
                Some(PathBuf::from("D:/ncc/a&b_src.jar")),
            ),
            (PathBuf::from("D:/ncc/plain.jar"), None),
        ];
        let xml = render_classpath(&ClasspathInputs {
            src_dirs: &src_dirs,
            class_dirs: &class_dirs,
            jars: &jars,
        });
        assert!(xml.contains(r#"kind="src" path="gl/src/private""#));
        // 复核探针：没有 JRE 容器，JDK 的类跳不过去
        assert!(xml.contains(
            "JRE_CONTAINER/org.eclipse.jdt.internal.debug.ui.launcher.StandardVMType/JavaSE-1.8"
        ));
        assert!(xml.contains(r#"kind="lib" path="C:/work/aier/newar/out/uapbd"/>"#));
        // sourcepath 让 NC 标准类能看到源码；XML 特殊字符必须转义
        assert!(xml.contains(r#"path="D:/ncc/a&amp;b.jar" sourcepath="D:/ncc/a&amp;b_src.jar""#));
        assert!(xml.contains(r#"path="D:/ncc/plain.jar"/>"#));
        // output 在影子目录内，且是最后一条
        assert!(xml.trim_end().ends_with(&format!(
            "<classpathentry kind=\"output\" path=\"{OUTPUT_DIR}\"/>\n</classpath>"
        )));
        // 源码在 JRE 之前，jar 在类目录之后
        let pos = |s: &str| xml.find(s).unwrap();
        assert!(pos("gl/src/private") < pos("JRE_CONTAINER"));
        assert!(pos("out/uapbd") < pos("plain.jar"));
    }

    #[test]
    fn project_keeps_only_java_nature() {
        let p = render_project();
        assert!(p.contains("org.eclipse.jdt.core.javanature"));
        assert!(!p.contains("nc.uap.mde"));
        assert!(p.contains(PROJECT_NAME));
    }

    #[test]
    fn prefs_default_gbk_and_register_utf8_files() {
        let prefs = render_prefs(&[
            "gl/src/public/B.java".to_string(),
            "gl/src/client/A.java".to_string(),
        ]);
        assert!(prefs.starts_with("eclipse.preferences.version=1\n"));
        // 键里的 <project> 是字面值
        assert!(prefs.contains("\nencoding/<project>=GBK\n"));
        assert!(prefs.contains("\nencoding//gl/src/client/A.java=UTF-8\n"));
        assert!(
            prefs.find("A.java").unwrap() < prefs.find("B.java").unwrap(),
            "按路径排序，输出稳定"
        );
    }

    #[test]
    fn link_is_created_reused_replaced_and_never_deletes_target() {
        let base = temp("link");
        let (t1, t2) = (base.join("t1"), base.join("t2"));
        std::fs::create_dir_all(&t1).unwrap();
        std::fs::create_dir_all(&t2).unwrap();
        std::fs::write(t1.join("f.txt"), "甲").unwrap();
        let link = base.join("shadow").join("m");
        std::fs::create_dir_all(link.parent().unwrap()).unwrap();

        assert!(ensure_link(&link, &t1).unwrap(), "首次创建");
        assert_eq!(
            std::fs::read_to_string(link.join("f.txt")).unwrap(),
            "甲",
            "通过链接能读到目标文件"
        );
        assert!(!ensure_link(&link, &t1).unwrap(), "指向未变就不动");
        assert!(ensure_link(&link, &t2).unwrap(), "指向变了要重建");
        assert!(t1.join("f.txt").is_file(), "摘链接绝不能删到目标里的文件");

        // 切模块：只摘链接，真目录和文件留着
        let shadow = base.join("shadow");
        std::fs::create_dir_all(shadow.join("real-dir")).unwrap();
        std::fs::write(shadow.join("real-file.txt"), "x").unwrap();
        assert!(remove_other_links(&shadow, "other").unwrap());
        assert!(std::fs::symlink_metadata(&link).is_err(), "旧链接应被摘掉");
        assert!(shadow.join("real-dir").is_dir() && shadow.join("real-file.txt").is_file());
        assert!(t2.is_dir() && t1.join("f.txt").is_file());

        // 已存在的真目录一律拒绝覆盖
        assert!(ensure_link(&shadow.join("real-dir"), &t1).is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 端到端：生成影子工程 → 真实 jdt.ls 打开 → 跳转、看源码、找未打开的 UTF-8 文件里的中文类。
    /// 本机没有 NC home / jdt.ls 就跳过（CI 没有）。
    #[test]
    fn real_jdtls_on_generated_shadow_project() {
        use crate::lsp::{
            build_initialize_params, build_settings, path_to_uri, JdtlsLaunch, LspClient,
            LspHandler,
        };
        use serde_json::{json, Value};
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        use std::time::Duration;

        let nc_home = PathBuf::from(r"D:\ncc\1909home");
        let java = nc_home.join("ufjdk").join("bin").join("java.exe");
        let ls = crate::lsp::tests::test_ls_dir();
        let jar = nc_home.join("modules/uapfw/lib/pubuapfw_jdbcframeworkLevel-1.jar");
        if !java.is_file() || !ls.join("plugins").is_dir() || !jar.is_file() {
            return;
        }

        // 合成工作区：m1 模块。C.java 是 UTF-8 且含中文类名（非 public，类名可以与文件名不同），不会被打开。
        let base = temp("e2e");
        let ws = base.join("ws");
        let pkg = ws.join("m1/src/private/p");
        std::fs::create_dir_all(&pkg).unwrap();
        let b_text = "package p;\nimport java.util.List;\nimport nc.bs.dao.BaseDAO;\npublic class B {\n    List<String> names;\n    void f() throws Exception {\n        BaseDAO dao = new BaseDAO();\n    }\n}\n";
        std::fs::write(pkg.join("B.java"), b_text).unwrap();
        std::fs::write(pkg.join("C.java"), "package p;\nclass 中文类 {}\n").unwrap();
        let ws_before: Vec<_> = walk_names(&ws);

        let index = ClassIndex::build(vec![jar]);
        let shadow = base.join("shadow");
        let spec = ShadowSpec {
            workspace_root: &ws,
            module: "m1",
            nc_home: &nc_home,
            shadow_dir: &shadow,
            index: &index,
            extra_jars: &[],
        };
        let first = generate(&spec).unwrap();
        assert!(first.changed);
        assert_eq!(
            (first.source_files, first.utf8_files),
            (2, 1),
            "C.java 应被登记成 UTF-8"
        );
        assert!(
            !generate(&spec).unwrap().changed,
            "内容没变第二次不应有任何改动"
        );
        let classpath = std::fs::read_to_string(shadow.join(".classpath")).unwrap();
        assert!(classpath.contains("sourcepath=") && classpath.contains("JRE_CONTAINER"));

        struct Ready(Arc<AtomicBool>);
        impl LspHandler for Ready {
            fn on_notification(&self, method: &str, params: Value) {
                if method == "language/status" && params["type"] == "ServiceReady" {
                    self.0.store(true, Ordering::SeqCst);
                }
            }
        }
        let ready = Arc::new(AtomicBool::new(false));
        let data = base.join("jdtls-data");
        let cmd = JdtlsLaunch {
            java_exe: &java,
            ls_dir: &ls,
            data_dir: &data,
            config_dir: &base.join("jdtls-config"),
            xmx_mb: 512,
        }
        .command()
        .unwrap();
        let client = LspClient::spawn(cmd, Arc::new(Ready(ready.clone()))).unwrap();
        let root = shadow.to_string_lossy().into_owned();
        let runtime = nc_home.join("ufjdk").to_string_lossy().into_owned();
        client
            .request(
                "initialize",
                build_initialize_params(&root, &runtime, std::process::id()),
                Duration::from_secs(60),
            )
            .unwrap();
        client.notify("initialized", json!({})).unwrap();
        client
            .notify(
                "workspace/didChangeConfiguration",
                json!({ "settings": build_settings(&runtime) }),
            )
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(120);
        while !ready.load(Ordering::SeqCst) && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(200));
        }
        assert!(ready.load(Ordering::SeqCst), "jdt.ls 没有在 120 秒内就绪");

        let b_path = shadow.join("m1/src/private/p/B.java");
        let b_uri = path_to_uri(&b_path.to_string_lossy());
        client
            .notify("textDocument/didOpen", json!({ "textDocument": { "uri": b_uri, "languageId": "java", "version": 1, "text": b_text } }))
            .unwrap();
        std::thread::sleep(Duration::from_secs(5));

        // 跳转到名字所在的类，返回 classFileContents 正文
        let jump = |line: &str, word: &str| -> String {
            let ln = b_text.lines().position(|l| l.contains(line)).unwrap();
            let col = b_text.lines().nth(ln).unwrap().find(word).unwrap() + 1;
            let hits = client
                .request("textDocument/definition", json!({ "textDocument": { "uri": b_uri }, "position": { "line": ln, "character": col } }), Duration::from_secs(60))
                .unwrap();
            let target = hits[0]["uri"].as_str().unwrap_or_default().to_string();
            assert!(
                target.starts_with("jdt://"),
                "{word} 应跳到 jdt:// ，实际 {hits}"
            );
            client
                .request(
                    "java/classFileContents",
                    json!({ "uri": target }),
                    Duration::from_secs(60),
                )
                .unwrap()
                .as_str()
                .unwrap_or_default()
                .to_string()
        };
        let dao_src = jump("BaseDAO dao", "BaseDAO");
        assert!(
            dao_src.contains("/**") && !dao_src.contains("Failed to get sources"),
            "NC 标准类应返回真实源码"
        );
        assert!(
            jump("List<String>", "List").contains("interface List"),
            "JDK 类应能跳（靠 JRE 容器条目）"
        );

        // 未打开的 UTF-8 文件：编码登记生效才能搜到中文类名
        let mut found = false;
        for _ in 0..15 {
            let r = client
                .request(
                    "workspace/symbol",
                    json!({ "query": "中文类" }),
                    Duration::from_secs(30),
                )
                .unwrap();
            if r.as_array().is_some_and(|a| {
                a.iter()
                    .any(|s| s["name"].as_str().is_some_and(|n| n.contains("中文类")))
            }) {
                found = true;
                break;
            }
            std::thread::sleep(Duration::from_secs(2));
        }
        assert!(found, "未打开的 UTF-8 文件里的中文类名应能搜到");

        client.shutdown();
        // 红线：用户的工作副本里一个文件都不能多
        assert_eq!(walk_names(&ws), ws_before, "工作副本里出现了多余文件");
        let _ = std::fs::remove_dir_all(base.join("jdtls-data"));
        // 不对 base 做 remove_dir_all：shadow 里有指向 ws 的 junction，先摘链接再清理
        remove_other_links(&shadow, "").unwrap();
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 递归列出目录下所有路径（相对），用来对比前后是否多出文件。
    fn walk_names(root: &Path) -> Vec<String> {
        fn go(dir: &Path, root: &Path, out: &mut Vec<String>) {
            for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
                let p = e.path();
                out.push(p.strip_prefix(root).unwrap().to_string_lossy().into_owned());
                if p.is_dir() {
                    go(&p, root, out);
                }
            }
        }
        let mut out = Vec::new();
        go(root, root, &mut out);
        out.sort();
        out
    }

    /// 手动测量：真实 `newar/gl` 的生成耗时、jdt.ls 就绪耗时，以及两个已知结果文件的诊断。
    /// 运行：`cargo test --no-default-features --lib real_newar_gl -- --ignored --nocapture`
    #[test]
    #[ignore = "真实 newar/gl，首次需数十秒建类索引，手动跑"]
    fn real_newar_gl_timing() {
        use crate::lsp::{
            build_initialize_params, build_settings, path_to_uri, JdtlsLaunch, LspClient,
            LspHandler,
        };
        use crate::nc_index::classpath_jars;
        use serde_json::{json, Value};
        use std::collections::HashMap;
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::{Arc, Mutex};
        use std::time::{Duration, Instant};

        let nc_home = PathBuf::from(r"D:\ncc\1909home");
        let ws = PathBuf::from(r"C:\work\aier\newar");
        let ls = crate::lsp::tests::test_ls_dir();
        if !ws.join("gl").is_dir() || !ls.join("plugins").is_dir() {
            return;
        }
        let base = PathBuf::from(r"D:\AItool\aiwork\nc-workbench-m0\m4v\real-gl");
        let _ = remove_other_links(&base.join("shadow"), "");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();

        let t = Instant::now();
        let cache = base.parent().unwrap().join("real-index.bin");
        let index = ClassIndex::load_or_build(classpath_jars(&nc_home), Some(&cache), None);
        println!(
            "[量] 类索引 {} 个 jar / {} 个类，耗时 {:.1}s",
            index.jars.len(),
            index.class_count(),
            t.elapsed().as_secs_f32()
        );

        let shadow = base.join("shadow");
        let t = Instant::now();
        let spec = ShadowSpec {
            workspace_root: &ws,
            module: "gl",
            nc_home: &nc_home,
            shadow_dir: &shadow,
            index: &index,
            extra_jars: &[],
        };
        let p = generate(&spec).unwrap();
        println!(
            "[量] 生成影子工程 {:.2}s：源文件 {}，jar {}，UTF-8 文件 {}，.classpath {}KB",
            t.elapsed().as_secs_f32(),
            p.source_files,
            p.jar_count,
            p.utf8_files,
            std::fs::metadata(shadow.join(".classpath")).unwrap().len() / 1024
        );

        #[derive(Default)]
        struct Rec {
            ready: AtomicBool,
            diags: Mutex<HashMap<String, Vec<Value>>>,
            last_diag: Mutex<Option<Instant>>,
        }
        struct H(Arc<Rec>);
        impl LspHandler for H {
            fn on_notification(&self, method: &str, params: Value) {
                if method == "language/status" && params["type"] == "ServiceReady" {
                    self.0.ready.store(true, Ordering::SeqCst);
                }
                if method == "textDocument/publishDiagnostics" {
                    let uri = params["uri"].as_str().unwrap_or_default().to_string();
                    let list = params["diagnostics"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default();
                    self.0.diags.lock().unwrap().insert(uri, list);
                    *self.0.last_diag.lock().unwrap() = Some(Instant::now());
                }
            }
        }
        let rec = Arc::new(Rec::default());
        let data = base.join("jdtls-data");
        let t0 = Instant::now();
        let cmd = JdtlsLaunch {
            java_exe: &nc_home.join("ufjdk/bin/java.exe"),
            ls_dir: &ls,
            data_dir: &data,
            config_dir: &base.join("jdtls-config"),
            xmx_mb: 1024,
        }
        .command()
        .unwrap();
        let client = LspClient::spawn(cmd, Arc::new(H(rec.clone()))).unwrap();
        let root = shadow.to_string_lossy().into_owned();
        let runtime = nc_home.join("ufjdk").to_string_lossy().into_owned();
        client
            .request(
                "initialize",
                build_initialize_params(&root, &runtime, std::process::id()),
                Duration::from_secs(120),
            )
            .unwrap();
        println!("[量] initialize 返回 {:.1}s", t0.elapsed().as_secs_f32());
        client.notify("initialized", json!({})).unwrap();
        client
            .notify(
                "workspace/didChangeConfiguration",
                json!({ "settings": build_settings(&runtime) }),
            )
            .unwrap();
        while !rec.ready.load(Ordering::SeqCst) && t0.elapsed() < Duration::from_secs(900) {
            std::thread::sleep(Duration::from_millis(500));
        }
        println!(
            "[量] ServiceReady {:.1}s（就绪={}）",
            t0.elapsed().as_secs_f32(),
            rec.ready.load(Ordering::SeqCst)
        );

        // 打开两个已知结果的文件：VoucherResources 应无错，Step4View 应有 2 个真错（ecj 与 Eclipse 产物都如此）
        let open = |rel: &str| -> (String, String) {
            let path = shadow.join("gl").join(rel);
            let text = crate::workspace::decode_lossy(&std::fs::read(&path).unwrap());
            let uri = path_to_uri(&path.to_string_lossy());
            client.notify("textDocument/didOpen", json!({ "textDocument": { "uri": uri, "languageId": "java", "version": 1, "text": text } })).unwrap();
            (uri, text)
        };
        let (v_uri, _) = open("src/public/nc/api/gl/resource/VoucherResources.java");
        let (s_uri, s_text) = open("src/client/nc/ui/glcom/reckoning/Step4View.java");
        // 等诊断稳定：连续 8 秒没有新的发布（最多 120 秒）
        let t = Instant::now();
        loop {
            std::thread::sleep(Duration::from_secs(1));
            let quiet = rec
                .last_diag
                .lock()
                .unwrap()
                .is_none_or(|l| l.elapsed() > Duration::from_secs(8));
            if (quiet && t.elapsed() > Duration::from_secs(10))
                || t.elapsed() > Duration::from_secs(120)
            {
                break;
            }
        }
        println!("[量] 诊断稳定用时 {:.1}s", t.elapsed().as_secs_f32());
        let errs = |uri: &str| -> Vec<String> {
            rec.diags
                .lock()
                .unwrap()
                .get(uri)
                .map(|l| {
                    l.iter()
                        .filter(|d| d["severity"] == 1)
                        .map(|d| {
                            d["message"]
                                .as_str()
                                .unwrap_or_default()
                                .chars()
                                .take(90)
                                .collect()
                        })
                        .collect()
                })
                .unwrap_or_default()
        };
        println!(
            "[量] VoucherResources 错误 {} 个 {:?}",
            errs(&v_uri).len(),
            errs(&v_uri)
        );
        println!(
            "[量] Step4View 错误 {} 个 {:?}",
            errs(&s_uri).len(),
            errs(&s_uri)
        );

        // 跳到 NCLocator（NC 标准类）
        let ln = s_text
            .lines()
            .position(|l| l.contains("NCLocator.getInstance()"))
            .unwrap();
        let col = s_text.lines().nth(ln).unwrap().find("NCLocator").unwrap() + 1;
        let t = Instant::now();
        let hits = client.request("textDocument/definition", json!({ "textDocument": { "uri": s_uri }, "position": { "line": ln, "character": col } }), Duration::from_secs(60)).unwrap();
        let target = hits[0]["uri"].as_str().unwrap_or_default().to_string();
        let body = client
            .request(
                "java/classFileContents",
                json!({ "uri": target }),
                Duration::from_secs(60),
            )
            .unwrap();
        let body = body.as_str().unwrap_or_default();
        println!(
            "[量] 跳 NCLocator {:.2}s → {} · 正文 {} 字节 · 有javadoc={} · 是桩={}",
            t.elapsed().as_secs_f32(),
            &target[..target.len().min(60)],
            body.len(),
            body.contains("/**"),
            body.contains("Failed to get sources")
        );

        // 补全：在 Step4View 里找一个成员访问点
        let ln = s_text
            .lines()
            .position(|l| l.contains("service."))
            .unwrap_or(ln);
        let col = s_text
            .lines()
            .nth(ln)
            .unwrap()
            .find("service.")
            .map_or(1, |c| c + 8);
        let t = Instant::now();
        let comp = client.request("textDocument/completion", json!({ "textDocument": { "uri": s_uri }, "position": { "line": ln, "character": col } }), Duration::from_secs(60)).unwrap();
        let n = comp["items"]
            .as_array()
            .map_or_else(|| comp.as_array().map_or(0, Vec::len), Vec::len);
        println!("[量] 补全 {:.2}s → {} 项", t.elapsed().as_secs_f32(), n);
        println!(
            "[量] 总用时 {:.1}s（从拉起 jdt.ls 起）",
            t0.elapsed().as_secs_f32()
        );
        // 给外部采样内存留一点时间
        std::thread::sleep(Duration::from_secs(8));

        client.shutdown();
        let _ = remove_other_links(&shadow, "");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn write_if_changed_is_idempotent() {
        let d = temp("write");
        let f = d.join("x.txt");
        assert!(write_if_changed(&f, "a").unwrap());
        assert!(!write_if_changed(&f, "a").unwrap());
        assert!(write_if_changed(&f, "b").unwrap());
        let _ = std::fs::remove_dir_all(&d);
    }
}
