//! 代码智能命令：启停 jdt.ls，并把前端的 LSP 请求/通知透传过去。
//!
//! 这里不做 LSP 与 Monaco 的语义转换（前端做），只管三件事：
//! 1. 拉起：影子工程生成 → 启动 jdt.ls → 握手；
//! 2. 路径：真实文件路径与影子工程 URI 互转（见 `lang.rs`），前端永远只看到真实路径；
//! 3. 事件：`lang-status`（状态）、`lang-notify`（诊断等通知，URI 已换回真实路径）。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{Emitter, Manager};

use super::compile_cmds::{cached_index, resolve_module};
use crate::config::AppConfig;
use crate::lang::{validate_xmx, LangSession, LangStatus, DEFAULT_XMX_MB};
use crate::lsp::{
    build_initialize_params, build_settings, path_to_uri, JdtlsLaunch, LspClient, LspHandler,
};
use crate::nc_home::{self, NcHome};
use crate::shadow::{self, ShadowSpec};
use crate::state::AppState;

fn lock_lang(state: &AppState) -> std::sync::MutexGuard<'_, crate::lang::LangRun> {
    state.lang.lock().unwrap_or_else(|e| e.into_inner())
}

/// 更新状态并通知前端。
fn set_status(app: &tauri::AppHandle, state: &AppState, status: LangStatus) {
    lock_lang(state).status = status.clone();
    let _ = app.emit("lang-status", status);
}

/// jdt.ls 目录候选顺序：环境变量 `NCFORGE_JDTLS_DIR`（手动指定，最高优先）→
/// 外部资源包（按需下载安装，`config_dir/resources/jdtls@<version>`）→
/// 安装包资源目录（v0.1.0 及以前的旧安装兜底）→ 源码树资源（开发模式）。
///
/// 历史上这里还有第四个候选 `config_dir/jdtls`（给手工放置的用户留的门）。
/// 资源包外置后统一为 `config_dir/resources/` 一套约定——两个 config 目录布局
/// 并存只会漂移，手工放置的用户改走环境变量（错误信息里指明了）。
/// 一个 jdt.ls 目录是否**真的能跑起来**。
///
/// 只看 `plugins/` 存在不够：复制中断、`cargo clean` 后重跑 `jdtls:fetch` 只做了一半，
/// 都会留下「有 plugins 目录但缺 bundle」的半残目录。这种目录被选中后 equinox 会在
/// 启动早期崩掉（实测留下 `UnknownHostException: configuration` +
/// `EclipseStarter.searchForBundle` 的 NPE），而状态栏只会说「代码智能不可用」。
/// 所以这里按启动必需项逐个查，缺哪个就说哪个。
fn usable_jdtls(dir: &Path) -> Result<(), String> {
    let plugins = dir.join("plugins");
    if !plugins.is_dir() {
        return Err("没有 plugins 目录".to_string());
    }
    let config_ini = dir
        .join(if cfg!(windows) {
            "config_win"
        } else {
            "config_linux"
        })
        .join("config.ini");
    if !config_ini.is_file() {
        return Err(format!("没有 {}", config_ini.display()));
    }
    let names: Vec<String> = std::fs::read_dir(&plugins)
        .map_err(|e| format!("读不了 {}: {e}", plugins.display()))?
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    let missing = |pred: &dyn Fn(&str) -> bool, what: &str| -> Result<(), String> {
        if names.iter().any(|n| pred(n)) {
            Ok(())
        } else {
            Err(format!("缺 {what}"))
        }
    };
    missing(
        &|n| n.starts_with("org.eclipse.equinox.launcher_") && n.ends_with(".jar"),
        "equinox 启动 jar",
    )?;
    missing(&|n| n.starts_with("org.eclipse.jdt.ls.core_"), "jdt.ls 核心 bundle")?;
    missing(&|n| n.starts_with("org.eclipse.osgi_"), "OSGi framework bundle")?;
    Ok(())
}

