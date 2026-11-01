//! NC home 的 classpath 顺序与「类名 → jar」索引。
//!
//! 为什么要这个：NC home 有 7000+ 个 jar，全放进 ecj 的 classpath 会让编译卡住数分钟（M0 实测），
//! 所以要按源码的 import 反查「这个类在哪个 jar」，只把用得到的 jar 放进 classpath。
//!
//! classpath 顺序规则（从 Eclipse 的实际 classpath 里归纳；M0 验证过顺序会影响字节一致性，
//! 同名类先出现的优先）：
//!
//! 1. `lib`、`framework`、`external/lib`、`middleware`（各自递归，按完整路径字符串排序）
//! 2. `modules/<模块名>/...`：模块名排序；每个模块内按「段 public → client → private，
//!    段内 hyext 层在标准层之前」，散类目录（`*classes`）一律排在 jar 目录之前
//!
//! 第 2 条的段序对齐 Eclipse 的库容器（`IdeaProjectGenerateUtil.java:473-510`）：容器是
//! 「散类 + jar」，所以二开覆盖类所在的 `META-INF/classes`、`client/classes` 必须先于 jar
//! 出现，否则改了被覆盖的类不生效。
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

/// 一层目录的两种身份：散类目录，或装 jar 的目录。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LayerKind {
    /// 目录本身就是类根（`classes` / `resources` / `_classes`）
    Classes,
    /// 目录下是 jar（`lib` / `_lib`）
    Jars,
}

/// 官方 15 层的相对路径（不含作用域前缀），**顺序即优先级**。
///
/// 来自 `ClasspathComputer:23-65`（`computeStandCP`）：`extension` → `hyext` → 标准层，
/// 且**jar 紧跟它自己那一层**，不是「所有散类在前、所有 jar 在后」——写成后者会让
/// `hyext/lib` 的优先级掉到标准 `classes` 之后（实证 §6.4）。
///
/// 为什么连 `_classes` / `_lib` / `extension` 这些本机为空的层也列上：它们是官方的
/// 「覆盖通道」（下划线前缀是为了排在同名普通目录之前），现场装了补丁/定制包就可能
/// 有内容。本机为空只是「没用到」，不是「不存在」。
const LAYERS: [(&str, LayerKind); 15] = [
    ("extension/_classes", LayerKind::Classes),
    ("extension/classes", LayerKind::Classes),
    ("extension/resources", LayerKind::Classes),
    ("extension/lib", LayerKind::Jars),
    ("extension/_lib", LayerKind::Jars),
    ("hyext/_classes", LayerKind::Classes),
    ("hyext/classes", LayerKind::Classes),
    ("hyext/resources", LayerKind::Classes),
    ("hyext/lib", LayerKind::Jars),
    ("hyext/_lib", LayerKind::Jars),
    ("_classes", LayerKind::Classes),
    ("classes", LayerKind::Classes),
    ("resources", LayerKind::Classes),
    ("_lib", LayerKind::Jars),
    ("lib", LayerKind::Jars),
];

/// 三个作用域前缀，顺序 public → client → private。
///
/// 官方 `computeModulePublicCP` **只收 public 段**，client / META-INF 是模块自己的
/// classloader 在运行期按需加载的（那是 NC 的模块隔离）。我们多收后两段是**有意偏离**，
/// 理由是编译期：ecj 要能解析 client/private 里的实现类，否则报 `cannot be resolved`。
/// 代价是运行期比官方更宽松——本应被隔离的同名类会进同一个 app classloader。
const SCOPES: [&str; 3] = ["", "client/", "META-INF/"];

/// 一个模块要扫的全部层，按优先级排列（3 个作用域 × 15 层 = 45 条）。
///
/// **这是模块类路径唯一的真源**：散类目录与 jar 目录都从这里派生。
/// 以前是 `MODULE_JAR_DIRS` 与 `MODULE_CLASS_DIRS` 各写一套（6 + 6），
/// 改一处忘另一处就会出现「编译找得到、启动加载不到」，而且没有任何报错。
pub fn module_layers() -> Vec<(String, LayerKind)> {
    let mut out = Vec::with_capacity(SCOPES.len() * LAYERS.len());
    for scope in SCOPES {
        for (rel, kind) in LAYERS {
            out.push((format!("{scope}{rel}"), kind));
        }
    }
    out
}

