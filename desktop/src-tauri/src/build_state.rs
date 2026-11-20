//! 构建账本：上次编了什么、这次该编什么、清理能删什么。
//!
//! 这里是纯逻辑（不依赖 tauri），命令层只负责拿锁、取路径、推事件。三条纪律：
//!
//! 1. **清单是优化，不是正确性前提**。读不出来、版本不对、布局变了，一律当「没有清单」
//!    走全量，最多多编一次，不能因为账本坏了编错或删错。
//! 2. **清理只删声明过的产物**。有清单按清单；没清单只删能映射回源码的 `.class`，
//!    映射不上的列出来给用户看，不删。输出根目录、源码、`.classpath`、NC home 永不碰。
//! 3. **增量宁可多编**。class 结构指纹 + 反向依赖都是近似：结构变了就把引用方带上，
//!    看不出来就全量；绝不靠时间戳猜依赖。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::build_layout::{self, ModuleLayout};
use crate::eclipse_cp::LinkedOverride;
use crate::workspace::decode_lossy;

/// 清单格式版本。字段或语义变化时 +1，旧清单自动作废。
/// 2：源码 ABI 指纹退役，改 class 结构指纹（桥 struct）+ 内容哈希 + 类型名 + 外部引用聚合。
pub const SCHEMA: u32 = 2;
const MAGIC: &[u8] = b"NCBS1\n";
const HISTORY_MAX: usize = 50;
/// jar 修改时间检查的进程内缓存时长：每次编译都 stat 7000 个 jar 太贵，
/// 但换 jar 后最多等这么久就能被发现（急着生效点「重建类索引」）。
const JAR_STAMP_TTL: Duration = Duration::from_secs(20);

/// 一个源文件在清单里的样子。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceStamp {
    /// 相对模块根的源码根（`src/public`），工作区搬家后仍能解读
    pub root: String,
    /// 相对源码根的路径（`/` 分隔）
    pub rel: String,
    /// 相对模块根的产物目录（`classes` / `bin` / `out/uapbd`）
    pub out: String,
    pub size: u64,
    pub mtime_ms: u64,
    pub package: String,
    /// 内容 SHA-256；空串 = 未算，按「可能变了」处理。
    /// stat 命中但内容没变（SVN 更新 / 外部工具 touch）时靠它免编。
    #[serde(default)]
    pub hash: String,
    /// class 结构指纹（桥 struct 命令，投影面对齐 Eclipse hasStructuralChanges）；
    /// `None` = 未知，按「结构可能变了」处理。取代旧源码级 ABI 指纹。
    #[serde(default)]
    pub struct_fp: Option<String>,
    /// 单文件编译写过 class 但没做结构判定（见 `build_engine::compile_files`）。
    /// 下次增量必须把该文件再走一轮编译补判定，否则签名变更永远传播不到引用方。
    #[serde(default)]
    pub struct_pending: bool,
    /// 本文件声明的类型简单名（删除后找引用方用，不必再读源码）
    #[serde(default)]
    pub types: Vec<String>,
    /// 本文件的外部引用（模块依赖图派生用，见 `module_graph`）
    #[serde(default)]
    pub ext: ExtRefs,
    /// 该源文件产出的 class（相对产物目录，含 `Outer$Inner.class`）
    #[serde(default)]
    pub classes: Vec<String>,
}

/// 一个模块的外部引用聚合（清单级 = 各源文件 ext 的并集）。
/// 模块依赖图靠它 join 工作区类型索引派生：NC 单根 `.classpath` 没有显式模块依赖，
/// 这是 make 编排 / 下游失效 / 真实分层的唯一边来源。全部小写、排序、去重。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExtRefs {
    /// 显式 import 的 FQCN
    pub fq: Vec<String>,
    /// 通配 import 的包
    pub wild: Vec<String>,
    /// 本模块源码出现过的包（同包跨模块边用）
    pub packages: Vec<String>,
    /// 正文出现的大写开头标识符（同包 / 通配边的候选简单名，宁可多连）
    pub simple: Vec<String>,
}

impl ExtRefs {
    /// 并集（增量时旧聚合 ∪ 新文件：陈旧边只会多编，不会漏编；全量时精确重算）。
    pub fn merge(&mut self, other: &ExtRefs) {
        self.fq.extend(other.fq.iter().cloned());
        self.wild.extend(other.wild.iter().cloned());
        self.packages.extend(other.packages.iter().cloned());
        self.simple.extend(other.simple.iter().cloned());
        for v in [
            &mut self.fq,
            &mut self.wild,
            &mut self.packages,
            &mut self.simple,
        ] {
            v.sort();
            v.dedup();
        }
    }
}

/// 被删除的源文件：源码已不在，引用方只能靠旧清单里的包名 + 类型名找。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemovedSource {
    pub path: PathBuf,
    pub package: String,
    pub types: Vec<String>,
}

impl SourceStamp {
    pub(crate) fn key(&self) -> String {
        format!(
            "{}\u{0}{}",
            self.root.to_ascii_lowercase(),
            self.rel.to_ascii_lowercase()
        )
    }
}

/// 一次模块构建的清单。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub schema: u32,
    pub workspace: String,
    pub module: String,
    pub source_roots: Vec<String>,
    pub outputs: Vec<String>,
    pub sources: Vec<SourceStamp>,
    /// 模块外部引用聚合（派生模块依赖图用）
    #[serde(default)]
    pub ext: ExtRefs,
    /// 有序 jar 集合 + NC home + 覆盖表 + 依赖工程 `.classpath` 的指纹
    pub classpath_fp: String,
    /// ecj / java / 编译参数的指纹
    pub compiler_fp: String,
    #[serde(default)]
    pub seed_jars: Vec<u32>,
    pub last_success_ms: u64,
    #[serde(default)]
    pub last_attempt: Option<LastAttempt>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LastAttempt {
    pub ok: bool,
    pub error_count: usize,
    pub warning_count: usize,
    pub duration_ms: u64,
    pub at_ms: u64,
    pub reason: String,
}

impl Manifest {
    pub fn sources_by_key(&self) -> HashMap<String, &SourceStamp> {
        self.sources.iter().map(|s| (s.key(), s)).collect()
    }
}

/// 增量决策。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// 输入指纹与源文件都没变，整模块不用编
    Skip,
    /// 必须全量（首次、配置变化、布局变化）
    Full { reason: String },
    /// 第一轮只编这些文件（内容变化 + 新增）。引用方由**编译后**的 class 结构 diff
    /// 决定（Eclipse 队列模型），删除文件的引用方靠旧清单类型名找——都在
    /// `build_engine::build_one` 里做，决策阶段不猜签名。
    Incremental {
        files: Vec<PathBuf>,
        reason: String,
        /// 真正被改动 / 新增的文件（跨模块传播只看这个）
        changed: Vec<PathBuf>,
        removed: Vec<RemovedSource>,
    },
}

// ───────────────────────────── 持久化 ─────────────────────────────

/// 工作区键：规范路径的哈希。切换工程不互相覆盖。
pub fn workspace_key(root: &Path) -> String {
    let s = build_layout::slash(root).to_ascii_lowercase();
    sha(&[s.as_bytes()])[..16].to_string()
}

pub fn build_dir(config_dir: &Path, root: &Path) -> PathBuf {
    config_dir.join("build").join(workspace_key(root))
}

/// 模块名进文件名：保留可读前缀，再加短哈希防重名。
fn safe_module_name(module: &str) -> String {
    let cleaned: String = module
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!(
        "{}-{}",
        cleaned,
        &sha(&[module.to_ascii_lowercase().as_bytes()])[..8]
    )
}

pub fn manifest_path(config_dir: &Path, root: &Path, module: &str) -> PathBuf {
    build_dir(config_dir, root).join(format!("{}.bin", safe_module_name(module)))
}

/// 读清单。magic / 版本 / 工作区 / 模块任一不符都返回 `None`（调用方走全量）。
pub fn read_manifest(path: &Path, root: &Path, module: &str) -> Option<Manifest> {
    let bytes = std::fs::read(path).ok()?;
    let body = bytes.strip_prefix(MAGIC)?;
    let m: Manifest = serde_json::from_slice(body).ok()?;
    if m.schema != SCHEMA {
        return None;
    }
    if !path_eq(&m.workspace, &build_layout::slash(root)) || !m.module.eq_ignore_ascii_case(module)
    {
        return None;
    }
    Some(m)
}

/// 原子写清单。先写临时文件再 rename，半截文件不会被下次启动读到。
pub fn write_manifest(path: &Path, m: &Manifest) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建构建目录失败: {e}"))?;
    }
    let mut body = Vec::with_capacity(4096);
    body.extend_from_slice(MAGIC);
    serde_json::to_writer(&mut body, m).map_err(|e| format!("序列化构建清单失败: {e}"))?;
    crate::atomic_file::write_atomic(path, &body)
}

pub fn delete_manifest(path: &Path) -> bool {
    std::fs::remove_file(path).is_ok()
}

/// 清某工作区的全部清单，返回删掉的个数。
pub fn clear_manifests(dir: &Path) -> usize {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut n = 0;
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().is_some_and(|x| x.eq_ignore_ascii_case("bin"))
            && std::fs::remove_file(&p).is_ok()
        {
            n += 1;
        }
    }
    n
}

/// 列出某工作区里所有可读清单。
pub fn list_manifests(dir: &Path) -> Vec<Manifest> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for e in rd.flatten() {
        let p = e.path();
        if !p.extension().is_some_and(|x| x.eq_ignore_ascii_case("bin")) {
            continue;
        }
        let Ok(bytes) = std::fs::read(&p) else {
            continue;
        };
        let Some(body) = bytes.strip_prefix(MAGIC) else {
            continue;
        };
        if let Ok(m) = serde_json::from_slice::<Manifest>(body) {
            if m.schema == SCHEMA {
                out.push(m);
            }
        }
    }
    out.sort_by(|a, b| a.module.cmp(&b.module));
    out
}

// ───────────────────────────── 指纹 ─────────────────────────────

struct JarStampCache {
    home: PathBuf,
    at: Instant,
    /// 格式化好的 jar 指纹字节（`path|len|ms`），跨模块共享：config_fingerprints 每模块
    /// 都拼这 12738 条，重复 format+clone 是纯浪费。Arc 共享、借用拼 refs，指纹值不变。
    blob: Arc<Vec<Vec<u8>>>,
}

static JAR_STAMPS: Mutex<Option<Arc<JarStampCache>>> = Mutex::new(None);

