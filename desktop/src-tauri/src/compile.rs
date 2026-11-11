//! 用 ecj 编译 NC 模块。
//!
//! 做法全部来自 M0 实测（细节见方案文档附 C）：
//! - ecj 用 Eclipse 4.11 自带的 jdt.core 3.17，参数 `-1.8 -g -nowarn -proc:none -preserveAllLocals`，
//!   缺 `-preserveAllLocals` 会和 Eclipse 产物差几十字节；
//! - 不能把 7000+ 个 jar 全放 classpath（数分钟跑不出结果），按源码 import 反查类索引挑 jar，
//!   编译报「类找不到」时再按报错分轮补 jar；
//! - jar 顺序要按 Eclipse 的 classpath 顺序（nc_index 保证），同名类先出现的优先；
//! - 不要给 `-sourcepath` 放其它模块源码（连带编译会滚雪球式报错）；
//!   单文件编译只把「被引用、还没编出 class 的同模块兄弟源文件」作为额外编译单元带上（`missing_sibling_sources`）；
//! - 逐文件标编码，写法是 `X.java[GBK]`。
//!
//! 纯逻辑模块，不含 tauri 类型（原因见 workspace.rs 头注释）。

use std::collections::BTreeSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::nc_index::ClassIndex;
use crate::workspace::{decode_lossy, detect_encoding, TextEncoding};

/// ecj 批量编译器入口类。
const ECJ_MAIN: &str = "org.eclipse.jdt.internal.compiler.batch.Main";
/// 源码目录（相对模块根）。
const SRC_DIRS: [&str; 3] = ["src/public", "src/client", "src/private"];
/// 「类找不到」驱动的补 jar 最多轮数。
const MAX_ROUNDS: u32 = 6;
const TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Problem {
    /// "error" | "warning"
    pub severity: String,
    pub file: String,
    pub line: u32,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileResult {
    pub ok: bool,
    pub duration_ms: u64,
    pub source_count: usize,
    pub error_count: usize,
    pub warning_count: usize,
    pub problems: Vec<Problem>,
    pub jar_count: usize,
    pub rounds: u32,
    pub out_dir: String,
    /// D4 诊断：产物比源码旧 / 有源码没产物 / 所在工程被停用。
    ///
    /// 与 `problems` 分开：`problems` 是 ecj 原文（有行列、可跳转），
    /// 诊断是我们的推断，不该算进错误数。原文报错**不**被替换。
    pub diagnostics: Vec<crate::compile_diag::Diagnostic>,
    /// 本次最终用到的 jar 序号（调用方缓存后下次作为 seed，省掉分轮补 jar）。
    #[serde(skip)]
    pub resolved_jars: Vec<u32>,
    /// 按模块的结果账本。单模块编译只有一条；`compile_all` 会带上 blocked / skipped。
    ///
    /// 前端的 `compileResult` 仍保留为派生视图（合并后的 problems / 计数），
    /// 但面板与状态栏要能显示「哪个模块失败、哪个模块被阻断」，不能再从错误里猜。
    #[serde(default)]
    pub modules: Vec<ModuleBuildResult>,
}

/// 一个模块在一轮构建里的结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleBuildResult {
    pub module: String,
    /// `ok` / `failed` / `blocked` / `skipped` / `cleaned`
    pub status: String,
    pub error_count: usize,
    pub warning_count: usize,
    pub duration_ms: u64,
    pub source_count: usize,
    pub out_dir: String,
    /// 本轮清理掉的 class 数（重编时）
    pub cleaned: usize,
    /// 跳过 / 阻断的原因（给用户看的一句话）
    pub reason: Option<String>,
}

impl ModuleBuildResult {
    pub fn ok(module: &str, r: &CompileResult) -> Self {
        Self {
            module: module.to_string(),
            status: if r.error_count == 0 { "ok" } else { "failed" }.to_string(),
            error_count: r.error_count,
            warning_count: r.warning_count,
            duration_ms: r.duration_ms,
            source_count: r.source_count,
            out_dir: r.out_dir.clone(),
            cleaned: 0,
            reason: None,
        }
    }
}

pub struct CompileEnv<'a> {
    pub nc_home: &'a Path,
    pub java_exe: &'a Path,
    pub ecj_jar: &'a Path,
    /// 常驻编译桥 jar（`ncecj.jar`）。`None` = 退回一次一进程（测试 / 资源缺失）。
    pub worker_jar: Option<&'a Path>,
    /// 工程根（如 newar），其下每个子目录是一个模块。
    pub project_root: &'a Path,
    pub index: &'a ClassIndex,
    /// 存放参数文件的临时目录。
    pub work_dir: &'a Path,
    /// 取消标志；`None` = 不可取消（测试与一次性调用）。
    ///
    /// 一次编译最坏是「300 秒 × 6 轮」≈ 30 分钟，没有任何中断手段时用户只能杀进程。
    /// 检查点放在轮间与 ecj 等待循环里（40ms 一次），保证点了取消能很快生效。
    pub cancel: Option<&'a std::sync::atomic::AtomicBool>,
    /// 工程关联覆盖表（停用 / 排前 / 追加目录）。
    ///
    /// 编译与启动**必须**用同一份：两边差一条，就会出现「编译能过、重启加载不到」
    /// 或者反过来的假象，而且查起来毫无线索。空切片 = 完全按 `.classpath`。
    pub overrides: &'a [crate::eclipse_cp::LinkedOverride],
}

impl CompileEnv<'_> {
    fn cancelled(&self) -> bool {
        self.cancel
            .map(|c| c.load(std::sync::atomic::Ordering::Relaxed))
            .unwrap_or(false)
    }
}

/// 取消时返回的错误前缀：前端据此弹「已取消」而不是报错。
pub const CANCELLED: &str = "CANCELLED:编译已取消";

/// 参数文件名里的序号（避免同进程并发编译撞同一个文件）。
static ARGS_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub struct CompileJob {
    pub module: String,
    /// 只编译这些文件；None = 整个模块。
    pub files: Option<Vec<PathBuf>>,
    /// 产物目录。`output_map` 为空时所有文件都写这里（兼容老调用点与单文件编译）。
    pub out_dir: PathBuf,
    /// `.classpath` 声明的源根；None = 按 `SRC_DIRS` 回落。
    pub source_roots: Option<Vec<PathBuf>>,
    /// 源根 → 产物目录（按最长前缀匹配）。一个模块多个 output 时分组各跑一轮 ecj。
    pub output_map: Vec<(PathBuf, PathBuf)>,
    /// 上次编译用到的 jar，省掉分轮补 jar 的时间。
    pub seed_jars: Vec<u32>,
    /// 快速模式（保存后的单文件编译）：启动参数偏向「起得快」。
    pub fast: bool,
}

/// 从文件路径推出所属模块名（工程根下的第一级目录）。
pub fn module_of(project_root: &Path, file: &Path) -> Option<String> {
    // Windows 路径不区分大小写、分隔符也可能混用：统一成 `/` 后忽略大小写比较，名字取原文里的写法
    let norm = |p: &Path| p.to_string_lossy().replace(char::from(92), "/");
    let root = norm(project_root);
    let root = root.trim_end_matches('/');
    let f = norm(file);
    if f.len() <= root.len() + 1
        || !f.is_char_boundary(root.len())
        || !f.is_char_boundary(root.len() + 1)
    {
        return None;
    }
    if !f[..root.len()].eq_ignore_ascii_case(root) || !f[root.len()..].starts_with('/') {
        return None;
    }
    f[root.len() + 1..]
        .split('/')
        .next()
        .filter(|m| !m.is_empty())
        .map(str::to_string)
}

pub fn collect_sources(module_dir: &Path) -> Vec<PathBuf> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(rd) = std::fs::read_dir(dir) else {
            return;
        };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(&p, out);
            } else if p.extension().is_some_and(|x| x == "java") {
                out.push(p);
            }
        }
    }
    let mut out = Vec::new();
    for d in SRC_DIRS {
        walk(&module_dir.join(d), &mut out);
    }
    out.sort();
    out
}

/// 提取 import：返回 (名字, 是否通配符)。只看行首是 `import` 的行，不做完整语法分析。
pub fn extract_imports(text: &str) -> Vec<(String, bool)> {
    let mut out = Vec::new();
    // 按语句而不是按行切：一行里写 `package p; import q.*;` 也是合法 Java，
    // 行首匹配会漏掉后面的 import（反向依赖会因此少编引用方）。
    // 最后一段没有分号收尾，不是完整语句（例如注释残缺 / 文件被截断），跳过。
    let parts: Vec<&str> = text.split(';').collect();
    for stmt in parts.iter().take(parts.len().saturating_sub(1)) {
        let Some(rest) = stmt.trim_start().strip_prefix("import ") else {
            continue;
        };
        let rest = rest.trim_start();
        let rest = rest
            .strip_prefix("static ")
            .map(str::trim_start)
            .unwrap_or(rest);
        let name = rest.trim();
        if name.is_empty()
            || !name
                .chars()
                .all(|c| c.is_alphanumeric() || matches!(c, '.' | '_' | '$' | '*'))
        {
            continue;
        }
        match name.strip_suffix(".*") {
            Some(pkg) => out.push((pkg.to_string(), true)),
            None => out.push((name.to_string(), false)),
        }
    }
    out
}

/// 提取 `package x.y;` 声明。同包的类不需要 import，所以包本身也要当作一次隐式的通配 import。
pub fn extract_package(text: &str) -> Option<String> {
    let rest = text
        .lines()
        .find_map(|l| l.trim_start().strip_prefix("package "))?;
    let name = rest.split(';').next()?.trim();
    (!name.is_empty()
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '.' | '_' | '$')))
    .then(|| name.to_string())
}

/// 把一个名字（类、内部类或 static import 的成员）解析成 jar 序号：先按类查，不行就逐级去掉末段（最多两级）。
fn jar_for_name(index: &ClassIndex, name: &str) -> Option<u32> {
    let mut cur = name;
    for _ in 0..3 {
        if let Some(j) = index.jar_for_class(cur) {
            return Some(j);
        }
        cur = cur.rsplit_once('.')?.0;
    }
    None
}

