//! jar 内符号索引：把 `class_pool` 抽出的符号预建成倒排，查询只读索引不扫 jar。
//!
//! # 为什么是「预建」而不是「现扫」
//!
//! Eclipse 的 jar 内搜索是秒级的，解剖本机它的做法就一句话：查询不碰 jar，只查
//! 5502 个 `.index`（345MB）。我们也走同一条路——一次性把 3341 个 jar 的常量池
//! 解成倒排写进一个文件，之后每次搜索只是在一份约 20MB 的有序词表里做匹配。
//!
//! # 规模（本机实测，全量 nc65home/modules）
//!
//! | 项 | 值 |
//! | --- | --- |
//! | jar | 3341 |
//! | class | 280 926 |
//! | 常量池原始条目 | 25 613 161 |
//! | 去噪后保留 | 10 994 468 |
//! | **唯一词** | **1 391 862**（含中文 22 730） |
//! | 词表字节 | 20.7 MB |
//!
//! 唯一词只有百万级、词表 20MB，所以**整个词表可以常驻内存**：查询是一次线性扫描
//! （毫秒级），不需要 n-gram 那套复杂结构。
//!
//! # 文件格式（`symbols.bin`，单文件自包含）
//!
//! ```text
//! [64B 头：各段偏移与计数]
//! terms_off  (n+1)×u32   → 词表字节偏移
//! terms_blob            → 排序去重后的词（UTF-8）
//! class_jar  m×u16      → 每个 class 属于哪个 jar
//! class_off  (m+1)×u32  → class 名偏移
//! class_blob           → class 全限定名（`/`→`.`，内部类保留 `$`）
//! post_off   (n+1)×u32  → 每个词的命中区在 post_blob 里的字节偏移
//! post_blob            → 每词：u8 条数 + 条数×u32 class 下标 + u32 真实命中处数
//! jar_fp     j×16       → (len u64, mtime nanos u64)，判索引是否过期
//! jar_paths  j×(u16 + 字节) → jar 绝对路径
//! ```
//!
//! 命中里存 **class 下标**而不是 jar 下标：一个词在同一个 jar 的几十个类里出现时
//! 只记前 `MAX_PLACES` 处，但**真实处数单独存一个 u32**——界面说「另有 N 处」
//! 时拿它算，否则 8 处以外的全被吞掉（`placesTotal`）。
//!
//! `VERSION` 与文件格式一一对应：改格式必须升版，否则旧文件会被当新格式解析，
//! 读出垃圾偏移直接 panic。

use crate::class_pool::class_terms;
use crate::nc_index::ClassIndex;
use std::borrow::Cow;
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const MAGIC: &[u8; 4] = b"NJSX";
const VERSION: u32 = 2;
const HEADER: usize = 64;

/// 每个词最多保留几处出现。界面只展示前几处，词频不参与排序——多存只是放大文件。
const MAX_PLACES: usize = 8;

/// 单个 class 读多少字节就够。常量池在文件头部，8MB 足够覆盖 NC 里最大的类；
/// 真遇到病态大类也只是少几个符号，不该为它把内存打满。
const MAX_CLASS_BYTES: u64 = 8 * 1024 * 1024;

/// 一次扫描词表的时间上限。正常是毫秒级；超了说明撞上极端情况，
/// 把已匹配的部分交回去并告知「可能不全」，别把用户扣在输入框前。
const SCAN_BUDGET_MS: u128 = 500;

/// 一处出现：jar 路径 + 类全限定名。
#[derive(Debug, Clone)]
pub struct JarSymbolPlace {
    pub jar: String,
    pub class: String,
}

/// 一个命中词。
#[derive(Debug, Clone)]
pub struct JarSymbolHit {
    pub term: String,
    /// 0 精确 / 1 前缀 / 2 包含。
    pub score: u8,
    pub places: Vec<JarSymbolPlace>,
    /// 这个词真实命中多少处（可能远大于 `places.len()`：后者最多 `MAX_PLACES`）。
    pub places_total: usize,
}

/// 一次查询的结果。
#[derive(Debug, Clone)]
pub struct JarSymbolSearch {
    pub hits: Vec<JarSymbolHit>,
    /// 一共匹配到多少个词（`hits` 可能因 `limit` 截断）。
    pub total: usize,
    /// 扫描超时提前退出：结果可能不全。
    pub truncated: bool,
    pub elapsed_ms: u64,
}

fn put_u16(v: &mut Vec<u8>, x: u16) {
    v.extend_from_slice(&x.to_le_bytes());
}
fn put_u32(v: &mut Vec<u8>, x: u32) {
    v.extend_from_slice(&x.to_le_bytes());
}
fn put_u64(v: &mut Vec<u8>, x: u64) {
    v.extend_from_slice(&x.to_le_bytes());
}
fn poke_u32(d: &mut [u8], at: usize, x: u32) {
    d[at..at + 4].copy_from_slice(&x.to_le_bytes());
}
fn rd_u16(d: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes([*d.get(at)?, *d.get(at + 1)?]))
}
fn rd_u32(d: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes([
        *d.get(at)?,
        *d.get(at + 1)?,
        *d.get(at + 2)?,
        *d.get(at + 3)?,
    ]))
}
fn rd_u64(d: &[u8], at: usize) -> Option<u64> {
    let mut b = [0u8; 8];
    b.copy_from_slice(d.get(at..at + 8)?);
    Some(u64::from_le_bytes(b))
}

