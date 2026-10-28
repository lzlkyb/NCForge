//! SVN 命令层：改动列表、差异、历史、blame、提交、更新、撤销、冲突处理、已审标记。
//!
//! 三条约定（与 server_cmds 同一套）：
//! 1. **所有桥调用都在 `spawn_blocking` 里**。全量 status 在这台机器上要 7.6 秒，
//!    放在 async 线程上等于把整个 IPC 队列钉死。
//! 2. **不缓存状态**。改动列表每次真扫——SVN 的「改动」随时会被 Eclipse、命令行改掉，
//!    缓存只会给出过期结论；界面靠轮询节流（窗口隐藏时停）而不是靠缓存。
//! 3. **写操作前先备份**。revert 是唯一无法从 SVN 恢复的操作，先把文件拷到
//!    `<工作区>/.ncforge-revert-<时间戳>/` 再动手。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::config::AppConfig;
use crate::security::path::{display_path, resolve_safe_path};
use crate::state::AppState;
use crate::svn_bridge::{self, Bridge, BridgeEnv};
use crate::svn_cred;
use crate::svn_review::{self, ReviewMark, ReviewStore};
use crate::svn_view::{self, ChangesView, RawEntry};
use crate::workspace;

/// status 超时：实测全量 7.6 秒，给 4 倍余量应付别人机器上的杀软扫描。
const T_STATUS: Duration = Duration::from_secs(180);
/// 单文件操作（diff/blame/log）通常毫秒级，但首次要连服务器。
const T_NET: Duration = Duration::from_secs(90);
/// 提交、更新可能搬大量数据。
const T_WRITE: Duration = Duration::from_secs(600);

