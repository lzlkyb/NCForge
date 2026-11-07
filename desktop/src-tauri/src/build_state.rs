//! 构建账本：上次编了什么、这次该编什么、清理能删什么。
//!
//! 这里是纯逻辑（不依赖 tauri），命令层只负责拿锁、取路径、推事件。三条纪律：
//!
//! 1. **清单是优化，不是正确性前提**。读不出来、版本不对、布局变了，一律当「没有清单」
//!    走全量，最多多编一次，不能因为账本坏了编错或删错。
//! 2. **清理只删声明过的产物**。有清单按清单；没清单只删能映射回源码的 `.class`，
//!    映射不上的列出来给用户看，不删。输出根目录、源码、`.classpath`、NC home 永不碰。
//! 3. **增量宁可多编**。源码级 ABI + 反向依赖都是近似：签名变了就把引用方带上，
//!    看不出来就全量；绝不靠时间戳猜依赖。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::build_layout::{self, ModuleLayout};
use crate::eclipse_cp::LinkedOverride;
use crate::workspace::decode_lossy;

/// 清单格式版本。字段或语义变化时 +1，旧清单自动作废。
pub const SCHEMA: u32 = 1;
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
    /// 源码级 ABI 指纹；`None` = 解析不出，按「可能变了」处理
    pub abi: Option<String>,
    /// 单文件编译只更新了 stat、没更新 ABI（见 `build_engine::compile_files`）。
    /// 下次模块级增量必须重新看这个文件，否则签名变更永远传播不到引用方。
    #[serde(default)]
    pub abi_stale: bool,
    /// 该源文件产出的 class（相对产物目录，含 `Outer$Inner.class`）
    #[serde(default)]
    pub classes: Vec<String>,
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
    /// 必须全量（首次、配置变化、增删文件、签名影响面过大）
    Full { reason: String },
    /// 只编这些文件（绝对路径）
    Incremental {
        files: Vec<PathBuf>,
        reason: String,
        /// 真正被改动的文件（`files` 里还包含被连带上的引用方）
        changed: Vec<PathBuf>,
        /// 是否检测到源码级 ABI 变化；跨模块传播只看这个
        abi_changed: bool,
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
    stamps: Vec<(String, u64, u64)>,
}

static JAR_STAMPS: Mutex<Option<JarStampCache>> = Mutex::new(None);

