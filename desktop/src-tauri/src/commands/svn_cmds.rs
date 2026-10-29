//! SVN 命令层：改动列表、差异、历史、blame、提交、更新、撤销、冲突处理、已审标记。
//!
//! 三条约定（与 server_cmds 同一套）：
//! 1. **所有桥调用都在 `spawn_blocking` 里**。全量 status 在这台机器上要 7.6 秒，
//!    放在 async 线程上等于把整个 IPC 队列钉死。
//! 2. **不缓存状态**。改动列表每次真扫——SVN 的「改动」随时会被 Eclipse、命令行改掉，
//!    缓存只会给出过期结论；界面靠轮询节流（窗口隐藏时停）而不是靠缓存。
//! 3. **写操作前先备份**。revert 是唯一无法从 SVN 恢复的操作，先把文件拷到
//!    `<工作副本上一级>/.ncforge-revert-<时间戳>/` 再动手（落点见 `backup_root`，
//!    这些目录的盘点与清理见 `svn_backup` 与 `svn_housekeeping`）。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::config::AppConfig;
use crate::security::path::{display_path, resolve_safe_path};
use crate::state::AppState;
use crate::svn_backup;
use crate::svn_bridge::{self, Bridge};
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
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveResult {
    /// 冲突临时文件（`.mine` / `.rN`）的备份目录；没有可备份的文件时为 None。
    pub backup_dir: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertResult {
    pub count: usize,
    /// 备份目录（界面告诉用户「后悔药在哪」）。
    pub backup_dir: String,
}

// ───────────────────────── 内部工具 ─────────────────────────

/// 资源目录候选：外部资源包（按需下载安装）在前，安装包资源（v0.1.0 及以前的
/// 旧安装兜底）随后，开发树的 `src-tauri/resources` 最后。
fn resource_dirs(app: &AppHandle, config_dir: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(dir) =
        crate::resource_pack::active_dir(config_dir, crate::resource_pack::PACK_SVNKIT)
    {
        dirs.push(dir);
    }
    if let Ok(dir) = app.path().resource_dir() {
        dirs.push(dir.join("svnkit"));
    }
    dirs.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/svnkit"));
    dirs
}

/// 取（或建）桥。java 路径变了（换了 NC home）**或组件版本变了**就重建。
///
/// 只比 java 路径是不够的：桥进程全程握着自己的 classpath，jar 升级（组件下载换包）
/// 后旧 JVM 仍然跑旧 class，必须重启应用才生效——而升级正是「刚点完更新组件」的时刻，
/// 用户会以为新版本没起作用。所以连 jar 列表一起比。
fn bridge_for(app: &AppHandle, state: &AppState, cfg: &AppConfig) -> Result<Arc<Bridge>, String> {
    let home = crate::nc_home::resolve(cfg.nc_home.as_deref())?;
    let java = PathBuf::from(&home.java);
    let (jars, _) = svn_bridge::find_jars(&resource_dirs(app, &state.config_dir)).ok_or_else(|| {
        "找不到 SVN 组件（ncsvn.jar / svnkit.jar）。若刚安装/更新过，请到设置 → 组件里下载；否则检查网络后重试".to_string()
    })?;
    let cfg_dir = state.config_dir.join("svn");
    svn_bridge::ensure_dir(&cfg_dir)?;

    let mut guard = state.svn.lock().map_err(|_| "SVN 桥状态异常".to_string())?;
    if let Some(existing) = guard.as_ref() {
        if existing.env().java == java && existing.env().jars == jars {
            return Ok(existing.clone());
        }
        existing.shutdown();
    }
    let bridge = Arc::new(Bridge::new(svn_bridge::env(java, jars, cfg_dir)));
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

/// 备份目录：`<工作副本上一级>/.ncforge-<tag>-<ts>`；工作副本根是盘符根时落到配置目录。
///
/// 故意不放在工作副本里面：那是 SVN 和 Eclipse 都盯着的目录，凭空多一个
/// 未纳管目录会进改动列表，也可能被别的客户端「提交全部」顺手带上。
/// 放上一级既在工程旁边好找，又不进仓库。
fn backup_root(root: &Path, config_dir: &Path, tag: &str, ts: u64) -> PathBuf {
    let root_clean = crate::nc_home::strip_verbatim(root);
    match root_clean.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => {
            parent.join(format!(".ncforge-{tag}-{ts}"))
        }
        _ => config_dir.join(format!("{tag}-{ts}")),
    }
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
///
/// 扫描要 7.6 秒，这段时间界面只转个 spinner 用户分不清「在跑」还是「卡死」，
/// 所以走 `call_with_progress` 把桥每 300 条的进度用事件推给前端
/// （桥一直在推，以前被 `call()` 当心跳丢掉）。
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
        let emitter = app.clone();
        let v = bridge
            .call_with_progress("status", &[&root_s], T_STATUS, move |p| {
                if let Some(n) = p.get("scanned").and_then(|x| x.as_i64()) {
                    // 进度只是提示：发不出去（窗口已关）不影响扫描结果
                    let _ = emitter.emit("svn-scan-progress", serde_json::json!({ "scanned": n }));
                }
            })
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
        // 每个条目的 BASE 版本号：已审标记的 revision 维度就靠它（见 `valid_marks`）
        let mut revisions = HashMap::new();
        for g in &changes.groups {
            for it in &g.items {
                revisions.insert(svn_review::key_of(Path::new(&it.path)), it.revision);
            }
        }
        let store = ReviewStore::load(&st.config_dir);
        Ok(StatusResult {
            changes,
            scanned,
            generated_at_ms: now_ms(),
            has_conflict,
            reviewed: svn_review::valid_marks(&store, &revisions),
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
///
/// 只做更新，**不在这里再扫一遍 status**：更新后前端一定会 `refresh()`（界面上的改动数、
/// 审查进度全靠那次扫描），里面再扫一次等于同一件事做两遍、多等 7.6 秒；更要紧的是
/// 二次扫描一旦失败，整条命令会报错——而更新其实已经成功了，用户可能再点一次更新。
/// 冲突信息由前端在那次刷新结果里自己读（C 条目就是冲突）。
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
        Ok(UpdateResult {
            revision: v["revision"].as_i64().unwrap_or(-1),
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
        // 备份：<工作副本上一级>/.ncforge-revert-<ts>/<相对路径>（见 backup_root）
        let ts = now_ms();
        let backup_dir = backup_root(&root, &st.config_dir, "revert", ts);
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

/// 冲突二选一：`mine` / `theirs` / `base`。
///
/// **先备份再落盘**，与撤销同一套标准：`doResolve` 会顺手删掉 `.mine` / `.rN`
/// 三个临时文件，删了就再没有「另一版」可看，而选错版本在冲突处理里太常见了。
/// 以前这里一点即落盘、连确认都没有，是全仓唯一没有回头路的写操作。
#[tauri::command]
pub async fn svn_resolve(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
    choice: String,
) -> Result<ResolveResult, String> {
    if !matches!(choice.as_str(), "mine" | "theirs" | "base") {
        return Err("未知的解决方式".to_string());
    }
    let cfg = state.config.read().await.clone();
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = root_of(&cfg)?;
        let target = safe_path(&cfg, &path)?;
        let bridge = bridge_for(&app, &st, &cfg)?;
        let backup_dir = backup_conflict_files(&root, &target, &st.config_dir, &path)?;
        bridge
            .call("resolve", &[&choice, &display_path(&target)], T_NET)
            .map_err(|e| split_code_label(e.code, e.message))?;
        Ok(ResolveResult {
            backup_dir: backup_dir.map(|d| d.display().to_string()),
        })
    })
    .await
    .map_err(|e| format!("解决冲突失败: {e}"))?
}

/// 把 `<文件>.mine` / `<文件>.r<数字>` 拷到备份目录，返回（有东西可拷时的）目录。
///
/// 版本号事先不知道（服务器把冲突版本写成 `.r1234`，本地那一版是 `.mine`），
/// 所以按文件名前缀扫一遍目录，而不是拼死一个名字。
fn backup_conflict_files(
    root: &Path,
    target: &Path,
    config_dir: &Path,
    requested: &str,
) -> Result<Option<PathBuf>, String> {
    let (Some(parent), Some(name)) = (target.parent(), target.file_name().and_then(|n| n.to_str()))
    else {
        return Ok(None);
    };
    let prefix = format!("{name}.");
    let mut found = Vec::new();
    if let Ok(entries) = std::fs::read_dir(parent) {
        for entry in entries.flatten() {
            let Some(fname) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            let Some(suffix) = fname.strip_prefix(&prefix) else {
                continue;
            };
            let is_conflict = suffix == "mine"
                || (suffix.starts_with('r') && suffix[1..].chars().all(|c| c.is_ascii_digit()));
            if is_conflict && entry.path().is_file() {
                found.push(entry.path());
            }
        }
    }
    if found.is_empty() {
        return Ok(None);
    }
    let dir = backup_root(root, config_dir, "resolve", now_ms());
    let rel_dir = target
        .parent()
        .and_then(|p| p.strip_prefix(root).ok())
        .unwrap_or(Path::new(""));
    let dest_dir = dir.join(rel_dir);
    std::fs::create_dir_all(&dest_dir).map_err(|e| format!("建备份目录失败: {e}"))?;
    for src in found {
        let Some(n) = src.file_name() else { continue };
        let dest = dest_dir.join(n);
        std::fs::copy(&src, &dest)
            .map_err(|e| format!("备份 {} 失败: {e}（{requested}）", src.display()))?;
    }
    Ok(Some(dest_dir))
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
                    // 原样路径另存一份：key 是小写化的，拿去 stat 在大小写敏感的
                    // 系统上永远失败（见 `ReviewMark::path`）
                    path: target.display().to_string(),
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
        let left = store.retain_valid(|key, mark| {
            let p = mark.fs_path(key);
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

/// 备份目录的候选基线目录。
///
/// 与 `backup_root` 同口径：正常是工作副本的上一级；工作副本根是盘符根时那里没有
/// 父目录，备份会落到配置目录，所以两个都要扫，否则最需要清理的那台机器反而看不到。
fn backup_bases(root: &Path, config_dir: &Path) -> Vec<PathBuf> {
    let mut bases: Vec<PathBuf> = Vec::new();
    if let Some(parent) = crate::nc_home::strip_verbatim(root).parent() {
        if !parent.as_os_str().is_empty() {
            bases.push(parent.to_path_buf());
        }
    }
    if !bases.iter().any(|b| b == config_dir) {
        bases.push(config_dir.to_path_buf());
    }
    bases
}

/// 维护面板的数据：备份目录盘点 + 审查标记统计。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HousekeepingInfo {
    /// 备份目录所在的目录（工作副本上一级），界面上告诉用户去哪儿找。
    pub base_dir: String,
    pub backups: Vec<svn_backup::BackupDir>,
    pub total_bytes: u64,
    /// 审查标记总数 / 仍然有效 / 已失效。
    ///
    /// 这里的「有效」只按**文件本身**判（还在、mtime 与长度没变）：版本号有没有变要
    /// 扫一遍工作副本才知道（7.6 秒），而维护面板不该为了三个数字付这个代价。
    /// 所以 revision 维度失效的标记会算在「有效」里，但它在改动列表里已经不生效了。
    pub review_total: usize,
    pub review_valid: usize,
    pub review_stale: usize,
}

/// 维护面板：列出备份目录与审查标记统计。只读，不碰磁盘内容。
#[tauri::command]
pub async fn svn_housekeeping(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<HousekeepingInfo, String> {
    let cfg = state.config.read().await.clone();
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = root_of(&cfg)?;
        let bases = backup_bases(&root, &st.config_dir);
        let backups = svn_backup::scan_all(&bases);
        let total_bytes = backups.iter().map(|b| b.bytes).sum();
        let store = ReviewStore::load(&st.config_dir);
        let review_total = store.marks.len();
        let mut review_valid = 0;
        for (key, mark) in &store.marks {
            let p = mark.fs_path(key);
            let (Some(mt), Ok(md)) = (mtime_ms(p), std::fs::metadata(p)) else {
                continue;
            };
            if mark.mtime_ms == mt && mark.size == md.len() {
                review_valid += 1;
            }
        }
        Ok(HousekeepingInfo {
            base_dir: bases
                .first()
                .map(|b| b.display().to_string())
                .unwrap_or_default(),
            backups,
            total_bytes,
            review_total,
            review_valid,
            review_stale: review_total.saturating_sub(review_valid),
        })
    })
    .await
    .map_err(|e| format!("盘点备份目录失败: {e}"))?
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupPurgeResult {
    pub deleted: usize,
    pub bytes: u64,
    /// 逐个删时失败的条目。一次失败不该把前面已删的数字吞掉——不可回滚，
    /// 用户需要知道「删了几个、释放多少、哪几个没删掉」。
    pub failed: Vec<PurgeFailure>,
}

#[derive(Debug, Serialize)]
pub struct PurgeFailure {
    pub name: String,
    pub message: String,
}

/// 删除指定的备份目录（按**目录名**，不按路径）。
///
/// 名字与父目录的校验在 `svn_backup::confirm_target` 里，这里只负责取基线目录。
/// 单个失败不中断整批：继续删剩下的，失败的条目连原因一起回给前端。
#[tauri::command]
pub async fn svn_backup_delete(
    state: tauri::State<'_, Arc<AppState>>,
    names: Vec<String>,
) -> Result<BackupPurgeResult, String> {
    if names.is_empty() {
        return Err("没有选中要删除的备份".to_string());
    }
    let cfg = state.config.read().await.clone();
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = root_of(&cfg)?;
        let bases = backup_bases(&root, &st.config_dir);
        let mut out = BackupPurgeResult {
            deleted: 0,
            bytes: 0,
            failed: Vec::new(),
        };
        for name in &names {
            match svn_backup::delete(&bases, name) {
                Ok(n) => {
                    out.bytes += n;
                    out.deleted += 1;
                }
                Err(e) => out.failed.push(PurgeFailure {
                    name: name.clone(),
                    message: e,
                }),
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("删除备份失败: {e}"))?
}

/// 保存用户输入的账号密码（密码 DPAPI 加密后落盘）。
///
/// **先联网验证再落盘**：以前这里只写配置、什么都不校验，界面写「验证中…」而实际
/// 错误密码也回「账号已保存」——错误要等下一次 commit/update 才爆，用户还记得
/// 「刚才明明验证过了」。校验用一次 `log`（limit=1）：它是真正走服务器鉴权的轻量调用。
/// 验证失败时连桥也不能留（里面已经装上了这份错凭据），重启它再报错。
#[tauri::command]
pub async fn svn_auth_set(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    user: String,
    password: String,
) -> Result<(), String> {
    if user.trim().is_empty() || password.is_empty() {
        return Err("账号和密码都不能为空".to_string());
    }
    let user = user.trim().to_string();
    let cfg = state.config.read().await.clone();
    let st = state.inner().clone();
    let (bridge, root) = {
        let home_cfg = cfg.clone();
        let st2 = st.clone();
        let app2 = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let root = root_of(&home_cfg)?;
            let bridge = bridge_for(&app2, &st2, &home_cfg)?;
            Ok::<_, String>((bridge, root))
        })
        .await
        .map_err(|e| format!("取 SVN 桥失败: {e}"))??
    };

    let probe = {
        let user = user.clone();
        // 密码要留在外面落盘（DPAPI），闭包里只能用一份副本
        let pass = password.clone();
        let root = root.display().to_string();
        let bridge = bridge.clone();
        tauri::async_runtime::spawn_blocking(move || {
            bridge
                .call("auth", &[&user, &pass], T_NET)
                .map_err(|e| split_code_label(e.code, e.message))?;
            // limit=1：只要「服务器认这个账号」这一条信息，不关心历史内容
            bridge
                .call("log", &[&root, "1", "0"], T_NET)
                .map_err(|e| split_code_label(e.code, e.message))
        })
        .await
        .map_err(|e| format!("验证账号失败: {e}"))?
    };
    if let Err(e) = probe {
        // 桥里现在是这份错凭据，留着会让后续所有调用都以为已登录
        bridge.restart();
        return Err(if parse_code(&e) == "auth" {
            "auth|密码不正确（或这个账号没有该仓库的读权限），没有保存".to_string()
        } else {
            e
        });
    }

    let enc = svn_cred::dpapi_protect(password.as_bytes())?;
    let encoded = svn_cred::b64_encode(&enc);
    state
        .update_config(|c| {
            c.svn_user = Some(user.clone());
            c.svn_password_dpapi = Some(encoded.clone());
            Ok(())
        })
        .await?;
    Ok(())
}

/// 从 `code|message` 里取 code（与 `split_code_label` 对称）。
fn parse_code(e: &str) -> &str {
    match e.find('|') {
        Some(i) => &e[..i],
        None => "",
    }
}