fn find_jdtls(app: &tauri::AppHandle, config_dir: &Path) -> Result<PathBuf, String> {
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Ok(env_dir) = std::env::var("NCFORGE_JDTLS_DIR") {
        cands.push(PathBuf::from(env_dir));
    }
    if let Some(dir) =
        crate::resource_pack::active_dir(config_dir, crate::resource_pack::PACK_JDTLS)
    {
        cands.push(dir);
    }
    if let Ok(dir) = app.path().resource_dir() {
        cands.push(dir.join("jdtls"));
    }
    cands.push(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("jdtls"),
    );
    // 逐个查，把「跳过它的原因」攒起来：全都不行时，错误信息要能说清每个候选
    // 差在哪，而不是笼统一句「找不到组件」——否则用户只会去重装。
    let mut skipped: Vec<String> = Vec::new();
    for dir in cands {
        match usable_jdtls(&dir) {
            Ok(()) => return Ok(dir),
            Err(why) => skipped.push(format!("{}：{why}", dir.display())),
        }
    }
    Err(format!(
        "找不到可用的 Java 语言服务组件（jdt.ls）。若刚安装/更新过，请到设置 → 组件里下载；\
         或设置环境变量 NCFORGE_JDTLS_DIR 指定已有目录。已检查：{}",
        skipped.join("；")
    ))
}

/// jdt.ls 死因的现场：stderr 尾部 + configuration 目录里最新的 OSGi 日志尾部。
///
/// 只说「进程意外退出」对排查毫无帮助：真正的错误（OSGi 配置区解析失败、堆溢出、
/// 启动参数不认识）全在这两处文本里。带上它们，用户 hover 状态栏就能看到原因，
/// 也省掉一轮「远程猜」。
fn crash_hint(stderr_log: &Path, osgi_dir: &Path) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(t) = tail_lines(stderr_log, 6) {
        parts.push(format!("stderr：{t}"));
    }
    if let Some(p) = newest_log(osgi_dir) {
        if let Some(t) = tail_lines(&p, 8) {
            let name = p
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            parts.push(format!("{name}：{t}"));
        }
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!("\n\n现场：{}", parts.join(" ｜ "))
    }
}

/// 读文件最后 `n` 行非空文本。日志可能很大，只取末尾 16KB。
fn tail_lines(path: &Path, n: usize) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let start = bytes.len().saturating_sub(16 * 1024);
    let text = String::from_utf8_lossy(&bytes[start..]).into_owned();
    let mut lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    if lines.is_empty() {
        return None;
    }
    let skip = lines.len().saturating_sub(n);
    let picked: Vec<&str> = lines.drain(skip..).collect();
    Some(picked.join(" ⏎ ").chars().take(700).collect())
}

/// configuration 目录里最新的 OSGi `.log`（equinox 只在启动出错时写它）。
fn newest_log(dir: &Path) -> Option<PathBuf> {
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "log"))
        .max_by_key(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok())
}

/// 处理 jdt.ls 主动发来的通知：记录状态、把诊断转给前端。
struct Handler {
    app: tauri::AppHandle,
    state: Arc<AppState>,
    module: String,
    real_prefix: String,
    shadow_prefix: String,
    /// 拉起时的代数（见 `LangRun::generation`）。
    generation: u64,
    /// NC 自带 JDK 的根目录：`workspace/configuration` 请求要按它回 runtimes。
    runtime_home: String,
    /// jdt.ls 的 stderr 落盘位置与 OSGi 日志目录，进程意外退出时用来带出现场。
    stderr_log: PathBuf,
    osgi_dir: PathBuf,
}

