//! 按需求审查：需求表、cc-bridge 变更日志同步、块级已审。
//!
//! 所有写操作都是「读盘 → 改 → 写盘」，在同一把锁里做，避免两个请求交错时后写的覆盖先写的。
//! 写操作返回最新的 [`ReqView`]，前端不必再拉一次。

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use super::svn_cmds::{root_of, safe_path};
use crate::cc_journal;
use crate::req_store::{key_of, now_ms, ReqStore, Requirement, Touch};
use crate::review_blocks::BlockStore;
use crate::security::path::display_path;
use crate::state::AppState;

/// 需求表与块级标记的读改写都在这把锁里。
static LOCK: Mutex<()> = Mutex::new(());

/// 测试 / 特殊安装位置用：指定 cc-bridge 变更日志目录，覆盖默认位置。
const JOURNAL_DIR_ENV: &str = "NCFORGE_CCBRIDGE_JOURNAL";

fn journal_dir() -> Option<PathBuf> {
    std::env::var_os(JOURNAL_DIR_ENV)
        .map(PathBuf::from)
        .or_else(cc_journal::default_dir)
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReqInfo {
    #[serde(flatten)]
    pub req: Requirement,
    /// 与更早的某个需求名很像（疑似敲错 / 后补清单号）时，建议合并到的需求 id。
    pub merge_hint: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileReqs {
    pub path: String,
    /// 归属的需求 id（多个 = 混改）。空 = 改过但未归入任何需求。
    pub reqs: Vec<String>,
    /// 是否人工认领。
    pub claimed: bool,
    pub touches: Vec<Touch>,
}

#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalInfo {
    pub dir: Option<String>,
    /// 日志目录是否存在。
    pub found: bool,
    /// 最后一条属于本工作区的记录时间；0 = 从没读到过。
    pub last_at_ms: u64,
    /// 还有没读完的（首次启用时日志很大）。
    pub more: bool,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReqView {
    pub reqs: Vec<ReqInfo>,
    pub current: Option<String>,
    pub files: Vec<FileReqs>,
    pub journal: JournalInfo,
}

fn view(store: &ReqStore, journal: JournalInfo) -> ReqView {
    let reqs = store
        .reqs
        .iter()
        .map(|r| ReqInfo {
            req: r.clone(),
            merge_hint: store.merge_hint(&r.id),
        })
        .collect();
    let keys: std::collections::BTreeSet<&String> =
        store.touches.keys().chain(store.claims.keys()).collect();
    let files = keys
        .into_iter()
        .map(|k| FileReqs {
            path: store.paths.get(k).cloned().unwrap_or_else(|| k.clone()),
            reqs: store.reqs_of(k),
            claimed: store.claims.contains_key(k),
            touches: store.touches.get(k).cloned().unwrap_or_default(),
        })
        .collect();
    ReqView {
        reqs,
        current: store.current.clone(),
        files,
        journal,
    }
}

fn journal_info(store: &ReqStore, found: bool, more: bool) -> JournalInfo {
    JournalInfo {
        dir: journal_dir().map(|d| display_path(&d)),
        found,
        last_at_ms: store.cursor.last_at_ms,
        more,
    }
}

/// 在阻塞线程里、持锁执行一次「读 → 改 → 写」，返回最新视图。
async fn mutate(
    state: &Arc<AppState>,
    f: impl FnOnce(&mut ReqStore, &str) -> Result<(), String> + Send + 'static,
) -> Result<ReqView, String> {
    let cfg = state.config.read().await.clone();
    let cfg_dir = state.config_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = display_path(&root_of(&cfg)?);
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut store = ReqStore::load(&cfg_dir, &root);
        f(&mut store, &root)?;
        store.save(&cfg_dir, &root)?;
        let found = journal_dir().is_some_and(|d| d.is_dir());
        Ok(view(&store, journal_info(&store, found, false)))
    })
    .await
    .map_err(|e| format!("需求表操作失败: {e}"))?
}

/// 读取需求表，并把 cc-bridge 变更日志里的新条目同步进来。
#[tauri::command]
pub async fn req_state(state: tauri::State<'_, Arc<AppState>>) -> Result<ReqView, String> {
    let cfg = state.config.read().await.clone();
    let cfg_dir = state.config_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = display_path(&root_of(&cfg)?);
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut store = ReqStore::load(&cfg_dir, &root);
        let (found, more) = match journal_dir() {
            Some(dir) => {
                let before = store.cursor.clone();
                let o = cc_journal::sync(&mut store, &dir, &root);
                if store.cursor != before {
                    store.save(&cfg_dir, &root)?;
                }
                (o.found, o.more)
            }
            None => (false, false),
        };
        Ok(view(&store, journal_info(&store, found, more)))
    })
    .await
    .map_err(|e| format!("读取需求表失败: {e}"))?
}

