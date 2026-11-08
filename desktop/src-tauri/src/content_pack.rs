//! 搜索内容包：工作区文本的快照。
//!
//! **为什么存在**：内容搜索原本每次查询都要重新走目录（本机 2~4 秒）、再逐个
//! `open` 8 千多个文件（冷缓存实测 11.75 ms/个，总计 97 秒）。慢的不是匹配算法，
//! 是 I/O 形态：N 次小文件 open 会被实时防护逐个拦。把全部文本拼成**一个大文件**
//! 后，同样的扫描只要 20~45 ms（实测 74 MB），因为顺序读只被拦一次。
//!
//! **为什么不压缩**（2026-11-08 实测后的决定）：LZ4 能把 74 MB 压到 18.5 MB（4.0x），
//! 但同一份数据量下**解压要 536 ms，扫描只要 45 ms**——解压比它省下的活贵十倍，
//! 而搜索是「每改一次关键词就跑一次」的高频操作，压缩等于每次敲键都烧一遍 CPU。
//! 换成不压缩后：查询从 ~580 ms 降到 ~45 ms，代价是磁盘多占 55 MB、进程多驻留
//! 74 MB 文本。用「磁盘 + 内存」换「每次查询的 CPU」，在这个场景里是明显划算的。
//!
//! **分块仍然保留**：块（1 MB）是**增量重建的单位**，不是压缩单位——改一个文件只重写
//! 它所在的那一块，其余块直接搬旧字节。分块顺带给了并行扫描一个天然的切分点。
//!
//! 格式（`{config_dir}/search-pack/<根哈希>/`）：**每个工作区根一份包**，子目录名是
//! 归一化根路径的 FNV-1a 十六进制。0.2.0 的单根布局（`search-pack/pack.*`）会在
//! 首次用到同根时自动搬进子目录，不重新花两分钟读盘。
//!
//! | 文件 | 内容 |
//! |---|---|
//! | `pack.bin` | 顺序拼接的 UTF-8 文本块（1 MB/块） |
//! | `pack.idx` | JSON：版本 / 工作区根 / 块表 / 文件表（路径、size、mtime、块号、偏移、长度） |
//!
//! 进程里按 LRU 保留至多 320 MB 的包内容（一个 newar 约 74 MB），磁盘上保留至多
//! 8 份子目录；建包走单线程串行队列，避免「关联 8 个工程」同时发起 8 次全量读盘。
//!
//! 任何不一致（版本、根、长度、切片越界）都按「没有包」处理并重建，不弹错误：
//! 包永远是可再生数据，拿它当唯一真源会把一次坏写变成「搜不到任何东西」。

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::workspace;

/// 包格式版本。**改布局必须 +1**：旧包会因版本不符被重建，而不是被误读。
/// v2：去掉压缩（块只有 `off/len`）。
const FORMAT_VERSION: u32 = 2;
/// 单个块的目标大小。1 MB 是「增量重建够便宜」与「并行切分够细」的折中。
const CHUNK_BYTES: usize = 1 << 20;
const DIR_NAME: &str = "search-pack";
const BIN_NAME: &str = "pack.bin";
const IDX_NAME: &str = "pack.idx";
/// 文件监听停止抖动后的等待窗口：连续保存 10 个文件只重建一次。
const DIRTY_QUIET: Duration = Duration::from_millis(1500);
/// 后台线程轮询间隔。只在有活时才有实际动作，空转成本可忽略。
const TICK: Duration = Duration::from_millis(300);