/// 确保 jar _stamp 缓存新鲜（TTL 内复用），返回 Arc 供 stamps/blob 共享借用。
fn jar_cache(nc_home: &Path) -> Arc<JarStampCache> {
    let now = Instant::now();
    if let Ok(g) = JAR_STAMPS.lock() {
        if let Some(c) = g.as_ref() {
            if c.home == nc_home && now.duration_since(c.at) < JAR_STAMP_TTL {
                return c.clone();
            }
        }
    }
    let stamps: Vec<(String, u64, u64)> = crate::nc_index::classpath_jars(nc_home)
        .into_iter()
        .map(|p| {
            let (len, ms) = stat_of(&p);
            (build_layout::slash(&p).to_ascii_lowercase(), len, ms)
        })
        .collect();
    let blob: Vec<Vec<u8>> = stamps
        .iter()
        .map(|(p, len, ms)| format!("{p}|{len}|{ms}").into_bytes())
        .collect();
    let cache = Arc::new(JarStampCache {
        home: nc_home.to_path_buf(),
        at: now,
        blob: Arc::new(blob),
    });
    if let Ok(mut g) = JAR_STAMPS.lock() {
        *g = Some(cache.clone());
    }
    cache
}

/// 共享 jar 指纹字节（Arc）：config_fingerprints 借用拼 refs，免每模块重 format+clone。
fn jar_blob(nc_home: &Path) -> Arc<Vec<Vec<u8>>> {
    jar_cache(nc_home).blob.clone()
}

/// 换 NC home / 点「重建类索引」时让 jar 指纹缓存立刻失效。
pub fn invalidate_config_cache() {
    if let Ok(mut g) = JAR_STAMPS.lock() {
        *g = None;
    }
}

/// 编译输入指纹：类路径侧（NC home / jar / `.classpath` / 覆盖表）与编译器侧分开算，
/// 日志里能说清是哪一类变了。
pub fn config_fingerprints(
    layout: &ModuleLayout,
    root: &Path,
    nc_home: &Path,
    overrides: &[LinkedOverride],
    ecj: &Path,
    java: &Path,
) -> (String, String) {
    let cp: Vec<Vec<u8>> = vec![
        build_layout::slash(nc_home)
            .to_ascii_lowercase()
            .into_bytes(),
        build_layout::slash(&layout.module_dir)
            .to_ascii_lowercase()
            .into_bytes(),
        classpath_xml(&layout.module_dir),
        dependencies_blob(root, overrides),
        overrides_blob(overrides).into_bytes(),
    ];
    // jar 侧 12738 条跨模块相同：借用共享 blob，免每模块重 format+clone（指纹字节序不变）。
    let blob = jar_blob(nc_home);

    let (ecj_len, ecj_ms) = stat_of(ecj);
    let (java_len, java_ms) = stat_of(java);
    let compiler = format!(
        "ecj:{}|{}|{};java:{}|{}|{};args:{};encoding:per-file",
        build_layout::slash(ecj),
        ecj_len,
        ecj_ms,
        build_layout::slash(java),
        java_len,
        java_ms,
        "-1.8 -g -nowarn -proc:none -preserveAllLocals -Dfile.encoding=UTF-8"
    );
    let mut cp_refs: Vec<&[u8]> = cp.iter().map(|v| v.as_slice()).collect();
    cp_refs.extend(blob.iter().map(|v| v.as_slice()));
    (sha(&cp_refs), sha(&[compiler.as_bytes()]))
}

fn classpath_xml(project: &Path) -> Vec<u8> {
    let p = project.join(".classpath");
    let mut blob = build_layout::slash(&p).into_bytes();
    blob.push(0);
    blob.extend(std::fs::read(&p).unwrap_or_default());
    blob
}

/// 依赖闭包里每个工程 `.classpath` 的内容：改依赖关系也要让主模块全量。
fn dependencies_blob(root: &Path, overrides: &[LinkedOverride]) -> Vec<u8> {
    let mut out = Vec::new();
    for p in crate::eclipse_cp::projects(root, overrides) {
        let Some(proj_root) = p.root else { continue };
        out.extend(classpath_xml(Path::new(&proj_root)));
        out.push(0);
    }
    out
}

fn overrides_blob(overrides: &[LinkedOverride]) -> String {
    overrides
        .iter()
        .map(|o| {
            format!(
                "{}:{}:{}",
                o.action.as_str(),
                o.target,
                o.dir.as_deref().unwrap_or("")
            )
        })
        .collect::<Vec<_>>()
        .join("|")
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn stat_of(p: &Path) -> (u64, u64) {
    let Ok(md) = std::fs::metadata(p) else {
        return (0, 0);
    };
    let ms = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    (md.len(), ms)
}

fn sha(parts: &[&[u8]]) -> String {
    let mut h = Sha256::new();
    for p in parts {
        h.update((p.len() as u64).to_le_bytes());
        h.update(p);
    }
    format!("{:x}", h.finalize())
}

pub fn path_eq(a: &str, b: &str) -> bool {
    a.replace('\\', "/")
        .eq_ignore_ascii_case(&b.replace('\\', "/"))
}

// ───────────────────────────── 源码 / ABI ─────────────────────────────

/// 扫描模块当前的源码。`with_details=false` 只取 stat（快速判跳过）。
///
/// 大模块（≥128 文件）有界并行 stat/哈希（上限 4，开发机重负载蓝屏史，不按核数放开）；
/// 小模块串行免线程开销。分块按 `collect_sources` 的有序列表切，各块顺序处理再拼接，
/// 结果与串行逐字节一致（差分门禁可比）。
pub fn scan_sources(layout: &ModuleLayout, with_details: bool) -> Vec<(PathBuf, SourceStamp)> {
    let sources = layout.collect_sources();
    let threads = if sources.len() >= 128 { 4 } else { 1 };
    scan_with(layout, &sources, with_details, threads)
}

/// `scan_sources` 的可指定并发版（测试用 1 vs 4 验一致性）。`threads<=1` 走串行。
fn scan_with(
    layout: &ModuleLayout,
    sources: &[PathBuf],
    with_details: bool,
    threads: usize,
) -> Vec<(PathBuf, SourceStamp)> {
    let serial = |c: &[PathBuf]| -> Vec<(PathBuf, SourceStamp)> {
        c.iter()
            .filter_map(|p| source_stamp(layout, p, with_details).map(|s| (p.clone(), s)))
            .collect()
    };
    if threads <= 1 || sources.len() < 2 {
        return serial(sources);
    }
    let chunk = sources.len().div_ceil(threads);
    let chunks: Vec<&[PathBuf]> = sources.chunks(chunk).collect();
    std::thread::scope(|s| {
        let handles: Vec<_> = chunks.iter().map(|c| s.spawn(|| serial(c))).collect();
        let mut out = Vec::with_capacity(sources.len());
        for h in handles {
            out.extend(h.join().expect("scan 线程不该 panic"));
        }
        out
    })
}

pub fn source_stamp(layout: &ModuleLayout, path: &Path, with_details: bool) -> Option<SourceStamp> {
    let rel = layout.rel_source_of(path)?;
    let out = layout
        .output_for(path)
        .and_then(|o| layout.output_rel(&o))
        .unwrap_or_else(|| "classes".to_string());
    let src_root = layout
        .source_root_of(path)
        .and_then(|r| layout.rel_root(r))
        .unwrap_or_default();
    let (size, mtime_ms) = stat_of(path);
    let mut stamp = SourceStamp {
        root: src_root,
        rel,
        out,
        size,
        mtime_ms,
        package: String::new(),
        hash: String::new(),
        struct_fp: None,
        struct_pending: false,
        types: Vec::new(),
        ext: ExtRefs::default(),
        classes: Vec::new(),
    };
    if with_details {
        let bytes = std::fs::read(path).ok()?;
        stamp.hash = sha(&[&bytes]);
        let text = decode_lossy(&bytes);
        stamp.package = crate::compile::extract_package(&text).unwrap_or_default();
        let clean = strip_comments_and_literals(&text);
        let deps = parse_deps_clean(&clean);
        stamp.types = deps.types.clone();
        stamp.ext = ext_refs(&clean, &deps);
    }
    Some(stamp)
}

/// 大写开头标识符：同包 / 通配跨模块边的候选简单名。宁可多收（JDK 类名也进来），
/// join 类型索引时自然滤掉工作区没有的名字。
fn upper_words(clean: &str) -> Vec<String> {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        regex::Regex::new(r"\b[A-Z][A-Za-z0-9_$]*\b").expect("静态正则不会编译失败")
    });
    let mut out: Vec<String> = re
        .find_iter(clean)
        .map(|m| m.as_str().to_ascii_lowercase())
        .collect();
    out.sort();
    out.dedup();
    out
}

fn ext_refs(clean: &str, deps: &SourceDeps) -> ExtRefs {
    let mut fq = Vec::new();
    let mut wild = Vec::new();
    for (name, w) in &deps.imports {
        if *w {
            wild.push(name.to_ascii_lowercase());
        } else {
            fq.push(name.to_ascii_lowercase());
        }
    }
    fq.sort();
    fq.dedup();
    wild.sort();
    wild.dedup();
    let packages = if deps.package.is_empty() {
        Vec::new()
    } else {
        vec![deps.package.to_ascii_lowercase()]
    };
    ExtRefs {
        fq,
        wild,
        packages,
        simple: upper_words(clean),
    }
}

/// 去掉注释与字符串/字符字面量，保留换行（让声明之间的分隔还在）。
pub(crate) fn strip_comments_and_literals(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    let mut it = src.chars().peekable();
    while let Some(c) = it.next() {
        match c {
            '/' if it.peek() == Some(&'/') => {
                while let Some(&n) = it.peek() {
                    it.next();
                    if n == '\n' {
                        out.push('\n');
                        break;
                    }
                }
            }
            '/' if it.peek() == Some(&'*') => {
                it.next();
                let mut prev = '\0';
                for n in it.by_ref() {
                    if prev == '*' && n == '/' {
                        break;
                    }
                    prev = n;
                    if n == '\n' {
                        out.push('\n');
                    }
                }
                out.push(' ');
            }
            '"' | '\'' => {
                let quote = c;
                out.push(' ');
                while let Some(n) = it.next() {
                    if n == '\\' {
                        it.next();
                        continue;
                    }
                    if n == quote {
                        break;
                    }
                    if n == '\n' {
                        out.push('\n');
                    }
                }
            }
            _ => out.push(c),
        }
    }
    out
}

/// 一个源文件的依赖信息（反向依赖索引的输入）。
#[derive(Debug, Clone, Default)]
pub struct SourceDeps {
    pub package: String,
    pub imports: Vec<(String, bool)>,
    pub types: Vec<String>,
}

/// 已去掉注释/字符串的文本：调用方手里有 clean 时别再洗一遍。
fn parse_deps_clean(clean: &str) -> SourceDeps {
    SourceDeps {
        package: crate::compile::extract_package(clean).unwrap_or_default(),
        imports: crate::compile::extract_imports(clean),
        types: declared_types(clean),
    }
}