// ───────────────────────── DTO ─────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SvnInfo {
    pub root: String,
    /// 工作副本对应的仓库 URL。
    pub url: String,
    /// 工作副本根的版本号。
    pub revision: i64,
    pub host: String,
    /// 用户名（配置里存的优先，其次 SVN 缓存里的）。
    pub user: Option<String>,
    /// 有没有可用的密码（false 时界面要引导输入）。
    pub has_password: bool,
    /// `saved`（我们自己存的）/ `svn-cache`（复用 Eclipse 的）/ `none`。
    pub credential_source: String,
    /// 桥进程是否活着（用于「桥已退出，将自动重启」提示）。
    pub bridge_alive: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusResult {
    pub changes: ChangesView,
    /// 桥扫过的条目数（含 normal，不含被忽略的）。
    pub scanned: i64,
    pub generated_at_ms: u64,
    pub has_conflict: bool,
    /// 已审标记（只含仍然有效的：文件没被改过）。前端还要拿它和当前 revision 比。
    pub reviewed: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffResult {
    /// 仓库里的 BASE 内容；新增文件为空串。
    pub base_text: String,
    /// 磁盘上的当前内容（已按检测出的编码解码成 `\n` 文本）。
    pub working_text: String,
    pub encoding: String,
    pub eol: String,
    /// BASE 不存在（未纳管/新增文件），界面显示「整份都是新增」。
    pub base_empty: bool,
    /// 工作副本相对 BASE 的字节数差，纯展示用。
    pub base_size: u64,
    pub working_size: u64,
    /// 文件在编辑器里是否可编辑（MIXED 换行或无法无损往返时为 false）。
    pub editable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub revision: i64,
    pub author: String,
    /// 毫秒时间戳。
    pub date: i64,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    pub revision: i64,
    pub author: String,
    pub date: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitResult {
    pub revision: i64,
    pub author: String,
    pub added: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateResult {
    pub revision: i64,
    /// 更新后仍有冲突的文件（更新本身不解决冲突）。
    pub conflicts: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertResult {
    pub count: usize,
    /// 备份目录（界面告诉用户「后悔药在哪」）。
    pub backup_dir: String,
}

// ───────────────────────── 内部工具 ─────────────────────────

/// 资源目录候选：安装包资源在前，开发树的 `src-tauri/resources` 兜底。
fn resource_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        dirs.push(dir.join("svnkit"));
    }
    dirs.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/svnkit"));
    dirs
}

/// 取（或建）桥。java 路径变了（换了 NC home）就重建，避免拿着旧 JVM 干活。
fn bridge_for(app: &AppHandle, state: &AppState, cfg: &AppConfig) -> Result<Arc<Bridge>, String> {
    let home = crate::nc_home::resolve(cfg.nc_home.as_deref())?;
    let java = PathBuf::from(&home.java);
    let (jars, _) = svn_bridge::find_jars(&resource_dirs(app)).ok_or_else(|| {
        "找不到内置的 SVN 组件（ncsvn.jar / svnkit.jar），安装包可能不完整".to_string()
    })?;
    let cfg_dir = state.config_dir.join("svn");
    svn_bridge::ensure_dir(&cfg_dir)?;

    let mut guard = state.svn.lock().map_err(|_| "SVN 桥状态异常".to_string())?;
    if let Some(existing) = guard.as_ref() {
        if existing.env().java == java {
            return Ok(existing.clone());
        }
        existing.shutdown();
    }
    let bridge = Arc::new(Bridge::new(BridgeEnv {
        java,
        jars,
        config_dir: cfg_dir,
    }));
    *guard = Some(bridge.clone());
    Ok(bridge)
}

/// 凭据解析结果。
enum Cred {
    /// 用户名 + 密码都能拿到。
    Full {
        user: String,
        pass: String,
        source: &'static str,
    },
    /// 只有用户名（SVN 缓存里没存密码），需要用户补一次。
    UserOnly { user: String },
    /// 什么都没有。
    None,
}

/// 先看自己存的，再看用户的 SVN 缓存。**顺序不能反**：用户在我们这里输过密码，
/// 就应该用那份（他可能特意为工作台设了不同的账号）。
fn lookup_cred(cfg: &AppConfig, host: &str) -> Cred {
    if let (Some(user), Some(pw)) = (cfg.svn_user.as_deref(), cfg.svn_password_dpapi.as_deref()) {
        if let Some(bytes) = svn_cred::b64_decode(pw) {
            if let Ok(plain) = svn_cred::dpapi_unprotect(&bytes) {
                if let Ok(pass) = String::from_utf8(plain) {
                    return Cred::Full {
                        user: user.to_string(),
                        pass,
                        source: "saved",
                    };
                }
            }
            // 解不开（换了用户/机器）：当作没存过
        }
    }
    let Some(dir) = svn_cred::user_auth_dir() else {
        return Cred::None;
    };
    let Some(rec) = svn_cred::find_cached(&dir, host) else {
        return Cred::None;
    };
    let Some(user) = rec.username.clone() else {
        return Cred::None;
    };
    if let (Some(enc), Some(kind)) = (rec.password.as_deref(), rec.passtype.as_deref()) {
        if kind == "wincrypt" {
            if let Some(raw) = svn_cred::b64_decode(&String::from_utf8_lossy(enc)) {
                if let Ok(plain) = svn_cred::dpapi_unprotect(&raw) {
                    if let Ok(pass) = String::from_utf8(plain) {
                        return Cred::Full {
                            user,
                            pass,
                            source: "svn-cache",
                        };
                    }
                }
            }
        }
    }
    Cred::UserOnly { user }
}

/// 本地 info（不联网）：拿 URL / 版本 / host。凭据缺失也能跑。
fn wc_info(bridge: &Bridge, root: &Path) -> Result<SvnInfo, String> {
    let root_s = root.display().to_string();
    let v = bridge
        .call("info", &[&root_s], T_NET)
        .map_err(|e| e.message)?;
    let url = v["url"].as_str().unwrap_or("").to_string();
    Ok(SvnInfo {
        root: root_s,
        host: svn_cred::host_of(&url),
        url,
        revision: v["revision"].as_i64().unwrap_or(-1),
        user: None,
        has_password: false,
        credential_source: "none".to_string(),
        bridge_alive: true,
    })
}

/// 网络操作前把凭据喂给桥。没有可用密码时返回 `code = "auth"` 的错误，
/// 前端据此弹登录框（而不是显示「命令失败」）。
fn ensure_auth(
    bridge: &Bridge,
    cfg: &AppConfig,
    host: &str,
) -> Result<(String, &'static str), String> {
    match lookup_cred(cfg, host) {
        Cred::Full { user, pass, source } => {
            bridge
                .call("auth", &[&user, &pass], T_NET)
                .map_err(|e| split_code_label(e.code, e.message))?;
            Ok((user, source))
        }
        Cred::UserOnly { user } => Err(format!(
            "auth|SVN 账号 {user} 已找到，但密码没有缓存，请在这里输一次"
        )),
        Cred::None => Err("auth|需要 SVN 账号密码".to_string()),
    }
}

fn root_of(cfg: &AppConfig) -> Result<PathBuf, String> {
    cfg.workspace_root
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| "还没有选择工作区（先在文件页打开一个工程根目录）".to_string())
}

/// 白名单校验：SVN 命令只允许作用在工作区内。
fn safe_path(cfg: &AppConfig, requested: &str) -> Result<PathBuf, String> {
    let root = root_of(cfg)?;
    let root_s = display_path(&root);
    let p = resolve_safe_path(requested, std::slice::from_ref(&root_s), &[], true)?;
    Ok(crate::nc_home::strip_verbatim(&p))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn mtime_ms(path: &Path) -> Option<u64> {
    let md = std::fs::metadata(path).ok()?;
    let t = md.modified().ok()?;
    Some(t.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as u64)
}

/// 已审标记里仍然有效的路径集合（文件还在、mtime/size 没变）。
/// revision 的比较交给前端：它手里才有刚扫出来的 status 条目。
fn valid_marks(store: &ReviewStore) -> Vec<String> {
    let mut out = Vec::new();
    for (key, mark) in &store.marks {
        let p = Path::new(key);
        let (Some(mt), Ok(md)) = (mtime_ms(p), std::fs::metadata(p)) else {
            continue;
        };
        if mark.mtime_ms == mt && mark.size == md.len() {
            out.push(key.clone());
        }
    }
    out
}

// ───────────────────────── 命令 ─────────────────────────

/// 工作副本概况 + 凭据状态。界面进页先调它。
#[tauri::command]
pub async fn svn_info(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<SvnInfo, String> {
    let cfg = state.config.read().await.clone();
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = root_of(&cfg)?;
        let bridge = bridge_for(&app, &st, &cfg)?;
        let mut info = wc_info(&bridge, &root)?;
        match lookup_cred(&cfg, &info.host) {
            Cred::Full { user, source, .. } => {
                info.user = Some(user);
                info.has_password = true;
                info.credential_source = source.to_string();
            }
            Cred::UserOnly { user } => {
                info.user = Some(user);
                info.credential_source = "svn-cache".to_string();
            }
            Cred::None => {}
        }
        info.bridge_alive = bridge.alive();
        Ok(info)
    })
    .await
    .map_err(|e| format!("取 SVN 信息失败: {e}"))?
}

/// 扫描改动。构建产物也一并返回（带 `ignored` 标记），由界面决定显不显示——
/// 让后端按界面开关重扫一遍，等于点一下「显示全部」等 7.6 秒。
#[tauri::command]
pub async fn svn_status(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<StatusResult, String> {
    let cfg = state.config.read().await.clone();
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = root_of(&cfg)?;
        let bridge = bridge_for(&app, &st, &cfg)?;
        let root_s = crate::nc_home::strip_verbatim(&root).display().to_string();
        let v = bridge
            .call("status", &[&root_s], T_STATUS)
            .map_err(|e| split_code_label(e.code, e.message))?;
        let scanned = v["scanned"].as_i64().unwrap_or(0);
        let raw: Vec<RawEntry> = serde_json::from_value(v["entries"].clone())
            .map_err(|e| format!("解析 SVN 状态失败: {e}"))?;
        let changes = svn_view::build_changes(&root, &raw);
        let has_conflict = changes
            .groups
            .iter()
            .flat_map(|g| g.items.iter())
            .any(|i| i.letter == "C");
        let store = ReviewStore::load(&st.config_dir);
        Ok(StatusResult {
            changes,
            scanned,
            generated_at_ms: now_ms(),
            has_conflict,
            reviewed: valid_marks(&store),
        })
    })
    .await
    .map_err(|e| format!("扫描改动失败: {e}"))?
}