// ───────────────────────────── 表结构 ─────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct ChunkMeta {
    /// 在 `pack.bin` 里的字节偏移。
    pub off: u64,
    /// 块长度（未压缩，就是文本字节数）。
    pub len: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct FileMeta {
    /// 工作区相对路径，`/` 分隔。
    pub path: String,
    /// 建包时磁盘上的大小（增量判据）。
    pub size: u64,
    /// 建包时磁盘上的 mtime（毫秒，增量判据）。
    pub mtime: u64,
    pub chunk: u32,
    /// 在块内的偏移。
    pub off: u32,
    pub len: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Table {
    pub version: u32,
    /// 建包时的工作区根（用于判断包是否属于当前工作区）。
    pub root: String,
    pub built_at: u64,
    /// `pack.bin` 的总长度：和实际文件长度对不上就当坏包（防「新 bin + 旧 idx」）。
    pub bin_len: u64,
    pub chunks: Vec<ChunkMeta>,
    /// 按相对路径排序；切块时保持这个顺序，增量才能按块对齐。
    pub files: Vec<FileMeta>,
    /// 被跳过的文件数（二进制 / 超大 / 读失败），仅供状态显示。
    #[serde(default)]
    pub skipped: usize,
}

/// 打开的内容包：整份文本常驻，查询只做切片与扫描。
pub struct Pack {
    table: Table,
    data: Arc<Vec<u8>>,
}

impl Pack {
    /// 从目录打开。任何不一致都返回 `None`（调用方据此回落磁盘路径）。
    pub fn open(dir: &Path) -> Option<Pack> {
        let idx = fs::read(dir.join(IDX_NAME)).ok()?;
        let table: Table = serde_json::from_slice(&idx).ok()?;
        if table.version != FORMAT_VERSION {
            return None;
        }
        let data = fs::read(dir.join(BIN_NAME)).ok()?;
        if data.len() as u64 != table.bin_len {
            return None;
        }
        // 块表必须落在数据范围内：与其搜索时逐块判越界，不如在这里一次性挡掉
        if table
            .chunks
            .iter()
            .any(|c| (c.off + c.len as u64) > table.bin_len)
        {
            return None;
        }
        Some(Pack {
            table,
            data: Arc::new(data),
        })
    }

    pub fn table(&self) -> &Table {
        &self.table
    }

    pub fn root(&self) -> &str {
        &self.table.root
    }

    /// 取第 `idx` 块的文本字节（零拷贝）。
    pub fn chunk(&self, idx: usize) -> Option<&[u8]> {
        let meta = self.table.chunks.get(idx)?;
        let start = meta.off as usize;
        self.data.get(start..start + meta.len as usize)
    }

    /// 整包字节数（状态展示用）。
    pub fn data_bytes(&self) -> u64 {
        self.data.len() as u64
    }
}

// ───────────────────────────── 建包 ─────────────────────────────

#[derive(Debug, Clone, Default)]
pub struct BuildReport {
    pub files: usize,
    pub chunks: usize,
    pub bytes: u64,
    pub skipped: usize,
    /// 直接复用旧块的数量 / 重读重建的数量。
    pub reused: usize,
    pub rebuilt: usize,
    pub elapsed_ms: u64,
}

/// 走树 + 解码 + 分块 + 增量复用，整包原子落盘。
///
/// `dir` 是包目录（`{config_dir}/search-pack`），不存在会自动建。
pub fn build(root: &Path, dir: &Path, cancel: &AtomicBool) -> Result<BuildReport, String> {
    let started = std::time::Instant::now();
    // 排除包目录自身：包在 `{config_dir}` 下，但配置目录被指到工作区内时
    // 会把 pack.bin 当源码收进来（越建越大，且块划分每次都变，增量全废）。
    let sources: Vec<crate::search::PackSource> = crate::search::pack_sources(root, cancel)
        .into_iter()
        .filter(|s| !s.path.starts_with(dir))
        .collect();
    let root_key = root_key(root);

    // 旧包只在「同根 + 同版本」时用于复用；否则全量重建。
    let old = Pack::open(dir).filter(|p| p.root() == root_key).map(|p| {
        let mut by_chunk: HashMap<u32, Vec<FileMeta>> = HashMap::new();
        for f in &p.table.files {
            by_chunk.entry(f.chunk).or_default().push(f.clone());
        }
        (p.table.chunks.clone(), by_chunk, p.data.clone())
    });

    // ── 切块：按相对路径顺序累计，超过 CHUNK_BYTES 就换块 ──
    let mut groups: Vec<Vec<crate::search::PackSource>> = Vec::new();
    let mut cur: Vec<crate::search::PackSource> = Vec::new();
    let mut cur_bytes: u64 = 0;
    for s in sources {
        if !cur.is_empty() && cur_bytes + s.size > CHUNK_BYTES as u64 {
            groups.push(std::mem::take(&mut cur));
            cur_bytes = 0;
        }
        cur_bytes += s.size;
        cur.push(s);
    }
    if !cur.is_empty() {
        groups.push(cur);
    }

    let mut bin: Vec<u8> = Vec::with_capacity(groups.len().saturating_mul(64 << 10));
    let mut chunks: Vec<ChunkMeta> = Vec::with_capacity(groups.len());
    let mut files: Vec<FileMeta> = Vec::new();
    let mut report = BuildReport::default();

    for group in groups.iter() {
        if cancel.load(Ordering::Relaxed) {
            return Err("建包已取消".to_string());
        }
        // 复用：旧块的文件集合与大小/mtime 完全一致 → 直接搬字节
        if let Some((bytes, olds)) = reuse_chunk(group, old.as_ref()) {
            let off = bin.len() as u64;
            let len = bytes.len() as u32;
            bin.extend_from_slice(&bytes);
            chunks.push(ChunkMeta { off, len });
            let real_idx = chunks.len() as u32 - 1;
            for (s, o) in group.iter().zip(olds.iter()) {
                // 块内偏移从旧表直接继承：内容一字未变，重算反而可能因解码差异错位
                files.push(FileMeta {
                    path: s.rel.clone(),
                    size: s.size,
                    mtime: s.mtime,
                    chunk: real_idx,
                    off: o.off,
                    len: o.len,
                });
            }
            report.reused += 1;
            report.files += group.len();
            report.bytes += len as u64;
            continue;
        }

        // 重建这一块：只读这一块涉及的文件
        let mut buf: Vec<u8> = Vec::with_capacity(CHUNK_BYTES.min(4 << 20));
        let mut metas: Vec<FileMeta> = Vec::new();
        for s in group {
            if cancel.load(Ordering::Relaxed) {
                return Err("建包已取消".to_string());
            }
            let Ok(bytes) = fs::read(&s.path) else {
                report.skipped += 1;
                continue;
            };
            // 与搜索侧同一条二进制判据：前 8 KB 有 NUL 就不是文本
            if bytes.iter().take(8192).any(|b| *b == 0) {
                report.skipped += 1;
                continue;
            }
            let text = workspace::decode_lossy(&bytes);
            if text.len() > u32::MAX as usize {
                report.skipped += 1;
                continue;
            }
            metas.push(FileMeta {
                path: s.rel.clone(),
                size: s.size,
                mtime: s.mtime,
                chunk: 0,
                off: buf.len() as u32,
                len: text.len() as u32,
            });
            buf.extend_from_slice(text.as_bytes());
        }
        if buf.is_empty() {
            continue;
        }
        let off = bin.len() as u64;
        let len = buf.len() as u32;
        bin.extend_from_slice(&buf);
        chunks.push(ChunkMeta { off, len });
        report.bytes += len as u64;
        report.files += metas.len();
        // 块号用「已写入块数 - 1」，跳过空块后仍连续
        let real_idx = chunks.len() as u32 - 1;
        for m in metas {
            files.push(FileMeta {
                chunk: real_idx,
                ..m
            });
        }
        report.rebuilt += 1;
    }

    report.chunks = chunks.len();
    report.elapsed_ms = started.elapsed().as_millis() as u64;

    let table = Table {
        version: FORMAT_VERSION,
        root: root_key,
        built_at: now_ms(),
        bin_len: bin.len() as u64,
        chunks,
        files,
        skipped: report.skipped,
    };

    fs::create_dir_all(dir).map_err(|e| format!("建包目录失败：{e}"))?;
    let idx = serde_json::to_vec(&table).map_err(|e| format!("序列化包表失败：{e}"))?;
    // 先 bin 后 idx：idx 是权威，bin 长度对不上会被 open 挡掉
    crate::atomic_file::write_atomic(&dir.join(BIN_NAME), &bin)?;
    crate::atomic_file::write_atomic(&dir.join(IDX_NAME), &idx)?;
    Ok(report)
}

/// 旧包的可复用部分：块表 + 每块的文件表 + 文本字节。抽成别名是给 clippy 看的。
type OldPack = (Vec<ChunkMeta>, HashMap<u32, Vec<FileMeta>>, Arc<Vec<u8>>);

/// 旧块能整块复用吗？要求「文件集合、顺序、size、mtime」全一致。
///
/// 返回旧块字节与**旧的文件表**（块内偏移要靠它继承）。
fn reuse_chunk(
    group: &[crate::search::PackSource],
    old: Option<&OldPack>,
) -> Option<(Vec<u8>, Vec<FileMeta>)> {
    let (chunks, by_chunk, data) = old?;
    let first = group.first()?;
    // 用第一个文件反查它在旧表里属于哪一块
    let chunk_idx = *by_chunk
        .iter()
        .find(|(_, v)| v.first().map(|m| m.path == first.rel).unwrap_or(false))?
        .0;
    let olds = by_chunk.get(&chunk_idx)?;
    if olds.len() != group.len() {
        return None;
    }
    for (g, o) in group.iter().zip(olds.iter()) {
        if g.rel != o.path || g.size != o.size || g.mtime != o.mtime {
            return None;
        }
    }
    let meta = chunks.get(chunk_idx as usize)?;
    let start = meta.off as usize;
    let end = start.checked_add(meta.len as usize)?;
    Some((data.get(start..end)?.to_vec(), olds.clone()))
}

// ───────────────────────────── 全局状态 ─────────────────────────────

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PackStatus {
    pub ready: bool,
    pub building: bool,
    pub root: String,
    pub files: usize,
    pub chunks: usize,
    pub built_at: u64,
    /// 整包字节数（= 文本字节数，不压缩）。
    pub bytes: u64,
    /// 排队待建的根数（主工作区 + 依赖工程）。
    pub pending: usize,
    /// 进程里已加载的包数。
    pub packed_roots: usize,
    pub last_error: Option<String>,
}

/// 进程里最多同时驻留多少字节的包内容。一个 newar 规模的工作区约 74 MB，
/// 依赖工程一般更小；超预算按 LRU 淘汰，别让「关联 8 个工程」变成常驻 600 MB。
const MAX_OPEN_BYTES: u64 = 320 * 1024 * 1024;
/// 磁盘上最多保留几份包目录（换工作区会留下旧目录，每份几十 MB）。
const MAX_PACK_DIRS: usize = 8;

#[derive(Default)]
struct State {
    /// 根键 → 已加载的包。包目录本身按根分，所以不会把别人的包读进来。
    packs: HashMap<String, Arc<Pack>>,
    /// LRU：前 = 最久没用。
    lru: std::collections::VecDeque<String>,
    /// 根键 → 原始路径（重建、排队都要用它，不能用归一化后的键）。
    root_paths: HashMap<String, PathBuf>,
    /// 文件监听盯着的那个工作区：改文件只重建它，不牵动依赖工程。
    primary: Option<String>,
    /// 正在建的根键（同一时刻只建一个）。
    building: Option<String>,
    /// 串行建包队列：多个依赖工程同时 ensure 不会各起一次全量读盘。
    queue: std::collections::VecDeque<(String, PathBuf)>,
    last_error: Option<String>,
}

fn state() -> &'static Mutex<State> {
    static S: OnceLock<Mutex<State>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(State::default()))
}

