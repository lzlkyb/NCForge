//! 模块的源码根 / 产物目录布局：`.classpath` 是唯一真源，读不到才回落旧约定。
//!
//! 以前编译把产物写死成 `<模块>/classes`，而 Eclipse 的 `.classpath` 完全可能写
//! `output="bin"`、给某条 src 单独写 `output="out/uapbd"`，甚至一个工程多个产物目录。
//! 清理如果按写死的目录去删，要么删不到（真正的产物在 bin），要么误删同名的无关目录；
//! 编译、启动、语言服务也会各看各的。这里只做一件事：把「源根 → 输出」算清楚，
//! 三处共用。
//!
//! 纯逻辑模块，不依赖 tauri；测试见文件末尾。

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::eclipse_cp::ProjectCp;

/// 没有 `.classpath` 时按 NC 老工程约定找的三个源码根。
pub const LEGACY_SRC_DIRS: [&str; 3] = ["src/public", "src/client", "src/private"];

/// 一个输出目录及写进它的源码根（保持 `.classpath` 顺序）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutputGroup {
    pub out_dir: PathBuf,
    pub source_roots: Vec<PathBuf>,
}

/// 一个模块的布局。路径全部是绝对路径（相对路径已按模块根展开）。
#[derive(Debug, Clone)]
pub struct ModuleLayout {
    pub module: String,
    pub module_dir: PathBuf,
    /// 参与编译的源码根（已排除 `src/test`）
    pub source_roots: Vec<PathBuf>,
    /// 产物目录（保序、去重）
    pub outputs: Vec<PathBuf>,
    /// 按产物目录分组；同一输出的多个源根共享一轮 ecj
    pub groups: Vec<OutputGroup>,
    /// 是否读到了 `.classpath`（false = 走 LEGACY_SRC_DIRS 回落）
    pub has_classpath: bool,
}

impl ModuleLayout {
    /// 从 `.classpath` 解析；没有 `.classpath` 或里面没有本地 src 时回落旧约定。
    pub fn resolve(root: &Path, module: &str) -> Self {
        let module_dir = root.join(module);
        let cp = ProjectCp::load(&module_dir);
        let has_classpath = cp.is_some();
        let mut pairs: Vec<(PathBuf, PathBuf)> = Vec::new();

        if let Some(cp) = &cp {
            for src in &cp.srcs {
                let rel = clean_rel(&src.path);
                if rel.is_empty() || is_test_root(&rel) {
                    continue;
                }
                let source_root = module_dir.join(&src.path);
                let out_rel = src
                    .output
                    .clone()
                    .or_else(|| cp.default_output.clone())
                    .unwrap_or_else(|| PathBuf::from("classes"));
                pairs.push((source_root, module_dir.join(out_rel)));
            }
        }
        // 没有声明任何本地 src：按旧约定找存在的目录。这里**只收存在的**目录，
        // 否则一个空的 `src/client` 会让「没有源文件」从一句清楚的话变成一次空编译。
        if pairs.is_empty() {
            for d in LEGACY_SRC_DIRS {
                let p = module_dir.join(d.replace('/', std::path::MAIN_SEPARATOR_STR));
                if p.is_dir() {
                    pairs.push((p, module_dir.join("classes")));
                }
            }
        }
        // 声明了但目录还没建（新工程）：保留声明，编译时会报「没有源文件」，
        // 这比悄悄换成 classes 更容易发现问题。
        if pairs.is_empty() {
            pairs.push((module_dir.join("src"), module_dir.join("classes")));
        }

        let mut source_roots: Vec<PathBuf> = Vec::new();
        let mut outputs: Vec<PathBuf> = Vec::new();
        let mut groups: Vec<OutputGroup> = Vec::new();
        for (src, out) in pairs {
            if !source_roots.iter().any(|p| eq_path(p, &src)) {
                source_roots.push(src.clone());
            }
            if !outputs.iter().any(|p| eq_path(p, &out)) {
                outputs.push(out.clone());
            }
            match groups.iter_mut().find(|g| eq_path(&g.out_dir, &out)) {
                Some(g) => {
                    if !g.source_roots.iter().any(|p| eq_path(p, &src)) {
                        g.source_roots.push(src);
                    }
                }
                None => groups.push(OutputGroup {
                    out_dir: out,
                    source_roots: vec![src],
                }),
            }
        }

        Self {
            module: module.to_string(),
            module_dir,
            source_roots,
            outputs,
            groups,
            has_classpath,
        }
    }

    /// 文件属于哪个源码根（最长前缀优先，避免 `src` 与 `src/public` 同时声明时选错）。
    pub fn source_root_of(&self, file: &Path) -> Option<&Path> {
        self.source_roots
            .iter()
            .filter(|r| path_starts_with(file, r))
            .max_by_key(|r| r.components().count())
            .map(PathBuf::as_path)
    }