fn add_import(index: &ClassIndex, jars: &mut BTreeSet<u32>, name: &str, wildcard: bool) {
    if wildcard {
        jars.extend(index.jars_for_package(name).iter().copied());
    } else if let Some(j) = jar_for_name(index, name) {
        jars.insert(j);
    }
}

/// 把注释和字符串字面量抹成空格（换行保留，行号不变）。
///
/// 只为扫「全限定类名」服务：注释和字符串里恰好有个像类名的串，不该让它去挑 jar。
fn blank_comments_and_strings(text: &str) -> String {
    let b: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        let next = b.get(i + 1).copied();
        if c == '/' && next == Some('/') {
            while i < b.len() && b[i] != '\n' {
                out.push(' ');
                i += 1;
            }
        } else if c == '/' && next == Some('*') {
            while i < b.len() && !(b[i] == '*' && b.get(i + 1) == Some(&'/')) {
                out.push(if b[i] == '\n' { '\n' } else { ' ' });
                i += 1;
            }
            // 吃掉收尾的 */（文件被截断时 i 已到末尾，不越界）
            for _ in 0..2 {
                if i < b.len() {
                    out.push(' ');
                    i += 1;
                }
            }
        } else if c == '\"' || c == '\'' {
            out.push(' ');
            i += 1;
            while i < b.len() && b[i] != c && b[i] != '\n' {
                if b[i] == '\\' && i + 1 < b.len() && b[i + 1] != '\n' {
                    out.push(' ');
                    i += 1;
                }
                out.push(' ');
                i += 1;
            }
            if i < b.len() && b[i] == c {
                out.push(' ');
                i += 1;
            }
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

/// 抽出源码里所有带点的标识符链（`a.b.c.D.m` 这种写法），已去掉注释与字符串。
///
/// 不带 import 的全限定写法（`if (nc.vo.tmpub.util.StringUtil.isNull(x))`）只出现在正文里，
/// 只看 import 挑 jar 会漏掉它们，ecj 报的又是包名（`nc.vo.tmpub cannot be resolved`），
/// 事后补 jar 的办法点不出缺哪个 jar。
pub fn extract_dotted_chains(text: &str) -> Vec<String> {
    let clean = blank_comments_and_strings(text);
    let b: Vec<char> = clean.chars().collect();
    let is_start = |c: char| c.is_alphabetic() || c == '_' || c == '$';
    let is_part = |c: char| c.is_alphanumeric() || c == '_' || c == '$';
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        // 链只能从标识符开头起，且前一个字符不是标识符/点（避免从 `x.y.z` 中间起一条）
        let prev_ok = i == 0 || !(is_part(b[i - 1]) || b[i - 1] == '.');
        if !(is_start(b[i]) && prev_ok) {
            i += 1;
            continue;
        }
        let begin = i;
        while i < b.len() {
            // 标识符字符，或者「后面紧跟标识符开头」的点，都属于这条链
            let dot_in_chain = b[i] == '.' && b.get(i + 1).is_some_and(|&c| is_start(c));
            if !(is_part(b[i]) || dot_in_chain) {
                break;
            }
            i += 1;
        }
        let chain: String = b[begin..i].iter().collect();
        if chain.contains('.') && seen.insert(chain.clone()) {
            out.push(chain);
        }
    }
    out
}

/// 一条点链里最短的、在类索引里真实存在的类前缀（全限定类名）。
///
/// 只有索引命中才算：变量链（`this.a.b`、`vo.getName`）不会误挑 jar。
fn qualified_class(index: &ClassIndex, chain: &str) -> Option<String> {
    let segs: Vec<&str> = chain.split('.').collect();
    (2..=segs.len())
        .map(|k| segs[..k].join("."))
        .find(|c| index.jar_for_class(c).is_some())
}

fn qualified_jar(index: &ClassIndex, chain: &str) -> Option<u32> {
    qualified_class(index, chain).and_then(|c| index.jar_for_class(&c))
}

/// 把正文里的全限定类名对应的 jar 补进来（见 `extract_dotted_chains`）。
///
/// `chains` 由调用方每文件抽一次后传入：抹注释要 collect 两遍整文件字符，
/// 全量编译时按文件重复扫是纯浪费。
fn add_qualified_refs(index: &ClassIndex, jars: &mut BTreeSet<u32>, chains: &[String]) {
    for chain in chains {
        if let Some(j) = qualified_jar(index, chain) {
            jars.insert(j);
        }
    }
}

/// 源码里引用到的类型（单类 import + 正文全限定名）的父类/接口链上的 jar 一并补上。
///
/// 只补类型自身的 jar 不够：`nc.vo.am.common.util.StringUtils` 的 `isBlank` 继承自
/// `nccloud...StringUtils` → `org.apache.commons.lang3.StringUtils`，链上任何一环的 jar
/// 不在类路径里，ecj 都只报「The method isBlank(String) is undefined」，既不点名缺哪个类，
/// 也没有「hierarchy inconsistent」可供事后补。`seen` 在整批文件间共用，同一个类只读一次。
///
/// `imports` / `chains` 同样是调用方每文件扫一次的结果，与 `add_qualified_refs` 共用。
fn add_referenced_type_supers(
    index: &ClassIndex,
    jars: &mut BTreeSet<u32>,
    imports: &[(String, bool)],
    chains: &[String],
    seen: &mut std::collections::HashSet<String>,
) {
    for (name, wildcard) in imports {
        if *wildcard {
            continue;
        }
        // import 的可能是 static 成员或内部类：逐级去掉末段，取第一个真实存在的类
        let mut cur = name.as_str();
        for _ in 0..3 {
            if index.jar_for_class(cur).is_some() {
                add_super_chain_seen(index, jars, cur, seen);
                break;
            }
            match cur.rsplit_once('.') {
                Some((head, _)) => cur = head,
                None => break,
            }
        }
    }
    for chain in chains {
        if let Some(c) = qualified_class(index, chain) {
            add_super_chain_seen(index, jars, &c, seen);
        }
    }
}

/// 从 ecj 的报错里找「还缺哪个 jar」：
///
/// - `The import X cannot be resolved`（X 可能是类，也可能是 import a.b.* 的包名）
/// - `The type X cannot be resolved. It is indirectly referenced from required .class files`
///
/// 不要用「简单类名猜 jar」兔底（M0 实测会引入错误版本越补越乱）。
fn discover_jars(index: &ClassIndex, output: &str, jars: &mut BTreeSet<u32>) -> usize {
    let before = jars.len();
    for line in output.lines() {
        let name = if let Some(rest) = line.strip_prefix("The import ") {
            rest.split(" cannot be resolved").next()
        } else if line.contains("indirectly referenced") {
            line.strip_prefix("The type ")
                .and_then(|r| r.split(" cannot be resolved").next())
        } else {
            None
        };
        let Some(name) = name.map(str::trim).filter(|n| !n.is_empty()) else {
            continue;
        };
        if let Some(j) = jar_for_name(index, name) {
            jars.insert(j);
        } else {
            // `import a.b.*;` 报错里的名字是包名
            jars.extend(index.jars_for_package(name).iter().copied());
        }
    }
    discover_qualified(index, output, jars);
    jars.len() - before
}

/// 「`a.b.c cannot be resolved`」（点名的是包前缀、不是类）：回读出错那一行，
/// 找以该前缀开头的全限定写法，按类索引挑 jar。正文里的全限定名在预挑阶段已经处理过，
/// 这里兜的是预挑漏掉的（比如写在多行表达式里被换行拆开的链）。
fn discover_qualified(index: &ClassIndex, output: &str, jars: &mut BTreeSet<u32>) {
    // 一个文件 N 条报错只读一次盘：整文件读 + 解码按文件名缓存（补 jar 最多 6 轮，每轮都重来）
    let mut texts: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for p in parse_problems(output) {
        let Some(name) = p.message.strip_suffix(" cannot be resolved") else {
            continue;
        };
        if !name.contains('.') || name.contains(' ') {
            continue;
        }
        let text = texts.entry(p.file.clone()).or_insert_with(|| {
            std::fs::read(&p.file)
                .map(|b| decode_lossy(&b))
                .unwrap_or_default()
        });
        let Some(line) = text.lines().nth(p.line.saturating_sub(1) as usize) else {
            continue;
        };
        for chain in extract_dotted_chains(line) {
            if chain.starts_with(name) {
                if let Some(j) = qualified_jar(index, &chain) {
                    jars.insert(j);
                }
            }
        }
    }
}

/// 读 class 文件头，返回直接父类与实现接口的全限定名（只解析常量池，不看字段方法）。
fn class_supers(jar: &Path, fqcn: &str) -> Vec<String> {
    // 单文件保存编译会反复读同一批类的头，缓存结果；但 jar 会原地重建（旧父类链会让挑 jar 挑错），
    // 所以 (len, mtime) 进键，再按插入顺序封顶淘汰，长会话里不会无界增长
    type Stamp = Option<(u64, Option<std::time::SystemTime>)>;
    type Key = (PathBuf, String, Stamp);
    type SupersCache = std::sync::Mutex<(
        std::collections::HashMap<Key, Vec<String>>,
        std::collections::VecDeque<Key>,
    )>;
    const CAP: usize = 4096;
    static CACHE: std::sync::OnceLock<SupersCache> = std::sync::OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    let stamp: Stamp = std::fs::metadata(jar)
        .ok()
        .map(|m| (m.len(), m.modified().ok()));
    let key = (jar.to_path_buf(), fqcn.to_string(), stamp);
    if let Some(hit) = cache.lock().ok().and_then(|c| c.0.get(&key).cloned()) {
        return hit;
    }
    let supers = class_supers_uncached(jar, fqcn);
    if let Ok(mut c) = cache.lock() {
        if !c.0.contains_key(&key) {
            c.1.push_back(key.clone());
        }
        c.0.insert(key, supers.clone());
        while c.1.len() > CAP {
            if let Some(old) = c.1.pop_front() {
                c.0.remove(&old);
            }
        }
    }
    supers
}

fn class_supers_uncached(jar: &Path, fqcn: &str) -> Vec<String> {
    let parse = || -> Option<Vec<String>> {
        let file = std::fs::File::open(jar).ok()?;
        let mut zip = zip::ZipArchive::new(file).ok()?;
        let mut entry = zip
            .by_name(&format!("{}.class", fqcn.replace('.', "/")))
            .ok()?;
        let mut b = Vec::new();
        entry.read_to_end(&mut b).ok()?;
        let u16at = |i: usize| -> Option<usize> {
            Some(((*b.get(i)? as usize) << 8) | *b.get(i + 1)? as usize)
        };
        let count = u16at(8)?;
        // 常量池序号从 1 开始；记下每个条目的起始偏移，Class 条目指向 Utf8 的序号
        let mut offs = vec![0usize; count];
        let mut pos = 10;
        let mut i = 1;
        while i < count {
            offs[i] = pos;
            let tag = *b.get(pos)?;
            pos += match tag {
                1 => 3 + u16at(pos + 1)?,
                3 | 4 | 9 | 10 | 11 | 12 | 17 | 18 => 5,
                5 | 6 => {
                    i += 1; // long/double 占两个序号
                    9
                }
                7 | 8 | 16 | 19 | 20 => 3,
                15 => 4,
                _ => return None,
            };
            i += 1;
        }
        let class_name = |idx: usize| -> Option<String> {
            let o = *offs.get(idx)?;
            let name_idx = u16at(o + 1)?;
            let u = *offs.get(name_idx)?;
            let len = u16at(u + 1)?;
            let raw = b.get(u + 3..u + 3 + len)?;
            Some(String::from_utf8_lossy(raw).replace('/', "."))
        };
        let mut out = Vec::new();
        let super_idx = u16at(pos + 4)?;
        if super_idx != 0 {
            out.push(class_name(super_idx)?);
        }
        let n_if = u16at(pos + 6)?;
        for k in 0..n_if {
            out.push(class_name(u16at(pos + 8 + k * 2)?)?);
        }
        Some(out)
    };
    parse().unwrap_or_default()
}

/// 沿父类/接口链把需要的 jar 全部补上（有深度上限，防止环或异常数据）。
fn add_super_chain(index: &ClassIndex, jars: &mut BTreeSet<u32>, start: &str) {
    add_super_chain_seen(index, jars, start, &mut std::collections::HashSet::new());
}

/// 按需补全一个全限定类型时复用编译的父类/接口链，避免只加目标 jar 造成假红线。
pub fn type_dependency_jars(index: &ClassIndex, name: &str) -> Vec<PathBuf> {
    let mut jars = BTreeSet::new();
    add_super_chain(index, &mut jars, name);
    jars.into_iter()
        .map(|id| index.jars[id as usize].clone())
        .collect()
}

/// 带「已访问」集合的版本：批量处理很多文件时共用同一个集合，同一个父类只读一次 class 头。
fn add_super_chain_seen(
    index: &ClassIndex,
    jars: &mut BTreeSet<u32>,
    start: &str,
    seen: &mut std::collections::HashSet<String>,
) {
    let mut queue = vec![(start.to_string(), 0u32)];
    while let Some((name, depth)) = queue.pop() {
        if depth > 30 || !seen.insert(name.clone()) || name == "java.lang.Object" {
            continue;
        }
        let Some(j) = index.jar_for_class(&name) else {
            continue;
        };
        jars.insert(j);
        for sup in class_supers(&index.jars[j as usize], &name) {
            queue.push((sup, depth + 1));
        }
    }
}

/// 取源码里主类型声明的 extends / implements 名字（去掉泛型），再按 import 或同包还原成全限定名。
pub fn declared_supertypes(text: &str, stem: &str) -> Vec<String> {
    let pkg = extract_package(text).unwrap_or_default();
    let imports = extract_imports(text);
    let Some(at) = ["class ", "interface "]
        .iter()
        .find_map(|kw| text.find(&format!("{kw}{stem}")))
    else {
        return Vec::new();
    };
    let head = &text[at..];
    let head = &head[..head.find('{').unwrap_or(head.len())];
    // 去掉泛型参数，包含嵌套的尖括号
    let (mut depth, mut plain) = (0u32, String::new());
    for c in head.chars() {
        match c {
            '<' => depth += 1,
            '>' => depth = depth.saturating_sub(1),
            _ if depth == 0 => plain.push(c),
            _ => {}
        }
    }
    let mut names = Vec::new();
    for tok in plain.split(|c: char| c.is_whitespace() || c == ',') {
        if tok.is_empty()
            || matches!(tok, "class" | "interface" | "extends" | "implements")
            || tok == stem
        {
            continue;
        }
        names.push(tok.to_string());
    }
    names
        .into_iter()
        .map(|n| {
            if n.contains('.') {
                return n;
            }
            match imports
                .iter()
                .find(|(i, w)| !*w && i.rsplit('.').next() == Some(n.as_str()))
            {
                Some((i, _)) => i.clone(),
                None => format!("{pkg}.{n}"),
            }
        })
        .collect()
}

/// 解析 ecj 的文本输出：
/// ```text
/// 1. ERROR in C:/x/A.java (at line 12)
///     IVoucherQuery srv = ...;
///     ^^^^^^^^^^^^^
/// IVoucherQuery cannot be resolved to a type
/// ----------
/// ```
/// 源码行、脚标行之后到分隔线之前的都是消息正文。
pub fn parse_problems(output: &str) -> Vec<Problem> {
    let mut problems = Vec::new();
    let mut lines = output.lines().peekable();
    while let Some(line) = lines.next() {
        let Some((sev, file, ln)) = parse_header(line) else {
            continue;
        };
        let mut seen_caret = false;
        // 头行之后的第一行是源码回显，不能当消息正文
        let mut first = true;
        let mut message = Vec::new();
        while let Some(&next) = lines.peek() {
            if next.starts_with("----------") {
                break;
            }
            lines.next();
            if seen_caret {
                if !next.trim().is_empty() {
                    message.push(next.trim().to_string());
                }
            } else if next.trim_start().starts_with('^') {
                seen_caret = true;
            } else if first {
                first = false; // 源码回显
            } else if !next.trim().is_empty() {
                // 没有脚标行的报错：ecj 有些版本（以及某些错误类型）不给 `^` 标记。
                // 以前只认脚标之后的行，这些报错解析出来是空串——问题列表里就是一条
                // 没有内容的错误，点进去也不知道错在哪。
                message.push(next.trim().to_string());
            }
        }
        problems.push(Problem {
            severity: sev,
            file,
            line: ln,
            message: message.join(" "),
        });
    }
    problems
}

/// `N. ERROR in <file> (at line L)` → (严重程度, 文件, 行号)。
fn parse_header(line: &str) -> Option<(String, String, u32)> {
    let (num, rest) = line.split_once(". ")?;
    if num.is_empty() || !num.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let (sev, rest) = if let Some(r) = rest.strip_prefix("ERROR in ") {
        ("error", r)
    } else {
        let r = rest.strip_prefix("WARNING in ")?;
        ("warning", r)
    };
    let (file, tail) = rest.rsplit_once(" (at line ")?;
    let ln = tail.strip_suffix(')')?.parse().ok()?;
    Some((sev.to_string(), file.to_string(), ln))
}

/// 不经过 ecj、只按源码本身挑出这批文件需要的 jar：import、同包、父类型链。
///
/// 语言服务（M4）没有「编译报错 → 补 jar」的反馈环，所以把 `discover_hierarchy` 事后才补的
/// 继承链提前展开，否则会出现 `VoucherResources` 那种「继承层次不一致」的假红线。
pub fn select_jars(index: &ClassIndex, files: &[PathBuf]) -> BTreeSet<u32> {
    let mut jars = BTreeSet::new();
    let mut seen = std::collections::HashSet::new();
    for f in files {
        let Ok(bytes) = std::fs::read(f) else {
            continue;
        };
        let text = decode_lossy(&bytes);
        if let Some(pkg) = extract_package(&text) {
            add_import(index, &mut jars, &pkg, true);
        }
        // 每文件只扫一次：import 与点链在下面几个入口间共用，别各扫各的
        let imports = extract_imports(&text);
        let chains = extract_dotted_chains(&text);
        for (name, wildcard) in &imports {
            add_import(index, &mut jars, name, *wildcard);
        }
        add_qualified_refs(index, &mut jars, &chains);
        add_referenced_type_supers(index, &mut jars, &imports, &chains, &mut seen);
        let Some(stem) = f.file_stem().map(|s| s.to_string_lossy().into_owned()) else {
            continue;
        };
        for sup in declared_supertypes(&text, &stem) {
            add_super_chain_seen(index, &mut jars, &sup, &mut seen);
        }
    }
    jars
}

/// 「The hierarchy of the type X is inconsistent」：X 的某级父类缺失，ecj 不会点名是哪个。
/// 按出错文件的声明找到父类型，沿继承链读 class 文件头把缺的 jar 补齐。
fn discover_hierarchy(index: &ClassIndex, output: &str, jars: &mut BTreeSet<u32>) -> usize {
    let before = jars.len();
    let mut done = std::collections::HashSet::new();
    for p in parse_problems(output) {
        if !p.message.contains("hierarchy of the type") || !done.insert(p.file.clone()) {
            continue;
        }
        let path = Path::new(&p.file);
        let Some(stem) = path.file_stem().map(|s| s.to_string_lossy().into_owned()) else {
            continue;
        };
        let Ok(bytes) = std::fs::read(path) else {
            continue;
        };
        for sup in declared_supertypes(&decode_lossy(&bytes), &stem) {
            add_super_chain(index, jars, &sup);
        }
    }
    jars.len() - before
}

/// 跑一次 ecj。
///
/// 优先走常驻 worker（省掉每次 0.6~0.9 秒的 JVM 启动）；worker 缺 jar / 启动失败 /
/// 协议错误时**静默退回**一次一进程，行为与以前完全一致。取消与超时不能回退重跑：
/// 那会让用户等两遍。
fn run_ecj(env: &CompileEnv, args: &Path, fast: bool) -> Result<(bool, String), String> {
    if let Some(jar) = env.worker_jar {
        if let Some((ok, output)) =
            crate::ecj_worker::compile(env.java_exe, env.ecj_jar, jar, args, TIMEOUT, env.cancel)?
        {
            return Ok((ok, clean_ecj_output(output)));
        }
    }
    let started = Instant::now();
    let (ok, output) = run_ecj_oneshot(env, args, fast)?;
    crate::ecj_worker::note_oneshot(started.elapsed().as_millis() as u64);
    Ok((ok, clean_ecj_output(output)))
}

/// JAR 清单里常见的噪声行：不是编译问题，混进问题面板只会添乱。
fn clean_ecj_output(text: String) -> String {
    text.lines()
        .filter(|l| !l.contains("invalid Class-Path header"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn run_ecj_oneshot(env: &CompileEnv, args: &Path, fast: bool) -> Result<(bool, String), String> {
    let mut cmd = Command::new(env.java_exe);
    // ecj 的输出与参数文件都按 UTF-8，避免依赖系统默认编码（中文 Windows 是 GBK）
    cmd.args(["-Dfile.encoding=UTF-8", "-Xmx1024m"]);
    if fast {
        // 保存后的单文件编译只有 1~2 个类，JIT 分层编译的收益为零，启动时间才是全部。
        // 整模块编译仍用默认参数：TieredStopAtLevel=1 会让长时间编译明显变慢。
        cmd.args(["-XX:TieredStopAtLevel=1", "-XX:+UseSerialGC"]);
    }
    cmd.arg("-cp")
        .arg(env.ecj_jar)
        .arg(ECJ_MAIN)
        .arg(format!("@{}", args.display()))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW：不弹控制台窗口
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("无法启动 java（{}）: {e}", env.java_exe.display()))?;
    let mut out = child.stdout.take().ok_or("读取 ecj 输出失败")?;
    let mut err = child.stderr.take().ok_or("读取 ecj 输出失败")?;
    // 用线程排空两个管道，否则输出量大时子进程会卡在写管道上
    let h_out = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = out.read_to_end(&mut b);
        b
    });
    let h_err = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = err.read_to_end(&mut b);
        b
    });
    let start = Instant::now();
    let status = loop {
        match child
            .try_wait()
            .map_err(|e| format!("等待 ecj 失败: {e}"))?
        {
            Some(st) => break st,
            None if env.cancelled() => {
                // 用户点了取消：杀掉本轮，收尾交给上层（返回值带 CANCELLED 前缀）
                let _ = child.kill();
                return Err(CANCELLED.to_string());
            }
            None if start.elapsed() > TIMEOUT => {
                let _ = child.kill();
                return Err(format!("编译超时（超过 {} 秒），已终止", TIMEOUT.as_secs()));
            }
            None => std::thread::sleep(Duration::from_millis(40)),
        }
    };
    let mut text = String::from_utf8_lossy(&h_out.join().unwrap_or_default()).into_owned();
    text.push_str(&String::from_utf8_lossy(&h_err.join().unwrap_or_default()));
    Ok((status.success(), text))
}

