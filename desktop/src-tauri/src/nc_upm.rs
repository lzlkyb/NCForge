//! `META-INF/*.upm`：NC 的**组件装配表**（接口 → 实现），以及围绕它的诊断。
//!
//! ## 为什么要有这个模块
//!
//! NC 的调用链是「`NCLocator.lookup(IXxxService.class)` → 由 `<模块>/META-INF/*.upm`
//! 决定用哪个实现类」。这张表不由编译器校验：实现类改名、挪包、没写进 upm，
//! 编译**全绿**，运行时才炸。2026-11-04 实测本机 `ar2025/eye` 的 29 个 upm、
//! 39 条装配里就有 1 条彻底悬空的（`ic/META-INF/aiersign.upm` 的接口与实现
//! 在工程源码、NCHOME 散类、全库 6480 个 jar 里都不存在）。
//!
//! 现有的 `nchome_deploy.rs` 只负责把这些文件**投送**到 NCHOME，不读内容，
//! 所以「送得过去」和「送过去是对的」是两件事，这里补后者。
//!
//! ## 三条口径（都与实测对齐）
//!
//! 1. **模块归属以路径为准，不以 `<module name>` 为准**。实测 `ic/META-INF/icwl.upm`
//!    里声明的是 `name="puwl"`，与目录不符。声明名仍然读出来，不一致要报
//!    （`module-mismatch`），但不能拿它去覆盖路径推出的模块名。
//! 2. **工程侧优先于 NCHOME 侧**。部署时工程会覆盖产品同名文件（`nchome_deploy.rs`
//!    已实现覆盖 + 备份），所以「找实现」要先给工程那份，否则拿到的是被覆盖的旧类。
//! 3. **不知道就说不知道**。类是否存在由调用方给（[`Presence`]）：`Unknown` 一律
//!    不报 `missing`——只查了工程源码和散类目录就说「类不存在」是撒谎，
//!    精确判定必须靠类索引（jar 里的类）。
//!
//! 解析器是手写的最小实现（同 `nc_manifest.rs` 的理由：格式固定，引 XML crate 不划算，
//! 且它必须永不 panic）。纯逻辑模块，不含 tauri 类型。

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use encoding_rs::GBK;
use serde::Serialize;

/// upm 所在的目录名。
pub const UPM_DIR: &str = "META-INF";
/// 扩展名（小写比较）。
pub const UPM_EXT: &str = "upm";

/// 装配表的来源层。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpmOrigin {
    /// 工程工作副本里的（会被部署覆盖产品侧）。
    Project,
    /// NCHOME 产品侧自带的。
    Product,
}

impl UpmOrigin {
    pub fn as_str(self) -> &'static str {
        match self {
            UpmOrigin::Project => "project",
            UpmOrigin::Product => "product",
        }
    }
}

/// 一条 `<component>`。字段名保持 upm 里的原名，便于对着文件读。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpmComponent {
    pub interface: String,
    pub implementation: String,
    /// `public` / `private`；不在任何层里则空串。
    pub visibility: String,
    pub remote: bool,
    pub singleton: bool,
    /// 事务属性（实测值 `CMT`）；没写就是空串。
    pub tx: String,
    pub alias: bool,
    /// 实测有 `priority="0"`；没写就是 `None`。
    pub priority: Option<i32>,
}

/// 一个 upm 文件。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpmFile {
    /// `<module name>` 声明的名字。可能与路径不符（见模块文档），**仅作诊断用**。
    pub declared_module: String,
    /// 路径推出的模块名（`.../<模块>/META-INF/x.upm` 的 `<模块>`）。唯一的归属真源。
    pub module: String,
    pub path: String,
    pub origin: UpmOrigin,
    pub components: Vec<UpmComponent>,
}

/// 扁平化的一条「接口 → 实现」，索引与前端查表用这个。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpmEntry {
    pub interface: String,
    pub implementation: String,
    pub module: String,
    pub path: String,
    pub origin: UpmOrigin,
    pub visibility: String,
    pub remote: bool,
    pub tx: String,
    pub singleton: bool,
}

/// 装配索引。`entries` 的顺序即优先级：工程侧在前。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpmIndex {
    pub entries: Vec<UpmEntry>,
    pub files: Vec<UpmFile>,
    /// 解析/读取过程中遇到的问题（读不动、没有 module、坏文件）。界面只陈述事实。
    pub notes: Vec<String>,
}

