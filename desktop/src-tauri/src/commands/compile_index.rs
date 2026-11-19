//! 类索引缓存与编译闸：进程内复用 NC 类索引、首建串行化、编译互斥、预热。
//!
//! 从 `compile_cmds` 拆出（体量门禁）：命令层只管参数解析与事件，这里是
//! 「索引 / 闸门」的状态编排。对外路径不变——`compile_cmds` 原样再导出。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::nc_home;
use crate::nc_index::{classpath_jars, ClassIndex};
use crate::state::AppState;

/// 内存里的类索引与各模块上次用到的 jar，进程内复用，避免每次编译重扫 7000 个 jar。
struct Cached {
    nc_home: PathBuf,
    index: Arc<ClassIndex>,
    seeds: std::collections::HashMap<String, Vec<u32>>,
}

static CACHE: Mutex<Option<Cached>> = Mutex::new(None);

/// 首建索引的串行化闸门。
///
/// 不能靠 `CACHE` 锁本身串行：首次冷扫 10~100 秒，持着 CACHE 锁扫盘会让状态轮询、
/// 语言服务、任何读缓存的命令一起干等；更糟的是后到的编译**完全没有反馈**
/// （自己的 log 回调一次都不触发），用户看到的就是「点了编译什么都没发生」。
/// 现在构建期间 CACHE 锁是空着的，等待者排在这把独立的闸门上，并且先收到一行提示。
static INDEX_GATE: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 编译互斥闸：同进程只允许一轮编译。
///
/// 前端有个 `compiling` 标志，但那是前端——切页、双击、命令层面重入都绕得过去。
/// 两轮并发编译会同时往同一个 `<模块>/classes` 写产物，还会抢同一个参数文件。
static COMPILING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 「已经有人在后台建索引」的在飞标记。
///
/// 索引冷的时候每次保存都会走到 `compile_file` 的跳过分支；没有这个标记的话，
/// 连按十次保存就是十个 `spawn_blocking` 排在 `INDEX_GATE` 上干等同一件事。
static WARMING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 编译闸的 RAII 凭据（drop 即释放，异常路径也不会漏）。
pub(super) struct CompileSlot;

impl CompileSlot {
    pub(super) fn acquire() -> Option<Self> {
        COMPILING
            .compare_exchange(
                false,
                true,
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
            )
            .ok()
            .map(|_| CompileSlot)
    }
}

impl Drop for CompileSlot {
    fn drop(&mut self) {
        COMPILING.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// `lookup_index` 的命中结果：类索引 + 该模块上次用到的 jar 序号。
type IndexHit = (Arc<ClassIndex>, Vec<u32>);

/// 已有这个 home 的索引就取出来（短锁），没有则 `None`。
pub(super) fn lookup_index(nc_home: &Path, module: &str) -> Result<Option<IndexHit>, String> {
    let guard = CACHE.lock().map_err(|_| "内部状态异常".to_string())?;
    let Some(c) = guard.as_ref() else {
        return Ok(None);
    };
    if c.nc_home != nc_home {
        return Ok(None);
    }
    Ok(Some((
        c.index.clone(),
        c.seeds.get(module).cloned().unwrap_or_default(),
    )))
}

/// 取（或首次构建）类索引，并带出该模块上次编译用到的 jar；进程内复用。
/// 首次冷扫约 10~100 秒，之后读磁盘缓存不到 1 秒。编译与语言服务共用这一份。
pub(super) fn cached_index(
    nc_home: &Path,
    cache_path: &Path,
    module: &str,
    log: &(dyn Fn(&str) + Sync),
) -> Result<(Arc<ClassIndex>, Vec<u32>), String> {
    if let Some(hit) = lookup_index(nc_home, module)? {
        return Ok(hit);
    }
    // 先给一行反馈再排队：后到的调用者以前是彻底静默的
    log("类索引还没就绪，正在等待（首次建索引要 10~100 秒）…");
    let _gate = INDEX_GATE.lock().map_err(|_| "内部状态异常".to_string())?;
    // 双重检查：排队期间别人可能刚建完
    if let Some(hit) = lookup_index(nc_home, module)? {
        return Ok(hit);
    }
    log("正在建立 NC 类索引（首次较慢，之后会缓存）…");
    let progress = |done: usize, total: usize| {
        if total > 0 && (done.is_multiple_of(500) || done == total) {
            log(&format!("扫描 jar {done}/{total}"));
        }
    };
    let index =
        ClassIndex::load_or_build(classpath_jars(nc_home), Some(cache_path), Some(&progress));
    let mut guard = CACHE.lock().map_err(|_| "内部状态异常".to_string())?;
    *guard = Some(Cached {
        nc_home: nc_home.to_path_buf(),
        index: Arc::new(index),
        seeds: Default::default(),
    });
    let c = guard.as_ref().ok_or("内部状态异常")?;
    Ok((
        c.index.clone(),
        c.seeds.get(module).cloned().unwrap_or_default(),
    ))
}

/// 把一次编译最终用到的 jar 记回内存 seed：下一次同模块编译直接带上，少跑几轮「按报错补 jar」。
pub(super) fn cache_seed(module: &str, jars: Vec<u32>) {
    if jars.is_empty() {
        return;
    }
    if let Ok(mut guard) = CACHE.lock() {
        if let Some(c) = guard.as_mut() {
            c.seeds.insert(module.to_string(), jars);
        }
    }
}

/// 类索引是否已就绪（保存触发的自动编译据此决定「先跳过并预热」还是直接编）。
pub(super) fn index_ready(nc_home: &Path) -> bool {
    lookup_index(nc_home, "")
        .map(|hit| hit.is_some())
        .unwrap_or(false)
}

/// 后台建一次类索引；已有索引或已有任务在飞时直接返回。
pub(super) fn warm_index(nc_home: PathBuf, cache_path: PathBuf) {
    if index_ready(&nc_home) {
        return;
    }
    if WARMING.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _budget = crate::prewarm_budget::acquire();
        let _ = cached_index(&nc_home, &cache_path, "", &|_| {});
        WARMING.store(false, std::sync::atomic::Ordering::SeqCst);
    });
}

/// 清进程内类索引与 jar 指纹缓存。`build_reindex` 与换 NC home 后调用。
pub(crate) fn invalidate_index() {
    if let Ok(mut guard) = CACHE.lock() {
        *guard = None;
    }
    crate::build_state::invalidate_config_cache();
}

/// 打开工作区后预热类索引（P2：消掉「第一次保存遇到 index-cold」的空窗）。
pub fn spawn_prewarm(state: Arc<AppState>) {
    tauri::async_runtime::spawn(async move {
        let (enabled, home_cfg) = {
            let cfg = state.config.read().await;
            (cfg.prewarm_index, cfg.nc_home.clone())
        };
        if !enabled {
            return;
        }
        let Ok(home) = nc_home::resolve(home_cfg.as_deref()) else {
            return;
        };
        let nc_home = PathBuf::from(home.root);
        let cache = super::build_engine::index_cache_path(&state.config_dir, &nc_home);
        warm_index(nc_home, cache);
    });
}
