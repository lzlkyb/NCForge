//! 工程元数据投送：把工作区模块的 `META-INF/*.upm` 等文件同步到 NCHOME。
//!
//! 为什么必须有这一步：NC 不按 classpath 找 `.upm`，它按
//! `<NCHOME>/modules/<模块>/META-INF/` 的**文件路径**读组件注册表。
//! 改了工程里的 upm 而不落地，运行时读到的还是 NCHOME 里那份旧的
//! ⇒ 新增组件 `NCLocator.lookup` 找不到 / 单据行为不生效。
//! 实证见 `docs/NCForge-多工程关联与启动链路-方案设计-20261031.md` §1.2、§4。
//!
//! 这是往**同事共用的安装目录**写文件，规则比普通文件写入严：
//!
//! 1. 只动 `modules/<模块>/META-INF/<文件名>`，只写文件不移动/删除目录；
//! 2. 每次落地记 manifest（`<config_dir>/nchome-deploy/<home 指纹>/manifest.json`），
//!    清理时**只删自己写过、且内容仍是自己写的那份**的文件；
//! 3. 覆盖 NCHOME 原有文件前先备份，清理时还原；
//! 4. 目标模块在 NCHOME 里不存在时，只有源侧带 `module.xml`（说明这是一个模块）
//!    才新建目录——没有 module.xml 的目录 NC 本来也不会当模块扫，建了只会留垃圾；
//! 5. 失败只记日志，不阻断启动/编译（先让人能干活）。
//!
//! 纯逻辑模块，不含 tauri 类型（命令层见 `commands/deploy_cmds.rs`）。

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// manifest 结构版本。不认的版本当作没有（宁可重复落地一次，也不按错格式删文件）。
pub const MANIFEST_VERSION: u32 = 1;

/// 单个元数据文件上限。upm/rest 都是几 KB 级；卡一道上限防的是误把大 jar 扔进 META-INF。
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;

/// 日志里最多列几条冲突/跳过：全列会把启动日志刷满，详情在部署预览里。
const MAX_NOTES_IN_SUMMARY: usize = 8;

/// 一次部署动作（新增/更新/接管），给界面展示「动了哪些文件」。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployAction {
    pub module: String,
    pub file: String,
    /// 目标绝对路径
    pub target: String,
    /// 源绝对路径
    pub source: String,
    /// 覆盖前备份的相对路径（未备份 = null）
    pub backup: Option<String>,
}

/// 同一目标文件被多个工程声明且内容不同。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployConflict {
    /// 相对 NCHOME 的目标路径
    pub target: String,
    /// 生效的源（类路径顺序靠前）
    pub winner: String,
    /// 被压住的源
    pub loser: String,
}

/// 部署结果。`applied=false` 时是预览（不做任何写入）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployReport {
    pub home: String,
    /// 本次部署组合（工程根，按类路径顺序）
    pub project_roots: Vec<String>,
    /// 与上次落地的组合不同（正常操作，不是错误）
    pub combo_changed: bool,
    pub previous_combo: Vec<String>,
    pub planned: usize,
    pub created: Vec<DeployAction>,
    pub updated: Vec<DeployAction>,
    /// 内容已一致、只是登记为「本工具管理」的文件（未写入、清理时也不删）
    pub adopted: Vec<DeployAction>,
    pub unchanged: usize,
    pub conflicts: Vec<DeployConflict>,
    pub skipped: Vec<String>,
    pub applied: bool,
    pub backup_root: String,
    pub manifest_path: String,
}

/// 清理结果。只动 manifest 里登记为「写过」的文件。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupReport {
    pub home: String,
    pub manifest_path: String,
    pub deleted: Vec<String>,
    /// 从备份还原的文件
    pub restored: Vec<String>,
    pub skipped: Vec<String>,
}

/// 当前部署状态（界面卡片用）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployStatus {
    pub home: String,
    pub manifest_path: String,
    pub has_manifest: bool,
    pub combo: Vec<String>,
    pub files: usize,
    pub written: usize,
    pub backups: usize,
    pub updated_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    home: String,
    #[serde(default)]
    combo: Vec<String>,
    #[serde(default)]
    updated_ms: u64,
    #[serde(default)]
    files: Vec<ManifestFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestFile {
    /// 相对 NCHOME，`/` 分隔
    target: String,
    source: String,
    project: String,
    size: u64,
    /// 落地时**源文件**的 mtime（毫秒）；与 size 一起做增量跳过
    mtime_ms: u64,
    sha256: String,
    /// 内容是否由本工具写入（false = 只是接管了一个内容相同的原有文件）
    #[serde(default)]
    written: bool,
    /// 覆盖前的原文件备份（相对 backup 根）
    #[serde(default)]
    backup: Option<String>,
}

/// 计划里的一个文件。
#[derive(Debug, Clone)]
struct Planned {
    module: String,
    file: String,
    target_rel: String,
    source: PathBuf,
    project: PathBuf,
    size: u64,
    mtime_ms: u64,
}

struct Store {
    manifest: PathBuf,
    backup_root: PathBuf,
}

fn store_of(config_dir: &Path, home: &Path) -> Store {
    let base = config_dir.join("nchome-deploy").join(home_tag(home));
    Store {
        manifest: base.join("manifest.json"),
        backup_root: base.join("backup"),
    }
}