/// 类是否存在的三种结论。`Unknown` 是关键：不能把「没查到」当成「不存在」。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Presence {
    /// 找到了，附带证据（`工程源码` / `classes 散类` / `jar: xxx.jar`）。
    Found(String),
    /// 确定不存在（查了完整的类搜索范围）。
    Missing,
    /// 搜索范围不完整（例如类索引还没建），不下结论。
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum IssueKind {
    /// `<implementation>` 指向的类不存在 —— 这条是会在运行时炸的。
    MissingImpl,
    /// `<interface>` 指向的类不存在。接口没了实现还在，通常是重构留下的残骸。
    MissingInterface,
    /// 同一个接口被多处装配，且实现类不同 —— 覆盖链风险。
    DuplicateImpl,
    /// `<module name>` 与所在目录不一致。
    ModuleMismatch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Severity {
    Error,
    Warning,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpmIssue {
    pub kind: IssueKind,
    pub severity: Severity,
    pub module: String,
    pub path: String,
    /// 相关的类名（`module-mismatch` 时为空）。
    pub class_name: String,
    pub detail: String,
}

/// 扫描结果。
#[derive(Debug, Clone, Default)]
pub struct Scan {
    pub files: Vec<UpmFile>,
    pub notes: Vec<String>,
}

/// 扫一个工程根：根 `META-INF/*.upm` + 一级子目录 `<模块>/META-INF/*.upm`。
///
/// 只下一层是刻意的：NC 工程的模块目录都在一级（与 `eclipse_cp::module_dirs_of`
/// 的口径一致），更深层的 `META-INF` 属于 jar 内部或无关目录，扫进来只会误报。
pub fn scan_project(root: &Path) -> Scan {
    let mut out = Scan::default();
    let root_meta = root.join(UPM_DIR);
    if root_meta.is_dir() {
        // 根 META-INF 对应的模块名要看 module.xml 声明（本机 EyePortal 声明的是 eye）
        let module = crate::nchome_deploy::declared_module(&root_meta)
            .unwrap_or_else(|| dir_name(root).unwrap_or_default());
        scan_metainf(&root_meta, &module, UpmOrigin::Project, &mut out);
    }
    let Ok(rd) = std::fs::read_dir(root) else {
        out.notes
            .push(format!("读不到工程目录：{}", root.display()));
        return out;
    };
    let mut dirs: Vec<PathBuf> = Vec::new();
    for e in rd.flatten() {
        if !e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = e.file_name().to_string_lossy().to_string();
        // 与文件树的隐藏目录口径一致：版本库/IDE 目录里不会有 upm
        if name.starts_with('.') {
            continue;
        }
        dirs.push(e.path());
    }
    dirs.sort();
    for d in dirs {
        let meta = d.join(UPM_DIR);
        if !meta.is_dir() {
            continue;
        }
        // 一级子目录的模块名取**目录名**，不取 module.xml：归属的真源是 NC 按路径扫
        // （`nchome_deploy.rs` 头注释），而 `icwl.upm` 这类文件内部声明的名字可能已经错位，
        // 用它去覆盖目录名就把「不一致」这个事实抹掉了。
        let module = dir_name(&d).unwrap_or_default();
        scan_metainf(&meta, &module, UpmOrigin::Project, &mut out);
    }
    out
}

/// 扫 NCHOME：`<home>/modules/<模块>/META-INF/*.upm`。
pub fn scan_home(home: &Path) -> Scan {
    let mut out = Scan::default();
    let modules = home.join("modules");
    let Ok(rd) = std::fs::read_dir(&modules) else {
        out.notes
            .push(format!("读不到模块目录：{}", modules.display()));
        return out;
    };
    let mut dirs: Vec<PathBuf> = rd
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| e.path())
        .collect();
    dirs.sort();
    for d in dirs {
        let meta = d.join(UPM_DIR);
        if !meta.is_dir() {
            continue;
        }
        let module = dir_name(&d).unwrap_or_default();
        scan_metainf(&meta, &module, UpmOrigin::Product, &mut out);
    }
    out
}

/// 扫一个 `META-INF` 目录下的全部 upm。
fn scan_metainf(meta: &Path, module: &str, origin: UpmOrigin, out: &mut Scan) {
    let Ok(rd) = std::fs::read_dir(meta) else {
        out.notes.push(format!("读不到目录：{}", meta.display()));
        return;
    };
    let mut files: Vec<PathBuf> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.extension()
                .map(|x| x.to_string_lossy().eq_ignore_ascii_case(UPM_EXT))
                .unwrap_or(false)
        })
        .collect();
    files.sort();
    for p in files {
        let bytes = match std::fs::read(&p) {
            Ok(b) => b,
            Err(e) => {
                out.notes.push(format!("读取失败 {}: {e}", p.display()));
                continue;
            }
        };
        let (declared, components) = parse(&decode(&bytes));
        if components.is_empty() {
            // 空 upm 在 NC 里也存在（占位），不算错误；记一笔便于解释「为什么这里没有组件」
            out.notes
                .push(format!("{} 里没有解析出 component", p.display()));
        }
        out.files.push(UpmFile {
            declared_module: declared.unwrap_or_default(),
            module: module.to_string(),
            path: p.to_string_lossy().to_string(),
            origin,
            components,
        });
    }
}

/// 把两批扫描结果合成一个索引。工程侧在前（部署时覆盖产品侧）。
pub fn build(project: Scan, product: Scan) -> UpmIndex {
    let mut index = UpmIndex::default();
    index.notes.extend(project.notes);
    index.notes.extend(product.notes);
    for f in project.files.into_iter().chain(product.files) {
        for c in &f.components {
            index.entries.push(UpmEntry {
                interface: c.interface.clone(),
                implementation: c.implementation.clone(),
                module: f.module.clone(),
                path: f.path.clone(),
                origin: f.origin,
                visibility: c.visibility.clone(),
                remote: c.remote,
                tx: c.tx.clone(),
                singleton: c.singleton,
            });
        }
        index.files.push(f);
    }
    index
}

