//! BMF 组件索引：扫描工作区 / 依赖工程 / NC home 的 `METADATA/**/*.bmf`。
//!
//! 读索引不碰文件内容之外的任何东西：**不写源文件、不连库**。缓存只落在
//! `{config_dir}/bmf_index.json`，按 `(size, mtime)` 复用上次的解析结果；
//! 文件一变就重新解析。
//!
//! 扫描策略：
//! - 只认名为 `METADATA` 的目录（NC 的约定），不递归 `src` / `classes` / `out`；
//! - 单线程顺序扫（本机有蓝屏/重负载约束，不并发拉满）；
//! - 解析失败的条目**保留在索引里**，带错误信息，交给问题列表——不能静默消失。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Instant, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::atomic_file;
use crate::bmf_model::BmfDoc;

/// 一个 BMF 文件的索引条目。字段都是扫描时就能拿到的摘要，不解包整份文档。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BmfEntry {
    pub path: String,
    pub module: String,
    /// 工作区 / 依赖 / NCHOME
    pub origin: String,
    pub name: String,
    pub display_name: String,
    pub namespace: String,
    pub version: i32,
    pub entity_count: usize,
    pub attr_count: usize,
    pub enum_count: usize,
    pub size: u64,
    pub mtime_ms: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BmfIndex {
    pub entries: Vec<BmfEntry>,
    pub roots: Vec<String>,
    pub warnings: Vec<String>,
    pub elapsed_ms: u128,
    /// 命中缓存的条目数；0 = 全新解析。
    pub cached: usize,
}

#[derive(Debug, Clone)]
pub struct RootSpec {
    pub origin: String,
    pub path: PathBuf,
}

#[derive(Debug, Serialize, Deserialize)]
struct CacheFile {
    v: u32,
    entries: Vec<BmfEntry>,
}

const CACHE_V: u32 = 1;
const CACHE_NAME: &str = "bmf_index.json";

/// 扫描一组根目录。`cache_dir` 传入 `{config_dir}`；为 `None` 时纯内存扫描。
/// `force` = 忽略已有缓存逐份重解析（外部工具改过文件、或怀疑 mtime 不可靠时用），
/// 扫完仍会写回新缓存。
pub fn scan(roots: &[RootSpec], cache_dir: Option<&Path>, force: bool) -> BmfIndex {
    let t0 = Instant::now();
    let mut warnings = Vec::new();
    let mut files: Vec<(PathBuf, String)> = Vec::new();
    for r in roots {
        if !r.path.is_dir() {
            warnings.push(format!("{} 不存在：{}", r.origin, r.path.display()));
            continue;
        }
        let before = files.len();
        let mut found = Vec::new();
        collect_bmfs(&r.path, 0, &mut found);
        for p in found {
            files.push((p, r.origin.clone()));
        }
        if files.len() == before {
            warnings.push(format!("{} 下没有找到 METADATA/*.bmf：{}", r.origin, r.path.display()));
        }
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));

    let mut cache: HashMap<String, BmfEntry> = HashMap::new();
    if !force {
        if let Some(dir) = cache_dir {
            if let Some(c) = load_cache(dir) {
                for e in c.entries {
                    cache.insert(e.path.clone(), e);
                }
            }
        }
    }

    let mut entries = Vec::with_capacity(files.len());
    let mut cached = 0;
    for (path, origin) in files {
        let meta = match std::fs::metadata(&path) {
            Ok(m) => m,
            Err(e) => {
                warnings.push(format!("{} 读取文件信息失败：{e}", path.display()));
                continue;
            }
        };
        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let key = path.to_string_lossy().to_string();
        if let Some(hit) = cache.get(&key) {
            if hit.size == meta.len() && hit.mtime_ms == mtime_ms {
                let mut hit = hit.clone();
                hit.origin = origin.clone();
                entries.push(hit);
                cached += 1;
                continue;
            }
        }
        entries.push(read_entry(&path, &origin, meta.len(), mtime_ms));
    }

    if let Some(dir) = cache_dir {
        let payload = CacheFile {
            v: CACHE_V,
            entries: entries.clone(),
        };
        if let Ok(json) = serde_json::to_vec(&payload) {
            let _ = atomic_file::write_atomic(&dir.join(CACHE_NAME), &json);
        }
    }

    BmfIndex {
        entries,
        roots: roots.iter().map(|r| r.path.to_string_lossy().to_string()).collect(),
        warnings,
        elapsed_ms: t0.elapsed().as_millis(),
        cached,
    }
}