impl LspHandler for Handler {
    /// 服务端主动来问配置。
    ///
    /// `workspace/configuration` 必须真答：我们在 initialize 里声明了这个能力，jdt.ls
    /// 就会按需来拉，默认空实现回 `null` 的话，某些版本的 jdt.ls 会用**默认值覆盖**
    /// 我们用 `didChangeConfiguration` 推过去的设置（runtimes / 编译选项），
    /// 表现是「明明配了 JDK 却提示找不到 JavaSE-1.8」，而且没有任何报错。
    ///
    /// 协议要求返回与 `items` 等长的数组，每项是该 section 的配置；这里统一回整份 settings
    /// （jdt.ls 只读自己那部分，多余字段会被忽略）。
    fn on_request(&self, method: &str, params: &Value) -> Value {
        if method == "workspace/configuration" {
            let n = params["items"]
                .as_array()
                .map(|a| a.len())
                .unwrap_or(0)
                .max(1);
            let settings = build_settings(&self.runtime_home);
            return Value::Array(vec![settings; n]);
        }
        Value::Null
    }
    /// jdt.ls 进程没了。主动停止 / 重启时会话已先被取走（`session` 为 None）或代数已变，都不算意外。
    /// 意外退出（比如模块太大 OOM）要告诉用户，否则状态栏会一直显示「就绪」而所有请求都在默默失败。
    fn on_exit(&self, reason: &str) {
        let unexpected = {
            let mut run = lock_lang(&self.state);
            let current = run.generation == self.generation && run.session.is_some();
            if current {
                run.session = None;
            }
            current
        };
        if unexpected {
            let hint = crash_hint(&self.stderr_log, &self.osgi_dir);
            set_status(
                &self.app,
                &self.state,
                LangStatus {
                    state: "error".into(),
                    module: Some(self.module.clone()),
                    message: format!(
                        "代码智能进程意外退出（{reason}），可能是内存上限太小，点「重试」或在设置里调大{hint}"
                    ),
                    ..LangStatus::stopped()
                },
            );
        }
    }

    fn on_notification(&self, method: &str, params: Value) {
        match method {
            "language/status" => {
                let kind = params["type"].as_str().unwrap_or_default();
                let message = params["message"].as_str().unwrap_or_default().to_string();
                let mut cur = lock_lang(&self.state).status.clone();
                // 只改本模块的状态：旧会话收尾时的通知不能覆盖新会话
                if cur.module.as_deref() != Some(&self.module)
                    || !matches!(cur.state.as_str(), "indexing" | "ready")
                {
                    return;
                }
                if kind == "ServiceReady" {
                    cur.state = "ready".into();
                }
                if !message.is_empty() {
                    cur.message = message;
                }
                set_status(&self.app, &self.state, cur);
            }
            "textDocument/publishDiagnostics" => {
                let mapped =
                    crate::lang::swap_prefix(&params, &self.shadow_prefix, &self.real_prefix);
                let _ = self
                    .app
                    .emit("lang-notify", json!({ "method": method, "params": mapped }));
            }
            _ => {}
        }
    }
}

fn start_blocking(
    app: tauri::AppHandle,
    state: Arc<AppState>,
    root: PathBuf,
    module: String,
    home: NcHome,
    xmx_mb: u32,
) -> Result<LangStatus, String> {
    // 同模块已在跑（或正在拉起）就不重复拉起
    let old = {
        let mut run = lock_lang(&state);
        let same = run.status.module.as_deref() == Some(&module)
            && matches!(run.status.state.as_str(), "starting" | "indexing" | "ready");
        if same {
            return Ok(run.status.clone());
        }
        run.status = LangStatus {
            state: "starting".into(),
            module: Some(module.clone()),
            message: "正在准备…".into(),
            ..LangStatus::stopped()
        };
        run.session.take()
    };
    let _ = app.emit("lang-status", lock_lang(&state).status.clone());
    // 切模块 = 重启（已验证的做法；在原进程里换 classpath 未验证）
    if let Some(s) = old {
        s.client.shutdown();
    }
    match launch(&app, &state, &root, &module, &home, xmx_mb) {
        Ok(st) => Ok(st),
        Err(e) if e == CANCELLED => Err(e), // 取消不是失败：状态已由 stop_now 置成 stopped
        Err(e) => {
            set_status(
                &app,
                &state,
                LangStatus {
                    state: "error".into(),
                    module: Some(module),
                    message: e.clone(),
                    ..LangStatus::stopped()
                },
            );
            Err(e)
        }
    }
}

/// 准备期间被停止/切工作区时的统一错误文案。`start_blocking` 据此**不覆盖**状态：
/// 这不是失败，`stop_now` 已经把状态置成 stopped 了。
const CANCELLED: &str = "启动已取消：准备期间停止或切换了工作区";