impl UpmIndex {
    /// 按接口找实现（大小写不敏感，用户可能从别处粘来大小写不一致的名字）。
    pub fn lookup(&self, interface: &str) -> Vec<&UpmEntry> {
        let want = interface.trim();
        self.entries
            .iter()
            .filter(|e| e.interface.eq_ignore_ascii_case(want))
            .collect()
    }

    /// 反过来：这个实现类被哪些装配引用。
    pub fn by_implementation(&self, class: &str) -> Vec<&UpmEntry> {
        let want = class.trim();
        self.entries
            .iter()
            .filter(|e| e.implementation.eq_ignore_ascii_case(want))
            .collect()
    }
}

/// 跑诊断。`presence` 由命令层提供：它知道去哪找类（工程源码 / 散类 / jar 索引）。
///
/// 只报有实据的问题：`Presence::Unknown` 不产生 `missing` 诊断，但会进 `notes`，
/// 让人知道「这次没查全」，而不是以为查干净了。
pub fn diagnose(index: &UpmIndex, presence: &dyn Fn(&str) -> Presence) -> Vec<UpmIssue> {
    let mut out: Vec<UpmIssue> = Vec::new();
    let mut seen: Vec<(String, String)> = Vec::new();

    for f in &index.files {
        // 1. 声明名与路径不符
        if !f.declared_module.trim().is_empty()
            && !f
                .declared_module
                .trim()
                .eq_ignore_ascii_case(f.module.trim())
        {
            out.push(UpmIssue {
                kind: IssueKind::ModuleMismatch,
                severity: Severity::Warning,
                module: f.module.clone(),
                path: f.path.clone(),
                class_name: String::new(),
                detail: format!(
                    "声明 module=\"{}\"，但文件在 {} 模块的 META-INF 下。NC 按路径找注册表，归属以路径为准",
                    f.declared_module.trim(),
                    f.module
                ),
            });
        }
    }

    for e in &index.entries {
        for (class, kind, label) in [
            (&e.implementation, IssueKind::MissingImpl, "实现类"),
            (&e.interface, IssueKind::MissingInterface, "接口"),
        ] {
            if class.trim().is_empty() {
                continue;
            }
            // 同一个 (文件, 类) 只报一次：一个 upm 可能重复装配同一对
            let key = (e.path.clone(), class.clone());
            if seen.contains(&key) {
                continue;
            }
            match presence(class) {
                Presence::Missing => {
                    seen.push(key);
                    out.push(UpmIssue {
                        kind,
                        severity: if kind == IssueKind::MissingImpl {
                            Severity::Error
                        } else {
                            Severity::Warning
                        },
                        module: e.module.clone(),
                        path: e.path.clone(),
                        class_name: class.clone(),
                        detail: format!(
                            "{label} {class} 在工程源码、NCHOME 散类与类索引里都找不到。\
                             配置能编译通过，但运行时 lookup 会失败"
                        ),
                    });
                }
                // Unknown 不进诊断：没查全就说「不存在」是撒谎
                Presence::Found(_) | Presence::Unknown => {}
            }
        }
    }

    // 2. 同一接口被不同实现装配（覆盖链风险）
    let mut by_iface: Vec<(&str, Vec<&UpmEntry>)> = Vec::new();
    for e in &index.entries {
        if e.interface.trim().is_empty() {
            continue;
        }
        match by_iface
            .iter_mut()
            .find(|(i, _)| i.eq_ignore_ascii_case(&e.interface))
        {
            Some((_, v)) => v.push(e),
            None => by_iface.push((&e.interface, vec![e])),
        }
    }
    for (iface, list) in by_iface {
        let mut impls: Vec<&str> = Vec::new();
        for e in &list {
            if !impls
                .iter()
                .any(|i| i.eq_ignore_ascii_case(&e.implementation))
            {
                impls.push(&e.implementation);
            }
        }
        if impls.len() < 2 {
            continue;
        }
        let files: Vec<String> = {
            let mut v: Vec<String> = Vec::new();
            for e in &list {
                if !v.contains(&e.path) {
                    v.push(e.path.clone());
                }
            }
            v
        };
        out.push(UpmIssue {
            kind: IssueKind::DuplicateImpl,
            severity: Severity::Warning,
            module: list[0].module.clone(),
            path: files.join(" | "),
            class_name: iface.to_string(),
            detail: format!(
                "接口被 {} 条装配指向 {} 个不同实现：{}。工程侧覆盖产品侧，\
                 其余按加载顺序生效——排查「为什么生效的不是我改的那个」先看这里",
                list.len(),
                impls.len(),
                impls.join(" / ")
            ),
        });
    }

    out
}

/// 解析一个 upm 文本。永不 panic：坏文件得到空组件清单。
pub fn parse(text: &str) -> (Option<String>, Vec<UpmComponent>) {
    let clean = strip_comments(text);
    let mut b = Builder::default();

    let mut rest = clean.as_str();
    while let Some(lt) = rest.find('<') {
        let text_part = &rest[..lt];
        let after = &rest[lt..];
        let Some(gt) = after.find('>') else { break };
        // `<` 与 `>` 之间就是标签体；越界一律当坏文件停手（下面的 rest 仍会前移）
        if gt > 1 {
            b.tag(&after[1..gt]);
        }
        b.text(text_part);
        rest = &after[gt + 1..];
    }
    b.text(rest);
    b.finish();
    (b.declared, b.components)
}

