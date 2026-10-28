//! NC home 的 classpath 顺序与「类名 → jar」索引。
//!
//! 为什么要这个：NC home 有 7000+ 个 jar，全放进 ecj 的 classpath 会让编译卡住数分钟（M0 实测），
//! 所以要按源码的 import 反查「这个类在哪个 jar」，只把用得到的 jar 放进 classpath。
//!
//! classpath 顺序规则（从 Eclipse 的实际 classpath 里归纳；M0 验证过顺序会影响字节一致性，
//! 同名类先出现的优先）：
//! 1. `lib`、`framework`、`external/lib`、`middleware`（各自递归，按完整路径字符串排序）
//! 2. `modules/<模块名>/...`：模块名排序；每个模块内依次是
//!    `client/hyext/lib`、`client/lib`、`hyext/lib`、`lib`、`META-INF/hyext/lib`、`META-INF/lib`
//!
//! 纯逻辑模块，不含 tauri 类型（原因见 workspace.rs 头注释）。

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::fs::File;
use std::hash::{Hash, Hasher};
use std::io::BufReader;
use std::path::{Path, PathBuf};

/// 并行扫一个 jar 的结果：jar 在入参里的下标 + 「类名哈希 → jar 内偏移」列表
/// （`None` = 这个 jar 读不了，跳过它而不是让整个索引失败）。
/// 抽成别名是因为它同时出现在 `Vec` 和 `Mutex` 里，内联写三层泛型没人看得动。
type JarScan = (usize, Option<Vec<(u64, u64)>>);

/// 模块目录下按顺序扫描的 jar 子目录。
const MODULE_JAR_DIRS: [&str; 6] = [
    "client/hyext/lib",
    "client/lib",
    "hyext/lib",
    "lib",
    "META-INF/hyext/lib",
    "META-INF/lib",
];

/// 排序键：转大写的完整路径。Eclipse 的顺序来自 Windows 目录列举，NTFS 比较文件名时先转大写：
/// - 按字节序会把 `Dm7JdbcDriver17.jar` 排到 `bsh-2.0b6.jar` 前面（大写在前），与 Eclipse 不一致；
/// - 转小写会把 `uibc_x.jar` 排到 `uibcbd_x.jar` 前面（`_`=0x5F 小于 `b`=0x62），也不对；
///   转大写后 `B`=0x42 小于 `_`=0x5F，才和 Eclipse 一致。
fn sort_key(p: &Path) -> String {
    p.to_string_lossy().to_uppercase()
}

/// 按完整路径递归收集目录下的 jar，路径不区分大小写排序（与 Eclipse 的顺序一致）。
fn collect_jars(dir: &Path, out: &mut Vec<PathBuf>) {
    let mut found = Vec::new();
    walk(dir, &mut found);
    found.sort_by_key(|p| sort_key(p));
    out.extend(found);
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk(&p, out);
        } else if p.extension().is_some_and(|x| x.eq_ignore_ascii_case("jar")) {
            out.push(p);
        }
    }
}

/// NC home 的全部 jar，按 Eclipse 的 classpath 顺序排列。
pub fn classpath_jars(nc_home: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for d in ["lib", "framework", "external/lib", "middleware"] {
        collect_jars(&nc_home.join(d), &mut out);
    }
    let modules = nc_home.join("modules");
    let mut names: Vec<String> = std::fs::read_dir(&modules)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.path().is_dir())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    names.sort_by_key(|n| n.to_uppercase());
    for m in names {
        for sub in MODULE_JAR_DIRS {
            // 只取该目录本层的 jar，不递归（子目录会被下一个 sub 或别的模块覆盖）
            let dir = modules.join(&m).join(sub);
            let Ok(rd) = std::fs::read_dir(&dir) else {
                continue;
            };
            let mut jars: Vec<PathBuf> = rd
                .flatten()
                .map(|e| e.path())
                .filter(|p| {
                    p.is_file() && p.extension().is_some_and(|x| x.eq_ignore_ascii_case("jar"))
                })
                .collect();
            jars.sort_by_key(|p| sort_key(p));
            out.extend(jars);
        }
    }
    out
}

/// NC home 各模块已编译好的 `classes` 目录（`modules/<m>/classes`），排在 jar 之前。
pub fn module_class_dirs(nc_home: &Path) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(nc_home.join("modules")) else {
        return Vec::new();
    };
    let mut dirs: Vec<PathBuf> = rd
        .flatten()
        .map(|e| e.path().join("classes"))
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort_by_key(|p| sort_key(p));
    dirs
}

fn h(s: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    s.hash(&mut hasher);
    hasher.finish()
}