    /// 文件应该写到哪个产物目录。
    pub fn output_for(&self, file: &Path) -> Option<PathBuf> {
        let root = self.source_root_of(file)?;
        self.groups
            .iter()
            .find(|g| g.source_roots.iter().any(|r| eq_path(r, root)))
            .map(|g| g.out_dir.clone())
            .or_else(|| self.outputs.first().cloned())
    }

    /// 相对源码根的路径（`/` 分隔），用于清单与显示。
    pub fn rel_source_of(&self, file: &Path) -> Option<String> {
        let root = self.source_root_of(file)?;
        let rel = strip_prefix_ci(file, root)?;
        Some(slash(&rel))
    }

    /// 相对模块根的源码根写法（清单里存这个，工作区搬家后仍能解读）。
    pub fn rel_root(&self, root: &Path) -> Option<String> {
        strip_prefix_ci(root, &self.module_dir).map(|p| slash(&p))
    }

    /// 源码文件对应的产物目录与相对模块根的写法。
    pub fn output_rel(&self, out: &Path) -> Option<String> {
        strip_prefix_ci(out, &self.module_dir).map(|p| slash(&p))
    }

    /// 清单里的源根 + 产物目录是否与当前布局一致。不一致 → 清单作废，全量。
    pub fn matches_manifest(&self, source_roots: &[String], outputs: &[String]) -> bool {
        let mut now_roots: Vec<String> = self
            .source_roots
            .iter()
            .filter_map(|p| self.rel_root(p))
            .collect();
        let mut was_roots: Vec<String> = source_roots.to_vec();
        let mut now_outs: Vec<String> = self
            .outputs
            .iter()
            .filter_map(|p| self.output_rel(p))
            .collect();
        let mut was_outs: Vec<String> = outputs.to_vec();
        now_roots.sort();
        was_roots.sort();
        now_outs.sort();
        was_outs.sort();
        now_roots == was_roots && now_outs == was_outs
    }

    /// 这个模块里所有 `.java`（按源码根遍历，跳过隐藏目录与 `src/test` 之外的测试目录）。
    pub fn collect_sources(&self) -> Vec<PathBuf> {
        let mut out = Vec::new();
        for root in &self.source_roots {
            walk_java(root, &mut out);
        }
        out.sort();
        out.dedup();
        out
    }
}

/// 逐层遍历；不跟随 symlink/junction（`is_dir` 会跟，`symlink_metadata` 不会）。
pub(crate) fn walk_java(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let p = e.path();
        let Ok(md) = std::fs::symlink_metadata(&p) else {
            continue;
        };
        if is_reparse(&md) {
            continue;
        }
        if md.is_dir() {
            walk_java(&p, out);
        } else if p
            .extension()
            .is_some_and(|x| x.eq_ignore_ascii_case("java"))
        {
            out.push(p);
        }
    }
}

/// 是否是重解析点（Windows junction / symlink）。清理与遍历都不能跟进去。
pub fn is_reparse(md: &std::fs::Metadata) -> bool {
    // symlink 各平台都有；Windows 的 junction 不算 symlink，要再看文件属性。
    // 刻意写成「求值 + 或」而不是 if-return：macOS 上 `cfg(windows)` 那段会被剥掉，
    // 函数只剩 `if symlink { return true } false`，clippy 1.100 的 needless_bool
    // 会在 mac CI 判红（Windows 侧因为有中间那段反而看不见）。
    let reparse_attr = {
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
            md.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        }
        #[cfg(not(windows))]
        {
            false
        }
    };
    md.file_type().is_symlink() || reparse_attr
}

/// 路径任一层（含自身）是重解析点。
pub fn has_reparse_component(path: &Path) -> bool {
    let mut p = path;
    loop {
        if let Ok(md) = std::fs::symlink_metadata(p) {
            if is_reparse(&md) {
                return true;
            }
        }
        match p.parent() {
            Some(parent) if parent != p => p = parent,
            _ => return false,
        }
    }
}