/// 命令层错误统一编码成 `code|message`：前端按第一个 `|` 切开，`code` 决定引导方式
/// （`auth` 弹登录框、`conflict` 指到冲突面板、其余原样显示）。
fn split_code_label(code: String, message: String) -> String {
    format!("{code}|{message}")
}

/// 单个文件的 BASE ↔ 工作副本对比。
#[tauri::command]
pub async fn svn_diff(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
) -> Result<DiffResult, String> {
    let cfg = state.config.read().await.clone();
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let target = safe_path(&cfg, &path)?;
        let bridge = bridge_for(&app, &st, &cfg)?;
        let working = workspace::read_text_file(&target)?;
        let v = bridge
            .call("diff", &[&target.display().to_string()], T_NET)
            .map_err(|e| split_code_label(e.code, e.message))?;
        let base_empty = v["empty"].as_bool().unwrap_or(true);
        let base_bytes = v["base"]
            .as_str()
            .and_then(svn_cred::b64_decode)
            .unwrap_or_default();
        // BASE 用工作副本的编码解：两侧必须同一种解码，否则 GBK 文件会满屏假差异
        let base_text = if base_empty {
            String::new()
        } else {
            decode_as(&base_bytes, working.encoding)
        };
        Ok(DiffResult {
            base_text,
            working_text: working.text.clone(),
            encoding: match working.encoding {
                workspace::TextEncoding::Utf8 => "UTF-8",
                workspace::TextEncoding::Gbk => "GBK",
            }
            .to_string(),
            eol: match working.eol {
                workspace::Eol::Lf => "LF",
                workspace::Eol::Crlf => "CRLF",
                workspace::Eol::Mixed => "MIXED",
            }
            .to_string(),
            base_empty,
            base_size: v["size"].as_u64().unwrap_or(0),
            working_size: working.size,
            editable: working.lossless && working.eol != workspace::Eol::Mixed,
        })
    })
    .await
    .map_err(|e| format!("取差异失败: {e}"))?
}