/// 「类名 → jar」索引。
///
/// 只存 64 位哈希而不是类名字符串：58 万个类名约占 60MB，哈希只要约 10MB，
/// 而这里只做「按名字查」，不需要把名字还原出来。
pub struct ClassIndex {
    pub jars: Vec<PathBuf>,
    by_class: HashMap<u64, u32>,
    by_pkg: HashMap<u64, Vec<u32>>,
    /// 打不开（损坏/不是 zip）的 jar，供界面提示。
    pub unreadable: Vec<PathBuf>,
}

/// 读一个 jar 的中央目录，返回 (类名哈希, 包名哈希) 列表。内部类（带 `$`）也收录。
fn scan_jar(path: &Path) -> Option<Vec<(u64, u64)>> {
    let file = File::open(path).ok()?;
    let mut zip = zip::ZipArchive::new(BufReader::new(file)).ok()?;
    let mut out = Vec::new();
    for i in 0..zip.len() {
        let Ok(entry) = zip.by_index_raw(i) else {
            continue;
        };
        let name = entry.name();
        let Some(stem) = name.strip_suffix(".class") else {
            continue;
        };
        // 多版本 jar 的 META-INF/versions 与 module-info 不是普通类
        if stem.starts_with("META-INF/") || stem.ends_with("module-info") {
            continue;
        }
        let fq = stem.replace('/', ".");
        let pkg = fq.rsplit_once('.').map(|(p, _)| p).unwrap_or("");
        out.push((h(&fq), h(pkg)));
    }
    Some(out)
}

/// 磁盘缓存里一个 jar 的记录：大小与修改时间用来判断它有没有变；entries 为 None 表示上次打不开。
struct CachedJar {
    len: u64,
    mtime_ms: u64,
    entries: Option<Vec<(u64, u64)>>,
}

const CACHE_MAGIC: &[u8; 5] = b"NCIX1";
/// 缓存里「打不开」的标记值（entries 条数字段）。
const UNREADABLE: u32 = u32::MAX;

fn stat_jar(p: &Path) -> (u64, u64) {
    let Ok(md) = std::fs::metadata(p) else {
        return (0, 0);
    };
    let ms = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    (md.len(), ms)
}

fn read_cache(path: &Path) -> Option<HashMap<PathBuf, CachedJar>> {
    use std::io::Read;
    let mut buf = Vec::new();
    File::open(path).ok()?.read_to_end(&mut buf).ok()?;
    if buf.get(..5)? != CACHE_MAGIC {
        return None;
    }
    let mut pos = 5usize;
    let take = |pos: &mut usize, n: usize| -> Option<&[u8]> {
        let s = buf.get(*pos..*pos + n)?;
        *pos += n;
        Some(s)
    };
    let u32_at = |s: &[u8]| u32::from_le_bytes(s.try_into().unwrap());
    let u64_at = |s: &[u8]| u64::from_le_bytes(s.try_into().unwrap());
    let count = u32_at(take(&mut pos, 4)?);
    let mut map = HashMap::with_capacity(count as usize);
    for _ in 0..count {
        let plen = u32_at(take(&mut pos, 4)?) as usize;
        let jar = PathBuf::from(std::str::from_utf8(take(&mut pos, plen)?).ok()?);
        let len = u64_at(take(&mut pos, 8)?);
        let mtime_ms = u64_at(take(&mut pos, 8)?);
        let n = u32_at(take(&mut pos, 4)?);
        let entries = if n == UNREADABLE {
            None
        } else {
            let raw = take(&mut pos, n as usize * 16)?;
            Some(
                raw.as_chunks::<16>()
                    .0
                    .iter()
                    .map(|c| (u64_at(&c[..8]), u64_at(&c[8..])))
                    .collect(),
            )
        };
        map.insert(
            jar,
            CachedJar {
                len,
                mtime_ms,
                entries,
            },
        );
    }
    Some(map)
}

fn write_cache(
    path: &Path,
    jars: &[PathBuf],
    stats: &[(u64, u64)],
    entries: &[Option<Vec<(u64, u64)>>],
) -> std::io::Result<()> {
    use std::io::Write;
    let mut out = Vec::with_capacity(8 << 20);
    out.extend_from_slice(CACHE_MAGIC);
    out.extend_from_slice(&(jars.len() as u32).to_le_bytes());
    for ((jar, (len, mtime)), e) in jars.iter().zip(stats).zip(entries) {
        let p = jar.to_string_lossy();
        out.extend_from_slice(&(p.len() as u32).to_le_bytes());
        out.extend_from_slice(p.as_bytes());
        out.extend_from_slice(&len.to_le_bytes());
        out.extend_from_slice(&mtime.to_le_bytes());
        match e {
            None => out.extend_from_slice(&UNREADABLE.to_le_bytes()),
            Some(v) => {
                out.extend_from_slice(&(v.len() as u32).to_le_bytes());
                for (c, p) in v {
                    out.extend_from_slice(&c.to_le_bytes());
                    out.extend_from_slice(&p.to_le_bytes());
                }
            }
        }
    }
    // 先写临时文件再 rename，避免半截缓存被下次启动读到
    let tmp = path.with_extension("tmp");
    File::create(&tmp)?.write_all(&out)?;
    std::fs::rename(&tmp, path)
}

