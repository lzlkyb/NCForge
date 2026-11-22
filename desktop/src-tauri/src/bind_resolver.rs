//! 常驻 binding resolver：窗口期精确跳转的第二链路（`lang_binding_resolver` 开关）。
//!
//! 设计：`docs/NCForge-窗口期精确解析-设计方案-2026-11-21.md`（§2 组件 / §3 协议 /
//! §4 生命周期）。解析本身在 `ecj-bridge/BindingResolver.java`（ECJ 内部 API 自持
//! LookupEnvironment 跨查询）；本模块只管「这个 JVM 怎么起、怎么退、怎么退避」。
//! 线路协议（`Hit` / argsFile）在 [`args`] 子模块，单测在 `tests` 子模块——都是
//! 体量红线（`.rs` ≤600 行）下的拆分，逻辑上仍是一体。
//!
//! 形态仿 `ecj_worker`，三点不同：
//! 1. **单 worker 不是池**：resolver 的环境跨查询自持，第二个进程只会各建一份
//!    LookupEnvironment，白吃 300~500MB 且答不了更多问题。
//! 2. **查询串行**（持锁跨整次调用）：JVM 内部单线程解析，并发发过去只是排队，
//!    而 5s 超时按每一次调用算——排队的那次会被误杀。
//! 3. **答不上不是错误**：所有失败路径都回 `None`，调用方退回内容搜索
//!    （与 `lang_fast_cmds` 同一条铁律）。
//!
//! 生命周期（设计 §4）：第一个查询起进程 + `init`；空闲 120s 自退；查询超时 5s
//! 杀进程、**不原地重试**；连续失败退避 60s→10min；换工作区 / NC home / 桥 jar /
//! 影子工程重生成 ⇒ 环境指纹变，旧 worker 直接退。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::java_bridge::BridgeError;
use crate::java_bridge::{Bridge, BridgeEnv};

mod args;
pub use args::Hit;
use args::{parse_hit, write_init_args, write_invalidate_args, write_resolve_args};

#[cfg(test)]
mod tests;

/// 单次 resolve 的超时：设计 §4「查询超时（5s）杀进程」。热查询实测 0~39ms，
/// 冷查询（invalidate 后重走全流程）约 1s ⇒ 5s 够一次冷流程，不够就是真卡死。
pub const RESOLVE_TIMEOUT: Duration = Duration::from_secs(5);
/// init 的超时单独给：它要建 FileSystem（1500 条 classpath）并拉起 JVM。
/// 只付一次，且失败同样杀 + 退避，不会把用户卡死在点击上。
const INIT_TIMEOUT: Duration = Duration::from_secs(30);
/// 空闲自退：设计 §4「空闲 120s 发 quit 自退（省内存）」。
const IDLE_TTL: Duration = Duration::from_secs(120);
/// trim 线程步长，与 `ecj_worker` 同一档。
const TRIM_TICK: Duration = Duration::from_secs(30);
/// resolver 的堆上限：设计 §4 的 768MB。S2a 实测 peakHeap 138MB，768 留足闭包生长。
const XMX_MB: u32 = 768;
/// 退避封顶：10 分钟（照 `fast_decl::Holder`）。
const BACKOFF_CAP: Duration = Duration::from_secs(600);

/// resolver 的运行环境。由命令层解析好再传进来（与 `fast_decl::build_index`
/// 同一个理由：生产路径在 `AppHandle` 里跑不到，抽出来单测才能喂合成路径）。
#[derive(Debug)]
pub struct ResolverEnv {
    /// NC 自带的 JDK（`<nc_home>/ufjdk/bin/java.exe`）。
    pub java: PathBuf,
    /// 桥 jar（`ncecj.jar`，含 `BindingResolver` 入口）。
    pub bridge: PathBuf,
    /// ECJ 来源：jdtls 的 plugins（3.22）。**不是** `resources/ecj/ecj-3.17.jar`
    /// —— 后者只服务编译期（`NcEcjBridge`），resolver 与 jdt.ls 共用同一份 ECJ。
    pub plugins: Vec<PathBuf>,
    /// 配置目录：影子工程 `.classpath` 在 `<config_dir>/lang/shadow/` 下。
    pub config_dir: PathBuf,
    pub workspace_root: PathBuf,
    pub nc_root: PathBuf,
}

