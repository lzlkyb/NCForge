//! 数据库命令层：多连接、执行任意语句、事务、元数据；以及表结构缓存与出包核对。
//!
//! 约定：
//! 1. **一个连接一个引擎句柄**（`state.db` 按连接 id 存），句柄底下是一条独立的数据库会话。
//!    A 方案后多条会话共用一个 JVM（内存从「每连接 50~70MB」降到「每连接几 MB」），
//!    每条会话在桥里各有一个工作线程，所以一个库上的慢查询仍然不会把另一个库堵住。
//! 2. **读写不在软件里限制**：能不能写由数据库账号权限决定。桥只报告事务状态
//!    （手动提交模式下几条写语句、影响多少行），界面据此提醒。
//! 3. **口令**：prop.xml 来源由桥里的 NC `PropXMLReader` 现解，不经过 Rust、不落盘；
//!    手动来源由用户输一次，DPAPI 加密存本机（与 SVN 凭据同一套）。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::config::{AppConfig, DbConnConfig};
use crate::db_bridge;
use crate::db_engine::{EngineHandle, EngineKind};
use crate::db_schema;
use crate::sql_refs;
use crate::state::AppState;
use crate::svn_cred;

/// 连库（含握手）留足余量。
pub(crate) const T_CONNECT: Duration = Duration::from_secs(60);
/// 元数据（表清单、DDL、执行计划）。
const T_META: Duration = Duration::from_secs(120);
/// 临时会话名：列数据源、测试连接、解 prop.xml 口令共用，不占用任何真实连接的会话。
pub(crate) const PROBE: &str = "__probe";

// ───────────────────────── 会话槽（A0：多标签独立会话） ─────────────────────────

/// 一条连接上最多几个额外会话槽。**不含 primary**。
///
/// 为什么是 3：`open_cursors` 与服务端会话数都要留余量；更重要的是——超过三四个标签
/// 各跑长查询时，用户自己也分不清哪个事务在哪条会话里，界面会从「不堵」变成「看不懂」。
const MAX_SLOTS: usize = 3;
/// 槽空闲多久回收。关标签时正常释放，这条只兜「标签被异常关掉 / 应用崩溃后的残留」。
const SLOT_IDLE: Duration = Duration::from_secs(600);

/// 槽位的引擎键：primary 用连接 id（保持老行为），额外会话用 `id#N`。
///
/// **只允许数字槽名**：这个键会拼进 Java 桥的会话名与日志，允许任意字符串等于把
/// 前端输入当标识符用。
pub(crate) fn slot_key(id: &str, slot: Option<&str>) -> Result<String, String> {
    match slot.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(id.to_string()),
        Some(s) if s.chars().all(|c| c.is_ascii_digit()) && s.len() <= 2 => Ok(format!("{id}#{s}")),
        Some(s) => Err(code_label("sql", &format!("会话槽名不合法：{s}"))),
    }
}

/// JVM 桥兜底会话的键后缀（P0 能力路由）。
///
/// 它不是会话槽，也不属于 primary：是挂在某个引擎键下面的**临时会话**，只在
/// 「Rust 引擎跑不了这条 REF CURSOR 语句」时出现。命名空间必须与槽分开——
/// `live_slots` 只认数字，`split_slot_key` 先剥这个后缀，两边都把它当「同一条连接」。
const JAVA_SUFFIX: &str = "#java";

/// 某个引擎键对应的兜底会话键（`c1` → `c1#java`，`c1#2` → `c1#2#java`）。
pub(crate) fn java_key(base: &str) -> String {
    format!("{base}{JAVA_SUFFIX}")
}

/// 引擎键 → (连接 id, 槽名)。给退出前的事务探测用：`c1#2` 属于连接 `c1` 的第 2 个槽。
///
/// `c1#java` / `c1#2#java` 是同一连接的兜底会话，归到它所属的那条连接上——
/// 否则退出确认里会冒出「c1#java」这种用户看不懂的假连接。
pub(crate) fn split_slot_key(key: &str) -> (&str, Option<&str>) {
    let key = key.strip_suffix(JAVA_SUFFIX).unwrap_or(key);
    match key.rsplit_once('#') {
        Some((id, slot)) if !id.is_empty() && slot.chars().all(|c| c.is_ascii_digit()) => {
            (id, Some(slot))
        }
        _ => (key, None),
    }
}

/// 槽的最近使用时刻（引擎键 → 时刻）。
///
/// 放模块级 static 而不是 `AppState`：只有这里的回收逻辑读它，没有第二个读者；
/// 存进 AppState 反而要在构造处多加一处默认值，还要在测试里手工清空。
fn slot_touch() -> &'static std::sync::Mutex<std::collections::HashMap<String, Instant>> {
    static TOUCH: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, Instant>>,
    > = std::sync::OnceLock::new();
    TOUCH.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// 记一次使用。取不到锁不影响任何功能（最坏是这条槽晚一点被回收）。
fn touch_slot(key: &str) {
    if let Ok(mut m) = slot_touch().lock() {
        m.insert(key.to_string(), Instant::now());
    }
}

fn forget_slot(key: &str) {
    if let Ok(mut m) = slot_touch().lock() {
        m.remove(key);
    }
}

/// 这个连接上现在活着的槽号（升序）。
///
/// **只认数字后缀**：`c1#java`（兜底会话）也在 `{id}#` 下，但它不是槽，
/// 混进来会挤掉用户的会话额度、还会被空闲回收逻辑当成槽去关。
fn live_slots(state: &AppState, id: &str) -> Vec<String> {
    let prefix = format!("{id}#");
    let mut out: Vec<String> = state
        .db
        .lock()
        .map(|m| {
            m.keys()
                .filter_map(|k| k.strip_prefix(&prefix).map(str::to_string))
                .filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()) && s.len() <= 2)
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out
}

/// 空闲槽的探测超时。与退出前的 `PING_TIMEOUT` 同量级：ping 要拿会话锁，
/// 长查询在跑时会排队，等太久会把「申请一条槽」也拖慢。
const SLOT_PING: Duration = Duration::from_secs(2);

