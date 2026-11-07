//! 本地历史：用户编辑的源文件的历史版本（IDEA Local History 的轻量版）。
//!
//! **解决什么问题**：编辑器里改烂了、保存之后想回到半小时前的样子，而工程没有
//! 纳入 SVN（或改动还没提交）。撤销栈只在本次会话里有效，关掉应用就没了。
//!
//! **存什么**：文件在某个时刻的**磁盘内容原字节**。不做编码/换行转换——历史版本
//! 的意义就是「那一时刻的文件本身」，转换过就不再是那个文件了。恢复时也按原字节写回，
//! 所以混合换行、GBK、带 BOM 的文件都能原样进历史、原样恢复（这一点与「保存」
//! 路径的 `lossless` 要求不同：保存要改内容，历史只是复制）。
//!
//! **什么时候归档**（调用方决定，本模块只提供 `capture`）：
//! - 保存前（`lib/fileSave.ts::saveOne`）：拿到的是**改动前**的磁盘内容，这是
//!   最有价值的一版——「保存完发现改错了」能退回去；
//! - 定时兜底（每 5 分钟，`hooks/useLocalHistorySweep.ts`）+ 切文件时：覆盖
//!   「别的程序改了文件」这种外部变化。
//!
//! 内容与最新一版相同（SHA-256 相同）就不重复归档，所以兜底扫描平时不写盘。
//!
//! **上限**：单文件 [`KEEP_PER_FILE`] 版；全部历史合计 [`MAX_TOTAL_BYTES`] 字节、
//! [`MAX_FILES`] 个文件，超了按「最早不动的文件」整份淘汰。没有上限的本地历史
//! 会在几个月后悄悄吃掉几十 GB——那是另一个需要用户发现的问题。
//!
//! **并发**：每个文件的索引读-改-写由按文件分槽的 [`FILE_LOCKS`] 保护，不同文件
//! 互不阻塞；全局淘汰单独用 [`CAP_LOCK`]，且带节流。保存是用户节奏的操作，临界区里
//! 只有内存拷贝与小文件 IO，不会互相等。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// 单个文件保留多少个版本。
pub const KEEP_PER_FILE: usize = 20;

/// 全部历史占用的磁盘上限。超过就整份淘汰最早不动的文件。
pub const MAX_TOTAL_BYTES: u64 = 512 * 1024 * 1024;

/// 有历史的文件数上限（按目录数计）。
pub const MAX_FILES: usize = 500;

/// 单个文件的历史字节上限。条数上限（KEEP_PER_FILE）管不住大文件：一个 30MB
/// 的文件留 20 版就是 600MB，比整个全局预算还大，而全局淘汰永远绕开刚写入的
/// 目录——字节这条线必须单独画。永远保留最新一版（那是这次改动的「改动前」）。
pub const PER_FILE_MAX_BYTES: u64 = 64 * 1024 * 1024;

/// 预览时最多回传多少字节。再大的版本只给大小与时间，仍可整版恢复——
/// 把 5MB 的旧文件拖过 IPC 只为了在界面上看两眼，不划算。
pub const MAX_PREVIEW_BYTES: usize = 512 * 1024;

/// 一个历史版本。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryVersion {
    /// `{归档时间ms}-{内容哈希前8位}`。同时用作文件名，所以必须过 [`valid_id`] 校验。
    pub id: String,
    /// 归档时间（Unix 毫秒）。
    pub ts: u64,
    /// 内容字节数。
    pub size: u64,
    /// 内容 SHA-256（hex）。与最新一版相同就不重复归档。
    pub sha: String,
}

/// 单个文件的索引：`{config_dir}/local-history/{slug}/index.json`。
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileIndex {
    /// 规范化后的绝对路径（给人看的，也用于「这个目录对应哪个文件」）。
    path: String,
    /// 最新在前。
    versions: Vec<HistoryVersion>,
}

