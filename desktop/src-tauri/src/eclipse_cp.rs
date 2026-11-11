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

/// 一条本地源码根（`kind="src"` 且 `path` 不是 `/工程名`）。
///
/// 保留「源根 → 输出目录」的对应关系：Eclipse 允许一条 src 单独写 `output=`，
/// 同一个工程因此可能有多个产物目录。编译与清理都必须按这个映射分组，
/// 否则会把 `src/test` 的产物和主代码混到一个目录里。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CpSrc {
    /// 相对工程根
    pub path: PathBuf,
    /// 该条声明的输出（相对工程根）；`None` = 用工程默认输出
    pub output: Option<PathBuf>,
}

/// 解析后的 `.classpath`。`outputs` 是**相对工程根**的路径，保序、已去重。
#[derive(Debug, Clone)]
pub struct ProjectCp {
    pub name: String,
    pub default_output: Option<PathBuf>,
    pub outputs: Vec<PathBuf>,
    pub refs: Vec<CpRef>,
    /// 本地源码根（按 `.classpath` 顺序，已排除 `/其它工程` 引用）
    pub srcs: Vec<CpSrc>,
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
        let mut srcs: Vec<CpSrc> = Vec::new();
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
                        let output = attr(tag, "output")
                            .filter(|o| !o.is_empty())
                            .map(PathBuf::from);
                        srcs.push(CpSrc {
                            path: PathBuf::from(path),
                            output: output.clone(),
                        });
                        src_outputs.push(output);
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
            srcs,
        }
    }
}

/// 覆盖表的一条：手工修正依赖闭包。
///
/// 为什么需要它：`.classpath` 是**别人**（Eclipse / 同事）写的，我们只读。真出问题时
/// 用户需要一个不改 `.classpath` 也能验证的旋钮——「把 B 停掉看还编不编得过」
/// 「B 明明该排前面」「有个手工编译的产物目录不在任何工程里」。这三件事分别对应
/// `Disable` / `Front` / `Add`。
///
/// 覆盖只影响**我们怎么算类路径**，不回写 `.classpath`：Eclipse 那边不受影响，
/// 所以「工作台里禁用了 B，Eclipse 里还看得见」是预期行为，不是 bug。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OverrideAction {
    /// 整个工程不参与（连同它往下传递的依赖一起剪掉）
    Disable,
    /// 排到主工程之后、其它依赖之前
    Front,
    /// 追加一个不在任何工程里的类目录 / jar（`dir` 必填）
    Add,
}

impl OverrideAction {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "disable" | "off" => Some(Self::Disable),
            "front" | "first" => Some(Self::Front),
            "add" | "extra" => Some(Self::Add),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Disable => "disable",
            Self::Front => "front",
            Self::Add => "add",
        }
    }
}

/// 一条生效中的覆盖。`target` 可以是工程名（`.classpath` 里的 `/X`）或工程根的绝对路径。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkedOverride {
    pub action: OverrideAction,
    pub target: String,
    /// 仅 `Add` 使用
    pub dir: Option<String>,
}

/// 一个参与编译/启动的工程，以及它贡献的类目录。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedProject {
    /// 工程名：主工程取目录名，依赖取 `.classpath` 里 `/X` 的写法（用户在 Eclipse 里
    /// 看到的就是它）。`.project` 自称的名字可能是另一个（`newar` 自称 `ar`），不采用——
    /// 界面要能和 Eclipse 对得上号
    pub name: String,
    /// 工程根；`None` = `.classpath` 里写了但磁盘上找不到
    pub root: Option<String>,
    /// `primary` / `classpath` / `legacy` / `front`
    pub origin: String,
    /// 0 = 主工程；`legacy` 兜底时无意义（固定 1）
    pub depth: usize,
    /// 由上一级引入时那条边是否 `exported="true"`
    pub exported: bool,
    /// 这个工程贡献的类目录（绝对路径，已按有效顺序）
    pub class_dirs: Vec<String>,
    /// 被覆盖表停用（此时 `class_dirs` 为空，保留条目是为了让用户看得见「它被剪掉了」）
    pub disabled: bool,
    /// 是否读到了 `.classpath`（false = 走老启发式）
    pub has_classpath: bool,
}

/// 依赖闭包的完整解析结果：既能给界面看，也是最终类路径的唯一来源。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedGraph {
    pub primary: String,
    pub primary_root: String,
    pub workspace: String,
    /// 按**有效顺序**排列（主工程 → 提前项 → 其余依赖）
    pub projects: Vec<LinkedProject>,
    /// 覆盖表追加的目录
    pub extra_dirs: Vec<String>,
    /// 工程侧类目录总数（不含 NC home）
    pub project_dir_count: usize,
    /// NC home 兜底的类目录数
    pub nc_home_dir_count: usize,
    /// 去重后的类目录总数（工程侧 + NC home），与真正塞进 classpath 的目录条目数一致
    pub total_dir_count: usize,
    /// 解析过程中的异常与覆盖动作，直接给界面展示
    pub notes: Vec<String>,
}

/// 主工程 + 依赖闭包 + NC home 的类目录，**空覆盖**版本（老调用点与测试用）。
///
/// 真正的实现只有 `flat_dirs` 一份：分组解析与顺序完全由它决定，
/// 这里只是把结果摊平，避免「两份各写一套顺序」。
pub fn class_roots(primary: &Path, nc_home: &Path) -> Vec<PathBuf> {
    class_roots_with(primary, nc_home, &[])
}

/// 同上，但让覆盖表参与。返回值与 `graph().projects` 展开后完全一致。
pub fn class_roots_with(
    primary: &Path,
    nc_home: &Path,
    overrides: &[LinkedOverride],
) -> Vec<PathBuf> {
    let mut dirs = flat_dirs(primary, overrides).0;
    dirs.extend(crate::nc_index::module_class_dirs(nc_home));
    dedupe(dirs)
}

/// 依赖闭包里的工程条目（不读 NC home）。
///
/// 文件树与「全部工程搜索」只关心工程根，不需要 NC home 的类目录统计；走 `graph()`
/// 会在没配 NC home 的机器上直接失败，一条工程都列不出来。
pub fn projects(primary: &Path, overrides: &[LinkedOverride]) -> Vec<LinkedProject> {
    flat_dirs(primary, overrides).1
}

