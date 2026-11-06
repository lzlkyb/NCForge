//! 常驻 ecj worker：把「一次编译起一个 JVM」换成复用一组常驻 JVM。
//!
//! 为什么值得：本机实测同一条 ecj 命令，一次一进程 660~900ms，同一 JVM 内第二次起
//! 24~54ms。差距全在 JVM 启动与 ecj 类加载，跟源码规模无关；保存后的单文件编译、
//! 补 jar 的多轮编译都要付这份钱。
//!
//! 约束（任何一条不满足都必须退回一次一进程，行为不能变）：
//! - 桥 jar 或 ecj jar 缺失 → 回退；
//! - 桥进程启动失败 / 中途退出 / 协议错误 → 回退；
//! - 用户取消 → 杀掉当前 worker（下次调用自动重拉），返回 `CANCELLED`；
//! - 超时 → 杀掉 worker，按超时错误返回（**不能**再回退重跑一遍，否则总耗时翻倍）；
//! - worker 堆爆了（`oom` 帧）→ 杀掉 worker，回退一次一进程（1GB）。不能把 OOM 当编译
//!   错误报给用户，那样问题面板会出现不存在的「错误」。
//!
//! 池上限故意很小：编译本身是单线程的，池只用于「有界并行构建」的并行槽位。
//! 空闲 worker 留着才叫常驻，但不能一直留 4 个：闲置 5 分钟后只留 1 个（见 `trim_loop`）。
//! 切换工作区 / java / jar 被替换时旧的一批关掉（`env_key` 带 jar 的 size + mtime）。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::compile::CANCELLED;
use crate::java_bridge::{Bridge, BridgeEnv};

/// 编译桥 jar 文件名（编译自 `src-tauri/ecj-bridge/NcEcjBridge.java`）。
pub const BRIDGE_JAR: &str = "ncecj.jar";

/// 常驻 JVM 上限。与构建并行上限（1~4）取小：超过这个数就排队，不再多开 JVM。
const MAX_WORKERS: usize = 4;
/// 并行构建结束后最多留几个空闲 worker；多出来的等 `IDLE_TTL` 后回收。
const IDLE_KEEP: usize = 1;
const IDLE_TTL: Duration = Duration::from_secs(300);
const TRIM_TICK: Duration = Duration::from_secs(30);
/// worker 的堆上限。单文件保存编译实测百兆级，512 足够；整模块构建若撑爆，
/// 桥回 `oom` 帧，这里杀掉 worker 并退回一次一进程（1GB），只是慢一次。
const XMX_MB: u32 = 512;

/// 进程内累计计数：给设置页看「常驻到底省了多少、回退了几次」。
///
/// 只增不减、进程退出即清零；不做持久化——跨版本的历史没有可比性（编译器、jar、
/// 模块规模都会变），拿它做趋势会得出错误结论。
#[derive(Default)]
struct Stats {
    cold_starts: AtomicU64,
    warm_hits: AtomicU64,
    fallback_missing: AtomicU64,
    fallback_spawn: AtomicU64,
    fallback_protocol: AtomicU64,
    fallback_oom: AtomicU64,
    timeouts: AtomicU64,
    cancels: AtomicU64,
    trimmed: AtomicU64,
    worker_compiles: AtomicU64,
    worker_ms_total: AtomicU64,
    oneshot_compiles: AtomicU64,
    oneshot_ms_total: AtomicU64,
    /// 完成的编译耗时分布（只统计真正跑完的 worker 编译与一次一进程）
    lt100: AtomicU64,
    lt300: AtomicU64,
    lt1000: AtomicU64,
    lt3000: AtomicU64,
    ge3000: AtomicU64,
}

static STATS: Stats = Stats::new_const();