#[tauri::command]
pub async fn req_create(
    state: tauri::State<'_, Arc<AppState>>,
    name: String,
) -> Result<ReqView, String> {
    mutate(&state, move |s, _| s.create(&name, now_ms()).map(|_| ())).await
}

#[tauri::command]
pub async fn req_rename(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
    name: String,
) -> Result<ReqView, String> {
    mutate(&state, move |s, _| s.rename(&id, &name)).await
}

#[tauri::command]
pub async fn req_merge(
    state: tauri::State<'_, Arc<AppState>>,
    from: String,
    into: String,
) -> Result<ReqView, String> {
    mutate(&state, move |s, _| s.merge(&from, &into)).await
}

#[tauri::command]
pub async fn req_set_status(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
    open: bool,
) -> Result<ReqView, String> {
    mutate(&state, move |s, _| s.set_status(&id, open)).await
}

#[tauri::command]
pub async fn req_set_current(
    state: tauri::State<'_, Arc<AppState>>,
    id: Option<String>,
) -> Result<ReqView, String> {
    mutate(&state, move |s, _| s.set_current(id.as_deref())).await
}

/// 把文件人工归到某个需求；`id = None` 解除认领。路径必须在工作区内（会落盘）。
#[tauri::command]
pub async fn req_claim(
    state: tauri::State<'_, Arc<AppState>>,
    paths: Vec<String>,
    id: Option<String>,
) -> Result<ReqView, String> {
    let cfg = state.config.read().await.clone();
    mutate(&state, move |s, _| {
        let safe = paths
            .iter()
            .map(|p| safe_path(&cfg, p).map(|p| display_path(&p)))
            .collect::<Result<Vec<_>, _>>()?;
        s.claim(&safe, id.as_deref())
    })
    .await
}

/// NCForge 里手改保存后调用：按「当前需求」记一条手改触达。
#[tauri::command]
pub async fn req_note_manual(
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
) -> Result<ReqView, String> {
    let cfg = state.config.read().await.clone();
    mutate(&state, move |s, _| {
        let p = display_path(&safe_path(&cfg, &path)?);
        s.note_manual(&p, now_ms());
        Ok(())
    })
    .await
}

/// 出包成功后记一笔出包记录。
#[tauri::command]
pub async fn req_record_package(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
    zip: String,
) -> Result<ReqView, String> {
    mutate(&state, move |s, _| {
        let r = s.reqs.iter_mut().find(|r| r.id == id).ok_or("需求不存在")?;
        r.packages.push(crate::req_store::PackRecord {
            zip,
            at_ms: now_ms(),
        });
        Ok(())
    })
    .await
}

/// 一次**完整、成功**的 SVN 扫描后调用：丢掉已不在改动里的文件的触达、认领与块级标记。
///
/// `changed` 是本次扫描的全部改动路径。只做删除、不碰文件系统，所以不逐个过白名单。
/// 空列表不处理：宁可少清一次，也不能因为一次异常的空结果把全部归属清光。
#[tauri::command]
pub async fn req_prune(
    state: tauri::State<'_, Arc<AppState>>,
    changed: Vec<String>,
) -> Result<ReqView, String> {
    let cfg_dir = state.config_dir.clone();
    mutate(&state, move |s, _| {
        if changed.is_empty() {
            return Ok(());
        }
        let keys: HashSet<String> = changed.iter().map(|p| key_of(p)).collect();
        s.prune(&keys);
        let mut blocks = BlockStore::load(&cfg_dir);
        if blocks.prune(&keys) > 0 {
            blocks.save(&cfg_dir)?;
        }
        Ok(())
    })
    .await
}

/// 全部块级已审的 key。
#[tauri::command]
pub async fn review_blocks_list(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<String>, String> {
    let cfg_dir = state.config_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        Ok(BlockStore::load(&cfg_dir).marks.into_keys().collect())
    })
    .await
    .map_err(|e| format!("读取块级审查标记失败: {e}"))?
}

/// 标记 / 取消若干块已审。`texts` 与 `keys` 一一对应（可缺省）。
#[tauri::command]
pub async fn review_blocks_set(
    state: tauri::State<'_, Arc<AppState>>,
    keys: Vec<String>,
    texts: Option<Vec<Option<String>>>,
    reviewed: bool,
) -> Result<(), String> {
    let cfg_dir = state.config_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut s = BlockStore::load(&cfg_dir);
        s.set(&keys, &texts.unwrap_or_default(), reviewed, now_ms());
        s.save(&cfg_dir)
    })
    .await
    .map_err(|e| format!("保存块级审查标记失败: {e}"))?
}