// ───────────────────────── 统计 ─────────────────────────

/// 进程内累计计数：给设置页状态行看「resolver 到底在干活还是在退避」。
/// 只增不减、退出即清零——跨版本没有可比性（classpath、ECJ 版本都会变）。
#[derive(Default)]
struct Stats {
    queries: AtomicU64,
    answers: AtomicU64,
    misses: AtomicU64,
    /// 进程拉起次数（每次换代 / 崩溃后重起都算）。
    spawns: AtomicU64,
    inits: AtomicU64,
    timeouts: AtomicU64,
    ooms: AtomicU64,
    protocol: AtomicU64,
    trimmed: AtomicU64,
    ms_total: AtomicU64,
    last_ms: AtomicU64,
}

static STATS: Stats = Stats::new_const();

impl Stats {
    const fn new_const() -> Self {
        Self {
            queries: AtomicU64::new(0),
            answers: AtomicU64::new(0),
            misses: AtomicU64::new(0),
            spawns: AtomicU64::new(0),
            inits: AtomicU64::new(0),
            timeouts: AtomicU64::new(0),
            ooms: AtomicU64::new(0),
            protocol: AtomicU64::new(0),
            trimmed: AtomicU64::new(0),
            ms_total: AtomicU64::new(0),
            last_ms: AtomicU64::new(0),
        }
    }

    fn bump(counter: &AtomicU64) {
        counter.fetch_add(1, Ordering::Relaxed);
    }
}

/// 设置页状态行（`lang_binding_status`）。
///
/// 没有 `starting`：init 是持锁同步发的，状态命令根本插不进去。真要观察启动中，
/// 得把 init 挪到后台线程——设计 §4 没这个要求，不做。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// `idle` / `ready` / `backoff`。
    pub state: &'static str,
    pub queries: u64,
    pub answers: u64,
    pub misses: u64,
    /// 当前连续失败次数（成功即清零）。
    pub failures: u32,
    pub timeouts: u64,
    pub ooms: u64,
    pub spawns: u64,
    pub trimmed: u64,
    /// 退避剩余秒数；0 = 不在退避。
    pub backoff_remaining_secs: u64,
    pub last_query_ms: Option<u64>,
    /// 全部查询耗时合计（配合 `queries` 算均值，诊断用）。
    pub total_query_ms: u64,
    pub error: Option<String>,
}

impl Status {
    fn idle() -> Self {
        Self {
            state: "idle",
            queries: 0,
            answers: 0,
            misses: 0,
            failures: 0,
            timeouts: 0,
            ooms: 0,
            spawns: 0,
            trimmed: 0,
            backoff_remaining_secs: 0,
            last_query_ms: None,
            total_query_ms: 0,
            error: None,
        }
    }
}

// ───────────────────────── worker 持有 ─────────────────────────

struct Holder {
    worker: Option<Arc<Bridge>>,
    /// worker 对应的环境指纹；变即换代（旧 worker 退掉、重新 init）。
    key: String,
    /// init 用的 classpath，与 key 一起换（解析影子工程 XML 不便宜，不能每次查询重算）。
    entries: Vec<PathBuf>,
    /// init 是否已在这条进程上发过。进程被杀 / 自退后置 false。
    inited: bool,
    failures: u32,
    retry_at: Option<Instant>,
    last_used: Instant,
    last_error: Option<String>,
}

static HOLDER: OnceLock<Mutex<Holder>> = OnceLock::new();

fn holder() -> &'static Mutex<Holder> {
    HOLDER.get_or_init(|| {
        // 空闲回收线程：只在第一次真用 resolver 时拉起，随进程退出
        let _ = std::thread::Builder::new()
            .name("bind-resolver-trim".into())
            .spawn(trim_loop);
        Mutex::new(Holder {
            worker: None,
            key: String::new(),
            entries: Vec::new(),
            inited: false,
            failures: 0,
            retry_at: None,
            last_used: Instant::now(),
            last_error: None,
        })
    })
}