/// NCHOME 指纹：同一台机器可能有多个安装目录，manifest 必须分账。
fn home_tag(home: &Path) -> String {
    let mut h = Sha256::new();
    h.update(home.to_string_lossy().to_lowercase().as_bytes());
    let hex = format!("{:x}", h.finalize());
    hex[..12].to_string()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn mtime_ms(p: &Path) -> u64 {
    std::fs::metadata(p)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn sha256(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}

/// 名字能不能安全地拼进 NCHOME 路径：不含分隔符/盘符/控制字符，不是 `.`/`..`。
fn is_plain_name(name: &str) -> bool {
    let n = name.trim();
    if n.is_empty() || n == "." || n == ".." {
        return false;
    }
    if n.ends_with('.') || n.ends_with(' ') {
        return false;
    }
    !n.chars()
        .any(|c| c == '/' || c == '\\' || c == ':' || c.is_control())
}

/// 从 `module.xml` 读模块名。NC 以声明名为准，目录名不一定等于模块名
/// （本机 `EyePortal/META-INF/module.xml` 声明的是 `eye`）。
pub(crate) fn declared_module(meta: &Path) -> Option<String> {
    let bytes = std::fs::read(meta.join("module.xml")).ok()?;
    // module.xml 声明 gb2312，但标签与模块名都是 ASCII；lossy 解码足够
    let text = crate::workspace::decode_lossy(&bytes);
    let start = text.find("<module")?;
    let end = text[start..].find('>')? + start;
    let tag = &text[start..end];
    let name = attr_value(tag, "name")?;
    is_plain_name(name).then(|| name.to_string())
}

fn attr_value<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    for quote in ['"', '\''] {
        let needle = format!("{name}={quote}");
        if let Some(i) = tag.find(&needle) {
            let start = i + needle.len();
            if let Some(end) = tag[start..].find(quote) {
                return Some(tag[start..start + end].trim());
            }
        }
    }
    None
}

/// 参与部署的工程根：主工程 + 依赖闭包（按类路径顺序），已停用的不算。
///
/// 与类路径用同一个组合：否则会出现「类来自 B、upm 来自 A」的错配。
pub fn project_roots(
    primary: &Path,
    home: &Path,
    overrides: &[crate::eclipse_cp::LinkedOverride],
) -> Vec<PathBuf> {
    let graph = crate::eclipse_cp::graph(primary, home, overrides);
    let mut out: Vec<PathBuf> = Vec::new();
    for p in &graph.projects {
        if p.disabled {
            continue;
        }
        let Some(root) = &p.root else { continue };
        let path = PathBuf::from(root);
        if !path.is_dir() {
            continue;
        }
        if out.iter().any(|x| {
            x.to_string_lossy()
                .eq_ignore_ascii_case(&path.to_string_lossy())
        }) {
            continue;
        }
        out.push(path);
    }
    out
}

/// 便利入口：以工作区根为起点算组合后部署。
pub fn deploy_for_workspace(
    config_dir: &Path,
    primary: &Path,
    home: &Path,
    overrides: &[crate::eclipse_cp::LinkedOverride],
    apply: bool,
) -> Result<DeployReport, String> {
    let roots = project_roots(primary, home, overrides);
    deploy(config_dir, home, &roots, apply)
}

/// 生成计划：每个工程根的根 META-INF（模块名取 module.xml 声明）+
/// 一级子目录里的 `<模块>/META-INF`（模块名取声明名，没有则取目录名）。
fn build_plan(home: &Path, roots: &[PathBuf]) -> (Vec<Planned>, Vec<String>) {
    let mut out = Vec::new();
    let mut notes = Vec::new();
    for root in roots {
        if !root.is_dir() {
            notes.push(format!("工程目录不存在，已跳过：{}", root.display()));
            continue;
        }
        let root_meta = root.join("META-INF");
        if root_meta.is_dir() {
            match declared_module(&root_meta) {
                Some(module) => {
                    collect_meta(&root_meta, &module, root, true, home, &mut out, &mut notes)
                }
                None => notes.push(format!(
                    "{} 没有可解析的 META-INF/module.xml，无法确定目标模块，已跳过",
                    root_meta.display()
                )),
            }
        }

        let mut subs: Vec<PathBuf> = std::fs::read_dir(root)
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect();
        subs.sort();
        for sub in subs {
            let Some(dir_name) = sub.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if dir_name.starts_with('.') || dir_name.eq_ignore_ascii_case("META-INF") {
                continue;
            }
            let meta = sub.join("META-INF");
            if !meta.is_dir() {
                continue;
            }
            let declared = declared_module(&meta);
            let module = declared.clone().unwrap_or_else(|| dir_name.to_string());
            if !is_plain_name(&module) {
                notes.push(format!(
                    "模块名 {:?} 不是合法目录名（来自 {}），已跳过",
                    module,
                    meta.display()
                ));
                continue;
            }
            collect_meta(
                &meta,
                &module,
                root,
                declared.is_some(),
                home,
                &mut out,
                &mut notes,
            );
        }
    }
    (out, notes)
}

fn collect_meta(
    meta: &Path,
    module: &str,
    project: &Path,
    module_defined: bool,
    home: &Path,
    out: &mut Vec<Planned>,
    notes: &mut Vec<String>,
) {
    let module_dir = home.join("modules").join(module);
    if !module_dir.is_dir() && !module_defined {
        notes.push(format!(
            "NCHOME 里没有模块 {module}，源侧也没有 module.xml（无法证明这是一个模块），已跳过 {} 下的文件",
            meta.display()
        ));
        return;
    }
    let Ok(rd) = std::fs::read_dir(meta) else {
        notes.push(format!("读不到目录 {}，已跳过", meta.display()));
        return;
    };
    let mut files: Vec<PathBuf> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .collect();
    files.sort();
    for f in files {
        let Some(name) = f.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !is_plain_name(name) {
            notes.push(format!("文件名 {:?} 不是合法文件名，已跳过", name));
            continue;
        }
        let size = match std::fs::metadata(&f) {
            Ok(m) => m.len(),
            Err(e) => {
                notes.push(format!("读不到 {} 的信息（{e}），已跳过", f.display()));
                continue;
            }
        };
        if size > MAX_FILE_BYTES {
            notes.push(format!(
                "{} 超过 {} MB，不像元数据文件，已跳过",
                f.display(),
                MAX_FILE_BYTES / 1024 / 1024
            ));
            continue;
        }
        let mtime = mtime_ms(&f);
        out.push(Planned {
            module: module.to_string(),
            file: name.to_string(),
            target_rel: format!("modules/{module}/META-INF/{name}"),
            source: f,
            project: project.to_path_buf(),
            size,
            mtime_ms: mtime,
        });
    }
}

/// 同一目标被多个工程声明：**类路径顺序靠前者胜**（与同名 class 的规则一致）。
fn resolve_conflicts(
    plan: Vec<Planned>,
    notes: &mut Vec<String>,
) -> (Vec<Planned>, Vec<DeployConflict>) {
    let mut out: Vec<Planned> = Vec::with_capacity(plan.len());
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut conflicts: Vec<DeployConflict> = Vec::new();
    for p in plan {
        if let Some(&i) = index.get(&p.target_rel) {
            let prev = &out[i];
            let same = same_file(&prev.source, &p.source);
            if !same {
                conflicts.push(DeployConflict {
                    target: p.target_rel.clone(),
                    winner: prev.source.to_string_lossy().to_string(),
                    loser: p.source.to_string_lossy().to_string(),
                });
            }
            continue;
        }
        index.insert(p.target_rel.clone(), out.len());
        out.push(p);
    }
    if !conflicts.is_empty() {
        notes.push(format!(
            "{} 个同名元数据文件来自多个工程且内容不同，按类路径顺序取第一个",
            conflicts.len()
        ));
    }
    (out, conflicts)
}

/// 两个文件内容是否相同。读失败按「不同」处理（冲突要让人看见，不能静默合并）。
fn same_file(a: &Path, b: &Path) -> bool {
    if std::fs::metadata(a).map(|m| m.len()).ok() != std::fs::metadata(b).map(|m| m.len()).ok() {
        return false;
    }
    match (std::fs::read(a), std::fs::read(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

fn target_path(home: &Path, rel: &str) -> PathBuf {
    let mut p = home.to_path_buf();
    for part in rel.split('/') {
        p.push(part);
    }
    p
}

fn backup_path(root: &Path, rel: &str) -> PathBuf {
    let mut p = root.to_path_buf();
    for part in rel.split('/') {
        p.push(part);
    }
    p
}

/// manifest 里的相对路径必须仍是 `modules/<m>/META-INF/<f>` 四段，
/// 否则宁可忽略也不去删一个来路不明的文件。
fn target_from_rel(home: &Path, rel: &str) -> Option<PathBuf> {
    let parts: Vec<&str> = rel.split('/').collect();
    if parts.len() != 4 || parts[0] != "modules" || parts[2] != "META-INF" {
        return None;
    }
    if !parts.iter().all(|p| is_plain_name(p)) {
        return None;
    }
    Some(target_path(home, rel))
}

/// 目标是否确实落在 NCHOME 内（canonicalize 后比对，防符号链接逃逸）。
fn inside_nchome(target: &Path, home_canon: &Path) -> bool {
    let parent = match target.parent() {
        Some(p) => p,
        None => return false,
    };
    let canon = std::fs::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf());
    canon.starts_with(home_canon)
}

fn load_manifest(path: &Path) -> Option<Manifest> {
    let text = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str::<Manifest>(&text) {
        Ok(m) if m.version == MANIFEST_VERSION => Some(m),
        Ok(m) => {
            log::warn!(
                "部署记录版本 {} 不认识（当前 {}），按无记录处理：{path:?}",
                m.version,
                MANIFEST_VERSION
            );
            None
        }
        Err(e) => {
            log::warn!("部署记录损坏，按无记录处理（{path:?}: {e}）");
            None
        }
    }
}

fn save_manifest(path: &Path, m: &Manifest) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("建部署记录目录失败：{e}"))?;
    }
    let text = serde_json::to_string_pretty(m).map_err(|e| format!("序列化部署记录失败：{e}"))?;
    crate::atomic_file::write_atomic(path, text.as_bytes())
}

