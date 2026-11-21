//! 库文件索引单飞后台建立；搜索与读取只接受当前 NC/工程根内的来源。
use crate::library_index::{self, Catalog};
use crate::library_search::LibraryOutcome;
use crate::search::{SearchGate, SearchOptions};
use crate::state::AppState;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

struct Slot {
    key: String,
    catalog: Option<Arc<Catalog>>,
    building: bool,
    checked: Instant,
    error: Option<String>,
    generation: u64,
    /// 上一次建包失败的时刻。失败后 30s 内不再重试。
    failed_at: Option<Instant>,
    /// watcher / 换 NC home 置脏：下次搜索立刻重建（旧目录仍先返回，SWR）。
    dirty: bool,
}

/// 建包失败后的退避窗口。
///
/// 🔴 为什么需要：`snapshot` 每次搜索都会调，`launch` 只看 `!building && catalog.is_none()`。
/// NC home 不可读 / 磁盘满这类**稳定失败**下，每敲一个字就重新扫一遍盘 —— 单飞 + 全局锁
/// 压住了并发，但 IO 是白烧的。退避 30s 内不重试，用户改好环境后半分钟内自愈。
const RETRY_BACKOFF: Duration = Duration::from_secs(30);

/// 兜底 TTL：watcher 只看工作区，NC home 侧的 jar 增删它看不见。
/// 事件驱动（`invalidate_library`）负责工作区内的即时失效；这个长窗口兜住
/// 工作区外的变化。以前是 30s 无条件重扫——空闲时搜索也在白烧 IO。
const LIBRARY_TTL: Duration = Duration::from_secs(300);

/// 目录是否过期。抽成纯函数便于单测判据（脏标记优先于 TTL）。
fn catalog_stale(has_catalog: bool, dirty: bool, age: Duration) -> bool {
    has_catalog && (dirty || age > LIBRARY_TTL)
}

/// watcher 发现库来源（jar/class/文本条目/.classpath）变化、或换 NC home /
/// 重建类索引时调用：只置标志，真正的重建推迟到下一次搜索（单飞线程里做）。
pub fn invalidate_library() {
    let mut slot = SLOT.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(s) = slot.as_mut() {
        s.dirty = true;
    }
}

/// 是否该发起建包。抽成纯函数是为了能脱库单测退避判据。
fn should_launch(
    building: bool,
    has_catalog: bool,
    stale: bool,
    failed_at: Option<Instant>,
) -> bool {
    if building || (has_catalog && !stale) {
        return false;
    }
    match failed_at {
        Some(at) => at.elapsed() >= RETRY_BACKOFF,
        None => true,
    }
}
static SLOT: Mutex<Option<Slot>> = Mutex::new(None);
static GENERATION: AtomicU64 = AtomicU64::new(0);
fn gate() -> &'static SearchGate {
    static GATE: OnceLock<SearchGate> = OnceLock::new();
    GATE.get_or_init(|| SearchGate::new(1))
}