impl ClassIndex {
    /// 不带缓存的全量构建（测试用）。
    pub fn build(jars: Vec<PathBuf>) -> ClassIndex {
        Self::load_or_build(jars, None, None)
    }

    /// 建索引：缓存里大小和修改时间都没变的 jar 直接复用，只扫新增/变化的（首次全量扫 7000+ 个 jar
    /// 冷磁盘要一两分钟，之后启动只需几十毫秒）。有变化时把新结果写回缓存。
    ///
    /// `progress(已扫, 共需扫)` 在扫描期间调用，给界面显示进度。
    pub fn load_or_build(
        jars: Vec<PathBuf>,
        cache_path: Option<&Path>,
        progress: Option<&(dyn Fn(usize, usize) + Sync)>,
    ) -> ClassIndex {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Mutex;

        let stats: Vec<(u64, u64)> = jars.iter().map(|p| stat_jar(p)).collect();
        let mut cached = cache_path.and_then(read_cache).unwrap_or_default();
        let mut scanned: Vec<Option<Vec<(u64, u64)>>> = vec![None; jars.len()];
        let mut todo: Vec<usize> = Vec::new();
        for (i, jar) in jars.iter().enumerate() {
            match cached.remove(jar) {
                Some(c) if (c.len, c.mtime_ms) == stats[i] => scanned[i] = c.entries,
                _ => todo.push(i),
            }
        }
        // 缓存里剩下的是已经不在 classpath 里的 jar，也算一次变化，需要重写缓存
        let changed = !todo.is_empty() || !cached.is_empty();

        // I/O 密集（读各 jar 尾部的中央目录），线程数取 8，让磁盘等待互相重叠
        let next = AtomicUsize::new(0);
        let done = AtomicUsize::new(0);
        let results: Mutex<Vec<JarScan>> = Mutex::new(Vec::with_capacity(todo.len()));
        std::thread::scope(|s| {
            for _ in 0..8.min(todo.len().max(1)) {
                s.spawn(|| loop {
                    let k = next.fetch_add(1, Ordering::Relaxed);
                    let Some(&i) = todo.get(k) else { break };
                    let r = scan_jar(&jars[i]);
                    results.lock().unwrap().push((i, r));
                    let d = done.fetch_add(1, Ordering::Relaxed) + 1;
                    if let Some(cb) = progress {
                        if d.is_multiple_of(100) || d == todo.len() {
                            cb(d, todo.len());
                        }
                    }
                });
            }
        });
        for (i, r) in results.into_inner().unwrap() {
            scanned[i] = r;
        }

        if changed {
            if let Some(path) = cache_path {
                // 写缓存失败不影响本次使用（只是下次又要重扫）
                let _ = write_cache(path, &jars, &stats, &scanned);
            }
        }

        let mut by_class: HashMap<u64, u32> = HashMap::new();
        let mut by_pkg: HashMap<u64, Vec<u32>> = HashMap::new();
        let mut unreadable = Vec::new();
        for (idx, (jar, entries)) in jars.iter().zip(scanned).enumerate() {
            let Some(entries) = entries else {
                unreadable.push(jar.clone());
                continue;
            };
            let idx = idx as u32;
            for (class_h, pkg_h) in entries {
                by_class.entry(class_h).or_insert(idx);
                let v = by_pkg.entry(pkg_h).or_default();
                if v.last() != Some(&idx) {
                    v.push(idx);
                }
            }
        }
        ClassIndex {
            jars,
            by_class,
            by_pkg,
            unreadable,
        }
    }

    /// 完整类名（如 `nc.vo.pub.lang.UFDouble`，内部类用 `$`）所在的 jar 序号。
    pub fn jar_for_class(&self, fqcn: &str) -> Option<u32> {
        self.by_class.get(&h(fqcn)).copied()
    }

    /// 包里有类的所有 jar（用于 `import a.b.*;`）。
    pub fn jars_for_package(&self, pkg: &str) -> &[u32] {
        self.by_pkg
            .get(&h(pkg))
            .map(|v| v.as_slice())
            .unwrap_or(&[])
    }