fn declared_types(clean: &str) -> Vec<String> {
    let mut out: Vec<String> = typed_declarations(clean)
        .into_iter()
        .map(|(name, _, _)| name)
        .collect();
    out.sort();
    out.dedup();
    out
}

/// 声明类型 + 种类 + 类型名在清洗后文本里的字节偏移。
///
/// 工作区类型索引要按声明行跳转，所以和反向依赖共用同一份正则，不另写一套
/// （两套正则迟早对「record」「@interface」这类写法给出不同答案）。
pub(crate) fn typed_declarations(clean: &str) -> Vec<(String, &'static str, usize)> {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        regex::Regex::new(r"\b(class|interface|enum|record)\s+([A-Za-z_$][A-Za-z0-9_$]*)")
            .expect("静态正则不会编译失败")
    });
    re.captures_iter(clean)
        .map(|c| {
            let kind = match &c[1] {
                "interface" => "interface",
                "enum" => "enum",
                "record" => "record",
                _ => "class",
            };
            (c[2].to_string(), kind, c.get(2).map_or(0, |m| m.start()))
        })
        .collect()
}

/// ABI 变了以后，把引用它的源文件找出来。
///
/// 规则是「宁可多编」：显式 import、同包、通配 import 都算边；再用简单类名是否出现
/// 过滤一下，避免一个 `nc.vo.*` 把整个模块都带上。解析不出类型名的文件直接返回全部，
/// 调用方按阈值回落全量。
pub fn referrers(changed: &[PathBuf], all: &[PathBuf]) -> Option<Vec<PathBuf>> {
    let mut changed_fq: HashSet<String> = HashSet::new();
    let mut changed_pkgs: HashSet<String> = HashSet::new();
    let mut simple: HashSet<String> = HashSet::new();
    for p in changed {
        let text = decode_lossy(&std::fs::read(p).ok()?);
        let clean = strip_comments_and_literals(&text);
        let deps = parse_deps_clean(&clean);
        if deps.types.is_empty() {
            return None;
        }
        for t in &deps.types {
            let fq = if deps.package.is_empty() {
                t.clone()
            } else {
                format!("{}.{}", deps.package, t)
            };
            changed_fq.insert(fq.to_ascii_lowercase());
            // 简单名保持原大小写：mentions_word / may_mention 在原文里按词边界找
            simple.insert(t.clone());
        }
        changed_pkgs.insert(deps.package.to_ascii_lowercase());
    }

    let exclude: HashSet<String> = changed
        .iter()
        .map(|p| build_layout::slash(p).to_ascii_lowercase())
        .collect();
    Some(referrers_of_names(
        &changed_fq,
        &changed_pkgs,
        &simple,
        &exclude,
        all,
    ))
}

/// 按类型名集合找引用方。删除的源文件用这个：源码已不在，只有旧清单里的
/// 包名 + 类型名（`RemovedSource`）。规则与 `referrers` 同一套，宁可多编。
pub fn referrers_of_names(
    changed_fq: &HashSet<String>,
    changed_pkgs: &HashSet<String>,
    simple: &HashSet<String>,
    exclude: &HashSet<String>,
    all: &[PathBuf],
) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for p in all {
        if exclude.contains(&build_layout::slash(p).to_ascii_lowercase()) {
            continue;
        }
        let Ok(bytes) = std::fs::read(p) else {
            continue;
        };
        // 快速预筛：正文字节里连类名都没出现（注释/字符串也算），不可能有引用。
        // 全工作区扫描时这一步省掉 95% 以上的解码与解析。
        if !may_mention(&bytes, simple) {
            continue;
        }
        let text = decode_lossy(&bytes);
        let clean = strip_comments_and_literals(&text);
        let deps = parse_deps_clean(&clean);
        let mut edge = false;
        // 同包：只要简单类名出现就算（保守）
        if changed_pkgs.contains(&deps.package.to_ascii_lowercase())
            && simple.iter().any(|s| mentions_word(&clean, s))
        {
            edge = true;
        }
        // 显式 import 直接命中
        if !edge
            && deps
                .imports
                .iter()
                .any(|(name, wild)| !*wild && changed_fq.contains(&name.to_ascii_lowercase()))
        {
            edge = true;
        }
        // 通配 import：包命中且简单类名出现
        if !edge
            && deps
                .imports
                .iter()
                .any(|(name, wild)| *wild && changed_pkgs.contains(&name.to_ascii_lowercase()))
            && simple.iter().any(|s| mentions_word(&clean, s))
        {
            edge = true;
        }
        // 签名里直接写了 FQCN（不 import）
        if !edge
            && changed_fq
                .iter()
                .any(|f| clean.to_ascii_lowercase().contains(f))
        {
            edge = true;
        }
        if edge {
            out.push(p.clone());
        }
    }
    out
}

/// 正文字节里是否可能出现某个类名。
///
/// 只看原始字节是有意为之：import 行、同包引用、FQCN 都会把简单类名写进正文，
/// 所以「没出现」是「不可能引用」的可靠超集。UTF-16 源码的 ASCII 字节被 0x00 隔开，
/// 这里判断不了，直接放行。
fn may_mention(bytes: &[u8], names: &HashSet<String>) -> bool {
    if names.is_empty() || bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        return true;
    }
    names.iter().any(|n| {
        let needle = n.as_bytes();
        !needle.is_empty() && bytes.windows(needle.len()).any(|w| w == needle)
    })
}

pub(crate) fn mentions_word(text: &str, name: &str) -> bool {
    let bytes = text.as_bytes();
    let needle = name.as_bytes();
    if needle.is_empty() || needle.len() > bytes.len() {
        return false;
    }
    let is_word = |b: u8| b.is_ascii_alphanumeric() || b == b'_' || b == b'$';
    let mut from = 0;
    while let Some(i) = text[from..].find(name) {
        let at = from + i;
        let before_ok = at == 0 || !is_word(bytes[at - 1]);
        let end = at + needle.len();
        let after_ok = end >= bytes.len() || !is_word(bytes[end]);
        if before_ok && after_ok {
            return true;
        }
        from = at + needle.len();
        if from >= text.len() {
            break;
        }
    }
    false
}

/// 全量编译时，哪些源文件相对旧清单真的变了（stat + 内容哈希 + 待判定标记）。
///
/// 结构变没变在**编译后**由桥 struct 指纹比对判定，不在这里猜；这里只挑出
/// 「需要参与结构判定」的文件，避免全量时对七千个文件都算指纹。
/// 先只 stat 全部文件，命中了才读文件算哈希。
pub fn changed_against_manifest(
    layout: &ModuleLayout,
    manifest: Option<&Manifest>,
    files: &[PathBuf],
) -> Vec<PathBuf> {
    let Some(m) = manifest else {
        return Vec::new();
    };
    let prev = m.sources_by_key();
    let mut changed = Vec::new();
    for p in files {
        let Some(stamp) = source_stamp(layout, p, false) else {
            continue;
        };
        let Some(old) = prev.get(&stamp.key()) else {
            changed.push(p.clone());
            continue;
        };
        if old.size == stamp.size && old.mtime_ms == stamp.mtime_ms && !old.struct_pending {
            continue;
        }
        // 内容哈希命中且无待判定 → touch 不算变（SVN 更新场景）
        if !old.struct_pending && !old.hash.is_empty() {
            if let Ok(bytes) = std::fs::read(p) {
                if sha(&[&bytes]) == old.hash {
                    continue;
                }
            }
        }
        changed.push(p.clone());
    }
    changed
}

/// 决定这一轮怎么编。
///
/// 只回答「第一轮编哪些文件」：内容变化 + 新增。签名变没变、引用方要不要跟，
/// 是编译后 class 结构 diff 的事（`build_engine::build_one`），决策阶段不猜。
/// 新增/删除不再一律全量（Eclipse 队列模型）：新增进第一轮，删除靠旧清单类型名
/// 找引用方；解析不出的保守退路仍在构建引擎里（referrers 返回 None → 全量）。
pub fn decide(
    layout: &ModuleLayout,
    manifest: Option<&Manifest>,
    classpath_fp: &str,
    compiler_fp: &str,
    force_full: bool,
) -> Decision {
    decide_with_hint(
        layout,
        manifest,
        classpath_fp,
        compiler_fp,
        force_full,
        None,
    )
}

/// `decide` 的脏集增量版：`hint` 可靠时只 stat 脏文件（含增删改），不必全模块扫描；
/// `hint=None` 或不可靠 → 回落全扫（与 `decide` 完全一致）。正确性兜底见 `compile_dirty`
/// 的 epoch 模型：溢出 / rescan / 切工作区 / 监听出错都会让 hint 不可信。
pub fn decide_with_hint(
    layout: &ModuleLayout,
    manifest: Option<&Manifest>,
    classpath_fp: &str,
    compiler_fp: &str,
    force_full: bool,
    hint: Option<&crate::compile_dirty::DirtyHint>,
) -> Decision {
    if force_full {
        return Decision::Full {
            reason: "手动要求全量".to_string(),
        };
    }
    let Some(m) = manifest else {
        return Decision::Full {
            reason: "没有可用的构建清单（首次编译或清单损坏）".to_string(),
        };
    };
    if !layout.matches_manifest(&m.source_roots, &m.outputs) {
        return Decision::Full {
            reason: "源码根或产物目录发生了变化".to_string(),
        };
    }
    if m.classpath_fp != classpath_fp {
        return Decision::Full {
            reason: "类路径发生了变化（.classpath / 依赖工程 / NC home / jar / 覆盖表）"
                .to_string(),
        };
    }
    if m.compiler_fp != compiler_fp {
        return Decision::Full {
            reason: "编译器或 Java 版本发生了变化".to_string(),
        };
    }

    // 脏集可信：只查脏文件，不扫全模块。空脏集 → 直接 Skip（build_all 无变更的大头）。
    if let Some(h) = hint {
        if h.reliable {
            return decide_incremental(layout, m, h);
        }
    }

    let current = scan_sources(layout, false);
    let prev = m.sources_by_key();
    let mut modified: Vec<PathBuf> = Vec::new();
    let mut added: Vec<PathBuf> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for (path, stamp) in &current {
        let key = stamp.key();
        seen.insert(key.clone());
        match prev.get(&key) {
            None => added.push(path.clone()),
            Some(old)
                if old.size != stamp.size
                    || old.mtime_ms != stamp.mtime_ms
                    || old.struct_pending =>
            {
                // stat 变了先读内容：哈希命中且无待判定 → touch 不算变。
                // struct_pending 必须进编译轮补结构判定，哈希相同也不能跳。
                let unchanged = !old.struct_pending
                    && !old.hash.is_empty()
                    && std::fs::read(path)
                        .ok()
                        .map(|b| sha(&[&b]) == old.hash)
                        .unwrap_or(false);
                if !unchanged {
                    modified.push(path.clone());
                }
            }
            _ => {}
        }
    }
    let mut removed: Vec<RemovedSource> = Vec::new();
    for s in &m.sources {
        if !seen.contains(&s.key()) {
            let path =
                build_layout::safe_join(&layout.module_dir, &format!("{}/{}", s.root, s.rel))
                    .unwrap_or_default();
            removed.push(RemovedSource {
                path,
                package: s.package.clone(),
                types: s.types.clone(),
            });
        }
    }
    if modified.is_empty() && added.is_empty() && removed.is_empty() {
        return Decision::Skip;
    }

    let mut files = modified.clone();
    files.extend(added.iter().cloned());
    files.sort();
    files.dedup();
    Decision::Incremental {
        reason: format!(
            "{} 个文件内容变化，{} 个新增，{} 个删除",
            modified.len(),
            added.len(),
            removed.len()
        ),
        changed: files.clone(),
        files,
        removed,
    }
}