/// 大小写无关的字节比较。
///
/// UTF-8 多字节序列不含 ASCII 字母字节，所以逐字节等同比较就是正确的大小写无关
/// 比较——不需要第二份 lower blob。std 的 `[u8]::eq_ignore_ascii_case` 是同一语义
/// 且优化更好，`search` 的热路径直接用它（这里不再另留一份，避免两处实现漂移）。
fn fingerprint(path: &Path) -> Option<(u64, u64)> {
    let m = std::fs::metadata(path).ok()?;
    let nanos = m
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos() as u64);
    Some((m.len(), nanos))
}

/// jar 目录 → 索引缓存目录。不同 NC home 的 jar 清单不同，混用一个文件会互相覆盖。
pub fn cache_dir_for(config_dir: &Path, nc_home: &str) -> PathBuf {
    // FNV-1a：只为分目录，不需要密码学强度
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in nc_home.to_lowercase().as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100_0000_01b3);
    }
    config_dir.join("jar-symbols").join(format!("{h:016x}"))
}

/// 建索引并写盘。jar 读失败 / class 畸形都只跳过，不中断。
///
/// `Err` 分两种：`"已取消"`（此时不写文件，别留下半份索引）与写盘失败
/// （磁盘满 / 杀软占用）。以前两者都返回 `None`，调用方分不清，写盘失败会被
/// 当成「用户取消了」，于是无日志、无错误态，界面永远演「正在后台建立」。
pub fn build(
    index: &ClassIndex,
    out: &Path,
    progress: &dyn Fn(usize, usize),
    cancelled: &dyn Fn() -> bool,
) -> Result<(), String> {
    if index.jars.len() > u16::MAX as usize {
        return Err(format!(
            "jar 数 {} 超过 u16 上限，本次不建",
            index.jars.len()
        ));
    }
    // 🔴 指纹必须在扫描**之前**取：建索引要一分钟，期间 jar 被打补丁替换掉的话，
    // 扫进去的是旧内容、记下来的却是新文件的指纹——索引从此「看起来新鲜」，
    // 内容却永远是旧的，且再也不会被判过期。
    let jar_fps: Vec<(u64, u64)> = index
        .jars
        .iter()
        .map(|jar| fingerprint(jar).unwrap_or((0, 0)))
        .collect();
    // term → (class 下标（有上限）, 真实命中处数)。百万级词、每词至多 8 处，
    // 峰值内存在百 MB 量级；处数只多一个 u32，却能让界面说清「另有 N 处」。
    let mut terms: HashMap<String, (Vec<u32>, u32)> = HashMap::new();
    let mut class_jar: Vec<u16> = Vec::new();
    let mut class_off: Vec<u32> = vec![0];
    let mut class_blob: Vec<u8> = Vec::new();
    let mut buf: Vec<u8> = Vec::new();

    for (id, jar) in index.jars.iter().enumerate() {
        if cancelled() {
            return Err("已取消".to_string());
        }
        let Ok(file) = File::open(jar) else { continue };
        let Ok(mut archive) = zip::ZipArchive::new(file) else {
            continue;
        };
        for i in 0..archive.len() {
            let Ok(entry) = archive.by_index(i) else {
                continue;
            };
            let name = entry.name().to_string();
            if !name.ends_with(".class") || name.starts_with("META-INF/") {
                continue;
            }
            buf.clear();
            if entry.take(MAX_CLASS_BYTES).read_to_end(&mut buf).is_err() {
                continue;
            }
            // `scratch`  borrow 着 `buf`，必须活在本次迭代里：声明在外层会让借用
            // 跨越下一轮的 `buf.clear()`，编译期就过不去。
            let mut scratch: Vec<Cow<'_, str>> = Vec::new();
            if !class_terms(&buf, &mut scratch) {
                continue;
            }
            class_jar.push(id as u16);
            let dotted = name.trim_end_matches(".class").replace('/', ".");
            class_blob.extend_from_slice(dotted.as_bytes());
            class_off.push(class_blob.len() as u32);
            let at = (class_jar.len() - 1) as u32;
            for term in &scratch {
                // 两段式而不是 entry()：命中时不必为已存在的词再分配一个 String
                match terms.get_mut(term.as_ref()) {
                    Some((places, total)) => {
                        *total += 1;
                        if places.len() < MAX_PLACES {
                            places.push(at);
                        }
                    }
                    None => {
                        terms.insert(term.to_string(), (vec![at], 1));
                    }
                }
            }
        }
        if id % 250 == 0 || id + 1 == index.jars.len() {
            progress(id + 1, index.jars.len());
        }
    }

    let mut names: Vec<&str> = terms.keys().map(String::as_str).collect();
    names.sort_unstable_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
    let mut terms_off = Vec::with_capacity(names.len() + 1);
    let mut terms_blob = Vec::new();
    terms_off.push(0u32);
    for n in &names {
        terms_blob.extend_from_slice(n.as_bytes());
        terms_off.push(terms_blob.len() as u32);
    }
    let mut post_off = Vec::with_capacity(names.len() + 1);
    let mut post_blob = Vec::new();
    post_off.push(0u32);
    for n in &names {
        let (places, total) = &terms[*n];
        post_blob.push(places.len() as u8);
        for at in places {
            post_blob.extend_from_slice(&at.to_le_bytes());
        }
        post_blob.extend_from_slice(&total.to_le_bytes());
        post_off.push(post_blob.len() as u32);
    }

    let n = names.len() as u32;
    let m = class_jar.len() as u32;
    let j = index.jars.len() as u32;
    let mut data: Vec<u8> = Vec::new();
    data.extend_from_slice(&[0u8; HEADER]);
    let terms_off_at = data.len() as u32;
    for x in &terms_off {
        put_u32(&mut data, *x);
    }
    data.extend_from_slice(&terms_blob);
    let class_jar_at = data.len() as u32;
    for x in &class_jar {
        put_u16(&mut data, *x);
    }
    let class_off_at = data.len() as u32;
    for x in &class_off {
        put_u32(&mut data, *x);
    }
    let class_blob_at = data.len() as u32;
    data.extend_from_slice(&class_blob);
    let post_off_at = data.len() as u32;
    for x in &post_off {
        put_u32(&mut data, *x);
    }
    let post_blob_at = data.len() as u32;
    data.extend_from_slice(&post_blob);
    let jar_fp_at = data.len() as u32;
    for (len, nanos) in &jar_fps {
        put_u64(&mut data, *len);
        put_u64(&mut data, *nanos);
    }
    let jar_paths_at = data.len() as u32;
    for jar in &index.jars {
        let raw = jar.to_string_lossy();
        put_u16(&mut data, raw.len() as u16);
        data.extend_from_slice(raw.as_bytes());
    }

    let total_len = data.len() as u32;
    let head = &mut data[..HEADER];
    head[..4].copy_from_slice(MAGIC);
    poke_u32(head, 4, VERSION);
    poke_u32(head, 8, n);
    poke_u32(head, 12, m);
    poke_u32(head, 16, j);
    poke_u32(head, 20, terms_off_at);
    poke_u32(head, 24, class_jar_at);
    poke_u32(head, 28, class_off_at);
    poke_u32(head, 32, class_blob_at);
    poke_u32(head, 36, post_off_at);
    poke_u32(head, 40, post_blob_at);
    poke_u32(head, 44, jar_fp_at);
    poke_u32(head, 48, jar_paths_at);
    poke_u32(head, 52, total_len);

    if let Some(parent) = out.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let temp = out.with_extension("tmp");
    let write = || -> std::io::Result<()> {
        let mut f = File::create(&temp)?;
        f.write_all(&data)?;
        drop(f);
        std::fs::rename(&temp, out)?;
        Ok(())
    };
    if let Err(e) = write() {
        // 写盘失败必须说出来：当成「取消」会让功能永远停在「正在后台建立」，
        // 而用户能做的只是清磁盘 / 加杀软白名单后重启
        log::error!("jar 符号索引写盘失败（{}）：{e}；索引未更新", out.display());
        return Err(format!("写索引文件失败：{e}"));
    }
    log::info!(
        "jar 符号索引：{} 词 / {} class / {} jar，{} MB",
        n,
        m,
        j,
        data.len() / (1024 * 1024)
    );
    Ok(())
}