/// 只在 `base` 之下这一段的路径检查重解析点（含 `base` 自身）。
///
/// 为什么需要基准：安全检查的目标是「别顺着链接把文件读写到模块目录之外」。
/// 一路查到文件系统根是过度防御——macOS/Linux 上 `/var`、`/tmp` 本身就是
/// 符号链接（`/var` → `/private/var`），于是临时目录下的每个产物文件都被判成
/// 「跟随重解析点」，清理与产物删除在 macOS 上整体失效（CI 的 macOS job 就是
/// 红在这里，只有非 dry-run 的用例挂）。基准之上属于系统布置，既不是我们能
/// 控制的东西，也不构成逃逸——我们本来就是从这条路径找到的文件。
///
/// `path` 不在 `base` 之下时退回完整链检查：那说明调用方给了个不在管辖范围内的
/// 路径，宁可多拒，不能放宽。
pub fn has_reparse_component_under(path: &Path, base: &Path) -> bool {
    if !path_starts_with(path, base) {
        return has_reparse_component(path);
    }
    let mut p = path;
    loop {
        if let Ok(md) = std::fs::symlink_metadata(p) {
            if is_reparse(&md) {
                return true;
            }
        }
        // 含 base 自身：模块目录本身是链接时整块拒绝
        if eq_path(p, base) {
            return false;
        }
        match p.parent() {
            Some(parent) if parent != p => p = parent,
            _ => return false,
        }
    }
}

/// 路径比较：Windows 不区分大小写，统一 `/` 后比较。
pub fn eq_path(a: &Path, b: &Path) -> bool {
    slash(a).eq_ignore_ascii_case(&slash(b))
}

pub fn path_starts_with(path: &Path, base: &Path) -> bool {
    let p = slash(path);
    let b = slash(base);
    p.len() >= b.len()
        && p.is_char_boundary(b.len())
        && p[..b.len()].eq_ignore_ascii_case(&b)
        && (p.len() == b.len() || p.as_bytes()[b.len()] == b'/')
}

/// 去掉前缀并返回相对路径；比较忽略大小写、分隔符统一。
pub fn strip_prefix_ci(path: &Path, base: &Path) -> Option<PathBuf> {
    if !path_starts_with(path, base) {
        return None;
    }
    let p = slash(path);
    let b = slash(base);
    let rest = p[b.len()..].trim_start_matches('/');
    Some(PathBuf::from(
        rest.replace('/', std::path::MAIN_SEPARATOR_STR),
    ))
}

pub fn slash(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

fn clean_rel(p: &Path) -> String {
    slash(p)
        .trim_start_matches('/')
        .trim_end_matches('/')
        .to_string()
}

/// `src/test`（以及 `test`）默认不参与编译：与现状一致，先不把测试产物混进主产物。
fn is_test_root(rel: &str) -> bool {
    let mut it = rel.split('/').filter(|s| !s.is_empty());
    match (it.next(), it.next()) {
        (Some(a), Some(b)) => {
            (a.eq_ignore_ascii_case("src") && b.eq_ignore_ascii_case("test"))
                || a.eq_ignore_ascii_case("test")
        }
        (Some(a), None) => a.eq_ignore_ascii_case("test"),
        _ => false,
    }
}

/// 清单 / 清理的安全路径拼接：拒绝绝对路径、`..`、盘符与空段。
pub fn safe_join(base: &Path, rel: &str) -> Option<PathBuf> {
    let mut out = base.to_path_buf();
    for part in rel.replace('\\', "/").split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." || part.contains(':') {
            return None;
        }
        out.push(part);
    }
    Some(out)
}

/// 去重（忽略大小写）但保序。
pub fn dedupe_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for p in paths {
        let key = slash(&p).to_ascii_lowercase();
        if seen.insert(key) {
            out.push(p);
        }
    }
    out
}

