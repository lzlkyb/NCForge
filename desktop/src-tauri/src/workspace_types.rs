//! 工作区类型索引：不等 jdt.ls，直接按源码回答「这个类在哪」。
//!
//! 背景：类型搜索过去只有 `workspace/symbol` 一条路。jdt.ls 要先生成影子工程、导入、
//! 建索引（实测 init → build 约 11 秒），第一次搜类时用户就在空输入框前等；而工作区
//! 里的类明明写在磁盘上，package 与声明都在同一份 `.java` 里。
//!
//! 这里只做一件事：把各模块源码的「包名 + 声明类型 + 位置」扫一遍，按文件大小 + mtime
//! 做增量刷新并落盘缓存。进程内再叠一层短 TTL，连续敲键时不会反复 stat 整棵树。
//!
//! 源码根仍以 `.classpath` 为准（工程根与模块级都读），目录发现只做兜底。纯逻辑模块，
//! 不含 tauri 类型。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::build_layout::{self, ModuleLayout};
use crate::eclipse_cp::ProjectCp;

/// 缓存版式：字段变了就加一，旧缓存自然失效。（2：加入成员声明）
const CACHE_VERSION: u32 = 2;
/// 一份缓存的上限。正常工程是几 MB；坏文件不能换来无界分配。
const CACHE_CAP: u64 = 64 * 1024 * 1024;
/// 单文件上限：源码不该有这么大，超了多半不是源码。
const MAX_SOURCE: u64 = 4 * 1024 * 1024;
/// 进程内结果的有效期。过期不阻塞查询（见 [`shared`]）：先返回旧索引、后台重建。
///
/// 取 30 分钟而不是几十秒：这台机器上遍历七千多个 `.java` + 逐个 stat 要十几秒
/// （机械盘 + 杀毒扫描），定时校准等于隔一会儿就和搜索抢一次磁盘。文件改动改由
/// 文件监听显式标记（见 [`mark_dirty`]），不需要靠定时纠偏。
const TTL: Duration = Duration::from_secs(30 * 60);

/// 一条类型命中。工作区条目 `file` 有值，jar 条目不经过本模块（见 `commands::type_search_cmds`）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeHit {
    /// 全限定名（嵌套类型暂按「包 + 简单名」记录）。
    pub name: String,
    pub simple: String,
    pub package: String,
    /// LSP SymbolKind：5 类 / 10 枚举 / 11 接口。
    pub kind: u8,
    pub file: String,
    pub module: String,
    /// jar 条目的绝对路径；工作区源码条目为空。
    pub jar: String,
    /// 声明位置（1 基）。跳转直接落到类声明行。
    pub line: u32,
    pub column: u32,
}

#[derive(Debug)]
struct IndexedType {
    hit: TypeHit,
    /// 驼峰首字母（小写）。预先算好，查询时零分配——十几万条逐条现算要 200ms 起。
    initials: String,
}

/// 一条成员命中（方法 / 字段级）。工作区符号搜索用它，不再等 jdt.ls。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolHit {
    pub name: String,
    /// 所属类型（嵌套类是 `Outer.Inner`）。
    pub container: String,
    /// LSP SymbolKind：6 方法 / 8 字段 / 9 构造器 / 14 常量 / 22 枚举成员
    pub kind: u8,
    pub file: String,
    pub module: String,
    pub line: u32,
    pub column: u32,
}

/// 成员条目按文件下标引用路径：七千多个文件、十万级成员，逐条存 String 太重。
#[derive(Debug)]
struct IndexedSymbol {
    name: String,
    initials: String,
    container: String,
    kind: u8,
    file: u32,
    line: u32,
    column: u32,
}

#[derive(Debug)]
struct SourceFile {
    path: String,
    module: String,
}

#[derive(Debug)]
pub struct WorkspaceTypes {
    entries: Vec<IndexedType>,
    /// 与 `symbols.file` 一一对应。
    files: Vec<SourceFile>,
    symbols: Vec<IndexedSymbol>,
    built_at: Instant,
}