fn manifest_entry(p: &Planned, written: bool, backup: Option<String>, sha: String) -> ManifestFile {
    ManifestFile {
        target: p.target_rel.clone(),
        source: p.source.to_string_lossy().to_string(),
        project: p.project.to_string_lossy().to_string(),
        size: p.size,
        mtime_ms: p.mtime_ms,
        sha256: sha,
        written,
        backup,
    }
}

/// 部署（`apply=false` 时只出报告）。返回 Err 只用于「连 NCHOME 都不可用」这类全局失败；
/// 单个文件的失败进 `skipped`，不连坐。
pub fn deploy(
    config_dir: &Path,
    home: &Path,
    project_roots: &[PathBuf],
    apply: bool,
) -> Result<DeployReport, String> {
    if !home.is_dir() {
        return Err(format!("NCHOME 不存在：{}", home.display()));
    }
    let home_canon = std::fs::canonicalize(home)
        .map_err(|e| format!("NCHOME 不可用（{}）：{e}", home.display()))?;
    let store = store_of(config_dir, home);
    let old = load_manifest(&store.manifest);
    let previous_combo = old.as_ref().map(|m| m.combo.clone()).unwrap_or_default();
    let combo: Vec<String> = project_roots
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect();
    let combo_changed = match &old {
        Some(m) => m.combo != combo,
        None => !combo.is_empty(),
    };

    let (plan, mut skipped) = build_plan(home, project_roots);
    let (plan, conflicts) = resolve_conflicts(plan, &mut skipped);

    let mut entries: BTreeMap<String, ManifestFile> = old
        .map(|m| m.files.into_iter().map(|f| (f.target.clone(), f)).collect())
        .unwrap_or_default();

    let mut report = DeployReport {
        home: home.to_string_lossy().to_string(),
        project_roots: combo.clone(),
        combo_changed,
        previous_combo,
        planned: plan.len(),
        created: Vec::new(),
        updated: Vec::new(),
        adopted: Vec::new(),
        unchanged: 0,
        conflicts,
        skipped: Vec::new(),
        applied: apply,
        backup_root: store.backup_root.to_string_lossy().to_string(),
        manifest_path: store.manifest.to_string_lossy().to_string(),
    };

    let mut planned_targets: HashSet<String> = HashSet::new();
    for p in &plan {
        planned_targets.insert(p.target_rel.clone());
        let target = target_path(home, &p.target_rel);
        let existing = entries.get(&p.target_rel).cloned();
        // 目标被同名目录占着（或符号链接等非常规文件）：不碰，留给人工处理
        if target.exists() && !target.is_file() {
            skipped.push(format!("目标已被非文件占用，未覆盖：{}", target.display()));
            continue;
        }
        let existed = target.is_file();
        let action = DeployAction {
            module: p.module.clone(),
            file: p.file.clone(),
            target: target.to_string_lossy().to_string(),
            source: p.source.to_string_lossy().to_string(),
            backup: None,
        };

        // 快路径：源大小+源 mtime 与上次落地记录一致，且目标大小相同 → 跳过读内容。
        // 编译/启动前都会跑一次，不能每次都把全部 upm 读两遍。
        let fast_same = existed
            && existing
                .as_ref()
                .is_some_and(|e| e.size == p.size && e.mtime_ms == p.mtime_ms)
            && std::fs::metadata(&target).map(|m| m.len()).ok() == Some(p.size);
        if fast_same {
            if existing.as_ref().is_some_and(|e| e.written) {
                report.unchanged += 1;
                if apply {
                    if let Some(e) = entries.get_mut(&p.target_rel) {
                        e.source = p.source.to_string_lossy().to_string();
                        e.project = p.project.to_string_lossy().to_string();
                    }
                }
            } else {
                let sha = existing
                    .as_ref()
                    .map(|e| e.sha256.clone())
                    .unwrap_or_default();
                report.adopted.push(action);
                if apply {
                    entries.insert(p.target_rel.clone(), manifest_entry(p, false, None, sha));
                }
            }
            continue;
        }

        let src_bytes = match std::fs::read(&p.source) {
            Ok(b) => b,
            Err(e) => {
                skipped.push(format!(
                    "读不到源文件 {}（{e}），已跳过",
                    p.source.display()
                ));
                continue;
            }
        };

        enum Kind {
            Create,
            Update,
            Adopt,
            Unchanged,
        }

        let (kind, backup_needed) = if !existed {
            (Kind::Create, false)
        } else {
            match std::fs::read(&target) {
                Ok(tb) if tb == src_bytes => {
                    if existing.as_ref().is_some_and(|e| e.written) {
                        (Kind::Unchanged, false)
                    } else {
                        (Kind::Adopt, false)
                    }
                }
                Ok(_) => (
                    Kind::Update,
                    existing.as_ref().map(|e| !e.written).unwrap_or(true),
                ),
                Err(e) => {
                    // 读不到现有目标就不覆盖：可能是权限/占用，硬写会把别人的文件弄坏
                    skipped.push(format!(
                        "读不到 NCHOME 里的 {}（{e}），为安全起见未覆盖",
                        target.display()
                    ));
                    continue;
                }
            }
        };

        let sha = sha256(&src_bytes);
        match kind {
            Kind::Unchanged => {
                report.unchanged += 1;
                if apply {
                    if let Some(e) = entries.get_mut(&p.target_rel) {
                        e.source = p.source.to_string_lossy().to_string();
                        e.project = p.project.to_string_lossy().to_string();
                        e.size = p.size;
                        e.mtime_ms = p.mtime_ms;
                    }
                }
            }
            Kind::Adopt => {
                report.adopted.push(action);
                if apply {
                    entries.insert(p.target_rel.clone(), manifest_entry(p, false, None, sha));
                }
            }
            Kind::Create | Kind::Update => {
                let mut backup_rel = existing.as_ref().and_then(|e| e.backup.clone());
                if apply {
                    let Some(parent) = target.parent() else {
                        skipped.push(format!("目标路径没有上级目录：{}", target.display()));
                        continue;
                    };
                    if !parent.is_dir() {
                        if let Err(e) = std::fs::create_dir_all(parent) {
                            skipped.push(format!("建目录失败（{}）：{e}", parent.display()));
                            continue;
                        }
                    }
                    if !inside_nchome(&target, &home_canon) {
                        skipped.push(format!(
                            "目标不在 NCHOME 内（可能是符号链接逃逸），已拒绝：{}",
                            target.display()
                        ));
                        continue;
                    }
                    if backup_needed {
                        let rel = p.target_rel.clone();
                        if let Err(e) = backup_original(&target, &store.backup_root, &rel) {
                            skipped.push(format!(
                                "备份 NCHOME 原文件失败，未覆盖 {}：{e}",
                                target.display()
                            ));
                            continue;
                        }
                        backup_rel = Some(rel);
                    }
                    if let Err(e) = crate::atomic_file::write_atomic(&target, &src_bytes) {
                        skipped.push(format!("写入 {} 失败：{e}", target.display()));
                        continue;
                    }
                    entries.insert(
                        p.target_rel.clone(),
                        manifest_entry(p, true, backup_rel.clone(), sha),
                    );
                } else if backup_needed {
                    backup_rel = Some(p.target_rel.clone());
                }
                let mut action = action;
                action.backup = backup_rel;
                match kind {
                    Kind::Create => report.created.push(action),
                    _ => report.updated.push(action),
                }
            }
        }
    }

    if apply {
        // 旧组合留下的「写过」记录保留：清理按钮要能删掉它们。
        // 只是接管（written=false）且本次不再计划的文件没有清理价值，丢掉免得记录膨胀。
        entries.retain(|k, e| e.written || planned_targets.contains(k));
        let manifest = Manifest {
            version: MANIFEST_VERSION,
            home: home.to_string_lossy().to_string(),
            combo,
            updated_ms: now_ms(),
            files: entries.into_values().collect(),
        };
        save_manifest(&store.manifest, &manifest)?;
    }

    report.skipped = skipped;
    Ok(report)
}