fn decode_as(bytes: &[u8], enc: workspace::TextEncoding) -> String {
    match enc {
        workspace::TextEncoding::Utf8 => {
            let s = String::from_utf8_lossy(bytes);
            s.trim_start_matches('\u{feff}').replace("\r\n", "\n")
        }
        workspace::TextEncoding::Gbk => {
            let (cow, _, _) = encoding_rs::GBK.decode(bytes);
            cow.replace("\r\n", "\n")
        }
    }
}

/// 历史（分页：`from` 传上一页最后一条的 revision，首页传 0）。
#[tauri::command]
pub async fn svn_log(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
    limit: u32,
    from: i64,
) -> Result<Vec<LogEntry>, String> {
    let cfg = state.config.read().await.clone();
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let target = safe_path(&cfg, &path)?;
        let bridge = bridge_for(&app, &st, &cfg)?;
        let info = wc_info(&bridge, &root_of(&cfg)?)?;
        ensure_auth(&bridge, &cfg, &info.host)?;
        let v = bridge
            .call(
                "log",
                &[
                    &target.display().to_string(),
                    &limit.clamp(1, 200).to_string(),
                    &from.to_string(),
                ],
                T_NET,
            )
            .map_err(|e| split_code_label(e.code, e.message))?;
        serde_json::from_value(v["entries"].clone()).map_err(|e| format!("解析历史失败: {e}"))
    })
    .await
    .map_err(|e| format!("取历史失败: {e}"))?
}

/// blame：每行对应的版本与作者（正文由前端从编辑器拿，不重复传）。
#[tauri::command]
pub async fn svn_blame(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
) -> Result<Vec<BlameLine>, String> {
    let cfg = state.config.read().await.clone();
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let target = safe_path(&cfg, &path)?;
        let bridge = bridge_for(&app, &st, &cfg)?;
        let info = wc_info(&bridge, &root_of(&cfg)?)?;
        ensure_auth(&bridge, &cfg, &info.host)?;
        let v = bridge
            .call("blame", &[&target.display().to_string()], T_NET)
            .map_err(|e| split_code_label(e.code, e.message))?;
        serde_json::from_value(v["lines"].clone()).map_err(|e| format!("解析 blame 失败: {e}"))
    })
    .await
    .map_err(|e| format!("取 blame 失败: {e}"))?
}