/// **只**包含工程侧的输出目录（不含 NC home 的模块 classes）。
///
/// 客户端启动用这一份：Eclipse 的 `ClientClasspathEntry` 只保留 runtime classpath 里
/// `type == PROJECT` 的条目，NC home 的模块类由另外四个容器提供（`Module_Public_Library`
/// 等）。若这里再拼 `module_class_dirs`，`modules/*/classes` 会进两次，且顺序会偏离
/// Eclipse 的「工程 → 产品公共库 → 模块 public → 模块 client → langlib」。
pub fn project_outputs(primary: &Path, overrides: &[LinkedOverride]) -> Vec<PathBuf> {
    flat_dirs(primary, overrides).0
}

/// 依赖链的完整视图（界面用）。目录顺序与 `class_roots_with` 逐项相同。
pub fn graph(primary: &Path, nc_home: &Path, overrides: &[LinkedOverride]) -> LinkedGraph {
    let (project_dirs, projects, extra, notes) = flat_dirs(primary, overrides);
    let nc_dirs = crate::nc_index::module_class_dirs(nc_home);
    let total = dedupe({
        let mut all = project_dirs.clone();
        all.extend(nc_dirs.iter().cloned());
        all
    })
    .len();
    LinkedGraph {
        primary: primary
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        primary_root: primary.to_string_lossy().to_string(),
        workspace: primary
            .parent()
            .unwrap_or(primary)
            .to_string_lossy()
            .to_string(),
        projects,
        extra_dirs: extra
            .iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect(),
        project_dir_count: project_dirs.len(),
        nc_home_dir_count: nc_dirs.len(),
        total_dir_count: total,
        notes,
    }
}

/// 依赖闭包里的一个原始条目（覆盖表应用之前）。
struct RawEntry {
    name: String,
    root: Option<PathBuf>,
    depth: usize,
    exported: bool,
    origin: &'static str,
    dirs: Vec<PathBuf>,
    has_classpath: bool,
    /// 被覆盖表停用（在遍历时就剪枝，不再往下走）
    disabled: bool,
}

/// 解析一次依赖闭包。返回值：工程侧目录（未含 NC home）、工程列表、追加目录、说明。
fn flat_dirs(
    primary: &Path,
    overrides: &[LinkedOverride],
) -> (Vec<PathBuf>, Vec<LinkedProject>, Vec<PathBuf>, Vec<String>) {
    let plan = OverridePlan::new(overrides);
    let mut notes = plan.notes.clone();
    let raw = collect(primary, &plan, &mut notes);
    let workspace = primary.parent().unwrap_or(primary).to_path_buf();

    // ── 1. 按覆盖表切三堆：主工程 / 提前项 / 其余 ──
    let mut primary_entry: Option<RawEntry> = None;
    let mut front: Vec<RawEntry> = Vec::new();
    let mut rest: Vec<RawEntry> = Vec::new();
    for mut e in raw {
        if e.origin == "primary" {
            // 主工程永远第一：配置里把它写成停用/排前都忽略，并说明原因
            if plan.hits(&e.name, e.root.as_deref()) {
                notes.push("覆盖表指向了主工程：主工程永远排第一、也不可停用，该条已忽略".into());
            }
            primary_entry = Some(e);
        } else if plan.is_front(&e.name, e.root.as_deref()) {
            // origin 记成 front：界面要能解释「它本在依赖链第 3 位，为什么排到了第 2 位」
            e.origin = "front";
            front.push(e);
        } else {
            rest.push(e);
        }
    }

    // 配置里写了「排前」但不在依赖闭包里的工程：单独解析一次，让排前也能用于链外工程
    for target in &plan.front {
        if front.iter().any(|e| plan.name_eq(e, target)) {
            continue;
        }
        // 主工程永远第一：配置里写「排前 A」不能再插一条 A（会变成两个 A 的目录）
        if primary_entry
            .as_ref()
            .is_some_and(|p| plan.name_eq(p, target))
        {
            continue;
        }
        let Some(root) = resolve_ref(target, &workspace) else {
            notes.push(format!(
                "覆盖表里的「排前」目标 {target} 找不到对应工程，已忽略"
            ));
            continue;
        };
        let mut dirs: Vec<PathBuf> = Vec::new();
        let has_cp = match ProjectCp::load(&root) {
            Some(cp) => {
                push_outputs(&cp, &root, &mut dirs);
                true
            }
            None => {
                legacy_own_dirs(&root, &mut dirs);
                false
            }
        };
        front.push(RawEntry {
            name: target.clone(),
            root: Some(root),
            depth: 1,
            exported: false,
            origin: "front",
            dirs,
            has_classpath: has_cp,
            disabled: false,
        });
    }
    // 配置顺序即优先级
    front.sort_by_key(|e| {
        plan.front
            .iter()
            .position(|t| plan.name_eq(e, t))
            .unwrap_or(usize::MAX)
    });

    // ── 2. 有效顺序：主工程 → 提前项 → 其余（.classpath 顺序） ──
    let mut ordered: Vec<RawEntry> = Vec::new();
    if let Some(p) = primary_entry {
        ordered.push(p);
    }
    ordered.extend(front);
    ordered.extend(rest);

    // ── 3. 拼目录。被停用的条目留壳，界面要能看见「剪掉了谁、省了多少目录」 ──
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut projects: Vec<LinkedProject> = Vec::with_capacity(ordered.len());
    for e in ordered {
        let disabled = e.disabled;
        if !disabled {
            dirs.extend(e.dirs.iter().cloned());
        }
        projects.push(LinkedProject {
            name: e.name,
            root: e.root.map(|p| p.to_string_lossy().to_string()),
            origin: e.origin.to_string(),
            depth: e.depth,
            exported: e.exported,
            class_dirs: if disabled {
                Vec::new()
            } else {
                e.dirs
                    .iter()
                    .map(|p| p.to_string_lossy().to_string())
                    .collect()
            },
            disabled,
            has_classpath: e.has_classpath,
        });
    }

    // ── 4. 追加目录 ──
    let mut extra: Vec<PathBuf> = Vec::new();
    for d in &plan.add {
        let p = PathBuf::from(d);
        if p.is_dir() || p.is_file() {
            extra.push(p);
        } else {
            notes.push(format!("覆盖表里追加的目录 {d} 不存在，已跳过"));
        }
    }
    dirs.extend(extra.iter().cloned());

    (dirs, projects, extra, notes)
}

