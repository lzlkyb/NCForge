//! 自动更新相关的 IPC 命令（`start_update` / `check_update`）与其私有辅助。
//!
//! 从 `commands.rs` 拆出来的第一块（D19 方案 C 第 1 批）。选它打头阵的理由：
//! 4 个私有辅助（`retry_with_backoff` / `resolve_update_endpoints` /
//! `candidate_endpoint_groups` / `build_updater`）**全部只被本模块调用**，与其它域零耦合，
//! 因此这一批能干净地验证「`pub use` 重导出 + `main.rs` 的 `invoke_handler!` 零改动」
//! 这套机制到底成不成立——机制若不成立，在这里暴露远比在大搬动里暴露好查。
//!
//! 本文件是**纯搬动**：函数体逐字节未改，可用 `tools/fingerprint.py` 比对哈希验证。
//! 唯一新增的是下面这行 import —— 区块内 13 处 `.emit()` 需要 `Emitter` trait 在作用域，
//! 其余外部符号（`url::Url` / `tauri_plugin_updater::` / `serde_json::` 等）原本就是全限定路径。

use tauri::Emitter;

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

/// 指数退避重试辅助函数。
///
/// `should_retry` 决定某个错误是否值得再试一次。**不能无条件重试**：更新源返回
/// "没有可用 manifest" 这类确定性结论时，重试 N 次只会让用户多等 N 次退避
/// （2026-10-22 实测：Gitee 源的 releases 分支失效后 404，旧逻辑每次检查白等
/// 1s+2s 共 3.5 秒才回退到 ghproxy，用户感知就是"点更新要转半天"）。
async fn retry_with_backoff<F, Fut, T, E>(
    max_retries: u32,
    operation_name: &str,
    should_retry: impl Fn(&E) -> bool,
    f: F,
) -> Result<T, E>
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = Result<T, E>>,
    E: std::fmt::Display,
{
    let mut attempt = 0u32;
    loop {
        match f().await {
            Ok(val) => return Ok(val),
            Err(e) => {
                if !should_retry(&e) {
                    log::info!("[Update] {operation_name} 遇到不可重试错误，立即换源: {e}");
                    return Err(e);
                }
                attempt += 1;
                if attempt > max_retries {
                    return Err(e);
                }
                let delay_secs = 1u64 << (attempt - 1);
                // +0–511ms 抖动：无抖动时，一次服务端抖动恢复会让所有客户端在
                // 同一刻齐刷刷回源（惊群），刚缓过来的源又被自己打回去。抖动量
                // 取系统时钟纳秒取模而非 rand crate——更新链路不引新依赖
                // （二进制体积是核心卖点），且这里要的只是"错开"，不是密码学随机。
                let jitter_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| (d.subsec_nanos() % 512) as u64);
                log::warn!(
                    "[Update] {} 失败（第 {}/{} 次），{}s+{}ms 后重试: {}",
                    operation_name,
                    attempt,
                    max_retries,
                    delay_secs,
                    jitter_ms,
                    e
                );
                tokio::time::sleep(std::time::Duration::from_millis(
                    delay_secs * 1000 + jitter_ms,
                ))
                .await;
            }
        }
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
/// 超时设 180s：插件的 `timeout` 同时作用于 manifest 检查与安装包下载（`Update`
/// 的 timeout 从 `Updater` 直传，无法只给一头设）。manifest 是几 KB 的小文件，
/// 180 秒只为防"服务器收下连接再不响应"的永久挂死（reqwest 默认无总超时，
/// 挂死时徽章会转到天荒地老）；安装包实测 ≤15MB，180s ≈ 83KB/s 的兜底网速，
/// 更慢还有重试 2 次 + 换源兜底。常见场景不受影响：端点 404 走 ReleaseNotFound
/// 秒回（不可重试），端点通畅也是秒回——只有"端点活着但不响应"的罕见死链
/// 才会真的吃满 180s。
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
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| format!("更新插件初始化失败: {e}"))
}