fn lock_holder() -> std::sync::MutexGuard<'static, Holder> {
    holder().lock().unwrap_or_else(|e| e.into_inner())
}

/// 解析一次跳转。`None` = 答不上（没环境 / 退避中 / 超时 / 进程挂 / offset 处
/// 没有绑定）——**调用方一律退回内容搜索**，本函数不返回错误。
///
/// `offset` 是 **UTF-16 code unit** 口径（ECJ 的 AST offset 就是 `char[]` 下标），
/// 由调用方按 Java 侧同规则解码文件后换算（见 `lang_binding_cmds::utf16_offset`）。
pub fn resolve(env: &ResolverEnv, file: &Path, offset: usize) -> Option<Hit> {
    let mut h = lock_holder();
    // 退避中：连 JVM 都不起。每次点击都拉一个 768MB 的进程比答不上更糟。
    if let Some(at) = h.retry_at {
        if Instant::now() < at {
            return None;
        }
    }
    let worker = ensure_worker(&mut h, env)?;
    // 进程被超时杀过 / 自己退过：下一条 call 会重新拉起，但引擎没了 ⇒ 必须重新 init
    if !h.inited || !worker.alive() {
        h.inited = false;
        let r = send_init(&worker, &h.entries);
        match r {
            Ok(()) => {
                h.inited = true;
                Stats::bump(&STATS.inits);
            }
            Err(e) => {
                note_failure(&mut h, &e);
                return None;
            }
        }
    }
    let Some(args) = write_resolve_args(file, offset) else {
        return None; // 临时文件写不出去：不是 resolver 的错，不走退避
    };
    let arg_line = crate::class_fp::display(&args.to_string_lossy());
    let started = Instant::now();
    let outcome = worker.call("resolve", &[&arg_line], RESOLVE_TIMEOUT);
    let ms = started.elapsed().as_millis() as u64;
    let _ = std::fs::remove_file(&args);
    h.last_used = Instant::now();
    match outcome {
        Ok(v) => {
            let hit = parse_hit(&v);
            // 成功即解除退避：进程明明是好的，别让一次超时禁言十分钟
            h.failures = 0;
            h.retry_at = None;
            h.last_error = None;
            STATS.queries.fetch_add(1, Ordering::Relaxed);
            STATS.ms_total.fetch_add(ms, Ordering::Relaxed);
            STATS.last_ms.store(ms, Ordering::Relaxed);
            if hit.is_some() {
                Stats::bump(&STATS.answers);
            } else {
                Stats::bump(&STATS.misses);
            }
            if let Some(hit) = &hit {
                if hit.problems > 0 {
                    log::debug!(
                        "binding resolve：{} 有 {} 个编译问题，绑定可能是恢复绑定",
                        file.display(),
                        hit.problems
                    );
                }
            }
            hit
        }
        Err(e) => {
            note_failure(&mut h, &e);
            None
        }
    }
}

/// 文件已保存：作废引擎里的 CU 缓存（Java 侧 `le.reset()` + 清缓存）。
///
/// 设计 §4：宁可下次查询冷走全流程（~1s），也不答旧位置。同步发、失败只记日志
/// ——保存路径上不能因为它多等；最坏 5s 超时后进程被杀，下次查询自愈。
///
/// 🔴 没有在跑的 worker 就直接返回：保存路径上每次都会调，为了「作废」去拉起一个
///    768MB 的进程纯属浪费，还会让 resolver 永远退不掉（每次保存都续命）。
///    环境换过（切工作区）同理——旧 worker 的缓存对不上新工作区，下一个 resolve
///    会连 worker 一起换掉，不用在这儿管它。
pub fn invalidate(env: &ResolverEnv, paths: &[PathBuf]) {
    let mut h = lock_holder();
    if let Some(at) = h.retry_at {
        if Instant::now() < at {
            return; // 退避中没有引擎，没什么可作废
        }
    }
    if h.worker.is_none() || !h.inited || h.key != env_key(env) {
        return;
    }
    let Some(worker) = h.worker.clone() else {
        return;
    };
    let Some(args) = write_invalidate_args(paths) else {
        return;
    };
    let arg_line = crate::class_fp::display(&args.to_string_lossy());
    let outcome = worker.call("invalidate", &[&arg_line], RESOLVE_TIMEOUT);
    let _ = std::fs::remove_file(&args);
    h.last_used = Instant::now();
    if let Err(e) = outcome {
        note_failure(&mut h, &e);
    }
}