impl WorkspaceTypes {
    pub fn search(&self, query: &str, limit: usize) -> Vec<TypeHit> {
        if query.is_empty() || query.len() > 100 || limit == 0 {
            return Vec::new();
        }
        let mut scored: Vec<(u8, &IndexedType)> = self
            .entries
            .iter()
            .filter_map(|e| {
                crate::java_types::type_match_score_with(query, &e.hit.simple, Some(&e.initials))
                    .map(|s| (s, e))
            })
            .collect();
        scored.sort_by(|a, b| {
            a.0.cmp(&b.0)
                .then(a.1.hit.simple.len().cmp(&b.1.hit.simple.len()))
                .then(a.1.hit.name.cmp(&b.1.hit.name))
                .then(a.1.hit.file.cmp(&b.1.hit.file))
        });
        scored.truncate(limit);
        scored.into_iter().map(|(_, e)| e.hit.clone()).collect()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// 按名字匹配方法 / 字段。打分规则与类型搜索同一份（`type_match_score`）：
    /// 完全相同 > 前缀 > 驼峰首字母 > 包含，两类结果的排序口径才不会分叉。
    pub fn search_symbols(&self, query: &str, limit: usize) -> Vec<SymbolHit> {
        if query.is_empty() || query.len() > 100 || limit == 0 {
            return Vec::new();
        }
        let mut scored: Vec<(u8, &IndexedSymbol)> = self
            .symbols
            .iter()
            .filter_map(|s| {
                crate::java_types::type_match_score_with(query, &s.name, Some(&s.initials))
                    .map(|sc| (sc, s))
            })
            .collect();
        scored.sort_by(|a, b| {
            a.0.cmp(&b.0)
                .then(a.1.name.len().cmp(&b.1.name.len()))
                .then(a.1.container.cmp(&b.1.container))
                .then(a.1.file.cmp(&b.1.file))
                .then(a.1.line.cmp(&b.1.line))
        });
        scored.truncate(limit);
        scored
            .into_iter()
            .filter_map(|(_, s)| {
                let f = self.files.get(s.file as usize)?;
                Some(SymbolHit {
                    name: s.name.clone(),
                    container: s.container.clone(),
                    kind: s.kind,
                    file: f.path.clone(),
                    module: f.module.clone(),
                    line: s.line,
                    column: s.column,
                })
            })
            .collect()
    }

    pub fn symbol_len(&self) -> usize {
        self.symbols.len()
    }
}

struct Shared {
    key: String,
    index: Arc<WorkspaceTypes>,
    /// 是不是经过全树 stat 校准过。只从磁盘缓存读出来的那份是 false：
    /// 它可能已经过期，下一次查询要触发后台校准。
    verified: bool,
}

static SHARED: Mutex<Option<Shared>> = Mutex::new(None);
/// 建索引的闸门：同一时刻只有一份在扫盘，后来的等它建完直接用。
static BUILD: Mutex<()> = Mutex::new(());
/// 后台重建的单飞标志（见 [`spawn_rebuild`]）。
static REBUILDING: AtomicBool = AtomicBool::new(false);
/// 源码刚被改过的标记：下一次查询触发后台重建。
static DIRTY: AtomicBool = AtomicBool::new(false);

/// 有人改了源码：让下一次查询触发后台重建。
///
/// 由文件监听（`watcher`）在 `.java` 变化时调用。它与 TTL 是两条独立路径：
/// 定时校准太贵（一次全树 stat 十几秒），按事件标记才能既不漏改动又不空转。
pub fn mark_dirty() {
    DIRTY.store(true, Ordering::SeqCst);
}

/// 取（必要时重建）工作区索引。
///
/// **过期的索引也照给**：重建要遍历七千多个 `.java` 并逐个 stat，几百毫秒起，
/// 而快速面板每敲一个字母都会问一次。让用户按键时等重建，远比「晚半秒看到新建
/// 的类」代价大。所以过期就先把旧的返回，后台再校准一次（stale-while-revalidate）。
///
/// 只有在**一份都没有**（首次查询、刚换工作区）时才同步建。
pub fn shared(root: &Path, cache_dir: &Path) -> Arc<WorkspaceTypes> {
    let key = norm(root);
    if let Some((index, fresh)) = peek(&key) {
        if !fresh {
            spawn_rebuild(key, root.to_path_buf(), cache_dir.to_path_buf());
        }
        return index;
    }
    // 磁盘上有缓存就先给出去（读 JSON 几百毫秒），全树 stat 交给后台
    if let Some(index) = load_cached_only(root, cache_dir) {
        let index = Arc::new(index);
        store(&key, index.clone(), false);
        spawn_rebuild(key, root.to_path_buf(), cache_dir.to_path_buf());
        return index;
    }
    rebuild_now(&key, root, cache_dir)
}

/// 同 [`shared`]，但一份索引都没有时**不阻塞**：起后台构建，先返回 `None`。
///
/// 冷建要读完整个源码树（newar 上 61MB，实测近百秒）。把它放进查询路径，用户
/// 第一次搜类就卡在那里；返回「正在建索引」、界面退回文件名匹配反而即时。
/// 已经有一份（哪怕过期）就照 [`shared`] 的 SWR 逻辑给旧索引。
pub fn shared_opt(root: &Path, cache_dir: &Path) -> Option<Arc<WorkspaceTypes>> {
    let key = norm(root);
    if let Some((index, fresh)) = peek(&key) {
        if !fresh {
            spawn_rebuild(key, root.to_path_buf(), cache_dir.to_path_buf());
        }
        return Some(index);
    }
    if let Some(index) = load_cached_only(root, cache_dir) {
        let index = Arc::new(index);
        store(&key, index.clone(), false);
        spawn_rebuild(key, root.to_path_buf(), cache_dir.to_path_buf());
        return Some(index);
    }
    spawn_rebuild(key, root.to_path_buf(), cache_dir.to_path_buf());
    None
}

/// 取当前索引并说明是否还在 TTL 内。
fn peek(key: &str) -> Option<(Arc<WorkspaceTypes>, bool)> {
    let guard = SHARED.lock().unwrap_or_else(|e| e.into_inner());
    let s = guard.as_ref()?;
    if s.key != key {
        return None;
    }
    let fresh = s.verified && !DIRTY.load(Ordering::SeqCst) && s.index.built_at.elapsed() < TTL;
    Some((s.index.clone(), fresh))
}

/// 同步重建（占住 `BUILD` 闸门）。期间别的线程会等在同一把锁上，建完直接复用。
fn rebuild_now(key: &str, root: &Path, cache_dir: &Path) -> Arc<WorkspaceTypes> {
    let _gate = BUILD.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((index, fresh)) = peek(key) {
        if fresh {
            return index;
        }
    }
    // 建之前清标记：构建期间再有改动，watcher 会重新置位，下一轮再校准
    DIRTY.store(false, Ordering::SeqCst);
    let index = Arc::new(build(root, cache_dir));
    store(key, index.clone(), true);
    index
}

fn store(key: &str, index: Arc<WorkspaceTypes>, verified: bool) {
    *SHARED.lock().unwrap_or_else(|e| e.into_inner()) = Some(Shared {
        key: key.to_string(),
        index,
        verified,
    });
}

/// 后台校准一次索引。单飞：已经有一个在跑就不再起（连续敲键不要排一队扫盘）。
fn spawn_rebuild(key: String, root: PathBuf, cache_dir: PathBuf) {
    if REBUILDING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        // panic 也要放掉标志，否则这个进程内再也不会自动校准
        struct Release;
        impl Drop for Release {
            fn drop(&mut self) {
                REBUILDING.store(false, Ordering::SeqCst);
            }
        }
        let _release = Release;
        rebuild_now(&key, &root, &cache_dir);
    });
}