/// 后台执行更新检查+下载安装，通过 Tauri event 推送状态到前端。
/// 按 `candidate_endpoint_groups` 的顺序依次尝试候选源（默认 Gitee 优先、ghproxy/GitHub
/// 回退），前一个候选检查或下载任一步失败就换下一个，全部失败才报错。内置指数退避重试：
/// 每个候选内检查最多重试 2 次、下载安装最多重试 2 次。
#[tauri::command]
pub fn start_update<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    // 已有任务在跑就直接忽略本次触发（事件由在跑的那个推送，不重复发状态）。
    static RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    let Some(guard) = SingleFlight::acquire(&RUNNING) else {
        log::info!("更新任务已在进行，忽略重复触发");
        return;
    };
    tauri::async_runtime::spawn(async move {
        let _guard = guard; // 持有到任务结束（含所有 early return）
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
        for endpoints in groups {
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

            let update = match check_result {
                Some(u) => u,
                None => {
                    // 下载链路不负责"已是最新"判定（那是 check_update 的事）。
                    // 这里返回 None 说明下载前复查没拿到可用更新，发 error 而非 uptodate，
                    // 避免把用户手上已有的可用更新静默清空；不再尝试下一个候选（各源应给出一致结论，
                    // 换源重试只会徒增耗时）。
                    let _ = app.emit(
                        "update:error",
                        serde_json::json!({
                            "message": "下载前复查未找到可用更新，可能已发布新版本，请重新检查",
                            "code": "stale"
                        }),
                    );
                    return;
                }
            };

            let date_str = update.date.map(|d| d.to_string());
            let current_ver = update.current_version.clone();
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
            // 下载阶段保持「任何错误都重试」的原有语义：这里失败多半是链路抖动，
            // 且重试会从头下载，代价可控；换源由外层 `continue` 负责。
            let result = retry_with_backoff(
                2,
                "下载安装",
                |_: &tauri_plugin_updater::Error| true,
                || {
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
                        u.download_and_install(
                            move |chunk_len, total| {
                                downloaded_total += chunk_len as u64;
                                window_bytes += chunk_len as u64;
                                let elapsed = window_start.elapsed();
                                if elapsed.as_millis() >= 250 {
                                    last_bytes_per_sec =
                                        window_bytes as f64 / elapsed.as_secs_f64();
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
                                // 🔴 插件这个回调是 on_download_finish（updater.rs:712），触发点在
                                // verify_signature **之前**。绝不能在这里发 update:ready——验签失败
                                // 时前端会误进自动重启倒计时并 relaunch，而更新根本没装上
                                // （2026-10-18 假签名实测：失败后 +9.2s app 被自行重启）。
                                // update:ready 改到 download_and_install 成功返回之后发（见 match）。
                            },
                        )
                        .await
                    }
                },
            )
            .await;

            match result {
                Ok(()) => {
                    // 下载 + 验签 + 安装全部成功才宣告 ready，前端据此起自动重启倒计时。
                    // Windows NSIS 路径走不到这里：install_inner 以 process::exit(0) 收尾，
                    // 重启由安装器负责；macOS/Linux 走到这里，事件才有意义。
                    let _ = app.emit("update:ready", ());
                    return; // 这个源成功，结束
                }
                Err(e) => {
                    last_code = classify_update_error(&e);
                    last_message = Some(format!("下载安装失败: {e}"));
                    continue; // 换下一个候选源重试
                }
            }
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
}

/// 只检查更新、不下载，通过 Tauri event 把结果推给前端用于展示徽章。
/// 与 `start_update` 共用 `updater.check()`、指数退避重试与候选源回退顺序，确保检查逻辑
/// 只有这一处实现（单一真相源）。
#[tauri::command]
pub fn check_update<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    // 与下载任务**分开**的闸：检查和下载可以并存，但各自不能重入。
    static RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    let Some(guard) = SingleFlight::acquire(&RUNNING) else {
        log::info!("更新检查已在进行，忽略重复触发");
        return;
    };
    tauri::async_runtime::spawn(async move {
        let _guard = guard;
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
                    let date_str = u.date.map(|d| d.to_string());
                    let current_ver = u.current_version.clone();
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tauri_plugin_updater::Error as UpdaterError;

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
