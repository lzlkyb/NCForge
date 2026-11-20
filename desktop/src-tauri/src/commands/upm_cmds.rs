//! `META-INF/*.upm` 装配索引的命令层。
//!
//! 解析与诊断全在 `nc_upm.rs`（纯逻辑、可单测），这里只做三件事：
//! 取路径、给「类是否存在」的答案、缓存扫描结果。
//!
//! ## 类存在性为什么要分两档
//!
//! 判断「`<implementation>` 指的类没了」必须有完整的类搜索范围。这个范围由三部分组成：
//! 工程源码、NCHOME 散类目录、classpath 上的 jar。前两个扫一遍只要几十毫秒，
//! **jar 要走 `nc_index` 的类索引，首次冷扫 10~100 秒**（7000+ jar）。
//!
//! 所以分两档：
//! - 默认（`deep = false`）：只查源码与散类，查不到一律 `Unknown` —— **不报缺失**。
//!   `module-mismatch` 与 `duplicate-impl` 不依赖类存在性，这一档就能出。
//! - `deep = true`：加上 jar 索引，`Unknown` 变成确定的 `Missing`。
//!   需要的话由用户主动触发，进度经 `upm-log` 事件推给前端。
//!
//! 这不是保守，是避免误报：实测 NCHOME 的 345 个散类目录里 **0 个 class 文件**
//! （类全在 jar 里），只查源码就断言「类不存在」会给出成百条假警报。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::app_error::AppError;
use crate::nc_upm::{self, Presence, UpmEntry, UpmFile, UpmIndex, UpmIssue};
use crate::state::AppState;

/// 一次索引的统计。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpmStats {
    /// upm 文件数（工程 + NCHOME）。
    pub files: usize,
    pub project_files: usize,
    pub product_files: usize,
    /// 装配条目数。
    pub components: usize,
    /// 不同的接口数。
    pub interfaces: usize,
    /// 涉及模块数。
    pub modules: usize,
}

/// 索引结果。**不返回全量 entries**：产品侧上千个 upm、几千条装配，
/// 前端只需要统计 + 问题清单 + 按需查询。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpmReport {
    pub stats: UpmStats,
    pub issues: Vec<UpmIssue>,
    pub notes: Vec<String>,
    /// 类存在性是否做了完整判定。`false` = 缺 jar 索引，`missing-*` 这两类没有结论。
    pub class_check_complete: bool,
}

/// 命中的装配条目 + 命中方向。前端据此显示「这个接口的实现」还是「这个类被谁装配」。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpmHit {
    #[serde(flatten)]
    pub entry: UpmEntry,
    /// `interface` = 按接口名命中；`implementation` = 按实现类命中。
    pub matched_by: String,
}

/// 进程内缓存。扫描 1600 个 upm 是一次完整目录读，不能每次点都重来。
struct Cached {
    root: PathBuf,
    home: PathBuf,
    index: Arc<UpmIndex>,
}

static CACHE: Mutex<Option<Cached>> = Mutex::new(None);

/// 取（或重建）索引。`refresh` 由前端在保存 upm 后传，工作区/NCHOME 变了自动失效。
fn load_index(root: &Path, home: &Path, refresh: bool) -> Result<Arc<UpmIndex>, String> {
    // 快路径：命中缓存直接返回（持锁极短）。
    if !refresh {
        if let Ok(g) = CACHE.lock() {
            if let Some(c) = g.as_ref() {
                if c.root == root && c.home == home {
                    return Ok(c.index.clone());
                }
            }
        }
    }
    // 慢 IO（scan_project/scan_home 全量读解析）放锁外，别堵并发 lookup；
    // 扫完再拿锁双检：等待期间别人可能已建好同 root/home 的索引，直接复用。
    let project = nc_upm::scan_project(root);
    let product = nc_upm::scan_home(home);
    let index = Arc::new(nc_upm::build(project, product));
    let mut guard = CACHE.lock().map_err(|_| "内部状态异常".to_string())?;
    if !refresh {
        if let Some(c) = guard.as_ref() {
            if c.root == root && c.home == home {
                return Ok(c.index.clone());
            }
        }
    }
    *guard = Some(Cached {
        root: root.to_path_buf(),
        home: home.to_path_buf(),
        index: index.clone(),
    });
    Ok(index)
}

// ───────────────────────── 类名集缓存 ─────────────────────────
//
// collect_project_classes 要走一遍全部模块的 src 树；装配页每次打开 / 刷新都重扫
// 是纯浪费。TTL 兜底 + watcher 事件失效（.java 变了立刻作废），与库目录同一套路。