#[derive(Default)]
struct Builder {
    declared: Option<String>,
    components: Vec<UpmComponent>,
    visibility: String,
    cur: Option<UpmComponent>,
    /// 上一个打开的文本容器（`interface` / `implementation`）。
    cap: Cap,
}

#[derive(Default, Clone, Copy, PartialEq, Eq)]
enum Cap {
    #[default]
    None,
    Interface,
    Implementation,
}

impl Builder {
    fn text(&mut self, t: &str) {
        let v = t.trim();
        if v.is_empty() || self.cap == Cap::None {
            return;
        }
        let Some(c) = self.cur.as_mut() else {
            self.cap = Cap::None;
            return;
        };
        match self.cap {
            Cap::Interface => c.interface = v.to_string(),
            Cap::Implementation => c.implementation = v.to_string(),
            Cap::None => {}
        }
        // 一个容器只吃一段文本，吃完就关，避免把后面的空白/换行算进去
        self.cap = Cap::None;
    }

    fn tag(&mut self, raw: &str) {
        let raw = raw.trim();
        if raw.is_empty() || raw.starts_with('?') || raw.starts_with('!') {
            return;
        }
        let closing = raw.starts_with('/');
        let body = raw.trim_start_matches('/').trim_end_matches('/');
        let (name, attrs) = split_tag_name(body);
        // 遇到新的开始标签，之前的文本捕获目标失效（`<interface>` 后直接跟 `<b>` 这种坏格式）
        if !closing {
            self.cap = Cap::None;
        }

        if name.eq_ignore_ascii_case("module") && !closing && self.declared.is_none() {
            self.declared = attr(attrs, "name").filter(|v| !v.trim().is_empty());
            return;
        }
        if name.eq_ignore_ascii_case("public") || name.eq_ignore_ascii_case("private") {
            self.visibility = if closing {
                String::new()
            } else {
                name.to_ascii_lowercase()
            };
            return;
        }
        if name.eq_ignore_ascii_case("component") {
            if closing {
                self.push();
            } else {
                // 上一个没闭合的脏数据先收进结果，别丢
                self.push();
                self.cur = Some(UpmComponent {
                    visibility: self.visibility.clone(),
                    remote: flag(attrs, "remote"),
                    singleton: flag(attrs, "singleton"),
                    tx: attr(attrs, "tx").unwrap_or_default(),
                    alias: flag(attrs, "supportAlias"),
                    priority: attr(attrs, "priority").and_then(|v| v.trim().parse().ok()),
                    ..UpmComponent::default()
                });
            }
            return;
        }
        if closing {
            return;
        }
        if name.eq_ignore_ascii_case("interface") {
            self.cap = Cap::Interface;
        } else if name.eq_ignore_ascii_case("implementation") {
            self.cap = Cap::Implementation;
        }
    }

    fn push(&mut self) {
        if let Some(c) = self.cur.take() {
            if !c.interface.trim().is_empty() || !c.implementation.trim().is_empty() {
                self.components.push(c);
            }
        }
    }

    fn finish(&mut self) {
        self.push();
    }
}

/// 读一个工程里的 upm 文件（测试与其他调用方用）。
pub fn read_file(path: &Path) -> Result<UpmFile, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("读取失败 {}: {e}", path.display()))?;
    let (declared, components) = parse(&decode(&bytes));
    let module = path
        .parent()
        .and_then(|p| p.parent())
        .and_then(dir_name)
        .unwrap_or_default();
    Ok(UpmFile {
        declared_module: declared.unwrap_or_default(),
        module,
        path: path.to_string_lossy().to_string(),
        origin: UpmOrigin::Project,
        components,
    })
}

fn dir_name(p: &Path) -> Option<String> {
    p.file_name().map(|n| n.to_string_lossy().to_string())
}

/// 工程里的类全名（`<模块>/src/{public,client,private,test}` 下的 `.java`）。
///
/// 用一次遍历而不是按类名逐个拼路径 stat：类可能有几百个、模块有几十个，
/// 逐个探测是几十万次系统调用；遍历两千多个文件只要几十毫秒。
pub fn collect_project_classes(root: &Path) -> HashSet<String> {
    let mut out = HashSet::new();
    let Ok(rd) = std::fs::read_dir(root) else {
        return out;
    };
    for m in rd.flatten() {
        if !m.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let Ok(layers) = std::fs::read_dir(m.path().join("src")) else {
            continue;
        };
        for layer in layers.flatten() {
            if layer.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                let base = layer.path();
                walk_files(&base, &base, "java", &mut out);
            }
        }
    }
    out
}

/// NCHOME 散类目录里的类全名。
///
/// 实测这台机器上 345 个散类目录里 **0 个 `.class`**（类全在 jar 里），所以这一步几乎空转；
/// 但现场补丁会落在 `hyext/classes`，那些类不在任何 jar 里，漏了就会把打了补丁的
/// 实现类误判成「不存在」。
pub fn collect_home_classes(home: &Path) -> HashSet<String> {
    let mut out = HashSet::new();
    for d in crate::nc_index::module_class_dirs(home) {
        walk_files(&d, &d, "class", &mut out);
    }
    out
}