/// 运行时类路径要排除的 jar：`xxx_src.jar` / `xxx_doc.jar`。
///
/// 与官方 `JarFilter:12-24` 一致。源码/文档 jar 里没有 `.class`，却会：
/// 1. 让 `ClassIndex` 多扫一遍（实测 6280 个 jar 里这类占一部分，纯浪费）；
/// 2. 在极端情况下因同名资源互相覆盖，产生「明明改了却读到另一份」的假象。
fn is_runtime_jar(p: &Path) -> bool {
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    !(name.ends_with("_src.jar") || name.ends_with("_doc.jar"))
}

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
    let layers = module_layers();
    for m in names {
        for (sub, kind) in &layers {
            if *kind != LayerKind::Jars {
                continue;
            }
            // 只取该目录本层的 jar，不递归（子目录会被下一个 sub 或别的模块覆盖）
            let dir = modules.join(&m).join(sub);
            let Ok(rd) = std::fs::read_dir(&dir) else {
                continue;
            };
            let mut jars: Vec<PathBuf> = rd
                .flatten()
                .map(|e| e.path())
                .filter(|p| {
                    p.is_file()
                        && p.extension().is_some_and(|x| x.eq_ignore_ascii_case("jar"))
                        && is_runtime_jar(p)
                })
                .collect();
            jars.sort_by_key(|p| sort_key(p));
            out.extend(jars);
        }
    }
    out
}

