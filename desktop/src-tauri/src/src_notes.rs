//! jar 内**源码注释**的索引：让 NC 随包发布的 `_src.jar` 里的中文注释可被搜索。
//!
//! 为什么单独一份索引而不是并进 `jar_symbols`：那边是「词 → class」的倒排，为符号名
//! 设计（整词命中、每词至多 8 处）；注释是长文本，要的是**子串命中 + 看到原文**，
//! 明文块 + 扫描才对得上。两者互补：符号索引覆盖 class 常量池（编译产物），
//! 这份覆盖源码注释（编译时被 javac 剥离的那部分）。
//!
//! 索引是单文件，`load` 后常驻内存；三态契约与 `jar_symbols` 一致：
//! 就绪 → 直接搜；没建好 → `building`；jar 变了 → 先用旧的出结果 + 后台重建。

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Instant, UNIX_EPOCH};

use memchr::memchr2;

use crate::java_comments::{self, Note};

const MAGIC: &[u8; 4] = b"NSRC";
const VERSION: u32 = 1;
const HEADER: usize = 64;

/// 扫描预算：超过就停，结果可能不全（与 `jar_symbols` 同一条纪律）。
const SCAN_BUDGET_MS: u128 = 500;

fn poke_u32(d: &mut [u8], at: usize, x: u32) {
    d[at..at + 4].copy_from_slice(&x.to_le_bytes());
}
fn put_u32(d: &mut Vec<u8>, x: u32) {
    d.extend_from_slice(&x.to_le_bytes());
}
fn put_u16(d: &mut Vec<u8>, x: u16) {
    d.extend_from_slice(&x.to_le_bytes());
}
fn rd_u16(d: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes([*d.get(at)?, *d.get(at + 1)?]))
}
fn rd_u32(d: &[u8], at: usize) -> Option<u32> {
    let mut b = [0u8; 4];
    b.copy_from_slice(d.get(at..at + 4)?);
    Some(u32::from_le_bytes(b))
}
fn rd_u64(d: &[u8], at: usize) -> Option<u64> {
    let mut b = [0u8; 8];
    b.copy_from_slice(d.get(at..at + 8)?);
    Some(u64::from_le_bytes(b))
}

fn fingerprint(path: &Path) -> Option<(u64, u64)> {
    let m = std::fs::metadata(path).ok()?;
    let nanos = m
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos() as u64);
    Some((m.len(), nanos))
}

/// 源码包目录 → 索引缓存目录。不同 NC home 的包清单不同，混用会互相覆盖。
pub fn cache_dir_for(config_dir: &Path, nc_home: &str) -> PathBuf {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in nc_home.to_lowercase().as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100_0000_01b3);
    }
    config_dir.join("src-notes").join(format!("{h:016x}"))
}

/// 一条命中。
#[derive(Debug, Clone)]
pub struct NoteHit {
    /// 源码包的绝对路径（`_src.jar`）。
    pub jar: String,
    /// 包内路径，如 `nc/pub/ba/update/BAPUpdateDB.java`。
    pub path: String,
    pub line: usize,
    pub text: String,
}

/// 建索引的中间态：喂进来的每个源码文件的注释都堆在这里。
///
/// 抽出来不是为了抽象，是为了**可测**——测试直接喂 `(路径, 字节)`，
/// 不必为了几条断言去造真的 zip。
pub struct Sink {
    notes_blob: Vec<u8>,
    notes_off: Vec<u32>,
    entry_jar: Vec<u16>,
    entry_line: Vec<u32>,
    entry_path: Vec<(u32, u32)>,
    paths_blob: Vec<u8>,
}

impl Default for Sink {
    fn default() -> Self {
        Self::new()
    }
}

impl Sink {
    pub fn new() -> Self {
        Self {
            notes_blob: Vec::new(),
            notes_off: vec![0],
            entry_jar: Vec::new(),
            entry_line: Vec::new(),
            entry_path: Vec::new(),
            paths_blob: Vec::new(),
        }
    }

