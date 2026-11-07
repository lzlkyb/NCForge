//! 全 NC 类名目录：只缓存 ZIP 中央目录，成员语义仍由 JDT 提供。
//! 与编译用的哈希索引分开，避免让不使用编辑器的编译流程常驻完整类名。
use crate::nc_index::ClassIndex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize, Deserialize)]
struct CachedJar {
    path: PathBuf,
    len: u64,
    modified: u128,
    names: Vec<String>,
}
struct Entry {
    name: String,
    jar: u32,
}
#[derive(Clone, Copy, PartialEq)]
struct JarFingerprint {
    len: u64,
    modified: Option<SystemTime>,
}
fn jar_fingerprint(path: &Path) -> Option<JarFingerprint> {
    let metadata = std::fs::metadata(path).ok()?;
    Some(JarFingerprint {
        len: metadata.len(),
        modified: metadata.modified().ok(),
    })
}
pub struct TypeCatalog {
    entries: Vec<Entry>,
    fingerprints: Vec<Option<JarFingerprint>>,
    kinds: std::sync::Mutex<HashMap<String, Option<u8>>>,
}
#[derive(Debug, Serialize)]
pub struct TypeCandidate {
    pub name: String,
    pub kind: u8,
    /// `ClassIndex.jars` 的下标：打开结果时要落到具体 jar。
    pub jar: u32,
}
fn simple(name: &str) -> &str {
    name.rsplit('.').next().unwrap_or(name)
}

/// 类型名匹配分：0 完全相同、1 前缀、2 驼峰首字母、3 包含；不命中为 `None`。
///
/// 前端快速面板以前只能靠 jdt.ls 的 `workspace/symbol` 做模糊匹配；没有语言服务时
/// 连「VBO → VoucherBillOrder」都做不到。工作区索引与 jar 目录共用这一个打分函数，
/// 两边的排序规则才不会一个说前缀优先、另一个说短名优先。
///
/// **不用 `to_lowercase()`**：工作区索引有十几万条成员，逐条分配字符串实测 200ms
/// 起；这里全是 ASCII 标识符，按字节做大小写无关比较即可，零分配。
pub(crate) fn type_match_score(query: &str, name: &str) -> Option<u8> {
    type_match_score_with(query, name, None)
}

/// 同 [`type_match_score`]，但可以带上预先算好的驼峰首字母（索引里存着）。
///
/// 首字母串是「VBO → VoucherBillOrder」这类查法的关键，逐条现算同样要分配一个
/// String；存在索引里就把这条也省掉。
pub(crate) fn type_match_score_with(query: &str, name: &str, initials: Option<&str>) -> Option<u8> {
    if query.is_empty() || query.len() > 100 {
        return None;
    }
    if eq_ignore_case(name, query) {
        return Some(0);
    }
    if starts_with_ignore_case(name, query) {
        return Some(1);
    }
    if query.len() >= 2 {
        let owned;
        let ini = match initials {
            Some(s) => s,
            None => {
                owned = initials_of(name);
                &owned
            }
        };
        if starts_with_ignore_case(ini, query) || contains_ignore_case(ini, query) {
            return Some(2);
        }
    }
    contains_ignore_case(name, query).then_some(3)
}

/// 驼峰首字母（小写）：`VoucherBillOrder` → `vbo`。
pub(crate) fn initials_of(name: &str) -> String {
    let mut out = String::with_capacity(8);
    for (i, c) in name.chars().enumerate() {
        if i == 0 || c.is_uppercase() {
            out.push(c.to_ascii_lowercase());
        }
    }
    out
}

fn eq_ignore_case(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.as_bytes()
            .iter()
            .zip(b.as_bytes())
            .all(|(x, y)| x.eq_ignore_ascii_case(y))
}

fn starts_with_ignore_case(s: &str, prefix: &str) -> bool {
    s.len() >= prefix.len()
        && s.as_bytes()[..prefix.len()]
            .iter()
            .zip(prefix.as_bytes())
            .all(|(x, y)| x.eq_ignore_ascii_case(y))
}