/// 载入后的索引。字段是各段在 `data` 里的偏移，查询时零拷贝切片。
pub struct JarSymbolIndex {
    data: Vec<u8>,
    terms_off_at: usize,
    class_jar_at: usize,
    class_off_at: usize,
    class_blob_at: usize,
    post_off_at: usize,
    post_blob_at: usize,
    jar_fp_at: usize,
    jar_paths_at: usize,
    terms: usize,
    classes: usize,
    jars: usize,
    /// 词表里 256 个字节值的出现次数（`load` 时现算，不进文件）。
    ///
    /// 用途：查询词在词表里是**子串**匹配，必须扫。拿哪个字节当扫描锚，代价差两个
    /// 数量级——`a` 在 20MB 英文词表里有上百万个候选，`V` 只有一万个。所以每次搜索
    /// 先挑 needle 里频率最低的那个字节（连它的大小写形态一起算）。
    byte_freq: [u32; 256],
}

impl JarSymbolIndex {
    /// 从磁盘载入。格式不符 / 段越界一律 `None`（调用方重建）。
    pub fn load(path: &Path) -> Option<Self> {
        let mut data = Vec::new();
        File::open(path).ok()?.read_to_end(&mut data).ok()?;
        if data.len() < HEADER || data[..4] != *MAGIC || rd_u32(&data, 4)? != VERSION {
            return None;
        }
        if rd_u32(&data, 52)? as usize != data.len() {
            return None;
        }
        let mut me = Self {
            terms_off_at: rd_u32(&data, 20)? as usize,
            class_jar_at: rd_u32(&data, 24)? as usize,
            class_off_at: rd_u32(&data, 28)? as usize,
            class_blob_at: rd_u32(&data, 32)? as usize,
            post_off_at: rd_u32(&data, 36)? as usize,
            post_blob_at: rd_u32(&data, 40)? as usize,
            jar_fp_at: rd_u32(&data, 44)? as usize,
            jar_paths_at: rd_u32(&data, 48)? as usize,
            terms: rd_u32(&data, 8)? as usize,
            classes: rd_u32(&data, 12)? as usize,
            jars: rd_u32(&data, 16)? as usize,
            byte_freq: [0; 256],
            data,
        };
        // 段与段必须首尾相接且不越界；terms_off[terms] 同时是词表与 post_blob 的长度
        let ordered = [
            me.terms_off_at,
            me.class_jar_at,
            me.class_off_at,
            me.class_blob_at,
            me.post_off_at,
            me.post_blob_at,
            me.jar_fp_at,
            me.jar_paths_at,
        ];
        let end = me.data.len();
        if ordered.windows(2).any(|w| w[0] > w[1]) || *ordered.last()? > end {
            return None;
        }
        // 词表段自身要能按条数取完：缺这条时 `terms_blob()` 的裸切片会 panic
        // （坏索引 / 被改小的文件都能造出这种头）
        if me.terms_off_at + (me.terms + 1) * 4 > me.class_jar_at
            || me.class_off_at + (me.classes + 1) * 4 > me.class_blob_at
        {
            return None;
        }
        let post_bytes = me.u32_at(me.post_off_at, me.terms)? as usize;
        if me.post_blob_at + post_bytes != me.jar_fp_at
            || me.jar_fp_at + me.jars * 16 != me.jar_paths_at
        {
            return None;
        }
        // 词表的 256 字节频率表：给查询词挑低频锚字节用。**只在内存里算，不进文件**——
        // 改文件格式会让所有已建索引作废，而这里只是一遍 20MB 的顺序扫（约 10ms），
        // 载入本来就要读 96MB，这点 CPU 相比磁盘 IO 可以忽略。
        let mut byte_freq = [0u32; 256];
        for &b in me.terms_blob() {
            byte_freq[b as usize] = byte_freq[b as usize].saturating_add(1);
        }
        me.byte_freq = byte_freq;
        Some(me)
    }

