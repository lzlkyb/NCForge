//! JAR 文本与散类目录：每个来源一份有界缓存，查询不重复解压，也不常驻全文。
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

pub(crate) const MAX_FILE: u64 = 4 * 1024 * 1024;
const MAX_SOURCE: usize = 32 * 1024 * 1024;
const MAX_TOTAL: u64 = 512 * 1024 * 1024;
const MAX_META: u64 = 16 * 1024 * 1024;
const MAX_ENTRIES: usize = 100_000;
const MAX_NAMES_MEMORY: usize = 128 * 1024 * 1024;
static CACHE_IO: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Stamp {
    name: String,
    len: u64,
    modified: u128,
}
#[derive(Clone, Debug)]
pub(crate) struct Source {
    pub path: PathBuf,
    pub module: String,
    stamps: Vec<Stamp>,
    pub archive: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct Entry {
    pub name: String,
    pub off: u32,
    pub len: u32,
    pub class: bool,
}
#[derive(Serialize, Deserialize)]
pub(crate) struct Table {
    version: u32,
    stamps: Vec<Stamp>,
    pub entries: Vec<Entry>,
    pub skipped: usize,
}
#[derive(Clone)]
pub(crate) struct CachedSource {
    pub source: Source,
    pub meta: PathBuf,
    pub blob: PathBuf,
    pub names: Option<Vec<Entry>>,
    pub has_text: bool,
}
pub(crate) struct Catalog {
    pub sources: Vec<CachedSource>,
    pub skipped: usize,
}

pub(crate) fn text_entry(name: &str) -> bool {
    matches!(
        name.rsplit('.')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "java"
            | "rest"
            | "upm"
            | "aop"
            | "bmf"
            | "bpf"
            | "mbe"
            | "mbp"
            | "wsdl"
            | "xml"
            | "properties"
            | "txt"
            | "json"
            | "yaml"
            | "yml"
            | "sql"
            | "ini"
            | "conf"
            | "cfg"
            | "mf"
            | "html"
            | "htm"
            | "css"
            | "js"
            | "jsp"
            | "md"
            | "csv"
            | "xsd"
            | "dtd"
    )
}
pub(crate) fn valid_entry(name: &str) -> bool {
    !name.is_empty()
        && !name.contains(['\\', ':', '\0'])
        && name
            .split('/')
            .all(|s| !s.is_empty() && s != "." && s != "..")
}
fn stamp(path: &Path, name: String) -> Option<Stamp> {
    let m = path.metadata().ok()?;
    Some(Stamp {
        name,
        len: m.len(),
        modified: m
            .modified()
            .ok()?
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_nanos(),
    })
}
fn walk(root: &Path, accept: &dyn Fn(&Path) -> bool) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0)];
    while let Some((dir, depth)) = stack.pop() {
        if depth > 32 {
            continue;
        }
        let Ok(rd) = std::fs::read_dir(dir) else {
            continue;
        };
        for e in rd.flatten() {
            let Ok(ft) = e.file_type() else { continue };
            let p = e.path();
            // 不穿过 junction/symlink 把搜索范围扩展到别的磁盘树。
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if e.metadata().is_ok_and(|m| m.file_attributes() & 0x400 != 0) {
                    continue;
                }
            }
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                if !matches!(
                    e.file_name().to_str(),
                    Some(".git" | ".svn" | "node_modules" | "target" | ".metadata")
                ) {
                    stack.push((p, depth + 1));
                }
            } else if ft.is_file() && accept(&p) {
                out.push(p);
            }
        }
    }
    out.sort();
    out
}
fn module_of(path: &Path, home: &Path, root: &Path) -> String {
    path.strip_prefix(home.join("modules"))
        .or_else(|_| path.strip_prefix(root))
        .ok()
        .and_then(|p| p.components().next())
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .unwrap_or_default()
}
pub(crate) fn discover(home: &Path, root: &Path) -> Vec<Source> {
    let mut jars = crate::nc_index::classpath_jars(home);
    jars.extend(crate::java_comments::source_jars(home));
    for base in [root.to_path_buf(), home.join("hyext")] {
        jars.extend(walk(&base, &|p| {
            p.extension().is_some_and(|e| e.eq_ignore_ascii_case("jar"))
        }));
    }
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for path in jars {
        if !seen.insert(path.clone()) {
            continue;
        }
        if let Some(s) = stamp(&path, String::new()) {
            out.push(Source {
                module: module_of(&path, home, root),
                path,
                stamps: vec![s],
                archive: true,
            });
        }
    }
    let mut dirs = crate::nc_index::module_class_dirs(home);
    dirs.extend(
        crate::nc_index::stand_cp(&home.join("hyext"))
            .into_iter()
            .filter(|p| p.is_dir()),
    );
    // 工作区 hyext 不依赖 .classpath 是否已登记。
    dirs.extend(
        crate::nc_index::stand_cp(root)
            .into_iter()
            .filter(|p| p.is_dir()),
    );
    if let Ok(rd) = std::fs::read_dir(root) {
        for e in rd.flatten().filter(|e| e.path().is_dir()) {
            dirs.extend(
                crate::nc_index::stand_cp(&e.path())
                    .into_iter()
                    .filter(|p| p.is_dir()),
            );
        }
    }
    for path in dirs {
        if !seen.insert(path.clone()) {
            continue;
        }
        let stamps = walk(&path, &|p| {
            text_entry(&p.to_string_lossy()) || p.extension().is_some_and(|e| e == "class")
        })
        .into_iter()
        .filter_map(|p| {
            stamp(
                &p,
                p.strip_prefix(&path)
                    .ok()?
                    .to_string_lossy()
                    .replace('\\', "/"),
            )
        })
        .collect();
        out.push(Source {
            module: module_of(&path, home, root),
            path,
            stamps,
            archive: false,
        });
    }
    out
}
pub(crate) fn key(value: &str) -> String {
    let mut h = 0xcbf2_9ce4_8422_2325u64;
    for b in value.bytes() {
        h = (h ^ b as u64).wrapping_mul(0x100_0000_01b3);
    }
    format!("{h:016x}")
}
pub(crate) fn read_table(path: &Path) -> Result<Table, String> {
    if path.metadata().map_err(|e| e.to_string())?.len() > MAX_META {
        return Err("库文件目录缓存超限".into());
    }
    let table: Table = serde_json::from_reader(File::open(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if table.version != 1 || table.entries.len() > MAX_ENTRIES {
        return Err("库文件目录缓存失效".into());
    }
    Ok(table)
}
fn bounded_read(reader: impl Read, size: u64) -> Result<Vec<u8>, String> {
    if size > MAX_FILE {
        return Err("文件超过 4 MiB".into());
    }
    let mut bytes = Vec::new();
    reader
        .take(MAX_FILE + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_FILE {
        return Err("文件解压后超过 4 MiB".into());
    }
    Ok(bytes)
}
pub(crate) fn read_entry(path: &Path, entry: &str, archive: bool) -> Result<Vec<u8>, String> {
    if !valid_entry(entry) {
        return Err("无效的包内路径".into());
    }
    if archive {
        let mut zip = zip::ZipArchive::new(File::open(path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        let member = zip.by_name(entry).map_err(|e| e.to_string())?;
        let size = member.size();
        bounded_read(member, size)
    } else {
        let target = crate::security::path::resolve_safe_path(
            &path.join(entry).to_string_lossy(),
            &[path.to_string_lossy().into_owned()],
            &[],
            true,
        )?;
        let size = target.metadata().map_err(|e| e.to_string())?.len();
        bounded_read(File::open(target).map_err(|e| e.to_string())?, size)
    }
}
fn feed(table: &mut Table, bytes: &mut Vec<u8>, name: &str, raw: Result<Vec<u8>, String>) {
    if table.entries.len() >= MAX_ENTRIES {
        table.skipped += 1;
        return;
    }
    let Ok(raw) = raw else {
        table.skipped += 1;
        return;
    };
    if raw.contains(&0) {
        table.skipped += 1;
        return;
    }
    let text = crate::workspace::decode_lossy(&raw);
    if bytes.len() + text.len() > MAX_SOURCE {
        table.skipped += 1;
        return;
    }
    table.entries.push(Entry {
        name: name.into(),
        off: bytes.len() as u32,
        len: text.len() as u32,
        class: false,
    });
    bytes.extend_from_slice(text.as_bytes());
}
fn build_source(source: &Source, meta: &Path, blob: &Path) -> Result<Table, String> {
    let _io = CACHE_IO.lock().unwrap_or_else(|e| e.into_inner());
    let mut table = Table {
        version: 1,
        stamps: source.stamps.clone(),
        entries: Vec::new(),
        skipped: 0,
    };
    let mut bytes = Vec::new();
    if source.archive {
        let mut zip = zip::ZipArchive::new(File::open(&source.path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        for i in 0..zip.len() {
            let mut member = match zip.by_index(i) {
                Ok(m) => m,
                Err(_) => {
                    table.skipped += 1;
                    continue;
                }
            };
            let name = member.name().to_string();
            if member.is_dir() || !valid_entry(&name) {
                continue;
            }
            if name.ends_with(".class") {
                if table.entries.len() >= MAX_ENTRIES {
                    table.skipped += 1;
                    continue;
                }
                table.entries.push(Entry {
                    name,
                    off: 0,
                    len: 0,
                    class: true,
                });
                continue;
            }
            if !text_entry(&name) {
                continue;
            }
            let size = member.size();
            feed(
                &mut table,
                &mut bytes,
                &name,
                bounded_read(&mut member, size),
            );
        }
    } else {
        for s in &source.stamps {
            if s.name.ends_with(".class") {
                if table.entries.len() >= MAX_ENTRIES {
                    table.skipped += 1;
                    continue;
                }
                table.entries.push(Entry {
                    name: s.name.clone(),
                    off: 0,
                    len: 0,
                    class: true,
                });
            } else {
                feed(
                    &mut table,
                    &mut bytes,
                    &s.name,
                    read_entry(&source.path, &s.name, false),
                );
            }
        }
    }
    crate::atomic_file::write_atomic(blob, &bytes)?;
    crate::atomic_file::write_atomic(
        meta,
        &serde_json::to_vec(&table).map_err(|e| e.to_string())?,
    )?;
    Ok(table)
}
pub(crate) fn build(sources: Vec<Source>, cache: &Path) -> Result<Catalog, String> {
    std::fs::create_dir_all(cache).map_err(|e| e.to_string())?;
    let mut out = Catalog {
        sources: Vec::new(),
        skipped: 0,
    };
    let mut total = 0;
    let mut names_memory = 0;
    for source in sources {
        let id = key(&source.path.to_string_lossy());
        let meta = cache.join(format!("{id}.json"));
        let blob = cache.join(format!("{id}.bin"));
        let table = read_table(&meta).ok().filter(|t| {
            t.stamps == source.stamps && blob.metadata().is_ok_and(|m| m.len() <= MAX_SOURCE as u64)
        });
        // 不在全局磁盘预算耗尽后继续解压尚未缓存的包。
        if table.is_none() && total + MAX_SOURCE as u64 > MAX_TOTAL {
            out.skipped += 1;
            continue;
        }
        let table = match table {
            Some(t) => t,
            None => match build_source(&source, &meta, &blob) {
                Ok(t) => t,
                Err(e) => {
                    log::warn!("库文件索引跳过 {}: {e}", source.path.display());
                    out.skipped += 1;
                    continue;
                }
            },
        };
        total += blob.metadata().map_or(0, |m| m.len());
        if total > MAX_TOTAL {
            out.skipped += table.entries.len();
            continue;
        }
        out.skipped += table.skipped;
        if !table.entries.is_empty() {
            let has_text = table.entries.iter().any(|e| !e.class);
            let size = table.entries.capacity() * std::mem::size_of::<Entry>()
                + table
                    .entries
                    .iter()
                    .map(|e| e.name.capacity())
                    .sum::<usize>();
            let names = if names_memory + size <= MAX_NAMES_MEMORY {
                names_memory += size;
                Some(table.entries)
            } else {
                None
            };
            out.sources.push(CachedSource {
                source,
                meta,
                blob,
                names,
                has_text,
            });
        }
    }
    Ok(out)
}

pub(crate) fn read_cached(
    cached: &CachedSource,
    names: bool,
) -> Result<Option<(Table, Vec<u8>)>, String> {
    // 目录与正文作为同一个快照读取，防后台更新时出现新目录配旧正文。
    let _io = CACHE_IO.lock().unwrap_or_else(|e| e.into_inner());
    let table = read_table(&cached.meta)?;
    if table.stamps != cached.source.stamps {
        return Ok(None);
    }
    if cached.blob.metadata().map_err(|e| e.to_string())?.len() > MAX_SOURCE as u64 {
        return Err("库文件正文缓存超限".into());
    }
    let blob = if names {
        vec![]
    } else {
        std::fs::read(&cached.blob).map_err(|e| e.to_string())?
    };
    Ok(Some((table, blob)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    #[test]
    fn 文件名目录复用内存_不读文本缓存() {
        let cached = CachedSource {
            source: Source {
                path: "not-opened.jar".into(),
                module: "pp".into(),
                stamps: vec![],
                archive: true,
            },
            meta: "absent.json".into(),
            blob: "absent.bin".into(),
            names: Some(
                (0..50_000)
                    .map(|i| Entry {
                        name: format!("nc/ui/Demo{i}.class"),
                        off: 0,
                        len: 0,
                        class: true,
                    })
                    .collect(),
            ),
            has_text: false,
        };
        let catalog = Catalog {
            sources: vec![cached],
            skipped: 0,
        };
        let options = crate::search::SearchOptions {
            text: "nc.ui.Demo49999".into(),
            max_results: 100,
            ..Default::default()
        };
        let out = crate::library_search::search(
            &catalog,
            &options,
            true,
            &std::sync::atomic::AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(out.items.len(), 1);
        assert_eq!(out.items[0].entry, "nc/ui/Demo49999.class");
        assert!(crate::library_search::search(
            &catalog,
            &options,
            false,
            &std::sync::atomic::AtomicBool::new(false)
        )
        .unwrap()
        .items
        .is_empty());
    }
    fn jar(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut z = zip::ZipWriter::new(File::create(path).unwrap());
        for (name, value) in [
            ("nc/Demo.java", text),
            ("config/a.xml", "<name>单据</name>"),
            ("messages.properties", "label=单据"),
        ] {
            z.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            z.write_all(value.as_bytes()).unwrap();
        }
        z.finish().unwrap();
    }
    #[test]
    fn hyext_jar与散类_文本纳入且缓存更新() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let root = temp.path().join("work");
        std::fs::create_dir_all(&root).unwrap();
        let p = home.join("modules/pp/hyext/lib/a.jar");
        jar(&p, "return billType;");
        let classes = home.join("modules/pp/hyext/classes/nc");
        std::fs::create_dir_all(&classes).unwrap();
        std::fs::write(classes.join("Demo.class"), b"class").unwrap();
        let cache = temp.path().join("cache");
        let a = build(discover(&home, &root), &cache).unwrap();
        assert_eq!(a.sources.len(), 2);
        assert!(a.sources.iter().all(|s| s.source.module == "pp"));
        assert!(a.sources.iter().any(|s| read_table(&s.meta)
            .unwrap()
            .entries
            .iter()
            .any(|e| e.class)));
        let first = read_entry(&p, "nc/Demo.java", true).unwrap();
        assert_eq!(first, b"return billType;");
        jar(&p, "return changedBillType;");
        let b = build(discover(&home, &root), &cache).unwrap();
        let source = b.sources.iter().find(|s| s.source.archive).unwrap();
        assert!(std::fs::read_to_string(&source.blob)
            .unwrap()
            .contains("changedBillType"));
        assert_eq!(read_table(&source.meta).unwrap().entries.len(), 3);
        // 后台更新之后旧目录快照不能拿到新正文。
        let old = a.sources.iter().find(|s| s.source.archive).unwrap();
        assert!(read_cached(old, false).unwrap().is_none());
    }
    #[test]
    fn 解压有界且拒绝越界路径和二进制() {
        assert!(bounded_read(&b"12345"[..], MAX_FILE + 1).is_err());
        for name in ["../a.xml", "/a.xml", "a/../b", "D:/a", "a\\b", "a//b"] {
            assert!(!valid_entry(name));
        }
        let mut table = Table {
            version: 1,
            stamps: vec![],
            entries: vec![],
            skipped: 0,
        };
        let mut bytes = vec![];
        feed(&mut table, &mut bytes, "a.xml", Ok(vec![0, 1]));
        assert_eq!(table.skipped, 1);
    }
}