    /// 喂一个源码文件。`name` 是 jar 内路径，`bytes` 是原始字节（GBK/UTF-8 均可）。
    pub fn feed(&mut self, jar_id: u16, name: &str, bytes: &[u8]) {
        if bytes.len() as u64 > java_comments::MAX_JAVA_BYTES {
            return;
        }
        let text = crate::workspace::decode_lossy(bytes);
        let (off, len) = (self.paths_blob.len() as u32, name.len() as u32);
        self.paths_blob.extend_from_slice(name.as_bytes());
        for Note { text, line } in java_comments::extract_notes(&text) {
            self.notes_blob.extend_from_slice(text.as_bytes());
            self.notes_off.push(self.notes_blob.len() as u32);
            self.entry_jar.push(jar_id);
            self.entry_line.push(line as u32);
            self.entry_path.push((off, len));
        }
    }

    pub fn notes(&self) -> usize {
        self.notes_off.len() - 1
    }

    /// 组装成待落盘的字节。`jars` 提供路径段与指纹段，须与 `feed` 用的 id 对应。
    pub fn finish(&self, jars: &[PathBuf]) -> Option<Vec<u8>> {
        let n = self.notes();
        let j = jars.len();
        let mut data: Vec<u8> = Vec::with_capacity(self.notes_blob.len() + n * 20);
        data.extend_from_slice(&[0u8; HEADER]);
        let notes_off_at = data.len() as u32;
        for x in &self.notes_off {
            put_u32(&mut data, *x);
        }
        let entry_jar_at = data.len() as u32;
        for x in &self.entry_jar {
            put_u16(&mut data, *x);
        }
        let entry_line_at = data.len() as u32;
        for x in &self.entry_line {
            put_u32(&mut data, *x);
        }
        let entry_path_at = data.len() as u32;
        for (off, len) in &self.entry_path {
            put_u32(&mut data, *off);
            put_u32(&mut data, *len);
        }
        let paths_blob_at = data.len() as u32;
        data.extend_from_slice(&self.paths_blob);
        let jar_paths_at = data.len() as u32;
        for jar in jars {
            let raw = jar.to_string_lossy();
            put_u16(&mut data, raw.len() as u16);
            data.extend_from_slice(raw.as_bytes());
        }
        let jar_fp_at = data.len() as u32;
        for jar in jars {
            let (len, nanos) = fingerprint(jar).unwrap_or((0, 0));
            data.extend_from_slice(&len.to_le_bytes());
            data.extend_from_slice(&nanos.to_le_bytes());
        }
        let notes_blob_at = data.len() as u32;
        data.extend_from_slice(&self.notes_blob);

        let total = data.len() as u32;
        let head = &mut data[..HEADER];
        head[..4].copy_from_slice(MAGIC);
        poke_u32(head, 4, VERSION);
        poke_u32(head, 8, n as u32);
        poke_u32(head, 12, j as u32);
        poke_u32(head, 16, notes_off_at);
        poke_u32(head, 20, entry_jar_at);
        poke_u32(head, 24, entry_line_at);
        poke_u32(head, 28, entry_path_at);
        poke_u32(head, 32, paths_blob_at);
        poke_u32(head, 36, jar_paths_at);
        poke_u32(head, 40, jar_fp_at);
        poke_u32(head, 44, notes_blob_at);
        poke_u32(head, 48, total);
        Some(data)
    }
}