/// 测试用：造目录符号链接。Windows 需要开发者模式，建不出来由调用方跳过。
#[cfg(all(test, unix))]
fn dir_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(all(test, windows))]
fn dir_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_dir(target, link)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ncwb-layout-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn classpath_per_src_output_and_default_output_are_both_honored() {
        let root = tmp("cp");
        let m = root.join("pm");
        std::fs::create_dir_all(m.join("src/public")).unwrap();
        std::fs::create_dir_all(m.join("src/client")).unwrap();
        std::fs::write(
            m.join(".classpath"),
            r#"<classpath>
              <classpathentry kind="src" path="src/public" output="out/uapbd"/>
              <classpathentry kind="src" path="src/client"/>
              <classpathentry kind="output" path="bin"/>
            </classpath>"#,
        )
        .unwrap();
        let l = ModuleLayout::resolve(&root, "pm");
        assert!(l.has_classpath);
        assert_eq!(l.source_roots.len(), 2);
        // 先声明的输出在前，且两条 src 都进了组
        assert_eq!(l.outputs.len(), 2);
        let public = m.join("src/public/nc/A.java");
        let client = m.join("src/client/nc/B.java");
        assert_eq!(l.output_for(&public).unwrap(), m.join("out/uapbd"));
        assert_eq!(l.output_for(&client).unwrap(), m.join("bin"));
    }

    #[test]
    fn legacy_layout_falls_back_to_classes_and_skips_test_roots() {
        let root = tmp("legacy");
        let m = root.join("gl");
        std::fs::create_dir_all(m.join("src/public")).unwrap();
        std::fs::create_dir_all(m.join("src/test")).unwrap();
        let l = ModuleLayout::resolve(&root, "gl");
        assert!(!l.has_classpath);
        assert_eq!(l.outputs, vec![m.join("classes")]);
        assert_eq!(l.source_roots, vec![m.join("src/public")]);
    }

    #[test]
    fn classpath_test_root_is_excluded_but_other_srcs_kept() {
        let root = tmp("testroot");
        let m = root.join("gl");
        std::fs::create_dir_all(m.join("src/main")).unwrap();
        std::fs::create_dir_all(m.join("src/test")).unwrap();
        std::fs::write(
            m.join(".classpath"),
            r#"<classpath>
              <classpathentry kind="src" path="src/main"/>
              <classpathentry kind="src" path="src/test"/>
            </classpath>"#,
        )
        .unwrap();
        let l = ModuleLayout::resolve(&root, "gl");
        assert_eq!(l.source_roots, vec![m.join("src/main")]);
    }

    #[test]
    fn longest_source_root_wins() {
        let root = tmp("longest");
        let m = root.join("gl");
        std::fs::create_dir_all(m.join("src")).unwrap();
        std::fs::create_dir_all(m.join("src/public")).unwrap();
        std::fs::write(
            m.join(".classpath"),
            r#"<classpath>
              <classpathentry kind="src" path="src"/>
              <classpathentry kind="src" path="src/public"/>
            </classpath>"#,
        )
        .unwrap();
        let l = ModuleLayout::resolve(&root, "gl");
        let f = m.join("src/public/A.java");
        assert_eq!(l.source_root_of(&f).unwrap(), m.join("src/public"));
        assert_eq!(l.rel_source_of(&f).as_deref(), Some("A.java"));
    }

    #[test]
    fn safe_join_rejects_escape_and_absolute_paths() {
        let base = Path::new("C:/ws/m/classes");
        assert!(safe_join(base, "../x.class").is_none());
        assert!(safe_join(base, "C:/Windows/x.class").is_none());
        assert_eq!(
            safe_join(base, "nc/vo/A.class").unwrap(),
            base.join("nc").join("vo").join("A.class")
        );
    }

    #[test]
    fn manifest_layout_comparison_is_order_insensitive() {
        let root = tmp("cmp");
        let m = root.join("gl");
        std::fs::create_dir_all(m.join("src/public")).unwrap();
        let l = ModuleLayout::resolve(&root, "gl");
        assert!(l.matches_manifest(&["src/public".to_string()], &["classes".to_string()]));
        assert!(!l.matches_manifest(&["src/client".to_string()], &["classes".to_string()]));
    }

    /// 重解析点检查以模块目录为界：**之上**的符号链接不算逃逸，**之内**的必须拒。
    ///
    /// 2026-11-06 CI 的 macOS job 红在这里——`/var` 是 `/private/var` 的符号链接，
    /// 临时目录下每次真删产物都被判成「跟随重解析点」，清理整体失效（dry-run 不
    /// 检查路径所以通过了，掩盖了问题：只有非 dry-run 的用例挂）。
    #[test]
    fn 重解析点检查在模块目录处截止() {
        let root = tmp("reparse");
        let real = root.join("real");
        let classes = real.join("gl/classes/p");
        std::fs::create_dir_all(&classes).unwrap();
        std::fs::write(classes.join("A.class"), b"x").unwrap();

        // 模拟「祖先目录是链接」：macOS 的 /var，或 Linux/macOS 的 /tmp。
        // 建不出来就跳过（Windows 建目录符号链接要开发者模式）；
        // CI 的 macOS 上必然建得出来，那边正是出问题的平台。
        let link = root.join("via-link");
        if dir_symlink(&real, &link).is_err() {
            let _ = std::fs::remove_dir_all(&root);
            return;
        }
        let module = link.join("gl");
        let class = module.join("classes/p/A.class");

        assert!(
            has_reparse_component(&class),
            "完整链检查会看到祖先链接——这正是它误伤 macOS 的原因"
        );
        assert!(
            !has_reparse_component_under(&class, &module),
            "模块目录之上的链接不算逃逸，否则 macOS 上清理永远删不动"
        );

        // 模块目录**之内**出现链接仍然要拒：那才是真正的逃逸路径。
        let inner = module.join("classes/linkp");
        if dir_symlink(&classes, &inner).is_ok() {
            assert!(
                has_reparse_component_under(&inner.join("A.class"), &module),
                "模块目录之内的链接必须拒绝"
            );
        }
        let _ = std::fs::remove_dir_all(&root);
    }
}