fn walk_files(dir: &Path, base: &Path, ext: &str, out: &mut HashSet<String>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let Ok(ft) = e.file_type() else { continue };
        let p = e.path();
        if ft.is_dir() {
            walk_files(&p, base, ext, out);
        } else if p
            .extension()
            .map(|x| x.to_string_lossy().eq_ignore_ascii_case(ext))
            .unwrap_or(false)
        {
            if let Ok(rel) = p.strip_prefix(base) {
                out.insert(path_to_class(rel, ext));
            }
        }
    }
}

/// `nc/impl/A.java` → `nc.impl.A`。分隔符与扩展名都吃掉。
fn path_to_class(rel: &Path, ext: &str) -> String {
    let s = rel.to_string_lossy().replace(['/', '\\'], ".");
    let tail = format!(".{ext}");
    s.strip_suffix(&tail).unwrap_or(&s).to_string()
}

/// upm 实测 UTF-8 与 `gbk` 混放（`icwl.upm` 声明 gbk 且注释是乱码）。
/// 先 UTF-8 再 GBK：反过来会把合法 UTF-8 中文读成乱码。
fn decode(bytes: &[u8]) -> String {
    let body = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF][..]).unwrap_or(bytes);
    match std::str::from_utf8(body) {
        Ok(s) => s.to_string(),
        Err(_) => GBK.decode(body).0.into_owned(),
    }
}

/// 去掉 XML 注释：被注释掉的 component 不该算数。
fn strip_comments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find("<!--") {
        out.push_str(&rest[..i]);
        match rest[i + 4..].find("-->") {
            Some(j) => rest = &rest[i + 4 + j + 3..],
            None => return out,
        }
    }
    out.push_str(rest);
    out
}

fn split_tag_name(tag: &str) -> (&str, &str) {
    let end = tag
        .find(|c: char| c.is_whitespace() || c == '/' || c == '>')
        .unwrap_or(tag.len());
    (&tag[..end], &tag[end..])
}

/// 取属性值。必须校验 key 前面是空白，否则 `supportAlias` 里的 `alias`、
/// `implementation` 里的 `implement` 都会被误命中。
fn attr(tag: &str, key: &str) -> Option<String> {
    for (start, _) in tag.match_indices(key) {
        let prev_ok = start == 0 || tag.as_bytes()[start - 1].is_ascii_whitespace();
        if !prev_ok {
            continue;
        }
        let rest = tag[start + key.len()..].trim_start();
        if let Some(rest) = rest.strip_prefix('=') {
            let rest = rest.trim_start();
            let quote = rest.chars().next()?;
            if quote == '"' || quote == '\'' {
                let body = &rest[1..];
                return body.find(quote).map(|end| body[..end].to_string());
            }
        }
    }
    None
}