impl Stats {
    const fn new_const() -> Self {
        Self {
            cold_starts: AtomicU64::new(0),
            warm_hits: AtomicU64::new(0),
            fallback_missing: AtomicU64::new(0),
            fallback_spawn: AtomicU64::new(0),
            fallback_protocol: AtomicU64::new(0),
            fallback_oom: AtomicU64::new(0),
            timeouts: AtomicU64::new(0),
            cancels: AtomicU64::new(0),
            trimmed: AtomicU64::new(0),
            worker_compiles: AtomicU64::new(0),
            worker_ms_total: AtomicU64::new(0),
            oneshot_compiles: AtomicU64::new(0),
            oneshot_ms_total: AtomicU64::new(0),
            lt100: AtomicU64::new(0),
            lt300: AtomicU64::new(0),
            lt1000: AtomicU64::new(0),
            lt3000: AtomicU64::new(0),
            ge3000: AtomicU64::new(0),
        }
    }

    fn bump(counter: &AtomicU64) {
        counter.fetch_add(1, Ordering::Relaxed);
    }

    fn bucket(&self, ms: u64) {
        let c = if ms < 100 {
            &self.lt100
        } else if ms < 300 {
            &self.lt300
        } else if ms < 1000 {
            &self.lt1000
        } else if ms < 3000 {
            &self.lt3000
        } else {
            &self.ge3000
        };
        Self::bump(c);
    }
}

/// 设置页读到的快照（序列化后直接进 `build_cache_info`）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerStats {
    pub cold_starts: u64,
    pub warm_hits: u64,
    pub fallback_missing: u64,
    pub fallback_spawn: u64,
    pub fallback_protocol: u64,
    pub fallback_oom: u64,
    pub timeouts: u64,
    pub cancels: u64,
    pub trimmed: u64,
    pub worker_compiles: u64,
    pub worker_ms_total: u64,
    pub oneshot_compiles: u64,
    pub oneshot_ms_total: u64,
    /// 耗时桶：`[0,100) [100,300) [300,1000) [1000,3000) [3000,∞)` 毫秒
    pub latency: [u64; 5],
}

pub fn stats() -> WorkerStats {
    let s = &STATS;
    WorkerStats {
        cold_starts: s.cold_starts.load(Ordering::Relaxed),
        warm_hits: s.warm_hits.load(Ordering::Relaxed),
        fallback_missing: s.fallback_missing.load(Ordering::Relaxed),
        fallback_spawn: s.fallback_spawn.load(Ordering::Relaxed),
        fallback_protocol: s.fallback_protocol.load(Ordering::Relaxed),
        fallback_oom: s.fallback_oom.load(Ordering::Relaxed),
        timeouts: s.timeouts.load(Ordering::Relaxed),
        cancels: s.cancels.load(Ordering::Relaxed),
        trimmed: s.trimmed.load(Ordering::Relaxed),
        worker_compiles: s.worker_compiles.load(Ordering::Relaxed),
        worker_ms_total: s.worker_ms_total.load(Ordering::Relaxed),
        oneshot_compiles: s.oneshot_compiles.load(Ordering::Relaxed),
        oneshot_ms_total: s.oneshot_ms_total.load(Ordering::Relaxed),
        latency: [
            s.lt100.load(Ordering::Relaxed),
            s.lt300.load(Ordering::Relaxed),
            s.lt1000.load(Ordering::Relaxed),
            s.lt3000.load(Ordering::Relaxed),
            s.ge3000.load(Ordering::Relaxed),
        ],
    }
}

/// 一次一进程编译完成（成功或有错误都算）后登记耗时。
pub fn note_oneshot(ms: u64) {
    STATS.oneshot_compiles.fetch_add(1, Ordering::Relaxed);
    STATS.oneshot_ms_total.fetch_add(ms, Ordering::Relaxed);
    STATS.bucket(ms);
}

struct Pool {
    /// 当前环境（java + jar 路径/内容）的指纹；变化即换代。
    key: String,
    idle: Vec<(String, Arc<Bridge>)>,
    /// 累计进程数（含正在用的），跨代计数，归还时按代决定去留。
    total: usize,
    /// 最后一次借出 / 归还的时间；空闲回收据此判断是否真的没人用。
    last_used: Instant,
}

static POOL: OnceLock<(Mutex<Pool>, Condvar)> = OnceLock::new();