fn jar_stamps(nc_home: &Path) -> Vec<(String, u64, u64)> {
    let now = Instant::now();
    if let Ok(g) = JAR_STAMPS.lock() {
        if let Some(c) = g.as_ref() {
            if c.home == nc_home && now.duration_since(c.at) < JAR_STAMP_TTL {
                return c.stamps.clone();
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
    if let Ok(mut g) = JAR_STAMPS.lock() {
        *g = Some(JarStampCache {
            home: nc_home.to_path_buf(),
            at: now,
            stamps: stamps.clone(),
        });
    }
    stamps
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
    let mut cp: Vec<Vec<u8>> = vec![
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
    for (p, len, ms) in jar_stamps(nc_home) {
        cp.push(format!("{p}|{len}|{ms}").into_bytes());
    }

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
    let cp_refs: Vec<&[u8]> = cp.iter().map(|v| v.as_slice()).collect();
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

/// 扫描模块当前的源码。`with_abi=false` 只取 stat（快速判跳过）。
pub fn scan_sources(layout: &ModuleLayout, with_abi: bool) -> Vec<(PathBuf, SourceStamp)> {
    layout
        .collect_sources()
        .into_iter()
        .filter_map(|p| source_stamp(layout, &p, with_abi).map(|s| (p, s)))
        .collect()
}

pub fn source_stamp(layout: &ModuleLayout, path: &Path, with_abi: bool) -> Option<SourceStamp> {
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
        abi: None,
        abi_stale: false,
        classes: Vec::new(),
    };
    if with_abi {
        let text = decode_lossy(&std::fs::read(path).ok()?);
        stamp.package = crate::compile::extract_package(&text).unwrap_or_default();
        stamp.abi = abi_fingerprint(&text);
    }
    Some(stamp)
}

/// 源码级 ABI 指纹：public/protected 成员、类型声明、继承关系，去掉注释/字符串/方法体。
///
/// 宁可多报（把注解、泛型参数也算进去），不可漏报——漏一次就是「编译成功但运行期
/// 加载旧字节码」。解析不出声明时返回 `None`，调用方按「ABI 可能变了」处理。
pub fn abi_fingerprint(text: &str) -> Option<String> {
    let clean = strip_comments_and_literals(text);
    let mut statements = Vec::new();
    let mut buf = String::new();
    let mut depth = 0i32;
    for ch in clean.chars() {
        match ch {
            '{' => {
                if depth <= 2 {
                    push_decl(&mut statements, &buf);
                }
                buf.clear();
                depth = (depth + 1).min(64);
            }
            '}' => {
                buf.clear();
                depth = (depth - 1).max(0);
            }
            ';' => {
                if depth <= 2 {
                    push_decl(&mut statements, &buf);
                }
                buf.clear();
            }
            _ if depth <= 2 => buf.push(ch),
            _ => {}
        }
    }
    if statements.is_empty() {
        return None;
    }
    let joined = statements.join("\n");
    Some(sha(&[joined.as_bytes()]))
}

fn push_decl(out: &mut Vec<String>, buf: &str) {
    let s = buf.split_whitespace().collect::<Vec<_>>().join(" ");
    let s = s.trim();
    if s.is_empty() {
        return;
    }
    let type_decl = ["class ", "interface ", "enum ", "record "]
        .iter()
        .any(|k| s.contains(&format!(" {k}")) || s.starts_with(k));
    let member = s.starts_with("public ")
        || s.starts_with("protected ")
        || s.starts_with("abstract ")
        || s.starts_with("public(")
        || s.starts_with("protected(");
    if s.starts_with("package ") || type_decl || member {
        out.push(s.to_string());
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
            simple.insert(t.clone());
        }
        changed_pkgs.insert(deps.package.to_ascii_lowercase());
    }

    let changed_set: HashSet<String> = changed
        .iter()
        .map(|p| build_layout::slash(p).to_ascii_lowercase())
        .collect();
    let mut out = Vec::new();
    for p in all {
        if changed_set.contains(&build_layout::slash(p).to_ascii_lowercase()) {
            continue;
        }
        let Ok(bytes) = std::fs::read(p) else {
            continue;
        };
        // 快速预筛：正文字节里连类名都没出现（注释/字符串也算），不可能有引用。
        // 全工作区扫描时这一步省掉 95% 以上的解码与解析。
        if !may_mention(&bytes, &simple) {
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
    Some(out)
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

fn mentions_word(text: &str, name: &str) -> bool {
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

/// 全量编译时，哪些源文件相对旧清单真的变了（stat + ABI）。
///
/// 全量分支（新增/删除、超过阈值、类路径变化）也要知道签名有没有变：
/// 跨模块传播靠 `changed` / `abi_changed` 决定谁要跟着重编。
/// 先只 stat 全部文件，命中了才读文件算 ABI，避免全量时多扫一遍 7 千个源文件。
pub fn changed_against_manifest(
    layout: &ModuleLayout,
    manifest: Option<&Manifest>,
    files: &[PathBuf],
) -> (Vec<PathBuf>, bool) {
    let Some(m) = manifest else {
        return (Vec::new(), false);
    };
    let prev = m.sources_by_key();
    let mut changed = Vec::new();
    let mut abi_changed = false;
    for p in files {
        let Some(stamp) = source_stamp(layout, p, false) else {
            continue;
        };
        let old = prev.get(&stamp.key());
        let touched = match old {
            None => true,
            Some(o) => o.size != stamp.size || o.mtime_ms != stamp.mtime_ms || o.abi_stale,
        };
        if !touched {
            continue;
        }
        changed.push(p.clone());
        let Some(old) = old else {
            abi_changed = true;
            continue;
        };
        let Some(old_abi) = old.abi.clone() else {
            abi_changed = true;
            continue;
        };
        let Ok(bytes) = std::fs::read(p) else {
            abi_changed = true;
            continue;
        };
        if abi_fingerprint(&decode_lossy(&bytes)).as_deref() != Some(old_abi.as_str()) {
            abi_changed = true;
        }
    }
    (changed, abi_changed)
}

/// 决定这一轮怎么编。
pub fn decide(
    layout: &ModuleLayout,
    manifest: Option<&Manifest>,
    classpath_fp: &str,
    compiler_fp: &str,
    force_full: bool,
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

    let current = scan_sources(layout, false);
    let prev = m.sources_by_key();
    let mut modified: Vec<PathBuf> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut added = false;
    for (path, stamp) in &current {
        let key = stamp.key();
        seen.insert(key.clone());
        match prev.get(&key) {
            None => added = true,
            Some(old)
                if old.size != stamp.size || old.mtime_ms != stamp.mtime_ms || old.abi_stale =>
            {
                modified.push(path.clone())
            }
            _ => {}
        }
    }
    let removed = prev.keys().any(|k| !seen.contains(k));
    if added || removed {
        return Decision::Full {
            reason: if added {
                "检测到新增源文件（可能被任何同包 / 通配 import 引用）".to_string()
            } else {
                "检测到删除或改名".to_string()
            },
        };
    }
    if modified.is_empty() {
        return Decision::Skip;
    }

    // 只改了方法体：ABI 不变，只编改动的文件
    let mut abi_changed = false;
    for p in &modified {
        let text = match std::fs::read(p) {
            Ok(b) => decode_lossy(&b),
            Err(_) => {
                abi_changed = true;
                break;
            }
        };
        let now_abi = abi_fingerprint(&text);
        let key = source_stamp(layout, p, false).map(|s| s.key());
        let old = key.as_ref().and_then(|k| prev.get(k));
        match (now_abi, old.and_then(|s| s.abi.clone())) {
            (Some(a), Some(b)) if a == b => {}
            _ => {
                abi_changed = true;
                break;
            }
        }
    }
    if abi_changed {
        let all: Vec<PathBuf> = current.iter().map(|(p, _)| p.clone()).collect();
        let Some(refs) = referrers(&modified, &all) else {
            return Decision::Full {
                reason: "无法解析被修改文件的类型声明，保守走全量".to_string(),
            };
        };
        let mut files = modified.clone();
        files.extend(refs);
        files.sort();
        files.dedup();
        // 增量反而要编 30% 以上：直接全量，别让“增量”比全量还慢
        if files.len() * 100 > all.len().saturating_mul(30) {
            return Decision::Full {
                reason: format!(
                    "签名变化影响 {} / {} 个源文件（超过 30%），改跑全量",
                    files.len(),
                    all.len()
                ),
            };
        }
        return Decision::Incremental {
            reason: format!(
                "{} 个文件签名变化，连带 {} 个引用方",
                modified.len(),
                files.len() - modified.len()
            ),
            files,
            changed: modified,
            abi_changed: true,
        };
    }
    Decision::Incremental {
        reason: format!("{} 个文件内容变化，签名未变", modified.len()),
        files: modified.clone(),
        changed: modified,
        abi_changed: false,
    }
}

// ───────────────────────────── 清单更新 / 旧产物 ─────────────────────────────

/// 编译成功后更新清单。`compiled` 为本次实际参与编译的文件；全量传全部源文件。
pub fn updated_manifest(
    layout: &ModuleLayout,
    previous: Option<&Manifest>,
    compiled: &[PathBuf],
    classpath_fp: &str,
    compiler_fp: &str,
    seed_jars: Vec<u32>,
    full: bool,
) -> Manifest {
    let compiled_set: HashSet<String> = compiled
        .iter()
        .map(|p| build_layout::slash(p).to_ascii_lowercase())
        .collect();
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
        classpath_fp: classpath_fp.to_string(),
        compiler_fp: compiler_fp.to_string(),
        seed_jars,
        last_success_ms: now_ms(),
        last_attempt: None,
    }
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
    fn abi_ignores_method_bodies_comments_and_strings() {
        let a = "package p;\npublic class A { public void f() { int x = 1; } }";
        let b = "package p;\n// x\npublic class A { public void f() { int y = 2; String s = \"public void g()\"; } }";
        assert_eq!(abi_fingerprint(a), abi_fingerprint(b));
    }

    #[test]
    fn abi_changes_with_signature_and_visibility() {
        let a = "public class A { public void f(int x) {} }";
        let b = "public class A { public void f(String x) {} }";
        let c = "public class A { protected void f(int x) {} }";
        assert_ne!(abi_fingerprint(a), abi_fingerprint(b));
        assert_ne!(abi_fingerprint(a), abi_fingerprint(c));
    }

    #[test]
    fn abi_includes_extends_and_public_fields() {
        let a = "public class A extends B { public int x; }";
        let b = "public class A extends C { public int x; }";
        let c = "public class A extends B { public long x; }";
        assert_ne!(abi_fingerprint(a), abi_fingerprint(b));
        assert_ne!(abi_fingerprint(a), abi_fingerprint(c));
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
                abi: None,
                abi_stale: false,
                classes: vec!["p/A.class".into()],
            }],
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
        let man = updated_manifest(&l, None, &all, "cp", "cc", vec![], true);
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

        // 改签名：B 被连带
        write(
            &m.join("src/public/p/A.java"),
            "package p; public class A { public void f(int x) {} }",
        );
        match decide(&l, Some(&man), "cp", "cc", false) {
            Decision::Incremental { files, .. } => assert_eq!(files.len(), 2),
            other => panic!("expected incremental with referrer, got {other:?}"),
        }

        // 新增文件：全量
        write(
            &m.join("src/public/p/C.java"),
            "package p; public class C {}",
        );
        assert!(matches!(
            decide(&l, Some(&man), "cp", "cc", false),
            Decision::Full { .. }
        ));
        // 配置变化：全量
        assert!(matches!(
            decide(&l, Some(&man), "other", "cc", false),
            Decision::Full { .. }
        ));
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
        let prev = updated_manifest(&l, None, &l.collect_sources(), "cp", "cc", vec![], true);
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
    fn changed_against_manifest_detects_body_and_signature_edits() {
        let root = tmp("changed-ab");
        let m = root.join("gl");
        let a = m.join("src/public/p/A.java");
        write(
            &a,
            "package p; public class A { public int f() { return 1; } }",
        );
        let l = ModuleLayout::resolve(&root, "gl");
        let files = l.collect_sources();
        let prev = updated_manifest(&l, None, &files, "cp", "cc", vec![], true);

        let (changed, abi) = changed_against_manifest(&l, Some(&prev), &files);
        assert!(changed.is_empty() && !abi, "没改不该报变化");

        // 只改方法体：有改动、签名没变
        write(
            &a,
            "package p; public class A { public int f() { return 10; } }",
        );
        let (changed, abi) = changed_against_manifest(&l, Some(&prev), &files);
        assert_eq!(changed.len(), 1);
        assert!(!abi);

        // 改返回类型：签名变了
        write(
            &a,
            "package p; public class A { public long f() { return 10; } }",
        );
        let (changed, abi) = changed_against_manifest(&l, Some(&prev), &files);
        assert_eq!(changed.len(), 1);
        assert!(abi);
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
                abi: None,
                abi_stale: false,
                classes: vec!["../../outside.class".into()],
            }],
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
}