/// 布尔属性：只有明确的 true/1/yes 才算真（缺省是 false）。
fn flag(tag: &str, key: &str) -> bool {
    attr(tag, key)
        .map(|v| {
            let v = v.trim().to_ascii_lowercase();
            v == "true" || v == "1" || v == "yes"
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"<?xml version='1.0' encoding='UTF-8'?>
<module name="aierreport">
	<public>
		<component remote="true" singleton="true" tx="CMT">
			<interface>nc.itf.aier.report.service.IAierICReportService</interface>
			<implementation>nc.impl.aier.report.service.AierICReportServiceImpl</implementation>
		</component>
	</public>
</module>"#;

    #[test]
    fn 解析出接口与实现及属性() {
        let (module, comps) = parse(SAMPLE);
        assert_eq!(module.as_deref(), Some("aierreport"));
        assert_eq!(comps.len(), 1);
        let c = &comps[0];
        assert_eq!(
            c.interface,
            "nc.itf.aier.report.service.IAierICReportService"
        );
        assert_eq!(
            c.implementation,
            "nc.impl.aier.report.service.AierICReportServiceImpl"
        );
        assert_eq!(c.visibility, "public");
        assert!(c.remote);
        assert!(c.singleton);
        assert_eq!(c.tx, "CMT");
        assert!(!c.alias);
        assert_eq!(c.priority, None);
    }

    /// 实测 `ic/META-INF/icwl.upm`：含 `priority="0" supportAlias="true"`，声明 gbk。
    #[test]
    fn 解析优先级与别名且不误命中_implement() {
        let (_, comps) = parse(
            r#"<module name="puwl"><public>
                 <component priority="0" singleton="true" remote="true" tx="CMT" supportAlias="true">
                   <interface>nc.itf.aier.back.service.IAierBackWLService</interface>
                   <implementation>nc.impl.aier.back.service.AierBackWLServiceImpl</implementation>
                 </component>
               </public></module>"#,
        );
        let c = &comps[0];
        assert_eq!(c.priority, Some(0));
        assert!(c.alias);
        assert_eq!(
            c.implementation,
            "nc.impl.aier.back.service.AierBackWLServiceImpl"
        );
    }

    #[test]
    fn 一个文件多个组件都要收() {
        let (_, comps) = parse(
            r#"<module name="x">
                 <public><component><interface>A</interface><implementation>AImpl</implementation></component></public>
                 <public><component><interface>B</interface><implementation>BImpl</implementation></component></public>
                 <private><component remote="false"><interface>C</interface><implementation>CImpl</implementation></component></private>
               </module>"#,
        );
        assert_eq!(comps.len(), 3);
        assert_eq!(comps[2].visibility, "private");
        assert_eq!(comps[1].interface, "B");
    }

    /// 注释掉的组件不算；但注释后面的正常组件要保留。
    #[test]
    fn 注释里的组件被忽略() {
        let (_, comps) = parse(
            r#"<module name="x">
                 <!-- 接口 -->
                 <!-- <component><interface>Old</interface><implementation>OldImpl</implementation></component> -->
                 <public><component><interface>New</interface><implementation>NewImpl</implementation></component></public>
               </module>"#,
        );
        assert_eq!(comps.len(), 1);
        assert_eq!(comps[0].interface, "New");
    }

    #[test]
    fn 坏输入不panic也只得到空清单() {
        for bad in ["", "<module", "<component>", "<module name=", "<<<>>>"] {
            let (_, comps) = parse(bad);
            assert!(comps.is_empty(), "输入 {bad:?} 不该解析出组件");
        }
    }

    /// 没写 `</component>` 就结束的脏数据：已解析到的字段要留下，不能整条丢。
    #[test]
    fn 未闭合的组件仍然保留() {
        let (_, comps) = parse(
            r#"<module name="x"><public><component><interface>A</interface><implementation>AImpl</implementation></public></module>"#,
        );
        assert_eq!(comps.len(), 1);
        assert_eq!(comps[0].implementation, "AImpl");
    }

    #[test]
    fn 工程侧优先于产品侧() {
        let project = Scan {
            files: vec![UpmFile {
                declared_module: "m".into(),
                module: "m".into(),
                path: "proj/m/META-INF/a.upm".into(),
                origin: UpmOrigin::Project,
                components: vec![UpmComponent {
                    interface: "X".into(),
                    implementation: "ProjImpl".into(),
                    visibility: "public".into(),
                    ..UpmComponent::default()
                }],
            }],
            notes: vec![],
        };
        let product = Scan {
            files: vec![UpmFile {
                declared_module: "m".into(),
                module: "m".into(),
                path: "home/modules/m/META-INF/a.upm".into(),
                origin: UpmOrigin::Product,
                components: vec![UpmComponent {
                    interface: "X".into(),
                    implementation: "ProdImpl".into(),
                    visibility: "public".into(),
                    ..UpmComponent::default()
                }],
            }],
            notes: vec![],
        };
        let idx = build(project, product);
        let hits = idx.lookup("X");
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].implementation, "ProjImpl", "工程侧必须排前面");
        assert_eq!(hits[0].origin, UpmOrigin::Project);
        assert_eq!(
            idx.lookup("x")[0].implementation,
            "ProjImpl",
            "大小写不敏感"
        );
        assert_eq!(idx.by_implementation("ProjImpl").len(), 1);
    }

    /// 诊断只报有实据的：`Unknown` 不产生 missing。
    #[test]
    fn 未知的类不报缺失() {
        let idx = one_group("I", "Impl");
        let issues = diagnose(&idx, &|_| Presence::Unknown);
        assert!(issues.is_empty(), "没查全就不能说找不到：{issues:?}");
    }

    #[test]
    fn 实现类缺失报_error_接口缺失报_warning() {
        let idx = one_group("nc.itf.I", "nc.impl.Impl");
        let issues = diagnose(&idx, &|c| match c {
            "nc.impl.Impl" => Presence::Missing,
            _ => Presence::Found("工程源码".into()),
        });
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].kind, IssueKind::MissingImpl);
        assert_eq!(issues[0].severity, Severity::Error);

        let issues = diagnose(&idx, &|c| match c {
            "nc.itf.I" => Presence::Missing,
            _ => Presence::Found("工程源码".into()),
        });
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].kind, IssueKind::MissingInterface);
        assert_eq!(issues[0].severity, Severity::Warning);
    }

    /// 实测 `icwl.upm`：文件在 ic 下、声明却是 puwl。
    #[test]
    fn 声明模块与路径不符要报出来() {
        let idx = build(
            Scan {
                files: vec![UpmFile {
                    declared_module: "puwl".into(),
                    module: "ic".into(),
                    path: "ic/META-INF/icwl.upm".into(),
                    origin: UpmOrigin::Project,
                    components: vec![],
                }],
                notes: vec![],
            },
            Scan::default(),
        );
        let issues = diagnose(&idx, &|_| Presence::Found("x".into()));
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].kind, IssueKind::ModuleMismatch);
        assert_eq!(issues[0].module, "ic");
        assert!(issues[0].detail.contains("puwl"));
    }

    #[test]
    fn 同一接口多个实现报覆盖风险() {
        let idx = build(
            Scan {
                files: vec![
                    UpmFile {
                        declared_module: "a".into(),
                        module: "a".into(),
                        path: "a/META-INF/a.upm".into(),
                        origin: UpmOrigin::Project,
                        components: vec![UpmComponent {
                            interface: "nc.itf.I".into(),
                            implementation: "nc.impl.A".into(),
                            ..UpmComponent::default()
                        }],
                    },
                    UpmFile {
                        declared_module: "b".into(),
                        module: "b".into(),
                        path: "b/META-INF/b.upm".into(),
                        origin: UpmOrigin::Product,
                        components: vec![UpmComponent {
                            interface: "nc.itf.I".into(),
                            implementation: "nc.impl.B".into(),
                            ..UpmComponent::default()
                        }],
                    },
                ],
                notes: vec![],
            },
            Scan::default(),
        );
        let issues = diagnose(&idx, &|_| Presence::Found("x".into()));
        let d: Vec<_> = issues
            .iter()
            .filter(|i| i.kind == IssueKind::DuplicateImpl)
            .collect();
        assert_eq!(d.len(), 1);
        assert!(d[0].detail.contains("nc.impl.A"));
        assert!(d[0].detail.contains("nc.impl.B"));
    }

    /// 同一接口被**同一个**实现装配两次（工程 + 产品各一份）不算冲突。
    #[test]
    fn 同实现重复装配不算冲突() {
        let idx = one_group("nc.itf.I", "nc.impl.Same");
        let issues = diagnose(&idx, &|_| Presence::Found("x".into()));
        assert!(
            !issues.iter().any(|i| i.kind == IssueKind::DuplicateImpl),
            "{issues:?}"
        );
    }

    /// 实测 aiersign.upm 的形状：接口与实现都不存在 ⇒ 两条都报。
    #[test]
    fn 接口与实现全悬空时两条都报() {
        let idx = one_group(
            "nc.itf.so.IAierPrintAndSignService",
            "nc.impl.so.AierPrintAndSignServiceImpl",
        );
        let issues = diagnose(&idx, &|_| Presence::Missing);
        let kinds: Vec<IssueKind> = issues.iter().map(|i| i.kind).collect();
        assert!(kinds.contains(&IssueKind::MissingImpl));
        assert!(kinds.contains(&IssueKind::MissingInterface));
    }

    /// GBK 文件要能读成中文（注释与中文模块名都有）。
    #[test]
    fn 读_gbk_文件() {
        let dir = tmpdir("gbk");
        let meta = dir.join("META-INF");
        std::fs::create_dir_all(&meta).unwrap();
        let text = r#"<module name="ic"><public><component tx="CMT"><interface>A</interface><implementation>B</implementation></component></public></module>"#;
        let (bytes, _, _) = GBK.encode(text);
        std::fs::write(meta.join("a.upm"), bytes.as_ref()).unwrap();
        let f = read_file(&meta.join("a.upm")).unwrap();
        // 模块名由路径推出：`<根>/META-INF/a.upm` 的父父目录名
        assert!(
            f.module.starts_with("ncwb-upm-gbk-"),
            "模块名应该来自目录：{}",
            f.module
        );
        assert_eq!(f.components.len(), 1);
        assert_eq!(f.declared_module, "ic");
    }

    /// 扫描只认 `META-INF/*.upm`，同目录的 `.aop`/`.rest` 与更深层都不算。
    #[test]
    fn 只扫_metainf_下的_upm() {
        let root = tmpdir("scan");
        let m1 = root.join("ic").join("META-INF");
        std::fs::create_dir_all(&m1).unwrap();
        std::fs::write(m1.join("a.upm"), SAMPLE).unwrap();
        std::fs::write(m1.join("b.aop"), "<x/>").unwrap();
        let deep = root.join("ic").join("META-INF").join("deep");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(deep.join("c.upm"), SAMPLE).unwrap();
        let scan = scan_project(&root);
        assert_eq!(scan.files.len(), 1);
        assert_eq!(scan.files[0].module, "ic");
    }

    fn one_group(iface: &str, imp: &str) -> UpmIndex {
        build(
            Scan {
                files: vec![UpmFile {
                    declared_module: "m".into(),
                    module: "m".into(),
                    path: "m/META-INF/a.upm".into(),
                    origin: UpmOrigin::Project,
                    components: vec![UpmComponent {
                        interface: iface.into(),
                        implementation: imp.into(),
                        visibility: "public".into(),
                        ..UpmComponent::default()
                    }],
                }],
                notes: vec![],
            },
            Scan::default(),
        )
    }

    fn tmpdir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("ncwb-upm-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
}