fn read_entry(path: &Path, origin: &str, size: u64, mtime_ms: u64) -> BmfEntry {
    let module = module_of(path);
    match BmfDoc::open(path) {
        Ok(d) => BmfEntry {
            path: path.to_string_lossy().to_string(),
            module,
            origin: origin.to_string(),
            name: d.component.name,
            display_name: d.component.display_name,
            namespace: d.component.namespace,
            version: d.component.version,
            entity_count: d.entities.len(),
            attr_count: d.entities.iter().map(|e| e.attrs.len()).sum(),
            enum_count: d.enums.len(),
            size,
            mtime_ms,
            error: None,
        },
        Err(e) => BmfEntry {
            path: path.to_string_lossy().to_string(),
            module,
            origin: origin.to_string(),
            name: path
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default(),
            display_name: String::new(),
            namespace: String::new(),
            version: 0,
            entity_count: 0,
            attr_count: 0,
            enum_count: 0,
            size,
            mtime_ms,
            error: Some(e),
        },
    }
}

/// 从 `…/模块/METADATA/x.bmf` 取模块名。路径没有 METADATA 时退回上一级目录名。
fn module_of(path: &Path) -> String {
    let mut it = path.ancestors();
    let _ = it.next();
    let parent = it.next();
    if parent.map(|p| p.file_name().map(|n| n.eq_ignore_ascii_case("METADATA")).unwrap_or(false)) == Some(true)
    {
        return it
            .next()
            .and_then(|p| p.file_name())
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
    }
    parent
        .and_then(|p| p.file_name())
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn collect_bmfs(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > 4 {
        return;
    }
    let is_metadata = dir
        .file_name()
        .map(|n| n.eq_ignore_ascii_case("METADATA"))
        .unwrap_or(false);
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    for e in rd.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().to_lowercase();
        if p.is_dir() {
            if is_metadata {
                // METADATA 下可能还有子目录（历史工程），继续但限制深度
                collect_bmfs(&p, depth + 1, out);
                continue;
            }
            if matches!(
                name.as_str(),
                ".svn" | ".git" | ".settings" | "src" | "classes" | "out" | "lib" | "client"
            ) {
                continue;
            }
            // 有 METADATA 子目录就进；其它目录只在较浅层继续找
            if name == "metadata" || depth < 2 {
                collect_bmfs(&p, depth + 1, out);
            }
        } else if is_metadata && name.ends_with(".bmf") {
            out.push(p);
        }
    }
}

fn load_cache(dir: &Path) -> Option<CacheFile> {
    let raw = std::fs::read(dir.join(CACHE_NAME)).ok()?;
    let c: CacheFile = serde_json::from_slice(&raw).ok()?;
    (c.v == CACHE_V).then_some(c)
}