/// 每文件一把锁（按 slug 哈希落到固定 64 个槽位，内存不随文件数增长）。
///
/// 以前这里是一把**全局**锁，`capture` 全程持有——于是读文件、算 SHA-256、
/// 写 blob 都排在别的文件后面，一次保存引发的固定开销随被跟踪文件数线性变差
/// （审查报告 P2-12）。现在锁只保护「同一个文件的索引读-改-写」这一段，
/// 不同文件可以并行归档。
static FILE_LOCKS: OnceLock<Vec<Mutex<()>>> = OnceLock::new();

fn file_lock(key: &str) -> &'static Mutex<()> {
    // FNV-1a：几行、无依赖，只要分布均匀即可
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in key.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    let slots = FILE_LOCKS.get_or_init(|| (0..64).map(|_| Mutex::new(())).collect());
    &slots[(h % slots.len() as u64) as usize]
}

/// 全局淘汰专用锁。与 `FILE_LOCKS` **分开**：淘汰要扫所有子目录，是全流程里
/// 最重的一步；让它和「某个文件的索引写入」共用一把锁，一次淘汰会把所有保存
/// 全堵住。加锁顺序恒定（先文件锁、再这把），不会成环。
static CAP_LOCK: Mutex<()> = Mutex::new(());

/// 淘汰扫描的最小间隔（毫秒）。淘汰是磁盘安全阀，不需要每次保存都扫一遍：
/// 几十个文件、每个文件 20 版的索引读一遍就是几百次 IO，落在用户每次保存上。
static LAST_CAP_SWEEP_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
const CAP_SWEEP_INTERVAL_MS: u64 = 60_000;
fn history_dir(config_dir: &Path) -> PathBuf {
    config_dir.join("local-history")
}

/// 路径 → 目录名。用规范化路径的 SHA-256 前 20 位：固定长度、不含路径分隔符，
/// 也不会把 `C:\work\aier` 变成三层嵌套目录。
fn slug(path: &str) -> String {
    let d = Sha256::digest(path.as_bytes());
    hex(&d)[..20].to_string()
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 稳定键：同一文件的多次调用必须得到同一个 slug。
///
/// 统一走项目既有的 `canonicalize` + `strip_verbatim` 前缀处理（与
/// `security::path::canonicalize_roots` 同一套），保证 Windows 的 `\\?\` 与
/// macOS 的 `/var`→`/private/var` 不会让同一个文件算出两个 slug。
/// canonicalize 失败返回明确错误，不再退回原串——退回原串正是「历史分裂」
/// （同一文件两个 slug、另一份被整目录淘汰）的根源（审查报告 P1-7）。
fn stable_key(path: &Path) -> Result<String, String> {
    let real = path
        .canonicalize()
        .map_err(|e| format!("无法规范化历史路径 {}: {e}", path.display()))?;
    Ok(crate::nc_home::strip_verbatim(&real)
        .to_string_lossy()
        .into_owned())
}

/// 版本 id 只允许 `[0-9a-f-]`：它会拼进文件路径，放行 `/`、`..` 就是任意文件读。
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-')
}

/// 索引的读取结果。区分「没有索引」与「索引读不懂」是**数据安全**问题：
/// 后者可能是磁盘坏字节、被杀软工具短暂独占、或将来改了 schema，当成空索引
/// 会把整个目录（连同里面完好的 blob）删掉。
enum IndexLoad {
    /// 目录里没有 index.json（从未写过，或被别人删了）。
    Missing,
    /// 读到了且解析成功。
    Ok(FileIndex),
    /// 索引存在但读不到 / 解析不了。
    Broken,
}

fn load_index(dir: &Path) -> IndexLoad {
    let raw = match fs::read(dir.join("index.json")) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return IndexLoad::Missing,
        Err(_) => return IndexLoad::Broken,
    };
    match serde_json::from_slice(&raw) {
        Ok(idx) => IndexLoad::Ok(idx),
        Err(_) => IndexLoad::Broken,
    }
}