/// 建索引并写盘。jar 读失败 / class 畸形都只跳过，不中断。
///
/// `Err` 分两种：`"已取消"`（此时不写文件，不留半份）与写盘失败（磁盘满 /
/// 杀软占用）。以前两者都返回 `None`，写盘失败被当成「用户取消了」，于是无日志、
/// 无错误态，界面永远演「正在后台建立」。
pub fn build(
    jars: &[PathBuf],
    out: &Path,
    progress: &dyn Fn(usize, usize),
    cancelled: &dyn Fn() -> bool,
) -> Result<(), String> {
    let mut sink = Sink::new();
    let mut buf: Vec<u8> = Vec::new();
    for (id, jar) in jars.iter().enumerate() {
        if cancelled() {
            return Err("已取消".to_string());
        }
        let Ok(file) = File::open(jar) else { continue };
        let Ok(mut archive) = zip::ZipArchive::new(file) else {
            continue;
        };
        for i in 0..archive.len() {
            if cancelled() {
                return Err("已取消".to_string());
            }
            let Ok(entry) = archive.by_index(i) else {
                continue;
            };
            let name = entry.name().to_string();
            if !name.ends_with(".java") || name.starts_with("META-INF/") {
                continue;
            }
            buf.clear();
            // 🔴 读也要设上限：条目的「未压缩大小」是 zip 里写明的，一个坏包
            // 声称 4GB 就能在读之前把内存打满。多读 1 字节，`Sink::feed` 的
            // `> MAX_JAVA_BYTES` 检查才能照旧把超大文件跳过（而不是收下半份）。
            if entry
                .take(java_comments::MAX_JAVA_BYTES + 1)
                .read_to_end(&mut buf)
                .is_err()
            {
                continue;
            }
            sink.feed(id as u16, &name, &buf);
        }
        if id % 100 == 0 || id + 1 == jars.len() {
            progress(id + 1, jars.len());
        }
    }
    let data = match sink.finish(jars) {
        Some(d) => d,
        None => return Err("组装索引失败".to_string()),
    };
    if let Some(parent) = out.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let temp = out.with_extension("tmp");
    let write = || -> std::io::Result<()> {
        let mut f = File::create(&temp)?;
        std::io::Write::write_all(&mut f, &data)?;
        drop(f);
        std::fs::rename(&temp, out)?;
        Ok(())
    };
    if let Err(e) = write() {
        log::error!("源码注释索引写盘失败（{}）：{e}；索引未更新", out.display());
        return Err(format!("写索引文件失败：{e}"));
    }
    log::info!(
        "源码注释索引：{} 条注释 / {} 个源码包，{} MB",
        sink.notes(),
        jars.len(),
        data.len() / (1024 * 1024)
    );
    Ok(())
}

/// 载入后的索引。字段是各段偏移，查询时零拷贝切片。
pub struct SrcNoteIndex {
    data: Vec<u8>,
    notes_off_at: usize,
    entry_jar_at: usize,
    entry_line_at: usize,
    entry_path_at: usize,
    paths_blob_at: usize,
    jar_paths_at: usize,
    jar_fp_at: usize,
    notes_blob_at: usize,
    notes: usize,
    jars: usize,
    /// 注释 blob 里 256 个字节值的出现次数（`load` 时现算，不进文件）。
    ///
    /// 与 `jar_symbols` 同理：子串搜索必须扫，拿哪个字节当锚代价差两个数量级。
    /// 注释 blob 里中文占多数，频率分布比英文词表均匀，但 `a`/`e` 这类仍偏高。
    byte_freq: [u32; 256],
}