/// 列出某个根下索引口径内的全部 BMF。引用扫描（F1）复用它，保证「扫到的文件」
/// 与左栏清单是同一批，不会再写一套目录遍历规则。
pub fn list_bmfs(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    collect_bmfs(root, 0, &mut out);
    out.sort();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ncwb-bmf-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn write_bmf(root: &Path, module: &str, name: &str, body: &str) -> PathBuf {
        let dir = root.join(module).join("METADATA");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        std::fs::write(&p, body.as_bytes()).unwrap();
        p
    }

    #[test]
    fn scans_modules_and_skips_broken_entries_in_place() {
        let d = tmpdir("scan");
        write_bmf(
            &d,
            "uapbd",
            "a.bmf",
            r#"<component name="a" displayName="A" namespace="uapbd" version="2"><celllist><entity name="H"><attributelist><attribute name="pk"/></attributelist></entity><Enumerate name="e"/></celllist></component>"#,
        );
        write_bmf(&d, "baseapp", "broken.bmf", "<component><celllist>");
        write_bmf(&d, "baseapp", "empty.bmf", r#"<component name="empty"><celllist/></component>"#);
        let idx = scan(
            &[RootSpec {
                origin: "工作区".into(),
                path: d.clone(),
            }],
            None,
            false,
        );
        assert_eq!(idx.entries.len(), 3);
        assert_eq!(idx.warnings.len(), 0);
        let a = idx.entries.iter().find(|e| e.name == "a").unwrap();
        assert_eq!(a.entity_count, 1);
        assert_eq!(a.attr_count, 1);
        assert_eq!(a.enum_count, 1);
        assert_eq!(a.module, "uapbd");
        let broken = idx.entries.iter().find(|e| e.path.contains("broken")).unwrap();
        assert!(broken.error.is_some(), "解析失败要留在索引里并带原因");
        let empty = idx.entries.iter().find(|e| e.name == "empty").unwrap();
        assert_eq!(empty.entity_count, 0);
        assert_eq!(idx.roots.len(), 1);
    }

    #[test]
    fn second_scan_hits_cache_when_size_and_mtime_unchanged() {
        let d = tmpdir("cache");
        let root = d.join("root");
        write_bmf(
            &root,
            "m1",
            "x.bmf",
            r#"<component name="x"><celllist/></component>"#,
        );
        let cache = d.join("cache");
        std::fs::create_dir_all(&cache).unwrap();
        let roots = [RootSpec {
            origin: "工作区".into(),
            path: root.clone(),
        }];
        let a = scan(&roots, Some(&cache), false);
        assert_eq!(a.cached, 0);
        let b = scan(&roots, Some(&cache), false);
        assert_eq!(b.cached, 1);
        assert_eq!(b.entries.len(), 1);
        assert!(cache.join(CACHE_NAME).is_file());
        // force：即使 size/mtime 没变也要重解析，不能返回 0 命中的假象
        let c = scan(&roots, Some(&cache), true);
        assert_eq!(c.cached, 0);
        assert_eq!(c.entries.len(), 1);
    }

    #[test]
    fn cache_is_invalidated_when_file_changes() {
        let d = tmpdir("inval");
        let root = d.join("root");
        let p = write_bmf(&root, "m1", "x.bmf", r#"<component name="x"><celllist/></component>"#);
        let cache = d.join("cache");
        std::fs::create_dir_all(&cache).unwrap();
        let roots = [RootSpec {
            origin: "工作区".into(),
            path: root,
        }];
        let _ = scan(&roots, Some(&cache), false);
        // 改写内容并强制不同 mtime（同毫秒内改写时 mtime 可能相同）
        std::thread::sleep(std::time::Duration::from_millis(5));
        std::fs::write(
            &p,
            br#"<component name="y"><celllist><entity name="H"/></celllist></component>"#,
        )
        .unwrap();
        let b = scan(&roots, Some(&cache), false);
        assert_eq!(b.cached, 0);
        assert_eq!(b.entries[0].name, "y");
        assert_eq!(b.entries[0].entity_count, 1);
    }

    #[test]
    fn missing_root_is_a_warning_not_a_panic() {
        let d = tmpdir("missing");
        let idx = scan(
            &[RootSpec {
                origin: "依赖".into(),
                path: d.join("nope"),
            }],
            None,
            false,
        );
        assert!(idx.entries.is_empty());
        assert_eq!(idx.warnings.len(), 1);
        assert!(idx.warnings[0].contains("不存在"));
    }

    #[test]
    fn module_name_comes_from_metadata_parent() {
        assert_eq!(
            module_of(Path::new("C:/w/newar/uapbd/METADATA/sz02.bmf")),
            "uapbd"
        );
        assert_eq!(module_of(Path::new("C:/w/odd/x.bmf")), "odd");
    }
}