fn pool() -> &'static (Mutex<Pool>, Condvar) {
    POOL.get_or_init(|| {
        // 空闲回收线程：只在有过编译后才会被拉起，随进程退出
        let _ = std::thread::Builder::new()
            .name("ecj-worker-trim".into())
            .spawn(trim_loop);
        (
            Mutex::new(Pool {
                key: String::new(),
                idle: Vec::new(),
                total: 0,
                last_used: Instant::now(),
            }),
            Condvar::new(),
        )
    })
}

/// 文件指纹：路径 + 大小 + mtime。只看路径的话，资源包原地换 jar 后旧 JVM 仍在用旧类。
fn stamp(path: &Path) -> String {
    match std::fs::metadata(path) {
        Ok(m) => {
            let nanos = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            format!("{}|{}|{nanos}", path.display(), m.len())
        }
        Err(_) => path.display().to_string(),
    }
}

fn env_key(env: &BridgeEnv) -> String {
    let jars = env
        .jars
        .iter()
        .map(|p| stamp(p))
        .collect::<Vec<_>>()
        .join(";");
    format!("{}|{jars}", stamp(&env.java))
}

fn cancelled(flag: Option<&AtomicBool>) -> bool {
    flag.map(|f| f.load(Ordering::Relaxed)).unwrap_or(false)
}

/// 闲置回收：超过 `IDLE_KEEP` 且最近 `ttl` 内没人借，就砍到 `IDLE_KEEP`。
/// 只返回要关掉的，关进程放在锁外做（持锁拉起/杀子进程会卡住其他编译线程）。
fn trim(p: &mut Pool, ttl: Duration, now: Instant) -> Vec<(String, Arc<Bridge>)> {
    if p.idle.len() <= IDLE_KEEP || now.duration_since(p.last_used) < ttl {
        return Vec::new();
    }
    let dropped = p.idle.split_off(IDLE_KEEP);
    p.total = p.total.saturating_sub(dropped.len());
    dropped
}

fn trim_loop() {
    loop {
        std::thread::sleep(TRIM_TICK);
        let Some((lock, cv)) = POOL.get() else {
            continue;
        };
        let dropped = {
            let mut p = lock.lock().unwrap_or_else(|e| e.into_inner());
            let dropped = trim(&mut p, IDLE_TTL, Instant::now());
            if !dropped.is_empty() {
                cv.notify_all();
            }
            dropped
        };
        if !dropped.is_empty() {
            STATS
                .trimmed
                .fetch_add(dropped.len() as u64, Ordering::Relaxed);
        }
        for (_, w) in dropped {
            w.shutdown();
        }
    }
}

fn acquire(env: BridgeEnv, cancel: Option<&AtomicBool>) -> Option<Arc<Bridge>> {
    let (lock, cv) = pool();
    let key = env_key(&env);
    let mut p = lock.lock().unwrap_or_else(|e| e.into_inner());
    loop {
        if p.key.is_empty() {
            p.key = key.clone();
        }
        if p.key != key {
            // 工作区/NC home 换了：旧 idle 关掉，在用的归还时也会被丢
            let stale = std::mem::take(&mut p.idle);
            p.total = p.total.saturating_sub(stale.len());
            p.key = key.clone();
            drop(p);
            for (_, w) in stale {
                w.shutdown();
            }
            p = lock.lock().unwrap_or_else(|e| e.into_inner());
        }
        if let Some((_, w)) = p.idle.pop() {
            p.last_used = Instant::now();
            Stats::bump(&STATS.warm_hits);
            return Some(w);
        }
        if p.total < MAX_WORKERS {
            p.total += 1;
            p.last_used = Instant::now();
            Stats::bump(&STATS.cold_starts);
            drop(p);
            return Some(Arc::new(Bridge::new(env)));
        }
        if cancelled(cancel) {
            return None;
        }
        let (guard, _) = cv
            .wait_timeout(p, Duration::from_millis(50))
            .unwrap_or_else(|e| e.into_inner());
        p = guard;
    }
}