fn write_args(
    path: &Path,
    class_dirs: &[PathBuf],
    jars: &[PathBuf],
    out_dir: &Path,
    sources: &[(PathBuf, TextEncoding)],
) -> std::io::Result<()> {
    let fwd = |p: &Path| p.to_string_lossy().replace('\\', "/");
    let cp: Vec<String> = class_dirs
        .iter()
        .chain(jars.iter())
        .map(|p| fwd(p))
        .collect();
    let mut s = String::new();
    s.push_str("-1.8 -g -nowarn -proc:none -preserveAllLocals\n");
    s.push_str(&format!(
        "-cp \"{}\"\n",
        cp.join(crate::java_bridge::CLASSPATH_SEP)
    ));
    s.push_str(&format!("-d \"{}\"\n", fwd(out_dir)));
    for (p, enc) in sources {
        let tag = match enc {
            TextEncoding::Gbk => "GBK",
            TextEncoding::Utf8 => "UTF-8",
        };
        s.push_str(&format!("\"{}[{tag}]\"\n", fwd(p)));
    }
    std::fs::write(path, s)
}

/// 编译一个模块（或模块里的指定文件）。`log` 收到阶段性进展文字，供界面显示。
///
/// 一个模块可能有多个产物目录（`.classpath` 给单条 src 写了 `output=`）：
/// `-d` 只能一个目录，所以按输出分组，每组跑一轮 ecj，共享 jar 集合与源码读取。
pub fn compile(
    env: &CompileEnv,
    job: &CompileJob,
    log: &dyn Fn(&str),
) -> Result<CompileResult, String> {
    let started = Instant::now();
    let module_dir = env.project_root.join(&job.module);
    let mut files = match &job.files {
        Some(f) => f.clone(),
        None => match &job.source_roots {
            Some(roots) => collect_sources_in(roots),
            None => collect_sources(&module_dir),
        },
    };
    // 只编指定文件时，把「被引用、没有 class 的同模块兄弟源文件」一起编；它们的报错不算在本次头上
    let extras: Vec<PathBuf> = if job.files.is_some() && !files.is_empty() {
        let roots: Vec<PathBuf> = job
            .source_roots
            .clone()
            .unwrap_or_else(|| SRC_DIRS.iter().map(|d| module_dir.join(d)).collect());
        let mut built =
            crate::launch::project_class_dirs(env.project_root, env.nc_home, env.overrides);
        built.push(job.out_dir.clone());
        built.extend(job.output_map.iter().map(|(_, o)| o.clone()));
        let found = missing_sibling_sources(&roots, &built, &files);
        if !found.is_empty() {
            log(&format!(
                "带上 {} 个还没编出 class 的同模块源文件：{}",
                found.len(),
                found
                    .iter()
                    .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
                    .take(5)
                    .collect::<Vec<_>>()
                    .join("、")
            ));
        }
        found
    } else {
        Vec::new()
    };
    files.extend(extras.iter().cloned());
    if files.is_empty() {
        return Err(format!(
            "模块 {} 下没有找到 .java 源文件（查找目录：{}）",
            job.module,
            SRC_DIRS.join("、")
        ));
    }

    // 按输出目录分组。`output_map` 为空 / 文件不在任何源根下 → 落到主输出。
    let mut groups: Vec<(PathBuf, Vec<PathBuf>)> = Vec::new();
    for f in files {
        let out = job
            .output_map
            .iter()
            .filter(|(root, _)| path_starts_with(&f, root))
            .max_by_key(|(root, _)| root.components().count())
            .map(|(_, out)| out.clone())
            .unwrap_or_else(|| job.out_dir.clone());
        match groups.iter_mut().find(|(o, _)| path_eq(o, &out)) {
            Some((_, list)) => list.push(f),
            None => groups.push((out, vec![f])),
        }
    }
    if groups.len() > 1 {
        log(&format!(
            "模块 {} 有 {} 个产物目录，按输出分组各编译一轮",
            job.module,
            groups.len()
        ));
    }

    let mut results = Vec::with_capacity(groups.len());
    let total = groups.len();
    for (i, (out, files)) in groups.into_iter().enumerate() {
        if total > 1 {
            log(&format!(
                "输出组 {}/{} → {}（{} 个文件）",
                i + 1,
                total,
                out.display(),
                files.len()
            ));
        }
        results.push(compile_group(
            env,
            GroupJob {
                module: &job.module,
                files: &files,
                extras: &extras,
                out_dir: &out,
                seed_jars: &job.seed_jars,
                fast: job.fast,
            },
            log,
        )?);
    }
    if results.len() == 1 {
        return Ok(results.pop().expect("刚判断过只有一个结果"));
    }
    let mut merged = CompileResult {
        ok: true,
        duration_ms: started.elapsed().as_millis() as u64,
        source_count: 0,
        error_count: 0,
        warning_count: 0,
        problems: Vec::new(),
        jar_count: 0,
        rounds: 0,
        out_dir: results
            .iter()
            .map(|r| r.out_dir.clone())
            .collect::<Vec<_>>()
            .join("；"),
        diagnostics: Vec::new(),
        resolved_jars: Vec::new(),
        modules: Vec::new(),
    };
    let mut jars: BTreeSet<u32> = BTreeSet::new();
    for r in results {
        merged.source_count += r.source_count;
        merged.error_count += r.error_count;
        merged.warning_count += r.warning_count;
        merged.jar_count = merged.jar_count.max(r.jar_count);
        merged.rounds += r.rounds;
        merged.problems.extend(r.problems);
        merged.diagnostics.extend(r.diagnostics);
        jars.extend(r.resolved_jars);
    }
    merged.ok = merged.error_count == 0;
    merged.resolved_jars = jars.into_iter().collect();
    Ok(merged)
}

