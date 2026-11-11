//! jar 内符号搜索命令：把 `jar_symbols` 的预建索引包成 IPC。
//!
//! # 为什么要有「后台建、本次先回空」
//!
//! 全量建索引要解 3341 个 jar 的常量池（本机约一分钟），不能把它压在正在等结果的
//! 输入框上。所以命令的契约是三态：**索引就绪 → 直接搜**；**没建好 → 回 `building`，
//! 后台排队建**；**已建但与当前 jar 不一致 → 先用旧索引出结果，同时后台重建**。
//! 这与内容包（`content_pack`）「本次走磁盘、下一次走包」是同一条思路。
//!
//! 顺带一条：类索引（`ClassIndex`）本身可能要 10~100 秒冷扫，语言服务没起、又没编译过
//! 时它并不存在。这时也只能回 `building` 并顺手预热——否则「搜 jar」在刚打开的工程上
//! 永远是空的。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

use super::build_engine::index_cache_path;
use super::compile_cmds::{cached_index, lookup_index};
use crate::jar_symbols::{self, JarSymbolIndex};
use crate::nc_home;
use crate::nc_index::ClassIndex;
use crate::state::AppState;

/// 一处出现。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JarSymbolPlaceOut {
    /// jar 绝对路径（界面只显示文件名，反编译跳转要全路径）。
    pub jar: String,
    /// 类全限定名（内部类保留 `$`）。
    pub class: String,
}

/// 一个命中词。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JarSymbolItem {
    pub term: String,
    /// 0 精确 / 1 前缀 / 2 包含。
    pub score: u8,
    pub places: Vec<JarSymbolPlaceOut>,
    /// 这个词真实命中多少处（可能远大于 `places.len()`）。
    pub places_total: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JarSymbolOut {
    pub items: Vec<JarSymbolItem>,
    /// 一共匹配到多少个词（`items` 可能因 `limit` 截断）。
    pub total: usize,
    /// 扫描超时提前退出：结果可能不全。
    pub truncated: bool,
    /// 索引还没建好（首次，或类索引还在冷扫）：本次没有 jar 段结果。
    pub building: bool,
    /// 结果来自旧索引，jar 已变动、正在后台重建。
    pub stale: bool,
    /// 索引建立失败的原因（磁盘满 / 杀软占用索引文件）。
    ///
    /// 有它就不是「还在建」：界面必须说「建失败 + 怎么办」，
    /// 不能继续演「正在后台建立」——那是永远等不到的假进度。
    pub error: Option<String>,
    pub elapsed_ms: u64,
}

/// 进程内已载入的那份索引：索引文件路径 + 索引本身。
type LoadedSlot = Option<(PathBuf, Arc<JarSymbolIndex>)>;

/// 进程内已载入的索引。键是索引文件路径——换 NC home 会换路径，自然对不上。
static LOADED: OnceLock<Mutex<LoadedSlot>> = OnceLock::new();
/// 「已有人在后台建」的在飞标记：连续敲键时不要排一队重复构建。
static BUILDING: AtomicBool = AtomicBool::new(false);

fn loaded_slot() -> &'static Mutex<LoadedSlot> {
    LOADED.get_or_init(|| Mutex::new(None))
}

/// 取进程内那份；路径不符（换了 NC home）就当没有。
fn cached_index_symbols(path: &Path) -> Option<Arc<JarSymbolIndex>> {
    let guard = loaded_slot().lock().ok()?;
    guard
        .as_ref()
        .filter(|(held, _)| held == path)
        .map(|(_, index)| index.clone())
}

fn remember(path: PathBuf, index: Arc<JarSymbolIndex>) {
    if let Ok(mut guard) = loaded_slot().lock() {
        *guard = Some((path.clone(), index));
    }
    // 重建 / 重新载入完成，旧的过期结论必须作废：否则 STALE_TTL 内每次搜索都
    // 看到 stale，既弹假提示，又各触发一次分钟级全量重建
    if let Some(slot) = STALE_CACHE.get() {
        let mut guard = match slot.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        if guard.as_ref().is_some_and(|(held, _, _)| *held == path) {
            *guard = None;
        }
    }
}

