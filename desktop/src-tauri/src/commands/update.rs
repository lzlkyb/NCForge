//! 自动更新相关的 IPC 命令（检查、下载与确认安装）及其私有辅助。
//!
//! 从 `commands.rs` 拆出来的第一块（D19 方案 C 第 1 批）。选它打头阵的理由：
//! 4 个私有辅助（`retry_with_backoff` / `resolve_update_endpoints` /
//! `candidate_endpoint_groups` / `build_updater`）**全部只被本模块调用**，与其它域零耦合，
//! 因此这一批能干净地验证「`pub use` 重导出 + `main.rs` 的 `invoke_handler!` 零改动」
//! 这套机制到底成不成立——机制若不成立，在这里暴露远比在大搬动里暴露好查。
//!
//! 下载与安装分离：后台仅下载并验签，用户确认并完成工作预检后才启动安装器。

use base64::{engine::general_purpose::STANDARD, Engine};
use tauri::{Emitter, Manager};

// 指数退避重试与资源包下载共用（见 retry.rs）；本文件只传 should_retry 策略。
use crate::retry::retry_with_backoff;

// 检查、下载与安装共用闸，避免旧检查的迟到终态覆盖正在下载或已就绪的状态。
static UPDATE_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

struct CachedPackage {
    bytes: Vec<u8>,
    installed: bool,
}

impl CachedPackage {
    fn install<E>(&mut self, install: impl FnOnce(&[u8]) -> Result<(), E>) -> Result<(), E> {
        if self.installed {
            return Ok(());
        }
        // 安装失败保留已验签字节；成功释放包，但保留标记避免重复启动安装器。
        install(&self.bytes)?;
        self.bytes = Vec::new();
        self.installed = true;
        Ok(())
    }
}

struct PreparedUpdate {
    update: tauri_plugin_updater::Update,
    package: CachedPackage,
}

#[derive(Default)]
struct UpdateCache {
    pending: std::sync::Mutex<Option<PreparedUpdate>>,
}

fn update_cache<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::State<'_, UpdateCache> {
    // manage 已存在时不会替换状态；每个应用只保留一个包，检查与重复点击均不清空它。
    app.manage(UpdateCache::default());
    app.state::<UpdateCache>()
}

fn package_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<std::path::PathBuf> {
    Some(app.path().app_cache_dir().ok()?.join("verified-update.pkg"))
}

fn persist_package<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    bytes: &[u8],
) -> std::io::Result<()> {
    use std::io::Write;
    let path = package_path(app).ok_or_else(|| std::io::Error::other("无法定位更新缓存目录"))?;
    let dir = path
        .parent()
        .ok_or_else(|| std::io::Error::other("更新缓存目录无效"))?;
    std::fs::create_dir_all(dir)?;
    let mut temporary = tempfile::NamedTempFile::new_in(dir)?;
    temporary.write_all(bytes)?;
    temporary.as_file().sync_all()?;
    temporary.persist(path)?;
    Ok(())
}

fn verify_package(bytes: &[u8], signature: &str, public_key: &str) -> Result<(), String> {
    let decode = |value: &str| {
        String::from_utf8(STANDARD.decode(value).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())
    };
    let key =
        minisign_verify::PublicKey::decode(&decode(public_key)?).map_err(|e| e.to_string())?;
    let sig = minisign_verify::Signature::decode(&decode(signature)?).map_err(|e| e.to_string())?;
    key.verify(bytes, &sig, true).map_err(|e| e.to_string())
}

fn verify_update<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    update: &tauri_plugin_updater::Update,
    bytes: &[u8],
) -> Result<(), String> {
    let version = semver::Version::parse(&update.version).map_err(|e| e.to_string())?;
    if version <= app.package_info().version {
        return Err("更新包版本不高于当前版本".into());
    }
    let key = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|config| config.get("pubkey"))
        .and_then(serde_json::Value::as_str)
        .ok_or("无法读取更新验签公钥")?;
    verify_package(bytes, &update.signature, key)
}

fn restore_package<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    update: &tauri_plugin_updater::Update,
) -> bool {
    let Some(path) = package_path(app) else {
        return false;
    };
    let Ok(bytes) = std::fs::read(path) else {
        return false;
    };
    // 使用当前平台和版本的在线清单签名，旧包或损坏的包不会进入就绪状态。
    if verify_update(app, update, &bytes).is_err() {
        return false;
    }
    let cache = update_cache(app);
    let Ok(mut pending) = cache.pending.lock() else {
        return false;
    };
    *pending = Some(PreparedUpdate {
        update: update.clone(),
        package: CachedPackage {
            bytes,
            installed: false,
        },
    });
    true
}