/// 一组写到同一个产物目录的编译输入（打成结构只是为了压住参数个数）。
struct GroupJob<'a> {
    module: &'a str,
    /// 本组全部要编的文件（含 `extras`）。
    files: &'a [PathBuf],
    /// 为解析引用而带上的兄弟源文件：不计入源文件数，它们的报错也不算本次的。
    extras: &'a [PathBuf],
    out_dir: &'a Path,
    seed_jars: &'a [u32],
    fast: bool,
}

/// 编译一组写到同一个目录的文件。
fn compile_group(
    env: &CompileEnv,
    group: GroupJob,
    log: &dyn Fn(&str),
) -> Result<CompileResult, String> {
    let GroupJob {
        module,
        files,
        extras,
        out_dir,
        seed_jars,
        fast,
    } = group;
    let started = Instant::now();
    let is_extra = |p: &Path| extras.iter().any(|e| path_eq(e, p));
    std::fs::create_dir_all(out_dir).map_err(|e| format!("无法创建输出目录: {e}"))?;
    std::fs::create_dir_all(env.work_dir).map_err(|e| format!("无法创建工作目录: {e}"))?;

    // 读源码：定编码 + 提取 import
    let mut jars: BTreeSet<u32> = seed_jars.iter().copied().collect();
    let mut sources: Vec<(PathBuf, TextEncoding)> = Vec::with_capacity(files.len());
    let mut supers_seen = std::collections::HashSet::new();
    for f in files {
        let bytes = std::fs::read(f).map_err(|e| format!("读取 {} 失败: {e}", f.display()))?;
        let text = decode_lossy(&bytes);
        if let Some(pkg) = extract_package(&text) {
            add_import(env.index, &mut jars, &pkg, true);
        }
        // 每文件只扫一次：import 与点链在下面几个入口间共用（全量编译上千文件，重复抹注释很贵）
        let imports = extract_imports(&text);
        let chains = extract_dotted_chains(&text);
        for (name, wildcard) in &imports {
            add_import(env.index, &mut jars, name, *wildcard);
        }
        add_qualified_refs(env.index, &mut jars, &chains);
        add_referenced_type_supers(env.index, &mut jars, &imports, &chains, &mut supers_seen);
        sources.push((f.clone(), detect_encoding(&bytes)));
    }
    log(&format!(
        "模块 {} · {} 个源文件 · 按 import 挑出 {} 个 jar",
        module,
        sources.len(),
        jars.len()
    ));

    // 跨模块依赖：工程内各模块已编译的 classes、out/<模块>、同工作区其他分组，
    // 再加 NC home 各模块的 classes。规则与启动服务共用（launch::project_class_dirs），
    // 否则会出现「编译过了、启动服务时加载的还是 jar 里的旧类」。
    let class_dirs =
        crate::launch::project_class_dirs(env.project_root, env.nc_home, env.overrides);

    // 参数文件名带唯一后缀：以前是 `ecj-<pid>.args`，同进程两次并发编译会写同一份文件、
    // 互相覆盖（后写的那轮可能读到前半段是自己的、后半段是别人的参数）。
    // 后端因此另有一道互斥（compile_cmds 的 COMPILING 闸），这里是第二道防线。
    let args_path = env.work_dir.join(format!(
        "ecj-{}-{}.args",
        std::process::id(),
        ARGS_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let mut rounds = 0;
    let (mut ok, mut output);
    loop {
        if env.cancelled() {
            let _ = std::fs::remove_file(&args_path);
            return Err(CANCELLED.to_string());
        }
        rounds += 1;
        let jar_paths: Vec<PathBuf> = jars
            .iter()
            .map(|&i| env.index.jars[i as usize].clone())
            .collect();
        write_args(&args_path, &class_dirs, &jar_paths, out_dir, &sources)
            .map_err(|e| format!("写参数文件失败: {e}"))?;
        log(&format!("第 {rounds} 轮编译（{} 个 jar）…", jars.len()));
        (ok, output) = run_ecj(env, &args_path, fast)?;
        if ok || rounds >= MAX_ROUNDS {
            break;
        }
        // 有报错：看是不是因为缺 jar，补了再跑；补不出新的就说明是真正的代码错误
        let mut added = discover_jars(env.index, &output, &mut jars);
        added += discover_hierarchy(env.index, &output, &mut jars);
        if added == 0 {
            break;
        }
        log(&format!("按报错补充 {added} 个 jar，重新编译"));
    }
    let _ = std::fs::remove_file(&args_path);

    let all_problems = parse_problems(&output);
    // 兄弟源文件只是为了让引用解析得到：它们自己的报错不算在本次保存头上
    let extra_errors = all_problems
        .iter()
        .any(|p| p.severity == "error" && is_extra(Path::new(&p.file)));
    let problems: Vec<Problem> = all_problems
        .into_iter()
        .filter(|p| !is_extra(Path::new(&p.file)))
        .collect();
    let error_count = problems.iter().filter(|p| p.severity == "error").count();
    let warning_count = problems.len() - error_count;
    // ecj 退出码非 0 但一条报错都没解析出来：把原始输出带回去，不要假装成功
    // （报错全落在兄弟源文件上时，退出码非 0 是它们造成的，本次要编的文件没问题）
    if !ok && error_count == 0 && !extra_errors {
        return Err(format!(
            "ecj 异常退出：{}",
            output.lines().take(8).collect::<Vec<_>>().join(" | ")
        ));
    }
    // D4：失败归因（有源码没产物 / 工程被停用 / 产物比源码旧）。
    // **只按类判断**，不扫整棵树——全量新旧检测要 8 秒，见 compile_diag::stale_diagnostics。
    // 依赖链在这里解析一次 `.classpath`（毫秒级）：顺序口径与 class_dirs 共用 `flat_dirs`。
    let diagnostics = if error_count > 0 {
        let graph = crate::eclipse_cp::graph(env.project_root, env.nc_home, env.overrides);
        crate::compile_diag::uncompiled_diagnostics(&graph.projects, &problems)
    } else if extra_errors {
        // 兄弟有错、本次保存的文件没错：problems 里没有错误能驱动诊断，等于把「有源码没产物 /
        // 产物比源码旧」这道兜底整个关掉（用户看到成功、运行时却是旧类）。只对被保存文件下探针。
        let graph = crate::eclipse_cp::graph(env.project_root, env.nc_home, env.overrides);
        crate::compile_diag::uncompiled_diagnostics(&graph.projects, &product_probes(files, extras))
    } else {
        Vec::new()
    };
    for d in &diagnostics {
        log(&format!("诊断：{}", d.message));
    }
    Ok(CompileResult {
        ok: error_count == 0,
        duration_ms: started.elapsed().as_millis() as u64,
        source_count: sources.iter().filter(|(p, _)| !is_extra(p)).count(),
        error_count,
        warning_count,
        problems,
        jar_count: jars.len(),
        rounds,
        out_dir: out_dir.to_string_lossy().into_owned(),
        diagnostics,
        resolved_jars: jars.into_iter().collect(),
        modules: Vec::new(),
    })
}

/// 产物兜底诊断的探针：只覆盖本次被保存的源文件（兄弟 extras 不算）。
///
/// `uncompiled_diagnostics` 是按「报错里点名的缺失符号」驱动的；兄弟有错而被保存文件没错时
/// 传进去的 problems 一条错误都没有，诊断就成了空。这里按被保存文件自己的类名合成一条探针
/// （只喂诊断，不进 problems / error_count），让它照样查「有源码没产物 / 产物比源码旧」。
fn product_probes(files: &[PathBuf], extras: &[PathBuf]) -> Vec<Problem> {
    let mut out = Vec::new();
    for f in files {
        if extras.iter().any(|e| path_eq(e, f)) {
            continue;
        }
        let Some(stem) = f.file_stem().map(|s| s.to_string_lossy().into_owned()) else {
            continue;
        };
        out.push(Problem {
            severity: "error".to_string(),
            file: f.to_string_lossy().into_owned(),
            line: 1,
            message: format!("{stem} cannot be resolved"),
        });
    }
    out
}

/// 单文件编译带上的「兄弟源文件」个数上限：只为解决「刚新建、还没编出 class」的引用，不是整模块编译。
const MAX_SIBLING_UNITS: usize = 40;

/// 顶层类 `fqcn` 在任一类目录里有没有已编出的 class。
fn class_built(dirs: &[PathBuf], fqcn: &str) -> bool {
    let rel = format!("{}.class", fqcn.replace('.', "/"));
    dirs.iter().any(|d| d.join(&rel).is_file())
}

/// 正文里有没有「按词边界」点名 `stem`：子串不算（引用 `UtilHelper` 不该把 `Util` 也带上，
/// 那会写出用户没动过的 class）。标识符字符含字母数字与 `_` `$`。
fn mentions_type(code: &str, stem: &str) -> bool {
    if stem.is_empty() {
        return false;
    }
    let is_part = |c: char| c.is_alphanumeric() || c == '_' || c == '$';
    code.match_indices(stem).any(|(at, _)| {
        let before = code[..at].chars().next_back();
        let after = code[at + stem.len()..].chars().next();
        before.is_none_or(|c| !is_part(c)) && after.is_none_or(|c| !is_part(c))
    })
}

/// 找出「被引用、源码在源根里、但还没有 class」的兄弟源文件，随本次编译一起作为编译单元。
///
/// 背景：保存即编只编被改的那一个文件，同模块里刚新建、还没编出 class 的类对它不可见，
/// 会报 `cannot be resolved`；Eclipse 整个工程一起编，不会有这个问题。
/// 不用 `-sourcepath`：它会把所有被引用的源码都连带重编、全部写出 class（M0 实测滚雪球）。
/// 这里只挑「引用得到且确实没有 class」的文件，传递两层，数量封顶。
///
/// - `roots`：本模块的源码根；`built_dirs`：判断「class 是否已有」的目录（类路径 + 产物目录）。
/// - 只认显式 import 与同包里被正文点名的类，通配 import 不展开。
fn missing_sibling_sources(
    roots: &[PathBuf],
    built_dirs: &[PathBuf],
    requested: &[PathBuf],
) -> Vec<PathBuf> {
    let mut extras: Vec<PathBuf> = Vec::new();
    let mut known: Vec<PathBuf> = requested.to_vec();
    let mut frontier: Vec<PathBuf> = requested.to_vec();
    for _depth in 0..2 {
        let mut next: Vec<PathBuf> = Vec::new();
        for f in &frontier {
            let Ok(bytes) = std::fs::read(f) else {
                continue;
            };
            let text = decode_lossy(&bytes);
            let code = blank_comments_and_strings(&text);
            let pkg = extract_package(&text).unwrap_or_default();
            let mut want: Vec<(String, PathBuf)> = Vec::new();
            // 显式 import：逐级去掉末段，兼容 static 成员 / 内部类
            for (name, wildcard) in extract_imports(&text) {
                if wildcard {
                    continue;
                }
                let mut cur = name.as_str();
                for _ in 0..3 {
                    for r in roots {
                        let p = r.join(format!("{}.java", cur.replace('.', "/")));
                        if p.is_file() {
                            want.push((cur.to_string(), p));
                        }
                    }
                    match cur.rsplit_once('.') {
                        Some((head, _)) => cur = head,
                        None => break,
                    }
                }
            }
            // 同包：目录里的类，正文里点名了才算
            for r in roots {
                let dir = r.join(pkg.replace('.', "/"));
                let Ok(rd) = std::fs::read_dir(&dir) else {
                    continue;
                };
                for e in rd.flatten() {
                    let p = e.path();
                    let Some(stem) = p
                        .file_name()
                        .and_then(|n| n.to_str())
                        .and_then(|n| n.strip_suffix(".java"))
                    else {
                        continue;
                    };
                    if mentions_type(&code, stem) {
                        let fq = if pkg.is_empty() {
                            stem.to_string()
                        } else {
                            format!("{pkg}.{stem}")
                        };
                        want.push((fq, p));
                    }
                }
            }
            for (fq, p) in want {
                if known.iter().any(|k| path_eq(k, &p)) || class_built(built_dirs, &fq) {
                    continue;
                }
                if extras.len() >= MAX_SIBLING_UNITS {
                    return extras;
                }
                known.push(p.clone());
                extras.push(p.clone());
                next.push(p);
            }
        }
        if next.is_empty() {
            break;
        }
        frontier = next;
    }
    extras
}

/// 按多个源码根收集 `.java`（不跟随 symlink/junction）。
fn collect_sources_in(roots: &[PathBuf]) -> Vec<PathBuf> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(rd) = std::fs::read_dir(dir) else {
            return;
        };
        for e in rd.flatten() {
            let p = e.path();
            let Ok(md) = std::fs::symlink_metadata(&p) else {
                continue;
            };
            if crate::build_layout::is_reparse(&md) {
                continue;
            }
            if md.is_dir() {
                walk(&p, out);
            } else if p
                .extension()
                .is_some_and(|x| x.eq_ignore_ascii_case("java"))
            {
                out.push(p);
            }
        }
    }
    let mut out = Vec::new();
    for r in roots {
        walk(r, &mut out);
    }
    out.sort();
    out.dedup();
    out
}