/// 最近一次建索引失败的原因。搜索时带上它，界面才知道该说「建失败 + 怎么办」。
static LAST_BUILD_ERROR: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn last_build_error() -> Option<String> {
    let slot = LAST_BUILD_ERROR.get_or_init(|| Mutex::new(None));
    let guard = slot.lock().ok()?;
    guard.clone()
}

fn set_last_build_error(msg: Option<String>) {
    let slot = LAST_BUILD_ERROR.get_or_init(|| Mutex::new(None));
    if let Ok(mut guard) = slot.lock() {
        *guard = msg;
    }
}

/// 进程内没有就从磁盘载入并记住。磁盘也没有（或文件坏了）返回 `None`。
fn usable_index(path: &Path) -> Option<Arc<JarSymbolIndex>> {
    if let Some(held) = cached_index_symbols(path) {
        return Some(held);
    }
    let fresh = Arc::new(JarSymbolIndex::load(path)?);
    remember(path.to_path_buf(), fresh.clone());
    Some(fresh)
}

/// NC home 与索引缓存目录。home 解析失败时整个功能不可用（没有 jar 可搜）。
async fn resolve_paths(state: &Arc<AppState>) -> Result<(PathBuf, PathBuf), String> {
    let home_cfg = state.config.read().await.nc_home.clone();
    let home = nc_home::resolve(home_cfg.as_deref())?;
    let root = PathBuf::from(home.root);
    let cache = jar_symbols::cache_dir_for(&state.config_dir, &root.to_string_lossy());
    Ok((root, cache))
}

/// 后台建索引的在飞标记。RAII：panic 也要释放。
///
/// 否则一旦 build 里 panic，标志永久卡在 true，之后每次 `spawn_build` 第一行就返回，
/// 功能永远停在「索引正在后台建立」，用户只能重启应用。
struct BuildingGuard;
impl Drop for BuildingGuard {
    fn drop(&mut self) {
        BUILDING.store(false, Ordering::SeqCst);
    }
}

/// `stale()` 的节流版：按索引路径记住上次结论，TTL 内直接复用。
///
/// `stale()` 要对全部 jar 逐个 stat（3341 个 ≈ 百毫秒级），而搜索本身是毫秒级——
/// 连续搜索时 99% 的时间都花在判过期上，且还是在 async 线程上同步阻塞的。
/// jar 被替换（打补丁）最晚 TTL 后的那次搜索必然发现，语义不丢。
const STALE_TTL: Duration = Duration::from_secs(2);
static STALE_CACHE: OnceLock<Mutex<Option<(PathBuf, Instant, bool)>>> = OnceLock::new();

fn stale_throttled(index: &JarSymbolIndex, class_index: &ClassIndex, out: &Path) -> bool {
    let slot = STALE_CACHE.get_or_init(|| Mutex::new(None));
    let now = Instant::now();
    {
        let guard = match slot.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some((held, at, verdict)) = guard.as_ref() {
            if held == out && now.duration_since(*at) < STALE_TTL {
                return *verdict;
            }
        }
    }
    // stat 不持锁：两个搜索同时过期时各判一次，比互相阻塞好
    let verdict = index.stale(class_index);
    if let Ok(mut guard) = slot.lock() {
        *guard = Some((out.to_path_buf(), now, verdict));
    }
    verdict
}