fn emit_cached_ready<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<bool, String> {
    let update = update_cache(app)
        .pending
        .lock()
        .map_err(|_| "更新缓存暂时不可用，请重新启动软件".to_string())?
        .as_ref()
        .map(|prepared| prepared.update.clone());
    if let Some(update) = update {
        // ready 代表已下载并验签，不代表已安装。元数据可恢复重新打开的前端。
        let _ = app.emit(
            "update:ready",
            serde_json::json!({
                "version": update.version,
                "body": update.body,
                "date": update.date.map(|date| date.to_string()),
                "currentVersion": update.current_version,
            }),
        );
        return Ok(true);
    }
    Ok(false)
}

// ===== 自动更新（后台线程，不阻塞 UI），採自 PastePanda 实现 =====

/// 单飞闸：同一时刻只允许一个更新 / 检查任务在跑。
///
/// 🔴 为什么需要（审查 P2）：`start_update` / `check_update` 是 **spawn 后立即返回**的，
/// 前端却把 `await invoke(...)` 当成「做完了」的信号。于是连点两次徽章 = 两个任务并发，
/// 一边下载一边又被另一个重试覆盖，`update:*` 事件交叉推送，前端状态机直接乱掉。
/// RAII 式持有：任务（含所有提前 return 分支）结束自动释放。
struct SingleFlight(&'static std::sync::atomic::AtomicBool);

impl SingleFlight {
    fn acquire(flag: &'static std::sync::atomic::AtomicBool) -> Option<Self> {
        flag.compare_exchange(
            false,
            true,
            std::sync::atomic::Ordering::SeqCst,
            std::sync::atomic::Ordering::SeqCst,
        )
        .ok()
        .map(|_| Self(flag))
    }
}

impl Drop for SingleFlight {
    fn drop(&mut self) {
        self.0.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// 更新错误的机器可读类别。
///
/// `is_retryable_check_error`（要不要重试）与 `classify_update_error`（给前端什么标签）
/// 共用这一套归类——历史上两处各维护一份列表，注释里还得写"注意与本函数保持一致"，
/// 漂移只是时间问题。改成单一真相源：这里加一类，两边同时生效。
enum ErrorClass {
    /// 源内容确定性坏：404/5xx、JSON 反序列化失败、版本号/日期解析失败、缺当前平台条目。
    /// 再请求一次还是一样的坏 manifest，重试唯一的效果是让用户多等一轮退避。
    Manifest,
    /// 端点/协议配置错：URL 不合法、非 https、没有端点、平台不支持、请求头非法。
    Config,
    /// 验签失败：包可能被篡改或下载损坏，必须与「普通下载失败」区分开。
    Signature,
    /// 链路超时。
    Timeout,
    /// 链路抖动：连接重置、TLS 抖动、临时 5xx、代理认证失败。值得再试一次。
    Network,
    /// 包已经下到本地，卡在落盘 / 解开 / 启动安装器。
    Install,
    /// 插件新增的未分类变体：保守视为可重试、标签 unknown（前端回退字符串启发式）。
    Unknown,
}

/// 把插件错误映射到 [`ErrorClass`]。插件 enum 是 `#[non_exhaustive]`，
/// 通配分支保证升级插件版本时编译不破、行为保守。
fn error_class(err: &tauri_plugin_updater::Error) -> ErrorClass {
    use tauri_plugin_updater::Error as UpdaterError;
    match err {
        UpdaterError::ReleaseNotFound
        | UpdaterError::TargetNotFound(_)
        | UpdaterError::TargetsNotFound(_)
        | UpdaterError::Serialization(_)
        | UpdaterError::Semver(_)
        | UpdaterError::FormatDate => ErrorClass::Manifest,
        UpdaterError::EmptyEndpoints
        | UpdaterError::UnsupportedOs
        | UpdaterError::UnsupportedArch
        | UpdaterError::UrlParse(_)
        | UpdaterError::InsecureTransportProtocol
        | UpdaterError::Http(_)
        | UpdaterError::InvalidHeaderValue(_)
        | UpdaterError::InvalidHeaderName(_) => ErrorClass::Config,
        UpdaterError::Minisign(_) | UpdaterError::SignatureUtf8(_) | UpdaterError::Base64(_) => {
            ErrorClass::Signature
        }
        UpdaterError::Reqwest(e) if e.is_timeout() => ErrorClass::Timeout,
        UpdaterError::Reqwest(_) => ErrorClass::Network,
        UpdaterError::Network(_) | UpdaterError::AuthenticationFailed => ErrorClass::Network,
        UpdaterError::Io(_)
        | UpdaterError::PackageInstallFailed
        | UpdaterError::DebInstallFailed
        | UpdaterError::TempDirNotOnSameMountPoint
        | UpdaterError::TempDirNotFound
        | UpdaterError::BinaryNotFoundInArchive
        | UpdaterError::InvalidUpdaterFormat
        | UpdaterError::FailedToDetermineExtractPath
        | UpdaterError::Tauri(_) => ErrorClass::Install,
        // `Extract` 是插件的 Windows 专属变体（插件侧 `#[cfg(all(target_os = "windows",
        // feature = "zip"))]`，zip 是默认 feature 且本项目没关默认特性），并进上面的
        // or-pattern 会让 macOS 编译不过（E0599，2026-10-28 首次 CI 实测）。
        #[cfg(target_os = "windows")]
        UpdaterError::Extract(_) => ErrorClass::Install,
        _ => ErrorClass::Unknown,
    }
}

/// 判断「检查更新」的错误是否值得重试。
///
/// `Manifest` 与 `Config` 两类都是**确定性**结论 —— 源上压根没有可用 manifest
/// （404 / 空响应 / JSON 坏 / 版本号或日期解析失败 / 缺当前平台条目），或端点配置本身
/// 不合法。再请求一次还是同样的结果，唯一效果是让用户多等一轮退避
/// （2026-10-22 实测：Gitee 源的 releases 分支失效后 404，旧逻辑每次检查白等
/// 1s+2s 共 3.5 秒才回退到 ghproxy，用户感知就是"点更新要转半天"）。
/// 其余错误（连接超时、TLS 抖动、临时 5xx）保留重试。
fn is_retryable_check_error(err: &tauri_plugin_updater::Error) -> bool {
    !matches!(error_class(err), ErrorClass::Manifest | ErrorClass::Config)
}

/// 判断「下载安装包」的错误是否值得重试。
///
/// 与检查阶段不同，下载失败的代价是**整个包**：重试会从头再下一遍（实测 8.4MB～58MB）。
/// 所以判据比检查更严——只有签名/解析类错误被排除在外也不太够，但其余（连接重置、
/// 超时、代理断流、IO 中断）确实可能一次成功，保留重试。
///
/// 🔴 **验签失败必须是不可重试**：同一个源、同一个包，字节不会变，重试 N 次都是
/// 同样的 `Minisign` 错误。2026-11-10 v0.4.0 事故里 Gitee 清单的签名属于上一轮构建、
/// 与附件包不匹配，每个平台白下 3 次（首次 + 重试 2 次）才换源，用户看到的就是
/// 「下载完了又自己重新下载」。
fn is_retryable_download_error(err: &tauri_plugin_updater::Error) -> bool {
    !matches!(error_class(err), ErrorClass::Signature)
}

/// 给更新失败打一个**机器可读**的原因标签，随 `update:error` 一起发给前端。
///
/// 为什么不用字符串判断：前端原先靠 `includes("fetch")` 之类猜原因，而插件的错误文案
/// 是英文常量（`Could not fetch a valid release JSON from the remote`），一句文案改动
/// 就能让整套翻译失效 —— 2026-10-22 实测就是这样：源上 404（根本没有 manifest）被
/// 翻译成「网络连接失败，请检查网络后重试」，而真正的网络错误
/// （`error sending request`）反而落到兜底「更新失败，请重试」。
///
/// 返回的标签由前端 `ERROR_TEXT` 表消费，**不要在日志或 UI 里直接展示**。
/// 标签集合与 `error_class` 一一对应，新增类别只改 `error_class` 一处。
fn classify_update_error(err: &tauri_plugin_updater::Error) -> &'static str {
    match error_class(err) {
        ErrorClass::Manifest => "manifest",
        ErrorClass::Config => "config",
        ErrorClass::Signature => "signature",
        ErrorClass::Timeout => "timeout",
        ErrorClass::Network => "network",
        ErrorClass::Install => "install",
        ErrorClass::Unknown => "unknown",
    }
}

/// 解析更新源端点：优先环境变量 `APP_UPDATE_ENDPOINT`（逗号分隔多 URL，按顺序故障转移），
/// 未设置或解析为空则返回 `None`（退回 `tauri.conf.json` 的 `plugins.updater.endpoints`）。
fn resolve_update_endpoints() -> Result<Option<Vec<url::Url>>, String> {
    let raw = match std::env::var("APP_UPDATE_ENDPOINT") {
        Ok(v) if !v.trim().is_empty() => v,
        _ => return Ok(None),
    };
    let mut eps = Vec::new();
    for part in raw.split(',') {
        let trimmed = part.trim();
        if trimmed.is_empty() {
            continue;
        }
        match url::Url::parse(trimmed) {
            Ok(u) => eps.push(u),
            Err(e) => return Err(format!("更新源 \"{trimmed}\" 不是合法 URL: {e}")),
        }
    }
    if eps.is_empty() {
        Ok(None)
    } else {
        Ok(Some(eps))
    }
}

/// Gitee 镜像仓库路径（owner/repo），**默认不启用**——设了环境变量
/// `APP_GITEE_REPOSITORY=owner/repo` 才把 Gitee 列为第一候选。
///
/// 启用后：CI 需要把每次发版的产物 + manifest 同步到该仓库的 `releases` 分支
/// `latest/` 目录（见 .github/workflows/build.yml 的可选镜像步骤）。国内访问远比
/// 任何公共 GitHub 代理稳定；失败时自动回退到 tauri.conf.json 配置的端点
/// （见 candidate_endpoint_groups）。
///
/// 为何默认关：没配镜像时第一候选必然 404，每次检查更新白等一轮退避重试
/// （2026-10-22 实测：旧逻辑每次检查多花 3.5 秒）。
fn gitee_repository() -> Option<String> {
    match std::env::var("APP_GITEE_REPOSITORY") {
        Ok(v) if !v.trim().is_empty() => Some(v.trim().to_string()),
        _ => None,
    }
}

/// 候选更新源分组，按顺序尝试：前一组检查或下载任一步失败，才换下一组。
/// 手动 env 覆盖（APP_UPDATE_ENDPOINT）存在时只用这一组、不做自动换源，保持覆盖语义单一可预期。
fn candidate_endpoint_groups() -> Result<Vec<Option<Vec<url::Url>>>, String> {
    if let Some(eps) = resolve_update_endpoints()? {
        return Ok(vec![Some(eps)]);
    }
    let mut groups = Vec::new();
    if let Some(repo) = gitee_repository() {
        let gitee_url = format!("https://gitee.com/{repo}/raw/releases/latest/updater-gitee.json");
        let gitee =
            url::Url::parse(&gitee_url).map_err(|e| format!("Gitee 更新源 URL 无效: {e}"))?;
        groups.push(Some(vec![gitee]));
    }
    groups.push(None); // 退回 tauri.conf.json 配置的端点
    Ok(groups)
}

/// 构造 `Updater`：注入指定的端点（若有），否则用配置端点。
/// 供 `check_update` / `start_update` 共用，确保更新源解析只有这一处实现（单一真相源）。
/// 泛型 `R: Runtime`：让 mock 运行时的集成测试也能驱动作命令（见文件末尾测试）。
///
/// 清单检查使用短超时，下载时为同一版本单独设置较长的包传输超时。
fn build_updater<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    endpoints: Option<Vec<url::Url>>,
) -> Result<tauri_plugin_updater::Updater, String> {
    use std::time::Duration;
    use tauri_plugin_updater::UpdaterExt;
    let app_handle = app.clone();
    let mut builder = app_handle.updater_builder();
    if let Some(eps) = endpoints {
        builder = builder
            .endpoints(eps)
            .map_err(|e| format!("更新源配置无效（需 https）: {e}"))?;
    }
    builder
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("更新插件初始化失败: {e}"))
}