/// 提交勾选的文件。冲突文件会被桥拒绝（返回 code=conflict）。
#[tauri::command]
pub async fn svn_commit(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    paths: Vec<String>,
    message: String,
) -> Result<CommitResult, String> {
    if paths.is_empty() {
        return Err("没有勾选任何文件".to_string());
    }
    if message.trim().is_empty() {
        return Err("提交说明不能为空".to_string());
    }
    let cfg = state.config.read().await.clone();
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = root_of(&cfg)?;
        let bridge = bridge_for(&app, &st, &cfg)?;
        let info = wc_info(&bridge, &root)?;
        ensure_auth(&bridge, &cfg, &info.host)?;
        let mut targets = Vec::with_capacity(paths.len());
        for p in &paths {
            targets.push(display_path(&safe_path(&cfg, p)?));
        }
        // 提交说明走临时文件：说明里必然有换行，塞进行协议要额外转义，不如落盘
        let msg_file = st.config_dir.join(format!("svn-commit-{}.txt", now_ms()));
        std::fs::write(&msg_file, message.trim()).map_err(|e| format!("写提交说明失败: {e}"))?;
        let mut args: Vec<String> = vec![msg_file.display().to_string()];
        args.extend(targets);
        let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        let result = bridge.call("commit", &refs, T_WRITE);
        let _ = std::fs::remove_file(&msg_file);
        let v = result.map_err(|e| split_code_label(e.code, e.message))?;
        Ok(CommitResult {
            revision: v["revision"].as_i64().unwrap_or(-1),
            author: v["author"].as_str().unwrap_or("").to_string(),
            added: v["added"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default(),
        })
    })
    .await
    .map_err(|e| format!("提交失败: {e}"))?
}

/// 更新整个工作副本。
#[tauri::command]
pub async fn svn_update(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<UpdateResult, String> {
    let cfg = state.config.read().await.clone();
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = root_of(&cfg)?;
        let bridge = bridge_for(&app, &st, &cfg)?;
        let info = wc_info(&bridge, &root)?;
        ensure_auth(&bridge, &cfg, &info.host)?;
        let v = bridge
            .call("update", &[&display_path(&root)], T_WRITE)
            .map_err(|e| split_code_label(e.code, e.message))?;
        // 更新不解决冲突，但会把冲突标出来，顺手扫一遍告诉界面
        let v2 = bridge
            .call("status", &[&display_path(&root)], T_STATUS)
            .map_err(|e| split_code_label(e.code, e.message))?;
        let raw: Vec<RawEntry> = serde_json::from_value(v2["entries"].clone()).unwrap_or_default();
        let conflicts = raw
            .iter()
            .filter(|e| e.status == "conflicted")
            .map(|e| e.path.clone())
            .collect();
        Ok(UpdateResult {
            revision: v["revision"].as_i64().unwrap_or(-1),
            conflicts,
        })
    })
    .await
    .map_err(|e| format!("更新失败: {e}"))?
}

/// 撤销本地改动。**先备份再 revert**。
#[tauri::command]
pub async fn svn_revert(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    paths: Vec<String>,
    recursive: bool,
) -> Result<RevertResult, String> {
    if paths.is_empty() {
        return Err("没有选中要撤销的文件".to_string());
    }
    let cfg = state.config.read().await.clone();
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = root_of(&cfg)?;
        let bridge = bridge_for(&app, &st, &cfg)?;
        let mut targets = Vec::with_capacity(paths.len());
        for p in &paths {
            targets.push(PathBuf::from(display_path(&safe_path(&cfg, p)?)));
        }
        // 备份：<工作副本上一级>/.ncforge-revert-<ts>/<相对路径>
        //
        // 故意不放在工作副本里面：那是 SVN 和 Eclipse 都盯着的目录，凭空多一个
        // 未纳管目录会进改动列表，也可能被别的客户端「提交全部」顺手带上。
        // 放上一级既在工程旁边好找，又不进仓库。
        let ts = now_ms();
        let root_clean = crate::nc_home::strip_verbatim(&root);
        let backup_dir = match root_clean.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => {
                parent.join(format!(".ncforge-revert-{ts}"))
            }
            // 工作副本根就是盘符根（D:\）时没有上一级，落到应用数据目录
            _ => st.config_dir.join(format!("revert-{ts}")),
        };
        for t in &targets {
            if !t.is_file() {
                continue;
            }
            let rel = t.strip_prefix(&root).unwrap_or(t);
            let dest = backup_dir.join(rel);
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("建备份目录失败: {e}"))?;
            }
            std::fs::copy(t, &dest).map_err(|e| format!("备份 {:?} 失败: {e}", t.display()))?;
        }
        let mut args: Vec<String> = vec![if recursive { "1".into() } else { "0".into() }];
        args.extend(targets.iter().map(|p| p.display().to_string()));
        let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        let v = bridge
            .call("revert", &refs, T_WRITE)
            .map_err(|e| split_code_label(e.code, e.message))?;
        Ok(RevertResult {
            count: v["count"].as_u64().unwrap_or(0) as usize,
            backup_dir: backup_dir.display().to_string(),
        })
    })
    .await
    .map_err(|e| format!("撤销失败: {e}"))?
}