fn path_starts_with(path: &Path, base: &Path) -> bool {
    crate::build_layout::path_starts_with(path, base)
}

fn path_eq(a: &Path, b: &Path) -> bool {
    crate::build_layout::eq_path(a, b)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn put(p: &Path, s: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, s).unwrap();
    }

    /// 只挑「被引用、有源码、没有 class」的兄弟：已编出的、没被点名的都不带，传递引用要跟上。
    #[test]
    fn 只带被引用且没有class的兄弟源文件() {
        let base = crate::test_support::tmp("sib-pure");
        let root = base.join("src");
        let built = base.join("classes");
        let a = root.join("p").join("A.java");
        put(
            &a,
            "package p;\nimport q.B;\nimport q.C;\npublic class A { D d; /* Z */ }\n",
        );
        put(
            &root.join("q").join("B.java"),
            "package q;\nimport q.F;\npublic class B { F f; }\n",
        );
        put(
            &root.join("q").join("C.java"),
            "package q;\npublic class C {}\n",
        );
        put(
            &root.join("q").join("F.java"),
            "package q;\npublic class F {}\n",
        );
        put(
            &root.join("p").join("D.java"),
            "package p;\npublic class D {}\n",
        );
        put(
            &root.join("p").join("E.java"),
            "package p;\npublic class E {}\n",
        );
        put(
            &root.join("p").join("Z.java"),
            "package p;\npublic class Z {}\n",
        );
        // C 已经编出过
        put(&built.join("q").join("C.class"), "x");

        let got = missing_sibling_sources(
            std::slice::from_ref(&root),
            std::slice::from_ref(&built),
            std::slice::from_ref(&a),
        );
        let names: BTreeSet<String> = got
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        let want: BTreeSet<String> = ["B.java", "D.java", "F.java"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        // C 已有 class；E 没被点名；Z 只出现在注释里；F 是 B 的引用（第二层）
        assert_eq!(names, want, "实际：{got:?}");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 没有任何引用缺失时不多带文件。
    #[test]
    fn 已全部编出时不带兄弟() {
        let base = crate::test_support::tmp("sib-none");
        let root = base.join("src");
        let built = base.join("classes");
        let a = root.join("p").join("A.java");
        put(&a, "package p;\nimport q.B;\npublic class A { }\n");
        put(
            &root.join("q").join("B.java"),
            "package q;\npublic class B {}\n",
        );
        put(&built.join("q").join("B.class"), "x");
        let got = missing_sibling_sources(
            std::slice::from_ref(&root),
            std::slice::from_ref(&built),
            std::slice::from_ref(&a),
        );
        assert!(got.is_empty(), "{got:?}");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 同包兄弟按词边界点名：`UtilHelper` 不该把 `Util` 带上、`ArrayList` 不该把 `List` 带上；
    /// 真被点名的仍要带（不能为了少带文件而漏掉引用）。
    #[test]
    fn 兄弟点名按词边界_子串不算() {
        let base = crate::test_support::tmp("sib-word");
        let root = base.join("src");
        let built = base.join("classes");
        for n in ["Util", "UtilHelper", "List", "ArrayList"] {
            put(
                &root.join("p").join(format!("{n}.java")),
                &format!("package p;\npublic class {n} {{}}\n"),
            );
        }
        let names = |f: &PathBuf| -> BTreeSet<String> {
            missing_sibling_sources(
                std::slice::from_ref(&root),
                std::slice::from_ref(&built),
                std::slice::from_ref(f),
            )
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect()
        };
        let a = root.join("p").join("A.java");
        put(
            &a,
            "package p;\npublic class A { UtilHelper h; ArrayList l; }\n",
        );
        let want: BTreeSet<String> = ["UtilHelper.java", "ArrayList.java"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(names(&a), want, "子串命中把没点名的兄弟也带上了");

        let b = root.join("p").join("B.java");
        put(&b, "package p;\npublic class B { Util u; List l; }\n");
        let want: BTreeSet<String> = ["Util.java", "List.java"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(names(&b), want, "真被点名的兄弟仍要带上");
    }

    /// 兄弟有错、被保存文件自己没错时，产物兜底诊断仍要覆盖被保存文件（兄弟不参与）。
    #[test]
    fn 兄弟有错时仍对被保存文件做产物诊断() {
        let base = crate::test_support::tmp("sib-probe");
        let root = base.join("newar");
        let a = root
            .join("m")
            .join("src")
            .join("public")
            .join("p")
            .join("A.java");
        let b = root
            .join("m")
            .join("src")
            .join("public")
            .join("q")
            .join("B.java");
        put(&a, "package p;\npublic class A {}\n");
        put(&b, "package q;\npublic class B { int x = \"s\"; }\n");
        let classes = root.join("m").join("classes");
        std::fs::create_dir_all(&classes).unwrap();
        let projects = vec![crate::eclipse_cp::LinkedProject {
            name: "newar".to_string(),
            root: Some(root.to_string_lossy().into_owned()),
            origin: "legacy".to_string(),
            depth: 0,
            exported: true,
            class_dirs: vec![classes.to_string_lossy().into_owned()],
            disabled: false,
            has_classpath: false,
        }];
        let files = vec![a.clone(), b.clone()];
        let extras = vec![b.clone()];
        let probes = product_probes(&files, &extras);
        assert_eq!(probes.len(), 1, "只探被保存文件：{probes:?}");
        assert_eq!(probes[0].file, a.to_string_lossy().into_owned());

        // 本次 problems 里一条错误都没有：探针仍要查出「有源码没产物」
        let diags = crate::compile_diag::uncompiled_diagnostics(&projects, &probes);
        assert!(
            diags
                .iter()
                .any(|d| d.kind == "uncompiled" && d.message.contains("p.A")),
            "应报「有源码没产物」：{diags:?}"
        );
        assert!(
            !diags.iter().any(|d| d.message.contains("q.B")),
            "兄弟不该被诊断：{diags:?}"
        );

        // 产物在、但比源码旧：同样要报出来（编译显示成功、运行时用的是改动前的类）
        let cls = classes.join("p").join("A.class");
        put(&cls, "x");
        let f = std::fs::OpenOptions::new().write(true).open(&cls).unwrap();
        f.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(120))
            .unwrap();
        let diags = crate::compile_diag::uncompiled_diagnostics(
            &projects,
            &product_probes(&files, &extras),
        );
        assert!(
            diags.iter().any(|d| d.kind == "stale-class"),
            "应报「产物比源码旧」：{diags:?}"
        );
    }

    /// 真跑 ecj：保存 A 时 B（同模块、刚新建、还没 class）不再报 cannot be resolved；
    /// B 自己有错时不算在 A 头上，也不会把半成品 class 写进产物目录。
    ///
    /// 真机 live，需显式 `--ignored`：路径守卫只挡「没装 NC 的机器」，挡不住门禁机起真 JVM。
    #[test]
    #[ignore]
    fn 单文件编译能看见还没编出的同模块兄弟() {
        use std::sync::atomic::AtomicBool;
        let java = Path::new(r"D:\ncc\1909home")
            .join("ufjdk")
            .join("bin")
            .join("java.exe");
        let ecj = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("ecj")
            .join("ecj-3.17.jar");
        if !java.is_file() || !ecj.is_file() {
            return;
        }
        let base = crate::test_support::tmp("sib-live");
        let ws = base.join("ws");
        let work = base.join("work");
        std::fs::create_dir_all(&work).unwrap();
        let src = ws.join("m").join("src").join("public");
        let a = src.join("p").join("A.java");
        put(
            &a,
            "package p;\nimport q.B;\npublic class A { public int f() { return new B().g(); } }\n",
        );
        put(
            &src.join("q").join("B.java"),
            "package q;\npublic class B { public int g() { return 1; } }\n",
        );

        let index = crate::nc_index::ClassIndex::build(Vec::new());
        let cancel = AtomicBool::new(false);
        let home = base.join("nchome");
        let env = CompileEnv {
            nc_home: &home,
            java_exe: &java,
            ecj_jar: &ecj,
            worker_jar: None,
            project_root: &ws,
            index: &index,
            work_dir: &work,
            cancel: Some(&cancel),
            overrides: &[],
        };
        let out = ws.join("m").join("classes");
        let job = CompileJob {
            module: "m".to_string(),
            files: Some(vec![a.clone()]),
            out_dir: out.clone(),
            source_roots: None,
            output_map: Vec::new(),
            seed_jars: Vec::new(),
            fast: true,
        };
        let r = compile(&env, &job, &|_| {}).unwrap();
        assert_eq!(r.error_count, 0, "应能看见 B：{:?}", r.problems);
        assert_eq!(r.source_count, 1, "兄弟不计入本次源文件数");
        assert!(out.join("p").join("A.class").is_file());

        // B 自己有错：A 照样算成功，错误不算在 A 头上，B 的半成品不落盘
        let _ = std::fs::remove_dir_all(&out);
        put(
            &src.join("q").join("B.java"),
            "package q;\npublic class B { public int g() { int x = \"s\"; return x; } }\n",
        );
        let r2 = compile(&env, &job, &|_| {}).unwrap();
        assert_eq!(
            r2.error_count, 0,
            "B 的错误不该算在 A 头上：{:?}",
            r2.problems
        );
        assert!(r2.ok);
        assert!(
            !out.join("q").join("B.class").is_file(),
            "有错的 B 不该落盘"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 正文里不带 import 的全限定写法要能抽出来；注释、字符串里的不算。
    #[test]
    fn 抽出正文里的全限定类名链() {
        let src = r#"
package a.b;
import x.y.Z;
public class T {
    // nc.in.comment.Foo.bar()
    /* nc.in.block.Foo
       nc.in.block2.Foo */
    String s = "nc.in.string.Foo";
    char c = '.';
    void f(String code) {
        if (nc.vo.tmpub.util.StringUtil.isNull(code)) { this.x.y = 1; }
        Map<String, nc.vo.pub.BusinessException> m = null;
    }
}
"#;
        let chains = extract_dotted_chains(src);
        assert!(chains.contains(&"nc.vo.tmpub.util.StringUtil.isNull".to_string()));
        assert!(chains.contains(&"nc.vo.pub.BusinessException".to_string()));
        assert!(
            chains.contains(&"this.x.y".to_string()),
            "变量链也会抽出，靠类索引过滤"
        );
        for bad in ["comment", "block", "block2", "string"] {
            assert!(
                !chains.iter().any(|c| c.contains(bad)),
                "注释/字符串里的 {bad} 不该被抽出：{chains:?}"
            );
        }
    }

    /// 抹注释不能改变行号，也不能越界（注释没收尾、字符串没收尾）。
    #[test]
    fn 抹注释保持行号且不越界() {
        let src = "a\n/* x\ny */\nb \"s\nc // t\nd /* 未收尾";
        let out = blank_comments_and_strings(src);
        assert_eq!(out.matches('\n').count(), src.matches('\n').count());
        assert!(out.starts_with("a\n"));
        assert!(!out.contains('x') && !out.contains("未收尾"));
    }

    /// classpath 的连接符必须跟 JVM 走：Windows 是 `;`，macOS / Linux 是 `:`。
    ///
    /// 这条在 Windows 上恒绿（两边都是 `;`），真正的守卫点是在 macOS CI 上跑：
    /// 实现若写死 `;`，mac 上会把整串当成一个不存在的路径，报「找不到主类」。
    #[test]
    fn args_file_joins_classpath_with_platform_separator() {
        let dir = crate::test_support::tmp("cp-sep");
        let classes = dir.join("classes");
        let jar = dir.join("lib.jar");
        let out = dir.join("out");
        let args = dir.join("args.txt");
        write_args(
            &args,
            std::slice::from_ref(&classes),
            std::slice::from_ref(&jar),
            &out,
            &[],
        )
        .unwrap();
        let text = std::fs::read_to_string(&args).expect("args 文件应写出");
        let fwd = |p: &Path| p.to_string_lossy().replace('\\', "/");
        let expect = format!(
            "{}{}{}",
            fwd(&classes),
            crate::java_bridge::CLASSPATH_SEP,
            fwd(&jar)
        );
        assert!(
            text.contains(&expect),
            "-cp 必须用平台分隔符连接（期望包含 {expect}）：\n{text}"
        );
    }

    #[test]
    fn imports_cover_plain_static_wildcard_and_skip_noise() {
        let src = "package a;\nimport nc.vo.pub.BusinessException;\n  import static nc.Util.CONST;\nimport nc.itf.gl.*;\n// import not.Real;\nString s = \"x\";\nimport broken\n";
        let got = extract_imports(src);
        assert_eq!(
            got,
            vec![
                ("nc.vo.pub.BusinessException".to_string(), false),
                ("nc.Util.CONST".to_string(), false),
                ("nc.itf.gl".to_string(), true),
            ]
        );
    }

    #[test]
    fn declared_supertypes_resolve_via_import_or_same_package() {
        let src = "package a.b;
import x.y.Base;
public class Foo<T> extends Base implements Same, java.io.Serializable {
}";
        assert_eq!(
            declared_supertypes(src, "Foo"),
            vec!["x.y.Base", "a.b.Same", "java.io.Serializable"]
        );
        assert!(declared_supertypes("class A {}", "B").is_empty());
    }

    #[test]
    fn class_supers_reads_real_jar_when_available() {
        // 依赖本机 NC home；不存在就跳过，不让单测依赖环境
        let jar = Path::new("D:/ncc/1909home/modules/gl/lib/pubgl_openapi.jar");
        if !jar.is_file() {
            return;
        }
        let supers = class_supers(jar, "nc.api.gl.resource.BaseGLRestResource");
        assert_eq!(
            supers,
            vec!["nccloud.ws.rest.resource.AbstractNCCRestResource".to_string()]
        );
    }

    #[test]
    fn package_declaration_is_extracted() {
        assert_eq!(
            extract_package(
                "/* 头 */
package nccloud.baseapp.login.impl;
import a.B;"
            )
            .as_deref(),
            Some("nccloud.baseapp.login.impl")
        );
        assert_eq!(extract_package("class A {}"), None);
    }

    #[test]
    fn parses_ecj_error_blocks() {
        let out = "1. ERROR in C:/w/A.java (at line 12)\n\tIVoucherQuery srv = x;\n\t^^^^^^^^^^^^^\nIVoucherQuery cannot be resolved to a type\n----------\n2. WARNING in C:/w/B.java (at line 3)\n\tint a;\n\t    ^\nThe value of the local variable a is not used\nsecond line\n----------\n2 problems (1 error, 1 warning)\n";
        let p = parse_problems(out);
        assert_eq!(p.len(), 2);
        assert_eq!(
            (p[0].severity.as_str(), p[0].file.as_str(), p[0].line),
            ("error", "C:/w/A.java", 12)
        );
        assert_eq!(p[0].message, "IVoucherQuery cannot be resolved to a type");
        assert_eq!(p[1].severity, "warning");
        assert_eq!(
            p[1].message,
            "The value of the local variable a is not used second line"
        );
    }

    #[test]
    fn file_names_with_dots_and_spaces_parse() {
        let out = "1. ERROR in D:/my proj/a.b/C.java (at line 7)\n\tx\n\t^\nboom\n----------\n";
        let p = parse_problems(out);
        assert_eq!(p[0].file, "D:/my proj/a.b/C.java");
        assert_eq!(p[0].line, 7);
    }

    #[test]
    fn module_of_takes_first_directory_under_root() {
        let root = Path::new("C:/work/aier/newar");
        assert_eq!(
            module_of(root, Path::new("C:/work/aier/newar/gl/src/private/A.java")).as_deref(),
            Some("gl")
        );
        assert_eq!(module_of(root, Path::new("C:/other/A.java")), None);
        // 大小写、分隔符不一致也要认出来（反斜杠用 char::from(92) 拼，避免转义出错）
        let bs = char::from(92).to_string();
        let mixed = format!("c:{bs}Work{bs}AIER/newar{bs}aim{bs}src{bs}A.java");
        assert_eq!(
            module_of(Path::new("C:/work/aier/newar"), Path::new(&mixed)).as_deref(),
            Some("aim")
        );
    }

    /// 真机快照：**单文件编译**这条新路径到底能不能编过、要多久。
    ///
    /// 保存后自动编译全靠它，所以这里验三件事而不是只看「没报错」：
    /// 1. 只编一个文件也能编过（class 路径靠 `project_class_dirs` 解析，不靠整模块源码）；
    /// 2. 产出的 class 落在指定目录（测试里指向临时目录，绝不写用户的 `<模块>/classes`）；
    /// 3. 耗时在「保存后等得起」的量级。
    ///
    /// 运行：`node scripts/rust-gate.mjs test --lib -- --ignored single_file_compile_live --nocapture`
    #[test]
    #[ignore]
    fn single_file_compile_live() {
        use std::sync::atomic::AtomicBool;
        let root = Path::new(r"C:\work\aier\newar");
        let home = Path::new(r"D:\ncc\1909home");
        let java = home.join("ufjdk").join("bin").join("java.exe");
        let ecj = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("ecj")
            .join("ecj-3.17.jar");
        let file = root
            .join("gl")
            .join("src")
            .join("private")
            .join("nc")
            .join("bs")
            .join("gl")
            .join("busirecon")
            .join("BusiReconBO.java");
        if !file.is_file() || !java.is_file() || !ecj.is_file() {
            return;
        }
        // 有桥 jar 就走常驻 worker（正是打包版的行为）；没有则自动退回一次一进程
        let bridge = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("ecj-bridge")
            .join(crate::ecj_worker::BRIDGE_JAR);

        // 首次清冷要扫 7000 个 jar；这里不落缓存文件，避免测试污染用户配置目录
        let index = crate::nc_index::ClassIndex::load_or_build(
            crate::nc_index::classpath_jars(home),
            None,
            None,
        );
        let work = std::env::temp_dir().join("ncf-single-file-live");
        std::fs::create_dir_all(&work).unwrap();
        let out = work.join("out");
        let cancel = AtomicBool::new(false);
        let env = CompileEnv {
            nc_home: home,
            java_exe: &java,
            ecj_jar: &ecj,
            worker_jar: bridge.exists().then_some(bridge.as_path()),
            project_root: root,
            index: &index,
            work_dir: &work,
            cancel: Some(&cancel),
            overrides: &[],
        };
        let job = CompileJob {
            out_dir: out.clone(),
            module: "gl".to_string(),
            files: Some(vec![file]),
            source_roots: None,
            output_map: Vec::new(),
            seed_jars: Vec::new(),
            fast: true,
        };
        let started = Instant::now();
        let r = compile(&env, &job, &|s| println!("{s}")).unwrap();
        let ms = started.elapsed().as_millis();
        // 第二次：worker 已预热，这才是保存后自动编译的稳态成本
        let again = Instant::now();
        let r2 = compile(&env, &job, &|_| {}).unwrap();
        let warm = again.elapsed().as_millis();
        // 对照：同一条命令退回一次一进程（老行为）
        let oneshot_env = CompileEnv {
            worker_jar: None,
            ..env
        };
        let oneshot_at = Instant::now();
        let r3 = compile(&oneshot_env, &job, &|_| {}).unwrap();
        let oneshot = oneshot_at.elapsed().as_millis();
        println!(
            "单文件编译：首次 {ms} ms · 预热 {warm} ms · 一次一进程 {oneshot} ms · {} 个 jar · {} 轮 · {} 错误",
            r.jar_count, r.rounds, r.error_count
        );
        crate::ecj_worker::shutdown_all();
        assert_eq!(r.source_count, 1);
        assert_eq!(r.error_count, 0, "问题：{:?}", r.problems);
        assert_eq!(r2.error_count, 0, "第二次编译出错：{:?}", r2.problems);
        assert_eq!(r3.error_count, 0, "一次一进程出错：{:?}", r3.problems);
        assert!(
            out.join("nc")
                .join("bs")
                .join("gl")
                .join("busirecon")
                .join("BusiReconBO.class")
                .is_file(),
            "产物没落到 out_dir"
        );
    }

    /// 差分门禁（真机、`#[ignore]`）：**增量编出来的 class 必须与全量编出来的一致**。
    ///
    /// 两个阶段对应保存后的两条路径：
    /// 1. 只改方法体 → 只编改动文件；
    /// 2. 改字段类型 → 编改动文件 + 引用它的其它模块源文件（签名传播）。
    ///
    /// 对照组是「同一份最终源码从空产物目录全量编一遍」，逐字节比较全部 class。
    ///
    /// 合成工作区只引用自己的类，不依赖 NC home；用的是仓库自带的 ecj。
    /// 运行：`node scripts/rust-gate.mjs test --lib -- --ignored incremental_matches_full_live --nocapture`
    #[test]
    #[ignore]
    fn incremental_matches_full_live() {
        use std::collections::BTreeMap;
        use std::sync::atomic::AtomicBool;

        fn write_src(p: &Path, s: &str) {
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, s).unwrap();
        }

        /// 收集目录下全部 class：`前缀/相对路径` → 字节。
        fn snapshot(dir: &Path, prefix: &str, out: &mut BTreeMap<String, Vec<u8>>) {
            fn walk(cur: &Path, base: &Path, prefix: &str, out: &mut BTreeMap<String, Vec<u8>>) {
                let Ok(rd) = std::fs::read_dir(cur) else {
                    return;
                };
                for e in rd.flatten() {
                    let p = e.path();
                    if p.is_dir() {
                        walk(&p, base, prefix, out);
                    } else if p.extension().is_some_and(|x| x == "class") {
                        let rel = p
                            .strip_prefix(base)
                            .unwrap()
                            .to_string_lossy()
                            .replace('\\', "/");
                        out.insert(format!("{prefix}/{rel}"), std::fs::read(&p).unwrap());
                    }
                }
            }
            walk(dir, dir, prefix, out);
        }

        fn compile_into(
            env: &CompileEnv,
            module: &str,
            files: Vec<PathBuf>,
            out: &Path,
            fast: bool,
        ) {
            let job = CompileJob {
                module: module.to_string(),
                files: Some(files),
                out_dir: out.to_path_buf(),
                source_roots: None,
                output_map: Vec::new(),
                seed_jars: Vec::new(),
                fast,
            };
            let r = compile(env, &job, &|_| {}).unwrap();
            assert_eq!(r.error_count, 0, "{module} 编译错误：{:?}", r.problems);
        }

        let java = Path::new(r"D:\ncc\1909home")
            .join("ufjdk")
            .join("bin")
            .join("java.exe");
        let ecj = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("ecj")
            .join("ecj-3.17.jar");
        if !java.is_file() || !ecj.is_file() {
            return;
        }

        let base = std::env::temp_dir().join(format!("ncwb-diff-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        // 每个工作区单独一层父目录：类路径启发式会看「兄弟目录/模块/classes」，
        // 不能让两个对照工作区互相看见对方的产物
        let inc = base.join("inc").join("ws");
        let st1 = base.join("stage1").join("ws");
        let st2 = base.join("stage2").join("ws");
        let work = base.join("work");
        std::fs::create_dir_all(&work).unwrap();

        let a_src = |root: &Path| {
            root.join("a")
                .join("src")
                .join("public")
                .join("p")
                .join("A.java")
        };
        let b_src = |root: &Path| {
            root.join("b")
                .join("src")
                .join("public")
                .join("q")
                .join("B.java")
        };

        // 初始源码：B 读 A 的 int 字段（int → long 会改字节码里的字段描述符）
        let a_v1 = "package p;\npublic class A {\n    public int x = 1;\n    public int f(int v) { return v + x; }\n}\n";
        // 阶段 1：只改方法体，ABI 不变
        let a_v2 = "package p;\npublic class A {\n    public int x = 1;\n    public int f(int v) { return v * x; }\n}\n";
        // 阶段 2：改字段类型，ABI 变了但 B 的源码不用改（int → long 扩大转换）
        let a_v3 = "package p;\npublic class A {\n    public long x = 1;\n    public int f(int v) { return v * (int) x; }\n}\n";
        let b_java = "package q;\nimport p.A;\npublic class B {\n    public long g(A a) { return a.x; }\n}\n";

        for root in [inc.as_path(), st1.as_path(), st2.as_path()] {
            let a = if root == st2.as_path() { a_v3 } else { a_v1 };
            write_src(&a_src(root), a);
            write_src(&b_src(root), b_java);
        }
        write_src(&a_src(&st1), a_v2);

        let index = crate::nc_index::ClassIndex::build(Vec::new());
        let cancel = AtomicBool::new(false);
        let home = base.join("nchome");
        fn make_env<'a>(
            root: &'a Path,
            home: &'a Path,
            java: &'a Path,
            ecj: &'a Path,
            index: &'a crate::nc_index::ClassIndex,
            work: &'a Path,
            cancel: &'a AtomicBool,
        ) -> CompileEnv<'a> {
            CompileEnv {
                nc_home: home,
                java_exe: java,
                ecj_jar: ecj,
                worker_jar: None,
                project_root: root,
                index,
                work_dir: work,
                cancel: Some(cancel),
                overrides: &[],
            }
        }
        // 只测编译器行为是否等价，不走常驻 bridge：两条路径产物应当一致，
        // worker 本身另有 `single_file_compile_live` 覆盖
        let a_out = |root: &Path| root.join("a").join("classes");
        let b_out = |root: &Path| root.join("b").join("classes");
        let all_sources = |root: &Path, module: &str| {
            crate::build_layout::ModuleLayout::resolve(root, module).collect_sources()
        };

        // 对照组：每个阶段从空产物目录全量编一遍
        let full_state = |root: &Path| {
            let env = make_env(root, &home, &java, &ecj, &index, &work, &cancel);
            for module in ["a", "b"] {
                let out = root.join(module).join("classes");
                compile_into(&env, module, all_sources(root, module), &out, false);
            }
            let mut snap = BTreeMap::new();
            snapshot(&a_out(root), "a", &mut snap);
            snapshot(&b_out(root), "b", &mut snap);
            snap
        };

        // 增量组：先按初始源码全量编一遍，再模拟保存后的增量编译
        let env = make_env(&inc, &home, &java, &ecj, &index, &work, &cancel);
        for module in ["a", "b"] {
            let out = inc.join(module).join("classes");
            compile_into(&env, module, all_sources(&inc, module), &out, true);
        }

        // 阶段 1：只编改动的 A.java（保存路径 compile_file）
        write_src(&a_src(&inc), a_v2);
        compile_into(&env, "a", vec![a_src(&inc)], &a_out(&inc), true);
        let mut got = BTreeMap::new();
        snapshot(&a_out(&inc), "a", &mut got);
        snapshot(&b_out(&inc), "b", &mut got);
        let want = full_state(&st1);
        assert_eq!(got, want, "阶段 1（只改方法体）：增量产物与全量不一致");

        // 阶段 2：先编 A.java，再按引用关系补编 B（签名传播）
        write_src(&a_src(&inc), a_v3);
        compile_into(&env, "a", vec![a_src(&inc)], &a_out(&inc), true);
        let b_all = all_sources(&inc, "b");
        let refs =
            crate::build_state::referrers(&[a_src(&inc)], &b_all).expect("A 的类型声明应当能解析");
        assert!(
            refs.iter().any(|p| p.ends_with("B.java")),
            "反向依赖没找到 B.java：{refs:?}"
        );
        compile_into(&env, "b", refs, &b_out(&inc), true);
        let mut got = BTreeMap::new();
        snapshot(&a_out(&inc), "a", &mut got);
        snapshot(&b_out(&inc), "b", &mut got);
        let want = full_state(&st2);
        assert_eq!(got, want, "阶段 2（签名变化 + 传播）：增量产物与全量不一致");
        crate::ecj_worker::shutdown_all();
        let _ = std::fs::remove_dir_all(&base);
    }
}