/// 读索引；读不懂按空索返回。调用方只是「看不到版本」，不会因此删数据——
/// 真正的删除决策在 `enforce_global_cap`，那里看 `load_index` 的完整结果。
fn read_index(dir: &Path) -> FileIndex {
    match load_index(dir) {
        IndexLoad::Ok(idx) => idx,
        _ => FileIndex::default(),
    }
}

fn write_index(dir: &Path, idx: &FileIndex) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("创建历史目录失败: {e}"))?;
    let text = serde_json::to_string(idx).map_err(|e| format!("序列化历史索引失败: {e}"))?;
    // 先写临时文件再 rename：写到一半崩溃不该把整份索引变成坏 JSON
    let tmp = dir.join("index.json.tmp");
    fs::write(&tmp, text).map_err(|e| format!("写历史索引失败: {e}"))?;
    fs::rename(&tmp, dir.join("index.json")).map_err(|e| format!("替换历史索引失败: {e}"))
}

/// 归档一个文件的当前磁盘内容。内容与最新一版相同返回 `Ok(None)`（没写盘）。
///
/// 读不到文件也返回 `Ok(None)`：历史是兜底，不该让「存不了历史」挡住保存。
pub fn capture(config_dir: &Path, path: &Path, keep: usize) -> Result<Option<String>, String> {
    capture_limited(config_dir, path, keep, MAX_TOTAL_BYTES)
}

/// [`capture`] 的本体，预算是参数。
///
/// 预算做成参数只为测试：验证「比预算还大就不归档」必须拿一个真比预算大的文件，
/// 而 `MAX_TOTAL_BYTES` 是 512MB。曾经用 `set_len` 造「稀疏文件」——NTFS 上
/// `SetEndOfFile` **真的分配** 512MB，于是每跑一次门禁就往 `%TEMP%` 里丢一个
/// 512MB 目录（2026-11-02 实测：C 盘三天攒了 1.5GB）。现在测试传 4 字节预算，
/// 语义一模一样，一次也不再写盘。
fn capture_limited(
    config_dir: &Path,
    path: &Path,
    keep: usize,
    max_total_bytes: u64,
) -> Result<Option<String>, String> {
    // keep=0 会把刚写进去的版本立刻裁空（连目录一起删），却仍返回 Some(id)——
    // 调用方拿到一个指向已删 blob 的 id。IPC 层硬编码 20，这里兜住这个契约
    let keep = keep.max(1);
    // 比整个全局预算还大的文件，一版就装不下：归档它只会让全局淘汰天天删别人。
    // 保存路径自己也有 10MB 上限，这里兜的是「外部程序把文件撑大」的情况
    if fs::metadata(path).map(|m| m.len()).unwrap_or(0) > max_total_bytes {
        return Ok(None);
    }
    // 读文件 + 算摘要放在锁外：这两步与「索引怎么改」无关，以前却在全局锁里
    // 排队——被跟踪的文件越多，每次保存越慢（审查报告 P2-12）
    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(_) => return Ok(None),
    };
    let sha = hex(&Sha256::digest(&bytes));
    // canonicalize 失败时跳过本次归档：历史是兜底，不该挡住保存；更不能退回
    // 原路径造出第二个 slug（P1-7）。既有历史仍完整，只是这次不新增版本。
    let key = match stable_key(path) {
        Ok(k) => k,
        Err(_) => return Ok(None),
    };
    let dir = history_dir(config_dir).join(slug(&key));

    // 只保护「这个文件」的索引读-改-写；不同文件的归档互不阻塞
    let _g = file_lock(&key).lock().unwrap_or_else(|e| e.into_inner());
    let mut idx = read_index(&dir);
    if idx.versions.first().map(|v| v.sha.as_str()) == Some(sha.as_str()) {
        return Ok(None);
    }
    let ts = now_ms();
    let id = format!("{ts}-{}", &sha[..8]);
    fs::create_dir_all(&dir).map_err(|e| format!("创建历史目录失败: {e}"))?;
    fs::write(dir.join(format!("{id}.bin")), &bytes).map_err(|e| format!("写历史版本失败: {e}"))?;
    idx.path = key;
    idx.versions.insert(
        0,
        HistoryVersion {
            id: id.clone(),
            ts,
            size: bytes.len() as u64,
            sha,
        },
    );
    // 超出的旧版本连内容一起删：只删索引等于把 blob 永久留在磁盘上
    while idx.versions.len() > keep {
        if let Some(old) = idx.versions.pop() {
            let _ = fs::remove_file(dir.join(format!("{}.bin", old.id)));
        }
    }
    // 条数没超、字节超了也删。大文件 20 版能吃满整个全局预算，而全局淘汰永远
    // 绕开刚写入的 keep_dir——不在这里画线，磁盘就会被一个文件慢慢吃光
    let mut total: u64 = idx.versions.iter().map(|v| v.size).sum();
    while idx.versions.len() > 1 && total > PER_FILE_MAX_BYTES {
        if let Some(old) = idx.versions.pop() {
            total = total.saturating_sub(old.size);
            let _ = fs::remove_file(dir.join(format!("{}.bin", old.id)));
        }
    }
    write_index(&dir, &idx)?;
    // 清掉索引外的 .bin：上一轮写到一半崩溃（blob 写完了、索引没写成）会留下
    // 没人引用的 blob——任何接口都到不了它，只会白占磁盘。索引是每轮全量重写的，
    // 所以「不在索引里」就是可以安全删除的判据。
    if let Ok(rd) = fs::read_dir(&dir) {
        for e in rd.flatten() {
            let name = e.file_name();
            let Some(id) = name.to_str().and_then(|n| n.strip_suffix(".bin")) else {
                continue;
            };
            if !idx.versions.iter().any(|v| v.id == id) {
                let _ = fs::remove_file(e.path());
            }
        }
    }
    // 文件锁在这里就可以放了：全局淘汰有自己的锁，别让它把别的保存堵住
    drop(_g);
    enforce_global_cap(config_dir, &dir)?;
    Ok(Some(id))
}