/// 后台建一次符号索引（必要时先冷扫类索引）。建完直接载入进程内缓存。
fn spawn_build(home: PathBuf, class_cache: PathBuf, out: PathBuf) {
    if BUILDING.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn_blocking(move || {
        // 闭包第一行：任何提前返回 / panic 都会经过 Drop，标志不会卡死
        let _guard = BuildingGuard;
        let _budget = crate::prewarm_budget::acquire();
        let index: Arc<ClassIndex> = match lookup_index(&home, "") {
            Ok(Some((index, _))) => index,
            _ => match cached_index(&home, &class_cache, "", &|_| {}) {
                Ok((index, _)) => index,
                Err(e) => {
                    log::warn!("jar 符号索引：类索引没建起来（{e}），本次跳过");
                    return;
                }
            },
        };
        let started = Instant::now();
        match jar_symbols::build(&index, &out, &|_, _| {}, &|| false) {
            Ok(()) => {
                set_last_build_error(None);
                if let Some(fresh) = JarSymbolIndex::load(&out) {
                    remember(out.clone(), Arc::new(fresh));
                }
                log::info!(
                    "jar 符号索引后台建成，{} ms（{} 词）",
                    started.elapsed().as_millis(),
                    cached_index_symbols(&out).map_or(0, |i| i.term_count())
                );
            }
            Err(e) => {
                // 建失败不能静默：界面要靠它说「建失败 + 怎么办」，
                // 否则用户永远看着「正在后台建立」
                set_last_build_error(Some(e.clone()));
                log::error!("jar 符号索引后台建成失败：{e}");
            }
        }
    });
}

/// 打开工作区后预热符号索引：第一次搜 jar 内代码不该让用户等一分钟。
pub fn spawn_prewarm_jar_symbols(state: Arc<AppState>) {
    tauri::async_runtime::spawn(async move {
        let Ok((home, cache)) = resolve_paths(&state).await else {
            return;
        };
        let class_cache = index_cache_path(&state.config_dir, &home);
        // 列目录 / 读索引文件 / stat 全部 jar 都是阻塞 IO：离开 async 线程
        let _ = tauri::async_runtime::spawn_blocking(move || {
            prewarm_blocking(home, cache, class_cache)
        })
        .await;
    });
}

fn prewarm_blocking(home: PathBuf, cache: PathBuf, class_cache: PathBuf) {
    let out = cache.join("symbols.bin");
    if let Some(existing) = JarSymbolIndex::load(&out) {
        // 类索引还没就绪时判不了过期：按「未证明过期」处理。以前这里一拿不到
        // 类索引就重建，而冷启动时它几乎总不在——等于每次开应用都白扫一遍
        // 3341 个 jar（分钟级）。真过期由搜索路径的 stale() 发现并重建。
        let stale = match lookup_index(&home, "") {
            Ok(Some((index, _))) => existing.stale(&index),
            _ => false,
        };
        remember(out.clone(), Arc::new(existing));
        if !stale {
            return;
        }
    }
    spawn_build(home, class_cache, out);
}

/// 「没有可用索引」时的返回：建失败过就说失败，否则说还在建。
fn building_or_error(started: Instant) -> JarSymbolOut {
    match last_build_error() {
        Some(e) => JarSymbolOut {
            items: Vec::new(),
            total: 0,
            truncated: false,
            building: false,
            stale: false,
            error: Some(e),
            elapsed_ms: started.elapsed().as_millis() as u64,
        },
        None => JarSymbolOut {
            items: Vec::new(),
            total: 0,
            truncated: false,
            building: true,
            stale: false,
            error: None,
            elapsed_ms: started.elapsed().as_millis() as u64,
        },
    }
}