/// 包目录基址（`{config_dir}/search-pack`），下面每个工作区根一个子目录。
fn pack_dir() -> &'static Mutex<Option<PathBuf>> {
    static D: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();
    D.get_or_init(|| Mutex::new(None))
}

pub fn set_cache_dir(config_dir: &Path) {
    let next = config_dir.join(DIR_NAME);
    let changed = {
        let mut g = pack_dir().lock().unwrap_or_else(|e| e.into_inner());
        if g.as_deref() != Some(next.as_path()) {
            *g = Some(next);
            true
        } else {
            false
        }
    };
    // 锁顺序：先放开 pack_dir，再拿 state——别让两把锁互相等。
    if changed {
        *state().lock().unwrap_or_else(|e| e.into_inner()) = State::default();
    }
}

fn dir() -> Option<PathBuf> {
    pack_dir().lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// 每个根一个目录：`<base>/<根键的 FNV-1a 64 位十六进制>`。
/// 不能把路径直接当目录名（`c:/work/aier/newar` 里有 `:` 和 `/`）。
pub fn dir_for(base: &Path, root: &Path) -> PathBuf {
    base.join(dir_hash(&root_key(root)))
}

fn dir_hash(key: &str) -> String {
    // FNV-1a 64：稳定、零依赖，只用来给目录起名（根的集合很小，不要求抗碰撞）。
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in key.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100_0000_01b3);
    }
    format!("{h:016x}")
}

