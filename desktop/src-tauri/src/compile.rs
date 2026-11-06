//! 用 ecj 编译 NC 模块。
//!
//! 做法全部来自 M0 实测（细节见方案文档附 C）：
//! - ecj 用 Eclipse 4.11 自带的 jdt.core 3.17，参数 `-1.8 -g -nowarn -proc:none -preserveAllLocals`，
//!   缺 `-preserveAllLocals` 会和 Eclipse 产物差几十字节；
//! - 不能把 7000+ 个 jar 全放 classpath（数分钟跑不出结果），按源码 import 反查类索引挑 jar，
//!   编译报「类找不到」时再按报错分轮补 jar；
//! - jar 顺序要按 Eclipse 的 classpath 顺序（nc_index 保证），同名类先出现的优先；
//! - 不要给 `-sourcepath` 放其它模块源码（连带编译会滚雪球式报错）；
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
    jars.len() - before
}

/// 读 class 文件头，返回直接父类与实现接口的全限定名（只解析常量池，不看字段方法）。
fn class_supers(jar: &Path, fqcn: &str) -> Vec<String> {
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
        for (name, wildcard) in extract_imports(&text) {
            add_import(index, &mut jars, &name, wildcard);
        }
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
        if let Some((ok, output)) = crate::ecj_worker::compile(
            env.java_exe,
            env.ecj_jar,
            jar,
            args,
            TIMEOUT,
            env.cancel,
        )? {
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
    s.push_str(&format!("-cp \"{}\"\n", cp.join(";")));
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
    let files = match &job.files {
        Some(f) => f.clone(),
        None => match &job.source_roots {
            Some(roots) => collect_sources_in(roots),
            None => collect_sources(&module_dir),
        },
    };
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
            &job.module,
            &files,
            &out,
            &job.seed_jars,
            job.fast,
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

/// 编译一组写到同一个目录的文件。
fn compile_group(
    env: &CompileEnv,
    module: &str,
    files: &[PathBuf],
    out_dir: &Path,
    seed_jars: &[u32],
    fast: bool,
    log: &dyn Fn(&str),
) -> Result<CompileResult, String> {
    let started = Instant::now();
    std::fs::create_dir_all(out_dir).map_err(|e| format!("无法创建输出目录: {e}"))?;
    std::fs::create_dir_all(env.work_dir).map_err(|e| format!("无法创建工作目录: {e}"))?;

    // 读源码：定编码 + 提取 import
    let mut jars: BTreeSet<u32> = seed_jars.iter().copied().collect();
    let mut sources: Vec<(PathBuf, TextEncoding)> = Vec::with_capacity(files.len());
    for f in files {
        let bytes = std::fs::read(f).map_err(|e| format!("读取 {} 失败: {e}", f.display()))?;
        let text = decode_lossy(&bytes);
        if let Some(pkg) = extract_package(&text) {
            add_import(env.index, &mut jars, &pkg, true);
        }
        for (name, wildcard) in extract_imports(&text) {
            add_import(env.index, &mut jars, &name, wildcard);
        }
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

    let problems = parse_problems(&output);
    let error_count = problems.iter().filter(|p| p.severity == "error").count();
    let warning_count = problems.len() - error_count;
    // ecj 退出码非 0 但一条报错都没解析出来：把原始输出带回去，不要假装成功
    if !ok && error_count == 0 {
        return Err(format!(
            "ecj 异常退出：{}",
            output.lines().take(8).collect::<Vec<_>>().join(" | ")
        ));
    }
    // D4：失败归因（有源码没产物 / 工程被停用 / 产物比源码旧）。
    // **只按类判断**，不扫整棵树——全量新旧检测要 8 秒，见 compile_diag::stale_diagnostics。
    // 依赖链在这里解析一次 `.classpath`（毫秒级）：顺序口径与 class_dirs 共用 `flat_dirs`。
    let diagnostics = if ok && error_count == 0 {
        Vec::new()
    } else {
        let graph = crate::eclipse_cp::graph(env.project_root, env.nc_home, env.overrides);
        crate::compile_diag::uncompiled_diagnostics(&graph.projects, &problems)
    };
    for d in &diagnostics {
        log(&format!("诊断：{}", d.message));
    }
    Ok(CompileResult {
        ok: ok && error_count == 0,
        duration_ms: started.elapsed().as_millis() as u64,
        source_count: sources.len(),
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
                let Ok(rd) = std::fs::read_dir(cur) else { return };
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

        let java = Path::new(r"D:\ncc\1909home").join("ufjdk").join("bin").join("java.exe");
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

        let a_src = |root: &Path| root.join("a").join("src").join("public").join("p").join("A.java");
        let b_src = |root: &Path| root.join("b").join("src").join("public").join("q").join("B.java");

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
        assert_eq!(
            got, want,
            "阶段 1（只改方法体）：增量产物与全量不一致"
        );

        // 阶段 2：先编 A.java，再按引用关系补编 B（签名传播）
        write_src(&a_src(&inc), a_v3);
        compile_into(&env, "a", vec![a_src(&inc)], &a_out(&inc), true);
        let b_all = all_sources(&inc, "b");
        let refs = crate::build_state::referrers(&[a_src(&inc)], &b_all)
            .expect("A 的类型声明应当能解析");
        assert!(
            refs.iter().any(|p| p.ends_with("B.java")),
            "反向依赖没找到 B.java：{refs:?}"
        );
        compile_into(&env, "b", refs, &b_out(&inc), true);
        let mut got = BTreeMap::new();
        snapshot(&a_out(&inc), "a", &mut got);
        snapshot(&b_out(&inc), "b", &mut got);
        let want = full_state(&st2);
        assert_eq!(
            got, want,
            "阶段 2（签名变化 + 传播）：增量产物与全量不一致"
        );
        crate::ecj_worker::shutdown_all();
        let _ = std::fs::remove_dir_all(&base);
    }
}