/// 后台执行更新检查、下载与验签，通过 Tauri event 推送状态到前端。
/// 按 `candidate_endpoint_groups` 的顺序依次尝试候选源（默认 Gitee 优先、ghproxy/GitHub
/// 回退），前一个候选检查或下载任一步失败就换下一个，全部失败才报错。内置指数退避重试：
/// 每个候选内检查最多重试 2 次、下载最多重试 2 次；这里绝不启动安装器。
#[tauri::command]
pub fn start_update<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    // 明确拒绝忙时请求：前端不能把 spawn 调用被忽略误认为下载已经开始。
    let Some(guard) = SingleFlight::acquire(&UPDATE_RUNNING) else {
        return Err("更新任务正在进行，请稍后再试".into());
    };
    tauri::async_runtime::spawn(async move {
        let _guard = guard; // 持有到任务结束（含所有 early return）
        match emit_cached_ready(&app) {
            Ok(true) => return,
            Ok(false) => {}
            Err(message) => {
                let _ = app.emit("update:error", serde_json::json!({ "message": message }));
                return;
            }
        }
        let _ = app.emit("update:checking", ());

        let groups = match candidate_endpoint_groups() {
            Ok(g) => g,
            Err(e) => {
                let _ = app.emit("update:error", serde_json::json!({ "message": e }));
                return;
            }
        };

        let mut last_message: Option<String> = None;
        // 最近一次失败的机器可读原因，随 update:error 一起发（见 classify_update_error）。
        let mut last_code: &'static str = "unknown";
        // 所有候选源都明确报告「没有更新」时为 true：用户点了下载却无更新可下，
        // 循环外要发 stale 而不是「全部源失败：未知错误」。
        let mut stale = false;
        for (idx, endpoints) in groups.into_iter().enumerate() {
            if idx > 0 {
                let _ = app.emit("update:source", ());
            }
            let updater = match build_updater(&app, endpoints) {
                Ok(u) => u,
                Err(e) => {
                    last_message = Some(e);
                    last_code = "config";
                    continue;
                }
            };

            let check_result =
                match retry_with_backoff(2, "检查更新", is_retryable_check_error, || {
                    updater.check()
                })
                .await
                {
                    Ok(r) => r,
                    Err(e) => {
                        last_code = classify_update_error(&e);
                        last_message = Some(format!("检查更新失败: {e}"));
                        continue;
                    }
                };

            let mut update = match check_result {
                Some(u) => u,
                None => {
                    // None = 这个源明确报告没有更新。**不在这里 return 发 error**：
                    // 多源场景下（如 Gitee 镜像同步延迟），第一个源的 None 会把后续源上
                    // 真正可用的更新静默吞掉——用户永远收不到 GitHub 上的新版本。
                    // check_update 已修过同一类问题（见其 Ok(None) 分支注释），孪生函数
                    // 这里漏修。记录 stale 并继续问后续源；全部源都 None 时循环外
                    // 统一发 stale 错误（那时确实是「点了下载却没更新可下」）。
                    log::info!("[Update] 候选源报告已是最新，继续问后续源");
                    stale = true;
                    continue;
                }
            };

            let date_str = update.date.map(|d| d.to_string());
            let current_ver = update.current_version.clone();
            if restore_package(&app, &update) {
                drop(_guard);
                let _ = emit_cached_ready(&app);
                return;
            }
            update.timeout = Some(std::time::Duration::from_secs(180));
            let _ = app.emit(
                "update:available",
                serde_json::json!({
                    "version": update.version,
                    "body": update.body,
                    "date": date_str,
                    "currentVersion": current_ver,
                }),
            );

            let _ = app.emit("update:downloading", ());

            let app_progress = app.clone();
            // 网络类失败照常重试（链路抖动、连接重置，重试真的可能成）；但**验签失败
            // 是确定性结论**——同一个源、同一个包，再下一次还是同样的字节、同样的签名，
            // 重试只会让用户多付一次全量流量。
            // v0.4.0 实测：Gitee 清单的签名属于上一轮构建，与附件包不匹配，每个平台
            // 白下 3 次（1 次 + 重试 2 次）8.4MB 才换源，用户看到的就是「下载完了又
            // 自己重新下载」。验签失败立刻换源，代价从 4 次下载降到 2 次。
            let result = retry_with_backoff(2, "下载更新", is_retryable_download_error, || {
                let u = update.clone();
                let ap = app_progress.clone();
                async move {
                    let mut downloaded_total: u64 = 0;
                    // 下载速度：窗口限流计算（~250ms 重算一次），不是每个 chunk 都重算——
                    // 快网速下 chunk 回调可能每秒触发好几十次，逐次算瞬时速率会跳得难看。
                    // downloaded/total 仍每 chunk 都发（百分比保持平滑），只有 bytesPerSec 在窗口
                    // 间隔内复用上一次算出的值。
                    let mut window_start = std::time::Instant::now();
                    let mut window_bytes: u64 = 0;
                    let mut last_bytes_per_sec: f64 = 0.0;
                    u.download(
                        move |chunk_len, total| {
                            downloaded_total += chunk_len as u64;
                            window_bytes += chunk_len as u64;
                            let elapsed = window_start.elapsed();
                            if elapsed.as_millis() >= 250 {
                                last_bytes_per_sec = window_bytes as f64 / elapsed.as_secs_f64();
                                window_start = std::time::Instant::now();
                                window_bytes = 0;
                            }
                            let _ = ap.emit(
                                "update:progress",
                                serde_json::json!({
                                    "downloaded": downloaded_total,
                                    "total": total,
                                    "bytesPerSec": last_bytes_per_sec,
                                }),
                            );
                        },
                        || {
                            // 此回调在验签之前触发；调用方只能在 download 成功返回后
                            // 宣告 ready，验签失败时不能缓存包或允许用户安装。
                        },
                    )
                    .await
                }
            })
            .await;

            match result {
                Ok(bytes) => {
                    if let Err(error) = persist_package(&app, &bytes) {
                        log::warn!("[Update] 无法保存跨重启的更新包缓存: {error}");
                    }
                    let cache = update_cache(&app);
                    match cache.pending.lock() {
                        Ok(mut pending) => {
                            *pending = Some(PreparedUpdate {
                                update,
                                package: CachedPackage {
                                    bytes,
                                    installed: false,
                                },
                            });
                        }
                        Err(_) => {
                            let _ = app.emit(
                                "update:error",
                                serde_json::json!({
                                    "message": "更新缓存暂时不可用，请重新启动软件",
                                }),
                            );
                            return;
                        }
                    }
                    // Windows 的 install 会退出应用，因此 ready 必须在安装之前可见，
                    // 后续只由用户明确调用 install_update，不倒计时、不自动安装。
                    drop(_guard);
                    let _ = emit_cached_ready(&app);
                    return; // 这个源成功，结束
                }
                Err(e) => {
                    last_code = classify_update_error(&e);
                    last_message = Some(format!("下载更新失败: {e}"));
                    continue; // 换下一个候选源重试
                }
            }
        }

        if last_message.is_none() && stale {
            // 所有源都明确说没有更新：用户点了下载却无更新可下。
            // 发 error 而非 uptodate——uptodate 会把用户手上已有的可用更新状态
            // 静默清空（徽章消失、对话框关闭）。
            let _ = app.emit(
                "update:error",
                serde_json::json!({
                    "message": "下载前复查未找到可用更新，可能已发布新版本，请重新检查",
                    "code": "stale"
                }),
            );
            return;
        }

        let _ = app.emit(
            "update:error",
            serde_json::json!({
                "message": format!(
                    "全部更新源均失败（已依次尝试）: {}",
                    last_message.unwrap_or_else(|| "未知错误".into())
                ),
                "code": last_code
            }),
        );
    });
    Ok(())
}