/// 覆盖前把 NCHOME 原文件复制到备份根（保留相对路径，还原时能一一对应）。
fn backup_original(target: &Path, backup_root: &Path, rel: &str) -> Result<(), String> {
    let dest = backup_path(backup_root, rel);
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("建备份目录失败：{e}"))?;
    }
    std::fs::copy(target, &dest)
        .map(|_| ())
        .map_err(|e| format!("复制备份失败：{e}"))
}

/// 清理本工具写过的文件（manifest 驱动）。
pub fn cleanup(config_dir: &Path, home: &Path) -> Result<CleanupReport, String> {
    let store = store_of(config_dir, home);
    let mut report = CleanupReport {
        home: home.to_string_lossy().to_string(),
        manifest_path: store.manifest.to_string_lossy().to_string(),
        deleted: Vec::new(),
        restored: Vec::new(),
        skipped: Vec::new(),
    };
    let Some(manifest) = load_manifest(&store.manifest) else {
        report
            .skipped
            .push("没有本工具的部署记录（manifest），无需清理".to_string());
        return Ok(report);
    };
    let home_canon = std::fs::canonicalize(home)
        .map_err(|e| format!("NCHOME 不可用（{}）：{e}", home.display()))?;

    for f in &manifest.files {
        if !f.written {
            continue;
        }
        let Some(target) = target_from_rel(home, &f.target) else {
            report
                .skipped
                .push(format!("记录里的路径不合法，已忽略：{}", f.target));
            continue;
        };
        if !inside_nchome(&target, &home_canon) {
            report
                .skipped
                .push(format!("目标不在 NCHOME 内，已忽略：{}", f.target));
            continue;
        }
        if !target.is_file() {
            report.skipped.push(format!("已不存在：{}", f.target));
            continue;
        }
        let bytes = match std::fs::read(&target) {
            Ok(b) => b,
            Err(e) => {
                report
                    .skipped
                    .push(format!("读不到 {}（{e}），未删除", f.target));
                continue;
            }
        };
        // 内容已被外部改过：可能是同事手工调过，不删（宁留垃圾不丢别人的改动）
        if sha256(&bytes) != f.sha256 {
            report
                .skipped
                .push(format!("内容已被外部修改，未删除：{}", f.target));
            continue;
        }
        std::fs::remove_file(&target)
            .map_err(|e| format!("删除 {} 失败：{e}", target.display()))?;
        report.deleted.push(f.target.clone());
        if let Some(b) = &f.backup {
            let bp = backup_path(&store.backup_root, b);
            if bp.is_file() {
                std::fs::copy(&bp, &target)
                    .map_err(|e| format!("还原 {} 失败：{e}", target.display()))?;
                let _ = std::fs::remove_file(&bp);
                report.restored.push(f.target.clone());
            } else {
                report
                    .skipped
                    .push(format!("备份缺失，未能还原原文件：{}", f.target));
            }
        }
    }

    let _ = std::fs::remove_file(&store.manifest);
    Ok(report)
}