/// 0.2.0 的老布局把 `pack.bin` / `pack.idx` 直接放在基址下。升级时不重建
/// 那 74 MB（冷读要近两分钟）：确认表里的根就是本次要用的根，整体搬进子目录。
fn adopt_legacy(base: &Path, key: &str, dir: &Path) {
    let legacy_idx = base.join(IDX_NAME);
    let Ok(raw) = fs::read(&legacy_idx) else {
        return;
    };
    let Ok(t) = serde_json::from_slice::<Table>(&raw) else {
        return;
    };
    if t.version != FORMAT_VERSION || t.root != key {
        return;
    }
    if fs::create_dir_all(dir).is_err() {
        return;
    }
    if fs::rename(base.join(BIN_NAME), dir.join(BIN_NAME)).is_err() {
        return;
    }
    let _ = fs::rename(&legacy_idx, dir.join(IDX_NAME));
}

fn touch(lru: &mut std::collections::VecDeque<String>, key: &str) {
    lru.retain(|k| k != key);
    lru.push_back(key.to_string());
}

/// 装进内存表并守住字节预算。淘汰的是「最久没查过的别的根」，刚装的那个不淘汰：
/// 真有单个包就超预算，也宁可留着它，否则会陷入「装了立刻被挤掉」的死循环。
fn insert_pack(g: &mut State, key: String, pack: Arc<Pack>) {
    g.packs.insert(key.clone(), pack);
    touch(&mut g.lru, &key);
    while g.packs.len() > 1 {
        let total: u64 = g.packs.values().map(|p| p.data_bytes()).sum();
        if total <= MAX_OPEN_BYTES {
            break;
        }
        let Some(old) = g.lru.iter().find(|k| *k != &key).cloned() else {
            break;
        };
        g.packs.remove(&old);
        g.lru.retain(|k| k != &old);
    }
}