#[cfg(test)]
mod live_tests {
    use super::*;

    /// 本机真实工程与 NCHOME（与 `nc_manifest.rs` 的真机快照同口径：路径不存在就跳过）。
    const PROJECT: &str = r"D:\Workspaces\ar2025\eye";
    const HOME: &str = r"D:\NC65\nc65home";

    /// 真机快照：29 个 upm、39 条装配，其中 `ic/META-INF/aiersign.upm` 的接口与实现
    /// 在工程源码里都不存在（2026-11-04 实测；全库 6480 个 jar 亦无）。
    ///
    /// ```bash
    /// node scripts/rust-gate.mjs test --lib -- --ignored upm快照
    /// ```
    #[test]
    #[ignore = "真机：依赖 D:\\Workspaces\\ar2025\\eye"]
    fn upm快照_29文件39条装配与一条悬空() {
        let root = Path::new(PROJECT);
        if !root.is_dir() {
            eprintln!("跳过：本机没有 {PROJECT}");
            return;
        }
        let scan = scan_project(root);
        println!("工程侧 upm 文件 {} 个", scan.files.len());
        assert_eq!(
            scan.files.len(),
            29,
            "工程侧 upm 数量变了就说明工程结构动了"
        );
        let idx = build(scan, Scan::default());
        println!("装配条目 {} 条", idx.entries.len());
        assert_eq!(idx.entries.len(), 39);

        // 源码集合：确认那条悬空装配的两个类都不在工程里
        let src = collect_project_classes(root);
        assert!(
            !src.contains("nc.impl.so.AierPrintAndSignServiceImpl"),
            "这个类如果回来了，说明工程补上了代码，快照该更新"
        );
        assert!(!src.contains("nc.itf.so.IAierPrintAndSignService"));

        // 只查源码时不能断言「不存在」（jar 里可能有），一率 Unknown
        let presence = |c: &str| {
            let base = c.split('$').next().unwrap_or(c);
            if src.contains(base) {
                Presence::Found("工程源码".to_string())
            } else {
                Presence::Unknown
            }
        };
        let issues = diagnose(&idx, &presence);
        assert!(
            !issues.iter().any(|i| i.kind == IssueKind::MissingImpl),
            "没查 jar 就说实现类不存在是误报"
        );

        // `icwl.upm` 声明 `module="puwl"` 却放在 ic 下 —— 这条不依赖类存在性，必须报出来
        let mm: Vec<_> = issues
            .iter()
            .filter(|i| i.kind == IssueKind::ModuleMismatch)
            .collect();
        assert!(
            mm.iter()
                .any(|i| i.path.ends_with("icwl.upm") && i.module == "ic"),
            "icwl.upm 的声明名不一致漏报了：{mm:?}"
        );
    }