    pub fn class_count(&self) -> usize {
        self.by_class.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn make_jar(path: &Path, entries: &[&str]) {
        let f = File::create(path).unwrap();
        let mut z = zip::ZipWriter::new(f);
        let opts = zip::write::SimpleFileOptions::default();
        for e in entries {
            z.start_file(*e, opts).unwrap();
            z.write_all(b"x").unwrap();
        }
        z.finish().unwrap();
    }

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ncwb-idx-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn classpath_order_follows_rules() {
        let d = tmpdir("order");
        for p in [
            "lib/b.jar",
            "lib/a.jar",
            "framework/z.jar",
            "framework/mwconfig/m.jar",
            "external/lib/e.jar",
            "middleware/x.jar",
            "modules/bb/lib/l.jar",
            "modules/bb/client/lib/c.jar",
            "modules/bb/META-INF/lib/meta.jar",
            "modules/aa/lib/a.jar",
        ] {
            let f = d.join(p);
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(f, b"").unwrap();
        }
        let got: Vec<String> = classpath_jars(&d)
            .iter()
            .map(|p| {
                p.strip_prefix(&d)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect();
        assert_eq!(
            got,
            [
                "lib/a.jar",
                "lib/b.jar",
                "framework/mwconfig/m.jar",
                "framework/z.jar",
                "external/lib/e.jar",
                "middleware/x.jar",
                "modules/aa/lib/a.jar",
                "modules/bb/client/lib/c.jar",
                "modules/bb/lib/l.jar",
                "modules/bb/META-INF/lib/meta.jar",
            ]
        );
    }

    #[test]
    fn index_finds_classes_packages_and_first_jar_wins() {
        let d = tmpdir("index");
        let (j1, j2, bad) = (d.join("1.jar"), d.join("2.jar"), d.join("bad.jar"));
        make_jar(
            &j1,
            &[
                "a/b/C.class",
                "a/b/C$D.class",
                "META-INF/MANIFEST.MF",
                "module-info.class",
            ],
        );
        make_jar(&j2, &["a/b/C.class", "a/b/E.class", "x/Y.class"]);
        std::fs::write(&bad, b"not a zip").unwrap();
        let idx = ClassIndex::build(vec![j1.clone(), j2.clone(), bad.clone()]);
        assert_eq!(idx.jar_for_class("a.b.C"), Some(0)); // 两个 jar 都有，先出现的优先
        assert_eq!(idx.jar_for_class("a.b.C$D"), Some(0));
        assert_eq!(idx.jar_for_class("a.b.E"), Some(1));
        assert_eq!(idx.jar_for_class("x.Y"), Some(1));
        assert_eq!(idx.jar_for_class("no.Such"), None);
        assert_eq!(idx.jars_for_package("a.b"), &[0, 1]);
        assert_eq!(idx.unreadable, vec![bad]);
        assert_eq!(idx.class_count(), 4);
    }

    #[test]
    fn cache_is_reused_and_only_changed_jars_are_rescanned() {
        let d = tmpdir("cache");
        let cache = d.join("index.bin");
        let (j1, j2) = (d.join("1.jar"), d.join("2.jar"));
        make_jar(&j1, &["a/A.class"]);
        make_jar(&j2, &["b/B.class"]);
        let jars = vec![j1.clone(), j2.clone()];

        let scans = std::sync::atomic::AtomicUsize::new(0);
        let count =
            |_: usize, total: usize| scans.store(total, std::sync::atomic::Ordering::Relaxed);
        let first = ClassIndex::load_or_build(jars.clone(), Some(&cache), Some(&count));
        assert_eq!(scans.load(std::sync::atomic::Ordering::Relaxed), 2); // 首次全量扫两个
        assert_eq!(
            (first.jar_for_class("a.A"), first.jar_for_class("b.B")),
            (Some(0), Some(1))
        );
        assert!(cache.exists());

        // 第二次：没变，不应触发任何扫描
        scans.store(0, std::sync::atomic::Ordering::Relaxed);
        let second = ClassIndex::load_or_build(jars.clone(), Some(&cache), Some(&count));
        assert_eq!(scans.load(std::sync::atomic::Ordering::Relaxed), 0);
        assert_eq!(second.jar_for_class("b.B"), Some(1));

        // 改一个 jar（大小变了）：只重扫它一个，结果要反映新内容
        make_jar(&j2, &["b/B.class", "b/C.class"]);
        let third = ClassIndex::load_or_build(jars, Some(&cache), Some(&count));
        assert_eq!(scans.load(std::sync::atomic::Ordering::Relaxed), 1);
        assert_eq!(third.jar_for_class("b.C"), Some(1));
    }
}