/// 走一遍 `.classpath` 的依赖图，拿到「工程 → 目录」的原始顺序。
///
/// 环（A→B→A）与菱形（A→B、A→C、B→C）都靠 `seen` 收敛；`exported` 只决定
/// 「要不要继续往下走」，直接依赖本身总是收进来。
fn collect(primary: &Path, plan: &OverridePlan, notes: &mut Vec<String>) -> Vec<RawEntry> {
    let workspace = primary.parent().unwrap_or(primary).to_path_buf();
    let mut out: Vec<RawEntry> = Vec::new();

    match ProjectCp::load(primary) {
        Some(cp) => {
            let mut own: Vec<PathBuf> = Vec::new();
            push_outputs(&cp, primary, &mut own);
            out.push(RawEntry {
                name: cp.name.clone(),
                root: Some(primary.to_path_buf()),
                depth: 0,
                exported: false,
                origin: "primary",
                dirs: own,
                has_classpath: true,
                disabled: false,
            });
            let mut seen: HashSet<PathBuf> = HashSet::new();
            seen.insert(dir_key(primary));
            walk(&cp, &workspace, &mut out, &mut seen, plan, 1, notes);
        }
        None => {
            // 老工程：没有依赖声明可按。**不假装**能表达依赖关系，界面会提示补 .classpath。
            let mut own: Vec<PathBuf> = Vec::new();
            legacy_roots(primary, &mut own);
            let name = project_name(primary).unwrap_or_else(|| {
                primary
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default()
            });
            notes.push(
                "主工程没有 .classpath：依赖只能按目录启发式猜（模块 classes → out/* → bin → \
                 兄弟工程），同名类谁生效不可控，建议在 Eclipse 里补上工程引用"
                    .into(),
            );
            out.push(RawEntry {
                name,
                root: Some(primary.to_path_buf()),
                depth: 0,
                exported: false,
                origin: "legacy",
                dirs: own,
                has_classpath: false,
                disabled: false,
            });
        }
    }
    out
}

fn walk(
    cp: &ProjectCp,
    workspace: &Path,
    out: &mut Vec<RawEntry>,
    seen: &mut HashSet<PathBuf>,
    plan: &OverridePlan,
    depth: usize,
    notes: &mut Vec<String>,
) {
    for r in &cp.refs {
        let Some(root) = resolve_ref(&r.name, workspace) else {
            // 不静默丢：编译期少一个工程的表现是「类找不到」，而原因在 .classpath 指向了
            // 一个不存在的目录——这条说明直接给到界面，比让用户猜快得多。
            notes.push(format!(
                "依赖 {} 在 {} 下找不到对应工程，已跳过（编译若报类找不到，先查这条）",
                r.name,
                workspace.display()
            ));
            out.push(RawEntry {
                name: r.name.clone(),
                root: None,
                depth,
                exported: r.exported,
                origin: "classpath",
                dirs: Vec::new(),
                has_classpath: false,
                disabled: false,
            });
            continue;
        };
        if !seen.insert(dir_key(&root)) {
            continue;
        }
        // 停用必须**在这里**生效：它要连「往下的依赖」一起剪掉。等到遍历完再过滤，
        // B 的子孙已经被别的分支 emit 出来了，只清 B 自己的目录等于没停用。
        if plan.is_disabled(&r.name, Some(&root)) {
            notes.push(format!(
                "{} 被覆盖表停用：它和它往下传递的依赖都不参与类路径",
                r.name
            ));
            let has_cp = ProjectCp::load(&root).is_some();
            out.push(RawEntry {
                name: r.name.clone(),
                root: Some(root),
                depth,
                exported: r.exported,
                origin: "classpath",
                dirs: Vec::new(),
                has_classpath: has_cp,
                disabled: true,
            });
            continue;
        }
        let mut dirs: Vec<PathBuf> = Vec::new();
        match ProjectCp::load(&root) {
            Some(child) => {
                // 直接依赖总进类路径，`exported` 只决定「要不要继续往下走」
                push_outputs(&child, &root, &mut dirs);
                out.push(RawEntry {
                    // 用 `.classpath` 里的写法（`/newar`）而不是 `.project` 自称的名字（`ar`）：
                    // 用户是在 Eclipse 里看到 `newar` 的，界面对齐那个名字才找得到人
                    name: r.name.clone(),
                    root: Some(root.clone()),
                    depth,
                    exported: r.exported,
                    origin: "classpath",
                    dirs,
                    has_classpath: true,
                    disabled: false,
                });
                if r.exported {
                    walk(&child, workspace, out, seen, plan, depth + 1, notes);
                }
            }
            None => {
                // 被引用但不是 Eclipse 工程：按老规则扫它自己的产物
                legacy_own_dirs(&root, &mut dirs);
                out.push(RawEntry {
                    name: r.name.clone(),
                    root: Some(root),
                    depth,
                    exported: r.exported,
                    origin: "classpath",
                    dirs,
                    has_classpath: false,
                    disabled: false,
                });
            }
        }
    }
}

/// 归一化后的覆盖表：匹配规则与顺序都在这里，避免各处各写一遍。
struct OverridePlan {
    disabled: Vec<String>,
    front: Vec<String>,
    add: Vec<String>,
    notes: Vec<String>,
}

impl OverridePlan {
    fn new(overrides: &[LinkedOverride]) -> Self {
        let mut p = Self {
            disabled: Vec::new(),
            front: Vec::new(),
            add: Vec::new(),
            notes: Vec::new(),
        };
        for o in overrides {
            let target = o.target.trim();
            match o.action {
                OverrideAction::Disable => {
                    if target.is_empty() {
                        p.notes
                            .push("覆盖表里有一条「停用」没写目标，已忽略".into());
                    } else {
                        p.disabled.push(target.to_string());
                    }
                }
                OverrideAction::Front => {
                    if target.is_empty() {
                        p.notes
                            .push("覆盖表里有一条「排前」没写目标，已忽略".into());
                    } else {
                        p.front.push(target.to_string());
                    }
                }
                OverrideAction::Add => match o.dir.as_deref().map(str::trim) {
                    Some(d) if !d.is_empty() => p.add.push(d.to_string()),
                    _ => p
                        .notes
                        .push("覆盖表里有一条「追加目录」没写路径，已忽略".into()),
                },
            }
        }
        p
    }