impl SrcNoteIndex {
    /// 从磁盘载入。格式不符 / 段越界一律 `None`（调用方重建）。
    pub fn load(path: &Path) -> Option<Self> {
        let data = std::fs::read(path).ok()?;
        if data.len() < HEADER || &data[..4] != MAGIC {
            return None;
        }
        // 版本不符一律当没有：格式演进后旧文件按新布局解会读出垃圾偏移
        if rd_u32(&data, 4)? != VERSION {
            return None;
        }
        let g = |at: usize| rd_u32(&data, at);
        let (n, j) = (g(8)? as usize, g(12)? as usize);
        let notes_off_at = g(16)? as usize;
        let entry_jar_at = g(20)? as usize;
        let entry_line_at = g(24)? as usize;
        let entry_path_at = g(28)? as usize;
        let paths_blob_at = g(32)? as usize;
        let jar_paths_at = g(36)? as usize;
        let jar_fp_at = g(40)? as usize;
        let notes_blob_at = g(44)? as usize;
        let total = g(48)? as usize;
        if total != data.len() {
            return None;
        }
        // 每段都必须落在文件内：u16/u32 段还要能按条数取完
        let ok = notes_off_at + (n + 1) * 4 <= entry_jar_at
            && entry_jar_at + n * 2 <= entry_line_at
            && entry_line_at + n * 4 <= entry_path_at
            && entry_path_at + n * 8 <= paths_blob_at
            && paths_blob_at <= jar_paths_at
            && jar_paths_at <= jar_fp_at
            && jar_fp_at + j * 16 <= notes_blob_at
            && notes_blob_at <= total;
        if !ok {
            return None;
        }
        let mut byte_freq = [0u32; 256];
        for &b in &data[notes_blob_at..] {
            byte_freq[b as usize] = byte_freq[b as usize].saturating_add(1);
        }
        Some(Self {
            data,
            notes_off_at,
            entry_jar_at,
            entry_line_at,
            entry_path_at,
            paths_blob_at,
            jar_paths_at,
            jar_fp_at,
            notes_blob_at,
            notes: n,
            jars: j,
            byte_freq,
        })
    }

    fn notes_blob(&self) -> &[u8] {
        &self.data[self.notes_blob_at..]
    }
    fn note_span(&self, i: usize) -> Option<(usize, usize)> {
        let a = rd_u32(&self.data, self.notes_off_at + i * 4)? as usize;
        // 末条没有后继偏移可读，结束位置就是 blob 尾部。
        // 🔴 别拿 `notes_blob_at`（data 里的段偏移）当 blob 长度——那会读到段头
        // 前 4 个字节当成偏移，末条注释的正文整个错位。
        let b = if i + 1 == self.notes {
            self.data.len() - self.notes_blob_at
        } else {
            rd_u32(&self.data, self.notes_off_at + (i + 1) * 4)? as usize
        };
        Some((a, b - a))
    }
    fn jar_of(&self, id: usize) -> String {
        let mut at = self.jar_paths_at;
        for _ in 0..id {
            let Some(len) = rd_u16(&self.data, at).map(usize::from) else {
                return String::new();
            };
            at += 2 + len;
        }
        let len = rd_u16(&self.data, at).map(usize::from).unwrap_or(0);
        // 🔴 裸切片会 panic：`at + 2 + len` 越界时（坏索引 / 被改小的文件）
        // 后台建索引的线程一死，「在飞」标志永远不复位，功能卡死在「建索引」
        let s = match self.data.get(at + 2..at + 2 + len) {
            Some(s) => s,
            None => return String::new(),
        };
        String::from_utf8_lossy(s).into_owned()
    }
    fn entry_path(&self, i: usize) -> String {
        let at = self.entry_path_at + i * 8;
        let (Some(off), Some(len)) = (rd_u32(&self.data, at), rd_u32(&self.data, at + 4)) else {
            return String::new();
        };
        let (off, len) = (off as usize, len as usize);
        let s = self
            .data
            .get(self.paths_blob_at + off..self.paths_blob_at + off + len);
        s.map(|b| String::from_utf8_lossy(b).into_owned())
            .unwrap_or_default()
    }

    /// 索引是否过期：任一源码包的**路径** / size / mtime 与建时不一致。
    ///
    /// 路径也要比：只比 size+mtime 的话，源码包改名（内容、大小、时间全不变）
    /// 会被判成新鲜，而索引里记的路径已经指向不存在的文件 —— 命中行点开报
    /// 「没找到源码包」，若改名后排序位置也变了，`jar_of` 还会取到另一个包的
    /// 路径，点开的是错文件。`jar_symbols::stale` 是同款口径。
    pub fn stale(&self, jars: &[PathBuf]) -> bool {
        if jars.len() != self.jars {
            return true;
        }
        // jar_paths 是顺序段：一遍走完同时比路径与指纹，避免 O(j²)。
        let mut at = self.jar_paths_at;
        for (id, jar) in jars.iter().enumerate() {
            let Some(plen) = rd_u16(&self.data, at).map(usize::from) else {
                return true;
            };
            at += 2;
            let Some(raw) = self.data.get(at..at + plen) else {
                return true;
            };
            at += plen;
            if raw != jar.to_string_lossy().as_bytes() {
                return true;
            }
            let base = self.jar_fp_at + id * 16;
            let (Some(len), Some(nanos)) = (rd_u64(&self.data, base), rd_u64(&self.data, base + 8))
            else {
                return true;
            };
            match fingerprint(jar) {
                Some(cur) if cur == (len, nanos) => {}
                _ => return true,
            }
        }
        false
    }