/// NC home 各模块已编译好的**散类目录**，排在 jar 之前。
///
/// 现在是**官方 15 层 × 3 个作用域**（`module_layers`），旧的 6 段是它的子集。
/// 本机实测（2026-10-31 逐段统计，
/// 判据可复跑 `tests/nc_class_dirs_live.rs`）：`modules/*/classes` **49 个目录 / 258 个
/// class**、`client/classes` 60/67、`META-INF/classes` 50/80，`hyext/classes` 与
/// `META-INF/hyext/classes` 各 1/1 ⇒ 合计 **160 个目录 / 406 个 class**。
/// **旧实现漏掉的 148 个全是二开覆盖类**——
/// 看不见的后果是编译报 `cannot be resolved`，而运行时类确实存在：编译期与运行期
/// 两份真源，比"顺序不对"严重（顺序错只是看错了，漏扫是看不见）。
///
/// 注：`modules/*/classes` 曾按 `find -path "*/classes"` 混算成「161 目录 / 458 class」，
/// 那是把各层级 `classes` 一起数进去的结果，数字偏高；`147` 也是同一口径下的错值。
pub fn module_class_dirs(nc_home: &Path) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(nc_home.join("modules")) else {
        return Vec::new();
    };
    let mut names: Vec<String> = rd
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort_by_key(|n| n.to_uppercase());

    let modules = nc_home.join("modules");
    let layers = module_layers();
    let mut dirs: Vec<PathBuf> = Vec::new();
    for name in names {
        for (sub, kind) in &layers {
            if *kind != LayerKind::Classes {
                continue;
            }
            let p = modules
                .join(&name)
                .join(sub.replace('/', std::path::MAIN_SEPARATOR_STR));
            if p.is_dir() {
                dirs.push(p);
            }
        }
    }
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
/// 缓存里 jar 记录数的上限。一条记录对应 classpath 里的一个 jar（真机 7000+），
/// 10 万已经很宽松。**count 来自文件头，损坏或被篡改的缓存可以声明任意值**：
/// `with_capacity(40 亿)` 会直接要 TB 级内存——启动进程当场 OOM，而缓存只是
/// 「下次重扫一遍」的优化，为它冒 OOM 的险没有道理。超过上限整份作废。
const MAX_CACHE_ENTRIES: u32 = 100_000;

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
    if count > MAX_CACHE_ENTRIES {
        return None;
    }
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
                // 段序 public → client → private（旧实现把 client 排最前）
                "modules/bb/lib/l.jar",
                "modules/bb/client/lib/c.jar",
                "modules/bb/META-INF/lib/meta.jar",
            ]
        );
    }

    /// D6：散类目录必须六段都收，且段序与 jar 同源、散类排在 jar 之前。
    /// 本机 `client/classes`、`META-INF/classes` 与两个 hyext 段里合计躺着 148 个二开覆盖类，
    /// 旧实现只收 `modules/<m>/classes`（258 个 class），它们一个都进不了类路径。
    #[test]
    fn module_class_dirs_covers_all_six_segments_in_segment_order() {
        let d = tmpdir("classdirs");
        for p in [
            "modules/bb/classes",
            "modules/bb/client/classes",
            "modules/bb/META-INF/classes",
            "modules/bb/META-INF/hyext/classes",
            "modules/aa/META-INF/classes",
            "modules/aa/classes",
            // 只有 jar、没有散类的目录不该被收
            "modules/bb/lib",
        ] {
            std::fs::create_dir_all(d.join(p)).unwrap();
        }
        let got: Vec<String> = module_class_dirs(&d)
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
                // 模块名排序在前，模块内 public → private，hyext 层在标准层前
                "modules/aa/classes",
                "modules/aa/META-INF/classes",
                "modules/bb/classes",
                "modules/bb/client/classes",
                "modules/bb/META-INF/hyext/classes",
                "modules/bb/META-INF/classes",
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

    /// 缓存头的 count 是**文件里的 4 个字节**，损坏或被篡改的缓存可以声明
    /// 任意大。`HashMap::with_capacity(40 亿)` 会直接要 TB 级内存——启动进程
    /// 当场 OOM，而缓存只是「下次少扫一遍」的优化。超上限整份作废重扫。
    #[test]
    fn 缓存条目数超上限时整份作废() {
        let d = tmpdir("badcount");
        let cache = d.join("index.bin");
        let mut v = Vec::new();
        v.extend_from_slice(CACHE_MAGIC);
        v.extend_from_slice(&u32::MAX.to_le_bytes()); // count = 40 亿
        v.extend_from_slice(&[0u8; 32]);
        std::fs::write(&cache, &v).unwrap();
        assert!(
            read_cache(&cache).is_none(),
            "条目数超上限必须整份作废，而不是按它预分配内存"
        );
    }

    /// 模块 15 层的顺序是官方 `computeStandCP` 抄下来的，不能凭感觉调：
    /// `extension` → `hyext` → 标准层，且 **jar 紧跟它自己那一层**。
    ///
    /// 这条顺序是行为不是美观：把 `hyext/lib` 排到标准 `classes` 之后，
    /// 现场补丁放在 `hyext/classes` 里的类就会被 `modules/<m>/lib` 的原版盖掉。
    #[test]
    fn 模块层是官方15层且jar紧跟本层() {
        let layers: Vec<String> = module_layers().into_iter().map(|(p, _)| p).collect();

        // 第一段（public 作用域）必须与官方 15 层逐字一致
        let expect = [
            "extension/_classes",
            "extension/classes",
            "extension/resources",
            "extension/lib",
            "extension/_lib",
            "hyext/_classes",
            "hyext/classes",
            "hyext/resources",
            "hyext/lib",
            "hyext/_lib",
            "_classes",
            "classes",
            "resources",
            "_lib",
            "lib",
        ];
        assert_eq!(&layers[..15], &expect[..]);

        let at = |name: &str| layers.iter().position(|p| p == name).unwrap();
        // jar 紧跟本层：hyext 的 lib 必须早于标准 classes
        assert!(
            at("hyext/lib") < at("classes"),
            "hyext/lib 必须早于标准 classes"
        );
        assert!(
            at("extension/lib") < at("hyext/classes"),
            "extension 整段在 hyext 之前"
        );
        // 下划线变体比同名普通目录更优先（官方的「覆盖通道」）
        assert!(at("_classes") < at("classes"));
        assert!(at("_lib") < at("lib"));
        // 作用域：public → client → private
        assert!(at("classes") < at("client/classes"));
        assert!(at("client/classes") < at("META-INF/classes"));
        assert_eq!(layers.len(), 45, "3 个作用域 × 15 层");
    }

    /// 散类目录与 jar 目录必须来自同一份层表：以前是两份常量各写一套，
    /// 改一处忘另一处会变成「编译找得到、启动加载不到」，还没有任何报错。
    #[test]
    fn 散类与jar都从同一份层表派生() {
        let layers = module_layers();
        let classes: Vec<&str> = layers
            .iter()
            .filter(|(_, k)| *k == LayerKind::Classes)
            .map(|(p, _)| p.as_str())
            .collect();
        let jars: Vec<&str> = layers
            .iter()
            .filter(|(_, k)| *k == LayerKind::Jars)
            .map(|(p, _)| p.as_str())
            .collect();
        // 15 层里 9 个类目录 + 6 个 jar 目录
        assert_eq!(classes.len(), 9 * 3);
        assert_eq!(jars.len(), 6 * 3);
        assert!(classes.contains(&"classes"));
        assert!(jars.contains(&"lib"));
    }

    #[test]
    fn 源码与文档jar不进运行时类路径() {
        assert!(is_runtime_jar(Path::new("D:/ncc/lib/a.jar")));
        assert!(!is_runtime_jar(Path::new("D:/ncc/lib/a_src.jar")));
        assert!(
            !is_runtime_jar(Path::new("D:/ncc/lib/a_DOC.jar")),
            "大小写不敏感"
        );
        assert!(!is_runtime_jar(Path::new("D:/ncc/lib/x_src.jar")));
    }
}