fn contains_ignore_case(s: &str, needle: &str) -> bool {
    let (n, h) = (needle.len(), s.len());
    if n == 0 {
        return true;
    }
    if n > h {
        return false;
    }
    let (sb, nb) = (s.as_bytes(), needle.as_bytes());
    (0..=h - n).any(|i| {
        sb[i..i + n]
            .iter()
            .zip(nb)
            .all(|(x, y)| x.eq_ignore_ascii_case(y))
    })
}
fn type_name(entry: &str) -> Option<String> {
    let name = entry.strip_suffix(".class")?;
    if name.starts_with("META-INF/") || name.contains('$') || name.ends_with("-info") {
        return None;
    }
    if !name.split('/').all(|s| {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_alphanumeric() || c == '_' || c == '$')
    }) {
        return None;
    }
    Some(name.replace('/', "."))
}
/// 进程内复用的那一份：跟着它所依据的 `ClassIndex` 实例走。
///
/// 类索引本身按 NC home 在进程内共享（见 `compile_cmds::cached_index`），换 NC home 才会
/// 换实例。以前每次启动 / 切模块都重读 JSON、逐 jar 取元数据、克隆名字、排序，
/// 现在复用未变化的目录，仅核对 jar 元数据；现场替换 jar 也能作废成员可见性缓存。
/// 用 `Weak` 记索引：索引被换掉后自然对不上、重建。
static SHARED: std::sync::Mutex<
    Option<(std::sync::Weak<ClassIndex>, std::sync::Arc<TypeCatalog>)>,
> = std::sync::Mutex::new(None);

impl TypeCatalog {
    /// 同 `load_cancellable`，但索引与 jar 未变时直接复用进程内的目录。
    pub fn shared_cancellable(
        index: &std::sync::Arc<ClassIndex>,
        cache: &Path,
        progress: &dyn Fn(usize, usize),
        cancelled: &dyn Fn() -> bool,
    ) -> Option<std::sync::Arc<Self>> {
        if cancelled() {
            return None;
        }
        let shared = {
            let guard = SHARED.lock().unwrap_or_else(|e| e.into_inner());
            guard.as_ref().and_then(|(held, catalog)| {
                held.upgrade()
                    .filter(|i| std::sync::Arc::ptr_eq(i, index))
                    .map(|_| catalog.clone())
            })
        };
        if let Some(catalog) = shared {
            // 文件系统访问放在锁外，避免慢盘阻挡其他语言服务的取消与切换。
            let mut unchanged = true;
            for (path, saved) in index.jars.iter().zip(&catalog.fingerprints) {
                if cancelled() {
                    return None;
                }
                if jar_fingerprint(path) != *saved {
                    unchanged = false;
                    break;
                }
            }
            if unchanged {
                return Some(catalog);
            }
        }
        // 构建可能要几秒，不持锁；语言服务同一时刻只有一次拉起，重复构建的代价可以接受
        let catalog =
            std::sync::Arc::new(Self::load_cancellable(index, cache, progress, cancelled)?);
        *SHARED.lock().unwrap_or_else(|e| e.into_inner()) =
            Some((std::sync::Arc::downgrade(index), catalog.clone()));
        Some(catalog)
    }

    /// 已有的进程内目录：不重建、也不校验 jar 指纹。
    ///
    /// 给快速面板这类「拿不到就这次先不显示 jar 段」的调用方用；真正要保证
    /// 与磁盘 jar 同步的路径仍走 `shared_cancellable`。
    pub fn shared_existing(index: &std::sync::Arc<ClassIndex>) -> Option<std::sync::Arc<Self>> {
        let guard = SHARED.lock().unwrap_or_else(|e| e.into_inner());
        guard.as_ref().and_then(|(held, catalog)| {
            held.upgrade()
                .filter(|i| std::sync::Arc::ptr_eq(i, index))
                .map(|_| catalog.clone())
        })
    }