fn release(worker: Arc<Bridge>) {
    let (lock, cv) = pool();
    let key = env_key(worker.env());
    let mut p = lock.lock().unwrap_or_else(|e| e.into_inner());
    if worker.alive() && p.key == key {
        p.idle.push((key, worker));
        p.last_used = Instant::now();
        cv.notify_one();
        return;
    }
    p.total = p.total.saturating_sub(1);
    drop(p);
    worker.shutdown();
    cv.notify_one();
}

/// 应用退出 / 切换工作区时调用：关掉空闲 worker；在用的归还时按换代丢弃。
pub fn shutdown_all() {
    let Some((lock, _)) = POOL.get() else {
        return;
    };
    let mut p = lock.lock().unwrap_or_else(|e| e.into_inner());
    let idle = std::mem::take(&mut p.idle);
    p.total = p.total.saturating_sub(idle.len());
    p.key.clear();
    drop(p);
    for (_, w) in idle {
        w.shutdown();
    }
}

/// 用常驻 worker 编译一份 ecj 参数文件。
///
/// - `Ok(Some((ok, output)))`：worker 完成了编译（ok 对应 ecj 退出码）；
/// - `Ok(None)`：worker 不可用（缺 jar / 启动失败 / 协议错误 / 堆不足），调用方应退回一次一进程；
/// - `Err(CANCELLED)` / `Err(超时)`：不能重跑，直接报给用户。
pub fn compile(
    java: &Path,
    ecj_jar: &Path,
    bridge_jar: &Path,
    args: &Path,
    timeout: Duration,
    cancel: Option<&AtomicBool>,
) -> Result<Option<(bool, String)>, String> {
    if !bridge_jar.is_file() || !ecj_jar.is_file() {
        Stats::bump(&STATS.fallback_missing);
        return Ok(None);
    }
    let started = Instant::now();
    let env = BridgeEnv {
        java: java.to_path_buf(),
        jars: vec![bridge_jar.to_path_buf(), ecj_jar.to_path_buf()],
        config_dir: std::env::temp_dir(),
        main_class: "NcEcjBridge".to_string(),
        label: "ecj".to_string(),
        xmx_mb: XMX_MB,
    };
    let Some(worker) = acquire(env, cancel) else {
        Stats::bump(&STATS.cancels);
        return Err(CANCELLED.to_string());
    };
    let arg_line = args.to_string_lossy().into_owned();
    let done = AtomicBool::new(false);
    let done_ref = &done;
    let outcome = std::thread::scope(|scope| {
        let watcher = cancel.map(|flag| {
            let w = Arc::clone(&worker);
            scope.spawn(move || {
                while !done_ref.load(Ordering::Relaxed) {
                    if flag.load(Ordering::Relaxed) {
                        // 杀掉正在编译的 JVM：调用方会收到「桥进程已退出」，再按取消上报。
                        // 下次编译会自动拉起新 worker（冷启动一次，但用户已经主动取消）。
                        w.restart();
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(40));
                }
            })
        });
        let r = worker.call("compile", &[&arg_line], timeout);
        done.store(true, Ordering::Relaxed);
        if let Some(h) = watcher {
            let _ = h.join();
        }
        r
    });
    // 堆已经爆过：进程状态不可信（碎片/半成品输出），杀掉，下次重新拉起
    if matches!(&outcome, Err(e) if e.code == "oom") {
        log::warn!("常驻 ecj worker 堆不足，本轮回退一次一进程（1GB）");
        worker.restart();
    }
    record_outcome(&outcome, started.elapsed().as_millis() as u64, cancel);
    release(worker);
    map_outcome(outcome, timeout, cancel)
}

/// 记录一次 worker 尝试的结果。超时/取消/回退分开计数：回退多说明环境有问题，
/// 取消多说明用户等不及，两者的处置完全不同。
fn record_outcome(
    outcome: &Result<serde_json::Value, crate::java_bridge::BridgeError>,
    ms: u64,
    cancel: Option<&AtomicBool>,
) {
    match outcome {
        Ok(_) => {
            STATS.worker_compiles.fetch_add(1, Ordering::Relaxed);
            STATS.worker_ms_total.fetch_add(ms, Ordering::Relaxed);
            STATS.bucket(ms);
        }
        Err(_) if cancelled(cancel) => Stats::bump(&STATS.cancels),
        Err(e) if e.code == "timeout" => Stats::bump(&STATS.timeouts),
        Err(e) if e.code == "oom" => Stats::bump(&STATS.fallback_oom),
        Err(e) if e.code == "spawn" => Stats::bump(&STATS.fallback_spawn),
        Err(_) => Stats::bump(&STATS.fallback_protocol),
    }
}