/// 应用退出 / 切工作区时调用（挂 `app_lifecycle::shutdown`）。
pub fn shutdown() {
    let Some(lock) = HOLDER.get() else {
        return;
    };
    let dropped = {
        let mut h = lock.lock().unwrap_or_else(|e| e.into_inner());
        h.inited = false;
        h.worker.take()
    };
    // 关进程放在锁外：持锁杀子进程会卡住并发查询（ecj_worker 同款教训）
    if let Some(w) = dropped {
        w.shutdown();
    }
}

pub fn status() -> Status {
    let s = &STATS;
    let Some(lock) = HOLDER.get() else {
        return Status::idle();
    };
    let h = lock.lock().unwrap_or_else(|e| e.into_inner());
    let remaining = h
        .retry_at
        .filter(|at| *at > Instant::now())
        .map(|at| at.saturating_duration_since(Instant::now()).as_secs())
        .unwrap_or(0);
    let state = if remaining > 0 {
        "backoff"
    } else if h.worker.is_some() && h.inited {
        "ready"
    } else {
        "idle"
    };
    Status {
        state,
        queries: s.queries.load(Ordering::Relaxed),
        answers: s.answers.load(Ordering::Relaxed),
        misses: s.misses.load(Ordering::Relaxed),
        failures: h.failures,
        timeouts: s.timeouts.load(Ordering::Relaxed),
        ooms: s.ooms.load(Ordering::Relaxed),
        spawns: s.spawns.load(Ordering::Relaxed),
        trimmed: s.trimmed.load(Ordering::Relaxed),
        backoff_remaining_secs: remaining,
        last_query_ms: Some(s.last_ms.load(Ordering::Relaxed)).filter(|v| *v > 0),
        total_query_ms: s.ms_total.load(Ordering::Relaxed),
        error: h.last_error.clone(),
    }
}

// ───────────────────────── worker 生命周期 ─────────────────────────

/// 取出（必要时重建）当前环境的 worker。`None` = 环境不可用（已记 `last_error`，
/// **不记退避**：缺 NC home / 缺 jar 不花钱，下次点击再试）。
fn ensure_worker(h: &mut Holder, env: &ResolverEnv) -> Option<Arc<Bridge>> {
    let key = env_key(env);
    if h.key != key || h.worker.is_none() {
        if !env.java.is_file() {
            h.last_error = Some(format!("找不到 NC 自带 JDK：{}", env.java.display()));
            return None;
        }
        if !env.bridge.is_file() {
            h.last_error = Some(format!(
                "缺 binding resolver 桥 jar（{}），重跑 node scripts/build-bridge-jar.mjs ecj",
                env.bridge.display()
            ));
            return None;
        }
        if env.plugins.is_empty() {
            h.last_error = Some("jdtls plugins 里没有 jar，ECJ 没地方来".to_string());
            return None;
        }
        let entries = match classpath_entries(env) {
            Ok(e) if !e.is_empty() => e,
            Ok(_) => {
                h.last_error =
                    Some("classpath 为空：影子工程没生成，NC home 里也没有 jar".to_string());
                return None;
            }
            Err(e) => {
                h.last_error = Some(e);
                return None;
            }
        };
        if let Some(old) = h.worker.take() {
            old.shutdown();
        }
        let mut jars = Vec::with_capacity(env.plugins.len() + 1);
        jars.push(env.bridge.clone());
        jars.extend(env.plugins.iter().cloned());
        h.worker = Some(Arc::new(Bridge::new(BridgeEnv {
            java: env.java.clone(),
            jars,
            // Java 侧 main 不读 --config（resolver 用不到 SVNKit 那套），传桥自己的
            // 配置目录即可——不要退回系统临时目录：这个文件的 `#[cfg(test)]` 声明在
            // 第 33 行，临时目录棘轮从那里往后数，生产代码里的裸调用会白占
            // 「测试禁用裸调用」的额度（零 slack 时，任何新测试都会因此变红）。
            config_dir: env.config_dir.clone(),
            main_class: "BindingResolver".to_string(),
            label: "binding".to_string(),
            xmx_mb: XMX_MB,
        })));
        h.key = key;
        h.entries = entries;
        h.inited = false;
    }
    h.worker.clone()
}