/// 已加载的包（同根才返回）。未加载但磁盘上有包时顺手加载。
pub fn current_for(root: &Path) -> Option<Arc<Pack>> {
    let key = root_key(root);
    let base = dir()?;
    {
        let mut g = state().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(p) = g.packs.get(&key).cloned() {
            touch(&mut g.lru, &key);
            return Some(p);
        }
    }
    let dir = dir_for(&base, root);
    if !dir.join(IDX_NAME).exists() {
        adopt_legacy(&base, &key, &dir);
    }
    let pack = Pack::open(&dir)?;
    if pack.root() != key {
        return None;
    }
    let pack = Arc::new(pack);
    let mut g = state().lock().unwrap_or_else(|e| e.into_inner());
    g.root_paths.insert(key.clone(), root.to_path_buf());
    insert_pack(&mut g, key, pack.clone());
    Some(pack)
}

/// 没有可用包时排一次后台建包；已有同根包则什么也不做。
/// 依赖工程也走这里，多个根会被串成队列，不会并发抢磁盘。
pub fn ensure(root: &Path, config_dir: &Path) {
    set_cache_dir(config_dir);
    enqueue(root);
}

/// 工作区根专用：文件监听只盯它，`mark_dirty()` 也只重建它的包。
pub fn ensure_primary(root: &Path, config_dir: &Path) {
    set_cache_dir(config_dir);
    {
        let mut g = state().lock().unwrap_or_else(|e| e.into_inner());
        g.primary = Some(root_key(root));
    }
    enqueue(root);
}