    pub fn notes(&self) -> usize {
        self.notes
    }

    /// 子串搜索（ASCII 大小写不敏感；中文按字节等同比较）。
    ///
    /// 返回 `(命中, 命中条数, 是否被截断)`：
    /// - `total` 是**去重后的命中条数**，可能大于 `hits.len()`（后者受 `limit` 截断）——
    ///   界面要靠它说「命中几条」，不能拿索引里注释总数冒充（那会让只有 1 条命中
    ///   也显示成「显示前 1」）；
    /// - `truncated` 为真表示「还有更多没列出来」：`limit` 截断或扫描超预算，二者都算。
    pub fn search(&self, needle: &str, limit: usize) -> (Vec<NoteHit>, usize, bool) {
        let started = Instant::now();
        let mut out = Vec::new();
        if needle.is_empty() || self.notes == 0 {
            return (out, 0, false);
        }
        let n = needle.len();
        let blob = self.notes_blob();
        // 锚字节：needle 里频率最低的那个（连大小写形态一起算）
        let mut anchor: Option<(u32, usize, u8, u8)> = None;
        for (k, &b) in needle.as_bytes().iter().enumerate() {
            let lo = b.to_ascii_lowercase();
            let up = b.to_ascii_uppercase();
            let f = self.byte_freq[lo as usize].saturating_add(self.byte_freq[up as usize]);
            if f == 0 {
                return (out, 0, false); // 这个词表里根本没有，免费回空
            }
            if anchor.is_none_or(|(bf, _, _, _)| f < bf) {
                anchor = Some((f, k, lo, up));
            }
        }
        let (_, at, lo, up) = anchor.expect("needle 非空，上面必然选得出锚");

        let mut i = 0usize;
        let mut total = 0usize;
        // 上一条命中的注释下标：同一条注释里关键词出现多次，字节层会命中多次，
        // 必须归并——否则同一条命中占满 limit、界面出现一模一样的重复行
        // （`jar_symbols::search` 同位置有 `dedup_by_key`，这边漏了）。
        let mut last_note: Option<usize> = None;
        'scan: while i < blob.len() {
            // 🔴 预算必须在**每轮**开头查：只在中命中后查的话，锚字节高频而
            // 完整匹配稀有时（「差一点匹配」的循环），一次搜索能跑过预算几十倍
            if started.elapsed().as_millis() > SCAN_BUDGET_MS {
                return (out, total, true);
            }
            let Some(off) = memchr2(lo, up, &blob[i..]) else {
                break 'scan;
            };
            let pos = i + off;
            i = pos + 1;
            if pos < at {
                continue;
            }
            let hit = pos - at;
            if hit + n > blob.len() || !blob[hit..hit + n].eq_ignore_ascii_case(needle.as_bytes()) {
                continue;
            }
            // 命中偏移 → 条目下标（notes_off 单调，二分）
            let mut lo_i = 0usize;
            let mut hi_i = self.notes;
            while lo_i + 1 < hi_i {
                let mid = lo_i + (hi_i - lo_i).div_ceil(2);
                if (self.note_span(mid).map_or(0, |(a, _)| a)) <= hit {
                    lo_i = mid;
                } else {
                    hi_i = mid;
                }
            }
            let Some((a, len)) = self.note_span(lo_i) else {
                continue;
            };
            let Some(text) = blob.get(a..a + len) else {
                continue;
            };
            // 这条注释剩下的部分不可能再产出**新**命中，直接跳到它的结尾
            i = i.max(a + len);
            if last_note == Some(lo_i) {
                continue;
            }
            last_note = Some(lo_i);
            total += 1;
            // 🔴 收够 limit 也要继续数：`total` 必须是真实命中条数，界面靠它说
            // 「命中 N 条 · 显示前 M」。提前返回会让 N 永远等于 M。
            if out.len() < limit {
                out.push(NoteHit {
                    jar: self.jar_of(
                        rd_u16(&self.data, self.entry_jar_at + lo_i * 2).unwrap_or(0) as usize,
                    ),
                    path: self.entry_path(lo_i),
                    line: rd_u32(&self.data, self.entry_line_at + lo_i * 4).unwrap_or(1) as usize,
                    text: String::from_utf8_lossy(text).into_owned(),
                });
            }
            if started.elapsed().as_millis() > SCAN_BUDGET_MS {
                return (out, total, true);
            }
        }
        // 还有更多没列出来（受 limit 截断）也要报，否则用户以为结果就是全部
        let truncated = total > out.len();
        (out, total, truncated)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 造一份索引落盘，返回（索引路径, jar 路径）。
    fn indexed(tag: &str, files: &[(&str, &str)]) -> (PathBuf, PathBuf) {
        let root = crate::test_support::tmp(tag);
        let jar = root.join("pubaeam-1_src.jar");
        std::fs::write(&jar, b"not a real zip").unwrap();
        let mut sink = Sink::new();
        for (name, src) in files {
            sink.feed(0, name, src.as_bytes());
        }
        let out = root.join("notes.bin");
        let data = sink.finish(std::slice::from_ref(&jar)).expect("组装应成功");
        std::fs::write(&out, &data).unwrap();
        (out, jar)
    }