fn send_init(worker: &Arc<Bridge>, entries: &[PathBuf]) -> Result<(), BridgeError> {
    let args = write_init_args(entries)
        .map_err(|e| BridgeError::new("other", format!("写 classpath 文件失败：{e}")))?;
    let arg_line = crate::class_fp::display(&args.to_string_lossy());
    let r = worker.call("init", &[&arg_line], INIT_TIMEOUT);
    let _ = std::fs::remove_file(&args);
    match r {
        Ok(v) => {
            log::info!(
                "binding resolver 就绪：classpath {} 条，rtJar={}",
                v.get("entries").and_then(|x| x.as_u64()).unwrap_or(0),
                v.get("rtJar").and_then(|x| x.as_bool()).unwrap_or(false)
            );
            Ok(())
        }
        Err(e) => Err(e),
    }
}

/// 记一次失败并决定退避。超时 / oom / 协议错 / 起不来都算——共同点是「这条进程
/// 不可信」，而每次点击都重拉一个 768MB 的 JVM 比答不上更糟（设计 §4）。
fn note_failure(h: &mut Holder, e: &BridgeError) {
    match e.code.as_str() {
        "timeout" => Stats::bump(&STATS.timeouts),
        "oom" => Stats::bump(&STATS.ooms),
        "spawn" => Stats::bump(&STATS.spawns),
        _ => Stats::bump(&STATS.protocol),
    }
    let dropped = h.worker.take();
    h.inited = false;
    h.failures = h.failures.saturating_add(1);
    let delay = backoff_delay(h.failures);
    h.retry_at = Some(Instant::now() + delay);
    h.last_error = Some(e.message.clone());
    log::warn!(
        "binding resolver 失败（{}，第 {} 次，{}s 后重试）：{}",
        e.code,
        h.failures,
        delay.as_secs(),
        e.message
    );
    if let Some(w) = dropped {
        w.shutdown();
    }
}

/// 退避时长：公式**照抄** `fast_decl::Holder`（30s 起翻倍、封顶 10min），不新造。
/// 第一次失败就是 60s——索引那边就是这个数，两边一致才好排查。
fn backoff_delay(failures: u32) -> Duration {
    Duration::from_secs(30u64 << failures.min(5)).min(BACKOFF_CAP)
}

/// 空闲判定（抽出来是为了单测能喂合成时刻，与 `ecj_worker::trim` 同一思路）。
fn idle_expired(last_used: Instant, now: Instant) -> bool {
    now.duration_since(last_used) >= IDLE_TTL
}

fn trim_loop() {
    loop {
        std::thread::sleep(TRIM_TICK);
        let Some(lock) = HOLDER.get() else {
            continue;
        };
        // 一次锁内判完就取：查询是持锁跑完整次调用的，锁拿着就没有在途查询，
        // 判定和取走之间不可能插进来一个「刚用完」的查询把 worker 砍早了。
        let dropped = {
            let mut h = lock.lock().unwrap_or_else(|e| e.into_inner());
            if h.worker.is_some() && idle_expired(h.last_used, Instant::now()) {
                h.inited = false;
                h.worker.take()
            } else {
                None
            }
        };
        if let Some(w) = dropped {
            w.shutdown();
            Stats::bump(&STATS.trimmed);
            log::debug!("binding resolver 空闲 {}s，已退", IDLE_TTL.as_secs());
        }
    }
}

// ───────────────────────── 环境指纹与 classpath ─────────────────────────