    /// 产品侧规模：NCHOME 的 `modules/<模块>/META-INF/*.upm`。
    ///
    /// 不断言精确值（装补丁会变），只保证「量级对」——扫描器如果只认了根 META-INF，
    /// 这个数字会掉到几十。
    #[test]
    #[ignore = "真机：依赖 D:\\NC65\\nc65home"]
    fn 产品侧upm规模() {
        let home = Path::new(HOME);
        if !home.is_dir() {
            eprintln!("跳过：本机没有 {HOME}");
            return;
        }
        let scan = scan_home(home);
        println!(
            "产品侧 upm {} 个，解析问题 {} 条",
            scan.files.len(),
            scan.notes.len()
        );
        assert!(
            scan.files.len() > 1000,
            "产品侧 upm 太少，扫描范围可能不对：{}",
            scan.files.len()
        );
        let idx = build(Scan::default(), scan);
        println!("产品侧装配条目 {} 条", idx.entries.len());
        assert!(
            idx.entries.len() > idx.files.len(),
            "平均每个 upm 至少一条装配"
        );
    }

    /// 产品侧全量诊断的底座：装配里指向的实现类，有多少在本机类索引里找不到。
    ///
    /// 这条盯的是**判定口径**而不是某个具体数字：如果未命中率高，说明「源码 ∪ 散类 ∪ jar」
    /// 这个范围漏了一大块（比如类索引只收了部分模块 jar），那 `missing-impl` 就会变成
    /// 成百上千条假警报，功能直接不可用。
    #[test]
    #[ignore = "真机：依赖 NCHOME 与已建立的类索引缓存"]
    fn 产品侧装配的实现类在jar里的命中率() {
        use crate::nc_index::{classpath_jars, ClassIndex};
        let home = Path::new(HOME);
        if !home.is_dir() {
            eprintln!("跳过：本机没有 {HOME}");
            return;
        }
        let Some(cache) = std::env::var("APPDATA").ok().map(|p| {
            PathBuf::from(p)
                .join("io.github.lzlkyb.ncforge")
                .join("class-index.bin")
        }) else {
            eprintln!("跳过：没有 APPDATA");
            return;
        };
        if !cache.exists() {
            eprintln!("跳过：还没有类索引缓存（先编译一次再跑）");
            return;
        }
        let idx = ClassIndex::load_or_build(classpath_jars(home), Some(&cache), None);
        println!(
            "类索引：{} 个 jar、{} 个类",
            idx.jars.len(),
            idx.class_count()
        );
        let upm = build(Scan::default(), scan_home(home));
        let mut miss: Vec<&UpmEntry> = Vec::new();
        for e in &upm.entries {
            if idx.jar_for_class(&e.implementation).is_none() {
                miss.push(e);
            }
        }
        let rate = miss.len() as f64 / upm.entries.len().max(1) as f64;
        println!(
            "装配 {} 条，实现类未命中 {} 条（{:.2}%）",
            upm.entries.len(),
            miss.len(),
            rate * 100.0
        );
        for e in miss.iter().take(10) {
            println!("  未命中: {}（模块 {}）", e.implementation, e.module);
        }
        assert!(
            rate < 0.05,
            "未命中率 {:.2}% 过高，类搜索范围有洞",
            rate * 100.0
        );
    }
}