/// 脏集可信时的增量判定：只 stat 脏集里的路径，不扫全模块。
///
/// 脏集含增 / 删 / 改三类（watcher 不区分，统一进 java 集）：stat 得到 → 比清单判
/// 改 / 增；stat 不到（已删）→ 若在清单里则判删。可信前提下脏集是完整的，故不必
/// 再遍历清单查「有没有漏掉的删除」——那正是全扫，与增量目的相悖。
fn decide_incremental(
    layout: &ModuleLayout,
    m: &Manifest,
    h: &crate::compile_dirty::DirtyHint,
) -> Decision {
    let prev = m.sources_by_key();
    let mut modified: Vec<PathBuf> = Vec::new();
    let mut added: Vec<PathBuf> = Vec::new();
    let mut removed: Vec<RemovedSource> = Vec::new();
    for p in &h.paths {
        let Some(stamp) = source_stamp(layout, p, false) else {
            continue;
        };
        let key = stamp.key();
        let exists = p.exists();
        match prev.get(&key) {
            None => {
                if exists {
                    added.push(p.clone());
                }
            }
            Some(old) => {
                if !exists {
                    removed.push(RemovedSource {
                        path: p.clone(),
                        package: old.package.clone(),
                        types: old.types.clone(),
                    });
                } else if old.size != stamp.size
                    || old.mtime_ms != stamp.mtime_ms
                    || old.struct_pending
                {
                    let unchanged = !old.struct_pending
                        && !old.hash.is_empty()
                        && std::fs::read(p)
                            .ok()
                            .map(|b| sha(&[&b]) == old.hash)
                            .unwrap_or(false);
                    if !unchanged {
                        modified.push(p.clone());
                    }
                }
            }
        }
    }
    if modified.is_empty() && added.is_empty() && removed.is_empty() {
        return Decision::Skip;
    }
    let mut files = modified.clone();
    files.extend(added.iter().cloned());
    files.sort();
    files.dedup();
    Decision::Incremental {
        reason: format!(
            "脏集增量：{} 个内容变化，{} 个新增，{} 个删除",
            modified.len(),
            added.len(),
            removed.len()
        ),
        changed: files.clone(),
        files,
        removed,
    }
}

/// Skip 时的 stat 刷新：mtime/size 变了但内容哈希没变的文件，把新 stat 写回清单，
/// 下次 decide 不再重复读文件。返回 `None` = 没什么可刷的（调用方不写盘）。
/// 待判定（struct_pending）文件不刷：它们必须走编译轮，不能在这里被静默抹平。
pub fn touch_refresh(layout: &ModuleLayout, m: &Manifest) -> Option<Manifest> {
    let mut next = m.clone();
    let mut changed = false;
    for s in &mut next.sources {
        if s.struct_pending {
            continue;
        }
        let Some(abs) =
            build_layout::safe_join(&layout.module_dir, &format!("{}/{}", s.root, s.rel))
        else {
            continue;
        };
        let (size, mtime_ms) = stat_of(&abs);
        if size == s.size && mtime_ms == s.mtime_ms {
            continue;
        }
        if s.hash.is_empty() {
            continue;
        }
        let Ok(bytes) = std::fs::read(&abs) else {
            continue;
        };
        if sha(&[&bytes]) == s.hash {
            s.size = size;
            s.mtime_ms = mtime_ms;
            changed = true;
        }
    }
    if changed {
        Some(next)
    } else {
        None
    }
}

// ───────────────────────────── 清单更新 / 旧产物 ─────────────────────────────

/// 编译成功后更新清单。`compiled` 为本次实际参与编译的文件；全量传全部源文件。
///
/// `struct_fps`：源文件 key → 本轮 class 结构指纹（`None` = 桥失败/未知，按可能变了处理）。
/// `preserve_struct=true`（保存后的单文件快速编译）：沿用旧指纹并标 `struct_pending`，
/// 把结构判定留给下一轮空闲增量——与旧 `preserve_abi` 同一形状，判定数据换成 class 指纹。
// 参数多是语义需要：布局 / 旧清单 / 本轮文件 / 两个配置指纹 / seed / 全量标志 /
// 结构指纹表 / 保留标志，各自独立，打包成结构体只会把调用点搅得更乱。
#[allow(clippy::too_many_arguments)]
pub fn updated_manifest(
    layout: &ModuleLayout,
    previous: Option<&Manifest>,
    compiled: &[PathBuf],
    classpath_fp: &str,
    compiler_fp: &str,
    seed_jars: Vec<u32>,
    full: bool,
    struct_fps: &HashMap<String, Option<String>>,
    preserve_struct: bool,
) -> Manifest {
    let compiled_set: HashSet<String> = compiled
        .iter()
        .map(|p| build_layout::slash(p).to_ascii_lowercase())
        .collect();
    let prev_map = previous.map(|m| m.sources_by_key()).unwrap_or_default();
    let mut ext = if full {
        ExtRefs::default()
    } else {
        previous.map(|m| m.ext.clone()).unwrap_or_default()
    };
    let mut sources: Vec<SourceStamp> = Vec::new();
    if !full {
        if let Some(prev) = previous {
            for s in &prev.sources {
                // 保留未参与本轮的文件；本轮编过的会被下面重新扫一遍
                let abs =
                    build_layout::safe_join(&layout.module_dir, &format!("{}/{}", s.root, s.rel));
                let key = abs
                    .as_deref()
                    .map(build_layout::slash)
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                if !compiled_set.contains(&key) {
                    sources.push(s.clone());
                }
            }
        }
    }
    for p in compiled {
        if let Some(mut s) = source_stamp(layout, p, true) {
            if let Some(out) = layout.output_for(p) {
                s.classes = classes_for_source(&out, &s.package, p);
            }
            if preserve_struct {
                s.struct_fp = prev_map.get(&s.key()).and_then(|o| o.struct_fp.clone());
                s.struct_pending = true;
            } else {
                s.struct_fp = struct_fps.get(&s.key()).cloned().flatten();
                s.struct_pending = false;
            }
            ext.merge(&s.ext);
            sources.push(s);
        }
    }
    sources.sort_by_key(|a| a.key());
    sources.dedup_by(|a, b| a.key() == b.key());
    let source_roots = layout
        .source_roots
        .iter()
        .filter_map(|p| layout.rel_root(p))
        .collect();
    let outputs = layout
        .outputs
        .iter()
        .filter_map(|p| layout.output_rel(p))
        .collect();
    Manifest {
        schema: SCHEMA,
        workspace: build_layout::slash(layout.module_dir.parent().unwrap_or(&layout.module_dir)),
        module: layout.module.clone(),
        source_roots,
        outputs,
        sources,
        ext,
        classpath_fp: classpath_fp.to_string(),
        compiler_fp: compiler_fp.to_string(),
        seed_jars,
        last_success_ms: now_ms(),
        last_attempt: None,
    }
}

/// 无清单模块的外部引用：按需全扫一遍源码（make 闭包遇到从未编过的模块时用）。
/// 有清单的模块直接读 `Manifest.ext`，不走这里。
pub fn module_ext_refs(layout: &ModuleLayout) -> ExtRefs {
    let mut ext = ExtRefs::default();
    for p in layout.collect_sources() {
        if let Some(s) = source_stamp(layout, &p, true) {
            ext.merge(&s.ext);
        }
    }
    ext
}

/// 某源文件在产物目录里对应的 class（`Outer.class` + `Outer$*.class`）。
pub fn classes_for_source(out_dir: &Path, package: &str, source: &Path) -> Vec<String> {
    let Some(stem) = source.file_stem().and_then(|s| s.to_str()) else {
        return Vec::new();
    };
    let dir = if package.is_empty() {
        out_dir.to_path_buf()
    } else {
        out_dir.join(package.replace('.', std::path::MAIN_SEPARATOR_STR))
    };
    let Ok(rd) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !name.to_ascii_lowercase().ends_with(".class") {
            continue;
        }
        let base = &name[..name.len() - 6];
        if base.eq_ignore_ascii_case(stem)
            || base
                .to_ascii_lowercase()
                .starts_with(&format!("{}$", stem.to_ascii_lowercase()))
        {
            let rel = if package.is_empty() {
                name
            } else {
                format!("{}/{}", package.replace('.', "/"), name)
            };
            out.push(rel);
        }
    }
    out.sort();
    out
}