const CLASS_SET_TTL: Duration = Duration::from_secs(300);

type SetCache = Mutex<Option<(PathBuf, Instant, Arc<HashSet<String>>)>>;
static PROJECT_CLASSES: SetCache = Mutex::new(None);
static HOME_CLASSES: SetCache = Mutex::new(None);

/// 缓存是否仍可用（纯判据，便于单测反例）。
fn set_fresh(cached_key: &Path, want: &Path, age: Duration) -> bool {
    cached_key == want && age <= CLASS_SET_TTL
}

fn cached_class_set(
    cache: &SetCache,
    key: &Path,
    build: impl FnOnce() -> HashSet<String>,
) -> Arc<HashSet<String>> {
    if let Ok(g) = cache.lock() {
        if let Some((k, at, set)) = g.as_ref() {
            if set_fresh(k, key, at.elapsed()) {
                return set.clone();
            }
        }
    }
    let set = Arc::new(build());
    if let Ok(mut g) = cache.lock() {
        *g = Some((key.to_path_buf(), Instant::now(), set.clone()));
    }
    set
}

/// watcher 看到 `.java` 变化、换 NC home / 重建类索引时调用：类名集立刻作废。
pub fn invalidate_upm_classes() {
    if let Ok(mut g) = PROJECT_CLASSES.lock() {
        *g = None;
    }
    if let Ok(mut g) = HOME_CLASSES.lock() {
        *g = None;
    }
}

/// 构造「类是否存在」的判定函数，返回 (函数, 是否完整)。
fn class_presence(
    root: &Path,
    home: &Path,
    deep: bool,
    index: Option<Arc<crate::nc_index::ClassIndex>>,
) -> (impl Fn(&str) -> Presence, bool) {
    let sources = cached_class_set(&PROJECT_CLASSES, root, || {
        nc_upm::collect_project_classes(root)
    });
    let home_classes = if deep {
        cached_class_set(&HOME_CLASSES, home, || nc_upm::collect_home_classes(home))
    } else {
        Arc::new(HashSet::new())
    };
    let jars = index;
    let complete = jars.is_some();
    let f = move |cls: &str| -> Presence {
        let cls = cls.trim();
        if cls.is_empty() {
            return Presence::Unknown;
        }
        // upm 里写的是外部类；源码/散类里按同名的编译单元找
        let base = cls.split('$').next().unwrap_or(cls);
        if sources.contains(base) {
            return Presence::Found("工程源码".to_string());
        }
        if home_classes.contains(base) {
            return Presence::Found("NCHOME 散类".to_string());
        }
        match &jars {
            Some(idx) => match idx.jar_for_class(base) {
                Some(i) => Presence::Found(format!(
                    "jar: {}",
                    idx.jars
                        .get(i as usize)
                        .map(|p| {
                            p.file_name()
                                .map(|n| n.to_string_lossy().to_string())
                                .unwrap_or_else(|| p.display().to_string())
                        })
                        .unwrap_or_default()
                )),
                // 到这里才算「查全了」：源码、散类、jar 都没有
                None => Presence::Missing,
            },
            None => Presence::Unknown,
        }
    };
    (f, complete)
}

fn stats_of(index: &UpmIndex) -> UpmStats {
    // 去重计数用 HashSet（小写归一）：旧版 Vec+线性 any 是 O(entries×unique)，数千×数千≈千万次比较。
    let mut interfaces: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut modules: std::collections::HashSet<String> = std::collections::HashSet::new();
    for e in &index.entries {
        interfaces.insert(e.interface.to_ascii_lowercase());
        modules.insert(e.module.to_ascii_lowercase());
    }
    UpmStats {
        files: index.files.len(),
        project_files: index
            .files
            .iter()
            .filter(|f| f.origin == nc_upm::UpmOrigin::Project)
            .count(),
        product_files: index
            .files
            .iter()
            .filter(|f| f.origin == nc_upm::UpmOrigin::Product)
            .count(),
        components: index.entries.len(),
        interfaces: interfaces.len(),
        modules: modules.len(),
    }
}