/// 探测结果 → 这条空闲槽能不能收回。
///
/// **超时不算干净**：空闲 10 分钟不等于没人用——跑了 20 分钟的长查询、
/// 或者一个改完就停手的事务，恰恰最容易落在「很闲」那一侧。
fn idle_slot_reclaimable(ping: &Result<Value, String>) -> bool {
    let Ok(v) = ping else {
        return false;
    };
    // 桥返回 `alive:false` 时 tx 里是上一次的残留数据，不能当依据；连接既然断了，收回是安全的。
    if !v.get("alive").and_then(Value::as_bool).unwrap_or(true) {
        return true;
    }
    let tx = v.get("tx");
    let statements = tx
        .and_then(|t| t.get("statements"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let auto_commit = tx
        .and_then(|t| t.get("autoCommit"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    // 只有写语句会累加 statements（DDL 会重置），`>0` 就等价于「有未提交的写入」。
    auto_commit || statements == 0
}

/// 回收空闲超时的槽。**在申请槽时顺手扫一遍**，不起后台线程——
/// 桌面应用里为了回收会话养一个定时器，代价比扫这一眼高得多。
///
/// 收回前先探一次事务：探测失败或有未提交写入就留下并重置计时，
/// 免得每次申请槽都对同一条会话再探一遍。
async fn sweep_idle_slots(state: &AppState, id: &str) {
    let now = Instant::now();
    let stale: Vec<String> = live_slots(state, id)
        .into_iter()
        .filter(|n| {
            let key = format!("{id}#{n}");
            match slot_touch().lock() {
                Ok(m) => m
                    .get(&key)
                    .map(|t| now.duration_since(*t) >= SLOT_IDLE)
                    .unwrap_or(false),
                // 取不到锁就当作还活着：宁可多留一条会话，也不要误杀正在用的
                Err(_) => false,
            }
        })
        .collect();
    if stale.is_empty() {
        return;
    }
    // 并行探测：每条槽自带 SLOT_PING 超时。串行时一个卡住的长查询会把「申请一条
    // 槽」拖到「槽数 × 2 秒」——用户点「新会话」时看到的就是界面卡住，而这里
    // 本来只是顺手扫一眼。
    let probed = futures_util::future::join_all(stale.iter().map(|n| {
        let key = format!("{id}#{n}");
        async move {
            match existing_bridge(state, &key) {
                Ok(h) => (key, Some(call(h, "ping", Vec::new(), SLOT_PING).await)),
                Err(_) => (key, None),
            }
        }
    }))
    .await;
    for (key, ping) in probed {
        let Some(ping) = ping else {
            // 拿不到句柄：会话已经不在了，只差登记没清
            forget_slot(&key);
            continue;
        };
        if !idle_slot_reclaimable(&ping) {
            touch_slot(&key);
            continue;
        }
        drop_bridge(state, &key);
        drop_bridge(state, &java_key(&key));
        forget_slot(&key);
    }
}

/// 取某个连接上某条会话的引擎键对应的句柄。
///
/// 槽被回收（空闲超 10 分钟 / 断开连接）时要给出**能让用户知道下一步做什么**的错误，
/// 不能复用 primary 的「还没连上」——那会让人以为整个连接掉了。
pub(crate) fn slot_bridge(
    state: &AppState,
    id: &str,
    slot: Option<&str>,
) -> Result<Arc<EngineHandle>, String> {
    let key = slot_key(id, slot)?;
    match existing_bridge(state, &key) {
        Ok(h) => {
            touch_slot(&key);
            Ok(h)
        }
        Err(e) => Err(match slot {
            None => e,
            Some(s) => code_label(
                "slot-gone",
                &format!("标签的独立会话 {s} 已经回收（空闲超过 10 分钟或连接断开），重新执行一次会自动重开"),
            ),
        }),
    }
}

// ───────────────────────── prop.xml（只读解析，不含口令） ─────────────────────────

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PropDb {
    pub url: String,
    pub user: String,
    pub database_type: String,
    /// prop.xml 里 `isEncode=true`：口令是 NC 加密格式（要靠桥里的 PropXMLReader 解）。
    pub password_encoded: bool,
    /// 从哪个文件读到的。
    pub source: String,
}

/// 解析 NC 的 `ierp/bin/prop.xml`，取基础数据源（`isBase=true`，没有就取第一个）。
///
/// 只在「还没有任何连接配置」时给表结构缓存 / 出包核对兜底用；数据库页的连接列表
/// 走桥里的 `propList`（能列出全部数据源）。
pub fn parse_prop(bytes: &[u8], source: &str) -> Result<PropDb, String> {
    let xml = String::from_utf8_lossy(bytes).to_string();
    let blocks = split_data_sources(&xml);
    if blocks.is_empty() {
        return Err("prop.xml 里没有 <dataSource>，可能读错了文件".to_string());
    }
    let block = blocks
        .iter()
        .find(|b| {
            tag(b, "isBase")
                .map(|v| v.eq_ignore_ascii_case("true"))
                .unwrap_or(false)
        })
        .copied()
        .unwrap_or(blocks[0]);
    let url = tag(block, "databaseUrl")
        .ok_or_else(|| "prop.xml 的 dataSource 里没有 databaseUrl".to_string())?;
    Ok(PropDb {
        url,
        user: tag(block, "user").unwrap_or_default(),
        database_type: tag(block, "databaseType").unwrap_or_default(),
        password_encoded: tag(&xml, "isEncode")
            .map(|v| v.eq_ignore_ascii_case("true"))
            .unwrap_or(false),
        source: source.to_string(),
    })
}

fn split_data_sources(xml: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find("<dataSource>") {
        let after = &rest[start + "<dataSource>".len()..];
        let Some(end) = after.find("</dataSource>") else {
            break;
        };
        out.push(&after[..end]);
        rest = &after[end..];
    }
    out
}

fn tag(block: &str, name: &str) -> Option<String> {
    let open = format!("<{name}>");
    let close = format!("</{name}>");
    let start = block.find(&open)? + open.len();
    let end = block[start..].find(&close)? + start;
    let v = block[start..end].trim();
    if v.is_empty() {
        None
    } else {
        Some(v.to_string())
    }
}

fn read_prop(cfg: &AppConfig) -> Option<PropDb> {
    let home = crate::nc_home::resolve(cfg.nc_home.as_deref()).ok()?;
    let cands = [
        Path::new(&home.root)
            .join("ierp")
            .join("bin")
            .join("prop.xml"),
        Path::new(&home.root).join("bin").join("prop.xml"),
    ];
    let p = cands.into_iter().find(|p| p.is_file())?;
    let bytes = std::fs::read(&p).ok()?;
    parse_prop(&bytes, &p.display().to_string()).ok()
}

// ───────────────────────── 桥 ─────────────────────────

fn resource_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        dirs.push(dir.join("ncdb"));
    }
    dirs.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/ncdb"));
    dirs
}

/// 桥的环境：自带 ncdb.jar + NC home 的 Oracle 驱动 + 解 prop.xml 口令要的两个 NC jar。
fn bridge_env(
    app: &AppHandle,
    state: &AppState,
    cfg: &AppConfig,
) -> Result<db_bridge::BridgeEnv, String> {
    let home = crate::nc_home::resolve(cfg.nc_home.as_deref())?;
    let (jar, _) = db_bridge::find_jar(&resource_dirs(app))
        .ok_or_else(|| "找不到内置的 ncdb.jar，安装包可能不完整".to_string())?;
    let root = Path::new(&home.root);
    let driver = db_bridge::find_driver(root).ok_or_else(|| {
        format!(
            "{} 下没有 Oracle 驱动（driver/oracle_11g/ojdbc6.jar）",
            home.root
        )
    })?;
    let cfg_dir = state.config_dir.join("db");
    std::fs::create_dir_all(&cfg_dir).map_err(|e| format!("建目录失败 {cfg_dir:?}: {e}"))?;
    Ok(db_bridge::env(
        PathBuf::from(&home.java),
        jar,
        driver,
        db_bridge::nc_decrypt_jars(root),
        cfg_dir,
    ))
}

/// 取（没有就建）某个连接的引擎句柄。`key` 是连接 id，同时用作桥里的会话名；
/// `__probe` / `__test` 给列数据源、测试连接用。
///
/// `engine` 由连接配置决定（见 `DbConnConfig::engine`）。两条路的资源代价完全不同：
/// - JVM 桥：同一套 java + classpath 下的所有连接共用**一个** JVM（见 [`shared_bridge`]），
///   每条连接只是里面一条会话——这是内存从「每连接 50~70MB」降到「底价 + 每会话几 MB」的关键。
/// - 纯 Rust：一条连接一个驱动会话，不碰 NC 的 jar，所以也不需要 `bridge_env`。
pub(crate) fn bridge_for(
    app: &AppHandle,
    state: &AppState,
    cfg: &AppConfig,
    key: &str,
    engine: EngineKind,
    policy_id: &str,
) -> Result<Arc<EngineHandle>, String> {
    let policy = state.db_policies.lock().map_err(|_| "数据库只读状态异常")?.entry(policy_id.to_string()).or_insert_with(|| Arc::new(std::sync::RwLock::new(false))).clone();
    // Registration holds the same read lock as execution, so a toggle cannot miss a new handle.
    let _registration = policy.read().map_err(|_| "数据库只读状态异常")?;
    if engine == EngineKind::Rust {
        // 纯 Rust 引擎连 config_dir 都不用建：它不读 NC 的任何文件
        let old = {
            let mut map = state
                .db
                .lock()
                .map_err(|_| "数据库桥状态异常".to_string())?;
            if let Some(existing) = map.get(key) {
                if existing.kind() == EngineKind::Rust {
                    return Ok(existing.clone());
                }
            }
            map.remove(key)
        };
        if let Some(old) = old {
            old.shutdown();
        }
        let handle = Arc::new(EngineHandle::rust().with_policy(policy.clone()));
        state
            .db
            .lock()
            .map_err(|_| "数据库桥状态异常".to_string())?
            .insert(key.to_string(), handle.clone());
        return Ok(handle);
    }

    let env = bridge_env(app, state, cfg)?;
    let old = {
        let mut map = state
            .db
            .lock()
            .map_err(|_| "数据库桥状态异常".to_string())?;
        if let Some(existing) = map.get(key) {
            // java 路径与 classpath 都没变 = 还是同一套驱动，可以直接复用。
            // 引擎种类也要对上：同一个连接被改过引擎时，旧句柄不能拿来用。
            if existing.kind() == EngineKind::Java && existing.matches_env(&env) {
                return Ok(existing.clone());
            }
        }
        // 换了 NC home、补装了驱动、或换了引擎：旧的会话要断掉再重建（锁外做，别持锁做 IO）
        map.remove(key)
    };
    if let Some(old) = old {
        old.shutdown();
    }
    let bridge = shared_bridge(state, &env)?;
    let handle = Arc::new(EngineHandle::java(bridge, key).with_policy(policy.clone()));
    state
        .db
        .lock()
        .map_err(|_| "数据库桥状态异常".to_string())?
        .insert(key.to_string(), handle.clone());
    Ok(handle)
}

/// 取（没有就起）共享的桥进程。同一套 java + classpath 只会有一个 JVM。
fn shared_bridge(
    state: &AppState,
    env: &db_bridge::BridgeEnv,
) -> Result<Arc<db_bridge::Bridge>, String> {
    let sig = format!(
        "{}|{}",
        env.java.display(),
        env.jars
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(";")
    );
    let mut pool = state
        .db_procs
        .lock()
        .map_err(|_| "数据库进程池状态异常".to_string())?;
    if let Some(alive) = pool.get(&sig).and_then(|w| w.upgrade()) {
        return Ok(alive);
    }
    let bridge = Arc::new(db_bridge::Bridge::new(env.clone()));
    pool.insert(sig, Arc::downgrade(&bridge));
    Ok(bridge)
}

/// 已经存在的引擎句柄（不新建）：没连过的连接上做元数据操作要报「先连接」，而不是偷偷起进程。
pub(crate) fn existing_bridge(state: &AppState, key: &str) -> Result<Arc<EngineHandle>, String> {
    let map = state
        .db
        .lock()
        .map_err(|_| "数据库桥状态异常".to_string())?;
    map.get(key)
        .cloned()
        .ok_or_else(|| code_label("not-connected", "这个连接还没连上"))
}

/// 关掉并移除某个句柄（断开、删除连接时用）。
pub(crate) fn drop_bridge(state: &AppState, key: &str) {
    let b = state.db.lock().ok().and_then(|mut m| m.remove(key));
    if let Some(b) = b {
        b.shutdown();
    }
}

/// 一次性任务的临时会话序号：导出与按值反查各用各的前缀，但序号共用一个池，
/// 避免两次操作（甚至两个入口同时点）撞上同一个会话名。
static TEMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 开一条临时会话跑「读全就断」的一次性任务（导出、按值反查）。
///
/// 自动提交、只读语义由调用方保证（只发 SELECT）。`None` = 拿不到可直接连接的条件
/// （没连上 / 手动连接的口令没记住），调用方决定是报错还是降级复用现有句柄。
/// 用完必须 `disconnect` + [`drop_bridge`]，否则服务端会话会一直挂着。
pub(crate) async fn open_temp_session(
    app: &AppHandle,
    state: &AppState,
    cfg: &AppConfig,
    conn: &DbConnConfig,
    engine: EngineKind,
    kind: &str,
) -> Option<(String, Arc<EngineHandle>)> {
    // 读操作不需要事务：自动提交，跑完断开也不留未提交状态
    let (cmd, args) = connect_args(cfg, conn, None, true, engine).ok()?;
    let key = format!(
        "__{kind}:{}:{}",
        conn.id,
        TEMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    let bridge = bridge_for(app, state, cfg, &key, engine, &conn.id).ok()?;
    match call(bridge.clone(), cmd, args, T_CONNECT).await {
        Ok(_) => Some((key, bridge)),
        Err(_) => {
            drop_bridge(state, &key);
            None
        }
    }
}

/// 在阻塞线程里调一次引擎，错误转成 `code|message`。
pub(crate) async fn call(
    engine: Arc<EngineHandle>,
    cmd: &'static str,
    args: Vec<String>,
    timeout: Duration,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        engine.call(cmd, &refs, timeout)
    })
    .await
    .map_err(|e| format!("调用数据库桥失败：{e}"))?
    .map_err(|e| {
        if e.code == "timeout" || e.code == "spawn" {
            code_label("bridge", &e.message)
        } else {
            map_sql_error(&e.message)
        }
    })
}

pub(crate) fn code_label(code: &str, message: &str) -> String {
    format!("{code}|{message}")
}

/// 桥的 SQL 错误翻译成前端好用的码：认证失败要弹输口令框，网络不通单独提示。
pub(crate) fn map_sql_error(message: &str) -> String {
    let m = message.to_lowercase();
    if m.contains("ora-01017") || m.contains("invalid username/password") || m.contains("登录被拒")
    {
        return code_label("auth", message);
    }
    if m.contains("ora-12541")
        || m.contains("ora-12514")
        || m.contains("ora-12505")
        || m.contains("no listener")
        || m.contains("io 错误")
        || m.contains("io error")
    {
        return code_label("unreachable", message);
    }
    code_label("sql", message)
}

pub(crate) fn find_conn(cfg: &AppConfig, id: &str) -> Result<DbConnConfig, String> {
    cfg.db_conns
        .iter()
        .find(|c| c.id == id)
        .cloned()
        .ok_or_else(|| "这个连接已经不存在（可能刚被删除）".to_string())
}

/// 手动来源的口令：本次输入优先，否则解 DPAPI；都没有就要求输入。
pub(crate) fn resolve_password(conn: &DbConnConfig, typed: Option<&str>) -> Result<String, String> {
    if let Some(t) = typed.filter(|t| !t.is_empty()) {
        return Ok(t.to_string());
    }
    let Some(enc) = conn.password_dpapi.as_deref() else {
        return Err(code_label("need-password", "还没输入这个连接的口令"));
    };
    let raw = svn_cred::b64_decode(enc)
        .ok_or_else(|| code_label("need-password", "存着的口令已损坏，请重输"))?;
    let plain = svn_cred::dpapi_unprotect(&raw).map_err(|e| {
        code_label(
            "need-password",
            &format!("存着的口令解不开（换机器/换用户会这样）：{e}"),
        )
    })?;
    String::from_utf8(plain).map_err(|e| format!("口令解码失败：{e}"))
}

pub(crate) fn protect(password: &str) -> Result<String, String> {
    Ok(svn_cred::b64_encode(&svn_cred::dpapi_protect(
        password.as_bytes(),
    )?))
}

/// 连接参数：prop 来源 + JVM 桥走 `connectProp`（口令在 JVM 里现解），
/// 其余一律走 `connect`（Rust 引擎拿不到 NC 的 Java 类，口令必须先由
/// [`prop_password_ready`] 解好存进 DPAPI）。
pub(crate) fn connect_args(
    cfg: &AppConfig,
    conn: &DbConnConfig,
    password: Option<&str>,
    auto_commit: bool,
    engine: EngineKind,
) -> Result<(&'static str, Vec<String>), String> {
    let auto = auto_commit.to_string();
    if conn.source == "prop" && engine == EngineKind::Java {
        let home = crate::nc_home::resolve(cfg.nc_home.as_deref())?;
        let ds = conn
            .prop_ds
            .clone()
            .ok_or_else(|| "这个连接缺数据源名".to_string())?;
        return Ok(("connectProp", vec![home.root, ds, auto]));
    }
    let pass = resolve_password(conn, password)?;
    Ok((
        "connect",
        vec![conn.url.clone(), conn.user.clone(), pass, auto],
    ))
}

/// 让 `conn` 具备一个能用的口令，供非 JVM 引擎使用。
///
/// prop 来源的连接原本不存口令（每次由 JVM 现解）。纯 Rust 驱动没有 classpath 解不了，
/// 所以这里做一次「解一次、存起来」：JVM 桥按 prop.xml 解出明文口令 → DPAPI 加密写入配置，
/// 之后这条连接就等同普通手动连接。代价是 prop 的口令从此在本机落了一份 DPAPI 密文
/// （和手动连接同一套保护，换机器/换用户解不开）。
///
/// 只在**这个连接真的要用 Rust 引擎**时才调；JVM 桥的连接保持「口令不落盘」的老行为。
pub(crate) async fn prop_password_ready(
    app: &AppHandle,
    st: &Arc<AppState>,
    cfg: &AppConfig,
    conn: &mut DbConnConfig,
    typed: Option<&str>,
    probe: &str,
) -> Result<(), String> {
    // 本次手输的口令优先（用户可能在表单里覆盖了 prop.xml 里的）
    if let Some(p) = typed.filter(|p| !p.is_empty()) {
        conn.password_dpapi = Some(protect(p)?);
        return Ok(());
    }
    if resolve_password(conn, None).is_ok() {
        return Ok(());
    }
    let ds = conn
        .prop_ds
        .clone()
        .ok_or_else(|| "这个连接缺数据源名".to_string())?;
    let home = crate::nc_home::resolve(cfg.nc_home.as_deref())?;
    let b = bridge_for(app, st, cfg, probe, EngineKind::Java, probe)?;
    let v = call(b, "propCred", vec![home.root, ds], T_CONNECT).await?;
    let pwd = v.get("password").and_then(Value::as_str).unwrap_or("");
    if pwd.is_empty() {
        return Err(code_label(
            "need-password",
            "prop.xml 里这个数据源没写口令，请在连接里手动输入一次",
        ));
    }
    // url / user 也以 prop.xml 为准：连接可能是手改过的，口令却对不上
    if let Some(u) = v
        .get("url")
        .and_then(Value::as_str)
        .filter(|u| !u.is_empty())
    {
        conn.url = u.to_string();
    }
    if let Some(u) = v
        .get("user")
        .and_then(Value::as_str)
        .filter(|u| !u.is_empty())
    {
        conn.user = u.to_string();
    }
    conn.password_dpapi = Some(protect(pwd)?);

    // 落盘：下次连这个连接不用再叫 JVM。写失败不算致命（只是下次再解一遍）
    let id = conn.id.clone();
    let url = conn.url.clone();
    let user = conn.user.clone();
    let enc = conn.password_dpapi.clone();
    let _ = st
        .update_config(move |c| {
            if let Some(x) = c.db_conns.iter_mut().find(|x| x.id == id) {
                x.url = url;
                x.user = user;
                x.password_dpapi = enc;
            }
            Ok(())
        })
        .await;
    Ok(())
}

// ───────────────────────── 连接 / 执行 / 事务 ─────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbConnectResult {
    pub id: String,
    pub url: String,
    pub user: String,
    pub product: String,
    pub version: String,
    pub auto_commit: bool,
}

