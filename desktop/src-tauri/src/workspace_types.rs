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
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::build_layout::{self, ModuleLayout};
use crate::eclipse_cp::ProjectCp;

/// 缓存版式：字段变了就加一，旧缓存自然失效。
const CACHE_VERSION: u32 = 1;
/// 一份缓存的上限。正常工程是几 MB；坏文件不能换来无界分配。
const CACHE_CAP: u64 = 64 * 1024 * 1024;
/// 单文件上限：源码不该有这么大，超了多半不是源码。
const MAX_SOURCE: u64 = 4 * 1024 * 1024;
/// 进程内结果的有效期。5 秒足够覆盖一次连续输入，又能在保存后很快看到新类。
const TTL: Duration = Duration::from_secs(5);

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
}

#[derive(Debug)]
pub struct WorkspaceTypes {
    entries: Vec<IndexedType>,
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
                crate::java_types::type_match_score(query, &e.hit.simple).map(|s| (s, e))
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
}

struct Shared {
    key: String,
    index: Arc<WorkspaceTypes>,
}

static SHARED: Mutex<Option<Shared>> = Mutex::new(None);
/// 建索引的闸门：同一时刻只有一份在扫盘，后来的等它建完直接用。
static BUILD: Mutex<()> = Mutex::new(());

/// 取（必要时重建）工作区索引。TTL 内直接复用进程内那份。
pub fn shared(root: &Path, cache_dir: &Path) -> Arc<WorkspaceTypes> {
    let key = norm(root);
    let fresh = || {
        let guard = SHARED.lock().unwrap_or_else(|e| e.into_inner());
        guard.as_ref().and_then(|s| {
            (s.key == key && s.index.built_at.elapsed() < TTL).then(|| s.index.clone())
        })
    };
    if let Some(index) = fresh() {
        return index;
    }
    let _gate = BUILD.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(index) = fresh() {
        return index;
    }
    let index = Arc::new(build(root, cache_dir));
    *SHARED.lock().unwrap_or_else(|e| e.into_inner()) = Some(Shared {
        key,
        index: index.clone(),
    });
    index
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
    size: u64,
    modified: u128,
    package: String,
    types: Vec<CachedType>,
}

#[derive(Serialize, Deserialize, Clone)]
struct CachedType {
    name: String,
    /// LSP SymbolKind
    kind: u8,
    line: u32,
    column: u32,
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
    let mut entries: Vec<IndexedType> = Vec::new();
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
                parse_file(&file, &key, md.len(), modified)
            }
        };
        let file_text = file.to_string_lossy().to_string();
        for t in &entry.types {
            entries.push(IndexedType {
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
        saved.push(entry);
    }
    if changed || !cached.is_empty() {
        write_cache(&cache_path, root, &saved);
    }
    WorkspaceTypes {
        entries,
        built_at: Instant::now(),
    }
}

fn parse_file(path: &Path, key: &str, size: u64, modified: u128) -> CachedFile {
    let empty = || CachedFile {
        path: key.to_string(),
        size,
        modified,
        package: String::new(),
        types: Vec::new(),
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
    CachedFile {
        path: key.to_string(),
        size,
        modified,
        package,
        types,
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