/// 全局上限：按「最早不动的文件」整份淘汰。
///
/// 整份淘汰（而不是逐版本删）是有意的：跨文件挑最旧的版本会让每个文件都剩半截
/// 历史，看哪份都不完整；整份淘汰至少保住「最近在改的文件有完整历史」。
/// 刚写入的 `keep_dir` 不参与淘汰——不能把用户这一下保存挤掉。
///
/// **带节流**：两次扫描之间至少隔 `CAP_SWEEP_INTERVAL_MS`。淘汰是安全阀而不是
/// 记账功能，晚一分钟执行没有代价；而每次保存都全量扫一遍索引，代价会随被跟踪
/// 文件数线性上涨，全落在用户点保存到文件落盘之间（审查报告 P2-12）。
fn enforce_global_cap(config_dir: &Path, keep_dir: &Path) -> Result<(), String> {
    let now = now_ms();
    let last = LAST_CAP_SWEEP_MS.load(std::sync::atomic::Ordering::Relaxed);
    if last != 0 && now.saturating_sub(last) < CAP_SWEEP_INTERVAL_MS {
        return Ok(());
    }
    // 抢到锁才更新时间戳：没抢到的那个说明别人正在扫，它这次不需要再扫
    let _g = CAP_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    LAST_CAP_SWEEP_MS.store(now_ms(), std::sync::atomic::Ordering::Relaxed);
    evict_over_budget(
        &history_dir(config_dir),
        keep_dir,
        MAX_TOTAL_BYTES,
        MAX_FILES,
    )
}

/// 一个历史目录在全局淘汰眼里的状态。
enum DirAction {
    /// 计入预算、参与「最早不动先淘汰」的排序。
    Count { size: u64, oldest: u64 },
    /// 整个目录没有存在价值，删掉。
    Drop,
    /// 原样保留，且不计入预算（异常状态，为它淘汰别人反而错）。
    Skip,
}