    /// 三路匹配：工程名、根目录名、绝对路径。界面上显示的可能是其中任一个。
    fn name_eq(&self, e: &RawEntry, target: &str) -> bool {
        if e.name.eq_ignore_ascii_case(target) {
            return true;
        }
        let Some(root) = &e.root else {
            return false;
        };
        if root.to_string_lossy().eq_ignore_ascii_case(target) {
            return true;
        }
        root.file_name()
            .is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(target))
    }

    fn hits(&self, name: &str, root: Option<&Path>) -> bool {
        self.is_disabled(name, root) || self.is_front(name, root)
    }

    fn is_disabled(&self, name: &str, root: Option<&Path>) -> bool {
        self.disabled.iter().any(|t| matches_target(name, root, t))
    }

    fn is_front(&self, name: &str, root: Option<&Path>) -> bool {
        self.front.iter().any(|t| matches_target(name, root, t))
    }
}

/// 覆盖表匹配：工程名（`.classpath` 里的写法）、根目录名、绝对路径三者任一相等即命中。
/// 大小写不敏感——Windows 路径与工程名都不区分大小写。
fn matches_target(name: &str, root: Option<&Path>, target: &str) -> bool {
    if name.eq_ignore_ascii_case(target) {
        return true;
    }
    let Some(root) = root else {
        return false;
    };
    root.to_string_lossy().eq_ignore_ascii_case(target)
        || root
            .file_name()
            .is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(target))
}

/// 把配置里的覆盖表转成解析器认识的形态。
///
/// 识别不了的 `action` 直接丢弃（老配置/手改文件里可能写成别的词）：
/// 一条坏配置不该让整个类路径算不出来——那是「配置写错 → 编不过」的死循环。
/// 丢弃不静默：返回值第二项是给人看的说明。
pub fn overrides_from(
    cfg: &[crate::config::LinkedOverrideConfig],
) -> (Vec<LinkedOverride>, Vec<String>) {
    let mut out: Vec<LinkedOverride> = Vec::new();
    let mut notes: Vec<String> = Vec::new();
    for c in cfg {
        let Some(action) = OverrideAction::parse(&c.action) else {
            notes.push(format!(
                "覆盖表里有一条的动作 {:?} 不认识（只认 disable / front / add），已跳过",
                c.action
            ));
            continue;
        };
        out.push(LinkedOverride {
            action,
            target: c.target.trim().to_string(),
            dir: c.dir.as_deref().map(str::trim).map(str::to_string),
        });
    }
    (out, notes)
}