fn launch(
    app: &tauri::AppHandle,
    state: &Arc<AppState>,
    root: &Path,
    module: &str,
    home: &NcHome,
    xmx_mb: u32,
) -> Result<LangStatus, String> {
    // 从这一刻起就算「本次拉起的意图」。下面每一步都可能耗时数秒（扫模块、生成影子工程、
    // 起进程、initialize 握手），期间用户完全可能关掉开关或切工作区。
    let cancel_epoch = lock_lang(state).cancel_epoch;
    let nc_home = PathBuf::from(&home.root);
    let java = PathBuf::from(&home.java);
    // java = <home>/ufjdk/bin/java.exe，运行时根 = 它的上上级
    let runtime = java
        .parent()
        .and_then(Path::parent)
        .ok_or("无法确定 NC 自带 JDK 的根目录")?
        .to_path_buf();
    let ls_dir = find_jdtls(app, &state.config_dir)?;
    let (index, seed) = cached_index(
        &nc_home,
        &state.config_dir.join("class-index.bin"),
        module,
        &|s| {
            let _ = app.emit(
                "lang-status",
                LangStatus {
                    state: "starting".into(),
                    module: Some(module.to_string()),
                    message: s.to_string(),
                    ..LangStatus::stopped()
                },
            );
        },
    )?;

    let base = state.config_dir.join("lang");
    let shadow_dir = base.join("shadow");
    let data_dir = base.join("jdtls-data");
    // 上次用的是另一个模块时清掉 jdt.ls 的工作区缓存，避免旧索引混进来。
    // data_dir 在影子目录之外、里面没有 junction，递归删除是安全的。
    let last_file = base.join("last-module.txt");
    if std::fs::read_to_string(&last_file).ok().as_deref() != Some(module) {
        let _ = std::fs::remove_dir_all(&data_dir);
    }
    std::fs::create_dir_all(&base).map_err(|e| format!("无法创建代码智能目录: {e}"))?;
    let _ = std::fs::write(&last_file, module);

    let project = shadow::generate(&ShadowSpec {
        workspace_root: root,
        module,
        nc_home: &nc_home,
        shadow_dir: &shadow_dir,
        index: &index,
        extra_jars: &seed,
    })?;

    let real_dir = root.join(module);
    let shadow_module = shadow_dir.join(module);
    let runtime_s = runtime.to_string_lossy().into_owned();
    // stderr 落到固定的一个文件（不追加：只关心最近一次拉起为什么没起来）。
    let stderr_log = base.join("jdtls-stderr.log");
    let osgi_dir = base.join("jdtls-config");
    let handler = Handler {
        app: app.clone(),
        state: state.clone(),
        module: module.to_string(),
        real_prefix: path_to_uri(&real_dir.to_string_lossy()),
        shadow_prefix: path_to_uri(&shadow_module.to_string_lossy()),
        runtime_home: runtime_s.clone(),
        stderr_log: stderr_log.clone(),
        osgi_dir: osgi_dir.clone(),
        generation: {
            let mut run = lock_lang(state);
            run.generation += 1;
            run.generation
        },
    };
    let cmd = JdtlsLaunch {
        java_exe: &java,
        ls_dir: &ls_dir,
        data_dir: &data_dir,
        config_dir: &osgi_dir,
        xmx_mb,
    }
    .command()?;
    let client = LspClient::spawn_with_stderr(cmd, Arc::new(handler), &stderr_log)?;
    let root_s = shadow_dir.to_string_lossy().into_owned();
    if let Err(e) = client.request(
        "initialize",
        build_initialize_params(&root_s, &runtime_s, std::process::id()),
        Duration::from_secs(120),
    ) {
        // 失败现场立刻取：进程可能马上被 kill 掉，日志还没写完就只能看到空文件
        let hint = crash_hint(&stderr_log, &osgi_dir);
        client.kill();
        return Err(format!("{e}{hint}"));
    }

    // 先登记会话并置为 indexing，再发 `initialized`。顺序不能反：索引有缓存（重启同一模块）时
    // `ServiceReady` 可能在 `initialized` 后几毫秒就到，那时状态还是 starting 的话处理器会把它丢掉，
    // 状态栏就永远停在「正在建立索引」。
    let status = LangStatus {
        state: "indexing".into(),
        module: Some(module.to_string()),
        message: "正在建立索引…".into(),
        source_files: project.source_files,
        jar_count: project.jar_count,
    };
    let session = Arc::new(LangSession::new(client, module, &real_dir, &shadow_module));
    {
        let mut run = lock_lang(state);
        // 登记前复检停止意图：这几秒里 session 还是 None，stop_now 摘不到东西、
        // 只把状态置成 stopped 就返回了。不复检的话这里会把它改回 indexing，
        // 留一个 700MB 的孤儿进程，而状态栏还宣称「正在建立索引」。
        if run.cancel_epoch != cancel_epoch {
            drop(run);
            session.client.kill();
            return Err(CANCELLED.to_string());
        }
        run.session = Some(session.clone());
    }
    set_status(app, state, status.clone());
    let handshake = session
        .client
        .notify("initialized", json!({}))
        .and_then(|_| {
            session.client.notify(
                "workspace/didChangeConfiguration",
                json!({ "settings": build_settings(&runtime_s) }),
            )
        });
    if let Err(e) = handshake {
        // 握手一半失败：不能留下一个已登记但不可用的会话和一个孤儿进程
        lock_lang(state).session = None;
        let hint = crash_hint(&stderr_log, &osgi_dir);
        session.client.kill();
        return Err(format!("{e}{hint}"));
    }
    Ok(status)
}