/// 按索引状态给目录定性。删除决策**只看这里**——「读不懂」与「没有」必须分开：
/// 前者可能是坏字节/被杀软独占/改了 schema，里面躺着完好 blob，删了就是数据丢失。
fn classify_dir(dir: &Path) -> DirAction {
    match load_index(dir) {
        IndexLoad::Broken => DirAction::Skip,
        // 没有索引 = 没有任何接口能到达这个目录（list/read/restore 全走索引），
        //  blob 留着也只是占磁盘
        IndexLoad::Missing => DirAction::Drop,
        IndexLoad::Ok(idx) if idx.versions.is_empty() => DirAction::Drop,
        IndexLoad::Ok(idx) => DirAction::Count {
            size: idx.versions.iter().map(|v| v.size).sum(),
            oldest: idx.versions.last().map(|v| v.ts).unwrap_or(0),
        },
    }
}

/// 全局淘汰的实现。预算由参数传入（生产传常量、测试传小值）——否则
/// 「超预算才淘汰」这条路在单测里永远走不到，改坏了也没人知道。
///
/// 整份淘汰（而不是逐版本删）是有意的：跨文件挑最旧的版本会让每个文件都剩半截
/// 历史，看哪份都不完整；整份淘汰至少保住「最近在改的文件有完整历史」。
/// 刚写入的 `keep_dir` 不参与淘汰——不能把用户这一下保存挤掉。
fn evict_over_budget(
    root: &Path,
    keep_dir: &Path,
    max_bytes: u64,
    max_files: usize,
) -> Result<(), String> {
    let entries = match fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return Ok(()),
    };
    let mut dirs: Vec<(PathBuf, u64, u64)> = Vec::new(); // (目录, 总字节, 最早一版的时间)
    let mut total: u64 = 0;
    for e in entries.flatten() {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        match classify_dir(&p) {
            DirAction::Skip => continue,
            DirAction::Drop => {
                let _ = fs::remove_dir_all(&p);
                continue;
            }
            DirAction::Count { size, oldest } => {
                total += size;
                dirs.push((p, size, oldest));
            }
        }
    }
    if total <= max_bytes && dirs.len() <= max_files {
        return Ok(());
    }
    dirs.sort_by_key(|(_, _, oldest)| *oldest);
    let mut files_left = dirs.len();
    for (dir, size, _) in &dirs {
        if total <= max_bytes && files_left <= max_files {
            break;
        }
        if dir == keep_dir {
            continue;
        }
        if fs::remove_dir_all(dir).is_ok() {
            total = total.saturating_sub(*size);
            files_left -= 1;
        }
    }
    Ok(())
}

/// 列出一个文件的历史版本（最新在前）。没有历史返回空 Vec。
pub fn list(config_dir: &Path, path: &Path) -> Result<Vec<HistoryVersion>, String> {
    // stable_key 里有一次 canonicalize（磁盘 IO），放在锁外：它不决定索引内容，
    // 只决定用哪个槽位的锁与哪个目录
    let key = stable_key(path)?;
    let _g = file_lock(&key).lock().unwrap_or_else(|e| e.into_inner());
    let dir = history_dir(config_dir).join(slug(&key));
    Ok(read_index(&dir).versions)
}

/// 读一个历史版本的原始字节。
pub fn read_version(config_dir: &Path, path: &Path, id: &str) -> Result<Vec<u8>, String> {
    if !valid_id(id) {
        return Err("非法的版本号".to_string());
    }
    let key = stable_key(path)?;
    let _g = file_lock(&key).lock().unwrap_or_else(|e| e.into_inner());
    let dir = history_dir(config_dir).join(slug(&key));
    let blob = dir.join(format!("{id}.bin"));
    if !blob.is_file() {
        return Err("这个版本已经不在历史里了（可能被上限淘汰）".to_string());
    }
    fs::read(&blob).map_err(|e| format!("读历史版本失败: {e}"))
}