    #[test]
    fn 建_载入_查询_往返() {
        let (out, jar) = indexed(
            "src-notes-basic",
            &[(
                "nc/pub/ba/update/BAPUpdateDB.java",
                "/**\n * 61升级63，部分功能节点编码从8001变为8004\n */\nclass BAPUpdateDB {}\n",
            )],
        );
        let idx = SrcNoteIndex::load(&out).expect("建完应能载入");
        assert_eq!(idx.notes(), 1);
        let (hits, total, trunc) = idx.search("升级63", 10);
        assert!(!trunc);
        assert_eq!(hits.len(), 1, "{hits:?}");
        assert_eq!(total, 1, "命中条数要与列表一致");
        assert_eq!(hits[0].text, "61升级63，部分功能节点编码从8001变为8004");
        assert_eq!(hits[0].path, "nc/pub/ba/update/BAPUpdateDB.java");
        // 注释起始行：`/**` 在第 1 行（跳到注释开头，不是跳到 `*` 续行）
        assert_eq!(hits[0].line, 1);
        assert!(hits[0].jar.ends_with("pubaeam-1_src.jar"));
        assert!(!idx.stale(std::slice::from_ref(&jar)));
        let _ = std::fs::remove_dir_all(out.parent().unwrap());
    }

    #[test]
    fn gbk_源码里的中文注释能搜到() {
        // NC 的 `_src.jar` 里 GBK/UTF-8 混放，注释必须按同一套解码走
        let src = "// 凭证\npublic class Pz {}\n";
        let (bytes, _, _) = encoding_rs::GBK.encode(src);
        let root = crate::test_support::tmp("src-notes-gbk");
        let jar = root.join("a_src.jar");
        std::fs::write(&jar, b"x").unwrap();
        let mut sink = Sink::new();
        sink.feed(0, "Pz.java", bytes.as_ref());
        let out = root.join("n.bin");
        std::fs::write(&out, sink.finish(std::slice::from_ref(&jar)).unwrap()).unwrap();
        let idx = SrcNoteIndex::load(&out).expect("载入");
        let (hits, _, _) = idx.search("凭证", 10);
        assert_eq!(hits.len(), 1, "GBK 源码里的中文注释搜不到");
        assert_eq!(hits[0].text, "凭证");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn 大小写不敏感且无命中回空() {
        let (out, _jar) = indexed(
            "src-notes-case",
            &[("A.java", "// GetBillCardPanel here\nclass A {}\n")],
        );
        let idx = SrcNoteIndex::load(&out).unwrap();
        assert_eq!(idx.search("getbillcardpanel", 10).0.len(), 1);
        assert_eq!(idx.search("GETBILLCARDPANEL", 10).0.len(), 1);
        assert!(idx.search("zzzznotexist", 10).0.is_empty());
        let _ = std::fs::remove_dir_all(out.parent().unwrap());
    }

    #[test]
    fn 同一条注释命中多次只算一条() {
        // 🔴 回归：字节层会对注释里每一次出现都命中，不归并就会返回多条
        // 一模一样的命中、把 limit 占满，前端还会撞 React key。
        let (out, _jar) = indexed(
            "src-notes-dup",
            &[(
                "A.java",
                "// 凭证校验：凭证号不能为空\n// 凭证同步\nclass A {}\n",
            )],
        );
        let idx = SrcNoteIndex::load(&out).unwrap();
        let (hits, total, trunc) = idx.search("凭证", 10);
        assert_eq!(hits.len(), 2, "{hits:?}");
        assert_eq!(total, 2);
        assert!(!trunc);
        assert_eq!(hits[0].text, "凭证校验：凭证号不能为空");
        assert_eq!(hits[1].text, "凭证同步");
        let _ = std::fs::remove_dir_all(out.parent().unwrap());
    }

    #[test]
    fn limit_截断要报出来_并且总数是命中数() {
        // 界面靠 total 说「命中几条」、靠 truncated 说「还有更多」：
        // 以前 limit 截断时返回 truncated=false，用户以为结果就是全部。
        let (out, _jar) = indexed(
            "src-notes-limit",
            &[("A.java", "// 凭证一\n// 凭证二\n// 凭证三\nclass A {}\n")],
        );
        let idx = SrcNoteIndex::load(&out).unwrap();
        let (hits, total, trunc) = idx.search("凭证", 2);
        assert_eq!(hits.len(), 2);
        assert_eq!(total, 3, "total 是去重后的命中条数，不是索引注释总数");
        assert!(trunc, "还有 1 条没列出来，必须报截断");
        let _ = std::fs::remove_dir_all(out.parent().unwrap());
    }

    #[test]
    fn jar_变动后过期() {
        let (out, jar) = indexed("src-notes-stale", &[("A.java", "// 说明\nclass A {}")]);
        let idx = SrcNoteIndex::load(&out).unwrap();
        assert!(!idx.stale(std::slice::from_ref(&jar)));
        std::fs::write(&jar, b"grown").unwrap();
        assert!(idx.stale(std::slice::from_ref(&jar)), "jar 变了必须过期");
        // 数量变了也算变（现场装了新模块）
        assert!(idx.stale(&[]));
        let _ = std::fs::remove_dir_all(out.parent().unwrap());
    }

    #[test]
    fn 畸形文件一律_none() {
        let root = crate::test_support::tmp("src-notes-bad");
        let short = root.join("short.bin");
        std::fs::write(&short, b"NSRC").unwrap();
        assert!(SrcNoteIndex::load(&short).is_none(), "太短");
        let mut d = vec![0u8; HEADER + 64];
        d[..4].copy_from_slice(MAGIC);
        // total_len 与实际不符
        poke_u32(&mut d, 48, 9999);
        let mismatch = root.join("mismatch.bin");
        std::fs::write(&mismatch, &d).unwrap();
        assert!(SrcNoteIndex::load(&mismatch).is_none(), "长度不符");
        let _ = std::fs::remove_dir_all(&root);
    }
}