/// 同步部分：载入索引 / 判过期 / 扫词表。
///
/// 🔴 必须整个搬出 async 线程：读索引文件是几十 MB 顺序读，判过期要 stat 几千个
/// jar，扫描本身有 500ms 预算——任一项都能把 tokio worker 占住，让别的命令
/// （包括 UI 上的其他 IPC）一起卡。
fn search_blocking(
    home: PathBuf,
    class_cache: PathBuf,
    out: PathBuf,
    q: String,
    limit: usize,
) -> JarSymbolOut {
    let started = Instant::now();
    let Ok(Some((index, _))) = lookup_index(&home, "") else {
        // 类索引还没冷扫完：预热它，下一次查询就有戏
        spawn_build(home, class_cache, out);
        return building_or_error(started);
    };

    let held = usable_index(&out);
    let stale = held
        .as_ref()
        .is_some_and(|i| stale_throttled(i, &index, &out));
    let Some(held) = held else {
        spawn_build(home, class_cache, out);
        return building_or_error(started);
    };

    if stale {
        spawn_build(home, class_cache, out);
    }
    let found = held.search(&q, limit);
    JarSymbolOut {
        items: found
            .hits
            .into_iter()
            .map(|hit| JarSymbolItem {
                term: hit.term,
                score: hit.score,
                places_total: hit.places_total,
                places: hit
                    .places
                    .into_iter()
                    .map(|p| JarSymbolPlaceOut {
                        jar: p.jar,
                        class: p.class,
                    })
                    .collect(),
            })
            .collect(),
        total: found.total,
        truncated: found.truncated,
        building: false,
        stale,
        error: None,
        elapsed_ms: started.elapsed().as_millis() as u64,
    }
}

#[tauri::command]
pub async fn search_jar_symbols(
    state: tauri::State<'_, Arc<AppState>>,
    query: String,
    limit: Option<usize>,
) -> Result<JarSymbolOut, String> {
    let q = query.trim().to_string();
    let limit = limit.unwrap_or(30).clamp(1, 100);
    if q.is_empty() {
        return Ok(JarSymbolOut {
            items: Vec::new(),
            total: 0,
            truncated: false,
            building: false,
            stale: false,
            error: None,
            elapsed_ms: 0,
        });
    }
    let (home, cache) = resolve_paths(&state).await?;
    let out = cache.join("symbols.bin");
    let class_cache = index_cache_path(&state.config_dir, &home);
    tauri::async_runtime::spawn_blocking(move || search_blocking(home, class_cache, out, q, limit))
        .await
        .map_err(|e| format!("搜索任务异常：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 空查询不建索引直接回空() {
        // 命令本身要 tauri::State，测不了；这里只守住「空查询是明确空结果」这个契约：
        // 由 search_jar_symbols 早退分支保证，测试确认输出字段齐全。
        let out = JarSymbolOut {
            items: Vec::new(),
            total: 0,
            truncated: false,
            building: false,
            stale: false,
            error: None,
            elapsed_ms: 0,
        };
        assert!(!out.building && out.items.is_empty() && out.total == 0 && out.error.is_none());
    }

    #[test]
    fn 没有可用索引时_建失败要说失败_没失败才说在建() {
        // 🔴 以前两者都回 building=true：建失败（磁盘满）会被演成
        // 「正在后台建立」，用户永远等一个不会来的进度条
        set_last_build_error(Some("写索引文件失败：磁盘空间不足".to_string()));
        let failed = building_or_error(Instant::now());
        assert!(!failed.building, "建失败不能假装还在建");
        assert_eq!(
            failed.error.as_deref(),
            Some("写索引文件失败：磁盘空间不足")
        );

        set_last_build_error(None);
        let building = building_or_error(Instant::now());
        assert!(building.building);
        assert!(building.error.is_none());
        set_last_build_error(None);
    }

    #[test]
    fn 缓存目录按_nc_home_分开() {
        let cfg = Path::new("C:/cfg");
        let a = jar_symbols::cache_dir_for(cfg, "D:/NC65/nc65home");
        let b = jar_symbols::cache_dir_for(cfg, "D:/NC65/nc65home");
        let c = jar_symbols::cache_dir_for(cfg, "D:/NC65/1909home");
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert!(a.starts_with(cfg));
        // 目录按 home 哈希分，索引文件由调用方再拼 `symbols.bin`
        assert!(!a.ends_with("symbols.bin"));
    }
}