/// 上次清单里有、这次没有的 class。只在**当前仍声明的产物目录**里找，
/// 旧产物目录不自动删（方案 §3.7：留给用户决定）。
pub fn stale_classes(layout: &ModuleLayout, previous: &Manifest, next: &Manifest) -> Vec<PathBuf> {
    let current: HashSet<String> = next
        .sources
        .iter()
        .flat_map(|s| {
            s.classes
                .iter()
                .map(move |c| format!("{}|{}", s.out.to_ascii_lowercase(), c.to_ascii_lowercase()))
        })
        .collect();
    let active_outputs: HashSet<String> = layout
        .outputs
        .iter()
        .filter_map(|p| layout.output_rel(p))
        .map(|p| p.to_ascii_lowercase())
        .collect();
    let mut out = Vec::new();
    for s in &previous.sources {
        if !active_outputs.contains(&s.out.to_ascii_lowercase()) {
            continue;
        }
        let Some(out_dir) = build_layout::safe_join(&layout.module_dir, &s.out) else {
            continue;
        };
        for c in &s.classes {
            let key = format!("{}|{}", s.out.to_ascii_lowercase(), c.to_ascii_lowercase());
            if current.contains(&key) {
                continue;
            }
            if let Some(p) = build_layout::safe_join(&out_dir, c) {
                if p.is_file() && !build_layout::has_reparse_component_under(&p, &layout.module_dir)
                {
                    out.push(p);
                }
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

// ───────────────────────────── 清理 ─────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanReport {
    pub module: String,
    pub outputs: Vec<String>,
    pub removed: usize,
    pub files: Vec<String>,
    pub failed: Vec<String>,
    pub unknown: Vec<String>,
    pub unknown_count: usize,
    pub dirs_removed: usize,
    pub had_manifest: bool,
    pub svn_detected: bool,
    pub manifest_removed: bool,
    pub notes: Vec<String>,
}

impl CleanReport {
    pub fn ok(&self) -> bool {
        self.failed.is_empty()
    }
}

/// 清理一个模块。`dry_run=true` 只算不删（确认框用）。
///
/// 安全规则见方案 §3.4：只删声明过的 `.class`、输出根保留、不跟重解析点、
/// 越界拒绝、失败即停。没有清单时只删能映射回源码的 class。
pub fn clean_module(
    layout: &ModuleLayout,
    manifest: Option<&Manifest>,
    manifest_path: Option<&Path>,
    dry_run: bool,
) -> CleanReport {
    let mut report = CleanReport {
        module: layout.module.clone(),
        outputs: layout
            .outputs
            .iter()
            .map(|p| crate::security::path::display_path(p))
            .collect(),
        removed: 0,
        files: Vec::new(),
        failed: Vec::new(),
        unknown: Vec::new(),
        unknown_count: 0,
        dirs_removed: 0,
        had_manifest: false,
        svn_detected: has_svn(layout),
        manifest_removed: false,
        notes: Vec::new(),
    };

    let trusted = manifest
        .filter(|m| m.schema == SCHEMA && layout.matches_manifest(&m.source_roots, &m.outputs));
    let mut targets: Vec<PathBuf> = Vec::new();
    if let Some(m) = trusted {
        report.had_manifest = true;
        let valid_outputs: HashSet<String> =
            m.outputs.iter().map(|s| s.to_ascii_lowercase()).collect();
        for s in &m.sources {
            if !valid_outputs.contains(&s.out.to_ascii_lowercase()) {
                report.notes.push(format!(
                    "清单里的产物目录 {} 已不在布局中，跳过（不自动删旧目录）",
                    s.out
                ));
                continue;
            }
            let Some(out_dir) = build_layout::safe_join(&layout.module_dir, &s.out) else {
                report.failed.push(format!("非法产物目录：{}", s.out));
                continue;
            };
            for c in &s.classes {
                if !c.to_ascii_lowercase().ends_with(".class") {
                    continue;
                }
                let Some(p) = build_layout::safe_join(&out_dir, c) else {
                    report
                        .failed
                        .push(format!("非法 class 路径：{}/{}", s.out, c));
                    continue;
                };
                if p.is_file() {
                    if build_layout::has_reparse_component_under(&p, &layout.module_dir) {
                        report.failed.push(format!(
                            "拒绝跟随重解析点：{}",
                            crate::security::path::display_path(&p)
                        ));
                    } else {
                        targets.push(p);
                    }
                }
            }
        }
    } else {
        let (mapped, unknown) = infer_classes(layout);
        report.unknown_count = unknown.total;
        report.unknown = unknown.sample;
        targets = mapped;
        if manifest.is_some() {
            report
                .notes
                .push("构建清单与当前布局不符，按源码映射推断可删集合".to_string());
        }
    }
    targets.sort();
    targets.dedup();

    if dry_run {
        report.removed = targets.len();
        report.files = targets
            .iter()
            .take(200)
            .map(|p| crate::security::path::display_path(p))
            .collect();
        return report;
    }

    for p in targets {
        if build_layout::has_reparse_component_under(&p, &layout.module_dir) {
            report.failed.push(format!(
                "拒绝跟随重解析点：{}",
                crate::security::path::display_path(&p)
            ));
            break;
        }
        match std::fs::remove_file(&p) {
            Ok(()) => {
                report.removed += 1;
                if report.files.len() < 200 {
                    report.files.push(crate::security::path::display_path(&p));
                }
            }
            Err(e) => {
                report
                    .failed
                    .push(format!("{}：{e}", crate::security::path::display_path(&p)));
                break;
            }
        }
    }
    // 包目录清空后自底向上删；输出根永远保留（classpath / 依赖顺序还要用它）
    for out in &layout.outputs {
        if !out.is_dir() || build_layout::has_reparse_component_under(out, &layout.module_dir) {
            continue;
        }
        report.dirs_removed += remove_empty_dirs(out);
    }
    if report.failed.is_empty() {
        if let Some(mp) = manifest_path {
            report.manifest_removed = delete_manifest(mp);
        }
    } else {
        report
            .notes
            .push("有文件删不掉，已停止；清单保留，修好锁定后可以再清一次".to_string());
    }
    if report.svn_detected {
        report.notes.push(
            "产物目录在 SVN 工作副本里：这些 class 被版本控制时，清理后会显示为删除".to_string(),
        );
    }
    report
}

/// 无清单时的可删集合：只认「包名 + 外层类名」能对上某个源码文件的 class。
fn infer_classes(layout: &ModuleLayout) -> (Vec<PathBuf>, UnknownClasses) {
    let mut sources: HashSet<String> = HashSet::new();
    for p in layout.collect_sources() {
        let Ok(bytes) = std::fs::read(&p) else {
            continue;
        };
        let text = decode_lossy(&bytes);
        let pkg = crate::compile::extract_package(&text).unwrap_or_default();
        if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
            sources.insert(format!(
                "{}|{}",
                pkg.to_ascii_lowercase(),
                stem.to_ascii_lowercase()
            ));
        }
    }
    let mut out = Vec::new();
    let mut unknown = UnknownClasses::default();
    for out_dir in &layout.outputs {
        walk_classes(out_dir, &mut |p, rel| {
            let Some(file) = p.file_name().and_then(|s| s.to_str()) else {
                return;
            };
            let base = &file[..file.len().saturating_sub(6)];
            let outer = base.split('$').next().unwrap_or(base);
            let pkg = rel
                .rsplit_once('/')
                .map(|(d, _)| d.replace('/', "."))
                .unwrap_or_default();
            let key = format!(
                "{}|{}",
                pkg.to_ascii_lowercase(),
                outer.to_ascii_lowercase()
            );
            if sources.contains(&key) {
                out.push(p.to_path_buf());
            } else {
                unknown.total += 1;
                if unknown.sample.len() < 100 {
                    unknown.sample.push(crate::security::path::display_path(p));
                }
            }
        });
    }
    (out, unknown)
}

#[derive(Default)]
struct UnknownClasses {
    total: usize,
    sample: Vec<String>,
}

/// 递归找 `.class`；不跟重解析点，不进 `.svn` / `.git`。
fn walk_classes(dir: &Path, cb: &mut dyn FnMut(&Path, String)) {
    fn inner(dir: &Path, base: &Path, cb: &mut dyn FnMut(&Path, String)) {
        let Ok(rd) = std::fs::read_dir(dir) else {
            return;
        };
        for e in rd.flatten() {
            let p = e.path();
            let Ok(md) = std::fs::symlink_metadata(&p) else {
                continue;
            };
            if build_layout::is_reparse(&md) {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            if md.is_dir() {
                if name.eq_ignore_ascii_case(".svn") || name.eq_ignore_ascii_case(".git") {
                    continue;
                }
                inner(&p, base, cb);
            } else if name.to_ascii_lowercase().ends_with(".class") {
                if let Ok(rel) = p.strip_prefix(base) {
                    cb(&p, build_layout::slash(rel));
                }
            }
        }
    }
    inner(dir, dir, cb);
}

/// 自底向上删空目录；返回删掉的个数。根目录不删。
fn remove_empty_dirs(root: &Path) -> usize {
    fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(rd) = std::fs::read_dir(dir) else {
            return;
        };
        for e in rd.flatten() {
            let p = e.path();
            if let Ok(md) = std::fs::symlink_metadata(&p) {
                if md.is_dir() && !build_layout::is_reparse(&md) {
                    collect(&p, out);
                    out.push(p);
                }
            }
        }
    }
    let mut dirs = Vec::new();
    collect(root, &mut dirs);
    dirs.sort_by_key(|p| std::cmp::Reverse(p.components().count()));
    let mut n = 0;
    for d in dirs {
        if d == root {
            continue;
        }
        if std::fs::read_dir(&d)
            .map(|mut it| it.next().is_none())
            .unwrap_or(false)
            && std::fs::remove_dir(&d).is_ok()
        {
            n += 1;
        }
    }
    n
}

fn has_svn(layout: &ModuleLayout) -> bool {
    if layout.module_dir.join(".svn").is_dir() {
        return true;
    }
    layout.outputs.iter().any(|o| o.join(".svn").is_dir())
}

// ───────────────────────────── 历史 ─────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub at_ms: u64,
    pub module: String,
    pub status: String,
    pub error_count: usize,
    pub warning_count: usize,
    pub duration_ms: u64,
    pub reason: String,
}

fn history_path(config_dir: &Path, root: &Path) -> PathBuf {
    build_dir(config_dir, root).join("history.json")
}

pub fn read_history(config_dir: &Path, root: &Path) -> Vec<HistoryEntry> {
    std::fs::read(history_path(config_dir, root))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

pub fn append_history(config_dir: &Path, root: &Path, entries: Vec<HistoryEntry>) {
    if entries.is_empty() {
        return;
    }
    let path = history_path(config_dir, root);
    let mut all = read_history(config_dir, root);
    all.extend(entries);
    if all.len() > HISTORY_MAX {
        all.drain(..all.len() - HISTORY_MAX);
    }
    if let Ok(bytes) = serde_json::to_vec(&all) {
        let _ = crate::atomic_file::write_atomic(&path, &bytes);
    }
}

// ───────────────────────────── 缓存统计 ─────────────────────────────

/// 递归目录大小（跳过重解析点，避免把 junction 另一头算进来）。
pub fn dir_size(path: &Path) -> u64 {
    fn inner(dir: &Path) -> u64 {
        let Ok(rd) = std::fs::read_dir(dir) else {
            return 0;
        };
        let mut n = 0;
        for e in rd.flatten() {
            let p = e.path();
            let Ok(md) = std::fs::symlink_metadata(&p) else {
                continue;
            };
            if build_layout::is_reparse(&md) {
                continue;
            }
            if md.is_dir() {
                n += inner(&p);
            } else {
                n += md.len();
            }
        }
        n
    }
    inner(path)
}

/// 输出目录里没被清单记录过的 class：清理时不会删，值得让用户知道。
pub fn untracked_classes(layout: &ModuleLayout, manifest: Option<&Manifest>) -> Vec<String> {
    let tracked: HashSet<String> = manifest
        .map(|m| {
            m.sources
                .iter()
                .flat_map(|s| {
                    s.classes.iter().map(move |c| {
                        format!("{}|{}", s.out.to_ascii_lowercase(), c.to_ascii_lowercase())
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let mut out = Vec::new();
    for out_dir in &layout.outputs {
        let Some(out_rel) = layout.output_rel(out_dir) else {
            continue;
        };
        walk_classes(out_dir, &mut |p, rel| {
            let key = format!(
                "{}|{}",
                out_rel.to_ascii_lowercase(),
                rel.to_ascii_lowercase()
            );
            if !tracked.contains(&key) && out.len() < 100 {
                out.push(crate::security::path::display_path(p));
            }
        });
    }
    out.sort();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ncwb-state-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn write(p: &Path, s: &str) {
        if let Some(d) = p.parent() {
            std::fs::create_dir_all(d).unwrap();
        }
        std::fs::write(p, s).unwrap();
    }

    #[test]
    fn ext_refs_collects_imports_packages_and_mentioned_names() {
        let src = "package p; import q.A; import r.*; public class B { A a; C c; }";
        let clean = strip_comments_and_literals(src);
        let deps = parse_deps_clean(&clean);
        let ext = ext_refs(&clean, &deps);
        assert_eq!(ext.fq, vec!["q.a".to_string()]);
        assert_eq!(ext.wild, vec!["r".to_string()]);
        assert_eq!(ext.packages, vec!["p".to_string()]);
        // 正文大写开头标识符（小写归一）：同包 / 通配边的候选简单名
        assert!(ext.simple.contains(&"a".to_string()));
        assert!(ext.simple.contains(&"c".to_string()));
        assert!(ext.simple.contains(&"b".to_string()));
        // 注释 / 字符串里的大写词不算引用
        let noisy = "package p; // import x.Y;\npublic class B { String s = \"Z\"; }";
        let clean2 = strip_comments_and_literals(noisy);
        let deps2 = parse_deps_clean(&clean2);
        let ext2 = ext_refs(&clean2, &deps2);
        assert!(ext2.fq.is_empty());
        assert!(!ext2.simple.contains(&"y".to_string()));
        assert!(!ext2.simple.contains(&"z".to_string()));
    }

    #[test]
    fn ext_refs_merge_is_sorted_union() {
        let mut a = ExtRefs {
            fq: vec!["q.b".into(), "q.a".into()],
            wild: vec!["r".into()],
            packages: vec!["p".into()],
            simple: vec!["b".into()],
        };
        a.merge(&ExtRefs {
            fq: vec!["q.a".into(), "s.c".into()],
            wild: vec!["r".into(), "t".into()],
            packages: vec!["p2".into()],
            simple: vec!["a".into(), "b".into()],
        });
        assert_eq!(a.fq, vec!["q.a".to_string(), "q.b".into(), "s.c".into()]);
        assert_eq!(a.wild, vec!["r".to_string(), "t".into()]);
        assert_eq!(a.simple, vec!["a".to_string(), "b".into()]);
    }

    #[test]
    fn manifest_roundtrip_and_corruption_falls_back() {
        let d = tmp("manifest");
        let m = Manifest {
            schema: SCHEMA,
            workspace: "C:/ws".into(),
            module: "gl".into(),
            source_roots: vec!["src/public".into()],
            outputs: vec!["classes".into()],
            sources: vec![],
            ext: ExtRefs::default(),
            classpath_fp: "a".into(),
            compiler_fp: "b".into(),
            seed_jars: vec![1, 2],
            last_success_ms: 1,
            last_attempt: None,
        };
        let p = d.join("gl.bin");
        write_manifest(&p, &m).unwrap();
        let got = read_manifest(&p, Path::new("C:/ws"), "gl").unwrap();
        assert_eq!(got.sources, m.sources);
        assert_eq!(got.seed_jars, vec![1, 2]);
        // 截断 → None，不 panic
        std::fs::write(&p, b"NCBS1\n{oops").unwrap();
        assert!(read_manifest(&p, Path::new("C:/ws"), "gl").is_none());
        // 工作区不符 → None
        write_manifest(&p, &m).unwrap();
        assert!(read_manifest(&p, Path::new("C:/other"), "gl").is_none());
    }

    #[test]
    fn clean_without_manifest_only_deletes_source_mapped_classes() {
        let root = tmp("clean-infer");
        let m = root.join("gl");
        write(
            &m.join("src/public/p/A.java"),
            "package p; public class A {}",
        );
        write(&m.join("classes/p/A.class"), "x");
        write(&m.join("classes/p/A$1.class"), "x");
        write(&m.join("classes/p/HandMade.class"), "x");
        let l = ModuleLayout::resolve(&root, "gl");
        let r = clean_module(&l, None, None, false);
        assert_eq!(r.removed, 2);
        assert!(!m.join("classes/p/A.class").exists());
        assert!(!m.join("classes/p/A$1.class").exists());
        // 映射不上的不删
        assert!(m.join("classes/p/HandMade.class").exists());
        assert_eq!(r.unknown_count, 1);
        // 输出根保留；包目录因为还有保留的 HandMade.class 也不能删
        assert!(l.outputs[0].is_dir());
        assert!(m.join("classes/p").is_dir());
    }

    #[test]
    fn clean_with_manifest_deletes_only_recorded_classes() {
        let root = tmp("clean-manifest");
        let m = root.join("gl");
        write(
            &m.join("src/public/p/A.java"),
            "package p; public class A {}",
        );
        write(&m.join("classes/p/A.class"), "x");
        write(&m.join("classes/p/Other.class"), "x");
        let l = ModuleLayout::resolve(&root, "gl");
        let man = Manifest {
            schema: SCHEMA,
            workspace: build_layout::slash(&root),
            module: "gl".into(),
            source_roots: vec!["src/public".into()],
            outputs: vec!["classes".into()],
            sources: vec![SourceStamp {
                root: "src/public".into(),
                rel: "p/A.java".into(),
                out: "classes".into(),
                size: 1,
                mtime_ms: 1,
                package: "p".into(),
                hash: String::new(),
                struct_fp: None,
                struct_pending: false,
                types: vec![],
                ext: ExtRefs::default(),
                classes: vec!["p/A.class".into()],
            }],
            ext: ExtRefs::default(),
            classpath_fp: "a".into(),
            compiler_fp: "b".into(),
            seed_jars: vec![],
            last_success_ms: 1,
            last_attempt: None,
        };
        let r = clean_module(&l, Some(&man), None, false);
        assert_eq!(r.removed, 1);
        assert!(!m.join("classes/p/A.class").exists());
        assert!(m.join("classes/p/Other.class").exists());
    }

    #[test]
    fn clean_dry_run_changes_nothing() {
        let root = tmp("clean-dry");
        let m = root.join("gl");
        write(
            &m.join("src/public/p/A.java"),
            "package p; public class A {}",
        );
        write(&m.join("classes/p/A.class"), "x");
        let l = ModuleLayout::resolve(&root, "gl");
        let r = clean_module(&l, None, None, true);
        assert_eq!(r.removed, 1);
        assert!(m.join("classes/p/A.class").exists());
    }

    #[test]
    fn manifest_layout_mismatch_is_not_trusted() {
        let root = tmp("mismatch");
        let m = root.join("gl");
        write(
            &m.join("src/public/p/A.java"),
            "package p; public class A {}",
        );
        write(&m.join("classes/p/A.class"), "x");
        let l = ModuleLayout::resolve(&root, "gl");
        let man = Manifest {
            schema: SCHEMA,
            workspace: build_layout::slash(&root),
            module: "gl".into(),
            source_roots: vec!["src/other".into()],
            outputs: vec!["classes".into()],
            sources: vec![],
            ext: ExtRefs::default(),
            classpath_fp: "a".into(),
            compiler_fp: "b".into(),
            seed_jars: vec![],
            last_success_ms: 1,
            last_attempt: None,
        };
        let r = clean_module(&l, Some(&man), None, false);
        assert!(!r.had_manifest);
        assert_eq!(r.removed, 1);
    }

    #[test]
    fn decision_skips_unchanged_and_increments_body_only_changes() {
        let root = tmp("decide");
        let m = root.join("gl");
        write(
            &m.join("src/public/p/A.java"),
            "package p; public class A { public void f() {} }",
        );
        write(
            &m.join("src/public/p/B.java"),
            "package p; public class B { A a; }",
        );
        // 留几个不相关文件，让「签名变化影响 2 个」低于 30% 全量阈值
        for i in 0..5 {
            write(
                &m.join(format!("src/public/z/Z{i}.java")),
                &format!("package z; public class Z{i} {{}}"),
            );
        }
        let l = ModuleLayout::resolve(&root, "gl");
        let all = l.collect_sources();
        let man = updated_manifest(
            &l,
            None,
            &all,
            "cp",
            "cc",
            vec![],
            true,
            &HashMap::new(),
            false,
        );
        assert_eq!(decide(&l, Some(&man), "cp", "cc", false), Decision::Skip);

        // 只改方法体：只编 A
        write(
            &m.join("src/public/p/A.java"),
            "package p; public class A { public void f() { int x = 1; } }",
        );
        match decide(&l, Some(&man), "cp", "cc", false) {
            Decision::Incremental { files, .. } => {
                assert_eq!(files.len(), 1);
                assert!(build_layout::slash(&files[0]).ends_with("p/A.java"));
            }
            other => panic!("expected incremental, got {other:?}"),
        }

        // 改签名：第一轮仍只编 A——引用方要不要跟，是编译后 class 结构 diff 的事，
        // 决策阶段不猜（旧源码 ABI 在这里猜，常把「只改方法体」也当成签名变化）
        write(
            &m.join("src/public/p/A.java"),
            "package p; public class A { public void f(int x) {} }",
        );
        match decide(&l, Some(&man), "cp", "cc", false) {
            Decision::Incremental { files, .. } => {
                assert_eq!(files.len(), 1);
                assert!(build_layout::slash(&files[0]).ends_with("p/A.java"));
            }
            other => panic!("expected incremental, got {other:?}"),
        }

        // 新增文件：进第一轮增量，不再一律全量（Eclipse 队列模型）
        write(
            &m.join("src/public/p/C.java"),
            "package p; public class C {}",
        );
        match decide(&l, Some(&man), "cp", "cc", false) {
            Decision::Incremental { files, removed, .. } => {
                assert!(files
                    .iter()
                    .any(|p| build_layout::slash(p).ends_with("p/C.java")));
                assert!(removed.is_empty());
            }
            other => panic!("expected incremental with added file, got {other:?}"),
        }
        // 配置变化：全量
        assert!(matches!(
            decide(&l, Some(&man), "other", "cc", false),
            Decision::Full { .. }
        ));
    }

    #[test]
    fn decision_touch_with_same_hash_skips_and_pending_forces_round() {
        let root = tmp("decide-touch");
        let m = root.join("gl");
        let a = m.join("src/public/p/A.java");
        write(&a, "package p; public class A { public void f() {} }");
        let l = ModuleLayout::resolve(&root, "gl");
        let man = updated_manifest(
            &l,
            None,
            &l.collect_sources(),
            "cp",
            "cc",
            vec![],
            true,
            &HashMap::new(),
            false,
        );
        assert!(!man.sources[0].hash.is_empty(), "全量清单应记内容哈希");

        // touch（SVN 更新 / 外部工具重写同样内容）：stat 变了哈希没变 → Skip
        write(&a, "package p; public class A { public void f() {} }");
        assert_eq!(decide(&l, Some(&man), "cp", "cc", false), Decision::Skip);
        // Skip 后把新 stat 刷回清单，下次不再重复读文件
        let refreshed = touch_refresh(&l, &man).expect("touch 应触发 stat 刷新");
        let (size, mtime) = (std::fs::metadata(&a).unwrap().len(), stat_of(&a).1);
        assert_eq!(refreshed.sources[0].size, size);
        assert_eq!(refreshed.sources[0].mtime_ms, mtime);
        assert_eq!(
            decide(&l, Some(&refreshed), "cp", "cc", false),
            Decision::Skip
        );
        assert!(touch_refresh(&l, &refreshed).is_none(), "刷过的不该再刷");

        // struct_pending（保存快速编译留下的待判定）：哈希相同也必须进编译轮
        let mut pending = man.clone();
        pending.sources[0].struct_pending = true;
        match decide(&l, Some(&pending), "cp", "cc", false) {
            Decision::Incremental { files, .. } => assert_eq!(files.len(), 1),
            other => panic!("pending must force a compile round, got {other:?}"),
        }
        // pending 文件不能被 touch_refresh 静默抹平
        assert!(touch_refresh(&l, &pending).is_none());
    }

    #[test]
    fn decision_reports_removed_with_old_types() {
        let root = tmp("decide-rm");
        let m = root.join("gl");
        write(
            &m.join("src/public/p/A.java"),
            "package p; public class A { public int x; }",
        );
        write(
            &m.join("src/public/p/B.java"),
            "package p; public class B { A a; }",
        );
        let l = ModuleLayout::resolve(&root, "gl");
        let man = updated_manifest(
            &l,
            None,
            &l.collect_sources(),
            "cp",
            "cc",
            vec![],
            true,
            &HashMap::new(),
            false,
        );
        let a_stamp = man.sources.iter().find(|s| s.rel == "p/A.java").unwrap();
        assert_eq!(a_stamp.types, vec!["A".to_string()]);
        std::fs::remove_file(m.join("src/public/p/A.java")).unwrap();
        match decide(&l, Some(&man), "cp", "cc", false) {
            Decision::Incremental { files, removed, .. } => {
                assert!(files.is_empty(), "只删除时第一轮没有文件要编");
                assert_eq!(removed.len(), 1);
                assert_eq!(removed[0].package, "p");
                assert_eq!(removed[0].types, vec!["A".to_string()]);
                assert!(build_layout::slash(&removed[0].path).ends_with("p/A.java"));
            }
            other => panic!("expected incremental with removed, got {other:?}"),
        }
    }

    #[test]
    fn stale_classes_are_removed_after_source_delete() {
        let root = tmp("stale");
        let m = root.join("gl");
        write(
            &m.join("src/public/p/A.java"),
            "package p; public class A {}",
        );
        write(
            &m.join("src/public/p/B.java"),
            "package p; public class B {}",
        );
        // 真实流程里清单是在一轮成功编译之后写的：那时 class 已经存在并记进清单
        write(&m.join("classes/p/A.class"), "x");
        write(&m.join("classes/p/B.class"), "x");
        let l = ModuleLayout::resolve(&root, "gl");
        let prev = updated_manifest(
            &l,
            None,
            &l.collect_sources(),
            "cp",
            "cc",
            vec![],
            true,
            &HashMap::new(),
            false,
        );
        assert_eq!(prev.sources.len(), 2);
        std::fs::remove_file(m.join("src/public/p/B.java")).unwrap();
        let next = updated_manifest(
            &l,
            Some(&prev),
            &l.collect_sources(),
            "cp",
            "cc",
            vec![],
            true,
            &HashMap::new(),
            false,
        );
        let stale = stale_classes(&l, &prev, &next);
        assert_eq!(stale.len(), 1);
        assert!(build_layout::slash(&stale[0]).ends_with("p/B.class"));
    }

    #[test]
    fn reverse_dependency_handles_same_package_and_wildcard_import() {
        let root = tmp("deps");
        let m = root.join("gl");
        write(
            &m.join("src/public/p/A.java"),
            "package p; public class A { public void f(int x) {} }",
        );
        write(
            &m.join("src/public/p/Same.java"),
            "package p; public class Same { A a; }",
        );
        write(
            &m.join("src/public/q/Wild.java"),
            "package q; import p.*; public class Wild { A a; }",
        );
        write(
            &m.join("src/public/q/Unrelated.java"),
            "package q; public class Unrelated {}",
        );
        let l = ModuleLayout::resolve(&root, "gl");
        let all = l.collect_sources();
        let changed = vec![m.join("src/public/p/A.java")];
        let refs = referrers(&changed, &all).unwrap();
        let names: Vec<String> = refs.iter().map(|p| build_layout::slash(p)).collect();
        assert!(names.iter().any(|n| n.ends_with("p/Same.java")));
        assert!(names.iter().any(|n| n.ends_with("q/Wild.java")));
        assert!(!names.iter().any(|n| n.ends_with("q/Unrelated.java")));
    }

    /// 真机探针（`#[ignore]`）：一个签名改动扫遍全工作区源码要多久。
    #[test]
    #[ignore = "真机：依赖 C:\\work\\aier\\newar"]
    fn workspace_referrer_scan_live() {
        let root = Path::new(r"C:\work\aier\newar");
        if !root.is_dir() {
            return;
        }
        let modules = crate::eclipse_cp::module_dirs_of(root);
        let (mut files, mut refs) = (0usize, 0usize);
        let started = std::time::Instant::now();
        for m in &modules {
            let l = ModuleLayout::resolve(root, m);
            let all = l.collect_sources();
            files += all.len();
            let changed: Vec<PathBuf> = all.iter().take(1).cloned().collect();
            refs += referrers(&changed, &all).map(|r| r.len()).unwrap_or(0);
        }
        println!(
            "{} 个模块 / {} 个源文件 / {} 个引用方 / {} ms",
            modules.len(),
            files,
            refs,
            started.elapsed().as_millis()
        );
    }

    #[test]
    fn changed_against_manifest_detects_edits_and_ignores_touch() {
        let root = tmp("changed-ab");
        let m = root.join("gl");
        let a = m.join("src/public/p/A.java");
        write(
            &a,
            "package p; public class A { public int f() { return 1; } }",
        );
        let l = ModuleLayout::resolve(&root, "gl");
        let files = l.collect_sources();
        let prev = updated_manifest(
            &l,
            None,
            &files,
            "cp",
            "cc",
            vec![],
            true,
            &HashMap::new(),
            false,
        );

        let changed = changed_against_manifest(&l, Some(&prev), &files);
        assert!(changed.is_empty(), "没改不该报变化");

        // touch：重写同样内容（stat 变、哈希不变）不算变
        write(
            &a,
            "package p; public class A { public int f() { return 1; } }",
        );
        assert!(changed_against_manifest(&l, Some(&prev), &files).is_empty());

        // 只改方法体：有改动（结构变没变由编译后的 class 指纹判，这里不猜）
        write(
            &a,
            "package p; public class A { public int f() { return 10; } }",
        );
        let changed = changed_against_manifest(&l, Some(&prev), &files);
        assert_eq!(changed.len(), 1);

        // struct_pending：哈希相同也要报变化（必须进编译轮补结构判定）
        write(
            &a,
            "package p; public class A { public int f() { return 1; } }",
        );
        let mut pending = prev.clone();
        pending.sources[0].struct_pending = true;
        assert_eq!(
            changed_against_manifest(&l, Some(&pending), &files).len(),
            1
        );
    }

    #[test]
    fn preserve_struct_keeps_old_fp_and_marks_pending() {
        let root = tmp("preserve");
        let m = root.join("gl");
        let a = m.join("src/public/p/A.java");
        write(&a, "package p; public class A { public void f() {} }");
        let l = ModuleLayout::resolve(&root, "gl");
        let files = l.collect_sources();
        let key = source_stamp(&l, &a, false).unwrap().key();
        let mut fps = HashMap::new();
        fps.insert(key.clone(), Some("fp-old".to_string()));
        let prev = updated_manifest(&l, None, &files, "cp", "cc", vec![], true, &fps, false);
        assert_eq!(prev.sources[0].struct_fp.as_deref(), Some("fp-old"));
        assert!(!prev.sources[0].struct_pending);

        // 保存快速编译（preserve_struct=true）：改了源码也不能把新指纹写进去，
        // 否则空闲增量永远看不见「结构变了」
        write(&a, "package p; public class A { public void f(int x) {} }");
        let fast = updated_manifest(
            &l,
            Some(&prev),
            &files,
            "cp",
            "cc",
            vec![],
            false,
            &HashMap::new(),
            true,
        );
        assert_eq!(fast.sources[0].struct_fp.as_deref(), Some("fp-old"));
        assert!(fast.sources[0].struct_pending);

        // 空闲增量（preserve_struct=false）：写真值、清 pending
        let mut fps2 = HashMap::new();
        fps2.insert(key, Some("fp-new".to_string()));
        let idle = updated_manifest(
            &l,
            Some(&fast),
            &files,
            "cp",
            "cc",
            vec![],
            false,
            &fps2,
            false,
        );
        assert_eq!(idle.sources[0].struct_fp.as_deref(), Some("fp-new"));
        assert!(!idle.sources[0].struct_pending);

        // 桥失败（fps 里是 None）：指纹置空 = 未知，下一轮按「可能变了」处理
        let mut fps3 = HashMap::new();
        fps3.insert(source_stamp(&l, &a, false).unwrap().key(), None);
        let unknown = updated_manifest(
            &l,
            Some(&idle),
            &files,
            "cp",
            "cc",
            vec![],
            false,
            &fps3,
            false,
        );
        assert!(unknown.sources[0].struct_fp.is_none());
        assert!(!unknown.sources[0].struct_pending);
    }

    #[test]
    fn schema1_manifest_is_invalidated() {
        let d = tmp("schema1");
        let mut m = Manifest {
            schema: 1,
            workspace: "C:/ws".into(),
            module: "gl".into(),
            source_roots: vec!["src/public".into()],
            outputs: vec!["classes".into()],
            sources: vec![],
            ext: ExtRefs::default(),
            classpath_fp: "a".into(),
            compiler_fp: "b".into(),
            seed_jars: vec![],
            last_success_ms: 1,
            last_attempt: None,
        };
        let p = d.join("gl.bin");
        write_manifest(&p, &m).unwrap();
        // 旧 schema（源码 ABI 时代）一律作废 → 调用方走全量，不能拿旧指纹当 class 指纹用
        assert!(read_manifest(&p, Path::new("C:/ws"), "gl").is_none());
        m.schema = SCHEMA;
        write_manifest(&p, &m).unwrap();
        assert!(read_manifest(&p, Path::new("C:/ws"), "gl").is_some());
    }

    #[test]
    fn clean_refuses_path_escape_in_manifest() {
        let root = tmp("escape");
        let m = root.join("gl");
        write(
            &m.join("src/public/p/A.java"),
            "package p; public class A {}",
        );
        let l = ModuleLayout::resolve(&root, "gl");
        let man = Manifest {
            schema: SCHEMA,
            workspace: build_layout::slash(&root),
            module: "gl".into(),
            source_roots: vec!["src/public".into()],
            outputs: vec!["classes".into()],
            sources: vec![SourceStamp {
                root: "src/public".into(),
                rel: "p/A.java".into(),
                out: "classes".into(),
                size: 1,
                mtime_ms: 1,
                package: "p".into(),
                hash: String::new(),
                struct_fp: None,
                struct_pending: false,
                types: vec![],
                ext: ExtRefs::default(),
                classes: vec!["../../outside.class".into()],
            }],
            ext: ExtRefs::default(),
            classpath_fp: "a".into(),
            compiler_fp: "b".into(),
            seed_jars: vec![],
            last_success_ms: 1,
            last_attempt: None,
        };
        let outside = root.join("outside.class");
        write(&outside, "x");
        let r = clean_module(&l, Some(&man), None, false);
        assert_eq!(r.removed, 0);
        assert!(!r.failed.is_empty());
        assert!(outside.exists());
    }

    // ───────────── decide_with_hint：脏集增量 stat ─────────────

    fn hint_setup(tag: &str) -> (PathBuf, ModuleLayout, Vec<PathBuf>, Manifest) {
        let root = tmp(tag);
        let m = root.join("gl");
        write(
            &m.join("src/public/p/A.java"),
            "package p; public class A { public int x; }",
        );
        write(
            &m.join("src/public/p/B.java"),
            "package p; public class B { public int y; }",
        );
        let l = ModuleLayout::resolve(&root, "gl");
        let files = l.collect_sources();
        let man = updated_manifest(
            &l,
            None,
            &files,
            "cp",
            "cc",
            vec![],
            true,
            &HashMap::new(),
            false,
        );
        (root, l, files, man)
    }

    fn hint(paths: Vec<PathBuf>, reliable: bool) -> crate::compile_dirty::DirtyHint {
        crate::compile_dirty::DirtyHint { paths, reliable }
    }

    #[test]
    fn 脏集可靠_空集直接skip() {
        let (_root, l, _files, man) = hint_setup("hint-empty");
        let d = decide_with_hint(&l, Some(&man), "cp", "cc", false, Some(&hint(vec![], true)));
        assert_eq!(d, Decision::Skip, "可靠空脏集应直接 Skip，不扫全模块");
    }

    #[test]
    fn 脏集可靠_只编脏文件() {
        let (root, l, files, man) = hint_setup("hint-one");
        let a = root.join("gl/src/public/p/A.java");
        write(
            &a,
            "package p; public class A { public int x; public int z; }",
        );
        let d = decide_with_hint(
            &l,
            Some(&man),
            "cp",
            "cc",
            false,
            Some(&hint(vec![a.clone()], true)),
        );
        match d {
            Decision::Incremental { files, .. } => {
                assert_eq!(files, vec![a], "只应编脏集里的 A");
            }
            other => panic!("应增量，got {other:?}"),
        }
        let _ = files;
    }

    #[test]
    fn 脏集不可信_回落全扫抓全部改动() {
        // 核心正确性守卫：hint 不可信时即便只报了 A，全扫也必须把 B 的改动一起抓出来。
        let (root, l, _files, man) = hint_setup("hint-unreliable");
        let a = root.join("gl/src/public/p/A.java");
        let b = root.join("gl/src/public/p/B.java");
        write(
            &a,
            "package p; public class A { public int x; public int z; }",
        );
        write(
            &b,
            "package p; public class B { public int y; public int w; }",
        );
        let d = decide_with_hint(
            &l,
            Some(&man),
            "cp",
            "cc",
            false,
            Some(&hint(vec![a.clone()], false)),
        );
        match d {
            Decision::Incremental { mut files, .. } => {
                files.sort();
                let mut want = vec![a, b];
                want.sort();
                assert_eq!(files, want, "不可信必须全扫，A/B 都抓到");
            }
            other => panic!("应全扫增量，got {other:?}"),
        }
    }

    #[test]
    fn 脏集可靠_删除被识别() {
        let (root, l, _files, man) = hint_setup("hint-remove");
        let a = root.join("gl/src/public/p/A.java");
        std::fs::remove_file(&a).unwrap();
        let d = decide_with_hint(
            &l,
            Some(&man),
            "cp",
            "cc",
            false,
            Some(&hint(vec![a.clone()], true)),
        );
        match d {
            Decision::Incremental { files, removed, .. } => {
                assert!(files.is_empty(), "只删除时没有文件要编");
                assert_eq!(removed.len(), 1);
                assert!(removed[0].path.ends_with("A.java"));
            }
            other => panic!("应识别删除，got {other:?}"),
        }
    }

    #[test]
    fn 脏集可靠_新增被识别() {
        let (root, l, _files, man) = hint_setup("hint-add");
        let c = root.join("gl/src/public/p/C.java");
        write(&c, "package p; public class C {}");
        let d = decide_with_hint(
            &l,
            Some(&man),
            "cp",
            "cc",
            false,
            Some(&hint(vec![c.clone()], true)),
        );
        match d {
            Decision::Incremental { files, .. } => assert_eq!(files, vec![c]),
            other => panic!("应识别新增，got {other:?}"),
        }
    }

    #[test]
    fn 脏集可靠_只信脏集_漏报的不发现() {
        // 钉住信任边界：可靠增量只看脏集，B 改了但不在脏集里就不发现——
        // 这正是「可靠」二字的分量，溢出/丢事件必须经 epoch 作废基线回落全扫。
        let (root, l, _files, man) = hint_setup("hint-trust");
        let a = root.join("gl/src/public/p/A.java");
        let b = root.join("gl/src/public/p/B.java");
        write(
            &a,
            "package p; public class A { public int x; public int z; }",
        );
        write(
            &b,
            "package p; public class B { public int y; public int w; }",
        );
        let d = decide_with_hint(
            &l,
            Some(&man),
            "cp",
            "cc",
            false,
            Some(&hint(vec![a.clone()], true)),
        );
        match d {
            Decision::Incremental { files, .. } => {
                assert_eq!(files, vec![a], "可靠增量只编脏集里的 A");
                assert!(!files.contains(&b), "B 不在脏集，增量不发现（信任边界）");
            }
            other => panic!("应增量，got {other:?}"),
        }
    }

    #[test]
    fn hint为none_走全扫() {
        let (root, l, _files, man) = hint_setup("hint-none");
        let a = root.join("gl/src/public/p/A.java");
        write(
            &a,
            "package p; public class A { public int x; public int z; }",
        );
        let d = decide_with_hint(&l, Some(&man), "cp", "cc", false, None);
        match d {
            Decision::Incremental { files, .. } => assert_eq!(files, vec![a]),
            other => panic!("None hint 应全扫增量，got {other:?}"),
        }
    }

    #[test]
    fn 并行scan与串行结果一致() {
        let root = tmp("scan-par");
        let m = root.join("gl");
        for i in 0..12 {
            write(
                &m.join(format!("src/public/p/C{i}.java")),
                &format!("package p; public class C{i} {{ public int v = {i}; }}"),
            );
        }
        let l = ModuleLayout::resolve(&root, "gl");
        let sources = l.collect_sources();
        for details in [false, true] {
            let serial = scan_with(&l, &sources, details, 1);
            let parallel = scan_with(&l, &sources, details, 4);
            assert_eq!(
                serial, parallel,
                "details={details} 并行必须与串行逐字段一致"
            );
            assert_eq!(serial.len(), 12);
        }
    }

    #[test]
    fn 脏集增量全流程_基线后只查脏文件_溢出回落() {
        use crate::compile_dirty as cd;
        let (root, l, _files, man) = hint_setup("hint-flow");
        let rs = l.source_roots.clone();
        let a = root.join("gl/src/public/p/A.java");
        let b = root.join("gl/src/public/p/B.java");
        // 启动作废 → 不可信 → 全扫（无变更）→ 建基线
        cd::invalidate(&root);
        assert!(!cd::hint(&root, "gl", &rs).reliable);
        let d = decide_with_hint(
            &l,
            Some(&man),
            "cp",
            "cc",
            false,
            Some(&cd::hint(&root, "gl", &rs)),
        );
        assert_eq!(d, Decision::Skip);
        cd::baseline(&root, "gl", &rs);
        // 基线后可靠空脏集 → 直接 Skip（不扫）
        let h = cd::hint(&root, "gl", &rs);
        assert!(h.reliable && h.paths.is_empty());
        assert_eq!(
            decide_with_hint(&l, Some(&man), "cp", "cc", false, Some(&h)),
            Decision::Skip
        );
        // 改 A + mark → 可靠增量只编 A → consume → 又空
        write(
            &a,
            "package p; public class A { public int x; public int z; }",
        );
        cd::mark(&root, std::slice::from_ref(&a), false, false);
        let h = cd::hint(&root, "gl", &rs);
        assert!(h.reliable && h.paths == vec![a.clone()]);
        match decide_with_hint(&l, Some(&man), "cp", "cc", false, Some(&h)) {
            Decision::Incremental { files, .. } => assert_eq!(files, vec![a.clone()]),
            other => panic!("应增量编 A，got {other:?}"),
        }
        cd::consume(&root, std::slice::from_ref(&a));
        assert!(cd::hint(&root, "gl", &rs).paths.is_empty());
        // 溢出 → 基线作废；此时改了 B（不在脏集）→ 不可信回落全扫必须抓到 B
        cd::mark(&root, &[], true, false);
        write(
            &b,
            "package p; public class B { public int y; public int w; }",
        );
        let h = cd::hint(&root, "gl", &rs);
        assert!(!h.reliable, "溢出后必须不可信");
        match decide_with_hint(&l, Some(&man), "cp", "cc", false, Some(&h)) {
            Decision::Incremental { files, .. } => {
                assert!(files.contains(&b), "回落全扫要抓到 B：{files:?}")
            }
            other => panic!("溢出回落应全扫增量，got {other:?}"),
        }
    }
}