    pub fn load(index: &ClassIndex, cache: &Path, progress: &dyn Fn(usize, usize)) -> Self {
        Self::load_cancellable(index, cache, progress, &|| false).expect("uncancelled catalogue")
    }
    pub fn load_cancellable(
        index: &ClassIndex,
        cache: &Path,
        progress: &dyn Fn(usize, usize),
        cancelled: &dyn Fn() -> bool,
    ) -> Option<Self> {
        if cancelled() {
            return None;
        }
        // 损坏的本地优化缓存不能导致无界分配；失效时重新读取 jar 中央目录。
        let cached: Vec<CachedJar> = std::fs::metadata(cache)
            .ok()
            .filter(|m| m.len() <= 128 * 1024 * 1024)
            .and_then(|_| File::open(cache).ok())
            .and_then(|f| serde_json::from_reader(BufReader::new(f)).ok())
            .unwrap_or_default();
        let mut cached: HashMap<PathBuf, CachedJar> =
            cached.into_iter().map(|j| (j.path.clone(), j)).collect();
        let mut entries = Vec::new();
        let mut fingerprints = Vec::with_capacity(index.jars.len());
        let mut saved = Vec::new();
        let mut changed = false;
        for (id, path) in index.jars.iter().enumerate() {
            if cancelled() {
                return None;
            }
            let fingerprint = jar_fingerprint(path);
            fingerprints.push(fingerprint);
            let Some(JarFingerprint { len, modified }) = fingerprint else {
                continue;
            };
            let modified = modified
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_nanos());
            let names = match cached.remove(path) {
                Some(j) if j.len == len && j.modified == modified => j.names,
                _ => {
                    changed = true;
                    File::open(path)
                        .ok()
                        .and_then(|f| zip::ZipArchive::new(f).ok())
                        .map(|z| z.file_names().filter_map(type_name).collect())
                        .unwrap_or_default()
                }
            };
            for name in &names {
                // 同名类严格遵循 NC/Eclipse 的类路径优先级，不猜 jar。
                if index.jar_for_class(name) == Some(id as u32) {
                    entries.push(Entry {
                        name: name.clone(),
                        jar: id as u32,
                    });
                }
            }
            saved.push(CachedJar {
                path: path.clone(),
                len,
                modified,
                names,
            });
            if id % 250 == 0 || id + 1 == index.jars.len() {
                progress(id + 1, index.jars.len());
            }
        }
        if changed || !cached.is_empty() {
            let temp = cache.with_extension("types.tmp");
            if let Ok(file) = File::create(&temp) {
                if serde_json::to_writer(file, &saved).is_ok() {
                    let _ = std::fs::rename(&temp, cache);
                } else {
                    let _ = std::fs::remove_file(&temp);
                }
            }
        }
        entries.sort_by(|a, b| {
            simple(&a.name)
                .cmp(simple(&b.name))
                .then(a.name.cmp(&b.name))
        });
        entries.dedup_by(|a, b| a.name == b.name);
        Some(Self {
            entries,
            fingerprints,
            kinds: std::sync::Mutex::new(HashMap::new()),
        })
    }
    pub fn search(&self, index: &ClassIndex, prefix: &str, limit: usize) -> Vec<TypeCandidate> {
        if prefix.chars().count() < 2 || prefix.len() > 100 {
            return vec![];
        }
        let start = self.entries.partition_point(|e| simple(&e.name) < prefix);
        let mut found = Vec::new();
        for entry in self.entries[start..]
            .iter()
            .take_while(|e| simple(&e.name).starts_with(prefix))
            .take(200)
        {
            if let Some(kind) = self.kind(index, entry) {
                found.push(TypeCandidate {
                    name: entry.name.clone(),
                    kind,
                    jar: entry.jar,
                });
                if found.len() >= limit {
                    break;
                }
            }
        }
        found
    }

    /// 前缀 / 包含 / 驼峰首字母三种匹配，按「越精确越靠前」排序。
    ///
    /// 和 `search` 一样只收 public 类型：解析访问标记要逐个开 jar，所以先按名字多取
    /// 一批候选（`limit * 8`），凑够 `limit` 就停，不为一个词打开几万个 jar。
    pub fn search_fuzzy(
        &self,
        index: &ClassIndex,
        query: &str,
        limit: usize,
    ) -> Vec<TypeCandidate> {
        if query.chars().count() < 2 || query.len() > 100 || limit == 0 {
            return vec![];
        }
        let mut hits: Vec<(u8, &Entry)> = self
            .entries
            .iter()
            .filter_map(|e| type_match_score(query, simple(&e.name)).map(|s| (s, e)))
            .collect();
        hits.sort_by(|a, b| {
            a.0.cmp(&b.0)
                .then(simple(&a.1.name).len().cmp(&simple(&b.1.name).len()))
                .then(a.1.name.cmp(&b.1.name))
        });
        hits.truncate(limit.saturating_mul(8).max(200));
        let mut found = Vec::new();
        for (_, entry) in hits {
            if let Some(kind) = self.kind(index, entry) {
                found.push(TypeCandidate {
                    name: entry.name.clone(),
                    kind,
                    jar: entry.jar,
                });
                if found.len() >= limit {
                    break;
                }
            }
        }
        found
    }
    pub fn contains(&self, index: &ClassIndex, name: &str) -> bool {
        self.entries
            .binary_search_by(|e| {
                simple(&e.name)
                    .cmp(simple(name))
                    .then(e.name.as_str().cmp(name))
            })
            .ok()
            .is_some_and(|id| self.kind(index, &self.entries[id]).is_some())
    }
    fn kind(&self, index: &ClassIndex, entry: &Entry) -> Option<u8> {
        let mut cache = self.kinds.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(kind) = cache.get(&entry.name) {
            return *kind;
        }
        let kind = public_kind(&index.jars[entry.jar as usize], &entry.name);
        if cache.len() >= 4096 {
            cache.clear();
        }
        cache.insert(entry.name.clone(), kind);
        kind
    }
}
fn public_kind(jar: &Path, name: &str) -> Option<u8> {
    let mut archive = zip::ZipArchive::new(File::open(jar).ok()?).ok()?;
    let entry = archive
        .by_name(&format!("{}.class", name.replace('.', "/")))
        .ok()?;
    // 只需要常量池与 access flags；异常压缩条目不能耗尽内存。
    let mut bytes = Vec::new();
    entry.take(1024 * 1024).read_to_end(&mut bytes).ok()?;
    access_kind(&bytes)
}
fn access_kind(bytes: &[u8]) -> Option<u8> {
    if bytes.get(..4)? != [0xca, 0xfe, 0xba, 0xbe] {
        return None;
    }
    let u16at = |i| Some(u16::from_be_bytes([*bytes.get(i)?, *bytes.get(i + 1)?]) as usize);
    let count = u16at(8)?;
    if count == 0 {
        return None;
    }
    let mut pos = 10;
    let mut i = 1;
    while i < count {
        pos += match *bytes.get(pos)? {
            1 => 3 + u16at(pos + 1)?,
            3 | 4 | 9 | 10 | 11 | 12 | 17 | 18 => 5,
            5 | 6 => {
                i += 1;
                9
            }
            7 | 8 | 16 | 19 | 20 => 3,
            15 => 4,
            _ => return None,
        };
        i += 1;
    }
    let flags = u16at(pos)?;
    if flags & 1 == 0 {
        return None;
    }
    Some(if flags & 0x4000 != 0 {
        13
    } else if flags & 0x200 != 0 {
        8
    } else {
        7
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    #[test]
    fn excludes_internal_metadata_and_invalid_names() {
        assert_eq!(type_name("nc/vo/Foo.class"), Some("nc.vo.Foo".into()));
        for n in [
            "nc/Foo$1.class",
            "META-INF/versions/9/Foo.class",
            "module-info.class",
            "../Foo.class",
            "nc/package-info.class",
        ] {
            assert_eq!(type_name(n), None);
        }
    }
    #[test]
    fn type_name_scoring_prefers_prefix_then_camel_then_contains() {
        assert_eq!(type_match_score("Widget", "Widget"), Some(0));
        assert_eq!(type_match_score("Wid", "Widget"), Some(1));
        // 驼峰首字母：VBO → VoucherBillOrder
        assert_eq!(type_match_score("VBO", "VoucherBillOrder"), Some(2));
        assert_eq!(type_match_score("rder", "Order"), Some(3));
        assert_eq!(type_match_score("xyz", "Voucher"), None);
    }

    #[test]
    fn public_class_flags_and_truncated_headers() {
        let mut bytes = vec![0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 52, 0, 1, 0, 1];
        assert_eq!(access_kind(&bytes), Some(7));
        bytes[10] = 2;
        assert_eq!(access_kind(&bytes), Some(8));
        bytes[10] = 0;
        bytes[11] = 0;
        assert_eq!(access_kind(&bytes), None);
        for i in 0..bytes.len() {
            assert_eq!(access_kind(&bytes[..i]), None);
        }
    }
    #[test]
    fn prefix_priority_visibility_and_cache_invalidation() {
        let root =
            std::env::temp_dir().join(format!("ncforge-type-catalog-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let create = |path: &Path, names: &[(&str, u8)]| {
            let mut zip = zip::ZipWriter::new(File::create(path).unwrap());
            for (name, flags) in names {
                zip.start_file(*name, zip::write::SimpleFileOptions::default())
                    .unwrap();
                zip.write_all(&[0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 52, 0, 1, 0, *flags])
                    .unwrap();
            }
            zip.finish().unwrap();
        };
        let a = root.join("a.jar");
        let b = root.join("b.jar");
        let cache = root.join("types.json");
        create(&a, &[("nc/Widget.class", 1), ("nc/WidgetHidden.class", 0)]);
        create(
            &b,
            &[("nc/Widget.class", 1), ("other/WidgetOther.class", 1)],
        );
        let modified = UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        File::options()
            .write(true)
            .open(&b)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        let load = || {
            let index = ClassIndex::build(vec![a.clone(), b.clone()]);
            let catalog = TypeCatalog::load(&index, &cache, &|_, _| {});
            catalog
                .search(&index, "Wid", 20)
                .into_iter()
                .map(|c| c.name)
                .collect::<Vec<_>>()
        };
        let partial_index = ClassIndex::build(vec![a.clone(), b.clone()]);
        let checked = std::sync::atomic::AtomicUsize::new(0);
        assert!(
            TypeCatalog::load_cancellable(&partial_index, &cache, &|_, _| {}, &|| {
                checked.fetch_add(1, std::sync::atomic::Ordering::Relaxed) >= 2
            })
            .is_none()
        );
        assert!(!cache.exists(), "取消不能落下半份缓存");
        assert_eq!(load(), ["nc.Widget", "other.WidgetOther"]);
        assert_eq!(load(), ["nc.Widget", "other.WidgetOther"]);
        let old_len = std::fs::metadata(&b).unwrap().len();
        // 同长度、同一毫秒内的替换也不能复用旧的磁盘类名缓存。
        create(
            &b,
            &[("nc/Widget.class", 1), ("other/WidgetAdded.class", 1)],
        );
        File::options()
            .write(true)
            .open(&b)
            .unwrap()
            .set_modified(modified + std::time::Duration::from_micros(100))
            .unwrap();
        assert_eq!(std::fs::metadata(&b).unwrap().len(), old_len);
        assert_eq!(load(), ["nc.Widget", "other.WidgetAdded"]);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn 同一份索引复用目录_索引或jar变化时重建() {
        use std::sync::Arc;
        let root = std::env::temp_dir().join(format!("ncforge-type-shared-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let jar = root.join("a.jar");
        let mut zip = zip::ZipWriter::new(File::create(&jar).unwrap());
        zip.start_file("nc/Widget.class", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(&[0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 52, 0, 1, 0, 1])
            .unwrap();
        zip.finish().unwrap();
        let cache = root.join("types.json");

        let index = Arc::new(ClassIndex::build(vec![jar.clone()]));
        let first = TypeCatalog::shared_cancellable(&index, &cache, &|_, _| {}, &|| false).unwrap();
        // 同一份索引：直接拿到同一个对象，连进度回调都不该走
        let again =
            TypeCatalog::shared_cancellable(&index, &cache, &|_, _| panic!("不该重建"), &|| false)
                .unwrap();
        assert!(Arc::ptr_eq(&first, &again));
        assert!(TypeCatalog::shared_cancellable(
            &index,
            &cache,
            &|_, _| panic!("取消不能重建"),
            &|| true
        )
        .is_none());
        // 索引换了（如换 NC home）：重建
        let other = Arc::new(ClassIndex::build(vec![jar.clone()]));
        let rebuilt =
            TypeCatalog::shared_cancellable(&other, &cache, &|_, _| {}, &|| false).unwrap();
        assert!(!Arc::ptr_eq(&first, &rebuilt));
        assert!(rebuilt.contains(&other, "nc.Widget"));

        // 索引实例未变时，现场覆盖 jar 也必须作废正文目录和已经缓存的 public 标记。
        let mut zip = zip::ZipWriter::new(File::create(&jar).unwrap());
        zip.start_file(
            "nc/WidgetRemoved.class",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        zip.write_all(&[0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 52, 0, 1, 0, 1])
            .unwrap();
        zip.finish().unwrap();
        let refreshed =
            TypeCatalog::shared_cancellable(&other, &cache, &|_, _| {}, &|| false).unwrap();
        assert!(!Arc::ptr_eq(&rebuilt, &refreshed));
        assert!(!refreshed.contains(&other, "nc.Widget"));
        let _ = std::fs::remove_dir_all(root);
    }
}