/// 连库。手动来源 `password` 为空时用存过的；`remember` 为真时把这次输入的口令存起来。
#[tauri::command]
pub async fn db_connect(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
    password: Option<String>,
    remember: Option<bool>,
) -> Result<DbConnectResult, String> {
    let st = state.inner().clone();
    let cfg = st.config.read().await.clone();
    let mut conn = find_conn(&cfg, &id)?;
    let engine = EngineKind::parse(&conn.engine);
    // prop 来源要用 Rust 驱动：先把口令解出来落盘（JVM 桥那边是每次现解，不必存）
    if engine != EngineKind::Java && conn.source == "prop" {
        prop_password_ready(&app, &st, &cfg, &mut conn, password.as_deref(), PROBE).await?;
    }
    let (cmd, args) = connect_args(&cfg, &conn, password.as_deref(), conn.auto_commit, engine)?;
    let bridge = bridge_for(&app, &st, &cfg, &id, engine, &id)?;
    let out = call(bridge, cmd, args, T_CONNECT).await?;

    let typed = password.filter(|p| !p.is_empty());
    let keep = remember.unwrap_or(true);
    let enc = match (&typed, keep) {
        (Some(p), true) => Some(protect(p)?),
        _ => None,
    };
    let _ = st
        .update_config(|c| {
            c.db_active = Some(id.clone());
            if let Some(e) = enc {
                if let Some(x) = c.db_conns.iter_mut().find(|x| x.id == id) {
                    x.password_dpapi = Some(e);
                }
            }
            Ok(())
        })
        .await;

    let s = |k: &str| out.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    Ok(DbConnectResult {
        id,
        url: s("url"),
        user: s("user"),
        product: s("product"),
        version: s("version"),
        auto_commit: out
            .get("autoCommit")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

/// 会话槽：给一条已经连上的连接再开一条独立会话（A0）。
///
/// 为什么需要：一个句柄底下只有一条数据库会话，长查询在执行时占着它，同一连接上的
/// 其它标签只能排队。开一条额外会话后，标签 A 跑 30 秒的查询，标签 B 照用。
///
/// 分工（与方案文档 13.4 一致）：
/// - **primary**（连接 id 本身）继续服务元数据、表页、事务条；
/// - 槽只给 SQL 标签用，**各自独立事务**；
/// - 每连接最多 [`MAX_SLOTS`] 个，空闲 [`SLOT_IDLE`] 回收。
#[tauri::command]
pub async fn db_slot_acquire(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
) -> Result<SlotOut, String> {
    let st = state.inner().clone();
    let cfg = st.config.read().await.clone();
    let conn = find_conn(&cfg, &id)?;
    // 槽是「再加一条会话」，不是「从零连库」：primary 都没连上就没什么可加的
    existing_bridge(&st, &id)
        .map_err(|_| code_label("not-connected", "先连上这个库，再开独立会话"))?;
    sweep_idle_slots(&st, &id).await;
    let used = live_slots(&st, &id);
    if used.len() >= MAX_SLOTS {
        return Err(code_label(
            "slots-full",
            &format!(
                "这条连接最多同时开 {MAX_SLOTS} 个独立会话（现在 {}/{MAX_SLOTS}）。\
                 关掉几个跑完的 SQL 标签再试",
                used.len()
            ),
        ));
    }
    let n = (1..=MAX_SLOTS)
        .find(|i| !used.contains(&i.to_string()))
        .ok_or_else(|| code_label("slots-full", "没有空闲的会话槽"))?;
    let slot = n.to_string();
    let key = slot_key(&id, Some(&slot))?;
    let engine = EngineKind::parse(&conn.engine);
    let (cmd, args) = connect_args(&cfg, &conn, None, conn.auto_commit, engine)?;
    let handle = bridge_for(&app, &st, &cfg, &key, engine, &id)?;
    match call(handle, cmd, args, T_CONNECT).await {
        Ok(_) => {
            touch_slot(&key);
            Ok(SlotOut { slot })
        }
        Err(e) => {
            // 连不上就把半成品收掉，否则下次申请会以为这条槽还在用
            drop_bridge(&st, &key);
            forget_slot(&key);
            Err(e)
        }
    }
}

/// 释放一条槽（关 SQL 标签时调）。断开连接时后端会连 primary 一起收掉。
#[tauri::command]
pub async fn db_slot_release(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
    slot: String,
) -> Result<(), String> {
    let key = slot_key(&id, Some(&slot))?;
    drop_bridge(&state, &key);
    // 槽上的 JVM 桥兜底会话也不能留（否则服务端会多出一条没人管的会话）
    drop_bridge(&state, &java_key(&key));
    forget_slot(&key);
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotOut {
    pub slot: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineCaps {
    /// `java` / `rust`。
    pub engine: String,
    /// 给人看的名字。
    pub label: String,
    /// 已经连上了（此时能力来自真实句柄，而不是按配置猜的）。
    pub connected: bool,
    pub cancel: bool,
    pub refcursor: bool,
    pub prop_decrypt: bool,
    pub multi_session: bool,
    /// 能列会话与锁（权限不够由返回的 `granted` 表达，不是能力位）。
    pub sessions: bool,
    /// 能回实际执行统计（执行前后读 `v$mystat` 取差值；读不到时响应里 `stats` 为 null）。
    pub stats: bool,
}

/// 这个连接用哪个引擎、那个引擎能做什么。界面上「停止」按钮可用性、引擎选择器的灰项
/// 都按它来——不要在前端硬编码「rust 不能停」，那会和后端的实现改动脱节。
#[tauri::command]
pub async fn db_caps(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
) -> Result<EngineCaps, String> {
    let cfg = state.config.read().await.clone();
    let conn = find_conn(&cfg, &id)?;
    // 连上以后以真实句柄为准：配置文件里写的是「想用哪个」，句柄才是「实际在跑哪个」
    if let Ok(h) = existing_bridge(&state, &id) {
        let kind = h.kind();
        let c = h.caps();
        return Ok(EngineCaps {
            engine: kind.as_str().to_string(),
            label: kind.label().to_string(),
            connected: true,
            cancel: c.cancel,
            refcursor: c.refcursor,
            prop_decrypt: c.prop_decrypt,
            multi_session: c.multi_session,
            sessions: c.sessions,
            stats: c.stats,
        });
    }
    let kind = EngineKind::parse(&conn.engine);
    let c = crate::db_engine::Caps::of(kind);
    Ok(EngineCaps {
        engine: kind.as_str().to_string(),
        label: kind.label().to_string(),
        connected: false,
        cancel: c.cancel,
        refcursor: c.refcursor,
        prop_decrypt: c.prop_decrypt,
        multi_session: c.multi_session,
        sessions: c.sessions,
        stats: c.stats,
    })
}

/// 取消这个连接上正在执行的语句。
///
/// 与其它命令的关键差别：它**不等调用锁**——正在跑的那条查询占着这条会话，
/// 取消要是排在它后面就毫无意义。两个引擎各走各的路：
/// - JVM 桥：桥侧在独立线程上收这条命令并调 `Statement.cancel()`，
///   被取消的查询会带着 ORA-01013 从原来那个请求上返回；
/// - 纯 Rust：`RustEngine::cancel()` 只置驱动里的 `BreakHandle` 标志（不拿会话锁），
///   持锁线程在下一个 100ms 切片上读到标志、发 INTERRUPT 标记后 `reset()`。
///
/// 两条路都表现为「原来那个请求返回一次错误」，前端照常显示为一次失败的执行。
#[tauri::command]
pub async fn db_cancel(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
    slot: Option<String>,
) -> Result<(), String> {
    let engine = slot_bridge(&state, &id, slot.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || engine.cancel())
        .await
        .map_err(|e| format!("发送取消失败：{e}"))?
        .map_err(|e| code_label("bridge", &e.message))
}

/// 断开（未提交的改动由桥回滚——界面已经先问过用户）。
///
/// **连同上开的独立会话一起断**：槽是这条连接的一部分，留着它们等于在服务端占着
/// 几条没人管的会话（用户以为已经断开了）。P0 的 JVM 桥兜底会话（`#java`）同理。
#[tauri::command]
pub async fn db_disconnect(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
) -> Result<(), String> {
    let slots = live_slots(&state, &id);
    for n in slots {
        let key = slot_key(&id, Some(&n))?;
        drop_bridge(&state, &key);
        drop_bridge(&state, &java_key(&key));
        forget_slot(&key);
    }
    drop_bridge(&state, &java_key(&id));
    let Ok(b) = existing_bridge(&state, &id) else {
        return Ok(());
    };
    let _ = call(b, "disconnect", vec![], Duration::from_secs(10)).await;
    drop_bridge(&state, &id);
    Ok(())
}

/// 执行一条语句（查询 / DML / DDL / PL/SQL 块都行）。返回桥的原样 JSON：
/// `{kind:"rows",columns,rows,rowCount,hasMore,ms,stats,output,tx}` 或 `{kind:"update",…}`。
///
/// `slot` 为空 = 走 primary（老行为）；前端给 SQL 标签申请槽之后，同一个标签的
/// 执行 / 加载更多 / 取消 / 提交都带同一个槽名，各自的游标与事务互不干扰。
///
/// **P0 能力路由**：纯 Rust 引擎遇到 REF CURSOR 形态（`open :1 for …`，或打开游标却不
/// `return_result`）时，不在这里报错，而是把这条语句改到同一连接的 JVM 桥临时会话上执行。
/// 判定见 `db_engine::refcursor_need`，落点在 [`exec_via_java`]。
#[tauri::command]
pub async fn db_exec(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
    sql: String,
    max_rows: Option<u32>,
    timeout_sec: Option<u32>,
    slot: Option<String>,
) -> Result<Value, String> {
    if sql.trim().is_empty() {
        return Err(code_label("sql", "SQL 是空的"));
    }
    let b = slot_bridge(&state, &id, slot.as_deref())?;
    let rows = max_rows.unwrap_or(500).clamp(1, 10_000);
    let timeout = timeout_sec.unwrap_or(30).clamp(1, 3600);
    let limit = Duration::from_secs(u64::from(timeout) + 30);
    if b.kind() == EngineKind::Rust {
        if let Some(need) = crate::db_engine::refcursor_need(&sql) {
            return exec_via_java(JavaFallback {
                app: &app,
                st: &state,
                id: &id,
                slot: slot.as_deref(),
                sql: &sql,
                rows,
                timeout,
                need,
            })
            .await;
        }
    }
    match call(
        b.clone(),
        "exec",
        vec![sql.clone(), rows.to_string(), timeout.to_string()],
        limit,
    )
    .await
    {
        Ok(v) => Ok(v),
        // 判定没覆盖到的形态（比如游标从包里返回、写法认不出）：按报错兜一层。
        // 兜底也失败时把两个原因都写出来——用户至少知道我们试过什么。
        Err(e) if b.kind() == EngineKind::Rust && e.contains("PLS-00707") => {
            exec_via_java(JavaFallback {
                app: &app,
                st: &state,
                id: &id,
                slot: slot.as_deref(),
                sql: &sql,
                rows,
                timeout,
                need: crate::db_engine::RefcursorNeed::OutBind,
            })
            .await
            .map_err(|又| format!("{e}\n（自动改走 JVM 桥也没成：{又}）"))
        }
        Err(e) => Err(e),
    }
}

/// 一条要改走 JVM 桥执行的语句（P0）。
///
/// 打成一个结构体而不是八个参数：调用点两处（判定命中、按报错兜底）都要把同样的东西
/// 原样传下去，参数列表一长，两边就容易少传一个（`slot` 少传会让兜底语句跑到另一条会话）。
struct JavaFallback<'a> {
    app: &'a AppHandle,
    st: &'a Arc<AppState>,
    id: &'a str,
    slot: Option<&'a str>,
    sql: &'a str,
    rows: u32,
    timeout: u32,
    need: crate::db_engine::RefcursorNeed,
}

/// 在 JVM 桥的临时会话上执行一条 Rust 引擎跑不了的语句。
///
/// 三条纪律，改这里之前先读完：
/// 1. **不占会话槽**：键是 `{引擎键}#java`，`live_slots` 只认数字后缀，所以它既不挤用户
///    的 3 个槽，也不会被空闲回收当成槽关掉；断开连接 / 释放槽时随宿主一起收；
/// 2. **不做假的无感**：结果里带 `fallback`，前端会把「这条走的是 JVM 桥」写进输出区。
///    悄悄换引擎执行，用户排查「为什么这条 SQL 的事务没算进去」时会被坑死；
/// 3. **绝不静默提交**：这个临时会话不归界面的事务条管。执行完先看它有没有未提交写入，
///    有就回滚并说明白——让用户以为提交了、实际挂在一条看不见的会话里，比直接报错更糟。
async fn exec_via_java(f: JavaFallback<'_>) -> Result<Value, String> {
    let JavaFallback {
        app,
        st,
        id,
        slot,
        sql,
        rows,
        timeout,
        need,
    } = f;
    let cfg = st.config.read().await.clone();
    let conn = find_conn(&cfg, id)?;
    let key = java_key(&slot_key(id, slot)?);
    let handle = bridge_for(app, st, &cfg, &key, EngineKind::Java, id)?;
    // 连过一次就复用：桥的 `connect` 会先把旧连接关掉，等于每条语句重连一次库。
    // 用一个 ping 探活，顺带能拿到「这条会话有没有未提交写入」。
    if call(handle.clone(), "ping", Vec::new(), T_META)
        .await
        .is_err()
    {
        let (cmd, args) = connect_args(&cfg, &conn, None, false, EngineKind::Java)?;
        call(handle.clone(), cmd, args, T_CONNECT).await?;
    }
    let limit = Duration::from_secs(u64::from(timeout) + 30);
    let mut v = call(
        handle.clone(),
        "exec",
        vec![sql.to_string(), rows.to_string(), timeout.to_string()],
        limit,
    )
    .await?;
    let pending = call(handle.clone(), "ping", Vec::new(), T_META)
        .await
        .ok()
        .and_then(|p| {
            p.get("tx")
                .and_then(|t| t.get("statements"))
                .and_then(Value::as_u64)
        })
        .unwrap_or(0);
    if pending > 0 {
        let _ = call(handle, "rollback", Vec::new(), T_META).await;
        return Err(code_label(
            "fallback-tx",
            &format!(
                "这条语句 Rust 引擎跑不了（{}），已改在 JVM 桥的临时会话里执行；\
                 但它在那个会话里留下了 {pending} 条未提交的写入，而那个会话不受这里的事务条管理，\
                 已经回滚以免你以为提交了。要执行会写库的这类语句，请把这条连接的引擎改成 JVM 桥。",
                need.reason()
            ),
        ));
    }
    if let Value::Object(map) = &mut v {
        map.insert(
            "fallback".into(),
            serde_json::json!({ "engine": "java", "reason": need.reason() }),
        );
    }
    Ok(v)
}

/// 「加载更多」：从上一次查询的游标接着取（`slot` 必须与执行时相同）。
#[tauri::command]
pub async fn db_more(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
    max_rows: Option<u32>,
    slot: Option<String>,
) -> Result<Value, String> {
    let b = slot_bridge(&state, &id, slot.as_deref())?;
    let rows = max_rows.unwrap_or(500).clamp(1, 10_000);
    call(b, "more", vec![rows.to_string()], T_META).await
}

/// 事务操作：`commit` / `rollback` / `autocommit-on` / `autocommit-off` / `status`。
///
/// 槽各自独立事务：带 `slot` 时只影响那条会话。`status` 走 `ping`，返回里带 `tx`。
#[tauri::command]
pub async fn db_tx(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
    action: String,
    slot: Option<String>,
) -> Result<Value, String> {
    let b = slot_bridge(&state, &id, slot.as_deref())?;
    let (cmd, args): (&'static str, Vec<String>) = match action.as_str() {
        "commit" => ("commit", vec![]),
        "rollback" => ("rollback", vec![]),
        "autocommit-on" => ("autocommit", vec!["true".into()]),
        "autocommit-off" => ("autocommit", vec!["false".into()]),
        "status" => ("ping", vec![]),
        other => return Err(format!("未知事务操作：{other}")),
    };
    call(b, cmd, args, Duration::from_secs(60)).await
}

/// 元数据：`tables` / `ncNames` / `columnsZh` / `columns` / `indexes` / `ddl` / `explain` /
/// `sessions` / `objects` / `source`。`arg` 是表名或对象名（columnsZh 时是逗号分隔的
/// 一批表名；explain 时是 SQL；sessions、objects 不需要参数）；`arg2` 目前只有 `ddl` 用，
/// 表示对象类型（包/过程/序列…，空 = 按表处理）。
#[tauri::command]
pub async fn db_meta(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
    kind: String,
    arg: Option<String>,
    arg2: Option<String>,
) -> Result<Value, String> {
    let b = existing_bridge(&state, &id)?;
    // 列中文名要两个引擎各走各的取数方式（Rust 用绑定变量、JVM 桥用 `query`），
    // 所以不进下面的「kind → 桥命令」映射，直接走 EngineHandle；拼装统一在 db_zh。
    if kind == "columnsZh" {
        let names = arg.unwrap_or_default();
        return tauri::async_runtime::spawn_blocking(move || b.columns_zh(&names, T_META))
            .await
            .map_err(|e| format!("调用数据库桥失败：{e}"))?
            .map_err(|e| {
                if e.code == "timeout" || e.code == "spawn" {
                    code_label("bridge", &e.message)
                } else {
                    map_sql_error(&e.message)
                }
            });
    }
    let cmd: &'static str = match kind.as_str() {
        "tables" => "tables",
        "ncNames" => "ncNames",
        "columns" => "columns",
        "indexes" => "indexes",
        "ddl" => "ddl",
        "explain" => "explain",
        "sessions" => "sessions",
        "objects" => "objects",
        "source" => "source",
        other => return Err(format!("未知元数据类型：{other}")),
    };
    if arg2.is_some() && arg.is_none() {
        return Err(format!("{cmd} 的第二个参数不能脱离第一个单独给"));
    }
    let args: Vec<String> = arg.into_iter().chain(arg2).collect();
    // 这几个不需要参数。加新 kind 时别忘了把「无参」的也列进来，否则会被下面这段拦掉
    if !matches!(cmd, "tables" | "ncNames" | "sessions" | "objects") && args.is_empty() {
        return Err(format!("{cmd} 需要参数"));
    }
    call(b, cmd, args, T_META).await
}

/// 退出前的「这条连接上所有会话」事务操作：primary + 每个独立会话槽一起提交/回滚。
///
/// 为什么不复用 `db_tx` 在前端循环：槽是后端的内部记账，前端只知道 primary 的 id；
/// 让它去枚举槽等于把内部结构再抄一份到界面。只允许 commit / rollback——
/// 退出场景里切自动提交没有意义。
///
/// 一条失败不中断其余（别的会话的写入也别丢），最后把第一个错误报上去。
#[tauri::command]
pub async fn db_tx_all(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
    action: String,
) -> Result<(), String> {
    let cmd: &'static str = match action.as_str() {
        "commit" => "commit",
        "rollback" => "rollback",
        other => return Err(format!("未知事务操作：{other}")),
    };
    let mut keys = vec![id.clone()];
    keys.extend(
        live_slots(&state, &id)
            .into_iter()
            .map(|n| format!("{id}#{n}")),
    );
    let mut first_err: Option<String> = None;
    for key in keys {
        let Ok(h) = existing_bridge(&state, &key) else {
            continue;
        };
        if let Err(e) = call(h, cmd, vec![], Duration::from_secs(30)).await {
            first_err.get_or_insert(e);
        }
    }
    match first_err {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

// ───────────────────────── 表结构缓存与出包核对 ─────────────────────────

/// 表结构缓存、悬停、出包核对用哪个库：最近一次在数据库页用过的连接，
/// 其次第一条连接，再其次 prop.xml 的基础数据源（老用户还没打开过新数据库页时）。
pub(crate) fn current_db(cfg: &AppConfig) -> Result<(Option<String>, String, String), String> {
    let pick = cfg
        .db_active
        .as_deref()
        .and_then(|id| cfg.db_conns.iter().find(|c| c.id == id))
        .or_else(|| cfg.db_conns.first());
    if let Some(c) = pick {
        return Ok((Some(c.id.clone()), c.url.clone(), c.user.clone()));
    }
    let prop = read_prop(cfg);
    let url = cfg
        .db_url
        .clone()
        .or_else(|| prop.as_ref().map(|p| p.url.clone()))
        .ok_or_else(|| "还没有数据库连接：到数据库页添加一个".to_string())?;
    let user = cfg
        .db_user
        .clone()
        .or_else(|| prop.as_ref().map(|p| p.user.clone()))
        .unwrap_or_default();
    Ok((None, url, user))
}

/// 缓存键里的用户名统一小写：prop.xml 写 `aier633`，库里回来的是 `AIER633`。
fn cache_file(dir: &Path, url: &str, user: &str) -> PathBuf {
    db_schema::cache_path(dir, url, &user.to_lowercase())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaStatus {
    pub has: bool,
    pub url: String,
    pub user: String,
    /// 拉取时刻（Unix 秒），没有缓存时是 0。
    pub fetched_at: u64,
    pub age_secs: u64,
    pub tables: usize,
    pub columns: usize,
    /// 对应的连接 id（没有连接配置时为空）。
    pub conn_id: Option<String>,
}

fn status_of(
    cache: Option<&db_schema::SchemaCache>,
    conn_id: Option<String>,
    url: &str,
    user: &str,
) -> SchemaStatus {
    let now = db_schema::now_secs();
    let (has, fetched_at, tables, columns) = match cache {
        Some(c) => (true, c.fetched_at, c.tables.len(), c.column_count()),
        None => (false, 0, 0, 0),
    };
    SchemaStatus {
        has,
        url: url.to_string(),
        user: user.to_string(),
        fetched_at,
        age_secs: if has {
            now.saturating_sub(fetched_at)
        } else {
            0
        },
        tables,
        columns,
        conn_id,
    }
}

fn load_cache(dir: &Path, url: &str, user: &str) -> Option<db_schema::SchemaCache> {
    let lower = user.to_lowercase();
    db_schema::load(&cache_file(dir, url, user), url, &lower)
        .or_else(|| db_schema::load(&db_schema::cache_path(dir, url, user), url, user))
}

/// 表结构缓存的状态（不连库，只读本地文件）。
#[tauri::command]
pub async fn db_schema_status(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<SchemaStatus, String> {
    let cfg = state.config.read().await.clone();
    let (id, url, user) = current_db(&cfg)?;
    let cache = load_cache(&state.config_dir, &url, &user);
    Ok(status_of(cache.as_ref(), id, &url, &user))
}

/// 从库里把表结构整个拉一遍落盘。要求当前连接已经连上（不偷偷连库）。
///
/// 一次拉完而不是分页：Java 侧每页都要把 `getColumns` 的结果从头 skip 一遍（O(n²)）。
#[tauri::command]
pub async fn db_schema_sync(
    state: tauri::State<'_, Arc<AppState>>,
    id: Option<String>,
) -> Result<SchemaStatus, String> {
    let st = state.inner().clone();
    let cfg = st.config.read().await.clone();
    let (active, url, user) = match id.as_deref() {
        Some(i) => {
            let c = find_conn(&cfg, i)?;
            (Some(c.id), c.url, c.user)
        }
        None => current_db(&cfg)?,
    };
    let key = active
        .clone()
        .ok_or_else(|| code_label("not-connected", "先在数据库页添加并连上一个连接"))?;
    let bridge = existing_bridge(&st, &key)
        .map_err(|_| code_label("not-connected", "先在数据库页连上这个库，再拉表结构"))?;
    let out = call(
        bridge,
        "schema",
        vec!["0".into(), "2000000".into()],
        Duration::from_secs(300),
    )
    .await?;

    let rows: Vec<(String, String, String)> = out
        .get("rows")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|r| {
                    let t = r.get("table")?.as_str()?.to_string();
                    let c = r.get("column")?.as_str()?.to_string();
                    let ty = db_schema::fmt_type(
                        r.get("type").and_then(Value::as_str).unwrap_or(""),
                        r.get("size").and_then(Value::as_i64).unwrap_or(0) as i32,
                    );
                    Some((t, c, ty))
                })
                .collect()
        })
        .unwrap_or_default();
    if rows.is_empty() {
        return Err(code_label(
            "sql",
            "库里没读到任何列定义——账号可能没有数据字典权限，或者连错了库",
        ));
    }
    let lower = user.to_lowercase();
    let cache = db_schema::SchemaCache::build(&url, &lower, db_schema::now_secs(), &rows);
    db_schema::save(&cache_file(&st.config_dir, &url, &user), &cache)?;
    Ok(status_of(Some(&cache), active, &url, &user))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbColumn {
    pub name: String,
    #[serde(rename = "type")]
    pub type_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbTableColumns {
    pub table: String,
    pub columns: Vec<DbColumn>,
    /// 来自本地缓存（界面显示「缓存」而不是「现查」）。
    pub from_cache: bool,
}

/// 单表字段（Java 悬停卡片用）。有缓存走缓存；没缓存且当前连接已连上就现查一次。
#[tauri::command]
pub async fn db_columns(
    state: tauri::State<'_, Arc<AppState>>,
    table: String,
) -> Result<DbTableColumns, String> {
    let cfg = state.config.read().await.clone();
    let (id, url, user) = current_db(&cfg)?;
    if let Some(c) = load_cache(&state.config_dir, &url, &user) {
        if let Some(t) = c.tables.get(&table.to_lowercase()) {
            return Ok(DbTableColumns {
                table,
                columns: t
                    .columns
                    .iter()
                    .map(|(n, ty)| DbColumn {
                        name: n.clone(),
                        type_name: ty.clone(),
                    })
                    .collect(),
                from_cache: true,
            });
        }
    }
    let key = id.ok_or_else(|| code_label("not-connected", "还没有数据库连接"))?;
    let b = existing_bridge(&state, &key)?;
    let out = call(b, "columns", vec![table.clone()], Duration::from_secs(60)).await?;
    let columns = out
        .get("columns")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .map(|c| DbColumn {
                    name: c
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    type_name: c
                        .get("full")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(DbTableColumns {
        table,
        columns,
        from_cache: false,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedTables {
    pub tables: Vec<String>,
    pub fetched_at: u64,
    pub url: String,
    pub user: String,
}

/// 缓存里的全部表名（不连库）。没缓存时返回空列表（不是错误）。
#[tauri::command]
pub async fn db_cached_tables(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<CachedTables, String> {
    let cfg = state.config.read().await.clone();
    let (_, url, user) = current_db(&cfg)?;
    let cache = load_cache(&state.config_dir, &url, &user);
    Ok(match cache {
        Some(c) => CachedTables {
            tables: c.tables.keys().cloned().collect(),
            fetched_at: c.fetched_at,
            url,
            user,
        },
        None => CachedTables {
            tables: Vec::new(),
            fetched_at: 0,
            url,
            user,
        },
    })
}

/// 指定连接的表结构缓存（SQL 补全用：表名 → 字段名与类型）。没缓存返回 null。
#[tauri::command]
pub async fn db_schema_cache(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
) -> Result<Option<Value>, String> {
    let cfg = state.config.read().await.clone();
    let c = find_conn(&cfg, &id)?;
    let Some(cache) = load_cache(&state.config_dir, &c.url, &c.user) else {
        return Ok(None);
    };
    let mut tables = serde_json::Map::new();
    for (name, t) in &cache.tables {
        let cols: Vec<Value> = t
            .columns
            .iter()
            .map(|(n, ty)| serde_json::json!([n, ty]))
            .collect();
        tables.insert(name.clone(), Value::Array(cols));
    }
    Ok(Some(
        serde_json::json!({ "fetchedAt": cache.fetched_at, "tables": tables }),
    ))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckIssue {
    /// `table`（表不存在）或 `column`（字段不存在）。
    pub kind: String,
    pub table: String,
    pub column: Option<String>,
    pub rel: String,
    pub abs: String,
    pub line: usize,
    pub suggestions: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceCheck {
    pub files: usize,
    pub skipped: usize,
    pub tables: usize,
    pub columns: usize,
    pub missing_tables: usize,
    pub missing_columns: usize,
    pub issues: Vec<CheckIssue>,
    pub schema_tables: usize,
    pub schema_age_secs: u64,
}

/// 出包前核对：源码里引用的表和字段，在库里是不是真的存在。
///
/// 只报「确定对不上」的：表名不在库里就算不存在；字段只有在别名能解析到表、
/// 且该表（们）里都没有这个列时才报。宁可漏报不误报。
#[tauri::command]
pub async fn db_check_sources(
    state: tauri::State<'_, Arc<AppState>>,
    files: Vec<String>,
) -> Result<SourceCheck, String> {
    let st = state.inner().clone();
    let cfg = st.config.read().await.clone();
    let (_, url, user) = current_db(&cfg)?;
    let cache = load_cache(&st.config_dir, &url, &user)
        .ok_or_else(|| code_label("need-schema", "还没有表结构缓存，先连库拉一次"))?;
    let root = cfg
        .workspace_root
        .clone()
        .ok_or_else(|| "还没打开工作区".to_string())?;

    let index = cache.index();
    let schema_tables = cache.tables.len();
    let schema_age_secs = db_schema::now_secs().saturating_sub(cache.fetched_at);
    let roots = vec![root.clone()];

    tauri::async_runtime::spawn_blocking(move || {
        let mut issues: Vec<CheckIssue> = Vec::new();
        let mut seen_t: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        let mut n_files = 0usize;
        let mut n_skip = 0usize;
        let mut n_cols = 0usize;

        for f in &files {
            let Ok(abs) = crate::security::path::resolve_safe_path(f, &roots, &[], true) else {
                n_skip += 1;
                continue;
            };
            let Ok(fc) = crate::workspace::read_text_file(&abs) else {
                n_skip += 1;
                continue;
            };
            n_files += 1;
            let abs_disp = crate::security::path::display_path(&abs);
            let rel = rel_of(&abs_disp, &root);
            let refs = sql_refs::parse(&fc.text);
            for t in &refs.tables {
                seen_t.insert(t.name.to_lowercase());
            }
            n_cols += refs.columns.len();
            for it in sql_refs::check_file(&rel, &refs, &index) {
                issues.push(CheckIssue {
                    kind: match it.kind {
                        sql_refs::IssueKind::MissingTable => "table".to_string(),
                        sql_refs::IssueKind::MissingColumn => "column".to_string(),
                    },
                    table: it.table,
                    column: it.column,
                    rel: it.file,
                    abs: abs_disp.clone(),
                    line: it.line,
                    suggestions: it.suggestions,
                });
            }
        }

        let missing_tables = issues.iter().filter(|i| i.kind == "table").count();
        let missing_columns = issues.iter().filter(|i| i.kind == "column").count();
        issues.sort_by(|a, b| a.rel.cmp(&b.rel).then_with(|| a.line.cmp(&b.line)));

        SourceCheck {
            files: n_files,
            skipped: n_skip,
            tables: seen_t.len(),
            columns: n_cols,
            missing_tables,
            missing_columns,
            issues,
            schema_tables,
            schema_age_secs,
        }
    })
    .await
    .map_err(|e| format!("核对失败：{e}"))
}

/// 相对工作区根的展示路径；不在根下就原样给绝对路径。
fn rel_of(abs: &str, root: &str) -> String {
    let a = abs.replace('\\', "/");
    let r = root.replace('\\', "/");
    let r = r.trim_end_matches('/');
    a.strip_prefix(r)
        .map(|s| s.trim_start_matches('/').to_string())
        .unwrap_or(a)
}

#[cfg(test)]
mod tests {
    use super::*;

    use serde_json::json;

    const SAMPLE: &str = r#"<?xml version="1.0" encoding='gb2312'?>
<root ClassType="nc.uap.plugin.studio.ui.preference.prop.PropInfo">
  <isEncode>true</isEncode>
  <dataSource>
    <dataSourceName>design</dataSourceName>
    <databaseUrl>jdbc:oracle:thin:@10.200.22.144:1521/aier260824</databaseUrl>
    <user>aier633</user>
    <password>mlboiblaogcdobfe</password>
    <databaseType>ORACLE11G</databaseType>
    <isBase>false</isBase>
  </dataSource>
  <dataSource>
    <dataSourceName>main</dataSourceName>
    <databaseUrl>jdbc:oracle:thin:@10.200.22.145:1521/aier</databaseUrl>
    <user>aier</user>
    <databaseType>ORACLE11G</databaseType>
    <isBase>true</isBase>
  </dataSource>
</root>"#;

    #[test]
    fn 取_isbase_那个数据源() {
        let p = parse_prop(SAMPLE.as_bytes(), "t").expect("应能解析");
        assert_eq!(p.url, "jdbc:oracle:thin:@10.200.22.145:1521/aier");
        assert_eq!(p.user, "aier");
        assert!(p.password_encoded);
    }

    #[test]
    fn 没有_isbase_时退回第一个() {
        let xml = SAMPLE.replace("<isBase>true</isBase>", "<isBase>false</isBase>");
        let p = parse_prop(xml.as_bytes(), "t").unwrap();
        assert_eq!(p.user, "aier633");
    }

    #[test]
    fn 没有数据源要报错() {
        let e = parse_prop(b"<root></root>", "t").unwrap_err();
        assert!(e.contains("dataSource"), "{e}");
    }

    #[test]
    fn oracle_错误分类() {
        assert!(map_sql_error("ORA 1017：ORA-01017: 用户名/口令无效").starts_with("auth|"));
        assert_eq!(
            map_sql_error("ORA 942：表或视图不存在"),
            "sql|ORA 942：表或视图不存在"
        );
        assert!(map_sql_error("ORA-12541: TNS:no listener").starts_with("unreachable|"));
        assert!(map_sql_error("ORA 17002：IO 错误: Connection refused").starts_with("unreachable|"));
    }

    fn conn(id: &str, url: &str) -> DbConnConfig {
        DbConnConfig {
            id: id.into(),
            name: id.into(),
            env: "test".into(),
            source: "manual".into(),
            url: url.into(),
            user: "U".into(),
            prop_ds: None,
            password_dpapi: None,
            auto_commit: false,
            engine: String::new(),
            note: String::new(),
        }
    }

    #[test]
    fn 当前库优先取最近用过的连接() {
        let mut cfg = AppConfig {
            db_conns: vec![conn("a", "ua"), conn("b", "ub")],
            ..Default::default()
        };
        assert_eq!(current_db(&cfg).unwrap().1, "ua", "没用过时取第一条");
        cfg.db_active = Some("b".into());
        assert_eq!(current_db(&cfg).unwrap().0.as_deref(), Some("b"));
        cfg.db_active = Some("已删除".into());
        assert_eq!(
            current_db(&cfg).unwrap().1,
            "ua",
            "最近用过的被删了退回第一条"
        );
    }

    #[test]
    fn 手动连接没口令要求输入() {
        let e = resolve_password(&conn("a", "u"), None).unwrap_err();
        assert!(e.starts_with("need-password|"), "{e}");
        assert_eq!(resolve_password(&conn("a", "u"), Some("p")).unwrap(), "p");
    }

    #[test]
    fn 空闲槽有未提交写入时不能回收() {
        let ping = |v: Value| Ok::<Value, String>(v);
        // 超时 / 探测失败：一律留下（可能只是长查询还在占着会话）
        assert!(!idle_slot_reclaimable(&Err("bridge|超时".into())));
        // 连接已断：残留状态可以收
        assert!(idle_slot_reclaimable(&ping(
            json!({ "alive": false, "tx": { "autoCommit": false, "statements": 3 } })
        )));
        // 手动提交且改过东西：留下
        assert!(!idle_slot_reclaimable(&ping(
            json!({ "alive": true, "tx": { "autoCommit": false, "statements": 3 } })
        )));
        // 手动提交但没改过东西：可以收
        assert!(idle_slot_reclaimable(&ping(
            json!({ "alive": true, "tx": { "autoCommit": false, "statements": 0 } })
        )));
        // 自动提交：没有在途事务
        assert!(idle_slot_reclaimable(&ping(
            json!({ "alive": true, "tx": { "autoCommit": true, "statements": 3 } })
        )));
    }

    #[test]
    fn 会话槽键只接受数字槽名() {
        assert_eq!(slot_key("c1", None).unwrap(), "c1", "不传槽就是 primary");
        assert_eq!(slot_key("c1", Some("")).unwrap(), "c1");
        assert_eq!(slot_key("c1", Some("2")).unwrap(), "c1#2");
        // 槽名会拼进桥的会话名：允许任意字符串等于把前端输入当标识符用
        assert!(slot_key("c1", Some("2#3")).is_err());
        assert!(slot_key("c1", Some("abc")).is_err());
        assert!(slot_key("c1", Some("123")).is_err(), "两位以上不收");
    }

    #[test]
    fn 槽键能拆回连接与槽() {
        assert_eq!(split_slot_key("c1"), ("c1", None));
        assert_eq!(split_slot_key("c1#2"), ("c1", Some("2")));
        // 连接 id 里本来就可能带 #（老配置 / 手改），不是纯数字就别乱拆
        assert_eq!(split_slot_key("c#abc"), ("c#abc", None));
        // P0 的兜底会话归它所属的连接：退出确认里不能冒出「c1#java」这种假连接
        assert_eq!(split_slot_key(&java_key("c1")), ("c1", None));
        assert_eq!(split_slot_key(&java_key("c1#2")), ("c1", Some("2")));
    }
}