/// 冲突二选一：`mine` / `theirs` / `base`。这一步会丢掉 .mine/.rN 临时文件。
#[tauri::command]
pub async fn svn_resolve(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
    choice: String,
) -> Result<(), String> {
    if !matches!(choice.as_str(), "mine" | "theirs" | "base") {
        return Err("未知的解决方式".to_string());
    }
    let cfg = state.config.read().await.clone();
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let target = safe_path(&cfg, &path)?;
        let bridge = bridge_for(&app, &st, &cfg)?;
        bridge
            .call("resolve", &[&choice, &display_path(&target)], T_NET)
            .map_err(|e| split_code_label(e.code, e.message))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("解决冲突失败: {e}"))?
}

/// 标记/取消「已审」。`reviewed = false` 时删掉标记。
#[tauri::command]
pub async fn svn_review_mark(
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
    revision: i64,
    reviewed: bool,
) -> Result<(), String> {
    let cfg = state.config.read().await.clone();
    let st = state.inner().clone();
    let cfg_dir = st.config_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // 这个 key 会落盘、下次 status 时被读回来，所以路径必须过白名单：
        // 不能让前端把工作区外的任意路径写进标记文件。
        let target = safe_path(&cfg, &path)?;
        let mut store = ReviewStore::load(&cfg_dir);
        let key = svn_review::key_of(&target);
        if reviewed {
            let md = std::fs::metadata(&target).map_err(|e| format!("读文件信息失败: {e}"))?;
            store.marks.insert(
                key,
                ReviewMark {
                    revision,
                    mtime_ms: mtime_ms(&target).unwrap_or(0),
                    size: md.len(),
                    at_ms: now_ms(),
                },
            );
        } else {
            store.marks.remove(&key);
        }
        store.save(&cfg_dir)
    })
    .await
    .map_err(|e| format!("保存审查标记失败: {e}"))?
}

/// 清掉所有失效标记（文件被改过/不在了），返回剩余条数。
#[tauri::command]
pub async fn svn_review_prune(state: tauri::State<'_, Arc<AppState>>) -> Result<usize, String> {
    let st = state.inner().clone();
    let cfg_dir = st.config_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut store = ReviewStore::load(&cfg_dir);
        let left = store.retain_valid(|key| {
            let p = Path::new(key);
            let mt = mtime_ms(p)?;
            let md = std::fs::metadata(p).ok()?;
            Some((mt, md.len()))
        });
        store.save(&cfg_dir)?;
        Ok(left)
    })
    .await
    .map_err(|e| format!("清理审查标记失败: {e}"))?
}

/// 保存用户输入的账号密码（密码 DPAPI 加密后落盘）。
#[tauri::command]
pub async fn svn_auth_set(
    state: tauri::State<'_, Arc<AppState>>,
    user: String,
    password: String,
) -> Result<(), String> {
    if user.trim().is_empty() || password.is_empty() {
        return Err("账号和密码都不能为空".to_string());
    }
    let enc = svn_cred::dpapi_protect(password.as_bytes())?;
    let encoded = svn_cred::b64_encode(&enc);
    state
        .update_config(|c| {
            c.svn_user = Some(user.trim().to_string());
            c.svn_password_dpapi = Some(encoded.clone());
            Ok(())
        })
        .await?;
    // 凭据变了，桥里的 client manager 要换：直接重启最省事（下次调用自动拉起）
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Ok(guard) = st.svn.lock() {
            if let Some(b) = guard.as_ref() {
                b.restart();
            }
        }
    })
    .await
    .map_err(|e| format!("重启 SVN 桥失败: {e}"))?;
    Ok(())
}