async fn paths(state: &Arc<AppState>) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let config = state.config.read().await;
    let root = config.workspace_root.clone().ok_or("尚未打开工程")?;
    let home = crate::nc_home::resolve(config.nc_home.as_deref())
        .map(|h| PathBuf::from(h.root))
        .unwrap_or_else(|_| state.config_dir.join("no-nc-home"));
    let cache = state
        .config_dir
        .join("library-files")
        .join(library_index::key(&format!("{}|{root}", home.display())));
    Ok((home, PathBuf::from(root), cache))
}
fn snapshot(
    home: PathBuf,
    root: PathBuf,
    cache: PathBuf,
) -> (Option<Arc<Catalog>>, bool, bool, Option<String>) {
    let key = cache.to_string_lossy().into_owned();
    let (catalog, building, stale, error, launch, generation) = {
        let mut slot = SLOT.lock().unwrap_or_else(|e| e.into_inner());
        if slot.as_ref().is_none_or(|s| s.key != key) {
            *slot = Some(Slot {
                key: key.clone(),
                catalog: None,
                building: false,
                checked: Instant::now(),
                error: None,
                generation: 0,
                failed_at: None,
                dirty: false,
            });
        }
        let s = slot.as_mut().unwrap();
        let stale = catalog_stale(s.catalog.is_some(), s.dirty, s.checked.elapsed());
        let launch = should_launch(s.building, s.catalog.is_some(), stale, s.failed_at);
        if launch {
            s.building = true;
            s.checked = Instant::now();
            s.generation = GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
        }
        (
            s.catalog.clone(),
            s.building,
            stale,
            s.error.clone(),
            launch,
            s.generation,
        )
    };
    if launch {
        std::thread::spawn(move || {
            let result = std::panic::catch_unwind(|| {
                let _budget = crate::prewarm_budget::acquire();
                // 排队期间换过工作区，旧任务不再扫盘；A→B→A 也按代次区分。
                if SLOT
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .as_ref()
                    .is_none_or(|s| s.key != key || s.generation != generation)
                {
                    return Err("库文件目录请求已过期".into());
                }
                library_index::build(library_index::discover(&home, &root), &cache).map(Arc::new)
            })
            .unwrap_or_else(|_| Err("库文件索引建立异常，请重试".into()));
            let mut slot = SLOT.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(s) = slot
                .as_mut()
                .filter(|s| s.key == key && s.generation == generation)
            {
                s.building = false;
                s.checked = Instant::now();
                match result {
                    Ok(c) => {
                        s.catalog = Some(c);
                        s.error = None;
                        s.failed_at = None;
                        s.dirty = false;
                    }
                    Err(e) => {
                        s.error = Some(e);
                        s.failed_at = Some(Instant::now());
                    }
                }
            }
        });
    }
    (catalog, building, stale, error)
}
pub fn spawn_prewarm_library(state: Arc<AppState>) {
    tauri::async_runtime::spawn(async move {
        if let Ok((home, root, cache)) = paths(&state).await {
            snapshot(home, root, cache);
        }
    });
}
#[tauri::command]
pub fn library_search_cancel(source: String) {
    gate().cancel(&source);
}
#[tauri::command]
pub async fn search_library_files(
    state: tauri::State<'_, Arc<AppState>>,
    options: SearchOptions,
    names: bool,
    source: String,
) -> Result<LibraryOutcome, String> {
    let request = gate().register(Some(&source));
    let (home, root, cache) = paths(&state).await?;
    tauri::async_runtime::spawn_blocking(move || {
        request.run(|cancel| {
            let (catalog, building, stale, error) = snapshot(home, root, cache);
            let mut out = match catalog {
                Some(c) => crate::library_search::search(&c, &options, names, cancel)?,
                None => LibraryOutcome::default(),
            };
            out.building = building;
            out.stale |= stale;
            out.error = error;
            Ok(out)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryText {
    text: String,
    decompiled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_origin: Option<String>,
}
#[tauri::command]
pub async fn read_library_file(
    state: tauri::State<'_, Arc<AppState>>,
    source: String,
    entry: String,
    archive: bool,
) -> Result<LibraryText, String> {
    let (home, _, _) = paths(&state).await?;
    let project_roots = super::workspace_cmds::allowed_read_roots(&state).await;
    let config_dir = state.config_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut allowed = project_roots.clone();
        if home.is_dir() {
            allowed.push(home.to_string_lossy().into_owned());
        }
        // 不新增全盘读取入口，沿用 canonicalize + 根路径校验。
        let source = crate::security::path::resolve_safe_path(&source, &allowed, &[], true)?;
        let bytes = library_index::read_entry(&source, &entry, archive)?;
        if entry.ends_with(".class") {
            if archive {
                if let Some(attached) = crate::library_source::read_attached(
                    &source,
                    &entry,
                    &bytes,
                    &project_roots,
                    &allowed,
                )? {
                    return Ok(LibraryText {
                        text: attached.text,
                        decompiled: false,
                        source_origin: Some(attached.origin),
                    });
                }
            }
            let nc = crate::nc_home::resolve(Some(&home.to_string_lossy()))?;
            let cfr = super::decompile_cmds::find_cfr(&config_dir)?;
            let text = if archive {
                crate::decompile::run_cfr(Path::new(&nc.java), &cfr, &source, &entry)?
            } else {
                crate::decompile::run_cfr(Path::new(&nc.java), &cfr, &source.join(&entry), "")?
            };
            Ok(LibraryText {
                text,
                decompiled: true,
                source_origin: None,
            })
        } else {
            if !library_index::text_entry(&entry)
                || bytes.contains(&0) && crate::workspace::utf16_encoding(&bytes).is_none()
            {
                return Err("这个库文件不是可读取的文本".into());
            }
            Ok(LibraryText {
                text: crate::workspace::decode_lossy(&bytes),
                decompiled: false,
                source_origin: None,
            })
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 事件驱动失效：脏标记立刻过期；无脏标记时 TTL 内不重扫（空闲搜索不再白烧 IO）。
    #[test]
    fn stale_follows_dirty_flag_then_fallback_ttl() {
        // 反例守卫：没目录时谈不上过期
        assert!(!catalog_stale(false, true, Duration::ZERO));
        // 刚建好且无事件：TTL 内保持新鲜（旧 30s 无条件重扫已废除）
        assert!(!catalog_stale(true, false, Duration::from_secs(31)));
        assert!(!catalog_stale(true, false, LIBRARY_TTL));
        // 兜底 TTL 超了：即便没有事件也过期（NC home 侧变化 watcher 看不见）
        assert!(catalog_stale(
            true,
            false,
            LIBRARY_TTL + Duration::from_secs(1)
        ));
        // watcher 置脏：0 秒也立刻过期
        assert!(catalog_stale(true, true, Duration::ZERO));
    }

    /// invalidate_library 只置标志、不清目录（SWR：重建期间旧结果仍可用）。
    #[test]
    fn invalidate_marks_dirty_without_dropping_catalog() {
        let key = "test-invalidate-slot".to_string();
        {
            let mut slot = SLOT.lock().unwrap_or_else(|e| e.into_inner());
            *slot = Some(Slot {
                key: key.clone(),
                catalog: None,
                building: false,
                checked: Instant::now(),
                error: None,
                generation: 0,
                failed_at: None,
                dirty: false,
            });
        }
        invalidate_library();
        let mut slot = SLOT.lock().unwrap_or_else(|e| e.into_inner());
        let s = slot.as_mut().unwrap();
        assert!(s.dirty);
        // 清场，避免影响别的测试用的全局槽
        *slot = None;
    }

    /// 🔴 稳定失败（NC home 不可读 / 磁盘满）下不能每敲一个字就重扫一遍盘。
    #[test]
    fn failed_build_backs_off_before_retrying() {
        // 刚失败：不重试
        assert!(!should_launch(false, false, false, Some(Instant::now())));
        // 超过退避窗口：可以重试
        let old = Instant::now() - RETRY_BACKOFF - Duration::from_secs(1);
        assert!(should_launch(false, false, false, Some(old)));
        // 没失败过：正常发起
        assert!(should_launch(false, false, false, None));
        assert!(RETRY_BACKOFF >= Duration::from_secs(30));
    }

    /// 退避不能把正常的单飞与刷新逻辑改坏。
    #[test]
    fn backoff_does_not_change_single_flight_or_refresh() {
        // 正在建：无论失败记录如何都不重复发起
        assert!(!should_launch(true, false, false, None));
        assert!(!should_launch(
            true,
            false,
            true,
            Some(Instant::now() - RETRY_BACKOFF * 2)
        ));
        // 已有目录且不脏：不重建
        assert!(!should_launch(false, true, false, None));
        // 已有目录但脏了：刷新（这条不受失败退避影响，因为上次是成功的）
        assert!(should_launch(false, true, true, None));
    }
}