/// 用户确认且前端已完成文件、事务与任务预检后，安装缓存的已验签包。
/// Windows 由安装器退出并重启；其它桌面平台返回后由前端 relaunch。
#[tauri::command]
pub async fn install_update<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    let Some(guard) = SingleFlight::acquire(&UPDATE_RUNNING) else {
        return Err("更新任务正在进行，请稍后再试".into());
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let cache = update_cache(&app);
        let mut prepared = cache
            .pending
            .lock()
            .map_err(|_| "更新缓存暂时不可用，请重新启动软件".to_string())?
            .take()
            .ok_or_else(|| "尚无已下载并验证的更新包，请先下载更新".to_string())?;
        let update = &prepared.update;
        let result = prepared.package.install(|bytes| {
            verify_update(&app, update, bytes)?;
            update.install(bytes).map_err(|error| error.to_string())
        });
        if result.is_ok() {
            if let Some(path) = package_path(&app) {
                let _ = std::fs::remove_file(path);
            }
        }
        // 不在安装器运行时持锁；失败也放回同一个包，用户重试无需重新下载。
        *cache
            .pending
            .lock()
            .map_err(|_| "更新缓存暂时不可用，请重新启动软件".to_string())? = Some(prepared);
        result.map_err(|error| format!("安装更新失败: {error}"))
    })
    .await
    .map_err(|error| format!("安装更新任务失败: {error}"))?
}