/// 为 `path` 所在的模块启动代码智能。拉起与握手约 3~5 秒后返回（`indexing`），
/// 真正就绪要等 `lang-status` 事件变成 `ready`（真实 gl 模块首次约 40 秒）。
#[tauri::command]
pub async fn lang_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
) -> Result<LangStatus, String> {
    let cfg = state.config.read().await.clone();
    if !cfg.lang_enabled {
        return Err("代码智能已在设置里关闭".to_string());
    }
    let (root, module) = resolve_module(&state, &path).await?;
    let home = nc_home::resolve(cfg.nc_home.as_deref())?;
    let xmx = cfg.lang_xmx_mb.unwrap_or(DEFAULT_XMX_MB);
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        start_blocking(app, state, root, module, home, xmx)
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 停掉当前会话并把状态置为已停止。
fn stop_now(app: &tauri::AppHandle, state: &AppState) {
    let old = {
        let mut run = lock_lang(state);
        // 先记「这一代作废」再摘 session：正在 launch 的那条线程会拿不到旧的
        // `cancel_epoch`，登记前复检时就会自己退场（见 launch 里的复检）。
        run.cancel_epoch += 1;
        run.session.take()
    };
    if let Some(s) = old {
        s.client.shutdown();
    }
    set_status(app, state, LangStatus::stopped());
}

#[tauri::command]
pub async fn lang_stop(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || stop_now(&app, &state))
        .await
        .map_err(|e| format!("后台任务失败: {e}"))
}