/// 装配索引 + 诊断。`deep = true` 时才会去建/用 jar 类索引（首次慢）。
#[tauri::command]
pub async fn nc_upm_index(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    root: Option<String>,
    deep: Option<bool>,
    refresh: Option<bool>,
) -> Result<UpmReport, String> {
    let dir = super::nc_manifest_cmds::resolve_root(state.inner(), root).await?;
    let home = crate::nc_home::resolve(state.config.read().await.nc_home.as_deref())
        .map(|h| PathBuf::from(h.root))?;
    let deep = deep.unwrap_or(false);
    let refresh = refresh.unwrap_or(false);
    let cache_path = state.config_dir.join("class-index.bin");

    tauri::async_runtime::spawn_blocking(move || {
        let index = load_index(&dir, &home, refresh)?;
        let jar_index = if deep {
            let log = |s: &str| {
                use tauri::Emitter;
                let _ = app.emit("upm-log", s.to_string());
            };
            Some(
                super::compile_cmds::cached_index(&home, &cache_path, "", &log)
                    .map(|(i, _)| i)
                    .map_err(|e| format!("类索引不可用：{e}"))?,
            )
        } else {
            None
        };
        let (presence, complete) = class_presence(&dir, &home, deep, jar_index);
        let issues = nc_upm::diagnose(&index, &presence);
        Ok(UpmReport {
            stats: stats_of(&index),
            issues,
            notes: index.notes.clone(),
            class_check_complete: complete,
        })
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 按类名查装配：接口名查「它的实现」，实现类名查「谁装配了它」。
///
/// 复用 `nc_upm_index` 建好的缓存；两条命令之间不重复扫目录。
#[tauri::command]
pub async fn nc_upm_lookup(
    state: tauri::State<'_, Arc<AppState>>,
    query: String,
    root: Option<String>,
) -> Result<Vec<UpmHit>, String> {
    let dir = super::nc_manifest_cmds::resolve_root(state.inner(), root).await?;
    let home = crate::nc_home::resolve(state.config.read().await.nc_home.as_deref())
        .map(|h| PathBuf::from(h.root))?;
    tauri::async_runtime::spawn_blocking(move || {
        let index = load_index(&dir, &home, false)?;
        let mut out: Vec<UpmHit> = Vec::new();
        let q = query.trim().to_string();
        if q.is_empty() {
            return Ok(out);
        }
        for e in index.lookup(&q) {
            out.push(UpmHit {
                entry: e.clone(),
                matched_by: "interface".to_string(),
            });
        }
        for e in index.by_implementation(&q) {
            // 接口名与实现类名相同的情况（少见）不重复报
            if out.iter().any(|h| h.entry == *e) {
                continue;
            }
            out.push(UpmHit {
                entry: e.clone(),
                matched_by: "implementation".to_string(),
            });
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 单个 upm 文件的装配清单（代码页大纲用）。
///
/// `text` 传编辑器当前内容（含未保存修改）；不传则读磁盘。解析复用 `nc_upm::parse`，
/// 与装配索引同一套口径。不查类存在性、不走缓存——单文件解析是微秒级，
/// 大纲每次编辑都要重算，引缓存反而带来失效问题。
#[tauri::command]
pub async fn nc_upm_file(path: String, text: Option<String>) -> Result<UpmFile, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        match text {
            Some(t) => Ok(nc_upm::from_text(&p, &t)),
            None => nc_upm::read_file(&p).map_err(|e| AppError::env("upm.readFailed", e)),
        }
    })
    .await
    .map_err(|e| AppError::internal("upm.taskFailed", format!("后台任务失败: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 类名集缓存判据_键不同或超龄都作废() {
        let a = PathBuf::from("C:/work/a");
        let b = PathBuf::from("C:/work/b");
        assert!(set_fresh(&a, &a, Duration::ZERO));
        assert!(set_fresh(&a, &a, CLASS_SET_TTL));
        // 反例：换了工程根
        assert!(!set_fresh(&a, &b, Duration::ZERO));
        // 反例：超过兜底 TTL（watcher 看不见的外部变化靠它）
        assert!(!set_fresh(&a, &a, CLASS_SET_TTL + Duration::from_secs(1)));
    }

    #[test]
    fn 命中缓存不再调构建_失效后重建() {
        let cache: SetCache = Mutex::new(None);
        let key = PathBuf::from("C:/work/cached-set-test");
        let mut calls = 0;
        let first = cached_class_set(&cache, &key, || {
            calls += 1;
            HashSet::from(["p.A".to_string()])
        });
        let second = cached_class_set(&cache, &key, || {
            calls += 1;
            HashSet::new()
        });
        assert_eq!(calls, 1);
        assert!(Arc::ptr_eq(&first, &second));
        // 失效后必须重建（反例守卫：失效不是空操作）
        *cache.lock().unwrap() = None;
        let third = cached_class_set(&cache, &key, || {
            calls += 1;
            HashSet::from(["p.B".to_string()])
        });
        assert_eq!(calls, 2);
        assert!(third.contains("p.B"));
    }
}