/// 读部署状态。没有记录不算错误（第一次用就是这个状态）。
pub fn status(config_dir: &Path, home: &Path) -> Result<DeployStatus, String> {
    let store = store_of(config_dir, home);
    let manifest = load_manifest(&store.manifest);
    let files = manifest.as_ref().map(|m| m.files.len()).unwrap_or(0);
    let written = manifest
        .as_ref()
        .map(|m| m.files.iter().filter(|f| f.written).count())
        .unwrap_or(0);
    Ok(DeployStatus {
        home: home.to_string_lossy().to_string(),
        manifest_path: store.manifest.to_string_lossy().to_string(),
        has_manifest: manifest.is_some(),
        combo: manifest
            .as_ref()
            .map(|m| m.combo.clone())
            .unwrap_or_default(),
        files,
        written,
        backups: count_files(&store.backup_root),
        updated_ms: manifest.map(|m| m.updated_ms).unwrap_or(0),
    })
}

fn count_files(dir: &Path) -> usize {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut n = 0;
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            n += count_files(&p);
        } else {
            n += 1;
        }
    }
    n
}

/// 把一次部署结果压成给人看的日志行（启动/编译日志里直接追加）。
pub fn summary_lines(r: &DeployReport) -> Vec<String> {
    let combo = if r.project_roots.is_empty() {
        "（无工程）".to_string()
    } else {
        r.project_roots
            .iter()
            .map(|p| {
                Path::new(p)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| p.clone())
            })
            .collect::<Vec<_>>()
            .join(" + ")
    };
    let verb = if r.applied {
        "投送完成"
    } else {
        "投送预览"
    };
    let mut out = vec![format!(
        "[nc-forge] 元数据{verb}（组合 {combo}）：新增 {}、更新 {}、接管 {}、未变 {}、冲突 {}、跳过 {}",
        r.created.len(),
        r.updated.len(),
        r.adopted.len(),
        r.unchanged,
        r.conflicts.len(),
        r.skipped.len()
    )];
    if r.combo_changed {
        out.push(format!(
            "[nc-forge] 部署组合已切换：{} → {combo}（旧组合落地的文件仍留在 NCHOME，可点「清理」移除）",
            if r.previous_combo.is_empty() {
                "（无）".to_string()
            } else {
                r.previous_combo.join(" + ")
            }
        ));
    }
    for c in r.conflicts.iter().take(MAX_NOTES_IN_SUMMARY) {
        out.push(format!(
            "[nc-forge] 元数据冲突 {}：{} 生效，{} 未落地",
            c.target, c.winner, c.loser
        ));
    }
    for s in r.skipped.iter().take(MAX_NOTES_IN_SUMMARY) {
        out.push(format!("[nc-forge] 元数据跳过：{s}"));
    }
    let rest = r.skipped.len().saturating_sub(MAX_NOTES_IN_SUMMARY);
    if rest > 0 {
        out.push(format!(
            "[nc-forge] 另有 {rest} 条跳过原因，见「NC 服务」页的部署预览"
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ncforge-deploy-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    /// 一个最小 NCHOME：modules/<m>/META-INF 已存在。
    fn home_with(tag: &str, modules: &[&str]) -> PathBuf {
        let home = temp_dir(tag).join("home");
        fs::create_dir_all(&home).unwrap();
        for m in modules {
            fs::create_dir_all(home.join("modules").join(m).join("META-INF")).unwrap();
        }
        home
    }

    fn cfg_of(home: &Path) -> PathBuf {
        home.parent().unwrap().join("cfg")
    }

    #[test]
    fn 模块名以_module_xml_声明为准() {
        let home = home_with("declared", &["eye"]);
        let ws = home.parent().unwrap().join("ws/EyePortal");
        write(
            &ws.join("META-INF/module.xml"),
            "<?xml version=\"1.0\" encoding='gb2312'?><module name=\"eye\"><public></public></module>",
        );
        write(&ws.join("META-INF/a.upm"), "<module name=\"eye\"></module>");

        let (plan, notes) = build_plan(&home, std::slice::from_ref(&ws));
        assert_eq!(plan.len(), 2, "module.xml 本身也是要落地的文件：{notes:?}");
        let a = plan
            .iter()
            .find(|p| p.file == "a.upm")
            .expect("a.upm 要在计划里");
        assert_eq!(a.module, "eye");
        assert_eq!(a.target_rel, "modules/eye/META-INF/a.upm");
    }

    #[test]
    fn 模块名非法时拒绝而不是拼进路径() {
        assert!(!is_plain_name("../evil"));
        assert!(!is_plain_name("a/b"));
        assert!(!is_plain_name("a\\b"));
        assert!(!is_plain_name("C:x"));
        assert!(!is_plain_name(".."));
        assert!(!is_plain_name(""));
        assert!(is_plain_name("uapbd"));
        assert!(is_plain_name("mmbcm-scm"));
    }

    #[test]
    fn 首次落地建文件并备份原有同名文件() {
        let home = home_with("first", &["uapbd"]);
        let ws = home.parent().unwrap().join("ws/newar");
        write(&ws.join("uapbd/META-INF/new.upm"), "NEW");
        write(&ws.join("uapbd/META-INF/old.upm"), "PROJECT");
        write(
            &home.join("modules/uapbd/META-INF/old.upm"),
            "PRODUCT-ORIGINAL",
        );
        let cfg = cfg_of(&home);

        let r = deploy(&cfg, &home, std::slice::from_ref(&ws), true).unwrap();
        assert_eq!(r.created.len(), 1, "{:?}", r.skipped);
        assert_eq!(r.updated.len(), 1);
        assert_eq!(
            fs::read_to_string(home.join("modules/uapbd/META-INF/new.upm")).unwrap(),
            "NEW"
        );
        assert_eq!(
            fs::read_to_string(home.join("modules/uapbd/META-INF/old.upm")).unwrap(),
            "PROJECT"
        );
        let backup = backup_path(Path::new(&r.backup_root), "modules/uapbd/META-INF/old.upm");
        assert_eq!(fs::read_to_string(backup).unwrap(), "PRODUCT-ORIGINAL");

        // 第二次：内容没变，全部走增量
        let r2 = deploy(&cfg, &home, &[ws], true).unwrap();
        assert_eq!(r2.created.len(), 0);
        assert_eq!(r2.updated.len(), 0);
        assert_eq!(r2.unchanged, 2);
    }

    #[test]
    fn 源文件改了会更新() {
        let home = home_with("update", &["ic"]);
        let ws = home.parent().unwrap().join("ws/newar");
        let src = ws.join("ic/META-INF/a.upm");
        write(&src, "V1");
        let cfg = cfg_of(&home);
        deploy(&cfg, &home, std::slice::from_ref(&ws), true).unwrap();

        // 改内容并拉开 mtime，避免快路径按 size+mtime 误判（不同大小天然能识别）
        write(&src, "V2-longer");
        let r = deploy(&cfg, &home, &[ws], true).unwrap();
        assert_eq!(r.updated.len(), 1);
        assert_eq!(
            fs::read_to_string(home.join("modules/ic/META-INF/a.upm")).unwrap(),
            "V2-longer"
        );
    }

    #[test]
    fn 内容相同的原有文件只接管不写入清理也不删() {
        let home = home_with("adopt", &["pu"]);
        let ws = home.parent().unwrap().join("ws/newar");
        write(&ws.join("pu/META-INF/c.upm"), "SAME");
        write(&home.join("modules/pu/META-INF/c.upm"), "SAME");
        let cfg = cfg_of(&home);

        let r = deploy(&cfg, &home, &[ws], true).unwrap();
        assert_eq!(r.adopted.len(), 1);
        assert_eq!(r.created.len(), 0);
        assert_eq!(r.updated.len(), 0);

        let st = status(&cfg, &home).unwrap();
        assert_eq!(st.written, 0, "接管不算写过");
        assert_eq!(st.files, 1);

        let c = cleanup(&cfg, &home).unwrap();
        assert!(c.deleted.is_empty(), "{:?}", c.deleted);
        assert!(
            home.join("modules/pu/META-INF/c.upm").is_file(),
            "接管的原有文件不能删"
        );
    }

    #[test]
    fn 清理删除自己写的并还原备份() {
        let home = home_with("cleanup", &["uapbd"]);
        let ws = home.parent().unwrap().join("ws/newar");
        write(&ws.join("uapbd/META-INF/new.upm"), "NEW");
        write(&ws.join("uapbd/META-INF/old.upm"), "PROJECT");
        write(&home.join("modules/uapbd/META-INF/old.upm"), "ORIGINAL");
        let cfg = cfg_of(&home);
        deploy(&cfg, &home, &[ws], true).unwrap();

        let c = cleanup(&cfg, &home).unwrap();
        assert_eq!(c.deleted.len(), 2, "{:?}", c.skipped);
        assert_eq!(c.restored.len(), 1);
        assert!(!home.join("modules/uapbd/META-INF/new.upm").exists());
        assert_eq!(
            fs::read_to_string(home.join("modules/uapbd/META-INF/old.upm")).unwrap(),
            "ORIGINAL",
            "清理要把 NCHOME 原有内容还回去"
        );
        assert!(!status(&cfg, &home).unwrap().has_manifest);
    }

    #[test]
    fn 清理放过被外部改过的文件() {
        let home = home_with("external", &["gl"]);
        let ws = home.parent().unwrap().join("ws/newar");
        write(&ws.join("gl/META-INF/a.upm"), "MINE");
        let cfg = cfg_of(&home);
        deploy(&cfg, &home, &[ws], true).unwrap();

        write(&home.join("modules/gl/META-INF/a.upm"), "COLLEAGUE");
        let c = cleanup(&cfg, &home).unwrap();
        assert!(c.deleted.is_empty());
        assert!(
            c.skipped.iter().any(|s| s.contains("外部修改")),
            "{:?}",
            c.skipped
        );
        assert_eq!(
            fs::read_to_string(home.join("modules/gl/META-INF/a.upm")).unwrap(),
            "COLLEAGUE"
        );
    }

    #[test]
    fn 没有_module_xml_且目标模块不存在时跳过() {
        let home = home_with("nomod", &[]);
        let ws = home.parent().unwrap().join("ws/newar");
        write(&ws.join("brandnew/META-INF/a.upm"), "X");
        let cfg = cfg_of(&home);

        let r = deploy(&cfg, &home, &[ws], true).unwrap();
        assert!(r.created.is_empty());
        assert!(
            r.skipped.iter().any(|s| s.contains("brandnew")),
            "{:?}",
            r.skipped
        );
        assert!(!home.join("modules/brandnew").exists());
    }

    #[test]
    fn 带_module_xml_的新模块会自动建目录() {
        let home = home_with("newmod", &[]);
        let ws = home.parent().unwrap().join("ws/newar");
        write(
            &ws.join("brandnew/META-INF/module.xml"),
            "<module name=\"brandnew\"/>",
        );
        write(&ws.join("brandnew/META-INF/a.upm"), "X");
        let cfg = cfg_of(&home);

        let r = deploy(&cfg, &home, &[ws], true).unwrap();
        assert_eq!(r.created.len(), 2, "{:?}", r.skipped);
        assert!(home.join("modules/brandnew/META-INF/a.upm").is_file());
    }

    #[test]
    fn 多工程同名文件冲突时先到者胜() {
        let home = home_with("conflict", &["uapbd"]);
        let base = home.parent().unwrap();
        let a = base.join("ws/a");
        let b = base.join("ws/b");
        write(&a.join("uapbd/META-INF/x.upm"), "FROM-A");
        write(&b.join("uapbd/META-INF/x.upm"), "FROM-B");
        let cfg = cfg_of(&home);

        let r = deploy(&cfg, &home, &[a, b], true).unwrap();
        assert_eq!(r.conflicts.len(), 1);
        assert!(r.conflicts[0].winner.contains("ws"));
        assert_eq!(
            fs::read_to_string(home.join("modules/uapbd/META-INF/x.upm")).unwrap(),
            "FROM-A"
        );
    }

    #[test]
    fn 目标读取失败的文件不覆盖() {
        let home = home_with("unreadable", &["uapbd"]);
        let ws = home.parent().unwrap().join("ws/newar");
        write(&ws.join("uapbd/META-INF/a.upm"), "NEW");
        // 目标做成目录：read 会失败，此时不能删/覆盖
        fs::create_dir_all(home.join("modules/uapbd/META-INF/a.upm")).unwrap();
        let cfg = cfg_of(&home);

        let r = deploy(&cfg, &home, &[ws], true).unwrap();
        assert!(r.created.is_empty() && r.updated.is_empty());
        assert!(
            r.skipped.iter().any(|s| s.contains("非文件")),
            "{:?}",
            r.skipped
        );
        assert!(
            home.join("modules/uapbd/META-INF/a.upm").is_dir(),
            "占位的目录不能被写坏"
        );
    }

    #[test]
    fn 预览不写任何文件() {
        let home = home_with("preview", &["uapbd"]);
        let ws = home.parent().unwrap().join("ws/newar");
        write(&ws.join("uapbd/META-INF/a.upm"), "NEW");
        let cfg = cfg_of(&home);

        let r = deploy(&cfg, &home, &[ws], false).unwrap();
        assert_eq!(r.created.len(), 1);
        assert!(!r.applied);
        assert!(!home.join("modules/uapbd/META-INF/a.upm").exists());
        assert!(!status(&cfg, &home).unwrap().has_manifest);
    }

    #[test]
    fn 部署组合切换会被报告() {
        let home = home_with("combo", &["pm", "uapbd"]);
        let base = home.parent().unwrap();
        let a = base.join("ws/a");
        let b = base.join("ws/b");
        write(&a.join("uapbd/META-INF/a.upm"), "A");
        write(&b.join("pm/META-INF/b.upm"), "B");
        let cfg = cfg_of(&home);

        let r1 = deploy(&cfg, &home, std::slice::from_ref(&a), true).unwrap();
        assert!(r1.combo_changed);
        let r2 = deploy(&cfg, &home, &[a, b], true).unwrap();
        assert!(r2.combo_changed, "组合从 A 变成 A+B 要报告");
        assert_eq!(r2.created.len(), 1);
        let lines = summary_lines(&r2);
        assert!(lines.iter().any(|l| l.contains("组合已切换")), "{lines:?}");
        // 旧组合写入的文件仍在（不自动删）
        assert!(home.join("modules/uapbd/META-INF/a.upm").is_file());
    }

    #[test]
    fn 目标路径只能是_modules_下的四段() {
        let home = Path::new("D:/ncc");
        assert!(target_from_rel(home, "modules/uapbd/META-INF/a.upm").is_some());
        assert!(target_from_rel(home, "config/a").is_none());
        assert!(target_from_rel(home, "modules/../a/META-INF/x").is_none());
        assert!(target_from_rel(home, "modules/uapbd/META-INF/x").is_some());
        assert!(target_from_rel(home, "modules/uapbd/META-INF/sub/x").is_none());
    }
}