fn enqueue(root: &Path) {
    if current_for(root).is_some() || dir().is_none() {
        return;
    }
    let key = root_key(root);
    {
        let mut g = state().lock().unwrap_or_else(|e| e.into_inner());
        g.root_paths.insert(key.clone(), root.to_path_buf());
        let queued =
            g.building.as_deref() == Some(key.as_str()) || g.queue.iter().any(|(k, _)| k == &key);
        if !queued {
            g.queue.push_back((key.clone(), root.to_path_buf()));
        }
    }
    start_worker();
}

/// 文件监听 flush 后调用：静默 1.5 秒再增量重建（连续保存只重建一次）。
pub fn mark_dirty() {
    if dir().is_none() {
        return;
    }
    dirty().store(true, Ordering::Relaxed);
    start_worker();
}

pub fn status() -> PackStatus {
    let g = state().lock().unwrap_or_else(|e| e.into_inner());
    let key = g.primary.clone();
    let pack = key.as_ref().and_then(|k| g.packs.get(k));
    let mut st = PackStatus {
        ready: pack.is_some(),
        building: g.building.is_some(),
        root: g.building.clone().or(key).unwrap_or_default(),
        pending: g.queue.len(),
        packed_roots: g.packs.len(),
        last_error: g.last_error.clone(),
        ..Default::default()
    };
    if let Some(p) = pack {
        st.files = p.table.files.len();
        st.chunks = p.table.chunks.len();
        st.bytes = p.data_bytes();
        st.built_at = p.table.built_at;
    }
    st
}

fn dirty() -> &'static AtomicBool {
    static D: AtomicBool = AtomicBool::new(false);
    &D
}

fn building() -> &'static AtomicBool {
    static B: AtomicBool = AtomicBool::new(false);
    &B
}

fn start_worker() {
    static STARTED: OnceLock<()> = OnceLock::new();
    STARTED.get_or_init(|| {
        let _ = std::thread::Builder::new()
            .name("search-pack".to_string())
            .spawn(|| loop {
                std::thread::sleep(TICK);
                if building().load(Ordering::Relaxed) {
                    continue;
                }
                if dirty().swap(false, Ordering::Relaxed) {
                    // 抖动窗口：期间又来改动就放弃这次，下一轮再说
                    std::thread::sleep(DIRTY_QUIET);
                    if dirty().load(Ordering::Relaxed) {
                        continue;
                    }
                    // 文件监听只盯着工作区根；依赖工程的包由队列各自负责。
                    let root = {
                        let g = state().lock().unwrap_or_else(|e| e.into_inner());
                        g.primary
                            .as_ref()
                            .and_then(|k| g.root_paths.get(k))
                            .cloned()
                    };
                    if let (Some(root), Some(base)) = (root, dir()) {
                        run(&root, &dir_for(&base, &root));
                    }
                    continue;
                }
                let job = {
                    let mut g = state().lock().unwrap_or_else(|e| e.into_inner());
                    g.queue.pop_front()
                };
                if let (Some((_key, root)), Some(base)) = (job, dir()) {
                    run(&root, &dir_for(&base, &root));
                }
            });
    });
}

fn run(root: &Path, out_dir: &Path) {
    let key = root_key(root);
    {
        let mut g = state().lock().unwrap_or_else(|e| e.into_inner());
        if g.building.is_some() {
            return;
        }
        g.building = Some(key.clone());
        g.root_paths.insert(key.clone(), root.to_path_buf());
    }
    building().store(true, Ordering::Relaxed);
    let cancel = AtomicBool::new(false);
    let result = build(root, out_dir, &cancel);
    building().store(false, Ordering::Relaxed);

    let mut g = state().lock().unwrap_or_else(|e| e.into_inner());
    g.building = None;
    match result {
        Ok(report) => {
            log::info!(
                "搜索内容包已就绪（{}）：{} 个文件 / {} 块 / {:.1} MB（复用 {} 块、重建 {} 块，{} ms）",
                root.display(),
                report.files,
                report.chunks,
                report.bytes as f64 / 1_048_576.0,
                report.reused,
                report.rebuilt,
                report.elapsed_ms
            );
            match Pack::open(out_dir) {
                Some(p) => {
                    insert_pack(&mut g, key.clone(), Arc::new(p));
                    g.last_error = None;
                }
                None => g.last_error = Some("建包后仍无法打开（包损坏）".to_string()),
            }
        }
        Err(e) => {
            log::warn!("搜索内容包构建失败（{}）：{e}", root.display());
            g.last_error = Some(e);
        }
    }
    drop(g);
    if let Some(base) = dir() {
        prune(&base, &key);
    }
}