/// 重新生成影子工程：停掉 → 清掉 jdt.ls 的工作区缓存 → 按当前模块重新拉起。
/// 用于模块目录结构变了、或 jdt.ls 的索引看起来不对的时候。
#[tauri::command]
pub async fn lang_regenerate(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<LangStatus, String> {
    let cfg = state.config.read().await.clone();
    if !cfg.lang_enabled {
        return Err("代码智能已在设置里关闭".to_string());
    }
    let module = lock_lang(&state)
        .status
        .module
        .clone()
        .ok_or_else(|| "还没有打开过 .java 文件，没有可重建的模块".to_string())?;
    let ws = cfg
        .workspace_root
        .clone()
        .ok_or_else(|| "尚未选择工作区目录".to_string())?;
    let (root, module) =
        resolve_module(&state, &PathBuf::from(ws).join(&module).to_string_lossy()).await?;
    let home = nc_home::resolve(cfg.nc_home.as_deref())?;
    let xmx = cfg.lang_xmx_mb.unwrap_or(DEFAULT_XMX_MB);
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        stop_now(&app, &state);
        // 删掉「上次模块」记录，launch 会据此连 jdt.ls 的工作区缓存一起清掉
        let _ = std::fs::remove_file(state.config_dir.join("lang").join("last-module.txt"));
        start_blocking(app, state, root, module, home, xmx)
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 代码智能设置的局部更新。字段名与 `AppConfig` 一致（snake_case）。
#[derive(Debug, serde::Deserialize)]
pub struct LangConfigPatch {
    #[serde(default)]
    pub lang_enabled: Option<bool>,
    #[serde(default)]
    pub lang_auto_start: Option<bool>,
    /// 内存上限（MB）。`0` = 恢复默认（用 0 表示「清空」，避免 JSON 里区分缺省与 null）。
    #[serde(default)]
    pub lang_xmx_mb: Option<u32>,
}

/// 改代码智能的设置。内存上限越界时明确报错；关掉总开关时顺手停掉正在跑的 jdt.ls。
/// 改内存上限不会重启正在跑的进程，下次拉起（或点「重新生成」）时生效。
#[tauri::command]
pub async fn lang_config_set(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    patch: LangConfigPatch,
) -> Result<AppConfig, String> {
    let xmx = match patch.lang_xmx_mb {
        Some(0) => Some(None),
        Some(mb) => Some(Some(validate_xmx(mb)?)),
        None => None,
    };
    let cfg = state
        .update_config(move |cfg| {
            if let Some(v) = patch.lang_enabled {
                cfg.lang_enabled = v;
            }
            if let Some(v) = patch.lang_auto_start {
                cfg.lang_auto_start = v;
            }
            if let Some(v) = xmx {
                cfg.lang_xmx_mb = v;
            }
            Ok(())
        })
        .await?;
    if !cfg.lang_enabled {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || stop_now(&app, &state))
            .await
            .map_err(|e| format!("后台任务失败: {e}"))?;
    }
    Ok(cfg)
}

#[tauri::command]
pub fn lang_status(state: tauri::State<'_, Arc<AppState>>) -> LangStatus {
    lock_lang(&state).status.clone()
}

/// 取当前会话，并把 `path`（真实文件路径）换成 `textDocument.uri` 填进参数。
fn prepare(
    state: &AppState,
    path: Option<&str>,
    params: &Value,
) -> Result<(Arc<LangSession>, Value), String> {
    let session = lock_lang(state)
        .session
        .clone()
        .ok_or_else(|| "代码智能未运行".to_string())?;
    let mut p = session.to_server(params);
    if let Some(path) = path {
        let uri = session.shadow_uri_of(path)?;
        p["textDocument"]["uri"] = Value::String(uri);
    }
    Ok((session, p))
}

/// 透传一个 LSP 请求。`path` 给出时按它填 `textDocument.uri`；结果里的影子 URI 会换回真实路径。
#[tauri::command]
pub async fn lang_request(
    state: tauri::State<'_, Arc<AppState>>,
    method: String,
    path: Option<String>,
    params: Value,
    timeout_ms: Option<u64>,
) -> Result<Value, String> {
    let (session, p) = prepare(&state, path.as_deref(), &params)?;
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(30_000));
    tauri::async_runtime::spawn_blocking(move || {
        let out = session.client.request(&method, p, timeout)?;
        Ok(session.from_server(&out))
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 透传一个 LSP 通知（didOpen / didChange / didClose 等）。
///
/// 写成 `async`：Tauri 的同步命令跑在主线程，jdt.ls 万一不再读管道（忙于索引、卡死），
/// 写 stdin 会阻塞，整个界面跟着冻住。换成 async 就只卡一个工作线程。
#[tauri::command]
pub async fn lang_notify(
    state: tauri::State<'_, Arc<AppState>>,
    method: String,
    path: Option<String>,
    params: Value,
) -> Result<(), String> {
    let (session, p) = prepare(&state, path.as_deref(), &params)?;
    session.client.notify(&method, p)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ncforge-lang-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// 造一个「该有的都有」的 jdt.ls 目录，只建判定要用的空文件。
    fn fake_jdtls(dir: &Path) {
        let plugins = dir.join("plugins");
        fs::create_dir_all(&plugins).unwrap();
        for n in [
            "org.eclipse.equinox.launcher_1.5.700.v20200207-2156.jar",
            "org.eclipse.jdt.ls.core_0.57.0.202006172108.jar",
            "org.eclipse.osgi_3.15.300.v20200520-1959.jar",
            "org.eclipse.equinox.launcher.win32.win32.x86_64_1.1.1200.v20200508-1552.jar",
        ] {
            fs::write(plugins.join(n), b"").unwrap();
        }
        let cfg = dir.join(if cfg!(windows) { "config_win" } else { "config_linux" });
        fs::create_dir_all(&cfg).unwrap();
        fs::write(cfg.join("config.ini"), b"osgi.bundles=x").unwrap();
    }

    #[test]
    fn 完整目录才算可用() {
        let d = temp("ok");
        fake_jdtls(&d);
        assert!(usable_jdtls(&d).is_ok());
        let _ = fs::remove_dir_all(&d);
    }

    /// 半残目录（复制中断 / cargo clean 后只跑了一半 jdtls:fetch）必须被判定不可用。
    /// 选中它启动的表现是 equinox 在配置区就崩，界面上只有「代码智能不可用」——
    /// 2026-10-30 就是这么排查了半天的。
    #[test]
    fn 半残目录逐项报缺什么() {
        let d = temp("partial");
        let err = usable_jdtls(&d).unwrap_err();
        assert!(err.contains("plugins"), "空目录要指出缺 plugins：{err}");

        fake_jdtls(&d);
        fs::remove_file(d.join("plugins").join("org.eclipse.equinox.launcher_1.5.700.v20200207-2156.jar"))
            .unwrap();
        let err = usable_jdtls(&d).unwrap_err();
        assert!(err.contains("equinox 启动 jar"), "{err}");

        fake_jdtls(&d);
        fs::remove_file(d.join("plugins").join("org.eclipse.jdt.ls.core_0.57.0.202006172108.jar")).unwrap();
        let err = usable_jdtls(&d).unwrap_err();
        assert!(err.contains("jdt.ls 核心"), "{err}");

        fake_jdtls(&d);
        fs::remove_file(d.join("plugins").join("org.eclipse.osgi_3.15.300.v20200520-1959.jar")).unwrap();
        let err = usable_jdtls(&d).unwrap_err();
        assert!(err.contains("OSGi framework"), "{err}");

        fake_jdtls(&d);
        let cfg = d.join(if cfg!(windows) { "config_win" } else { "config_linux" });
        fs::remove_file(cfg.join("config.ini")).unwrap();
        let err = usable_jdtls(&d).unwrap_err();
        assert!(err.contains("config.ini"), "{err}");

        let _ = fs::remove_dir_all(&d);
    }

    /// 只有片段 jar（`...launcher.win32...`）不能被当成启动 jar。
    #[test]
    fn 片段_jar_不算启动_jar() {
        let d = temp("fragment");
        fake_jdtls(&d);
        fs::remove_file(d.join("plugins").join("org.eclipse.equinox.launcher_1.5.700.v20200207-2156.jar"))
            .unwrap();
        assert!(usable_jdtls(&d).is_err(), "只剩 win32 片段时必须拒绝");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn 尾部日志只取最后几行且截断() {
        let d = temp("tail");
        let f = d.join("x.log");
        let body: String = (1..=50).map(|i| format!("行{i}\n")).collect();
        fs::write(&f, body).unwrap();
        let got = tail_lines(&f, 3).unwrap();
        assert!(got.contains("行48") && got.contains("行50"), "{got}");
        assert!(!got.contains("行1\n") && !got.contains("行47"), "{got}");

        assert!(tail_lines(&d.join("nope.log"), 3).is_none());
        fs::write(&f, b"").unwrap();
        assert!(tail_lines(&f, 3).is_none(), "空文件没有现场可报");
        let _ = fs::remove_dir_all(&d);
    }

    /// 两条线索都没有时不能给个空壳「现场：」，那还不如没有。
    #[test]
    fn 没有现场时_hint_为空() {
        let d = temp("hint");
        assert_eq!(crash_hint(&d.join("a.log"), &d), "");
        fs::write(d.join("1793338302103.log"), b"!SESSION x\njava.net.UnknownHostException: configuration\n")
            .unwrap();
        let hint = crash_hint(&d.join("a.log"), &d);
        assert!(hint.contains("UnknownHostException"), "{hint}");
        assert!(hint.contains("1793338302103.log"), "要指出是哪份日志：{hint}");
        let _ = fs::remove_dir_all(&d);
    }
}