/// 配置 → 生效覆盖表。识别不了的条目记 warn 后丢弃（界面另有 `notes` 展示，
/// 这条日志是给「用户没打开工程关联页也要能查」用的）。
pub fn active_overrides(cfg: &[crate::config::LinkedOverrideConfig]) -> Vec<LinkedOverride> {
    let (v, notes) = overrides_from(cfg);
    for n in notes {
        log::warn!("工程关联覆盖表：{n}");
    }
    v
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

/// 工程的产物目录，按 `.classpath` 顺序。
///
/// 一个模块（工程根下的一级目录）自己没有 `.classpath` 时，工作台把它编到 `<模块>/classes`
/// （`ModuleLayout` 的旧约定），而 Eclipse 的根 `.classpath` 可能让它的 src 写到别处
/// （`output="out/riart"`，或没写 output 就用默认的 `out/bin`）。两边不一致的后果：
/// 运行用的类路径里只有 Eclipse 的旧目录，工作台编出的 `<模块>/classes` 根本不在上面，
/// 改了代码重启也不生效、热替换还报「被遮挡」。所以这类模块要把 `<模块>/classes`
/// **排在它对应的 Eclipse 产物目录之前**——工作台编出来的类优先，没编过的类仍回落到旧产物。
fn push_outputs(cp: &ProjectCp, root: &Path, out: &mut Vec<PathBuf>) {
    for rel in &cp.outputs {
        let p = root.join(rel);
        for module in workbench_modules_writing_to(cp, root, rel) {
            let own = root.join(&module).join("classes");
            if own.is_dir() && !crate::build_layout::eq_path(&own, &p) {
                out.push(own);
            }
        }
        if p.is_dir() {
            out.push(p);
        }
    }
}

/// 在 Eclipse 里把产物写到 `output` 的那些「没有自己 `.classpath` 的模块」（按声明顺序、去重）。
fn workbench_modules_writing_to(cp: &ProjectCp, root: &Path, output: &Path) -> Vec<String> {
    let mut modules: Vec<String> = Vec::new();
    for src in &cp.srcs {
        let effective = src.output.as_ref().or(cp.default_output.as_ref());
        if effective != Some(&output.to_path_buf()) {
            continue;
        }
        let mut parts = src.path.components();
        let (Some(first), Some(_)) = (parts.next(), parts.next()) else {
            continue; // 源根就是工程根下一级：没有「模块」这一层
        };
        let module = first.as_os_str().to_string_lossy().to_string();
        if module.is_empty() || module == ".." || module == "." {
            continue;
        }
        if root.join(&module).join(".classpath").is_file() || modules.contains(&module) {
            continue;
        }
        modules.push(module);
    }
    modules
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
        // 两个十六进制位都按**字节**取：`&s[i+1..i+3]` 这种切法在 `%` 后面跟
        // 多字节字符时会切在 char boundary 上直接 panic（中文路径未编码就会
        // 踩到），而字节比较没有这个问题。
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(hi), Some(lo)) = (hex_val(b[i + 1]), hex_val(b[i + 2])) {
                out.push(hi * 16 + lo);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn hex_val(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// Read-only browser rows. Eclipse containers and variables need an Eclipse resolver.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyEntry {
    pub kind: &'static str,
    pub name: String,
    pub declared: String,
    pub path: Option<String>,
    pub status: &'static str,
    pub source: Option<String>,
    pub source_path: Option<String>,
}

pub fn dependency_entries(
    root: &Path,
    projects: &[LinkedProject],
) -> Result<Option<Vec<DependencyEntry>>, String> {
    let xml = match std::fs::read_to_string(root.join(".classpath")) {
        Ok(xml) => xml,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("读取 .classpath 失败：{e}")),
    };
    let project = |name: &str| projects.iter().find(|p| p.name.eq_ignore_ascii_case(name));
    let resolve = |declared: &str| {
        if let Some(workspace_path) = declared.strip_prefix('/') {
            let (name, rest) = workspace_path
                .split_once('/')
                .unwrap_or((workspace_path, ""));
            project(name)?
                .root
                .as_ref()
                .map(|p| PathBuf::from(p).join(rest))
        } else {
            Some(root.join(declared))
        }
    };
    let mut entries = Vec::new();
    for tag in classpathentry_tags(&xml) {
        let Some(declared) = attr(tag, "path").filter(|s| !s.is_empty()) else {
            continue;
        };
        let kind = match attr(tag, "kind") {
            Some("src") if declared.starts_with('/') => "project",
            Some("lib") => "library",
            Some("con") => "container",
            Some("var") => "variable",
            _ => continue,
        };
        let mut path = None;
        let status = match kind {
            "project" => match project(&declared[1..]) {
                Some(p) if p.disabled => "disabled",
                Some(p) if p.root.as_ref().is_some_and(|p| Path::new(p).is_dir()) => {
                    path = p.root.clone();
                    "available"
                }
                _ => "missing",
            },
            "library" => match resolve(declared) {
                Some(candidate) => {
                    let exists = candidate.is_file() || candidate.is_dir();
                    path = Some(crate::security::path::display_path(&candidate));
                    if exists {
                        "available"
                    } else {
                        "missing"
                    }
                }
                None => "unresolved",
            },
            _ => "unresolved",
        };
        let source = attr(tag, "sourcepath").filter(|s| !s.is_empty());
        let source_path = source
            .filter(|_| kind == "library")
            .and_then(resolve)
            .and_then(|p| p.canonicalize().ok())
            .map(|p| crate::security::path::display_path(&p));
        let name = if declared.contains("JRE_CONTAINER") && kind == "container" {
            "JRE System Library".to_string()
        } else {
            declared
                .rsplit(['/', '\\'])
                .next()
                .unwrap_or(declared)
                .to_string()
        };
        entries.push(DependencyEntry {
            kind,
            name,
            declared: declared.to_string(),
            path,
            status,
            source: source.map(str::to_string),
            source_path,
        });
    }
    Ok(Some(entries))
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

/// 按「依赖在前」的顺序列出工作区内的模块名（「编译全部模块」用）。
///
/// 顺序来源是**类路径本身的顺序**，而不是 `graph().projects`：
/// 类路径是「主工程 → 直接依赖 → 传递依赖」，反过来就是「最底层 → 主工程」，
/// 正好是编译需要的顺序（先把被依赖的产物编出来）。停用工程已经被覆盖表剪掉，
/// 这里的输入里就没有它们。
///
/// 只收工作区**内部**的模块（`<root>/<module>/...`）：`CompileEnv` 只有一个
/// `project_root`，工作区外的目录用这套参数编不出来。工作区内但类路径里没出现过的
/// 模块（老工程 `bin/` 之类）由调用方兜底补上。
///
/// 名字保留原始大小写：调用方要拿它去拼 `<root>/<module>`，小写会在日志里把
/// `EyePortal` 显示成 `eyeportal`（Windows 上照样能找到目录，但看着像另一个人）。
pub fn compile_order(class_dirs: &[PathBuf], root: &Path) -> Vec<String> {
    /// 路径按 `\` 切段（`/` 先归一），去掉空段（尾部分隔符、`\\?\` 前缀都会产生）。
    fn parts_of(p: &Path) -> Vec<String> {
        p.to_string_lossy()
            .replace('/', "\\")
            .split('\\')
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect()
    }
    let root_parts = parts_of(root);
    let mut out: Vec<String> = Vec::new();
    for d in class_dirs {
        let parts = parts_of(d);
        // 至少 `<root>/<模块>/<产物目录>`：直接挂在根下的那一层不是模块
        // （追加目录、根工程自己的 `classes` 都会落到这里）
        if parts.len() < root_parts.len() + 2 {
            continue;
        }
        if !parts[..root_parts.len()]
            .iter()
            .zip(&root_parts)
            .all(|(a, b)| a.eq_ignore_ascii_case(b))
        {
            continue;
        }
        let module = &parts[root_parts.len()];
        if out.iter().any(|m| m.eq_ignore_ascii_case(module)) {
            continue;
        }
        out.push(module.clone());
    }
    out.reverse();
    out
}

/// 工作区根下看起来是模块的目录（兜底：类路径里一条都没匹配上时用它）。
///
/// 判据只有两条：有 `.classpath`，或有 `src` 目录。两者都没有的（日志、备份、补丁包）
/// 不是可编译模块，编它只会报「没有源文件」。
pub fn module_dirs_of(root: &Path) -> Vec<String> {
    let Ok(rd) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut out: Vec<String> = rd
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter(|e| {
            let p = e.path();
            p.join(".classpath").is_file() || p.join("src").is_dir()
        })
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .collect();
    out.sort();
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn dependency_browser_distinguishes_missing_libraries_and_eclipse_containers() {
        let project = tempfile::tempdir().unwrap();
        let root = project.path();
        assert!(super::dependency_entries(root, &[]).unwrap().is_none());
        std::fs::write(root.join("present.jar"), "").unwrap();
        std::fs::write(root.join("sources.zip"), "").unwrap();
        std::fs::write(
            root.join(".classpath"),
            r#"<classpath>
          <classpathentry kind="src" path="src"/>
          <classpathentry kind="src" path="/MissingProject"/>
          <classpathentry kind="lib" path="present.jar" sourcepath="sources.zip"/>
          <classpathentry kind="lib" path="missing.jar" sourcepath="missing-sources.zip"/>
          <classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER/JavaSE-1.8"/>
        </classpath>"#,
        )
        .unwrap();
        let rows = super::dependency_entries(root, &[]).unwrap().unwrap();
        assert_eq!(rows.len(), 4);
        assert_eq!((rows[0].kind, rows[0].status), ("project", "missing"));
        assert_eq!((rows[1].kind, rows[1].status), ("library", "available"));
        assert!(rows[1]
            .source_path
            .as_deref()
            .unwrap()
            .ends_with("sources.zip"));
        assert_eq!(rows[2].status, "missing");
        assert!(rows[2].source_path.is_none());
        assert_eq!(rows[3].name, "JRE System Library");
        assert_eq!(rows[3].status, "unresolved");
    }

    use super::*;
    use std::fs;

    /// 外面套一层隔离壳：`legacy_roots` 会把「工程根的兄弟目录」当工作区分组扫
    /// （`<兄弟>/<模块>/classes`），临时工程直接建在 `%TEMP%` 下会被并行用例污染。
    fn temp_dir(tag: &str) -> PathBuf {
        let mut shell = std::env::temp_dir();
        shell.push(format!("ncforge-cp-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&shell);
        let d = shell.join("root");
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn cleanup(d: &Path) {
        let _ = fs::remove_dir_all(d);
        if d.file_name().is_some_and(|n| n == "root") {
            if let Some(shell) = d.parent() {
                let _ = fs::remove_dir_all(shell);
            }
        }
    }

    fn touch_class(dir: &Path) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join("A.class"), b"x").unwrap();
    }

    /// `%` 后面跟着多字节字符时，按 `&s[i+1..i+3]` 切 `&str` 会切在 char
    /// boundary 上直接 panic——`.location` 里出现未编码的中文路径（UNC 共享、
    /// 中文用户名）就会让整个类路径解析崩掉，工程直接打不开。
    #[test]
    fn percent_decode_不能按字符边界切分() {
        assert_eq!(percent_decode("%E4%B8%AD%E6%96%87"), "中文");
        assert_eq!(percent_decode("a%20b"), "a b");
        // 这两个以前会 panic：% 后第一个字节是多字节字符的开头，i+3 落在字符中间
        assert_eq!(percent_decode("%中文"), "%中文");
        assert_eq!(percent_decode("x%aé"), "x%aé");
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

    /// 造一个工作区：每个工程给出「一个输出目录」与「依赖引用列表」。
    ///
    /// 输出目录会真的建出来并放一个 `A.class`——`push_outputs` 只收存在的目录，
    /// 只写 `.classpath` 不建目录的话所有断言都会是空。
    /// 一个工程的造数规格：工程名 / 输出目录 / 依赖引用（名字, 是否 exported）
    type WsSpec<'a> = (&'a str, &'a str, &'a [(&'a str, bool)]);

    fn build_ws(tag: &str, specs: &[WsSpec]) -> PathBuf {
        let ws = temp_dir(tag);
        for (name, out, refs) in specs {
            let root = ws.join(name);
            touch_class(&root.join(out));
            let mut xml = String::from("<classpath>\n");
            for (r, exported) in refs.iter() {
                xml.push_str(&format!(
                    "\t<classpathentry kind=\"src\" path=\"/{r}\" exported=\"{exported}\"/>\n"
                ));
            }
            xml.push_str(&format!(
                "\t<classpathentry kind=\"src\" output=\"{out}\" path=\"m/src/public\"/>\n"
            ));
            xml.push_str(&format!(
                "\t<classpathentry kind=\"output\" path=\"{out}\"/>\n</classpath>"
            ));
            write(&root.join(".classpath"), &xml);
        }
        ws
    }

    fn names(g: &LinkedGraph) -> Vec<&str> {
        g.projects.iter().map(|p| p.name.as_str()).collect()
    }

    /// 根 `.classpath` 把模块的 src 写到 `out/<模块>` 或默认 `out/bin` 时，工作台的
    /// `<模块>/classes` 要排在它们前面（否则工作台编出的类运行时根本不在类路径上）。
    #[test]
    fn 工作台产物目录排在_eclipse_旧产物前面() {
        let ws = temp_dir("own-before-eclipse");
        let root = ws.join("newar");
        for d in [
            "out/riart",
            "out/bin",
            "gl/classes",
            "riart/classes",
            "pubapp/classes",
            "own/classes",
        ] {
            touch_class(&root.join(d));
        }
        // own 模块自己有 .classpath：它的产物由它自己说了算，不额外加 own/classes
        write(&root.join("own").join(".classpath"), "<classpath/>");
        write(
            &root.join(".classpath"),
            r#"<classpath>
  <classpathentry kind="src" output="gl/classes" path="gl/src/public"/>
  <classpathentry kind="src" output="out/riart" path="riart/src/public"/>
  <classpathentry kind="src" output="out/riart" path="riart/src/client"/>
  <classpathentry kind="src" path="pubapp/src/public"/>
  <classpathentry kind="src" output="out/bin" path="own/src/public"/>
  <classpathentry kind="output" path="out/bin"/>
</classpath>"#,
        );
        let cp = ProjectCp::load(&root).unwrap();
        let mut dirs = Vec::new();
        push_outputs(&cp, &root, &mut dirs);
        let got: Vec<String> = dirs
            .iter()
            .map(|p| {
                p.strip_prefix(&root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect();
        assert_eq!(
            got,
            [
                // 输出就是模块自己的 classes：原样一份
                "gl/classes",
                // riart：工作台产物在 Eclipse 的 out/riart 之前
                "riart/classes",
                "out/riart",
                // pubapp 没写 output，走默认 out/bin；own 自带 .classpath，不加
                "pubapp/classes",
                "out/bin",
            ]
        );
    }

    /// 依赖链视图：顺序 = 主工程 → 依赖声明顺序，且分组信息能让用户对上 Eclipse。
    #[test]
    fn 依赖链按_classpath_顺序分组() {
        // A → B(exported) → D；A → C。C 在 B 之后声明。
        let ws = build_ws(
            "graph",
            &[
                ("A", "a-out", &[("B", true), ("C", false)]),
                ("B", "b-out", &[("D", true)]),
                ("C", "c-out", &[]),
                ("D", "d-out", &[]),
            ],
        );
        let home = temp_dir("graph-home");
        let g = graph(&ws.join("A"), &home, &[]);

        assert_eq!(
            names(&g),
            vec!["A", "B", "D", "C"],
            "顺序必须与 .classpath 一致"
        );
        assert_eq!(g.projects[0].origin, "primary");
        assert_eq!(g.projects[0].depth, 0);
        assert!(g.projects[1].exported, "B 那条边是 exported");
        assert_eq!(g.projects[2].depth, 2, "D 是 B 传递进来的");
        assert!(!g.projects[3].exported);
        assert!(g.projects.iter().all(|p| p.has_classpath));
        assert_eq!(g.project_dir_count, 4, "四个工程各一个输出目录");
        assert!(g.notes.is_empty(), "干净工作区不该有说明：{:?}", g.notes);

        // 视图与真正塞进 classpath 的目录必须逐项一致
        let dirs = class_roots_with(&ws.join("A"), &home, &[]);
        let flat: Vec<PathBuf> = g
            .projects
            .iter()
            .flat_map(|p| p.class_dirs.iter().map(PathBuf::from))
            .collect();
        assert_eq!(dirs, flat);

        cleanup(&ws);
        cleanup(&home);
    }

    /// 停用 B 必须连带剪掉只有它能传递到的 D——只剪一层等于没剪。
    #[test]
    fn 停用工程连带剪掉它往下的依赖() {
        let ws = build_ws(
            "disable",
            &[
                ("A", "a-out", &[("B", true), ("C", false)]),
                ("B", "b-out", &[("D", true)]),
                ("C", "c-out", &[]),
                ("D", "d-out", &[]),
            ],
        );
        let home = temp_dir("disable-home");
        let ov = [LinkedOverride {
            action: OverrideAction::Disable,
            target: "B".into(),
            dir: None,
        }];
        let g = graph(&ws.join("A"), &home, &ov);
        // B 留壳（用户要看得见自己停用了谁），D 只有经 B 才能传递到，必须一起消失
        assert_eq!(names(&g), vec!["A", "B", "C"]);
        assert!(
            g.projects
                .iter()
                .find(|p| p.name == "B")
                .is_some_and(|p| p.disabled),
            "B 要标成停用"
        );
        assert!(
            !g.projects.iter().any(|p| p.name == "D"),
            "只有 B 能传递到的 D 必须消失，否则等于只剪了一层"
        );

        let dirs = class_roots_with(&ws.join("A"), &home, &ov);
        assert!(
            !dirs.iter().any(|d| d.to_string_lossy().contains("b-out")),
            "被停用的工程不该留下目录：{dirs:?}"
        );
        assert!(
            g.notes.iter().any(|n| n.contains("B 被覆盖表停用")),
            "界面要能看见剪掉了谁：{:?}",
            g.notes
        );
        cleanup(&ws);
        cleanup(&home);
    }

    /// 停用只留壳：条目还在（用户看得见自己停用了谁），但类目录清空。
    #[test]
    fn 停用的工程留在列表里但目录清空() {
        let ws = build_ws(
            "disable-shell",
            &[("A", "a-out", &[("B", false)]), ("B", "b-out", &[])],
        );
        let home = temp_dir("disable-shell-home");
        let ov = [LinkedOverride {
            action: OverrideAction::Disable,
            target: "B".into(),
            dir: None,
        }];
        let g = graph(&ws.join("A"), &home, &ov);
        let b = g.projects.iter().find(|p| p.name == "B").expect("B 要留壳");
        assert!(b.disabled);
        assert!(b.class_dirs.is_empty());
        cleanup(&ws);
        cleanup(&home);
    }

    /// 排前：主工程之后、其它依赖之前；且配置顺序即优先级。
    #[test]
    fn 排前把工程提到其它依赖之前() {
        let ws = build_ws(
            "front",
            &[
                ("A", "a-out", &[("B", false), ("C", false)]),
                ("B", "b-out", &[]),
                ("C", "c-out", &[]),
            ],
        );
        let home = temp_dir("front-home");
        let ov = [
            LinkedOverride {
                action: OverrideAction::Front,
                target: "C".into(),
                dir: None,
            },
            LinkedOverride {
                action: OverrideAction::Front,
                target: "B".into(),
                dir: None,
            },
        ];
        let g = graph(&ws.join("A"), &home, &ov);
        // 配置里 C 在前，所以 C 排第一（主工程之后）
        assert_eq!(names(&g), vec!["A", "C", "B"]);
        assert_eq!(g.projects[1].origin, "front");
        cleanup(&ws);
        cleanup(&home);
    }

    /// 排前也能用于「不在依赖链上」的工程：单独解析一次再插进来。
    #[test]
    fn 排前可用于链外工程() {
        let ws = build_ws(
            "front-outside",
            &[
                ("A", "a-out", &[("B", false)]),
                ("B", "b-out", &[]),
                ("X", "x-out", &[]),
            ],
        );
        let home = temp_dir("front-outside-home");
        let ov = [LinkedOverride {
            action: OverrideAction::Front,
            target: "X".into(),
            dir: None,
        }];
        let g = graph(&ws.join("A"), &home, &ov);
        assert_eq!(names(&g), vec!["A", "X", "B"]);
        assert_eq!(g.projects[1].origin, "front");
        cleanup(&ws);
        cleanup(&home);
    }

    /// 追加目录：存在的收进来，不存在的跳过并说明（不能静默——用户会以为生效了）。
    #[test]
    fn 追加目录存在才收且不存在的要说明() {
        let ws = build_ws("add", &[("A", "a-out", &[])]);
        let home = temp_dir("add-home");
        let extra = ws.join("handmade");
        touch_class(&extra);
        let ghost = ws.join("ghost");
        let ov = [
            LinkedOverride {
                action: OverrideAction::Add,
                target: String::new(),
                dir: Some(extra.to_string_lossy().to_string()),
            },
            LinkedOverride {
                action: OverrideAction::Add,
                target: String::new(),
                dir: Some(ghost.to_string_lossy().to_string()),
            },
        ];
        let g = graph(&ws.join("A"), &home, &ov);
        assert_eq!(g.extra_dirs.len(), 1, "只收存在的那个");
        assert!(g.extra_dirs[0].ends_with("handmade"));
        assert!(
            g.notes.iter().any(|n| n.contains("不存在")),
            "跳过的要说明：{:?}",
            g.notes
        );
        let dirs = class_roots_with(&ws.join("A"), &home, &ov);
        assert_eq!(dirs.last().unwrap(), &extra, "追加目录排在工程目录之后");
        cleanup(&ws);
        cleanup(&home);
    }

    /// 主工程永远第一、也不可停用：配置写错了要忽略并说明，而不是把主工程剪掉。
    #[test]
    fn 主工程不可停用也不可排后() {
        let ws = build_ws(
            "primary-guard",
            &[("A", "a-out", &[("B", false)]), ("B", "b-out", &[])],
        );
        let home = temp_dir("primary-guard-home");
        let ov = [
            LinkedOverride {
                action: OverrideAction::Disable,
                target: "A".into(),
                dir: None,
            },
            LinkedOverride {
                action: OverrideAction::Front,
                target: "A".into(),
                dir: None,
            },
        ];
        let g = graph(&ws.join("A"), &home, &ov);
        assert_eq!(names(&g), vec!["A", "B"]);
        assert!(!g.projects[0].disabled);
        assert!(!g.projects[0].class_dirs.is_empty());
        assert!(
            g.notes.iter().any(|n| n.contains("主工程")),
            "忽略配置也要说一句：{:?}",
            g.notes
        );
        cleanup(&ws);
        cleanup(&home);
    }

    /// 依赖指向不存在的工程：条目要留在列表里并说明，别静默消失。
    #[test]
    fn 找不到的依赖留下说明() {
        let ws = build_ws(
            "missing",
            &[("A", "a-out", &[("Nope", true)]), ("B", "b-out", &[])],
        );
        let home = temp_dir("missing-home");
        let g = graph(&ws.join("A"), &home, &[]);
        let n = g
            .projects
            .iter()
            .find(|p| p.name == "Nope")
            .expect("要留条目");
        assert!(n.root.is_none());
        assert!(n.class_dirs.is_empty());
        assert!(
            g.notes.iter().any(|n| n.contains("Nope")),
            "要说清是哪个依赖找不到：{:?}",
            g.notes
        );
        cleanup(&ws);
        cleanup(&home);
    }

    /// 覆盖表按绝对路径也能命中（用户可能从界面上贴了完整路径）。
    #[test]
    fn 覆盖表支持绝对路径与大小写不敏感() {
        let ws = build_ws(
            "match",
            &[("A", "a-out", &[("B", false)]), ("B", "b-out", &[])],
        );
        let home = temp_dir("match-home");
        let target = ws.join("B").to_string_lossy().to_uppercase();
        let ov = [LinkedOverride {
            action: OverrideAction::Disable,
            target,
            dir: None,
        }];
        let g = graph(&ws.join("A"), &home, &ov);
        let b = g.projects.iter().find(|p| p.name == "B").expect("B 要留壳");
        assert!(b.disabled, "大写路径也要命中 B");
        assert!(b.class_dirs.is_empty());
        cleanup(&ws);
        cleanup(&home);
    }

    #[test]
    fn 覆盖动作解析只认三种写法() {
        assert_eq!(
            OverrideAction::parse("disable"),
            Some(OverrideAction::Disable)
        );
        assert_eq!(
            OverrideAction::parse(" OFF "),
            Some(OverrideAction::Disable)
        );
        assert_eq!(OverrideAction::parse("front"), Some(OverrideAction::Front));
        assert_eq!(OverrideAction::parse("first"), Some(OverrideAction::Front));
        assert_eq!(OverrideAction::parse("add"), Some(OverrideAction::Add));
        assert_eq!(OverrideAction::parse("delete"), None);
        assert_eq!(OverrideAction::parse(""), None);
        // 回写配置用的字符串必须是 parse 认得的（否则存进去下次读不出来）
        for a in [
            OverrideAction::Disable,
            OverrideAction::Front,
            OverrideAction::Add,
        ] {
            assert_eq!(OverrideAction::parse(a.as_str()), Some(a));
        }
    }

    /// 编译顺序 = 类路径顺序的倒序：类路径是「主工程 → 依赖」，编译要「依赖 → 主工程」。
    #[test]
    fn 编译顺序按依赖优先且去重() {
        let root = Path::new("C:/work/aier");
        let dirs = vec![
            PathBuf::from("C:/work/aier/EyePortal/classes"),
            PathBuf::from("C:/work/aier/EyePortal/bin"),
            PathBuf::from("C:/work/aier/pm/bin"),
            PathBuf::from("C:/work/aier/newar/out/uapbd"),
            PathBuf::from("C:/work/aier/newar/out"),
        ];
        assert_eq!(
            compile_order(&dirs, root),
            vec!["newar", "pm", "EyePortal"],
            "最深依赖先编，主工程最后；同名模块只出现一次"
        );
    }

    /// 工作区外的目录不参与（CompileEnv 只有一个 project_root，编了会写错位置）。
    #[test]
    fn 编译顺序忽略工作区外目录() {
        let root = Path::new("C:/work/aier");
        let dirs = vec![
            PathBuf::from("D:/other/foo/classes"),
            PathBuf::from("C:/work/aier/pm/classes"),
            // 直接挂在根下的那一层不是模块：追加目录、根工程自己的 `classes`
            PathBuf::from("C:/work/aier/classes"),
            PathBuf::from("C:/work/aier/pm"),
        ];
        assert_eq!(compile_order(&dirs, root), vec!["pm"]);
    }

    /// 模块名保留原始大小写（调用方拿它拼 `<root>/<module>`），
    /// 去重与工作区前缀比对都大小写不敏感——Windows 上 `EyePortal` 与 `eyeportal` 是同一个目录。
    #[test]
    fn 编译顺序保留目录名大小写() {
        let root = Path::new("c:/WORK/Aier");
        let dirs = vec![
            PathBuf::from("C:/work/aier/EyePortal/classes"),
            PathBuf::from("c:/work/aier/eyeportal/bin"),
            PathBuf::from("C:/work/aier/pm/classes"),
        ];
        assert_eq!(compile_order(&dirs, root), vec!["pm", "EyePortal"]);
    }

    #[test]
    fn 模块目录兜底只认_classpath_或_src() {
        let d = temp_dir("moddirs");
        fs::create_dir_all(d.join("pm").join("src")).unwrap();
        fs::create_dir_all(d.join("eye")).unwrap();
        write(&d.join("eye").join(".classpath"), "<classpath/>");
        fs::create_dir_all(d.join("logs")).unwrap();
        fs::write(d.join("readme.txt"), "x").unwrap();
        assert_eq!(module_dirs_of(&d), vec!["eye", "pm"]);
        cleanup(&d);
    }
}