/// 桥回包 → 调用方语义。单独拆出来是为了能喂合成错误（OOM / 超时 / 取消）做单测。
fn map_outcome(
    outcome: Result<serde_json::Value, crate::java_bridge::BridgeError>,
    timeout: Duration,
    cancel: Option<&AtomicBool>,
) -> Result<Option<(bool, String)>, String> {
    match outcome {
        Ok(v) => {
            let exit = v.get("exit").and_then(|x| x.as_i64()).unwrap_or(1);
            let output = v.get("output").and_then(|x| x.as_str()).unwrap_or("").to_string();
            Ok(Some((exit == 0, output)))
        }
        Err(_) if cancelled(cancel) => Err(CANCELLED.to_string()),
        Err(e) if e.code == "timeout" => Err(format!(
            "编译超时（超过 {} 秒），已终止",
            timeout.as_secs()
        )),
        // 包括 oom：worker 这条路的错误一律回退一次一进程
        Err(_) => Ok(None),
    }
}

/// 在某组目录里找编译桥 jar；找不到返回 `None`（调用方退回一次一进程）。
pub fn find_jar(dirs: &[PathBuf]) -> Option<PathBuf> {
    dirs.iter().map(|d| d.join(BRIDGE_JAR)).find(|p| p.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    /// 缺 jar 必须走回退，而不是报错——打包漏了桥 jar 也不能让编译彻底不可用。
    #[test]
    fn missing_bridge_falls_back() {
        let missing = PathBuf::from("no-such-dir").join("missing.jar");
        let r = compile(
            Path::new("java"),
            &missing,
            &missing,
            Path::new("args.txt"),
            Duration::from_secs(1),
            None,
        );
        assert!(matches!(r, Ok(None)), "缺 jar 应回退：{r:?}");
    }

    fn test_env(jars: Vec<PathBuf>) -> BridgeEnv {
        BridgeEnv {
            java: PathBuf::from("java"),
            jars,
            config_dir: PathBuf::new(),
            main_class: "NcEcjBridge".to_string(),
            label: "ecj".to_string(),
            xmx_mb: 1,
        }
    }

    /// 合成错误帧：OOM/协议错回退，超时/取消不能回退（回退会让用户多等一遍）。
    #[test]
    fn outcome_mapping() {
        use crate::java_bridge::BridgeError;
        let t = Duration::from_secs(30);
        let err = |code: &str| Err(BridgeError::new(code, "x"));
        assert!(matches!(map_outcome(err("oom"), t, None), Ok(None)));
        assert!(matches!(map_outcome(err("other"), t, None), Ok(None)));
        assert_eq!(
            map_outcome(err("timeout"), t, None).unwrap_err(),
            "编译超时（超过 30 秒），已终止"
        );
        let cancelled_flag = AtomicBool::new(true);
        assert_eq!(
            map_outcome(err("other"), t, Some(&cancelled_flag)).unwrap_err(),
            CANCELLED
        );
        let ok = serde_json::json!({"exit": 0, "output": "fine"});
        assert_eq!(
            map_outcome(Ok(ok), t, None).unwrap(),
            Some((true, "fine".to_string()))
        );
    }

    /// 延迟桶边界是左闭右开：99→[0,100)，100→[100,300)，3000→[3000,∞)。
    #[test]
    fn latency_buckets_are_half_open() {
        let s = Stats::new_const();
        for ms in [0, 99, 100, 299, 300, 999, 1000, 2999, 3000, 10_000] {
            s.bucket(ms);
        }
        let got = [
            s.lt100.load(Ordering::Relaxed),
            s.lt300.load(Ordering::Relaxed),
            s.lt1000.load(Ordering::Relaxed),
            s.lt3000.load(Ordering::Relaxed),
            s.ge3000.load(Ordering::Relaxed),
        ];
        assert_eq!(got, [2, 2, 2, 2, 2]);
    }

    /// 只换内容、路径不变（资源包原地更新）也必须换代，否则旧 JVM 还加载着旧类。
    #[test]
    fn env_key_tracks_jar_content() {
        let dir = std::env::temp_dir().join(format!("ncf-ecj-key-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let jar = dir.join("ecj.jar");
        std::fs::write(&jar, b"aaaa").unwrap();
        let k1 = env_key(&test_env(vec![jar.clone()]));
        std::thread::sleep(Duration::from_millis(5));
        std::fs::write(&jar, b"bbbb").unwrap();
        let k2 = env_key(&test_env(vec![jar.clone()]));
        assert_ne!(k1, k2, "同路径同大小的新内容应换指纹");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn test_pool(idle: usize, last_used: Instant) -> Pool {
        let env = test_env(Vec::new());
        Pool {
            key: "k".to_string(),
            idle: (0..idle)
                .map(|_| ("k".to_string(), Arc::new(Bridge::new(env.clone()))))
                .collect(),
            total: idle,
            last_used,
        }
    }

    /// 闲置回收：构建刚结束不能砍（多轮编译还要复用），放够 TTL 才砍到 IDLE_KEEP。
    #[test]
    fn idle_trim() {
        let now = Instant::now();
        let ttl = Duration::from_secs(300);

        let mut fresh = test_pool(4, now);
        assert!(trim(&mut fresh, ttl, now).is_empty(), "刚用完不该砍");

        let mut stale = test_pool(4, now - Duration::from_secs(600));
        let dropped = trim(&mut stale, ttl, now);
        assert_eq!(dropped.len(), 3, "闲置超时应砍到只剩 {IDLE_KEEP} 个");
        assert_eq!(stale.idle.len(), IDLE_KEEP);
        assert_eq!(stale.total, IDLE_KEEP, "total 要跟 idle 一起减");

        let mut single = test_pool(1, now - Duration::from_secs(600));
        assert!(trim(&mut single, ttl, now).is_empty(), "只剩 1 个不砍");
    }

    fn live_env() -> Option<(PathBuf, PathBuf, PathBuf)> {
        let home = [
            PathBuf::from("D:/ncc/1909home"),
            PathBuf::from("C:/ncc/1909home"),
        ]
        .into_iter()
        .find(|p| p.is_dir())?;
        let java = home.join("ufjdk").join("bin").join("java.exe");
        let res = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources");
        let ecj = res.join("ecj").join("ecj-3.17.jar");
        let bridge = res.join("ecj-bridge").join(BRIDGE_JAR);
        [&java, &ecj, &bridge]
            .iter()
            .all(|p| p.is_file())
            .then_some((java, ecj, bridge))
    }

    /// 真机：同一常驻 JVM 连编两次（第二次含报错），且退出后能重新拉起。
    ///
    /// 运行：`node scripts/rust-gate.mjs test --lib -- --ignored persistent_worker_live --nocapture`
    #[test]
    #[ignore]
    fn persistent_worker_live() {
        let Some((java, ecj, bridge)) = live_env() else {
            println!("跳过：本机没有 java / ecj / 桥 jar");
            return;
        };
        let work = std::env::temp_dir().join("ncf-ecj-worker-live");
        let src = work.join("src");
        let out = work.join("out");
        let _ = std::fs::remove_dir_all(&work);
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir_all(&out).unwrap();
        let good = src.join("Good.java");
        std::fs::write(&good, "public class Good { public static int one() { return 1; } }\n").unwrap();
        let bad = src.join("Bad.java");
        std::fs::write(&bad, "public class Bad { int x = ; }\n").unwrap();

        let args = |name: &str, file: &Path| {
            let p = work.join(name);
            std::fs::write(
                &p,
                format!(
                    "-1.8 -g -nowarn -proc:none\n-d \"{}\"\n\"{}\"\n",
                    out.display().to_string().replace('\\', "/"),
                    file.display().to_string().replace('\\', "/")
                ),
            )
            .unwrap();
            p
        };
        let bad_args = args("bad.args", &bad);
        let good_args = args("good.args", &good);

        let t0 = Instant::now();
        let cold = compile(&java, &ecj, &bridge, &bad_args, Duration::from_secs(60), None)
            .expect("worker 不应报错");
        let cold_ms = t0.elapsed().as_millis();
        let Some((ok, text)) = cold else {
            panic!("桥 jar 存在却没走常驻 worker");
        };
        assert!(!ok, "有语法错误应返回失败");
        assert!(text.contains("ERROR"), "输出里应有 ERROR：{text}");

        // 第二次：已预热的 JVM，同时验证第一次的失败不会污染下一次编译
        let t1 = Instant::now();
        let warm = compile(&java, &ecj, &bridge, &good_args, Duration::from_secs(60), None)
            .expect("worker 不应报错");
        let warm_ms = t1.elapsed().as_millis();
        let (ok, text) = warm.expect("桥 jar 存在却没走常驻 worker");
        assert!(ok, "合法源码应编过：{text}");
        assert!(out.join("Good.class").is_file(), "class 没落盘");

        // 关掉后还能重新拉起（应用退出清理 / 切换工作区走这条）
        shutdown_all();
        let t2 = Instant::now();
        let again = compile(&java, &ecj, &bridge, &good_args, Duration::from_secs(60), None)
            .expect("重启后不应报错");
        let again_ms = t2.elapsed().as_millis();
        assert!(again.map(|(ok, _)| ok).unwrap_or(false), "重启后编译失败");

        // 超时：报超时而不是回退重跑，杀掉的 worker 下次自动重拉
        let timed_out = compile(
            &java,
            &ecj,
            &bridge,
            &good_args,
            Duration::from_millis(1),
            None,
        );
        assert!(
            matches!(&timed_out, Err(e) if e.contains("编译超时")),
            "1ms 超时应报超时：{timed_out:?}"
        );
        // 超时杀掉的 worker 不能留在池里：下一次冷启动一次仍应成功
        let after_timeout = compile(&java, &ecj, &bridge, &good_args, Duration::from_secs(60), None)
            .expect("超时后不应报错");
        let (ok, text) = after_timeout.expect("超时后仍应走常驻 worker");
        assert!(ok, "超时后重新拉起的 worker 编译失败：{text}");

        // 中途中止：watcher 杀掉正在编译的 JVM，调用方拿到 CANCELLED
        let big = src.join("Big.java");
        let mut code = String::from("public class Big {\n");
        for i in 0..20000 {
            code.push_str(&format!("  int m{i}() {{ return {i}; }}\n"));
        }
        code.push_str("}\n");
        std::fs::write(&big, code).unwrap();
        let big_args = args("big.args", &big);
        let flag = Arc::new(AtomicBool::new(false));
        let setter = {
            let flag = Arc::clone(&flag);
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(150));
                flag.store(true, Ordering::Relaxed);
            })
        };
        let cancelled_run = compile(
            &java,
            &ecj,
            &bridge,
            &big_args,
            Duration::from_secs(120),
            Some(&flag),
        );
        setter.join().unwrap();
        assert!(
            matches!(&cancelled_run, Err(e) if e == CANCELLED),
            "取消后应返回 CANCELLED：{cancelled_run:?}"
        );
        // 被杀的 worker 不能留在池里：下一次编译仍要成功
        let after_cancel = compile(&java, &ecj, &bridge, &good_args, Duration::from_secs(60), None)
            .expect("取消后不应报错");
        assert!(
            after_cancel.map(|(ok, _)| ok).unwrap_or(false),
            "取消后重新拉起的 worker 编译失败"
        );

        println!(
            "常驻编译：首次 {cold_ms} ms · 预热 {warm_ms} ms · 重启后 {again_ms} ms · 超时与取消分支通过"
        );
        assert!(
            warm_ms * 2 < cold_ms,
            "预热应明显快于首次：{cold_ms} vs {warm_ms} ms"
        );
        shutdown_all();
    }
}