/// 环境指纹。便宜（几个 stat + 字符串拼接）：每个查询都算，算完跟 Holder 里的比。
///
/// 含影子工程 `.classpath` 的 mtime/size：jdt.ls 重生成影子工程（换模块 / 换
/// NC home）后 classpath 会变，指纹必须跟着变，否则 resolver 拿着旧 classpath
/// 解析新工作区。文件不存在时 `stamp` 退回路径字面量——从「没有」变成「有」
/// 同样会变指纹（兜底路径用到一半、jdt.ls 起来了，能切过去）。
fn env_key(env: &ResolverEnv) -> String {
    let plugins = env
        .plugins
        .iter()
        .map(|p| crate::ecj_worker::stamp(p))
        .collect::<Vec<_>>()
        .join(";");
    format!(
        "{}|{}|{}|{}|{plugins}|{}",
        env.workspace_root.display(),
        env.nc_root.display(),
        crate::ecj_worker::stamp(&env.java),
        crate::ecj_worker::stamp(&env.bridge),
        crate::ecj_worker::stamp(&shadow_cp_file(env)),
    )
}

fn shadow_cp_file(env: &ResolverEnv) -> PathBuf {
    env.config_dir
        .join("lang")
        .join("shadow")
        .join(".classpath")
}

/// init 的 classpath：**影子工程同一份**（设计 §2「不重跑 select_jars 95s」）。
///
/// 主路径 = 解析影子工程的 `.classpath`（jdt.ls 启动早期就生成，见
/// `commands::lang_cmds::launch`）。`src` 条目是影子相对的 ⇒ 拼工作区根；
/// `lib` 是绝对路径。`con`（JRE 容器）与 `output` 跳过——rt.jar 由 Java 侧
/// 按 `java.home` 自己找（`BindingResolver.addBootJar`）。
///
/// 兜底（影子工程还没生成：没启动过代码智能）= NC home 的 Eclipse classpath
/// 全集 + 工作区源根 + 类目录。多带一些 jar（不做 import 精选）不要紧：
/// resolver 只解析传递闭包，多带的 jar 根本不会被打开。
/// 🔴 兜底路径没有「jar 增减」的指纹：进程存活期间发现不了 NC home 新装的组件。
///    正常路径不受影响——影子工程 mtime 进 key，重生成即换代。
fn classpath_entries(env: &ResolverEnv) -> Result<Vec<PathBuf>, String> {
    let cp_file = shadow_cp_file(env);
    if let Ok(xml) = std::fs::read_to_string(&cp_file) {
        let entries = parse_shadow_classpath(&xml, &env.workspace_root);
        if !entries.is_empty() {
            return Ok(entries);
        }
    }
    let mut out: Vec<PathBuf> = Vec::new();
    for m in crate::shadow::workspace_modules(&env.workspace_root) {
        for d in crate::shadow::SRC_DIRS {
            let p = env.workspace_root.join(&m).join(d);
            if p.is_dir() {
                out.push(p);
            }
        }
    }
    out.extend(crate::nc_index::classpath_jars(&env.nc_root));
    // overrides 传空：解析器是只读助手，不参与「关联工程覆盖」那套编译语义
    out.extend(crate::launch::project_class_dirs(
        &env.workspace_root,
        &env.nc_root,
        &[],
    ));
    Ok(out)
}

/// `<classpathentry>` 扫描：只认 `kind` + `path` 两个属性（`sourcepath`/`output`
/// 忽略）。不引 XML 库——影子工程的 `.classpath` 是我们自己生成的，形态固定。
fn parse_shadow_classpath(xml: &str, root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for tag in xml.split("<classpathentry").skip(1) {
        let kind = attr(tag, "kind");
        let Some(path) = attr(tag, "path") else {
            continue;
        };
        match kind.as_deref() {
            // 源根在影子工程里是 junction，拼工作区根拿到真实目录
            Some("src") => out.push(root.join(path)),
            Some("lib") => out.push(PathBuf::from(path)),
            _ => {}
        }
    }
    out
}

fn attr(tag: &str, key: &str) -> Option<String> {
    let pat = format!("{key}=\"");
    let i = tag.find(&pat)? + pat.len();
    let end = tag[i..].find('"')?;
    Some(tag[i..i + end].to_string())
}