/// 恢复一个历史版本：把那一版的字节写回文件。
///
/// - 写之前先把**当前**内容归档一版：恢复本身也是一次改动，得能再退回来。
/// - `expected_mtime_ms` 与保存同口径：磁盘被别的程序改过就报 `CONFLICT`，不覆盖。
pub fn restore(
    config_dir: &Path,
    path: &Path,
    id: &str,
    expected_mtime_ms: Option<u64>,
) -> Result<(), String> {
    if !valid_id(id) {
        return Err("非法的版本号".to_string());
    }
    // 先取旧版内容再锁外归档：capture 自己会拿锁（std Mutex 不可重入）
    let old = {
        let key = stable_key(path)?;
        let _g = file_lock(&key).lock().unwrap_or_else(|e| e.into_inner());
        let dir = history_dir(config_dir).join(slug(&key));
        let blob = dir.join(format!("{id}.bin"));
        if !blob.is_file() {
            return Err("这个版本已经不在历史里了（可能被上限淘汰）".to_string());
        }
        fs::read(&blob).map_err(|e| format!("读历史版本失败: {e}"))?
    };
    if let Some(expect) = expected_mtime_ms {
        let actual = fs::metadata(path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        if actual != expect {
            return Err(format!(
                "CONFLICT: 磁盘上的文件自你打开后被改过（期望 mtime {expect}，实际 {actual}），先刷新再恢复"
            ));
        }
    }
    capture(config_dir, path, KEEP_PER_FILE)?;
    // 直接写字节：历史版本是原样复制，不需要也不该经过编码/换行转换。
    // 走统一的原子写：同目录随机临时名（并发恢复不撞名，P1-5）+ 写完 sync_all
    // 再 rename，保证目标不会变成旧新混合的半截内容；rename 只保证原子性、
    // 不保证持久性，刷盘由 `write_atomic` 负责（P1-6 的注释口径）。
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    crate::atomic_file::write_atomic(path, &old)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ncf-hist-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn 相同内容不重复归档() {
        let cfg = tmp("dedup");
        let f = cfg.join("A.java");
        fs::write(&f, "class A {}").unwrap();
        assert!(capture(&cfg, &f, KEEP_PER_FILE).unwrap().is_some());
        assert!(capture(&cfg, &f, KEEP_PER_FILE).unwrap().is_none());
        assert_eq!(list(&cfg, &f).unwrap().len(), 1);
    }

    #[test]
    fn 改动后归档新版本并可原样恢复() {
        let cfg = tmp("round");
        let f = cfg.join("A.java");
        fs::write(&f, "v1").unwrap();
        capture(&cfg, &f, KEEP_PER_FILE).unwrap();
        fs::write(&f, "v2").unwrap();
        capture(&cfg, &f, KEEP_PER_FILE).unwrap();
        let vs = list(&cfg, &f).unwrap();
        assert_eq!(vs.len(), 2);
        assert_eq!(vs[0].size, 2);
        // 二进制也原样进、原样出（含 0 字节与混合换行）
        fs::write(&f, b"a\r\nb\n\x00").unwrap();
        capture(&cfg, &f, KEEP_PER_FILE).unwrap();
        let last = list(&cfg, &f).unwrap().swap_remove(0);
        let bytes = read_version(&cfg, &f, &last.id).unwrap();
        assert_eq!(bytes, b"a\r\nb\n\x00");
        restore(&cfg, &f, &last.id, None).unwrap();
        assert_eq!(fs::read(&f).unwrap(), b"a\r\nb\n\x00");
    }

    #[test]
    fn 单文件超过上限淘汰最旧的() {
        let cfg = tmp("cap");
        let f = cfg.join("A.java");
        fs::write(&f, "0").unwrap();
        capture(&cfg, &f, 3).unwrap();
        for i in 1..6 {
            fs::write(&f, format!("{i}")).unwrap();
            capture(&cfg, &f, 3).unwrap();
        }
        let vs = list(&cfg, &f).unwrap();
        assert_eq!(vs.len(), 3);
        // 留下的应是最新的三版（5/4/3），最旧两版的 blob 已删
        let bytes = read_version(&cfg, &f, &vs[0].id).unwrap();
        assert_eq!(bytes, b"5");
        let dir = history_dir(&cfg).join(slug(&stable_key(&f).unwrap()));
        let blobs = fs::read_dir(&dir).unwrap().flatten().count();
        assert_eq!(blobs, 3 + 1); // 3 个 bin + index.json
    }

    #[test]
    fn 非法版本号被拒() {
        let cfg = tmp("badid");
        let f = cfg.join("A.java");
        fs::write(&f, "x").unwrap();
        assert!(read_version(&cfg, &f, "../../secret").is_err());
        assert!(restore(&cfg, &f, "..", None).is_err());
    }

    #[test]
    fn 恢复前冲突不覆盖() {
        let cfg = tmp("conflict");
        let f = cfg.join("A.java");
        fs::write(&f, "v1").unwrap();
        capture(&cfg, &f, KEEP_PER_FILE).unwrap();
        fs::write(&f, "v2").unwrap();
        capture(&cfg, &f, KEEP_PER_FILE).unwrap();
        let first = list(&cfg, &f).unwrap().pop().unwrap();
        // 期望一个早就过去的 mtime：等价于「磁盘被别的程序改过」
        let err = restore(&cfg, &f, &first.id, Some(1)).unwrap_err();
        assert!(err.starts_with("CONFLICT"), "{err}");
        assert_eq!(fs::read_to_string(&f).unwrap(), "v2");
    }

    /// keep=0 曾把刚写进去的版本连同目录一起裁掉，却仍返回 Some(id)——
    /// 调用方拿到一个指向已删 blob 的 id。IPC 层硬编码 20，这里兜住契约。
    #[test]
    fn keep为0时按1版处理() {
        let cfg = tmp("keep0");
        let f = cfg.join("A.java");
        fs::write(&f, "v1").unwrap();
        let id = capture(&cfg, &f, 0).unwrap().expect("keep=0 也要归档一版");
        assert_eq!(list(&cfg, &f).unwrap().len(), 1);
        assert_eq!(read_version(&cfg, &f, &id).unwrap(), b"v1");
        fs::write(&f, "v2").unwrap();
        let id2 = capture(&cfg, &f, 0).unwrap().unwrap();
        assert_eq!(read_version(&cfg, &f, &id2).unwrap(), b"v2");
        assert_eq!(list(&cfg, &f).unwrap().len(), 1);
    }

    /// 比整个全局预算还大的文件：一版就装不下，归档它只会让全局淘汰天天删别人。
    ///
    /// 预算通过 [`capture_limited`] 注入小值，**不**造真实大文件：`set_len` 在 NTFS 上
    /// 会实打实分配空间（不是稀疏文件），一条用例就能往临时目录里写 512MB。
    #[test]
    fn 比全局预算还大的文件不归档() {
        let cfg = tmp("huge");
        let f = cfg.join("big.java");
        fs::write(&f, b"1234567890").unwrap(); // 10 字节 > 4 字节预算
        assert!(capture_limited(&cfg, &f, KEEP_PER_FILE, 4)
            .unwrap()
            .is_none());
        assert!(list(&cfg, &f).unwrap().is_empty());
        // 边界：恰好等于预算要照常归档（判断是「严格大于」）
        assert!(capture_limited(&cfg, &f, KEEP_PER_FILE, 10)
            .unwrap()
            .is_some());
    }

    /// 索引读不懂 ≠ 没有索引。当成空索引会把整个目录（连同完好的 blob）删掉。
    #[test]
    fn 索引读不懂的目录在全局淘汰里原样保留() {
        let cfg = tmp("broken");
        let root = history_dir(&cfg);
        let a = cfg.join("A.java");
        let b = cfg.join("B.java");
        let c = cfg.join("C.java");
        fs::write(&a, "aaaa").unwrap();
        fs::write(&b, "bb").unwrap();
        fs::write(&c, "c").unwrap();
        capture(&cfg, &a, KEEP_PER_FILE).unwrap();
        capture(&cfg, &b, KEEP_PER_FILE).unwrap();
        capture(&cfg, &c, KEEP_PER_FILE).unwrap();
        let dir_c = root.join(slug(&stable_key(&c).unwrap()));
        // 写坏 C 的索引：模拟磁盘坏字节 / 被杀软工具改坏
        fs::write(dir_c.join("index.json"), "{ 坏了").unwrap();

        // 预算卡到 4 字节，只有 A 放得下。B 应被整份淘汰，C 原样保留，A 不动
        evict_over_budget(&root, &root.join(slug(&stable_key(&a).unwrap())), 4, 500).unwrap();

        assert!(
            !root.join(slug(&stable_key(&b).unwrap())).exists(),
            "最早不动的 B 应被淘汰"
        );
        assert!(dir_c.exists(), "索引读不懂的目录不能删");
        let blobs = fs::read_dir(&dir_c)
            .unwrap()
            .flatten()
            .filter(|e| e.path().extension().map(|x| x == "bin").unwrap_or(false))
            .count();
        assert_eq!(blobs, 1, "坏索引目录里的 blob 必须保住");
        assert_eq!(list(&cfg, &a).unwrap().len(), 1, "keep_dir 不动");
    }

    /// 没有索引的目录：任何接口都到不了（list/read/restore 全走索引），
    /// blob 留着只是占磁盘，预算再充裕也要清。
    #[test]
    fn 没有索引的目录被清掉() {
        let cfg = tmp("missing");
        let root = history_dir(&cfg);
        let orphan = root.join("deadbeef");
        fs::create_dir_all(&orphan).unwrap();
        fs::write(orphan.join("x.bin"), "没人引用的 blob").unwrap();
        let f = cfg.join("A.java");
        // 节流时间戳是进程级静态，而 cargo test 并行跑用例：别的用例在我
        // store(0) 之后、capture 之前又盖一个新时间戳，这次就被节流挡掉。
        // 生产上这个清理最多晚一分钟（安全阀不是即时任务），所以这里重试到
        // 抢到为止——每次换内容，保证 capture 不会因「内容相同」提前返回。
        for i in 0..8 {
            fs::write(&f, format!("a{i}")).unwrap();
            LAST_CAP_SWEEP_MS.store(0, std::sync::atomic::Ordering::Relaxed);
            capture(&cfg, &f, KEEP_PER_FILE).unwrap();
            if !orphan.exists() {
                return;
            }
        }
        panic!("无索引目录应被清掉");
    }

    /// 上一轮写到一半崩溃会留下「blob 落盘、索引没写成」的孤儿：
    /// 索引每轮全量重写，不在索引里的 .bin 就是可以安全删除的。
    #[test]
    fn 索引外的blob被清掉() {
        let cfg = tmp("orphan");
        let f = cfg.join("A.java");
        fs::write(&f, "v1").unwrap();
        capture(&cfg, &f, KEEP_PER_FILE).unwrap();
        let dir = history_dir(&cfg).join(slug(&stable_key(&f).unwrap()));
        fs::write(dir.join("1699999999-deadbeef.bin"), "没人引用").unwrap();
        fs::write(&f, "v2").unwrap();
        capture(&cfg, &f, KEEP_PER_FILE).unwrap();
        assert_eq!(list(&cfg, &f).unwrap().len(), 2, "两版都在索引里");
        assert!(
            !dir.join("1699999999-deadbeef.bin").exists(),
            "索引外的 blob 应被清掉"
        );
    }

    /// 恢复走统一的原子写：成功不该留下 `AtomicTarget` 的临时文件。
    #[test]
    fn 恢复后不留临时文件() {
        let cfg = tmp("notmp");
        let f = cfg.join("A.java");
        fs::write(&f, "v1").unwrap();
        capture(&cfg, &f, KEEP_PER_FILE).unwrap();
        let id = list(&cfg, &f).unwrap()[0].id.clone();
        fs::write(&f, "v2").unwrap();
        restore(&cfg, &f, &id, None).unwrap();
        assert_eq!(fs::read_to_string(&f).unwrap(), "v1");
        let leftovers: Vec<String> = fs::read_dir(&cfg)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with(".ncforge-") && n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "恢复不该留下临时文件: {leftovers:?}");
    }
}