// ───────────────────────── 建索引 ─────────────────────────

#[derive(Serialize, Deserialize)]
struct CachedIndex {
    version: u32,
    root: String,
    files: Vec<CachedFile>,
}

#[derive(Serialize, Deserialize, Clone)]
struct CachedFile {
    /// 规整过的绝对路径（`/` 分隔、小写比较键），与发现阶段一致。
    path: String,
    /// 原始大小写的绝对路径：打开文件与界面展示都用它（小写路径在 Linux 上打不开）。
    #[serde(default)]
    raw: String,
    /// 所属模块。存进缓存而不是每次从 `.classpath` 重算，模块被删改后仍能显示归属。
    #[serde(default)]
    module: String,
    size: u64,
    modified: u128,
    package: String,
    types: Vec<CachedType>,
    /// 方法 / 字段 / 构造器 / 枚举常量。空 = 这个文件里没解析到（不是文件没有）。
    #[serde(default)]
    members: Vec<CachedMember>,
}

impl CachedFile {
    fn display_path(&self) -> &str {
        if self.raw.is_empty() {
            &self.path
        } else {
            &self.raw
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
struct CachedMember {
    name: String,
    /// 所属类型（嵌套类是 `Outer.Inner`）。
    container: String,
    /// LSP SymbolKind
    kind: u8,
    line: u32,
    column: u32,
}

#[derive(Serialize, Deserialize, Clone)]
struct CachedType {
    name: String,
    /// LSP SymbolKind
    kind: u8,
    line: u32,
    column: u32,
}

/// 把一批**已解析**的文件组装成可查询的索引。
fn assemble(files: Vec<CachedFile>) -> WorkspaceTypes {
    let mut entries: Vec<IndexedType> = Vec::new();
    let mut sources: Vec<SourceFile> = Vec::new();
    let mut symbols: Vec<IndexedSymbol> = Vec::new();
    for entry in files {
        let file_text = entry.display_path().to_string();
        let module = entry.module.clone();
        for t in &entry.types {
            entries.push(IndexedType {
                initials: crate::java_types::initials_of(&t.name),
                hit: TypeHit {
                    name: if entry.package.is_empty() {
                        t.name.clone()
                    } else {
                        format!("{}.{}", entry.package, t.name)
                    },
                    simple: t.name.clone(),
                    package: entry.package.clone(),
                    kind: t.kind,
                    file: file_text.clone(),
                    module: module.clone(),
                    jar: String::new(),
                    line: t.line,
                    column: t.column,
                },
            });
        }
        // 成员表按文件引用路径：只有真有成员的文件才占一个下标
        if !entry.members.is_empty() {
            let idx = sources.len() as u32;
            sources.push(SourceFile {
                path: file_text.clone(),
                module,
            });
            for m in &entry.members {
                symbols.push(IndexedSymbol {
                    name: m.name.clone(),
                    initials: crate::java_types::initials_of(&m.name),
                    container: m.container.clone(),
                    kind: m.kind,
                    file: idx,
                    line: m.line,
                    column: m.column,
                });
            }
        }
    }
    WorkspaceTypes {
        entries,
        files: sources,
        symbols,
        built_at: Instant::now(),
    }
}

/// 只读磁盘缓存、**不做任何文件系统校验**。
///
/// 启动后第一件事就是它：读十几 MB JSON 几百毫秒，而「逐个 stat 七千个文件」在这台
/// 机器上要十几秒（机械盘 + 杀毒）。先给旧的、后台校准——`verified = false` 会让下一次
/// 查询触发重建，所以旧数据最多用一次。
fn load_cached_only(root: &Path, cache_dir: &Path) -> Option<WorkspaceTypes> {
    let cache = load_cache(&cache_path(cache_dir, root), root)?;
    Some(assemble(cache.files))
}

fn build(root: &Path, cache_dir: &Path) -> WorkspaceTypes {
    let mut seen: HashSet<String> = HashSet::new();
    let mut files: Vec<(PathBuf, String)> = Vec::new();
    for (dir, module) in source_roots(root) {
        let mut found = Vec::new();
        build_layout::walk_java(&dir, &mut found);
        for f in found {
            if seen.insert(norm(&f)) {
                files.push((f, module.clone()));
            }
        }
    }
    files.sort_by_key(|a| norm(&a.0));

    let cache_path = cache_path(cache_dir, root);
    let mut cached: HashMap<String, CachedFile> = load_cache(&cache_path, root)
        .map(|c| c.files.into_iter().map(|f| (f.path.clone(), f)).collect())
        .unwrap_or_default();

    let mut saved: Vec<CachedFile> = Vec::with_capacity(files.len());
    let mut changed = false;
    for (file, module) in files {
        let Ok(md) = std::fs::metadata(&file) else {
            continue;
        };
        if !md.is_file() || md.len() > MAX_SOURCE {
            continue;
        }
        let modified = md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_nanos());
        let key = norm(&file);
        let entry = match cached.remove(&key) {
            Some(c) if c.size == md.len() && c.modified == modified => c,
            _ => {
                changed = true;
                parse_file(&file, &key, md.len(), modified, &module)
            }
        };
        saved.push(entry);
    }
    if changed || !cached.is_empty() {
        write_cache(&cache_path, root, &saved);
    }
    assemble(saved)
}

fn parse_file(path: &Path, key: &str, size: u64, modified: u128, module: &str) -> CachedFile {
    let empty = || CachedFile {
        path: key.to_string(),
        raw: path.to_string_lossy().to_string(),
        module: module.to_string(),
        size,
        modified,
        package: String::new(),
        types: Vec::new(),
        members: Vec::new(),
    };
    let Ok(bytes) = std::fs::read(path) else {
        return empty();
    };
    let text = crate::workspace::decode_lossy(&bytes);
    let clean = crate::build_state::strip_comments_and_literals(&text);
    let package = crate::compile::extract_package(&clean).unwrap_or_default();
    let types = crate::build_state::typed_declarations(&clean)
        .into_iter()
        .map(|(name, kind, offset)| {
            let (line, column) = line_col(&clean, offset);
            CachedType {
                name,
                kind: match kind {
                    "interface" => 11,
                    "enum" => 10,
                    _ => 5,
                },
                line,
                column,
            }
        })
        .collect();
    // 成员位置：先记一遍行首偏移再二分。逐个从文首数换行是 O(成员数 × 文件长度)，
    // 大文件上累积起来能到几百毫秒，而这些开销每次改文件都要付一次。
    let decls = crate::java_members::members(&clean);
    let members = if decls.is_empty() {
        Vec::new()
    } else {
        let mut starts = vec![0usize];
        for (i, b) in clean.bytes().enumerate() {
            if b == b'\n' {
                starts.push(i + 1);
            }
        }
        decls
            .into_iter()
            .map(|m| {
                let at = m.offset.min(clean.len());
                let line = starts.partition_point(|s| *s <= at).saturating_sub(1);
                let column = clean[starts[line]..at].chars().count() as u32 + 1;
                CachedMember {
                    name: m.name,
                    container: m.container,
                    kind: m.kind,
                    line: line as u32 + 1,
                    column,
                }
            })
            .collect()
    };
    CachedFile {
        path: key.to_string(),
        raw: path.to_string_lossy().to_string(),
        module: module.to_string(),
        size,
        modified,
        package,
        types,
        members,
    }
}

fn line_col(text: &str, offset: usize) -> (u32, u32) {
    let before = &text[..offset.min(text.len())];
    let line = before.bytes().filter(|b| *b == b'\n').count() as u32 + 1;
    let column = before
        .rsplit('\n')
        .next()
        .map_or(1, |s| s.chars().count() as u32 + 1);
    (line, column)
}

/// 源码根 → 模块名。工程根 `.classpath` 优先，再补模块自己的 `.classpath` / 老约定。
fn source_roots(root: &Path) -> Vec<(PathBuf, String)> {
    let mut out: Vec<(PathBuf, String)> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut push = |dir: PathBuf, module: String| {
        if dir.is_dir() && seen.insert(norm(&dir)) {
            out.push((dir, module));
        }
    };

    if let Some(cp) = ProjectCp::load(root) {
        for src in &cp.srcs {
            let rel = build_layout::slash(&src.path);
            let rel = rel.trim_matches('/');
            if rel.is_empty() || is_test_root(rel) {
                continue;
            }
            let first = rel.split('/').next().unwrap_or("");
            let module = if first.is_empty() || first.eq_ignore_ascii_case("src") {
                String::new()
            } else {
                first.to_string()
            };
            push(root.join(&src.path), module);
        }
    }

    let Ok(rd) = std::fs::read_dir(root) else {
        return out;
    };
    let mut names: Vec<String> = rd
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .filter(|n| !n.starts_with('.') && !n.eq_ignore_ascii_case("out"))
        .collect();
    names.sort();
    for name in names {
        let layout = ModuleLayout::resolve(root, &name);
        for dir in layout.source_roots {
            push(dir, name.clone());
        }
    }
    out
}

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

// ───────────────────────── 缓存 ─────────────────────────

fn cache_path(cache_dir: &Path, root: &Path) -> PathBuf {
    cache_dir.join(format!("{:016x}.json", fnv(&norm(root))))
}

fn load_cache(path: &Path, root: &Path) -> Option<CachedIndex> {
    let md = std::fs::metadata(path).ok()?;
    if md.len() > CACHE_CAP {
        return None;
    }
    let file = std::fs::File::open(path).ok()?;
    let cache: CachedIndex = serde_json::from_reader(std::io::BufReader::new(file)).ok()?;
    (cache.version == CACHE_VERSION && cache.root == norm(root)).then_some(cache)
}

fn write_cache(path: &Path, root: &Path, files: &[CachedFile]) {
    let Some(parent) = path.parent() else {
        return;
    };
    if std::fs::create_dir_all(parent).is_err() {
        return;
    }
    let cache = CachedIndex {
        version: CACHE_VERSION,
        root: norm(root),
        files: files.to_vec(),
    };
    let temp = path.with_extension("json.tmp");
    let result = std::fs::File::create(&temp).and_then(|file| {
        serde_json::to_writer(std::io::BufWriter::new(file), &cache).map_err(std::io::Error::other)
    });
    if result.is_ok() {
        let _ = std::fs::rename(&temp, path);
    } else {
        let _ = std::fs::remove_file(&temp);
    }
}

fn norm(p: &Path) -> String {
    build_layout::slash(p).to_ascii_lowercase()
}

/// FNV-1a：缓存文件名要跨进程稳定，不能依赖 `DefaultHasher`。
fn fnv(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ncforge-ws-types-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn write(root: &Path, rel: &str, text: &str) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    #[test]
    fn scans_all_modules_by_classpath_and_reports_declaration_line() {
        let root = tmp("scan");
        std::fs::write(
            root.join(".classpath"),
            r#"<classpath>
              <classpathentry kind="src" path="baseapp/src/public" output="out/baseapp"/>
              <classpathentry kind="output" path="out/bin"/>
            </classpath>"#,
        )
        .unwrap();
        write(
            &root,
            "baseapp/src/public/nc/vo/VoucherBillOrder.java",
            "package nc.vo;\n\n// class Fake {}\npublic class VoucherBillOrder {\n  String s = \"class AlsoFake\";\n}\n",
        );
        write(
            &root,
            "gl/src/client/nc/itf/ia/BaseDaoUtils.java",
            "package nc.itf.ia;\npublic interface BaseDaoUtils {}\n",
        );
        write(
            &root,
            "gl/src/client/nc/vo/Kind.java",
            "package nc.enums;\npublic enum Kind { A, B }\n",
        );
        // 测试源码不参与：同名类不能从测试目录挤进来
        write(
            &root,
            "gl/src/test/nc/vo/VoucherBillOrder.java",
            "package nc.vo;\nclass VoucherBillOrder {}\n",
        );

        let cache = root.join("cache");
        let idx = build(&root, &cache);
        let hits = idx.search("VBO", 20);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].name, "nc.vo.VoucherBillOrder");
        assert_eq!(hits[0].module, "baseapp");
        // 声明在第 4 行：注释与字符串里的假类不能命中，位置也不能被它们带偏
        assert_eq!((hits[0].line, hits[0].column), (4, 14));

        let dao = idx.search("BaseDao", 20);
        assert_eq!(dao.len(), 1, "测试目录的副本不应出现");
        assert_eq!(dao[0].kind, 11);
        assert!(dao[0]
            .file
            .replace('\\', "/")
            .to_lowercase()
            .contains("gl/src/client"));

        let kind = idx.search("Kind", 20);
        assert_eq!(kind[0].kind, 10);

        // 第二份直接读缓存：内容一致
        let again = build(&root, &cache);
        assert_eq!(again.len(), idx.len());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn cache_is_incremental_for_touched_files_and_drops_deleted_ones() {
        let root = tmp("inc");
        write(
            &root,
            "m/src/public/p/Old.java",
            "package p;\npublic class Old {}\n",
        );
        let cache = root.join("cache");
        let first = build(&root, &cache);
        assert_eq!(first.search("Old", 10).len(), 1);

        write(
            &root,
            "m/src/public/p/Old.java",
            "package p;\npublic class Old {}\nclass AddedLater {}\n",
        );
        let second = build(&root, &cache);
        assert_eq!(second.search("AddedLater", 10).len(), 1, "改过的文件要重扫");

        std::fs::remove_file(root.join("m/src/public/p/Old.java")).unwrap();
        let third = build(&root, &cache);
        assert!(
            third.search("Old", 10).is_empty(),
            "删掉的文件不能留在索引里"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn indexes_members_for_symbol_search() {
        let root = tmp("sym");
        write(
            &root,
            "m/src/public/p/Bill.java",
            "package p;\npublic class Bill {\n    private String no;\n    public String getNo() { return no; }\n    void setNo(String n) { this.no = n; }\n}\n",
        );
        let idx = build(&root, &root.join("cache"));
        let hits = idx.search_symbols("getNo", 10);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].name, "getNo");
        assert_eq!(hits[0].container, "Bill");
        assert_eq!(hits[0].kind, 6);
        assert_eq!((hits[0].line, hits[0].column), (4, 19));
        assert_eq!(hits[0].module, "m");
        assert!(hits[0].file.replace('\\', "/").ends_with("p/Bill.java"));

        // 驼峰首字母与字段名都要能搜到：这是「找方法」的主要用法
        assert!(idx
            .search_symbols("gn", 10)
            .iter()
            .any(|h| h.name == "getNo"));
        assert_eq!(
            idx.search_symbols("no", 10)
                .iter()
                .filter(|h| h.name == "no")
                .count(),
            1
        );

        // 缓存往返：成员不能因为读缓存就丢掉
        let again = build(&root, &root.join("cache"));
        assert_eq!(again.symbol_len(), idx.symbol_len());
        assert_eq!(again.search_symbols("getNo", 10)[0].name, "getNo");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 真机：在 newar 上量一遍成员索引的规模与耗时。手动跑：
    /// `cargo test --lib -- 真机_成员索引 --ignored --nocapture`
    #[test]
    #[ignore]
    fn 真机_成员索引规模与耗时() {
        let root = PathBuf::from(r"C:\work\aier\newar");
        if !root.is_dir() {
            return;
        }
        let cache = crate::test_support::tmp("wt-bench");
        let t = Instant::now();
        let cold = build(&root, &cache);
        let cold_ms = t.elapsed().as_millis();
        let t = Instant::now();
        let warm = build(&root, &cache);
        let warm_ms = t.elapsed().as_millis();
        let t = Instant::now();
        let fast = load_cached_only(&root, &cache).expect("刚写过缓存");
        let fast_ms = t.elapsed().as_millis();
        let t = Instant::now();
        let hits = warm.search_symbols("getBillNo", 20);
        let q_us = t.elapsed().as_micros();
        println!(
            "冷建 {cold_ms} ms / 热建 {warm_ms} ms / 只读缓存 {fast_ms} ms，类型 {} 条，成员 {} 条",
            cold.len(),
            warm.symbol_len()
        );
        assert_eq!(
            fast.symbol_len(),
            warm.symbol_len(),
            "缓存路径与全树校验结果一致"
        );
        println!("搜 getBillNo：{} 条 / {q_us} µs", hits.len());
        for h in hits.iter().take(3) {
            println!("  {} · {}:{},{}", h.name, h.file, h.line, h.column);
        }
    }

    /// 真机：分解「读文件 / 解码 / 去注释 / 找类型 / 找成员」各占多少。手动跑：
    /// `cargo test --lib -- 真机_解析耗时分解 --ignored --nocapture`
    #[test]
    #[ignore]
    fn 真机_解析耗时分解() {
        let root = PathBuf::from(r"C:\work\aier\newar");
        if !root.is_dir() {
            return;
        }
        let mut files = Vec::new();
        for (dir, _) in source_roots(&root) {
            crate::build_layout::walk_java(&dir, &mut files);
        }
        let n = files.len().min(300);
        let (mut read, mut decode, mut strip, mut types, mut members) =
            (0f64, 0f64, 0f64, 0f64, 0f64);
        let mut bytes_total = 0usize;
        for f in files.iter().take(n) {
            let t = Instant::now();
            let Ok(bytes) = std::fs::read(f) else {
                continue;
            };
            read += t.elapsed().as_secs_f64() * 1000.0;
            bytes_total += bytes.len();
            let t = Instant::now();
            let text = crate::workspace::decode_lossy(&bytes);
            decode += t.elapsed().as_secs_f64() * 1000.0;
            let t = Instant::now();
            let clean = crate::build_state::strip_comments_and_literals(&text);
            strip += t.elapsed().as_secs_f64() * 1000.0;
            let t = Instant::now();
            let _ = crate::build_state::typed_declarations(&clean);
            types += t.elapsed().as_secs_f64() * 1000.0;
            let t = Instant::now();
            let m = crate::java_members::members(&clean);
            members += t.elapsed().as_secs_f64() * 1000.0;
            std::hint::black_box(m);
        }
        println!(
            "{n} 个文件 / {:.1} MB：读 {read:.0}ms 解码 {decode:.0}ms 去注释 {strip:.0}ms 类型 {types:.0}ms 成员 {members:.0}ms",
            bytes_total as f64 / 1048576.0
        );
    }

    #[test]
    fn module_level_classpath_and_legacy_dirs_are_both_found() {
        let root = tmp("mods");
        write(
            &root,
            "own/.classpath",
            "<classpath><classpathentry kind=\"src\" path=\"src/main\"/></classpath>",
        );
        write(
            &root,
            "own/src/main/p/FromOwn.java",
            "package p;\nclass FromOwn {}\n",
        );
        write(
            &root,
            "legacy/src/client/p/FromLegacy.java",
            "package p;\nclass FromLegacy {}\n",
        );
        let idx = build(&root, &root.join("cache"));
        assert_eq!(idx.search("FromOwn", 5).first().unwrap().module, "own");
        assert_eq!(
            idx.search("FromLegacy", 5).first().unwrap().module,
            "legacy"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
