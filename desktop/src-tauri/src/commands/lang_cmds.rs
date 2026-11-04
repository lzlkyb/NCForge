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
    missing(
        &|n| n.starts_with("org.eclipse.jdt.ls.core_"),
        "jdt.ls 核心 bundle",
    )?;
    missing(
        &|n| n.starts_with("org.eclipse.osgi_"),
        "OSGi framework bundle",
    )?;
    Ok(())
}

/// java-debug 的 bundle 路径。
///
/// 放在 `<jdtls>/java-debug/` 而不是 `plugins/`：后者由 equinox 按 config.ini 装配，
/// 塞进去会被当成平台 bundle 参与启动解析。这个 jar 由 `fetch-jdtls.mjs` 下载并校验，
/// 旧资源包里没有时返回 `None`——语言服务不受影响，只是没有调试。
pub fn java_debug_bundle(ls_dir: &Path) -> Option<PathBuf> {
    let jar = ls_dir
        .join("java-debug")
        .join("com.microsoft.java.debug.plugin-0.32.0.jar");
    jar.is_file().then_some(jar)
}

/// 本仓库自带的 jdt.ls 扩展 bundle（目前只有 `ncforge.typeHierarchy`）。
///
/// 与 java-debug 不同，它不由 jdt.ls 资源包分发，而是随安装包走 `resources/jdtls-ext/`；
/// 因此候选顺序是「app 资源目录 → 源码目录」。找不到就返回 `None`：类型层级不可用，
/// 语言服务照常起（和调试一个原则，别让一个可选功能拖垮整条链路）。
pub fn jdtls_ext_bundle(app: &tauri::AppHandle) -> Option<PathBuf> {
    let name = "ncforge-jdt-ext.jar";
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Ok(p) = std::env::var("NCFORGE_JDTLS_EXT_JAR") {
        cands.push(PathBuf::from(p));
    }
    if let Ok(dir) = app.path().resource_dir() {
        cands.push(dir.join("jdtls-ext").join(name));
    }
    cands.push(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("jdtls-ext")
            .join(name),
    );
    cands.into_iter().find(|p| p.is_file())
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
        "找不到可用的 Java 语言服务组件（jdt.ls）。请点击下载按钮，或到设置 → 维护 → 组件与更新下载；\
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

/// jdt.ls 工作区缓存的版式号：目录规则变了就加一，旧缓存自然不再命中、随后被淘汰。
const DATA_LAYOUT: u32 = 1;
/// 最多保留几个模块的索引缓存。一份大约百 MB 级，4 份够在常用的几个模块间来回切。
const DATA_KEEP: usize = 4;
/// 缓存目录里记「最近一次使用时间」的文件（内容是毫秒时间戳）。
const DATA_STAMP: &str = ".ncforge-used";

/// FNV-1a：稳定、不随 Rust 版本变化（`DefaultHasher` 不保证这一点）。
/// 路径先转小写：Windows 上 `C:\Work` 与 `c:\work` 是同一个目录。
fn stable_hash(parts: &[&str]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for p in parts {
        for b in p.to_lowercase().bytes().chain(std::iter::once(0)) {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
    }
    h
}

/// 某个模块自己的 jdt.ls 工作区缓存目录：`<base>/jdtls-ws/<模块>-<指纹>`。
///
/// 指纹覆盖工作区根、模块、NC home、jdt.ls 目录（含版本）与版式号：任一变化都换新目录，
/// 旧的不再被读到。NC home 里 jar 增减不在指纹里——影子工程的 .classpath 每次启动都重生成，
/// jdt.ls 自己会按新的类路径重新解析。
fn data_dir_for(base: &Path, root: &Path, module: &str, nc_home: &Path, ls_dir: &Path) -> PathBuf {
    let key = stable_hash(&[
        &DATA_LAYOUT.to_string(),
        &root.to_string_lossy(),
        module,
        &nc_home.to_string_lossy(),
        &ls_dir.to_string_lossy(),
    ]);
    let safe: String = module
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .take(40)
        .collect();
    base.join("jdtls-ws").join(format!("{safe}-{key:016x}"))
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// 是不是可以放心递归删除的普通目录：符号链接与 junction 一律不碰
/// （`symlink_metadata` 不跟随链接，junction 在 Windows 上也报成符号链接）。
fn plain_dir(p: &Path) -> bool {
    std::fs::symlink_metadata(p).is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink())
}

/// 给本次用的缓存打上「刚用过」，再把同级里最久没用的删到只剩 `keep` 份。
/// 正在用的这份永远不删。缓存目录里只有 jdt.ls 自己写的文件，没有 junction。
fn touch_and_prune(current: &Path, keep: usize, now: u128) {
    let _ = std::fs::write(current.join(DATA_STAMP), now.to_string());
    let Some(parent) = current.parent() else {
        return;
    };
    let Ok(rd) = std::fs::read_dir(parent) else {
        return;
    };
    let mut others: Vec<(u128, PathBuf)> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| p != current && plain_dir(p))
        .map(|p| {
            let used = std::fs::read_to_string(p.join(DATA_STAMP))
                .ok()
                .and_then(|s| s.trim().parse().ok())
                .unwrap_or(0);
            (used, p)
        })
        .collect();
    others.sort_by_key(|o| std::cmp::Reverse(o.0));
    for (_, p) in others.into_iter().skip(keep.saturating_sub(1)) {
        let _ = std::fs::remove_dir_all(&p);
    }
}

/// 旧版本只有一份的 `jdtls-data` 与 `last-module.txt`：新版不再用，顺手清掉（只会发生一次）。
fn remove_legacy_data(base: &Path) {
    let legacy = base.join("jdtls-data");
    if plain_dir(&legacy) {
        let _ = std::fs::remove_dir_all(&legacy);
    }
    let _ = std::fs::remove_file(base.join("last-module.txt"));
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
            if lock_lang(state).cancel_epoch != cancel_epoch {
                return;
            }
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

    // 覆盖表：影子工程要和编译/启动用同一份（launch 是同步函数，用 blocking_lock）
    let overrides =
        crate::eclipse_cp::active_overrides(&state.config.blocking_read().linked_overrides);
    let base = state.config_dir.join("lang");
    let shadow_dir = base.join("shadow");
    // jdt.ls 的工作区缓存按「工作区 + 模块 + NC home + jdt.ls 目录」各存一份：
    // 以前只有一份、换模块就整个删掉，A → B → A 回到 A 要从头建索引。
    // 现在各模块互不混用，又能复用；只留最近用过的 DATA_KEEP 份控制磁盘占用。
    let data_dir = data_dir_for(&base, root, module, &nc_home, &ls_dir);
    std::fs::create_dir_all(&data_dir).map_err(|e| format!("无法创建代码智能目录: {e}"))?;
    remove_legacy_data(&base);
    touch_and_prune(&data_dir, DATA_KEEP, now_ms());

    let project = shadow::generate(&ShadowSpec {
        workspace_root: root,
        module,
        nc_home: &nc_home,
        shadow_dir: &shadow_dir,
        index: &index,
        extra_jars: &seed,
        overrides: &overrides,
    })?;
    // 同一份类索引（同一 NC home）在进程内只建一次类名目录，切模块 / 重启语言服务直接复用
    let catalog = crate::java_types::TypeCatalog::shared_cancellable(
        &index,
        &base.join("type-names.json"),
        &|done, total| {
            if lock_lang(state).cancel_epoch != cancel_epoch {
                return;
            }
            let _ = app.emit(
                "lang-status",
                LangStatus {
                    state: "starting".into(),
                    module: Some(module.into()),
                    message: format!("准备全 NC 类名补全 {done}/{total}…"),
                    ..LangStatus::stopped()
                },
            );
        },
        &|| lock_lang(state).cancel_epoch != cancel_epoch,
    )
    .ok_or(CANCELLED)?;

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
    // 两个都是可选 bundle：java-debug 管调试，扩展 jar 管类型层级（`ncforge.typeHierarchy`）。
    // 缺哪个都只是对应入口不可用，语言服务照常起，不因此判整机不可用
    let mut bundles: Vec<String> = Vec::new();
    if let Some(p) = java_debug_bundle(&ls_dir) {
        bundles.push(p.to_string_lossy().into_owned());
    }
    if let Some(p) = jdtls_ext_bundle(app) {
        bundles.push(p.to_string_lossy().into_owned());
    }
    if let Err(e) = client.request(
        "initialize",
        build_initialize_params(&root_s, &runtime_s, std::process::id(), &bundles),
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
    let session = Arc::new(
        LangSession::new(client, module, &real_dir, &shadow_module).with_completion_catalog(
            index,
            catalog,
            &shadow_dir,
        ),
    );
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
    let (root, module, _dir) = resolve_module(&state, &path).await?;
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
    let (root, module, _dir) =
        resolve_module(&state, &PathBuf::from(ws).join(&module).to_string_lossy()).await?;
    let home = nc_home::resolve(cfg.nc_home.as_deref())?;
    let xmx = cfg.lang_xmx_mb.unwrap_or(DEFAULT_XMX_MB);
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        stop_now(&app, &state);
        // 只清这个模块自己的 jdt.ls 工作区缓存（别的模块的索引照样留着）。
        // 进程已停，没有人占着这个目录；目录里没有 junction，递归删除是安全的。
        if let Ok(ls_dir) = find_jdtls(&app, &state.config_dir) {
            let base = state.config_dir.join("lang");
            let dir = data_dir_for(&base, &root, &module, Path::new(&home.root), &ls_dir);
            if plain_dir(&dir) {
                let _ = std::fs::remove_dir_all(&dir);
            }
        }
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

/// 取当前会话，并把 `path`（真实文件路径）换成影子工程 URI 填进参数。
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
        fill_document_uris(&mut p, &uri);
    }
    Ok((session, p))
}

/// 把 `uri` 填进参数里所有「目标文档」的位置。
///
/// 两种写法都要填：顶层 `textDocument` 是补全 / 跳转 / 重命名这类请求；里层
/// `context.textDocument` 是 codeAction 与 `java/getRefactorEdit` 这类把
/// `CodeActionParams` 塞进参数的请求。前端给的 `file://` 字符串由 Monaco 生成，
/// 盘符冒号是 `%3A`，与 `path_to_uri` 的形态对不上，靠前缀替换换不掉，只能按
/// `path` 重算。
fn fill_document_uris(p: &mut Value, uri: &str) {
    if let Some(td) = p.get_mut("context").and_then(|c| c.get_mut("textDocument")) {
        if td.is_object() {
            td["uri"] = Value::String(uri.to_string());
        }
    }
    // 自定义命令（`ncforge.typeHierarchy`）把目标文档放在第一个参数里。
    // 只在**已经给了 uri 键**时覆盖：别的 executeCommand 参数对象不该被塞进一个多余的字段。
    if let Some(first) = p.get_mut("arguments").and_then(|a| a.get_mut(0)) {
        if first.get("uri").is_some_and(Value::is_string) {
            first["uri"] = Value::String(uri.to_string());
        }
    }
    p["textDocument"]["uri"] = Value::String(uri.to_string());
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
    if method == "ncforge/resolveTypeCompletion" && path.is_none() {
        return Err("加载 NC 类型必须提供当前模块的真实文件路径".into());
    }
    if method == "workspace/executeCommand" && params["command"] == "ncforge.includeType" {
        return Err("NC 类型依赖只能通过受控类型补全加载".into());
    }
    let (session, p) = prepare(&state, path.as_deref(), &params)?;
    // 夹住：0 会让请求发出去就判定超时（前端拿到的错误是"超时"而不是真实原因），
    // 过大的值则让一个卡死的 jdt.ls 调用长期占着工作线程。
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(30_000).clamp(1_000, 120_000));
    tauri::async_runtime::spawn_blocking(move || {
        if method == "ncforge/typeCompletion" {
            return Ok(crate::java_type_completion::candidates(&session, &p));
        }
        if method == "ncforge/resolveTypeCompletion" {
            return crate::java_type_completion::resolve(&session, &p, timeout);
        }
        if method == "completionItem/resolve" {
            return crate::java_type_completion::resolve_item(&session, &p, timeout);
        }
        let out = session.client.request(&method, p, timeout)?;
        Ok(session.from_server(&out))
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// `java.project.provideSemanticTokens` 的参数：0.57 只认影子工程 URI 这一个字符串参数。
pub fn semantic_tokens_params(shadow_uri: &str) -> Value {
    json!({
        "command": "java.project.provideSemanticTokens",
        "arguments": [shadow_uri],
    })
}

/// 语义着色：jdt.ls 0.57 没有标准 LSP 的 `textDocument/semanticTokens/full`，只挂了
/// `java.project.provideSemanticTokens` 这个 executeCommand（返回 5 元组增量流，见
/// `tests/semantic_tokens_live.rs`）。参数要影子工程 URI，前端只认真实路径，换算放这里。
#[tauri::command]
pub async fn lang_semantic_tokens(
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
) -> Result<Value, String> {
    let session = lock_lang(&state)
        .session
        .clone()
        .ok_or_else(|| "代码智能未运行".to_string())?;
    let uri = session.shadow_uri_of(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        session.client.request(
            "workspace/executeCommand",
            semantic_tokens_params(&uri),
            Duration::from_secs(30),
        )
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 透传一个 LSP 通知（didOpen / didChange / didClose 等）。
///
/// 写成 `async`：Tauri 的同步命令跑在主线程，jdt.ls 万一不再读管道（忙于索引、卡死），
/// 写 stdin 会阻塞，整个界面跟着冻住。换成 async 就只卡一个工作线程。
/// 真正的写入还要再进 `spawn_blocking`——只标 `async` 仍会占住 async 运行时线程，
/// 管道卡死时连查询类命令一起排队。
#[tauri::command]
pub async fn lang_notify(
    state: tauri::State<'_, Arc<AppState>>,
    method: String,
    path: Option<String>,
    params: Value,
) -> Result<(), String> {
    let (session, p) = prepare(&state, path.as_deref(), &params)?;
    tauri::async_runtime::spawn_blocking(move || session.client.notify(&method, p))
        .await
        .map_err(|e| format!("后台任务失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn 索引缓存按模块与环境隔离() {
        let base = Path::new("C:\\cfg\\lang");
        let ws = Path::new("C:\\work\\aier\\newar");
        let home = Path::new("D:\\ncc\\1909home");
        let ls = Path::new("C:\\cfg\\jdtls-1.40");
        let a = data_dir_for(base, ws, "gl", home, ls);
        // 同一组参数必须落到同一目录（A → B → A 才能复用），大小写不影响
        assert_eq!(
            a,
            data_dir_for(base, Path::new("c:\\WORK\\aier\\newar"), "gl", home, ls)
        );
        assert!(a.starts_with(base.join("jdtls-ws")));
        assert!(a.file_name().unwrap().to_string_lossy().starts_with("gl-"));
        // 模块 / 工作区 / NC home / jdt.ls 版本任一变化都换目录
        assert_ne!(a, data_dir_for(base, ws, "ia", home, ls));
        assert_ne!(
            a,
            data_dir_for(base, Path::new("C:\\work\\other"), "gl", home, ls)
        );
        assert_ne!(
            a,
            data_dir_for(base, ws, "gl", Path::new("D:\\ncc\\nc65home"), ls)
        );
        assert_ne!(
            a,
            data_dir_for(base, ws, "gl", home, Path::new("C:\\cfg\\jdtls-1.41"))
        );
        // 模块名里的怪字符不能跑出缓存根
        let odd = data_dir_for(base, ws, "..\\x y", home, ls);
        assert_eq!(odd.parent().unwrap(), base.join("jdtls-ws"));
    }

    #[test]
    fn 索引缓存只留最近用过的几份() {
        let base = temp("data-prune");
        let ws = base.join("jdtls-ws");
        let dirs: Vec<PathBuf> = (0..6).map(|i| ws.join(format!("m{i}"))).collect();
        for (i, d) in dirs.iter().enumerate() {
            fs::create_dir_all(d.join(".metadata")).unwrap();
            fs::write(d.join(DATA_STAMP), (100 + i).to_string()).unwrap();
        }
        // 用最旧的 m0：它变成最新，另外留 m5/m4/m3，m2/m1 被删
        touch_and_prune(&dirs[0], 4, 1000);
        let alive: Vec<bool> = dirs.iter().map(|d| d.is_dir()).collect();
        assert_eq!(alive, [true, false, false, true, true, true]);
        assert_eq!(
            fs::read_to_string(dirs[0].join(DATA_STAMP)).unwrap(),
            "1000"
        );

        // 旧版单份缓存与「上次模块」记录会被清掉
        fs::create_dir_all(base.join("jdtls-data").join(".metadata")).unwrap();
        fs::write(base.join("last-module.txt"), "gl").unwrap();
        remove_legacy_data(&base);
        assert!(!base.join("jdtls-data").exists() && !base.join("last-module.txt").exists());
        let _ = fs::remove_dir_all(&base);
    }

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
        let cfg = dir.join(if cfg!(windows) {
            "config_win"
        } else {
            "config_linux"
        });
        fs::create_dir_all(&cfg).unwrap();
        fs::write(cfg.join("config.ini"), b"osgi.bundles=x").unwrap();
    }

    /// 命令名与参数形状是钉死的：0.57 的 `SemanticTokensCommand.provide(String)` 只吃
    /// 一个字符串参数，多一个对象就会被服务端当成坏参数（见真机测试）。
    #[test]
    fn 语义着色命令只带影子_uri_一个参数() {
        let p = semantic_tokens_params("file:///D:/shadow/gl/src/A.java");
        assert_eq!(p["command"], "java.project.provideSemanticTokens");
        assert_eq!(p["arguments"], json!(["file:///D:/shadow/gl/src/A.java"]));
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
        fs::remove_file(
            d.join("plugins")
                .join("org.eclipse.equinox.launcher_1.5.700.v20200207-2156.jar"),
        )
        .unwrap();
        let err = usable_jdtls(&d).unwrap_err();
        assert!(err.contains("equinox 启动 jar"), "{err}");

        fake_jdtls(&d);
        fs::remove_file(
            d.join("plugins")
                .join("org.eclipse.jdt.ls.core_0.57.0.202006172108.jar"),
        )
        .unwrap();
        let err = usable_jdtls(&d).unwrap_err();
        assert!(err.contains("jdt.ls 核心"), "{err}");

        fake_jdtls(&d);
        fs::remove_file(
            d.join("plugins")
                .join("org.eclipse.osgi_3.15.300.v20200520-1959.jar"),
        )
        .unwrap();
        let err = usable_jdtls(&d).unwrap_err();
        assert!(err.contains("OSGi framework"), "{err}");

        fake_jdtls(&d);
        let cfg = d.join(if cfg!(windows) {
            "config_win"
        } else {
            "config_linux"
        });
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
        fs::remove_file(
            d.join("plugins")
                .join("org.eclipse.equinox.launcher_1.5.700.v20200207-2156.jar"),
        )
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
        fs::write(
            d.join("1793338302103.log"),
            b"!SESSION x\njava.net.UnknownHostException: configuration\n",
        )
        .unwrap();
        let hint = crash_hint(&d.join("a.log"), &d);
        assert!(hint.contains("UnknownHostException"), "{hint}");
        assert!(
            hint.contains("1793338302103.log"),
            "要指出是哪份日志：{hint}"
        );
        let _ = fs::remove_dir_all(&d);
    }

    /// `context.textDocument` 里的 uri 必须一起换：`java/getRefactorEdit`
    /// 的目标文档只在这里，漏了就会拿 Monaco 的 `%3A` 形态去查影子工程，查不到。
    #[test]
    fn fill_document_uris_fills_top_level_and_context() {
        let mut p = serde_json::json!({
            "context": {
                "textDocument": { "uri": "file:///D%3A/ws/A.java" },
                "range": { "start": { "line": 0, "character": 0 } }
            }
        });
        fill_document_uris(&mut p, "file:///tmp/shadow/A.java");
        assert_eq!(p["textDocument"]["uri"], "file:///tmp/shadow/A.java");
        assert_eq!(
            p["context"]["textDocument"]["uri"],
            "file:///tmp/shadow/A.java"
        );
        assert_eq!(p["context"]["range"]["start"]["line"], 0, "其它字段不能动");
    }

    /// `context.textDocument` 不是对象（null / 字符串）时不能建出一个怪结构。
    #[test]
    fn fill_document_uris_leaves_non_object_context_alone() {
        let mut null_ctx = serde_json::json!({ "context": { "textDocument": null } });
        fill_document_uris(&mut null_ctx, "file:///a");
        assert!(null_ctx["context"]["textDocument"].is_null());
        assert_eq!(null_ctx["textDocument"]["uri"], "file:///a");

        let mut no_ctx = serde_json::json!({ "position": { "line": 1 } });
        fill_document_uris(&mut no_ctx, "file:///b");
        assert!(no_ctx.get("context").is_none(), "没有 context 就不要造一个");
        assert_eq!(no_ctx["textDocument"]["uri"], "file:///b");
    }

    /// 自定义命令（类型层级）的目标文档在 `arguments[0].uri`：前端给的是 Monaco 的
    /// `%3A` 形态，必须按 path 重算。没有 uri 键的参数对象不能被塞进多余字段。
    #[test]
    fn fill_document_uris_fills_first_command_argument() {
        let mut p = serde_json::json!({
            "command": "ncforge.typeHierarchy",
            "arguments": [{ "uri": "file:///d%3A/ws/A.java", "line": 3, "character": 6 }]
        });
        fill_document_uris(&mut p, "file:///tmp/shadow/A.java");
        assert_eq!(p["arguments"][0]["uri"], "file:///tmp/shadow/A.java");
        assert_eq!(p["arguments"][0]["line"], 3, "其它字段不能动");

        let mut other = serde_json::json!({
            "command": "java.edit.organizeImports",
            "arguments": [{ "line": 0 }]
        });
        fill_document_uris(&mut other, "file:///tmp/shadow/A.java");
        assert!(
            other["arguments"][0].get("uri").is_none(),
            "没有 uri 键就不要加：那是别的命令的参数"
        );

        let mut no_args = serde_json::json!({ "command": "x" });
        fill_document_uris(&mut no_args, "file:///a");
        assert!(no_args.get("arguments").is_none());
    }
}