/// 换工作区会留下旧的子目录，每份几十 MB。保留最近 MAX_PACK_DIRS 份，
/// 只删自己认得的 `pack.bin` / `pack.idx`，且跳过内存里还加载着的那几份。
fn prune(base: &Path, keep_key: &str) {
    let Ok(rd) = fs::read_dir(base) else { return };
    let loaded: Vec<String> = state()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .packs
        .keys()
        .map(|k| dir_hash(k))
        .collect();
    let mut dirs: Vec<(SystemTime, PathBuf, String)> = rd
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            if !p.is_dir() || !p.join(IDX_NAME).exists() {
                return None;
            }
            let name = p.file_name()?.to_string_lossy().into_owned();
            let mt = p
                .join(IDX_NAME)
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(UNIX_EPOCH);
            Some((mt, p, name))
        })
        .collect();
    if dirs.len() <= MAX_PACK_DIRS {
        return;
    }
    dirs.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    let keep = dir_hash(keep_key);
    for (_, p, name) in dirs.iter().skip(MAX_PACK_DIRS) {
        if name == &keep || loaded.contains(name) {
            continue;
        }
        let _ = fs::remove_file(p.join(BIN_NAME));
        let _ = fs::remove_file(p.join(IDX_NAME));
        let _ = fs::remove_dir(p);
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 路径归一成可比较的键：`/` 分隔 + 小写（Windows 大小写不敏感）。
fn root_key(root: &Path) -> String {
    root.to_string_lossy().replace('\\', "/").to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, rel: &str, bytes: &[u8]) {
        let p = dir.join(rel);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(p, bytes).unwrap();
    }

    /// UTF-8 与 GBK 混放的文件都能进包，且切片出来的文本与磁盘解码一致。
    #[test]
    fn build_roundtrip_utf8_and_gbk() {
        let root = crate::test_support::tmp("pack-roundtrip");
        let dir = crate::test_support::tmp("pack-roundtrip-pack");
        write(
            &root,
            "bill/A.java",
            "class A { String s = \"凭证\"; }".as_bytes(),
        );
        let (gbk, _, _) = encoding_rs::GBK.encode("发票查询");
        write(&root, "bill/B.xml", &gbk);
        // 二进制：必须被跳过
        write(&root, "bill/C.class", b"\xca\xfe\xba\xbe\x00\x00\x00\x34");
        write(&root, "bill/skip.bin", b"abc\x00def");

        let rep = build(&root, &dir, &AtomicBool::new(false)).unwrap();
        assert_eq!(rep.files, 2, "二进制文件不应进包");
        assert_eq!(rep.chunks, 1);

        let pack = Pack::open(&dir).unwrap();
        let chunk = pack.chunk(0).unwrap();
        for f in &pack.table.files {
            let text =
                std::str::from_utf8(&chunk[f.off as usize..(f.off + f.len) as usize]).unwrap();
            let disk = fs::read(root.join(&f.path)).unwrap();
            assert_eq!(
                text,
                workspace::decode_lossy(&disk),
                "{} 内容不一致",
                f.path
            );
        }
        assert!(pack
            .table
            .files
            .iter()
            .all(|f| !f.path.ends_with(".class") && !f.path.ends_with("skip.bin")));
    }

    /// 改一个文件只重建它所在的那一块，另一块直接搬旧字节。
    #[test]
    fn incremental_reuses_untouched_chunk() {
        let root = crate::test_support::tmp("pack-incremental");
        let dir = crate::test_support::tmp("pack-incremental-pack");
        let pad_a = "a".repeat(700 * 1024);
        let pad_b = "b".repeat(700 * 1024);
        write(&root, "a.txt", pad_a.as_bytes());
        write(&root, "b.txt", pad_b.as_bytes());

        let first = build(&root, &dir, &AtomicBool::new(false)).unwrap();
        assert_eq!(first.chunks, 2, "两个 700KB 文件应分成两块");
        assert_eq!(first.reused, 0);

        write(&root, "a.txt", format!("{pad_a}changed").as_bytes());
        let second = build(&root, &dir, &AtomicBool::new(false)).unwrap();
        assert_eq!(second.reused, 1, "没动过的那块必须直接复用");
        assert_eq!(second.rebuilt, 1);

        let pack = Pack::open(&dir).unwrap();
        let changed = pack
            .table
            .files
            .iter()
            .find(|f| f.path == "a.txt")
            .expect("a.txt 在包里");
        let chunk = pack.chunk(changed.chunk as usize).unwrap();
        let text =
            std::str::from_utf8(&chunk[changed.off as usize..(changed.off + changed.len) as usize])
                .unwrap();
        assert!(text.ends_with("changed"));
    }

    /// 坏包 / 版本不符都必须返回 None，让上层回落磁盘而不是搜不到东西。
    #[test]
    fn broken_pack_falls_back() {
        let root = crate::test_support::tmp("pack-broken");
        let dir = crate::test_support::tmp("pack-broken-pack");
        write(&root, "a.txt", b"hello");
        build(&root, &dir, &AtomicBool::new(false)).unwrap();
        assert!(Pack::open(&dir).is_some());

        // idx 不是合法 JSON
        fs::write(dir.join(IDX_NAME), b"{not json").unwrap();
        assert!(Pack::open(&dir).is_none());

        // 版本号比当前格式新 → 必须当没有包，而不是按旧布局误读
        build(&root, &dir, &AtomicBool::new(false)).unwrap();
        let mut table: Table =
            serde_json::from_slice(&fs::read(dir.join(IDX_NAME)).unwrap()).unwrap();
        table.version = FORMAT_VERSION + 1;
        fs::write(dir.join(IDX_NAME), serde_json::to_vec(&table).unwrap()).unwrap();
        assert!(Pack::open(&dir).is_none());
    }

    /// bin 被截断（模拟「新 bin + 旧 idx」的崩溃窗口）也要拒绝。
    #[test]
    fn truncated_bin_rejected() {
        let root = crate::test_support::tmp("pack-truncated");
        let dir = crate::test_support::tmp("pack-truncated-pack");
        write(&root, "a.txt", b"hello world");
        build(&root, &dir, &AtomicBool::new(false)).unwrap();
        let bin = fs::read(dir.join(BIN_NAME)).unwrap();
        fs::write(dir.join(BIN_NAME), &bin[..bin.len() / 2]).unwrap();
        assert!(Pack::open(&dir).is_none());
    }

    /// 多根布局：目录名只由归一化后的根决定（大小写不敏感），且 0.2.0 的老包
    /// 会被原样搬进新目录——升级后不必再花两分钟重建 74 MB。
    #[test]
    fn legacy_pack_is_adopted_into_root_dir() {
        let root = crate::test_support::tmp("pack-legacy-root");
        let base = crate::test_support::tmp("pack-legacy-base");
        write(&root, "bill/A.java", b"class A {}");
        build(&root, &base, &AtomicBool::new(false)).unwrap();
        assert!(base.join(IDX_NAME).exists(), "先造出老布局");

        let dir = dir_for(&base, &root);
        assert_ne!(dir, base);
        let upper = PathBuf::from(root.to_string_lossy().to_uppercase());
        assert_eq!(dir, dir_for(&base, &upper), "根大小写不该产生两份包");
        assert!(!dir.join(IDX_NAME).exists());

        adopt_legacy(&base, &root_key(&root), &dir);
        assert!(!base.join(IDX_NAME).exists(), "老文件应被搬走");
        assert_eq!(
            Pack::open(&dir).expect("搬完必须能打开").root(),
            root_key(&root)
        );

        // 别的根搬不走（表里的 root 对不上），免得 A 工程的包被 B 工程误用
        let other = crate::test_support::tmp("pack-legacy-other");
        build(&other, &base, &AtomicBool::new(false)).unwrap();
        adopt_legacy(&base, &root_key(&root), &dir_for(&base, &other));
        assert!(base.join(IDX_NAME).exists(), "根对不上就该留在原地");
    }
}