/// 只检查更新、不下载，通过 Tauri event 把结果推给前端用于展示徽章。
/// 与 `start_update` 共用 `updater.check()`、指数退避重试与候选源回退顺序，确保检查逻辑
/// 只有这一处实现（单一真相源）。
#[tauri::command]
pub fn check_update<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    let Some(guard) = SingleFlight::acquire(&UPDATE_RUNNING) else {
        return Err("更新任务正在进行，请稍后再试".into());
    };
    tauri::async_runtime::spawn(async move {
        let _guard = guard;
        match emit_cached_ready(&app) {
            Ok(true) => return,
            Ok(false) => {}
            Err(message) => {
                let _ = app.emit("update:error", serde_json::json!({ "message": message }));
                return;
            }
        }
        let _ = app.emit("update:checking", ());

        let groups = match candidate_endpoint_groups() {
            Ok(g) => g,
            Err(e) => {
                let _ = app.emit("update:error", serde_json::json!({ "message": e }));
                return;
            }
        };

        let mut last_message: Option<String> = None;
        let mut last_code: &'static str = "unknown";
        let total_groups = groups.len();
        for (idx, endpoints) in groups.into_iter().enumerate() {
            if idx > 0 {
                let _ = app.emit("update:source", ());
            }
            let updater = match build_updater(&app, endpoints) {
                Ok(u) => u,
                Err(e) => {
                    last_message = Some(e);
                    last_code = "config";
                    continue;
                }
            };

            match retry_with_backoff(2, "检查更新", is_retryable_check_error, || {
                updater.check()
            })
            .await
            {
                Ok(Some(u)) => {
                    if restore_package(&app, &u) {
                        drop(_guard);
                        let _ = emit_cached_ready(&app);
                        return;
                    }
                    let date_str = u.date.map(|d| d.to_string());
                    let current_ver = u.current_version.clone();
                    drop(_guard);
                    let _ = app.emit(
                        "update:available",
                        serde_json::json!({
                            "version": u.version,
                            "body": u.body,
                            "date": date_str,
                            "currentVersion": current_ver,
                        }),
                    );
                    return;
                }
                Ok(None) => {
                    // None = 这个源明确报告没有更新。**不在这里 return**：
                    // 多源场景下（如 Gitee 镜像同步延迟或路径指错），第一个源的
                    // None 会把后续源上真正可用的更新静默吞掉——用户看到"已是最新"，
                    // 日志里却毫无痕迹。改为记录并继续问后续源；全部问完仍无更新
                    // 才在循环外发 uptodate。单源场景（默认）行为不变。
                    log::info!("[Update] 候选源 {}/{} 报告已是最新", idx + 1, total_groups);
                    continue;
                }
                Err(e) => {
                    last_code = classify_update_error(&e);
                    last_message = Some(format!("检查更新失败: {e}"));
                    continue;
                }
            }
        }

        // 全部候选问完：无任何错误 ⇒ 确实没有更新；有错误 ⇒ 如实报错
        // （None 不是失败，不能拿 None 掩盖真的失败）。
        // 发终态前释放闸；收到 available 的前端可立即开始下载，不撞上已结束的检查。
        drop(_guard);
        match last_message {
            None => {
                let _ = app.emit("update:uptodate", ());
            }
            Some(msg) => {
                let _ = app.emit(
                    "update:error",
                    serde_json::json!({
                        "message": format!("全部更新源均检查失败（已依次尝试）: {msg}"),
                        "code": last_code
                    }),
                );
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tauri_plugin_updater::Error as UpdaterError;

    #[test]
    fn verifies_cached_package_against_manifest_signature() {
        // Known signed fixture from minisign-verify's public example.
        let key = STANDARD.encode(
            "untrusted comment: test key
RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3",
        );
        let sig = STANDARD.encode(concat!(
            "untrusted comment: signature from minisign secret key
",
            "RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=
",
            "trusted comment: timestamp:1633700835	file:test	prehashed
",
            "wLMDjy9FLAuxZ3q4NlEvkgtyhrr0gtTu6KC4KBJdITbbOeAi1zBIYo0v4iTgt8jJpIidRJnp94ABQkJAgAooBQ==",
        ));
        assert!(verify_package(b"test", &sig, &key).is_ok());
        assert!(verify_package(b"altered", &sig, &key).is_err());
    }

    #[test]
    fn update_single_flight_rejects_reentry_and_releases_on_drop() {
        static RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
        let first = SingleFlight::acquire(&RUNNING).expect("首次操作应可开始");
        assert!(SingleFlight::acquire(&RUNNING).is_none());
        drop(first);
        assert!(SingleFlight::acquire(&RUNNING).is_some());
    }

    #[test]
    fn failed_install_keeps_verified_package_for_retry() {
        let mut package = CachedPackage {
            bytes: vec![1, 2, 3],
            installed: false,
        };
        let result = package.install(|bytes| {
            assert_eq!(bytes, &[1, 2, 3]);
            Err("installer unavailable")
        });
        assert_eq!(result, Err("installer unavailable"));
        assert!(!package.installed);
        assert_eq!(package.bytes, vec![1, 2, 3]);
        assert_eq!(package.install(|_| Ok::<(), &str>(())), Ok(()));
        assert!(package.installed);
        assert!(package.bytes.is_empty());
    }

    #[test]
    fn installed_package_does_not_launch_installer_twice() {
        let mut package = CachedPackage {
            bytes: vec![1],
            installed: false,
        };
        let calls = std::cell::Cell::new(0);
        for _ in 0..2 {
            package
                .install(|_| {
                    calls.set(calls.get() + 1);
                    Ok::<(), &str>(())
                })
                .expect("安装应成功");
        }
        assert_eq!(calls.get(), 1);
    }

    /// 源上找不到 manifest（Gitee releases 分支失效时的真实形态）不该重试：
    /// 重试只会让用户多等一轮 1s+2s 退避。
    #[test]
    fn manifest_missing_is_not_retryable() {
        assert!(!is_retryable_check_error(&UpdaterError::ReleaseNotFound));
        assert!(!is_retryable_check_error(&UpdaterError::TargetNotFound(
            "windows-x86_64".into()
        )));
        assert!(!is_retryable_check_error(&UpdaterError::TargetsNotFound(
            vec!["windows-x86_64".into()]
        )));
    }

    /// manifest 内容确定性坏（JSON 反序列化失败、版本号/日期解析失败）同样不该重试：
    /// 换来的还是同一份坏 manifest。这类曾被误判为"其余错误保留重试"。
    #[test]
    fn deterministic_content_errors_are_not_retryable() {
        assert!(!is_retryable_check_error(&UpdaterError::FormatDate));
        assert!(!is_retryable_check_error(&UpdaterError::Serialization(
            serde_json::from_str::<i32>("not json").unwrap_err()
        )));
        assert!(!is_retryable_check_error(&UpdaterError::Semver(
            semver::Version::parse("not-a-version").unwrap_err()
        )));
    }

    /// 端点配置错（URL 不合法、非 https、没有端点、平台不支持）也不该重试：
    /// 配置不修，重试一万次还是同样的错。
    #[test]
    fn config_errors_are_not_retryable() {
        assert!(!is_retryable_check_error(&UpdaterError::UrlParse(
            url::ParseError::RelativeUrlWithoutBase
        )));
        assert!(!is_retryable_check_error(
            &UpdaterError::InsecureTransportProtocol
        ));
        assert!(!is_retryable_check_error(&UpdaterError::EmptyEndpoints));
        assert!(!is_retryable_check_error(&UpdaterError::UnsupportedOs));
    }

    /// 下载阶段的验签失败**不可重试**：同一个源、同一个包，字节不会变，重试 N 次都是
    /// 同一个 `Minisign` 错误，只会让用户多付 N 次全量流量。
    ///
    /// 2026-11-10 v0.4.0 实测：Gitee 清单的签名属于上一轮构建、与附件包不匹配，
    /// 每个平台白下 3 次（首次 + 重试 2 次）才换源 → 用户看到「下载完了又自己重新下载」。
    #[test]
    fn signature_errors_are_not_retryable_for_download() {
        assert!(!is_retryable_download_error(&UpdaterError::SignatureUtf8(
            "not base64".into()
        )));
        // 网络类仍然可重试：链路抖动一次失败，第二次真的可能成。
        assert!(is_retryable_download_error(&UpdaterError::Network(
            "connection reset by peer".into()
        )));
        assert!(is_retryable_download_error(&UpdaterError::Network(
            "unexpected end of file".into()
        )));
    }

    /// 链路抖动值得再试一次：换源前多试一轮是划算的。
    #[test]
    fn transient_errors_stay_retryable() {
        assert!(is_retryable_check_error(&UpdaterError::Network(
            "connection reset".into()
        )));
        assert!(is_retryable_check_error(
            &UpdaterError::AuthenticationFailed
        ));
        assert!(is_retryable_check_error(&UpdaterError::Io(
            std::io::Error::new(std::io::ErrorKind::ConnectionReset, "reset")
        )));
    }

    /// 源上没有 manifest（404/5xx/缺当前平台条目/内容确定性坏）必须与「网络故障」区分开：
    /// 前者该告诉用户「服务暂时不可用」，后者才是「检查网络」。
    /// 前端按这个标签出文案，所以标签本身不能漂。
    #[test]
    fn classify_separates_manifest_from_network() {
        assert_eq!(
            classify_update_error(&UpdaterError::ReleaseNotFound),
            "manifest"
        );
        assert_eq!(
            classify_update_error(&UpdaterError::TargetNotFound("windows-x86_64".into())),
            "manifest"
        );
        // manifest 内容坏（JSON/版本号/日期）同样归 manifest：源的问题，不是用户的网络问题。
        assert_eq!(classify_update_error(&UpdaterError::FormatDate), "manifest");
        assert_eq!(
            classify_update_error(&UpdaterError::Semver(
                semver::Version::parse("not-a-version").unwrap_err()
            )),
            "manifest"
        );
        assert_eq!(
            classify_update_error(&UpdaterError::Network("connection reset".into())),
            "network"
        );
        assert_eq!(
            classify_update_error(&UpdaterError::EmptyEndpoints),
            "config"
        );
        assert_eq!(
            classify_update_error(&UpdaterError::UnsupportedOs),
            "config"
        );
        // 端点 URL 不合法归 config：修配置，不是重试。
        assert_eq!(
            classify_update_error(&UpdaterError::UrlParse(
                url::ParseError::RelativeUrlWithoutBase
            )),
            "config"
        );
        // 落盘/安装失败与下载失败分开：前者多半是磁盘权限或磁盘空间。
        assert_eq!(
            classify_update_error(&UpdaterError::Io(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "denied"
            ))),
            "install"
        );
    }

    /// 不可重试错误必须**只调用一次**（改动前是 3 次，本测试即失败）。
    #[tokio::test]
    async fn non_retryable_error_is_attempted_once() {
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        let result: Result<(), UpdaterError> =
            retry_with_backoff(2, "检查更新", is_retryable_check_error, || {
                let counter = counter.clone();
                async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    Err(UpdaterError::ReleaseNotFound)
                }
            })
            .await;

        assert!(result.is_err());
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "404 类确定性错误不应重试（每次重试都要白等一轮退避）"
        );
    }

    /// 可重试错误保留原有语义：`max_retries=1` ⇒ 首次 + 重试 1 次 = 2 次调用。
    #[tokio::test]
    async fn retryable_error_is_attempted_again() {
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        let result: Result<(), UpdaterError> =
            retry_with_backoff(1, "检查更新", is_retryable_check_error, || {
                let counter = counter.clone();
                async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    Err(UpdaterError::Network("connection reset".into()))
                }
            })
            .await;

        assert!(result.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 2, "可重试错误应再试一次");
    }
}
