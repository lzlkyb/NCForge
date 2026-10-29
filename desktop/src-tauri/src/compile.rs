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
    /// 本次最终用到的 jar 序号（调用方缓存后下次作为 seed，省掉分轮补 jar）。
    #[serde(skip)]
    pub resolved_jars: Vec<u32>,
}

pub struct CompileEnv<'a> {
    pub nc_home: &'a Path,
    pub java_exe: &'a Path,
    pub ecj_jar: &'a Path,
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
    /// 产物目录（正式使用时是 `<模块>/classes`，和 Eclipse 一致）。
    pub out_dir: PathBuf,
    /// 上次编译用到的 jar，省掉分轮补 jar 的时间。
    pub seed_jars: Vec<u32>,
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
    for line in text.lines() {
        let Some(rest) = line.trim_start().strip_prefix("import ") else {
            continue;
        };
        let rest = rest.trim_start();
        let rest = rest
            .strip_prefix("static ")
            .map(str::trim_start)
            .unwrap_or(rest);
        let Some(end) = rest.find(';') else { continue };
        let name = rest[..end].trim();
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

fn run_ecj(env: &CompileEnv, args: &Path) -> Result<(bool, String), String> {
    let mut cmd = Command::new(env.java_exe);
    // ecj 的输出与参数文件都按 UTF-8，避免依赖系统默认编码（中文 Windows 是 GBK）
    cmd.args(["-Dfile.encoding=UTF-8", "-Xmx1024m", "-cp"])
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
    // JAR 清单里常见的噪声行
    let text = text
        .lines()
        .filter(|l| !l.contains("invalid Class-Path header"))
        .collect::<Vec<_>>()
        .join("\n");
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
pub fn compile(
    env: &CompileEnv,
    job: &CompileJob,
    log: &dyn Fn(&str),
) -> Result<CompileResult, String> {
    let started = Instant::now();
    let module_dir = env.project_root.join(&job.module);
    let files = match &job.files {
        Some(f) => f.clone(),
        None => collect_sources(&module_dir),
    };
    if files.is_empty() {
        return Err(format!(
            "模块 {} 下没有找到 .java 源文件（查找目录：{}）",
            job.module,
            SRC_DIRS.join("、")
        ));
    }
    std::fs::create_dir_all(&job.out_dir).map_err(|e| format!("无法创建输出目录: {e}"))?;
    std::fs::create_dir_all(env.work_dir).map_err(|e| format!("无法创建工作目录: {e}"))?;

    // 读源码：定编码 + 提取 import
    let mut jars: BTreeSet<u32> = job.seed_jars.iter().copied().collect();
    let mut sources: Vec<(PathBuf, TextEncoding)> = Vec::with_capacity(files.len());
    for f in &files {
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
        job.module,
        sources.len(),
        jars.len()
    ));

    // 跨模块依赖：工程内各模块已编译的 classes、out/<模块>、同工作区其他分组，
    // 再加 NC home 各模块的 classes。规则与启动服务共用（launch::project_class_dirs），
    // 否则会出现「编译过了、启动服务时加载的还是 jar 里的旧类」。
    let class_dirs = crate::launch::project_class_dirs(env.project_root, env.nc_home);

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
        write_args(&args_path, &class_dirs, &jar_paths, &job.out_dir, &sources)
            .map_err(|e| format!("写参数文件失败: {e}"))?;
        log(&format!("第 {rounds} 轮编译（{} 个 jar）…", jars.len()));
        (ok, output) = run_ecj(env, &args_path)?;
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
    Ok(CompileResult {
        ok: ok && error_count == 0,
        duration_ms: started.elapsed().as_millis() as u64,
        source_count: sources.len(),
        error_count,
        warning_count,
        problems,
        jar_count: jars.len(),
        rounds,
        out_dir: job.out_dir.to_string_lossy().into_owned(),
        resolved_jars: jars.into_iter().collect(),
    })
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
}