    fn u32_at(&self, section: usize, i: usize) -> Option<u32> {
        rd_u32(&self.data, section + i * 4)
    }
    fn terms_blob(&self) -> &[u8] {
        let start = self.terms_off_at + (self.terms + 1) * 4;
        &self.data[start..self.class_jar_at]
    }
    fn term_at(&self, id: usize) -> Option<&[u8]> {
        let a = self.u32_at(self.terms_off_at, id)? as usize;
        let b = self.u32_at(self.terms_off_at, id + 1)? as usize;
        let start = self.terms_off_at + (self.terms + 1) * 4;
        self.data.get(start + a..start + b)
    }
    fn term_len(&self, id: usize) -> usize {
        self.u32_at(self.terms_off_at, id + 1)
            .zip(self.u32_at(self.terms_off_at, id))
            .map_or(0, |(e, s)| (e - s) as usize)
    }
    /// 字节位置 → 词下标（`terms_off` 单调，二分）。位置必须落在词表内。
    fn term_id_at(&self, pos: usize) -> Option<usize> {
        let mut lo = 0usize;
        let mut hi = self.terms;
        while lo < hi {
            let mid = lo + (hi - lo).div_ceil(2);
            if self.u32_at(self.terms_off_at, mid)? as usize <= pos {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        Some(lo)
    }
    fn jar_of_class(&self, at: u32) -> Option<u16> {
        // 倒排里的 class 下标来自磁盘上的旧索引：索引损坏或被改小时越界读会拿到
        // 垃圾 jar id，所以先按 `classes` 收口。
        if at as usize >= self.classes {
            return None;
        }
        rd_u16(&self.data, self.class_jar_at + at as usize * 2)
    }
    fn class_name(&self, at: u32) -> Option<&[u8]> {
        if at as usize >= self.classes {
            return None;
        }
        let a = self.u32_at(self.class_off_at, at as usize)? as usize;
        let b = self.u32_at(self.class_off_at, at as usize + 1)? as usize;
        self.data
            .get(self.class_blob_at + a..self.class_blob_at + b)
    }
    fn jar_path(&self, id: u16) -> Option<&str> {
        let mut at = self.jar_paths_at;
        for i in 0..=id {
            let len = rd_u16(&self.data, at)? as usize;
            at += 2;
            let raw = self.data.get(at..at + len)?;
            at += len;
            if i == id {
                return std::str::from_utf8(raw).ok();
            }
        }
        None
    }
    /// 一个词的出现处：最多 `MAX_PLACES` 个 (jar, class)，外加真实命中处数。
    fn places(&self, id: usize) -> (Vec<JarSymbolPlace>, usize) {
        let start = match self.u32_at(self.post_off_at, id) {
            Some(x) => self.post_blob_at + x as usize,
            None => return (Vec::new(), 0),
        };
        let end = match self.u32_at(self.post_off_at, id + 1) {
            Some(x) => self.post_blob_at + x as usize,
            None => return (Vec::new(), 0),
        };
        let Some(body) = self.data.get(start..end).filter(|b| !b.is_empty()) else {
            return (Vec::new(), 0);
        };
        let count = body[0] as usize;
        // 布局：u8 条数 + 条数×u32 + u32 真实处数
        let total = rd_u32(body, 1 + count * 4).unwrap_or(count as u32) as usize;
        let mut out = Vec::with_capacity(count.min(MAX_PLACES));
        for k in 0..count {
            let Some(ci) = rd_u32(body, 1 + k * 4) else {
                break;
            };
            let (Some(jar_id), Some(class)) = (self.jar_of_class(ci), self.class_name(ci)) else {
                break;
            };
            let Some(jar) = self.jar_path(jar_id) else {
                break;
            };
            out.push(JarSymbolPlace {
                jar: jar.to_string(),
                class: String::from_utf8_lossy(class).into_owned(),
            });
        }
        (out, total)
    }

    /// 索引是否与当前 jar 目录不一致（jar 被替换 / 增删 / 改名）。
    ///
    /// 路径也要比：只比 size+mtime 的话，「同尺寸同 mtime 的另一个文件」与
    /// 「改名」都判成新鲜——而索引里记的 jar 路径已经错了，点命中会打错包。
    pub fn stale(&self, index: &ClassIndex) -> bool {
        if self.jars != index.jars.len() {
            return true;
        }
        // jar_paths 是顺序段，一遍走完同时比路径与指纹（分开两遍走是 O(j²)）
        let mut at = self.jar_paths_at;
        for (id, jar) in index.jars.iter().enumerate() {
            let Some(len) = rd_u16(&self.data, at).map(usize::from) else {
                return true;
            };
            at += 2;
            let Some(raw) = self.data.get(at..at + len) else {
                return true;
            };
            at += len;
            if raw != jar.to_string_lossy().as_bytes() {
                return true;
            }
            let Some((len, nanos)) = fingerprint(jar) else {
                return true;
            };
            let base = self.jar_fp_at + id * 16;
            if rd_u64(&self.data, base) != Some(len) || rd_u64(&self.data, base + 8) != Some(nanos)
            {
                return true;
            }
        }
        false
    }

    /// 词表大小（诊断 / 测试用）。
    pub fn term_count(&self) -> usize {
        self.terms
    }

    /// 在词表里找包含 `query` 的词（大小写无关），
    /// 按「精确 > 前缀 > 包含，同级短词优先」排序。
    pub fn search(&self, query: &str, limit: usize) -> JarSymbolSearch {
        let started = std::time::Instant::now();
        let q = query.trim();
        if q.len() < 2 || limit == 0 || self.terms == 0 {
            return JarSymbolSearch {
                hits: Vec::new(),
                total: 0,
                truncated: false,
                elapsed_ms: 0,
            };
        }
        let needle = q.to_ascii_lowercase().into_bytes();
        let n = needle.len();
        let blob = self.terms_blob();

        // ── 挑扫描锚：needle 里频率最低的那个字节（含其大写形态）──
        //
        // 子串匹配没有二分可走，必须扫词表；但扫的代价全看拿谁当锚。`a` 在 20MB
        // 英文词表里有上百万个候选，`V` 只有一万个——同一个查询能差两个数量级
        // （实测 `ArapTempVoucherVO`：用 `a` 501ms 还触发超时截断，用锚字节后 <20ms）。
        // UTF-8 多字节序列不含 ASCII 字母字节，所以「大小写无关」在字节层就是
        // 「找该字节的小写与大写两个形态」，`memchr2` 一次搞定（SIMD）。
        //
        // 顺带一个免费的快速失败：needle 里只要有一个字节在词表里**一次都没出现**，
        // 这个词就不可能命中，直接回空。
        let mut anchor: Option<(u32, usize, u8, u8)> = None; // (频率, 在 needle 里的偏移, 小写, 大写)
        for (k, &b) in needle.iter().enumerate() {
            let lo = b.to_ascii_lowercase();
            let up = b.to_ascii_uppercase();
            let f = self.byte_freq[lo as usize].saturating_add(self.byte_freq[up as usize]);
            if f == 0 {
                return JarSymbolSearch {
                    hits: Vec::new(),
                    total: 0,
                    truncated: false,
                    elapsed_ms: started.elapsed().as_millis() as u64,
                };
            }
            if anchor.is_none_or(|(bf, _, _, _)| f < bf) {
                anchor = Some((f, k, lo, up));
            }
        }
        let (_, at, lo, up) = anchor.expect("needle 非空，上面必然选得出锚");

        let mut found: Vec<(usize, u8)> = Vec::new();
        let mut truncated = false;
        let mut i = 0usize;
        'scan: while i < blob.len() {
            if started.elapsed().as_millis() > SCAN_BUDGET_MS {
                truncated = true;
                break 'scan;
            }
            let Some(off) = memchr::memchr2(lo, up, &blob[i..]) else {
                break 'scan;
            };
            let pos = i + off;
            i = pos + 1;
            // 锚落在 needle 的第 `at` 字节：完整匹配区是 [pos-at, pos-at+n)
            if pos < at {
                continue;
            }
            let hit = pos - at;
            if hit + n > blob.len() || !blob[hit..hit + n].eq_ignore_ascii_case(&needle) {
                continue;
            }
            // 位置 → 词下标；命中必须完整落在一个词内部，跨词边界的是假阳性
            let Some(id) = self.term_id_at(hit) else {
                continue;
            };
            if hit + n > self.u32_at(self.terms_off_at, id + 1).unwrap_or(0) as usize {
                continue;
            }
            let Some(term) = self.term_at(id) else {
                continue;
            };
            let score = if term.eq_ignore_ascii_case(&needle) {
                0
            } else if term.len() >= n && term[..n].eq_ignore_ascii_case(&needle) {
                1
            } else {
                2
            };
            found.push((id, score));
        }
        // 同一个词可能命中多次：先按词下标归并（保留最好分数），再按展示顺序排
        found.sort_unstable();
        found.dedup_by_key(|(id, _)| *id);
        let total = found.len();
        let mut ranked: Vec<(u8, usize, usize)> = found
            .into_iter()
            .map(|(id, score)| (score, self.term_len(id), id))
            .collect();
        ranked.sort_unstable();
        ranked.truncate(limit);
        let hits = ranked
            .into_iter()
            .filter_map(|(score, _, id)| {
                let (places, places_total) = self.places(id);
                Some(JarSymbolHit {
                    term: String::from_utf8_lossy(self.term_at(id)?).into_owned(),
                    score,
                    places,
                    places_total,
                })
            })
            .collect();
        JarSymbolSearch {
            hits,
            total,
            truncated,
            elapsed_ms: started.elapsed().as_millis() as u64,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jar_with(dir: &Path, name: &str, entries: &[(&str, &[u8])]) -> PathBuf {
        let path = dir.join(name);
        let mut z = zip::ZipWriter::new(File::create(&path).unwrap());
        for (entry, bytes) in entries {
            z.start_file(*entry, zip::write::SimpleFileOptions::default())
                .unwrap();
            z.write_all(bytes).unwrap();
        }
        z.finish().unwrap();
        path
    }

    /// 手搓一个 class：`class_name` 按 internal form 进常量池 #1——真实 class 里
    /// `CONSTANT_Class` 的 name_index 正指向它，所以「搜类名」走的就是这一项。
    /// `utf8s` 是额外的方法名 / 字符串字面量。
    fn class_with(class_name: &str, utf8s: &[&str]) -> Vec<u8> {
        let mut items: Vec<u8> = Vec::new();
        items.push(1);
        items.extend_from_slice(&(class_name.len() as u16).to_be_bytes());
        items.extend_from_slice(class_name.as_bytes());
        for s in utf8s {
            items.push(1);
            items.extend_from_slice(&(s.len() as u16).to_be_bytes());
            items.extend_from_slice(s.as_bytes());
        }
        items.push(7);
        items.extend_from_slice(&1u16.to_be_bytes());
        let mut out = vec![0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 52];
        out.extend_from_slice(&((utf8s.len() + 3) as u16).to_be_bytes());
        out.extend_from_slice(&items);
        out
    }

    #[test]
    fn 建索引_查询_与过期判定() {
        // test_support::tmp 会先删后建并 canonicalize：裸 temp_dir 在 macOS /var 符号链接
        // 与 Windows CI 8.3 短名下拼出的路径和产品代码对不上（rust-tempdir 棘轮也拦这个）。
        let root = crate::test_support::tmp("jar-symbols");
        let a = jar_with(
            &root,
            "a.jar",
            &[
                (
                    "nc/vo/VoucherBillOrder.class",
                    &class_with("nc/vo/VoucherBillOrder", &["getVoucherNo", "数据源ID重复"]),
                ),
                (
                    "nc/vo/Other.class",
                    &class_with("nc/vo/Other", &["pk_corp"]),
                ),
            ],
        );
        let b = jar_with(
            &root,
            "b.jar",
            &[(
                "gl/Thing.class",
                &class_with("gl/Thing", &["查询系统模板失败！"]),
            )],
        );
        let out = root.join("symbols.bin");
        let index = ClassIndex::build(vec![a.clone(), b.clone()]);
        assert!(build(&index, &out, &|_, _| {}, &|| false).is_ok());
        let loaded = JarSymbolIndex::load(&out).expect("索引应可载入");
        // 类名 + 方法名 + 中文字符串：三个 class 共 7 个词
        assert_eq!(loaded.term_count(), 7);
        assert!(!loaded.stale(&index));

        let hit = loaded.search("VoucherBillOrder", 10);
        assert_eq!(hit.total, 1);
        // 常量池里类名是 internal form：搜裸类名走「包含」档，不是精确档
        assert_eq!(hit.hits[0].term, "nc/vo/VoucherBillOrder");
        assert_eq!(hit.hits[0].score, 2);
        assert_eq!(hit.hits[0].places.len(), 1);
        assert_eq!(hit.hits[0].places_total, 1);
        assert!(hit.hits[0].places[0].jar.ends_with("a.jar"));
        assert_eq!(hit.hits[0].places[0].class, "nc.vo.VoucherBillOrder");

        // 中文原文可搜；标识符大小写无关
        for q in [
            "数据源ID重复",
            "voucherbillorder",
            "VOUCHERBILLORDER",
            "voucherno",
            "模板失败",
        ] {
            assert!(loaded.search(q, 10).total >= 1, "{q} 应命中");
        }
        // 打分三档：精确 / 前缀 / 包含。查询词刻意互不交叠，否则排序会把
        // 别的词顶到 hits[0]，断言就失去意义。
        assert_eq!(loaded.search("getVoucherNo", 10).hits[0].score, 0);
        assert_eq!(loaded.search("pk_c", 10).hits[0].score, 1);
        assert_eq!(loaded.search("_corp", 10).hits[0].score, 2);
        assert_eq!(loaded.search("zzz-not-here", 10).total, 0);
        assert_eq!(loaded.search("a", 10).total, 0, "单词不查");

        // jar 被替换 → 过期
        let _ = jar_with(
            &root,
            "a.jar",
            &[(
                "nc/vo/Replaced.class",
                &class_with("nc/vo/Replaced", &["other"]),
            )],
        );
        assert!(loaded.stale(&index));

        // 取消不落文件，且与写盘失败可区分
        let err = build(&index, &root.join("no.bin"), &|_, _| {}, &|| true).unwrap_err();
        assert_eq!(err, "已取消");
        assert!(!root.join("no.bin").exists());
        // 收尾由下一次 tmp("同 tag") 的 remove_dir_all 负责，这里不重复清
    }

    /// 真实命中处数必须单独存：`places` 只留前 `MAX_PLACES` 处，
    /// 界面靠 `places_total` 说「另有 N 处」，否则 8 处以外的全被吞掉。
    #[test]
    fn places_total_记真实命中处数() {
        let root = crate::test_support::tmp("jar-symbols-total");
        // 同一个词放进 12 个类：places 只留 8 个，total 必须是 12
        let entries: Vec<(String, Vec<u8>)> = (0..12)
            .map(|i| {
                (
                    format!("nc/vo/C{i}.class"),
                    class_with(&format!("nc/vo/C{i}"), &["pk_corp"]),
                )
            })
            .collect();
        let refs: Vec<(&str, &[u8])> = entries
            .iter()
            .map(|(n, b)| (n.as_str(), b.as_slice()))
            .collect();
        let jar = jar_with(&root, "many.jar", &refs);
        let out = root.join("s.bin");
        build(&ClassIndex::build(vec![jar]), &out, &|_, _| {}, &|| false).unwrap();
        let loaded = JarSymbolIndex::load(&out).unwrap();
        let hit = loaded.search("pk_corp", 10);
        assert_eq!(hit.total, 1);
        assert_eq!(hit.hits[0].places.len(), MAX_PLACES);
        assert_eq!(hit.hits[0].places_total, 12, "{:?}", hit.hits[0].places);
    }

    /// 指纹必须在扫描前取：建索引期间 jar 被替换，索引必须判过期
    /// （否则「看起来新鲜、内容是旧的」，且再也不会被发现）。
    #[test]
    fn 建索引期间_jar_被替换则判过期() {
        let root = crate::test_support::tmp("jar-symbols-fp");
        let jar = jar_with(
            &root,
            "a.jar",
            &[("x/A.class", &class_with("x/A", &["pk_corp"]))],
        );
        let out = root.join("s.bin");
        let index = ClassIndex::build(vec![jar.clone()]);
        build(&index, &out, &|_, _| {}, &|| false).unwrap();
        let loaded = JarSymbolIndex::load(&out).unwrap();
        assert!(!loaded.stale(&index));
        // 同尺寸替换：size 相同、mtime 必然不同 → 旧代码也判得出来；
        // 真正防的是「扫描后才取指纹」：那时记下的是新文件的指纹，永远新鲜
        let _ = jar_with(
            &root,
            "a.jar",
            &[("x/B.class", &class_with("x/B", &["other"]))],
        );
        assert!(loaded.stale(&index));
        // 改名（路径不同、内容相同）也必须过期：索引里记的 jar 路径已经错了
        let moved = root.join("renamed.jar");
        std::fs::rename(&jar, &moved).unwrap();
        let index2 = ClassIndex::build(vec![moved]);
        assert!(loaded.stale(&index2));
    }

    #[test]
    fn 跨词边界不算命中() {
        let root = crate::test_support::tmp("jar-symbols-b");
        // 两个词相邻拼起来恰好含查询词：必须判为不命中
        let jar = jar_with(
            &root,
            "c.jar",
            &[("x/A.class", &class_with("x/A", &["getVoucher", "NoSuffix"]))],
        );
        let out = root.join("s.bin");
        let index = ClassIndex::build(vec![jar]);
        build(&index, &out, &|_, _| {}, &|| false).unwrap();
        let loaded = JarSymbolIndex::load(&out).unwrap();
        assert_eq!(loaded.search("VoucherNoSuffix", 10).total, 0);
        assert_eq!(loaded.search("Voucher", 10).total, 1);
        // 收尾由下一次 tmp("同 tag") 的 remove_dir_all 负责，这里不重复清
    }

    /// 锚字节在 needle 中间（不是首字节）时的正确性。
    ///
    /// 词表里 `a` 出现 4 次、`b` 只 1 次，所以搜 `aab` 时锚必然是 `b`（偏移 2）——
    /// 这条路径在真实 20MB 词表上才是常态，手搓小词表很容易只覆盖到「锚 = 首字节」。
    #[test]
    fn 锚字节不在_needle_首位时照样命中() {
        let root = crate::test_support::tmp("jar-symbols-anchor");
        let jar = jar_with(
            &root,
            "a.jar",
            &[("x/A.class", &class_with("x/A", &["aaa", "aab", "aba"]))],
        );
        let out = root.join("s.bin");
        build(&ClassIndex::build(vec![jar]), &out, &|_, _| {}, &|| false).unwrap();
        let loaded = JarSymbolIndex::load(&out).unwrap();
        // 锚是 'b'（偏移 2）：匹配区要回退两个字节，回退算错就会漏
        assert_eq!(loaded.search("aab", 10).total, 1);
        assert_eq!(loaded.search("AAb", 10).total, 1, "大小写无关");
        // 锚是 'a'（偏移 0/1 都可能）：验证前缀与包含两档
        assert_eq!(loaded.search("aa", 10).hits[0].score, 1);
        assert_eq!(loaded.search("aaa", 10).hits[0].score, 0);
        // 收尾由下一次 tmp("同 tag") 的 remove_dir_all 负责，这里不重复清
    }

    /// needle 里只要有一个字节在词表里完全没出现，就不可能命中——直接回空。
    /// 这是频率表的免费快速失败：真实词表上「搜一个不存在的词」是高频操作。
    #[test]
    fn 字节不在词表里直接回空() {
        let root = crate::test_support::tmp("jar-symbols-miss");
        let jar = jar_with(
            &root,
            "a.jar",
            &[("x/A.class", &class_with("x/A", &["pk_corp", "pk_org"]))],
        );
        let out = root.join("s.bin");
        build(&ClassIndex::build(vec![jar]), &out, &|_, _| {}, &|| false).unwrap();
        let loaded = JarSymbolIndex::load(&out).unwrap();
        // 'z' / 'x' 都不在词表里
        assert_eq!(loaded.search("pk_zorp", 10).total, 0);
        assert_eq!(loaded.search("xx", 10).total, 0);
        // 在词表里的字节组合照常命中
        assert_eq!(loaded.search("pk_corp", 10).total, 1);
        assert_eq!(loaded.search("_org", 10).total, 1);
        // 收尾由下一次 tmp("同 tag") 的 remove_dir_all 负责，这里不重复清
    }

    #[test]
    fn 畸形文件一律当打不开() {
        let root = crate::test_support::tmp("jar-symbols-c");
        let bad = root.join("bad.bin");
        std::fs::write(&bad, b"not an index at all").unwrap();
        assert!(JarSymbolIndex::load(&bad).is_none());
        assert!(JarSymbolIndex::load(&root.join("missing.bin")).is_none());
        // 头里声称的长度与文件实际长度不符
        let jar = jar_with(
            &root,
            "d.jar",
            &[("x/A.class", &class_with("x/A", &["pk_corp"]))],
        );
        let out = root.join("s.bin");
        build(&ClassIndex::build(vec![jar]), &out, &|_, _| {}, &|| false).unwrap();
        let mut bytes = std::fs::read(&out).unwrap();
        bytes.pop();
        std::fs::write(&bad, &bytes).unwrap();
        assert!(JarSymbolIndex::load(&bad).is_none());
        // 收尾由下一次 tmp("同 tag") 的 remove_dir_all 负责，这里不重复清
    }
}
