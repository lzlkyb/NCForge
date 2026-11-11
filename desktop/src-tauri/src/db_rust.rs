//! 纯 Rust 引擎（B 方案）：用 Oracle 官方 `oracledb` 驱动 thin 直连，一条连接只占几 MB。
//!
//! 与 [`crate::db_bridge`] 那套「常驻 JVM + JDBC」对外的接口**完全一致**：都是
//! `命令 + 参数 → JSON`，所以命令层（`commands/db_cmds.rs`）一个字都不用改，选哪个引擎
//! 只由连接配置里的 `engine` 决定。
//!
//! # 与 JVM 桥的差异（能力位见 [`crate::db_engine::Caps`]）
//!
//! | 能力 | JVM 桥 | 这里 |
//! |---|---|---|
//! | 语句执行中取消 | `Statement.cancel()` | **有**（`vendor/oracledb` 里的 `BreakHandle` 补丁） |
//! | NC `prop.xml` 加密口令 | `PropXMLReader` 现解 | 由 JVM 桥解一次、DPAPI 存起来（见 `db_cmds`） |
//! | REF CURSOR | 支持 | `dbms_sql.return_result` / 嵌套游标列**支持**（多结果集见 [`implicit_sets`]）；`open :1 for` 这类 OUT 绑定仍不支持 |
//! | 内存 | 底价 ~60MB + 每会话几 MB | 纯驱动，每连接几 MB |
//!
//! 取消的实现：`RustEngine::cancel()` 只置一个原子位（**不抢会话锁**，否则排队排到查询后面
//! 就白取消了），驱动的传输层把阻塞读切成 100ms 的片，读到置位就返回「超时」，由持锁线程
//! 发 INTERRUPT 标记再 reset。真库实测：计算类长查询约 180ms 生效；`dbms_lock.sleep` 这类
//! 等待受 19c 服务端 3 秒块边界支配（30 秒的 sleep 约 3 秒返回）——不是客户端的问题，
//! 官方 python thin 驱动同样如此。会话随后仍可正常查询。
//!
//! 另外仍给连接设了 `call_timeout` 兜底：万一中断没能打断（比如语句还在服务端排队），
//! 界面也不会无限转圈。
//!
//! # 为什么每条命令都过一遍 `catch_unwind`
//!
//! 上游驱动有两处会 panic：11g 账号的密码校验器（oracle/rust-oracledb#63，我们已在
//! vendored 驱动里补上 11G 验证器，并把未知类型改成返回错误）和认证参数缺失时的 `unwrap()`。
//! 这条路径一旦 panic 就是整个应用进程没了，所以连接与执行仍套一层兜底。
//!
//! # 结果格式与 JVM 桥严格对齐
//!
//! 前端（`ResultGrid` / 导出 / 排序）只认 JVM 桥那套 JSON：`NUMBER` 太大的给字符串保精度、
//! `DATE` 给 `yyyy-MM-dd HH:mm:ss`、`CLOB` 截到 1M、`RAW` 给十六进制。这里逐条照搬，
//! 否则同一个查询在两个引擎下会显示出两种样子。

use std::collections::HashMap;
use std::io::Read;
use std::panic::{self, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use oracledb::{
    BreakHandle, Connection, Cursor, Error, ErrorKind, ExecResult, Lob, Metadata, Row, ToDbValue,
};
use serde_json::{json, Map, Value};

use crate::java_bridge::BridgeError;

/// 按需取完整 CLOB 时的上限（与 JVM 桥一致）。结果集里只带 `LOB_PREVIEW` 的预览，
/// 用户点「加载完整值」才走这个上限。
const CLOB_MAX: usize = 1024 * 1024;
/// 结果集里一格大文本最多带这么多字符。
///
/// 为什么不给 1MB：500 行 × 2 个 CLOB × 1MB 会直接把前端 16MB 的结果预算撑爆
/// （`lib/dbResultBudget.ts::fitRows` 按**整行**裁），后面的行根本进不来，
/// 用户看到的是「查出来 500 行，但一大半没了」。完整值走 `lobValue` 按需取。
///
/// 🔴 网格走预览通道；导出 / 表间搬运走 `execFull`（`CLOB_MAX` 的全量通道）。
/// 两条路都可能截断，判据一律用 [`is_lob_preview`]（按**尾部文案**认，不按长度）：
/// 8K 预览永远够不到 1MB，拿 1MB 当阈值会静默写出「正文 + 一句中文提示」。
pub(crate) const LOB_PREVIEW: usize = 8 * 1024;

/// 「这条会话有没有未提交事务」的数据库真源判据。
///
/// 两引擎（Rust / JVM 桥）必须用**同一条 SQL**：本地 DML 计数看不见手写 COMMIT、
/// PL/SQL 内部提交、别的工具做的回滚，只有 `v$transaction` 里那条记录才是真。
/// 读不到（账号没有 `V_$TRANSACTION` / `V_$SESSION` 授权）时返回 null 降级，
/// 绝不把「查不了」当成「没有事务」。
pub(crate) const TX_ACTIVE_SQL: &str = "select count(*) from v$transaction where ses_addr = (select saddr from v$session where sid = sys_context('userenv','sid'))";
/// DBMS_OUTPUT 一次最多取这么多行。
const OUTPUT_MAX: usize = 5000;
/// `columnsZh` 一次最多认几张表（Oracle `in (...)` 的参数上限是 1000）。
/// 调用方给的是「一条 SQL 里出现的表」，正常不会撞到；超了只是这一屏少几个中文名。
/// 改这里要同步 Java 桥的 `Session.MAX_ZH_TABLES`。
const MAX_ZH_TABLES: usize = 80;

/// `columns_zh` 用的 SQL。抽成函数是为了让真库测试跑**同一条**语句
/// （`tests/db_columns_zh_live.rs`）——另写一份「大概等价」的查询只能证明抄对了。
pub fn columns_zh_sql(n: usize) -> String {
    let ph = (1..=n.max(1))
        .map(|i| format!(":{i}"))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "select lower(c.tableid), lower(c.name), c.displayname from md_column c \
         where lower(c.tableid) in ({ph}) and c.displayname is not null"
    )
}

/// 对象树里的非表对象类型（`user_objects.object_type` 的取值）。
///
/// 这份白名单有两个用途：①`objects()` 的 `in (...)` 列表；②`ddl()` 拼
/// `dbms_metadata.get_ddl('<type>', :1)` 时的**注入防线**——类型名是 SQL 字面量、
/// 绑不进去，只能拼，所以必须只认这几个。改这里要同步 Java 桥的同名常量。
const OBJECT_TYPES: &[&str] = &[
    "PACKAGE",
    "PACKAGE BODY",
    "PROCEDURE",
    "FUNCTION",
    "SEQUENCE",
    "SYNONYM",
    "TRIGGER",
    "TYPE",
    "TYPE BODY",
];

fn sql_err(m: impl Into<String>) -> BridgeError {
    BridgeError::new("sql", m)
}

/// 一个重载的参数集合（`arguments` 命令的中间结构）。
///
/// 用结构体而不是四元组：`Vec<(i64, Option<String>, Option<String>, Vec<Value>)>` 过不了
/// `clippy::type_complexity`，而且三个同类型的 `Option<String>` 靠位置记语义太容易写反。
struct ArgGroup {
    sub_id: i64,
    package: Option<String>,
    /// 函数返回值（`position = 0` 那行），过程为 `None`。
    returns: Option<String>,
    args: Vec<Value>,
}

fn other_err(m: impl Into<String>) -> BridgeError {
    BridgeError::new("other", m)
}

fn not_connected() -> BridgeError {
    sql_err("还没连数据库")
}

/// 响应流错位：驱动在响应里读到了不认识的 TTC 消息类型。
///
/// 命中和「连接真的断了」是两回事：会话还在服务端活着，只是本机这条字节流已经
/// 对不上消息边界（`unknown TTC message type 0 at packet 1, offset …`），之后每条
/// 语句都会接着错位，界面上就表现成「用着用着会话断开」。发 RESET 标记能把流对齐。
fn is_desync(e: &Error) -> bool {
    matches!(e.kind(), ErrorKind::UnknownTtcMessageType(..))
}

/// [`is_desync`] 的字符串版：错误已经过 [`drv_err`] 转成 [`BridgeError`] 时用。
fn is_desync_msg(msg: &str) -> bool {
    msg.contains("unknown TTC message type")
}

/// 错位之后连 RESET 都对齐不了：这条连接已经不能再用，只能让用户重连。
fn resync_failed() -> BridgeError {
    BridgeError::new(
        "session-lost",
        "响应流错位，且自动对齐失败，请重新连接后核对事务状态",
    )
}

/// 驱动的错误 → 我们的错误码。带 `ORA-xxxxx` 前缀，命令层的 `map_sql_error` 靠它分流
/// （认证失败弹输口令框、网络不通单独提示）。
fn drv_err(e: Error) -> BridgeError {
    match e.kind() {
        ErrorKind::DbError(d) => {
            BridgeError::new("sql", format!("ORA-{:05}：{}", d.code(), d.message()))
        }
        // 两种情况走同一个驱动错误：用户点了「停止」（驱动发 INTERRUPT 打断），
        // 或者调用超时到期（兜底）。对用户来说都是「这条语句没跑完」，但语义不同：
        // 前者是主动取消，不该在结果区显示成红色失败；由 `classify_cancel` 按标志改码。
        // 真正的超时在 `exec_params` 里改写成带具体秒数的文案（这里不知道上限）。
        ErrorKind::CallTimeoutExceeded => BridgeError::new(
            "timeout",
            "语句已中断（点了停止，或等待超过超时时间）。会话仍然可用",
        ),
        // 这三种都表示「这条连接已经不能再用」：
        // - `DeadConnection`：驱动确认对端关了；
        // - `UnableToRecover`：驱动自己尝试恢复失败，连接已被关闭；
        // - `NotConnected`：连接对象本身已关（前一条之后驱动就变成这个）。
        //
        // 🔴 不能落到 `_ => sql`：那样探测与执行都会把它当普通 SQL 错误，上层既不标
        // 「会话丢失」也不重连，界面表现就是「闲置一阵后每次点执行都是同一句失败，
        // 只能手动断开重连」。这是最影响体感的一条，别改回去。
        ErrorKind::DeadConnection | ErrorKind::UnableToRecover | ErrorKind::NotConnected => {
            BridgeError::new("session-lost", "连接已断开（数据库或网络关闭了它）")
        }
        _ => BridgeError::new("sql", e.to_string()),
    }
}

/// 用户点了停止时，驱动给的是 `CallTimeoutExceeded`（和真正的超时同一条路）。
/// 中断标志为真就换成 `cancelled` —— 前端据此显示「已停止」而不是失败。
fn classify_cancel(
    result: Result<Value, BridgeError>,
    interrupted: &AtomicBool,
) -> Result<Value, BridgeError> {
    if interrupted.swap(false, Ordering::SeqCst) {
        if let Err(e) = &result {
            if e.code == "timeout" {
                return Err(BridgeError::new(
                    "cancelled",
                    "语句已中断（点了停止）。会话仍然可用",
                ));
            }
        }
    }
    result
}

/// 连接阶段的错误 → 前端码。
///
/// 为什么不能复用 [`drv_err`]：驱动把关不上 TCP（`io::ErrorKind::TimedOut`）也归到
/// `CallTimeoutExceeded`（见 `vendor/oracledb/src/error.rs` 的 `From<io::Error>`），
/// 复用就会把「连不上库」说成「语句已中断、会话仍然可用」——连接阶段根本没有会话。
fn connect_err(e: Error) -> BridgeError {
    match e.kind() {
        // 只说事实，不在这里堆建议：文案由前端统一补（JVM 桥的 ORA-12541 走同一条路）
        ErrorKind::CallTimeoutExceeded => {
            BridgeError::new("unreachable", "15 秒内没建立 TCP 连接（对端没响应）")
        }
        ErrorKind::StreamOperation | ErrorKind::DeadConnection => {
            BridgeError::new("unreachable", format!("连接被拒绝或网络中断：{e}"))
        }
        _ => drv_err(e),
    }
}

// ───────────────────────── 连接串 ─────────────────────────
/// 把 JDBC 的 URL 换成驱动认的 connect string。
///
/// 支持 NC `prop.xml` 里最常见的几种写法（`jdbc:oracle:thin:@host:port/service`、
/// `@//host:port/service`、`@host:port:sid`、完整 `(DESCRIPTION=…)` 描述符），
/// 也接受已经是 `host:port/service` 的裸串——这样手工填连接串时不用管前缀。
pub fn connect_string_from_jdbc(url: &str) -> Result<String, String> {
    let raw = url.trim();
    if raw.is_empty() {
        return Err("连接串是空的".to_string());
    }
    let after = raw.rsplit_once('@').map(|(_, r)| r).unwrap_or(raw).trim();
    let s = after.strip_prefix("//").unwrap_or(after).trim();
    if s.is_empty() {
        return Err(format!("连接串里 @ 后面没有地址：{raw}"));
    }
    // 完整描述符（含括号）与带服务名的形式原样交给驱动
    if s.contains('(') || s.contains('/') {
        return Ok(s.to_string());
    }
    // `host:port:sid` 是 JDBC 自己的写法，驱动认的是 `host:port/sid`
    if let Some((host_port, sid)) = s.rsplit_once(':') {
        if host_port.contains(':')
            && !sid.is_empty()
            && sid
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '$')
        {
            return Ok(format!("{host_port}/{sid}"));
        }
    }
    Ok(s.to_string())
}

// ───────────────────────── 引擎 ─────────────────────────

/// 一条连接的全部可变状态：会话串行执行，所以整块套一个 `Mutex` 就够了。
pub struct RustEngine {
    sess: Mutex<Session>,
    /// 中断句柄单独放一把锁：`cancel()` 要在长查询**占着 `sess` 锁**的时候插进来，
    /// 和它抢同一个锁就毫无意义了。这里只在连接/断开时短暂持有。
    /// 与 `Session.breaker` 是同一个 `Arc`（会话内部连接成功时写进去）。
    breaker: BreakerSlot,
    /// 本次「停止」是否由用户发起。驱动把主动中断和调用超时都报成
    /// `CallTimeoutExceeded`，靠这个标志把两者分开展示（见 `classify_cancel`）。
    interrupted: AtomicBool,
}

/// 「当前这条连接的中断句柄」。`None` = 没连上。
type BreakerSlot = Arc<Mutex<Option<BreakHandle>>>;

const MAX_RESULT_CURSORS: usize = 32;

/// Legacy callers keep their own slot; named results never replace another result's cursor.
struct ResultCursors<T> {
    legacy: Option<T>,
    named: HashMap<String, T>,
}

impl<T> ResultCursors<T> {
    fn new() -> Self {
        Self {
            legacy: None,
            named: HashMap::new(),
        }
    }

    fn check_capacity(&self, id: Option<&str>) -> Result<(), BridgeError> {
        if id.is_some_and(|id| !self.named.contains_key(id))
            && self.named.len() >= MAX_RESULT_CURSORS
        {
            return Err(BridgeError::new(
                "cursor-limit",
                "已保留 32 个查询游标，请先关闭部分结果再执行",
            ));
        }
        Ok(())
    }

    fn take(&mut self, id: Option<&str>) -> Option<T> {
        match id {
            Some(id) => self.named.remove(id),
            None => self.legacy.take(),
        }
    }

    fn put(&mut self, id: Option<&str>, cursor: T) {
        match id {
            Some(id) => {
                self.named.insert(id.to_string(), cursor);
            }
            None => self.legacy = Some(cursor),
        }
    }

    fn clear(&mut self) {
        self.legacy = None;
        self.named.clear();
    }
}

struct ResultCursor {
    cursor: Cursor,
    columns: Vec<Value>,
    full_lob: bool,
}

struct Session {
    conn: Option<Connection>,
    /// 「加载更多」用的游标。Oracle 游标不能回退，必须留着才能接着取。
    cursors: ResultCursors<ResultCursor>,
    auto_commit: bool,
    readonly: bool,
    readonly_started: bool,
    stats_unavailable: bool,
    /// `v$transaction` 读不到（低权限）：只探测一次，别每次状态刷新都白跑一趟字典。
    tx_unavailable: bool,
    previous_auto: bool,
    tx_statements: i64,
    tx_rows: i64,
    tx_since: i64,
    /// 登录账号（`select user from dual`）。`setSchema("")` 要切回它。
    login_user: String,
    /// 连接成功后由这里写入中断句柄（见 `RustEngine.breaker`）。
    breaker: BreakerSlot,
}

impl Default for RustEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl RustEngine {
    pub fn new() -> Self {
        let breaker: BreakerSlot = Arc::new(Mutex::new(None));
        Self {
            sess: Mutex::new(Session {
                conn: None,
                cursors: ResultCursors::new(),
                auto_commit: false,
                readonly: false,
                readonly_started: false,
                stats_unavailable: false,
                tx_unavailable: false,
                previous_auto: false,
                tx_statements: 0,
                tx_rows: 0,
                tx_since: 0,
                login_user: String::new(),
                breaker: breaker.clone(),
            }),
            breaker,
            interrupted: AtomicBool::new(false),
        }
    }

    /// 请求中断正在执行的语句（JDBC `Statement.cancel()` 的语义）。
    ///
    /// **不碰 `sess` 锁**——正在跑的那条语句占着它，取消要是排在后面就白取消了。
    pub fn cancel(&self) -> Result<(), BridgeError> {
        let handle = self
            .breaker
            .lock()
            .map_err(|_| other_err("数据库会话状态异常"))?
            .clone();
        match handle {
            Some(h) => {
                self.interrupted.store(true, Ordering::SeqCst);
                h.interrupt();
                Ok(())
            }
            None => Err(not_connected()),
        }
    }

    /// 跑一条命令。阻塞调用，调用方要放在 `spawn_blocking` 里。
    pub fn call(&self, cmd: &str, args: &[&str], timeout: Duration) -> Result<Value, BridgeError> {
        // 上一条语句留下的「用户停止」标志不能算到这一条头上。
        self.interrupted.store(false, Ordering::SeqCst);
        let mut s = self.lock();
        // 11g 密码校验器的 panic（#63）必须在这里拦下：它一炸就是整个进程退出
        let result = match panic::catch_unwind(AssertUnwindSafe(|| s.dispatch(cmd, args, timeout)))
        {
            Ok(r) => r,
            Err(p) => {
                let detail = panic_msg(&p);
                // 会话状态可能已经半死，直接丢掉连接，让用户重连
                s.reset_all();
                Err(other_err(format!(
                    "纯 Rust 驱动内部崩溃（这是驱动已知问题，见 oracle/rust-oracledb#63）：{detail}。\
                     这条连接已失效，请重连；若反复出现，把该连接的引擎改回「JVM 桥」"
                )))
            }
        };
        classify_cancel(result, &self.interrupted)
    }

    /// 有连接且还能 ping 通。
    ///
    /// 不抢锁：正在跑长查询时锁被占着，此时「连得上」是显然的，没必要排队等它跑完。
    pub fn alive(&self) -> bool {
        match self.sess.try_lock() {
            Ok(mut s) => s.ping().is_ok(),
            Err(std::sync::TryLockError::WouldBlock) => true,
            Err(std::sync::TryLockError::Poisoned(p)) => p.into_inner().ping().is_ok(),
        }
    }

    /// 断开**这条连接**（未提交的改动由服务端回滚）。
    pub fn shutdown(&self) {
        let mut s = self.lock();
        s.close();
    }

    /// 锁中毒了也要能用：panic 之后会话已经 `reset_all`，继续持有它是安全的。
    fn lock(&self) -> std::sync::MutexGuard<'_, Session> {
        self.sess.lock().unwrap_or_else(|e| e.into_inner())
    }
}

fn panic_msg(p: &Box<dyn std::any::Any + Send>) -> String {
    p.downcast_ref::<&str>()
        .map(|s| (*s).to_string())
        .or_else(|| p.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "未知 panic".to_string())
}

impl Session {
    fn dispatch(&mut self, cmd: &str, a: &[&str], timeout: Duration) -> Result<Value, BridgeError> {
        // 元数据命令同样要读超时：字典视图被别的会话 DDL 锁住时，没有超时就是无限期持锁，
        // 界面上表现为「结构页永远转圈」，只能杀进程。exec / more / lobValue 各自已经设过，
        // 这里只兜这一族（它们跑的是固定的小查询，用调用方给的整体超时即可）。
        let bounded = matches!(
            cmd,
            "tables"
                | "schemas"
                | "columns"
                | "arguments"
                | "indexes"
                | "columnsZh"
                | "ncNames"
                | "ddl"
                | "objects"
                | "source"
                | "explain"
                | "sessions"
                | "schema"
                | "schemaBatch"
                | "txActive"
                | "txStatus"
        );
        if bounded {
            if let Ok(conn) = self.conn_ref() {
                let _ = conn.set_call_timeout(Some(timeout));
            }
        }
        let out = match cmd {
            "connect" => {
                let auto = a.get(3).map(|v| v.eq_ignore_ascii_case("true")).unwrap_or(false);
                self.connect(a.first().copied().unwrap_or(""), a.get(1).copied().unwrap_or(""), a.get(2).copied().unwrap_or(""), auto, a.get(4).copied().unwrap_or(""), a.get(5).is_some_and(|v| v.eq_ignore_ascii_case("true")))
            }
            "connectProp" => Err(other_err(
                "纯 Rust 驱动解不了 NC prop.xml 里加密的口令（那要用 NC 自带的 PropXMLReader，只有 JVM 里能跑）。\
                 这个连接请改用「JVM 桥」，或者导入 .properties / 手工填连接参数",
            )),
            // `execFull` = 同一条查询，但结果集里 CLOB 给完整值（导出 / 表间搬运用）。
            // 网格绝不发这个命令：500 行 × 2 个 1MB CLOB 会撑爆前端的 16MB 结果预算。
            "exec" | "execFull" => self.exec(
                a.first().copied().unwrap_or(""),
                int_arg(a, 1, 500),
                int_arg(a, 2, 30),
                a.get(3).is_some_and(|v| v.eq_ignore_ascii_case("true")),
                cmd == "execFull",
                a.get(4).copied().filter(|id| !id.is_empty()),
            ),
            // `execFullBound` 与 execBound 同协议，只是 CLOB 走全量（导出带绑定变量时用）。
            // 不能靠在参数尾部加一个开关：a[3..] 是成对的 (类型, 值)，加单参数会破坏配对。
            "execBound" | "execFullBound" => {
                if a.len()<3 || !(a.len()-3).is_multiple_of(2) {return Err(sql_err("绑定参数协议不完整"));}
                let params: Result<Vec<Box<dyn ToDbValue>>, BridgeError> = a[3..].as_chunks::<2>().0.iter().map(|pair| {
                    Ok(match pair[0] {
                        "null" => Box::new(None::<String>) as Box<dyn ToDbValue>,
                        "number" => Box::new(decimal_number(pair[1])?),
                        "bool" => Box::new(if pair[1] == "true" { 1i32 } else { 0i32 }),
                        "string" => Box::new(pair[1].to_string()),
                        _ => return Err(sql_err("未知绑定类型")),
                    })
                }).collect();
                let params = params?;
                let refs: Vec<&dyn ToDbValue> = params.iter().map(|p| p.as_ref()).collect();
                self.exec_params(a[0],int_arg(a,1,500),int_arg(a,2,30),&refs,false,cmd == "execFullBound",None)
            }
            "readOnly" => self.set_readonly(a.first() == Some(&"true")),
            "more" => self.more(int_arg(a, 0, 500), timeout, a.get(1).copied().filter(|id| !id.is_empty())),
            "closeResult" => {
                let id = a.first().copied().filter(|id| !id.is_empty()).ok_or_else(|| sql_err("结果标识是空的"))?;
                Ok(json!({"closed": self.cursors.take(Some(id)).is_some()}))
            }
            "lobValue" => self.lob_value(
                a.first().copied().unwrap_or(""),
                int_arg(a, 1, 0),
                a.get(2).copied().unwrap_or(""),
                int_arg(a, 3, CLOB_MAX),
                timeout,
            ),
            "commit" => {
                let conn = self.conn_ref()?;
                conn.commit().map_err(drv_err)?;
                self.reset_tx();
                Ok(json!({ "tx": self.tx_json() }))
            }
            "rollback" => {
                let conn = self.conn_ref()?;
                conn.rollback().map_err(drv_err)?;
                self.reset_tx();
                Ok(json!({ "tx": self.tx_json() }))
            }
            "autocommit" => {
                self.conn_ref()?;
                // 驱动本身没有自动提交开关：切到自动提交时先把在途事务提交掉，
                // 与 JDBC 的 `setAutoCommit(true)` 行为一致（界面在有无提交事务时会先问用户）
                let on = a.first().map(|v| v.eq_ignore_ascii_case("true")).unwrap_or(false);
                if on && !self.auto_commit {
                    let conn = self.conn_ref()?;
                    conn.commit().map_err(drv_err)?;
                }
                self.auto_commit = on;
                self.reset_tx();
                Ok(json!({ "tx": self.tx_json() }))
            }
            // 两个命令走同一套探测。`conn.ping()` 不能用：Oracle thin 的 ping 在部分服务端
            // 会返回无法解析的 TTC 消息，本文件 `probe` 早就因此改成 `select 1 from dual`；
            // 而 `db_read_only` 与重连前置校验走的是 `ping`，两套口径必须统一。
            "ping" => {
                let alive = self.probe_conn(timeout).is_ok();
                if !alive { self.cursors.clear(); }
                Ok(json!({ "alive": alive, "tx": self.tx_json() }))
            }
            // 重连前给 `db_engine.rs` 校准本地脏标志用：只问字典，不探活、不改计数。
            "txActive" => Ok(json!({
                "active": self.tx_active().map(Value::Bool).unwrap_or(Value::Null)
            })),
            // 前端「核对事务」用：探活 + 真源 + 本地计数，一次往返都给齐。
            // `active` 同时放进 tx 与顶层：TxBar 拿 `status.tx` 就能显示核对结果。
            "txStatus" => {
                let alive = self.probe_conn(timeout).is_ok();
                if !alive { self.cursors.clear(); }
                let flag = self.tx_active().map(Value::Bool).unwrap_or(Value::Null);
                let mut tx = self.tx_json();
                if let Some(m) = tx.as_object_mut() {
                    m.insert("active".into(), flag.clone());
                }
                Ok(json!({ "alive": alive, "tx": tx, "active": flag }))
            }
            "probe" => {
                if self.conn.is_none() {
                    return Ok(json!({ "alive": false, "tx": self.tx_json() }));
                }
                self.probe_conn(timeout)?;
                Ok(json!({ "alive": true, "tx": self.tx_json() }))
            }
            // 诊断/自救用：丢弃错位的响应流，把连接拉回可用（不改事务状态、不重发语句）。
            // 界面上正常路径不会调它——执行与取数命中错位时会自己对齐。
            "resync" => {
                self.cursors.clear();
                let Some(conn) = self.conn.as_ref() else {
                    return Err(not_connected());
                };
                let _ = conn.set_call_timeout(Some(timeout));
                let out = conn.resync().map_err(drv_err);
                let _ = conn.set_call_timeout(None);
                out.map(|_| json!({ "resynced": true }))
            }
            "disconnect" => {
                self.close();
                Ok(json!({}))
            }
            "tables" => self.tables(),
            "schemas" => self.schemas(),
            "setSchema" => self.set_schema(a.first().copied().unwrap_or("")),
            "ncNames" => self.nc_names(),
            "columnsZh" => self.columns_zh(a.first().copied().unwrap_or("")),
            "columns" => self.columns(a.first().copied().unwrap_or("")),
            "arguments" => self.arguments(a.first().copied().unwrap_or("")),
            "indexes" => self.indexes(a.first().copied().unwrap_or("")),
            "ddl" => self.ddl(
                a.first().copied().unwrap_or(""),
                a.get(1).copied(),
            ),
            "objects" => self.objects(),
            "source" => self.source(a.first().copied().unwrap_or("")),
            "explain" => self.explain(a.first().copied().unwrap_or("")),
            "sessions" => self.sessions(),
            "schema" => self.schema(int_arg(a, 0, 0), int_arg(a, 1, 2000)),
            "schemaBatch" => self.schema_batch(a.first().copied().unwrap_or("")),
            // 真正的中断走 `RustEngine::cancel()`（不经过会话锁），这条命令只是占位
            "cancel" => Err(other_err("请用引擎层的 cancel，不要发 cancel 命令")),
            other => Err(other_err(format!("纯 Rust 引擎不认识这个命令：{other}"))),
        };
        if bounded {
            if let Ok(conn) = self.conn_ref() {
                let _ = conn.set_call_timeout(None);
            }
        }
        if matches!(&out, Err(e) if is_desync_msg(&e.message) || e.code == "session-lost") {
            self.cursors.clear();
        }
        out
    }

    fn conn_ref(&self) -> Result<&Connection, BridgeError> {
        self.conn.as_ref().ok_or_else(not_connected)
    }

    fn reset_tx(&mut self) {
        self.readonly_started = false;
        self.tx_statements = 0;
        self.tx_rows = 0;
        self.tx_since = 0;
    }

    fn reset_all(&mut self) {
        self.cursors.clear();
        self.conn = None;
        self.drop_breaker();
        self.reset_tx();
    }

    /// 清掉中断句柄：连接没了，句柄留着只会让 `cancel` 误以为还能取消。
    fn drop_breaker(&self) {
        if let Ok(mut b) = self.breaker.lock() {
            *b = None;
        }
    }

    fn tx_json(&self) -> Value {
        json!({
            "autoCommit": self.auto_commit,
            "statements": self.tx_statements,
            "rows": self.tx_rows,
            "since": self.tx_since,
        })
    }

    fn ping(&mut self) -> Result<(), BridgeError> {
        let conn = self.conn_ref()?;
        conn.ping().map_err(drv_err)
    }

    fn close(&mut self) {
        self.drop_breaker();
        // 游标先归还，再关连接；否则仍持有旧会话的游标会延长服务端资源寿命。
        self.cursors.clear();
        if let Some(conn) = self.conn.take() {
            if !self.auto_commit {
                let _ = conn.rollback();
            }
            // Connection::close 要 &mut：这里已经取出所有权，drop 也会关，显式调用只是为了
            // 立刻把会话还给服务端
            let mut conn = conn;
            let _ = conn.close();
        }
        self.reset_tx();
    }

    // ───────────────────── 连接 ─────────────────────

    fn connect(
        &mut self,
        url: &str,
        user: &str,
        pass: &str,
        auto: bool,
        schema: &str,
        no_stmt_cache: bool,
    ) -> Result<Value, BridgeError> {
        self.close();
        let cs = connect_string_from_jdbc(url).map_err(sql_err)?;
        let mut cfg = oracledb::Config::default()
            .set_credentials(user, pass)
            // 连不通的库不能一直挂着：JVM 桥那边是 `oracle.net.CONNECT_TIMEOUT=15000`，
            // 这里对齐成同一个数。不设的话退到系统 TCP 超时，界面上会转两三分钟。
            .set_transport_connect_timeout(Some(Duration::from_secs(15)))
            .set_connect_string(&cs)
            .map_err(drv_err)?;
        // 关缓存 = 设成 0：`StatementCache::new(0)` 之后 `has_space()` 恒 false，
        // 每条语句都现 parse、用完即弃，缓存里不会再留着过期的 describe info 和
        // 半途而废的 cursor_id（见 `DbConnConfig::no_stmt_cache` 的说明）。
        // 不给值就走驱动默认（20 个 slot）。
        if no_stmt_cache {
            cfg = cfg.set_stmtcachesize(0);
        }
        let conn = oracledb::connect(cfg).map_err(connect_err)?;
        // DBMS_OUTPUT 默认关着：打开后 PL/SQL 里的 put_line 才能在「输出」标签看到。
        // 没权限也不影响连库。
        let _ = conn.execute("begin dbms_output.enable(1000000); end;", &[]);
        let login_user =
            scalar_string(&conn, "select user from dual").unwrap_or_else(|| user.to_string());
        // 默认 schema 跟着连接一起设：以后写 `select * from org_orgs` 就不用带 `aier633.`。
        // 放在「刚连上、还没有任何事务」的时刻最干净（`alter session` 本身也不提交事务）。
        //
        // 这里**不让连接失败**：配置里写错 schema 就永远连不上，用户连改配置的入口都没有。
        // 回落到登录账号 + 带回 `schemaWarning`，由界面标一行黄字——不静默。
        let (current, schema_warning) = match effective_schema(&conn, schema, &login_user) {
            Ok(current) => (current, String::new()),
            Err(e) => (login_user.clone(), e.message),
        };
        let version = db_version(&conn);
        self.stats_unavailable = false;
        self.tx_unavailable = false;
        self.readonly = false;
        self.readonly_started = false;
        self.auto_commit = auto;
        self.login_user = login_user.clone();
        self.reset_tx();
        // 中断句柄先取出来再交所有权：`cancel()` 要从另一个线程用它
        let breaker = conn.break_handle().ok();
        self.conn = Some(conn);
        if let Ok(mut b) = self.breaker.lock() {
            *b = breaker;
        }
        Ok(json!({
            "url": url,
            "product": "Oracle",
            "version": version,
            "user": login_user,
            "schema": current,
            "schemaWarning": schema_warning,
            "autoCommit": auto,
            // 实际生效值（不是配置值）：关掉缓存时界面要能说出来，否则用户不知道
            // 「我开了那个开关」到底有没有落到这条会话上。
            "noStmtCache": no_stmt_cache,
        }))
    }

    /// 切换默认 schema。空串 = 回到登录账号自己的 schema。
    fn set_schema(&mut self, name: &str) -> Result<Value, BridgeError> {
        self.cursors.clear();
        // 连接先取出来再放回：`effective_schema` 要 `&Connection`，而这里拿着 `&mut self`。
        let conn = self.conn.take().ok_or_else(not_connected)?;
        let result = effective_schema(&conn, name, &self.login_user);
        self.conn = Some(conn);
        result.map(|current| json!({"schema": current}))
    }

    /// 库里的 schema 清单（`all_users`，任何账号都读得到）。
    ///
    /// 用独立语句而不是「先 exec 再取游标」：这条查询不能碰「加载更多」的游标，
    /// 否则结果表里上一页的数据就再也取不到了。
    fn schemas(&self) -> Result<Value, BridgeError> {
        let conn = self.conn_ref()?;
        let cur = conn
            .query("select username from all_users order by username", &[])
            .map_err(drv_err)?;
        let mut list: Vec<String> = Vec::new();
        for row in cur {
            let row = row.map_err(drv_err)?;
            if let Ok(Some(name)) = row.get::<Option<String>>(0) {
                list.push(name);
            }
        }
        let current = current_schema_of(conn).unwrap_or_else(|| self.login_user.clone());
        Ok(json!({
            "schemas": list,
            "current": current,
            "user": self.login_user,
        }))
    }

    // ───────────────────── 执行 ─────────────────────

    fn set_readonly(&mut self, enabled: bool) -> Result<Value, BridgeError> {
        self.conn_ref()?;
        if enabled != self.readonly {
            if self.tx_statements > 0 {
                return Err(sql_err("有未提交写入，请先提交或回滚再切换只读查询"));
            }
            self.cursors.clear();
            self.conn_ref()?.rollback().map_err(drv_err)?;
            if enabled {
                self.previous_auto = self.auto_commit;
                self.auto_commit = false;
            } else {
                self.auto_commit = self.previous_auto;
            }
            self.readonly = enabled;
            self.readonly_started = false;
        }
        if enabled && !self.readonly_started {
            self.conn_ref()?
                .execute("set transaction read only", &[])
                .map_err(drv_err)?;
            self.readonly_started = true;
        }
        Ok(json!({"readOnly":self.readonly,"tx":self.tx_json()}))
    }
    fn exec(
        &mut self,
        raw: &str,
        max_rows: usize,
        timeout_sec: usize,
        collect_stats: bool,
        full_lob: bool,
        result_id: Option<&str>,
    ) -> Result<Value, BridgeError> {
        self.exec_params(
            raw,
            max_rows,
            timeout_sec,
            &[],
            collect_stats,
            full_lob,
            result_id,
        )
    }
    #[allow(clippy::too_many_arguments)]
    fn exec_params(
        &mut self,
        raw: &str,
        max_rows: usize,
        timeout_sec: usize,
        params: &[&dyn ToDbValue],
        collect_stats: bool,
        full_lob: bool,
        result_id: Option<&str>,
    ) -> Result<Value, BridgeError> {
        if self.conn.is_none() {
            return Err(not_connected());
        }
        let sql = normalize(raw);
        if sql.is_empty() {
            self.cursors.take(result_id);
            return Err(sql_err("空语句"));
        }
        let head = leading_keywords(&sql);
        if is_query(&head, &sql) {
            // 先检查再发 SQL；满额时不能执行完才报错，更不能悄悄关掉其它结果。
            self.cursors.check_capacity(result_id)?;
        }
        self.cursors.take(result_id);
        let max_rows = max_rows.clamp(1, 10_000);
        let t0 = Instant::now();

        // 双重保险：用户点「停止」走中断句柄（立刻生效），这里的读超时只是兜底
        // ——万一中断没能打断（比如语句在服务端排队还没开始跑），也别让界面无限等。
        if let Ok(conn) = self.conn_ref() {
            let _ =
                conn.set_call_timeout(Some(Duration::from_secs(timeout_sec.max(1) as u64 + 10)));
        }
        // 仅显式请求 Autotrace 时前后读取 `v$mystat`；普通执行避免这两次往返。
        // 读不到（低权限账号没有 V_$MYSTAT 授权）就是 None，界面据此**不显示这一行**，
        // 而不是给一排 0 让人以为「这条 SQL 一次逻辑读都没花」。
        let mut before = None;
        let mut stat_denied = false;
        if collect_stats && !self.stats_unavailable {
            if let Ok(conn) = self.conn_ref() {
                match stat_snapshot(conn) {
                    Ok(s) => before = Some(s),
                    // 🔴 只有「这个账号永远读不到」才值得永久关掉。超时、连接抖动、
                    // 字典视图被别的会话锁住都是临时的——按一次失败就永久关闭，用户
                    // 会遇到「Autotrace 忽然再也不出数，只能重启应用」，而库里明明正常。
                    Err(e) => stat_denied = is_permanent_stat_error(&e),
                }
            }
        }
        if stat_denied {
            self.stats_unavailable = true;
        }
        let out = self.run(&sql, &head, max_rows, params, full_lob, result_id);
        // 收尾快照同样是一次网络往返，必须在读超时复位**之前**取：
        // 账号被卡住或字典视图被锁时，它和正文一样不能无限等。
        let after = if before.is_some() {
            self.conn_ref().ok().and_then(|c| stat_snapshot(c).ok())
        } else {
            None
        };
        if let Ok(conn) = self.conn_ref() {
            let _ = conn.set_call_timeout(None);
        }

        // 先把输出缓冲取空：`out?` 走错误分支时若还没取，本次语句已写入的
        // `put_line` 会留在缓冲里，被下一条成功语句一起取走 —— 输出就张冠李戴了。
        let output = self.take_output();
        // 超时的原文是「点了停止，或等待超过超时时间」，用户分不清是哪一种；
        // 走到这里说明没被用户停（停会被 `classify_cancel` 改码），所以直接写明秒数。
        let mut body = out.map_err(|e| {
            if e.code == "timeout" {
                BridgeError::new(
                    "timeout",
                    format!(
                        "等待超过 {timeout_sec} 秒仍未返回，语句已中断。会话仍然可用；\
                         要跑更久请在查询设置里调大等待上限"
                    ),
                )
            } else {
                e
            }
        })?;
        body.insert("ms".into(), json!(t0.elapsed().as_millis() as u64));
        body.insert(
            "stats".into(),
            match (before, after) {
                (Some(b), Some(a)) => a.since(&b),
                _ => Value::Null,
            },
        );
        body.insert("output".into(), json!(output));
        body.insert("tx".into(), self.tx_json());
        Ok(Value::Object(body))
    }

    /// 真正执行。`conn` 先取出来再用，避免「同一次调用里既要 `&mut self` 又要 `&self.conn`」。
    fn run(
        &mut self,
        sql: &str,
        head: &str,
        max_rows: usize,
        params: &[&dyn ToDbValue],
        full_lob: bool,
        result_id: Option<&str>,
    ) -> Result<Map<String, Value>, BridgeError> {
        let conn = self.conn.take().ok_or_else(not_connected)?;
        let r = self.run_with(&conn, sql, head, max_rows, params, full_lob, result_id);
        self.conn = Some(conn);
        r
    }

    #[allow(clippy::too_many_arguments)]
    fn run_with(
        &mut self,
        conn: &Connection,
        sql: &str,
        head: &str,
        max_rows: usize,
        params: &[&dyn ToDbValue],
        full_lob: bool,
        result_id: Option<&str>,
    ) -> Result<Map<String, Value>, BridgeError> {
        let mut body = Map::new();
        if is_query(head, sql) {
            // 🔴 不要在这里设 `prefetch_rows` / `fetch_array_size`。
            // vendor `oracledb 26.0.0-beta.5` 在「上一条同 SQL 的分页游标还没取完」
            // 时会命中语句缓存走 `TTC_RPC_REEXECUTE_AND_FETCH`（num_iters = prefetch_rows），
            // 服务端预取的行包与新响应交错，驱动把残留字节当消息头读，报
            // `unknown TTC message type <随机值> at packet 1, offset …`，且连接从此永久错位。
            // 真库复现：大表取 500 行留游标，再执行同一 SQL 必炸；换一条 SQL 就正常。
            // 驱动默认 prefetch_rows=2 / fetch_array_size=100 没有这个问题，别为省几次
            // 往返把它调大（真要调，先确认 vendor 的重执行路径已修）。
            let mut cur = match conn.query(sql, params) {
                Ok(cur) => cur,
                // 响应流错位：查询是只读的，对齐之后重发一次没有副作用。
                // 不重发的话这条连接上后面每条语句都会接着错位，只能重连。
                Err(e) if is_desync(&e) => {
                    self.cursors.clear();
                    if conn.resync().is_err() {
                        return Err(resync_failed());
                    }
                    conn.query(sql, params).map_err(drv_err)?
                }
                Err(e) => return Err(drv_err(e)),
            };
            let columns: Vec<Value> = cur.columns().iter().map(column_json).collect();
            let types: Vec<String> = cur
                .columns()
                .iter()
                .map(|m| base_type(&type_label(m)))
                .collect();
            let (rows, has_more) = page(&mut cur, &types, max_rows, full_lob)?;
            body.insert("kind".into(), json!("rows"));
            body.insert("columns".into(), Value::Array(columns.clone()));
            body.insert("rows".into(), json!(rows));
            body.insert("hasMore".into(), json!(has_more));
            if has_more {
                self.cursors.put(
                    result_id,
                    ResultCursor {
                        cursor: cur,
                        columns,
                        full_lob,
                    },
                );
            }
            // `select … for update` 也算开了事务（和 JVM 桥一致）
            if has_for_update(sql) {
                self.track_tx("lock", 0);
            }
            body.insert("rowCount".into(), json!(body_len(&body)));
        } else {
            let mut res = match conn.execute(sql, params) {
                Ok(res) => res,
                // 🔴 写语句绝不能自动重发：服务端可能已经执行完，只是响应那条流错位了。
                // 这里只做「把连接拉回可用」——否则接下来每条语句都报同一个错，用户
                // 只能重连，还会以为数据没写进去。结果有没有生效必须由人去库里核对。
                Err(e) if is_desync(&e) => {
                    self.cursors.clear();
                    if conn.resync().is_err() {
                        return Err(resync_failed());
                    }
                    return Err(BridgeError::new(
                        "session-desync",
                        format!(
                            "响应流错位（会话仍在，连接已自动恢复）。这条语句的结果未确认，\
                             如果是写入，可能已经生效——请提交前先到库里核对。原始错误：{e}"
                        ),
                    ));
                }
                Err(e) => return Err(drv_err(e)),
            };
            let n = res.rows_affected();
            // 隐式结果集（`dbms_sql.return_result`）：PL/SQL 块自己开的 ref cursor，
            // 服务端按 TTC 27 号消息下发，驱动侧已解析（vendor 补丁四）。
            let sets = implicit_sets(&mut res, max_rows, full_lob)?;
            if sets.is_empty() {
                body.insert("kind".into(), json!("update"));
                body.insert("updateCount".into(), json!(n));
            } else {
                // 顶层字段仍给第一个结果集：旧的前端 / 导出 / 排序逻辑不用改。
                let first = &sets[0];
                body.insert("kind".into(), json!("rows"));
                body.insert("columns".into(), first["columns"].clone());
                body.insert("rows".into(), first["rows"].clone());
                // 隐式结果集不留游标（见 `implicit_sets` 的注释），顶层就永远没有「更多」；
                // 每个结果集自己的 `hasMore` 才是真截断标记，前端据此提示调大行数。
                body.insert("hasMore".into(), json!(false));
                body.insert("rowCount".into(), json!(body_len(&body)));
                body.insert("sets".into(), Value::Array(sets));
            }
            self.track_tx(head, n as i64);
            if self.auto_commit {
                conn.commit().map_err(drv_err)?;
                self.reset_tx();
            }
        }
        Ok(body)
    }

    fn more(
        &mut self,
        max_rows: usize,
        timeout: Duration,
        result_id: Option<&str>,
    ) -> Result<Value, BridgeError> {
        let max_rows = max_rows.clamp(1, 10_000);
        let t0 = Instant::now();
        // 取出游标再取数：失败时不能把坏游标留在池里 —— 继续在它上面
        // `next()` 只会重复同一个报错，或者给出错位的行（TTC 那条坑尤其如此）。
        let Some(mut state) = self.cursors.take(result_id) else {
            // 独立错误码：前端据此把「重试加载」换成「重新执行」。
            // 上一次续取失败时游标已经被 take 走并关闭，再点多少次都是这个结果。
            return Err(BridgeError::new(
                "cursor-closed",
                "没有可以继续读取的结果（游标已关闭，重新执行一次）",
            ));
        };
        let types: Vec<String> = state
            .columns
            .iter()
            .map(|c| base_type(c.get("type").and_then(Value::as_str).unwrap_or("")))
            .collect();
        // 「加载更多」以前没有超时：服务端黑洞时这里会一直持着会话锁，
        // 同一连接上的提交 / 断开全部排队，用户只能强杀进程。
        if let Some(conn) = self.conn.as_ref() {
            conn.set_call_timeout(Some(timeout)).map_err(drv_err)?;
        }
        let next = page(&mut state.cursor, &types, max_rows, state.full_lob);
        // 错位要**先对齐再清超时**：`resync()` 要读到服务端回的重置标记，
        // 没有读超时会一直等下去。
        let desync = matches!(&next, Err(e) if is_desync_msg(&e.message));
        let mut broken = false;
        if desync {
            self.cursors.clear();
            if let Some(conn) = self.conn.as_ref() {
                broken = conn.resync().is_err();
            }
        }
        if let Some(conn) = self.conn.as_ref() {
            let _ = conn.set_call_timeout(None);
        }
        let next = match next {
            Ok(v) => v,
            // 游标已经跟着错位流一起作废，重取没有意义：让用户重新执行这次查询。
            Err(_) if desync => {
                return Err(if broken {
                    resync_failed()
                } else {
                    sql_err("取数过程中响应流错位，连接已自动恢复；请重新执行这次查询")
                });
            }
            Err(e) => {
                // 游标已在上一行被 take 走，这里随作用域结束关闭；用户再点「加载更多」
                // 会收到「游标已关闭」，重新执行一次即可。
                return Err(e);
            }
        };
        let (rows, has_more) = next;
        if has_more {
            self.cursors.put(result_id, state);
        }
        let count = rows.len();
        Ok(json!({
            "rows": rows,
            "rowCount": count,
            "hasMore": has_more,
            "ms": t0.elapsed().as_millis() as u64,
        }))
    }

    /// 按需取一格大文本的完整值（结果集里只带 `LOB_PREVIEW` 的预览）。
    ///
    /// 不重跑原 SQL：外面套一层「编号 + 取第 N 行」，服务端只回一行一列；而且 SQL
    /// 文本变了，不会命中驱动按语句文本走的缓存 —— 同一条 SQL 重执行遇上没取完的
    /// 游标会触发 vendor 的 TTC 错位（见 `run_with` 的注释），那条路不能碰。
    fn lob_value(
        &mut self,
        raw: &str,
        row_index: usize,
        column: &str,
        max_chars: usize,
        timeout: Duration,
    ) -> Result<Value, BridgeError> {
        let sql = normalize(raw);
        if sql.is_empty() {
            return Err(sql_err("SQL 是空的"));
        }
        if !is_query(&leading_keywords(&sql), &sql) {
            return Err(sql_err("只有查询结果才能按需取大文本"));
        }
        let probe = lob_probe_sql(&sql, column, row_index)?;
        // 🔴 借连接，不要 `take()` 走。`take()` 之后任何一个 `?` 早退都会跳过
        // `self.conn = Some(conn)`，连接被 drop 掉，会话就永久停在「还没连数据库」——
        // 用户只会看到「用着用着连接没了」。同文件的 `more()` 用的也是 `as_ref()`。
        let Some(conn) = self.conn.as_ref() else {
            return Err(not_connected());
        };
        // 大字段读取同样要有上限：对方数据库卡住时，这条命令会一直占着会话锁。
        conn.set_call_timeout(Some(timeout)).map_err(drv_err)?;
        let out = lob_value_with(conn, &probe, row_index, max_chars.clamp(1, CLOB_MAX));
        let _ = conn.set_call_timeout(None);
        out
    }

    /// 探活：一条只读查询，不碰用户现有的分页游标。
    ///
    /// `conn.ping()` 不能用 —— thin 驱动在部分服务端会返回无法解析的 TTC 消息，
    /// 而这里的失败会被上层当成「连接已死」，误判代价比多一次往返大得多。
    fn probe_conn(&mut self, timeout: std::time::Duration) -> Result<(), BridgeError> {
        let Some(conn) = self.conn.as_ref() else {
            return Err(not_connected());
        };
        conn.set_call_timeout(Some(timeout)).map_err(drv_err)?;
        let result = conn.query_row("select 1 from dual", &[]);
        let _ = conn.set_call_timeout(None);
        result.map(|_| ()).map_err(drv_err)
    }

    /// 查 `v$transaction`：`Some(true/false)` 是数据库真源，`None` 是查不了（降级）。
    fn tx_active(&mut self) -> Option<bool> {
        if self.tx_unavailable {
            return None;
        }
        // 取出所有权再借：失败分支要写 `self.tx_unavailable`，不能同时借用 `self.conn`。
        let conn = self.conn.take()?;
        let mut unavailable = false;
        // 字典视图可能被别的会话的 DDL 锁住。这里不能靠调用方给的超时：
        // `txStatus` 里的 probe_conn 会顺手把 call_timeout 清成 None。
        let _ = conn.set_call_timeout(Some(Duration::from_secs(3)));
        let out = match conn.query(TX_ACTIVE_SQL, &[]) {
            Ok(mut cur) => {
                let first = cur.next();
                // 取干净：vendor 的语句缓存按 SQL 文本重执行，留着未取完的游标会让
                // 下一次同 SQL 命中 TTC 预取交错，连接从此永久错位（见 run_with）。
                while cur.next().is_some() {}
                match first {
                    Some(Ok(row)) => row
                        .get::<Option<String>>(0)
                        .ok()
                        .flatten()
                        .and_then(|s| s.trim().parse::<u64>().ok())
                        .map(|n| n > 0),
                    _ => {
                        unavailable = true;
                        None
                    }
                }
            }
            Err(_) => {
                unavailable = true;
                None
            }
        };
        let _ = conn.set_call_timeout(None);
        self.conn = Some(conn);
        if unavailable {
            // 与 stats 同口径：只探测一次，重连成功时重置（换账号后还能重试）。
            self.tx_unavailable = true;
        }
        out
    }

    fn track_tx(&mut self, head: &str, update_count: i64) {
        if self.auto_commit {
            return;
        }
        if is_ddl(head) {
            // Oracle 的 DDL 前后各隐式提交一次
            self.reset_tx();
            return;
        }
        // 编辑器里手写 `commit;` / `rollback;` 也是真的结束了事务。不认这两个词的话，
        // 计数永远清不掉，之后切只读会被「有未提交写入」永久挡住，而库里其实早提交了。
        if starts_any(head, &["commit", "rollback"]) {
            self.reset_tx();
            return;
        }
        // `for update` 也在事务里（并且拿着行锁），PL/SQL 块里的 DML 同理 —— 这两类
        // 首关键字都不是 DML，按白名单判会漏计，随后切只读 / 重连 / 关标签的 rollback
        // 就会静默丢掉锁和写入。宁可多计一次（用户点一次提交即可），不能少计。
        if opens_transaction(head) {
            if self.tx_statements == 0 {
                self.tx_since = now_ms() as i64;
            }
            self.tx_statements += 1;
            if update_count > 0 {
                self.tx_rows += update_count;
            }
        }
    }

    /// 取空 DBMS_OUTPUT 缓冲（没开或没权限就是空数组）。
    fn take_output(&self) -> Vec<String> {
        let mut out = Vec::new();
        let Ok(conn) = self.conn_ref() else {
            return out;
        };
        for _ in 0..OUTPUT_MAX {
            let line = String::new();
            let status = String::new();
            let mut res = match conn.execute(
                "begin dbms_output.get_line(:1, :2); end;",
                &[&line as &dyn ToDbValue, &status as &dyn ToDbValue],
            ) {
                Ok(r) => r,
                Err(_) => break,
            };
            let row = res.out_bind_data();
            let text: String = row.get(0).unwrap_or_default();
            // status 是 NUMBER：正常取成整数，取不动（类型没对）就退回按字符串解析，
            // 两种情况都拿不到就当作「没有更多输出」——不能因为读状态失败把整段输出吞掉
            let st: i64 = match row.get::<Option<i64>>(1) {
                Ok(Some(v)) => v,
                _ => row
                    .get::<Option<String>>(1)
                    .ok()
                    .flatten()
                    .and_then(|s| s.trim().parse().ok())
                    .unwrap_or(1),
            };
            if st != 0 {
                break;
            }
            out.push(text);
        }
        out
    }

    // ───────────────────── 元数据 ─────────────────────

    fn tables(&self) -> Result<Value, BridgeError> {
        let conn = self.conn_ref()?;
        // 按当前默认 schema 过滤（不是登录账号）：切了 schema 之后树里列的必须和「不带
        // 前缀能解析到的表」一致，否则会出现「树上有、SQL 报 ORA-00942」。用 all_* 而非
        // user_*：user_* 永远只有登录账号自己的表，切过去就是空的。没授权的表不显示——
        // 那正是「能查什么」的真实边界。查询文本与 JVM 桥的 tables() 保持一致。
        let sql = "select table_name, 'TABLE' from all_tables \
                   where owner = sys_context('userenv','current_schema') and table_name not like 'BIN$%' \
                   union all select view_name, 'VIEW' from all_views \
                   where owner = sys_context('userenv','current_schema') order by 1";
        // 与 `run_with` 同理：下面若某行转换失败会提前 `return`，游标未必取完，
        // 放大 prefetch 就有把行包留在 TTC 流里的风险。用驱动默认取数。
        let cur = conn.query(sql, &[]).map_err(drv_err)?;
        let mut list = Vec::new();
        for row in cur {
            let row = row.map_err(drv_err)?;
            list.push(json!({
                "name": row.get::<Option<String>>(0).ok().flatten().unwrap_or_default(),
                "kind": row.get::<Option<String>>(1).ok().flatten().unwrap_or_default(),
            }));
        }
        let n = list.len();
        Ok(json!({ "tables": list, "count": n }))
    }

    /// NC 元数据里的表中文名（`md_table.displayname`）。不是 NC 库就返回空。
    fn nc_names(&self) -> Result<Value, BridgeError> {
        let conn = self.conn_ref()?;
        let mut map = Map::new();
        if let Ok(cur) = conn.query(
            "select lower(name), displayname from md_table where displayname is not null",
            &[],
        ) {
            for row in cur {
                let Ok(row) = row else { continue };
                let k: Option<String> = row.get(0).ok().flatten();
                let v: Option<String> = row.get(1).ok().flatten();
                if let (Some(k), Some(v)) = (k, v) {
                    map.insert(k, json!(v));
                }
            }
        }
        let n = map.len();
        Ok(json!({ "names": map, "count": n }))
    }

    /// 一批表的列中文名，键是 `表名|列名`（都小写）。
    ///
    /// 为什么按**表**查而不是按列名查：`name` / `id` / `code` 这类列名在几百张表里都有，
    /// 按列名去重只能瞎挑一个 —— `code` 可能叫「编码」也可能叫「单据号」，
    /// 张冠李戴比不显示更糟。调用方传的是 SQL 里出现的表，同名列由前端按
    /// 「先出现的表优先」合并（主表在前）。
    fn columns_zh(&self, tables: &str) -> Result<Value, BridgeError> {
        let conn = self.conn_ref()?;
        let names: Vec<String> = tables
            .split(',')
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty())
            .take(MAX_ZH_TABLES)
            .collect();
        let mut map = Map::new();
        if names.is_empty() {
            return Ok(json!({ "names": map, "count": 0 }));
        }
        let sql = columns_zh_sql(names.len());
        let vals: Vec<&dyn ToDbValue> = names.iter().map(|s| s as &dyn ToDbValue).collect();
        if let Ok(cur) = conn.query(&sql, &vals) {
            for row in cur {
                let Ok(row) = row else { continue };
                let t: Option<String> = row.get(0).ok().flatten();
                let c: Option<String> = row.get(1).ok().flatten();
                let v: Option<String> = row.get(2).ok().flatten();
                if let (Some(t), Some(c), Some(v)) = (t, c, v) {
                    // md_column 同一列可能有多版本：先到的留下，与 `nc_column_names` 同口径
                    map.entry(format!("{t}|{c}")).or_insert(json!(v));
                }
            }
        }
        let n = map.len();
        Ok(json!({ "names": map, "count": n }))
    }

    fn columns(&self, table: &str) -> Result<Value, BridgeError> {
        let conn = self.conn_ref()?;
        let (owner, t) = split_qualified(table);
        let zh = self.nc_column_names(conn, &t);
        let pk = self.pk_columns(conn, &t, owner.as_deref())?;
        // `aier633.bd_material` 与 `bd_material` 要分开处理：前者按 owner 精确查，
        // 后者沿用连接的 current_schema。整串丢给 `table_name = :1` 永远查不到，
        // 结果是「表有主键却被判成没有主键」——SQL 控制台双击不能改就是这么来的。
        const BASE: &str = "select c.column_name, c.data_type, c.char_length, c.data_precision, \
                   c.data_scale, c.nullable, c.data_default, cc.comments \
                   from all_tab_columns c left join all_col_comments cc \
                   on cc.owner = c.owner and cc.table_name = c.table_name \
                   and cc.column_name = c.column_name \
                   where c.table_name = :1";
        let cur = match owner.as_deref() {
            Some(o) => conn.query(
                &format!("{BASE} and c.owner = :2 order by c.column_id"),
                &[&t as &dyn ToDbValue, &o as &dyn ToDbValue],
            ),
            None => conn.query(
                &format!("{BASE} and c.owner = sys_context('userenv','current_schema') order by c.column_id"),
                &[&t as &dyn ToDbValue],
            ),
        }
        .map_err(drv_err)?;
        let mut out = Vec::new();
        for row in cur {
            let row = row.map_err(drv_err)?;
            let name: String = row
                .get::<Option<String>>(0)
                .ok()
                .flatten()
                .unwrap_or_default();
            let ty: String = row
                .get::<Option<String>>(1)
                .ok()
                .flatten()
                .unwrap_or_default();
            let len: i64 = row.get::<Option<i64>>(2).ok().flatten().unwrap_or(0);
            let prec: Option<i64> = row.get(3).ok().flatten();
            let scale: i64 = row.get::<Option<i64>>(4).ok().flatten().unwrap_or(0);
            let nullable = row
                .get::<Option<String>>(5)
                .ok()
                .flatten()
                .map(|v| v == "Y")
                .unwrap_or(false);
            let def: Option<String> = row.get(6).ok().flatten();
            let comment: Option<String> = row.get(7).ok().flatten();
            let size = if len > 0 { len } else { prec.unwrap_or(0) };
            out.push(json!({
                "name": name,
                "type": ty,
                "size": size,
                "full": full_type(&ty, len, prec, scale),
                "nullable": nullable,
                "pk": pk.iter().any(|p| p == &name),
                "default": def.map(|d| d.trim().to_string()),
                "comment": comment,
                "zh": zh.get(&name.to_lowercase()).cloned(),
            }));
        }
        Ok(json!({ "table": table, "columns": out }))
    }

    /// 过程 / 函数的参数清单（SQL 编辑器签名帮助用）。
    ///
    /// `name` 支持 `proc` 与 `pkg.proc` 两种写法：`all_arguments` 里 `object_name` 是过程名、
    /// `package_name` 是包名，两者都不是 schema owner，所以拆出来按列匹配，owner 固定取
    /// 当前会话的 current_schema（跨 schema 的过程在 NC 现场几乎不写）。
    ///
    /// 重载会返回多条 `subprogramId`——**不能按过程名去重**，否则重载的签名全被合成一个，
    /// 参数个数对不上时提示就是错的。
    fn arguments(&self, name: &str) -> Result<Value, BridgeError> {
        let conn = self.conn_ref()?;
        let (pkg, proc_name) = match name.rsplit_once('.') {
            Some((p, n)) => (Some(p.to_string()), n.to_string()),
            None => (None, name.to_string()),
        };
        const BASE: &str = "select a.package_name, a.subprogram_id, a.position, a.argument_name, \
                   a.data_type, a.in_out, a.defaulted \
                   from all_arguments a \
                   where a.owner = sys_context('userenv','current_schema') \
                   and lower(a.object_name) = lower(:1)";
        let cur = match pkg.as_deref() {
            Some(p) => {
                // position 0 是函数返回值（argument_name 为空），一起取回来当返回类型
                conn.query(
                    &format!("{BASE} and lower(a.package_name) = lower(:2) order by a.subprogram_id, a.position"),
                    &[&proc_name as &dyn ToDbValue, &p as &dyn ToDbValue],
                )
            }
            None => conn.query(
                &format!("{BASE} and a.package_name is null order by a.subprogram_id, a.position"),
                &[&proc_name as &dyn ToDbValue],
            ),
        }
        .map_err(drv_err)?;
        // subprogram_id 保序（Oracle 按定义顺序给），用 Vec + 线性查找而不是 HashMap，
        // 因为签名顺序直接影响「第几个重载排前面」，HashMap 会把这个顺序打乱。
        let mut groups: Vec<ArgGroup> = Vec::new();
        for row in cur {
            let row = row.map_err(drv_err)?;
            let package: Option<String> = row.get::<Option<String>>(0).ok().flatten();
            let sub_id: i64 = row.get::<Option<i64>>(1).ok().flatten().unwrap_or(0);
            let pos: i64 = row.get::<Option<i64>>(2).ok().flatten().unwrap_or(0);
            let arg_name: Option<String> = row.get::<Option<String>>(3).ok().flatten();
            let ty: Option<String> = row.get::<Option<String>>(4).ok().flatten();
            let in_out: Option<String> = row.get::<Option<String>>(5).ok().flatten();
            let defaulted = row
                .get::<Option<String>>(6)
                .ok()
                .flatten()
                .map(|v| v == "Y")
                .unwrap_or(false);
            let slot = match groups.iter().position(|g| g.sub_id == sub_id) {
                Some(i) => i,
                None => {
                    groups.push(ArgGroup {
                        sub_id,
                        package: package.clone(),
                        returns: None,
                        args: Vec::new(),
                    });
                    groups.len() - 1
                }
            };
            // position = 0 的那行是返回值，不是参数：放进 returns 而不是 args，
            // 否则签名会渲染成「函数名(返回值类型)」这种没人看得懂的形态。
            if pos == 0 {
                groups[slot].returns = ty;
                continue;
            }
            groups[slot].args.push(json!({
                "name": arg_name.unwrap_or_default(),
                "type": ty.unwrap_or_default(),
                "inOut": in_out.unwrap_or_else(|| "IN".to_string()),
                "defaulted": defaulted,
            }));
        }
        let overloads: Vec<Value> = groups
            .into_iter()
            .map(|g| {
                json!({
                    "package": g.package,
                    "subprogramId": g.sub_id,
                    "returns": g.returns,
                    "args": g.args,
                })
            })
            .collect();
        Ok(json!({ "name": name, "overloads": overloads }))
    }

    fn nc_column_names(
        &self,
        conn: &Connection,
        table: &str,
    ) -> std::collections::HashMap<String, String> {
        let mut m = std::collections::HashMap::new();
        let sql = "select lower(c.name), c.displayname from md_column c \
                   where lower(c.tableid) = lower(:1) and c.displayname is not null";
        if let Ok(cur) = conn.query(sql, &[&table as &dyn ToDbValue]) {
            for row in cur {
                let Ok(row) = row else { continue };
                let k: Option<String> = row.get(0).ok().flatten();
                let v: Option<String> = row.get(1).ok().flatten();
                if let (Some(k), Some(v)) = (k, v) {
                    m.insert(k, v);
                }
            }
        }
        m
    }

    fn pk_columns(
        &self,
        conn: &Connection,
        table: &str,
        owner: Option<&str>,
    ) -> Result<Vec<String>, BridgeError> {
        const BASE: &str = "select cc.column_name from all_constraints c \
                   join all_cons_columns cc on cc.owner = c.owner and cc.constraint_name = c.constraint_name \
                   where c.table_name = :1 and c.constraint_type = 'P'";
        let cur = match owner {
            Some(o) => conn.query(
                &format!("{BASE} and c.owner = :2 order by cc.position"),
                &[&table as &dyn ToDbValue, &o as &dyn ToDbValue],
            ),
            None => conn.query(
                &format!(
                    "{BASE} and c.owner = sys_context('userenv','current_schema') order by cc.position"
                ),
                &[&table as &dyn ToDbValue],
            ),
        }
        .map_err(drv_err)?;
        let mut out = Vec::new();
        for row in cur {
            let row = row.map_err(drv_err)?;
            if let Ok(Some(v)) = row.get::<Option<String>>(0) {
                out.push(v);
            }
        }
        Ok(out)
    }

    fn indexes(&self, table: &str) -> Result<Value, BridgeError> {
        let conn = self.conn_ref()?;
        let t = table.to_uppercase();
        // `all_ind_columns` 没有 `owner` 列，只认 `index_owner`（写 `ic.owner`
        // 会让每一张表的「索引」页签都报 ORA-00904）。
        let sql = "select i.index_name, i.uniqueness, i.status, ic.column_name \
                   from all_indexes i join all_ind_columns ic \
                   on ic.index_owner = i.owner and ic.index_name = i.index_name \
                   where i.owner = sys_context('userenv','current_schema') \
                   and i.table_name = :1 order by i.index_name, ic.column_position";
        let cur = conn.query(sql, &[&t as &dyn ToDbValue]).map_err(drv_err)?;
        let mut order: Vec<String> = Vec::new();
        let mut idx: std::collections::HashMap<String, (String, String, Vec<String>)> =
            std::collections::HashMap::new();
        for row in cur {
            let row = row.map_err(drv_err)?;
            let name: String = row
                .get::<Option<String>>(0)
                .ok()
                .flatten()
                .unwrap_or_default();
            let uniq: String = row
                .get::<Option<String>>(1)
                .ok()
                .flatten()
                .unwrap_or_default();
            let status: String = row
                .get::<Option<String>>(2)
                .ok()
                .flatten()
                .unwrap_or_default();
            let col: String = row
                .get::<Option<String>>(3)
                .ok()
                .flatten()
                .unwrap_or_default();
            match idx.get_mut(&name) {
                Some(v) => v.2.push(col),
                None => {
                    order.push(name.clone());
                    idx.insert(name, (uniq, status, vec![col]));
                }
            }
        }
        let list: Vec<Value> = order
            .into_iter()
            .filter_map(|name| {
                let (uniq, status, cols) = idx.remove(&name)?;
                Some(json!({
                    "name": name,
                    "unique": uniq == "UNIQUE",
                    "status": status,
                    "columns": cols.join(", "),
                }))
            })
            .collect();
        Ok(json!({ "indexes": list }))
    }

    /// DDL。`otype` 为空 = 按表处理（TABLE 失败后回落 VIEW）；非空 = 该类型对象（包/过程/
    /// 序列/同义词/触发器等，见 `OBJECT_TYPES`）。
    ///
    /// `otype` 会被拼进 SQL（`dbms_metadata.get_ddl` 的类型是字面量，绑不进去），所以
    /// **必须过白名单**：这里只认 `OBJECT_TYPES` 里那几个，其余当表处理。
    fn ddl(&self, table: &str, otype: Option<&str>) -> Result<Value, BridgeError> {
        let conn = self.conn_ref()?;
        let _ = conn.execute(
            "begin \
             dbms_metadata.set_transform_param(dbms_metadata.session_transform, 'SEGMENT_ATTRIBUTES', false); \
             dbms_metadata.set_transform_param(dbms_metadata.session_transform, 'STORAGE', false); \
             dbms_metadata.set_transform_param(dbms_metadata.session_transform, 'SQLTERMINATOR', true); \
             end;",
            &[],
        );
        let t = table.to_uppercase();
        if let Some(ty) = object_type_of(otype) {
            // 对象 DDL 没有「依赖索引」那一段；拿到什么给什么，失败就把驱动错误原样抛上去
            let sql = format!("select dbms_metadata.get_ddl('{ty}', :1) from dual");
            let text = metadata_ddl(conn, &sql, &t).map_err(sql_err)?;
            return Ok(json!({ "ddl": text.trim(), "type": ty }));
        }
        let main = metadata_ddl(
            conn,
            "select dbms_metadata.get_ddl('TABLE', :1) from dual",
            &t,
        )
        .or_else(|_| {
            metadata_ddl(
                conn,
                "select dbms_metadata.get_ddl('VIEW', :1) from dual",
                &t,
            )
        })
        .map_err(sql_err)?;
        let idx = metadata_ddl(
            conn,
            "select dbms_metadata.get_dependent_ddl('INDEX', :1) from dual",
            &t,
        )
        .unwrap_or_default();
        let text = format!("{}\n\n{}", main.trim(), idx.trim());
        Ok(json!({ "ddl": text.trim() }))
    }

    /// 非表对象：包 / 包体 / 过程 / 函数 / 序列 / 同义词 / 触发器 / 类型。
    ///
    /// 过滤在 **owner = 当前默认 schema** 上（不是登录账号）：切了 schema 之后对象树跟着换，
    /// 与「不带前缀能解析到的对象」一致。用 `all_objects` 而不是 `user_objects`——
    /// `user_objects` 永远只含登录账号自己的对象，切过去就是空的。
    /// `generated = 'N'` 排掉系统生成的（回收站对象、LOB 索引之类）。
    fn objects(&self) -> Result<Value, BridgeError> {
        let conn = self.conn_ref()?;
        let sql = "select object_name, object_type, status, to_char(created, 'YYYY-MM-DD') \
                   from all_objects \
                   where owner = sys_context('userenv','current_schema') \
                     and object_type in ('PACKAGE','PACKAGE BODY','PROCEDURE','FUNCTION', \
                        'SEQUENCE','SYNONYM','TRIGGER','TYPE','TYPE BODY') \
                     and generated = 'N' \
                   order by object_type, object_name";
        let cur = conn.query(sql, &[]).map_err(drv_err)?;
        let mut list = Vec::new();
        for row in cur {
            let row = row.map_err(drv_err)?;
            list.push(json!({
                "name": row.get::<Option<String>>(0).ok().flatten().unwrap_or_default(),
                "type": row.get::<Option<String>>(1).ok().flatten().unwrap_or_default(),
                "status": row.get::<Option<String>>(2).ok().flatten().unwrap_or_default(),
                "created": row.get::<Option<String>>(3).ok().flatten(),
            }));
        }
        let n = list.len();
        Ok(json!({ "objects": list, "count": n }))
    }

    /// 库内源码（`all_source`，按当前默认 schema 过滤）。序列、同义词这类没有源码的对象
    /// 返回空 `lines`。
    ///
    /// `order by type, line`：字典序里 `PACKAGE` 排在 `PACKAGE BODY` 之前，
    /// 正好是「规范在前、实现在后」的阅读顺序（`TYPE` / `TYPE BODY` 同理）。
    fn source(&self, name: &str) -> Result<Value, BridgeError> {
        let conn = self.conn_ref()?;
        let n = name.to_uppercase();
        let sql = "select type, line, text from all_source \
                   where owner = sys_context('userenv','current_schema') and name = :1 \
                   order by type, line";
        let cur = conn.query(sql, &[&n as &dyn ToDbValue]).map_err(drv_err)?;
        let mut lines = Vec::new();
        let mut text = String::new();
        for row in cur {
            let row = row.map_err(drv_err)?;
            let ty: String = row
                .get::<Option<String>>(0)
                .ok()
                .flatten()
                .unwrap_or_default();
            let line: i64 = row.get::<Option<i64>>(1).ok().flatten().unwrap_or(0);
            let t: String = row
                .get::<Option<String>>(2)
                .ok()
                .flatten()
                .unwrap_or_default();
            text.push_str(&t);
            lines.push(json!({ "type": ty, "line": line, "text": t }));
        }
        let count = lines.len();
        Ok(json!({ "name": n, "lines": lines, "text": text, "count": count }))
    }

    /// 执行计划：`EXPLAIN PLAN` 只解析不执行。PLAN_TABLE 在 11g 是会话级临时表，
    /// 用完删掉自己那几行，不影响当前事务里的其它改动。
    fn explain(&self, raw: &str) -> Result<Value, BridgeError> {
        let conn = self.conn_ref()?;
        let mark = format!("NCF{}", now_ms() % 100_000_000);
        let stmt = format!(
            "explain plan set statement_id = '{}' for {}",
            mark,
            normalize(raw)
        );
        conn.execute(&stmt, &[]).map_err(drv_err)?;
        let sql = "select level - 1, operation || nvl2(options, ' ' || options, ''), object_name, \
                   access_predicates, filter_predicates, cost, cardinality from plan_table \
                   start with id = 0 and statement_id = :1 \
                   connect by prior id = parent_id and statement_id = :1 order siblings by position";
        let cur = conn
            // `:1` 在 SQL 里出现两次，就得绑两次：JDBC 的 `?` 是「一个占位符一个值」，
            // 这个驱动则是「一个出现位置一个值」，少给会报 positional bind 数量不符。
            .query(sql, &[&mark as &dyn ToDbValue, &mark as &dyn ToDbValue])
            .map_err(drv_err)?;
        let mut plan = Vec::new();
        for row in cur {
            let row = row.map_err(drv_err)?;
            let depth: i64 = row.get::<Option<i64>>(0).ok().flatten().unwrap_or(0);
            // NUMBER 列在这套驱动里取出来是字符串；前端 `PlanRow.cost/rows` 是数字
            // （JVM 桥那边 `rs.getLong` 直接给数字）。这里转成数字再给，否则成本条
            // 在纯 Rust 引擎下画不出来——`Math.max(1, ...)` 遇上字符串会变成 NaN。
            let num = |i: usize| -> Option<f64> {
                row.get::<Option<String>>(i)
                    .ok()
                    .flatten()
                    .and_then(|s| s.trim().parse::<f64>().ok())
            };
            plan.push(json!({
                "depth": depth,
                "operation": row.get::<Option<String>>(1).ok().flatten().unwrap_or_default(),
                "object": row.get::<Option<String>>(2).ok().flatten().unwrap_or_default(),
                "access": row.get::<Option<String>>(3).ok().flatten().unwrap_or_default(),
                "filter": row.get::<Option<String>>(4).ok().flatten().unwrap_or_default(),
                "cost": num(5),
                "rows": num(6),
            }));
        }
        let _ = conn.execute(
            "delete from plan_table where statement_id = :1",
            &[&mark as &dyn ToDbValue],
        );
        Ok(json!({ "plan": plan }))
    }

    /// 会话与锁：谁在跑、谁在等、谁锁了哪张表。**只读**，不生成也不执行 kill。
    ///
    /// 权限边界（这是这个功能最容易骗人的地方）：
    /// - `v$session` 普通账号可读，但只看到有权限的部分列；
    /// - `v$locked_object` 多数客户库只给 DBA —— 读不到时返回 `granted:false`，
    ///   前端显示黄条与授权语句，**不能当成「没有锁」**（那是把事故说成正常）；
    /// - `v$sql` 同理，取不到就只给 `sqlId`，不给空 SQL 文本。
    ///
    /// JSON 形状与 JVM 桥严格一致（见 `db-bridge/NcDbBridge.java` 的 `sessions()`）：
    /// 形状不一致会变成「用 Rust 引擎时面板空白」这种只在个别人机器上复现的 bug。
    fn sessions(&self) -> Result<Value, BridgeError> {
        let conn = self.conn_ref()?;
        // 只取「正在跑」与「被阻塞」的会话：全量 v$session 在共用库上有几百行，界面没法看
        let sql = "select s.sid, s.serial#, s.username, s.machine, s.program, s.status, \
                          s.blocking_session, s.event, s.wait_class, s.seconds_in_wait, \
                          s.last_call_et, s.sql_id \
                     from v$session s \
                    where s.type = 'USER' \
                      and (s.status = 'ACTIVE' or s.blocking_session is not null) \
                    order by nvl(s.blocking_session, s.sid), s.sid";
        let cur = conn.query(sql, &[]).map_err(drv_err)?;
        let mut rows: Vec<Value> = Vec::new();
        for row in cur {
            let row = row.map_err(drv_err)?;
            // 字段逐个 `.ok().flatten()`：这些列在低权限账号下可能直接报「标识符无效」，
            // 不能因为一列读不到就让整个面板空掉
            rows.push(json!({
                "sid": row.get::<Option<i64>>(0).ok().flatten().unwrap_or(-1),
                "serial": row.get::<Option<i64>>(1).ok().flatten(),
                "user": row.get::<Option<String>>(2).ok().flatten().unwrap_or_default(),
                "machine": row.get::<Option<String>>(3).ok().flatten().unwrap_or_default(),
                "program": row.get::<Option<String>>(4).ok().flatten().unwrap_or_default(),
                "status": row.get::<Option<String>>(5).ok().flatten().unwrap_or_default(),
                "blocker": row.get::<Option<i64>>(6).ok().flatten(),
                "event": row.get::<Option<String>>(7).ok().flatten().unwrap_or_default(),
                "waitClass": row.get::<Option<String>>(8).ok().flatten().unwrap_or_default(),
                "waitSec": row.get::<Option<i64>>(9).ok().flatten().unwrap_or(0),
                "elapsedSec": row.get::<Option<i64>>(10).ok().flatten().unwrap_or(0),
                "sqlId": row.get::<Option<String>>(11).ok().flatten().unwrap_or_default(),
                "locked": Vec::<String>::new(),
                "sql": String::new(),
            }));
        }

        // 锁：读不到权限就记 granted=false，绝不返回「空锁列表」冒充「没有锁」
        let mut granted = true;
        let mut locks: Vec<(i64, Vec<String>)> = Vec::new();
        match conn.query(
            "select l.session_id, o.owner, o.object_name, o.object_type, l.locked_mode \
               from v$locked_object l join all_objects o on o.object_id = l.object_id",
            &[],
        ) {
            Ok(cur) => {
                for row in cur {
                    let Ok(row) = row else {
                        granted = false;
                        break;
                    };
                    let sid = row.get::<Option<i64>>(0).ok().flatten().unwrap_or(-1);
                    let owner = row
                        .get::<Option<String>>(1)
                        .ok()
                        .flatten()
                        .unwrap_or_default();
                    let obj = row
                        .get::<Option<String>>(2)
                        .ok()
                        .flatten()
                        .unwrap_or_default();
                    let kind = row
                        .get::<Option<String>>(3)
                        .ok()
                        .flatten()
                        .unwrap_or_default();
                    let mode = row.get::<Option<i64>>(4).ok().flatten().unwrap_or(0);
                    let text = format!("{owner}.{obj}({kind},L{mode})");
                    match locks.iter_mut().find(|(s, _)| *s == sid) {
                        Some((_, v)) => v.push(text),
                        None => locks.push((sid, vec![text])),
                    }
                }
            }
            Err(_) => granted = false,
        }

        // SQL 文本：v$sql 在低权限账号下常常只返回自己的语句，读不到就留空（前端只显示 sqlId）
        let mut texts: Vec<(String, String)> = Vec::new();
        if let Ok(cur) = conn.query(
            "select sql_id, sql_text from v$sql where sql_id is not null and rownum <= 500",
            &[],
        ) {
            for row in cur {
                let Ok(row) = row else { break };
                let id = row
                    .get::<Option<String>>(0)
                    .ok()
                    .flatten()
                    .unwrap_or_default();
                let text = row
                    .get::<Option<String>>(1)
                    .ok()
                    .flatten()
                    .unwrap_or_default();
                if !id.is_empty() {
                    // 长 SQL 截断：面板只用来认「是哪条」，完整语句点开再复制
                    let short: String = text.chars().take(300).collect();
                    texts.push((id, short));
                }
            }
        }

        for row in rows.iter_mut() {
            let sid = row["sid"].as_i64().unwrap_or(-1);
            if let Some((_, objs)) = locks.iter().find(|(s, _)| *s == sid) {
                row["locked"] = json!(objs);
            }
            let id = row["sqlId"].as_str().unwrap_or_default();
            if !id.is_empty() {
                if let Some((_, text)) = texts.iter().find(|(k, _)| k == id) {
                    row["sql"] = json!(text);
                }
            }
        }

        Ok(json!({ "rows": rows, "granted": granted }))
    }

    /// 批量导出表结构（工作台缓存到本地，出包前核对字段与补全用）。
    ///
    /// JVM 桥走 JDBC 的 `DatabaseMetaData.getColumns`，这里直接查 `user_tab_columns`——
    /// 字段与语义对齐（`TYPE_NAME` 对应 `data_type`，`COLUMN_SIZE` 对字符类型取
    /// `char_length`、数字取 `data_precision`）。
    fn schema_batch(&self, sql: &str) -> Result<Value, BridgeError> {
        // Metadata has its own local cursor: do not replace the user's active SQL cursor.
        let cur = self.conn_ref()?.query(sql, &[]).map_err(drv_err)?;
        let mut rows = Vec::new();
        for row in cur.take(1000) {
            let row = row.map_err(drv_err)?;
            rows.push(json!([
                row.get::<Option<String>>(0).map_err(drv_err)?,
                row.get::<Option<String>>(1).map_err(drv_err)?,
                row.get::<Option<String>>(2).map_err(drv_err)?,
                row.get::<Option<i64>>(3).map_err(drv_err)?,
            ]));
        }
        Ok(json!({"rows": rows}))
    }

    fn schema(&self, offset: usize, limit: usize) -> Result<Value, BridgeError> {
        let conn = self.conn_ref()?;
        // 别名只能用 `sz`：`SIZE` 在 19c 是保留字，`as size` 直接 ORA-00923
        let sql = "select table_name, column_name, data_type, \
                   nvl(char_length, nvl(data_precision, 0)) as sz, nullable \
                   from user_tab_columns order by table_name, column_id";
        let cur = conn.query(sql, &[]).map_err(drv_err)?;
        let mut rows = Vec::new();
        let mut skipped = 0usize;
        for row in cur {
            let row = row.map_err(drv_err)?;
            if skipped < offset {
                skipped += 1;
                continue;
            }
            if rows.len() >= limit {
                break;
            }
            rows.push(json!({
                "table": row.get::<Option<String>>(0).ok().flatten().unwrap_or_default(),
                "column": row.get::<Option<String>>(1).ok().flatten().unwrap_or_default(),
                "type": row.get::<Option<String>>(2).ok().flatten().unwrap_or_default(),
                "size": row.get::<Option<i64>>(3).ok().flatten().unwrap_or(0),
                "nullable": row.get::<Option<String>>(4).ok().flatten().unwrap_or_default() == "Y",
            }));
        }
        let n = rows.len();
        Ok(json!({
            "rows": rows,
            "count": n,
            "nextOffset": offset + n,
        }))
    }
}

// ───────────────────────── Autotrace 统计（A2） ─────────────────────────

/// `v$mystat` 里我们关心的四项。**名字必须与 JVM 桥逐字一致**，否则两个引擎算出来的
/// 数字口径不同，同一条 SQL 换引擎会给出两种「逻辑读」。
const STAT_NAMES: &str = "'db block gets','consistent gets','physical reads','execute count'";

/// 某一时刻的会话累计统计。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct StatSnap {
    db_block_gets: i64,
    consistent_gets: i64,
    physical_reads: i64,
    execute_count: i64,
}

impl StatSnap {
    /// 与执行前快照的差值 → 给前端的 JSON。四项各自夹到非负：
    /// 会话统计理论上单调递增，但 `ALTER SESSION` / 重新连接会让基线归零。
    fn since(&self, before: &StatSnap) -> Value {
        let d = |a: i64, b: i64| (a - b).max(0);
        let block_gets = d(self.db_block_gets, before.db_block_gets);
        let consistent = d(self.consistent_gets, before.consistent_gets);
        json!({
            "dbBlockGets": block_gets,
            "consistentGets": consistent,
            "logicalReads": block_gets + consistent,
            "physicalReads": d(self.physical_reads, before.physical_reads),
            "executeCount": d(self.execute_count, before.execute_count),
        })
    }
}

/// 读一次会话统计。**读不到就返回 `None`**（无 `V_$MYSTAT` 授权、或结果里一项都没有）。
///
/// 可用时每次执行多两次往返，实际成本取决于网络延迟。差值里**包含**这两次统计查询自己的开销
/// （约十几次逻辑读），与 PL/SQL Developer 的 autotrace 同口径，不额外剔除。
fn stat_snapshot(conn: &Connection) -> Result<StatSnap, BridgeError> {
    let sql = format!(
        "select n.name, m.value from v$mystat m, v$statname n \
          where n.statistic# = m.statistic# and n.name in ({STAT_NAMES})"
    );
    let cur = conn.query(&sql, &[]).map_err(drv_err)?;
    let mut s = StatSnap::default();
    let mut found = 0usize;
    for row in cur {
        let row = row.map_err(drv_err)?;
        let name: String = row
            .get::<Option<String>>(0)
            .map_err(drv_err)?
            .unwrap_or_default();
        let v: i64 = row.get::<Option<i64>>(1).map_err(drv_err)?.unwrap_or(0);
        match name.trim().to_ascii_lowercase().as_str() {
            "db block gets" => {
                s.db_block_gets = v;
                found += 1;
            }
            "consistent gets" => {
                s.consistent_gets = v;
                found += 1;
            }
            "physical reads" => {
                s.physical_reads = v;
                found += 1;
            }
            "execute count" => {
                s.execute_count = v;
                found += 1;
            }
            _ => {}
        }
    }
    if found == 0 {
        // 一条统计都没匹配上：不是网络问题，是这个库/账号看不到这几项（授权或版本差异），
        // 再试也是空，交给调用方按「永久读不到」处理。
        return Err(BridgeError::new("stats", "读不到执行统计"));
    }
    Ok(s)
}

/// 统计快照的失败是不是「这个账号永远读不到」。
///
/// 只有权限类错误和「一条都没匹配」算永久：其余（超时、连接抖动、字典视图被锁）
/// 都该下次再试，否则一次抖动就把 Autotrace 永久关掉。
fn is_permanent_stat_error(e: &BridgeError) -> bool {
    e.code == "stats" || e.message.contains("ORA-00942") || e.message.contains("ORA-01031")
}

// ───────────────────────── 结果集转换 ─────────────────────────

/// 从游标取最多 `max_rows` 行。返回（行, 是否可能还有）。
///
/// 取满就停、不预读下一行：Oracle 游标不能回退，预读会把一行吞掉（JVM 桥踩过这个坑）。
/// 把 `dbms_sql.return_result` 交回来的每个结果集取成 JSON（顺序与 `return_result` 一致）。
///
/// **不接「加载更多」**：一个 PL/SQL 执行可能返回多个隐式结果，当前协议没有为这些内部
/// 结果分别分配 resultId。因此每个结果集一次取
/// `max_rows` 行，取满就给 `hasMore: true`（前端提示调大「每次取」再执行），然后让游标
/// 随 `Cursor` 一起 drop —— `Statement::new` 的 `return_on_drop` 会把它还给客户端，
/// 否则会话游标会一路漏到 `open_cursors` 上限（探针 R11 验过）。
fn implicit_sets(
    res: &mut ExecResult,
    max_rows: usize,
    full_lob: bool,
) -> Result<Vec<Value>, BridgeError> {
    let mut sets = Vec::new();
    for mut cur in res.implicit_resultsets() {
        let columns: Vec<Value> = cur.columns().iter().map(column_json).collect();
        let types: Vec<String> = cur
            .columns()
            .iter()
            .map(|m| base_type(&type_label(m)))
            .collect();
        let (rows, has_more) = page(&mut cur, &types, max_rows, full_lob)?;
        let count = rows.len();
        sets.push(json!({
            "columns": columns,
            "rows": rows,
            "rowCount": count,
            "hasMore": has_more,
        }));
    }
    Ok(sets)
}

fn page(
    cur: &mut Cursor,
    types: &[String],
    max_rows: usize,
    full_lob: bool,
) -> Result<(Vec<Value>, bool), BridgeError> {
    let mut rows = Vec::with_capacity(max_rows.min(64));
    for _ in 0..max_rows {
        match cur.next() {
            Some(Ok(row)) => rows.push(row_json(&row, types, full_lob)),
            Some(Err(e)) => return Err(drv_err(e)),
            // 取不满 = 确实没有更多了
            None => return Ok((rows, false)),
        }
    }
    // 刚好取满：可能还有，也可能正好取完——留给下一次 more 判定（不预读，预读会吞掉一行）
    Ok((rows, true))
}

fn row_json(row: &Row, types: &[String], full_lob: bool) -> Value {
    let mut out = Vec::with_capacity(types.len());
    for (i, ty) in types.iter().enumerate() {
        out.push(cell_json(row, i, ty, full_lob));
    }
    Value::Array(out)
}

/// 一列 → JSON。约定与 JVM 桥的 `value()` 逐条对齐（日期格式、大数字保精度、CLOB 截断…）。
fn cell_json(row: &Row, i: usize, base: &str, full_lob: bool) -> Value {
    if base.starts_with("DATE") || base.starts_with("TIMESTAMP") {
        let with_frac = base.starts_with("TIMESTAMP");
        if let Ok(Some(ts)) = row.get::<Option<oracledb::OracleTimestamp>>(i) {
            return json!(fmt_timestamp(&ts, with_frac));
        }
        // `TIMESTAMP WITH TIME ZONE` / `WITH LOCAL TIME ZONE` 驱动不给 `OracleTimestamp`，
        // 也可能给了个字符串。退一步用字符串 —— 绝不把「取不出来」降级成 NULL，
        // 那会让网格、详情、导出、排序全把真实值当成空值（对照下面 BLOB 分支的同一条原则）。
        if let Ok(Some(s)) = row.get::<Option<String>>(i) {
            return json!(s);
        }
        return json!("<TIMESTAMP 取值失败：驱动未返回可识别的值>");
    }
    if base == "BLOB" {
        // 只为了显示「多少字节」就用 `Vec<u8>` 会把整个 BLOB 读进内存：
        // NC 附件表一次 select * 就是 500 行 × 几十 MB，主进程直接 OOM 被杀。
        if let Ok(Some(mut lob)) = row.get::<Option<Lob>>(i) {
            return match lob.get_size() {
                Ok(n) => json!(format!("<BLOB {n}B>")),
                Err(e) => json!(format!("<BLOB 取值失败：{e}>")),
            };
        }
        return match row.get::<Option<Vec<u8>>>(i) {
            Ok(Some(b)) => json!(format!("<BLOB {}B>", b.len())),
            Ok(None) => Value::Null,
            // 不能落回下面的字符串分支：那里的 `None` 会被当成 NULL，
            // 而「取不出来」显示成「NULL，数据库空值」是最误导的一种失败。
            Err(e) => json!(format!("<BLOB 取值失败：{e}>")),
        };
    }
    if base == "RAW" || base == "LONG RAW" {
        return match row.get::<Option<Vec<u8>>>(i) {
            Ok(Some(b)) => json!(hex(&b, 64)),
            Ok(None) => Value::Null,
            Err(e) => json!(format!("<RAW 取值失败：{e}>")),
        };
    }
    if base == "CLOB" || base == "NCLOB" || base == "LONG" {
        return clob_json(row, i, full_lob);
    }
    // BINARY_FLOAT / BINARY_DOUBLE 在 JDBC 那边是 Float/Double，JVM 桥给的是 JSON 数字。
    // 这两个类型没有精度可丢，按数字给才对得上。
    if base == "BINARY_DOUBLE" {
        if let Ok(Some(v)) = row.get::<Option<f64>>(i) {
            return json!(v);
        }
    }
    if base == "BINARY_FLOAT" {
        if let Ok(Some(v)) = row.get::<Option<f32>>(i) {
            return json!(v);
        }
    }
    // 其余一律按字符串取。**NUMBER 也给字符串**：JDBC 那边取出来是 BigDecimal，
    // JVM 桥一律 `toPlainString()` 给字符串（金额/单据号转 double 会掉精度），
    // 这里必须跟着一致，否则同一条 SQL 换个引擎就显示成两种样子。
    let Ok(v) = row.get::<Option<String>>(i) else {
        // 取不出来（对象类型、数组之类）：不报错，给个占位，别让整行都失败
        return json!("<不支持的类型>");
    };
    match v {
        None => Value::Null,
        Some(s) => json!(s),
    }
}

/// CLOB / NCLOB / LONG 一列 → JSON。
///
/// `full_lob` = 导出 / 搬运专用的全量通道：给到 `CLOB_MAX` 个字符（不是网格的 8K 预览）。
/// 超过 `CLOB_MAX` 仍会截断，但**必须**带上能被 [`is_lob_preview`] 认出的尾部文案，
/// 否则导出会把「正文 + 半句话」当完整值写进文件，而「部分结果」告警也不会亮。
///
/// 取值顺序：`Lob` → `String`（驱动对某些 LONG 列会直接给字符串）。
/// 两条路都 `None` 才是真 NULL；任一条**报错**、另一条也拿不到时给显式占位，
/// 绝不把「取不出来」降级成 NULL —— 那会让网格和详情面板都显示「数据库空值」，
/// 是 CLOB 明明有内容却看起来是空的最误导的一种失败。
fn clob_json(row: &Row, i: usize, full_lob: bool) -> Value {
    let limit = if full_lob { CLOB_MAX } else { LOB_PREVIEW };
    let mut saw_null = false;
    match row.get::<Option<Lob>>(i) {
        Ok(Some(mut lob)) => {
            let size = lob.get_size().unwrap_or(0);
            // 字符 LOB 的 amount 是 UCS-2 单位，一个字符最多编成 4 字节 UTF-8：
            // 按 4 倍字节数取，保证够 `LOB_PREVIEW` 个字符；多出来的按字符裁掉。
            let cap = (limit as u64).saturating_mul(4);
            let mut raw = Vec::new();
            if let Err(e) = (&mut lob).take(cap).read_to_end(&mut raw) {
                return json!(format!("<CLOB 读取失败：{e}>"));
            }
            let text = String::from_utf8_lossy(&raw);
            // 读满自建的字节上限、而 LOB 还有剩余 ⇒ 确实被切了，此时**字符总数未知**
            // （`get_size` 给的是字节数，中文 3 字节/字，拿它当字符数会多报 3 倍）。
            // 没读满 = 全文都在手里，字符数就是准的。
            let cut = raw.len() as u64 >= cap && size > raw.len();
            if full_lob {
                return json!(full_lob_text(&text, cut));
            }
            let total = if cut {
                None
            } else {
                Some(text.chars().count())
            };
            return json!(preview_text(&text, total));
        }
        Ok(None) => saw_null = true,
        Err(_) => {}
    }
    match row.get::<Option<String>>(i) {
        Ok(Some(s)) => {
            if full_lob {
                return json!(full_lob_text(&s, s.chars().count() > CLOB_MAX));
            }
            let total = Some(s.chars().count());
            return json!(preview_text(&s, total));
        }
        Ok(None) => saw_null = true,
        Err(_) => {}
    }
    if saw_null {
        Value::Null
    } else {
        json!("<CLOB 取值失败：驱动既没返回 Lob 也没返回字符串>")
    }
}

/// 全量通道的文本：最多 `CLOB_MAX` 个字符，超限就挂上可识别的截断标记。
///
/// 文案里必须有「个字符，只取前 1M」——导出侧 `is_lob_preview` 靠它把文件标成
/// 「部分结果」，也和 JVM 桥 `clobText(c, CLOB_MAX)` 的措辞一致。
fn full_lob_text(text: &str, cut: bool) -> String {
    let mut out: String = text.chars().take(CLOB_MAX).collect();
    if cut || text.chars().count() > CLOB_MAX {
        out.push_str(" …（共 1M+ 个字符，只取前 1M）");
    }
    out
}

/// 预览文本：超过 `LOB_PREVIEW` 个字符就截断，并在尾部标明总数与下一步。
///
/// `total` 是**字符**总数：`None` = 只读到字节上限、字符数无法确定（中文 3 字节/字，
/// 拿字节数当字符数会多报几倍，而且会让「本来没截断」的值也被贴上截断标记 ——
/// 那句中文提示是**值的一部分**，导出/复制会把它一起带走）。
///
/// 🔴 尾部文案是前端判断「要不要显示『加载完整值』」的依据
/// （`lib/db.ts::isLobPreview`），改这里必须同步改那边。
fn preview_text(text: &str, total: Option<usize>) -> String {
    let mut out: String = text.chars().take(LOB_PREVIEW).collect();
    match total {
        // 字符数已知：只有真的超了才加提示
        Some(n) if n <= LOB_PREVIEW => {}
        _ => {
            // 未知时写「8192+」：前端 `lobPreviewChars` 解析不出数字会退回 null，
            // 界面上就不显示具体总数，好过显示一个错的。
            let n = total.map_or_else(|| format!("{LOB_PREVIEW}+"), |n| n.to_string());
            out.push_str(&format!(
                " …（共 {n} 个字符，只显示前 {LOB_PREVIEW}，点「加载完整值」查看）"
            ));
        }
    }
    out
}

/// 这个值是不是「被截断的 LOB」（网格的 8K 预览，或全量通道的 1M 上限）。
///
/// 判据只能看文案标记：拿长度比 `LOB_PREVIEW` 会把「刚好 8192 字符的正常值」误判，
/// 拿 1MB 比则永远判不出来（8K 预览够不到 1MB），后者会让导出的脚本里出现
/// 「正文 + 一句中文提示」而零告警。两种截断的尾部措辞都由这里统一认。
pub(crate) fn is_lob_preview(s: &str) -> bool {
    s.contains("个字符，只显示前") || s.contains("个字符，只取前 1M")
}

fn fmt_timestamp(ts: &oracledb::OracleTimestamp, with_frac: bool) -> String {
    let mut s = format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        ts.year(),
        ts.month(),
        ts.day(),
        ts.hour(),
        ts.minute(),
        ts.second()
    );
    let ns = ts.nanoseconds();
    if with_frac && ns != 0 {
        let frac = format!("{ns:09}");
        s.push('.');
        s.push_str(frac.trim_end_matches('0'));
    }
    s
}

/// 列名 → 安全的双引号标识符。
///
/// 列名来自数据库元数据或查询别名，但这里仍当不可信输入处理：一律加双引号并转义
/// 内部引号（引号内部无法再逃逸出 SQL 结构），只额外限制长度。
fn quote_ident(name: &str) -> Result<String, BridgeError> {
    let t = name.trim();
    if t.is_empty() || t.chars().count() > 128 {
        return Err(sql_err("列名不合法，无法定位大文本"));
    }
    Ok(format!("\"{}\"", t.replace('"', "\"\"")))
}

/// 「按需取一格大文本」的探测 SQL：外层给子查询编号，只取第 N+1 行的目标列。
///
/// 抽成函数是为了能单测：列名转义与行号 off-by-one 是这里最容易错的两处。
fn lob_probe_sql(sql: &str, column: &str, row_index: usize) -> Result<String, BridgeError> {
    let ident = quote_ident(column)?;
    Ok(format!(
        "select {ident} as \"__nc_lob\" from \
         (select t.*, rownum as \"__ncforge_rn\" from ({sql}) t) \
         where \"__ncforge_rn\" = {}",
        row_index.saturating_add(1)
    ))
}

/// 取一格大文本的完整值。`probe` 由调用方拼好（外层编号后取第 N 行）。
fn lob_value_with(
    conn: &Connection,
    probe: &str,
    row_index: usize,
    max_chars: usize,
) -> Result<Value, BridgeError> {
    let t0 = Instant::now();
    let mut cur = conn.query(probe, &[]).map_err(drv_err)?;
    let Some(row) = cur.next().transpose().map_err(drv_err)? else {
        return Err(sql_err(format!(
            "第 {} 行已经不存在（结果可能已变化，请重新执行查询）",
            row_index + 1
        )));
    };
    let base = base_type(&type_label(&cur.columns()[0]));
    let text = match base.as_str() {
        "CLOB" | "NCLOB" | "LONG" => clob_full_at(&row, 0, max_chars)?,
        _ => row
            .get::<Option<String>>(0)
            .map_err(drv_err)?
            .unwrap_or_default(),
    };
    let chars = text.chars().count();
    Ok(json!({
        "value": text,
        "chars": chars,
        "truncated": chars >= max_chars,
        "ms": t0.elapsed().as_millis() as u64,
    }))
}

/// 完整读一格 CLOB（最多 `max_chars` 个字符）。取不到时返回空串由调用方呈现，
/// 「驱动报错」则显式失败——这两件事不能混。
fn clob_full_at(row: &Row, i: usize, max_chars: usize) -> Result<String, BridgeError> {
    let mut saw_null = false;
    match row.get::<Option<Lob>>(i) {
        Ok(Some(mut lob)) => {
            let mut raw = Vec::new();
            (&mut lob)
                .take((max_chars as u64).saturating_mul(4))
                .read_to_end(&mut raw)
                .map_err(|e| sql_err(format!("读 CLOB 失败：{e}")))?;
            return Ok(String::from_utf8_lossy(&raw)
                .chars()
                .take(max_chars)
                .collect());
        }
        Ok(None) => saw_null = true,
        Err(_) => {}
    }
    match row.get::<Option<String>>(i) {
        Ok(Some(s)) => return Ok(s.chars().take(max_chars).collect()),
        Ok(None) => saw_null = true,
        Err(_) => {}
    }
    if saw_null {
        Ok(String::new())
    } else {
        Err(sql_err("CLOB 取值失败：驱动既没返回 Lob 也没返回字符串"))
    }
}

fn hex(b: &[u8], max: usize) -> String {
    let mut s = String::new();
    for x in b.iter().take(max) {
        s.push_str(&format!("{x:02X}"));
    }
    if b.len() > max {
        s.push('…');
    }
    s
}

/// 列的类型名。与 JVM 桥的 `typeName()` 一致：字符类型带长度、NUMBER 带精度。
fn type_label(m: &Metadata) -> String {
    let t = m.data_type();
    let base = base_type(&t);
    // 驱动把 CLOB 列描述成 LONG（`select 一个 CLOB 列` 实测定），而 JDBC 那边报的是 CLOB。
    // 列头显示的类型名要对齐，何况 NC 的 19c 库里基本没有真正的 LONG 列。
    if base == "LONG" {
        return "CLOB".to_string();
    }
    let size = m.max_size();
    match base.as_str() {
        "VARCHAR2" | "CHAR" | "NVARCHAR2" | "NCHAR" if size > 0 => format!("{base}({size})"),
        "NUMBER" if m.precision() > 0 => {
            if m.scale() > 0 {
                format!("NUMBER({},{})", m.precision(), m.scale())
            } else {
                format!("NUMBER({})", m.precision())
            }
        }
        _ => base,
    }
}

/// `VARCHAR2(20)` → `VARCHAR2`。
fn base_type(t: &str) -> String {
    let t = t.trim();
    match t.find('(') {
        Some(i) => t[..i].trim().to_uppercase(),
        None => t.to_uppercase(),
    }
}

/// 元数据入参 `schema.table` → (owner, table)，都转大写。
///
/// 不带 schema 时 owner 为 `None`，调用方退回连接的 `current_schema`。
/// 这一步必须做：把整串丢进 `table_name = :1` 查不到任何东西，而查询不报错、
/// 只是返回空——上层就会把「表有主键」误判成「没有主键」，直接关掉编辑。
fn split_qualified(name: &str) -> (Option<String>, String) {
    match name.trim().split_once('.') {
        Some((o, t)) if !o.is_empty() && !t.is_empty() => {
            (Some(o.trim().to_uppercase()), t.trim().to_uppercase())
        }
        _ => (None, name.trim().to_uppercase()),
    }
}

fn column_json(m: &Metadata) -> Value {
    let base = base_type(&type_label(m));
    // 字符类型（VARCHAR2 / CHAR / NCHAR…）的「精度」在 JDBC 里是 COLUMN_SIZE，
    // 驱动这边只给 max_size；NUMBER 才是真精度。两边这么对齐，列宽估算才不会一个引擎宽一个引擎窄。
    let is_char = base.starts_with("VARCHAR")
        || base.starts_with("NVARCHAR")
        || base.starts_with("CHAR")
        || base.starts_with("NCHAR");
    let precision = if is_char {
        i64::from(m.max_size())
    } else {
        i64::from(m.precision())
    };
    // 驱动的 scale 用 -127 表示「没声明」，JVM 桥给 0
    let scale = i64::from(m.scale().max(0));
    json!({
        "name": m.name(),
        "type": type_label(m),
        "precision": precision,
        "scale": scale,
    })
}

fn full_type(ty: &str, len: i64, prec: Option<i64>, scale: i64) -> String {
    if ty.is_empty() {
        return String::new();
    }
    if ty.ends_with("CHAR") || ty.ends_with("CHAR2") || ty == "RAW" {
        return if len > 0 {
            format!("{ty}({len})")
        } else {
            ty.to_string()
        };
    }
    if ty == "NUMBER" {
        if let Some(p) = prec {
            return if scale > 0 {
                format!("{ty}({p},{scale})")
            } else {
                format!("{ty}({p})")
            };
        }
    }
    ty.to_string()
}

// ───────────────────────── 语句分类（与 Java 侧同一套启发式） ─────────────────────────

/// 去掉首尾空白；非 PL/SQL 去掉末尾分号（Oracle 遇到会报 ORA-00911）。
pub fn normalize(raw: &str) -> String {
    let mut s = raw.trim().to_string();
    if let Some(rest) = s.strip_suffix('/') {
        s = rest.trim().to_string();
    }
    if !is_plsql(&leading_keywords(&s)) {
        while let Some(rest) = s.strip_suffix(';') {
            s = rest.trim().to_string();
        }
    }
    s
}

/// 去掉字符串常量与注释后的小写文本（只用于判断语句类别）。
pub fn leading_keywords(sql: &str) -> String {
    let s = strip_literals(sql).trim().to_lowercase();
    s.chars().take(200).collect()
}

/// 去掉字符串常量与注释，避免注释或字面量里的关键字被误判。
pub fn strip_literals(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let b: Vec<char> = sql.chars().collect();
    let n = b.len();
    let mut i = 0;
    while i < n {
        let c = b[i];
        if c == '\'' {
            i += 1;
            while i < n {
                if b[i] == '\'' {
                    if i + 1 < n && b[i + 1] == '\'' {
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            out.push_str("''");
            continue;
        }
        if c == '-' && i + 1 < n && b[i + 1] == '-' {
            while i < n && b[i] != '\n' {
                i += 1;
            }
            out.push(' ');
            continue;
        }
        if c == '/' && i + 1 < n && b[i + 1] == '*' {
            i += 2;
            while i + 1 < n && !(b[i] == '*' && b[i + 1] == '/') {
                i += 1;
            }
            i = (i + 2).min(n);
            out.push(' ');
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

/// `head`（已小写、已去注释）的首个词是不是候选之一。
fn starts_any(head: &str, candidates: &[&str]) -> bool {
    let first = head
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .find(|s| !s.is_empty());
    match first {
        Some(w) => candidates.contains(&w),
        None => false,
    }
}

fn is_plsql(head: &str) -> bool {
    starts_any(head, &["begin", "declare", "call", "exec", "execute"])
}

/// 校验并规范化对象类型，认不出来一律 `None`（= 按表处理）。
///
/// 为什么单独抽出来：`dbms_metadata.get_ddl` 的类型名是 SQL **字面量**、绑不进去，
/// 只能拼进语句。任何拼进 SQL 的外部字符串都必须先在白名单里查一遍——`"PACKAGE';
/// drop table x --"` 这种只要漏一次就是远端执行任意语句。返回 `&'static str` 而不是
/// `String`，让「拼进 SQL 的值只可能来自常量表」这件事在类型上成立。
fn object_type_of(raw: Option<&str>) -> Option<&'static str> {
    let want = raw?.trim().to_uppercase();
    // 索引从表的索引页单独查看，不加入对象树清单。
    if want == "INDEX" {
        return Some("INDEX");
    }
    OBJECT_TYPES.iter().copied().find(|t| *t == want)
}

fn is_ddl(head: &str) -> bool {
    starts_any(
        head,
        &[
            "create", "alter", "drop", "truncate", "rename", "comment", "grant", "revoke",
        ],
    )
}

fn is_write(head: &str) -> bool {
    starts_any(head, &["insert", "update", "delete", "merge", "replace"])
}

/// 这条语句会不会开启/延续事务。`for update` 用 `head = "lock"` 表示。
///
/// DML 之外还有三类必须算进来，否则事务条与「切只读前先提交」的守卫全部失效：
/// `select … for update`（拿着行锁）、PL/SQL 块（`begin`/`declare` 里的 DML）、
/// 存储过程调用（`call`）。
fn opens_transaction(head: &str) -> bool {
    head == "lock" || is_write(head) || starts_any(head, &["begin", "declare", "call"])
}

/// 是不是返回结果集的语句。没有 `DatabaseMetaData` 可问，只能看首个关键字。
///
/// 判错的代价不对称：把查询当更新执行会丢掉结果（用户还得重跑），把更新当查询执行会
/// 报错（会当场发现）。所以这里只认确定的查询起始词，其余一律按更新走。
fn is_query(head: &str, sql: &str) -> bool {
    if starts_any(head, &["select", "with", "table", "values"]) {
        return true;
    }
    sql.trim_start().starts_with('(')
}

fn has_for_update(sql: &str) -> bool {
    let s = strip_literals(sql).to_lowercase();
    s.contains("for update")
}

// ───────────────────────── 杂项 ─────────────────────────

fn int_arg(a: &[&str], i: usize, def: usize) -> usize {
    a.get(i)
        .and_then(|v| v.trim().parse::<usize>().ok())
        .unwrap_or(def)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn scalar_string(conn: &Connection, sql: &str) -> Option<String> {
    conn.query_row(sql, &[])
        .ok()?
        .get::<Option<String>>(0)
        .ok()
        .flatten()
}

/// 这条会话当前的默认 schema（`sys_context('userenv','current_schema')`）。
///
/// 不缓存成字段：用户完全可能自己发一句 `alter session set current_schema`，
/// 缓存就会和真实会话不一致，界面上显示的名字就成了假的。
fn current_schema_of(conn: &Connection) -> Option<String> {
    scalar_string(
        conn,
        "select sys_context('userenv','current_schema') from dual",
    )
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty())
}

/// 把会话切到 `name`，返回生效后的 schema 名。空串 = 回到登录账号自己的 schema。
///
/// **名字绑不进绑定变量**（`alter session` 的标识符位置不接受占位符），只能拼串，所以
/// 先用 [`crate::db_conns::valid_schema`] 卡字符集——这与 JVM 桥的 `SCHEMA_NAME` 是同一
/// 条规则，两侧不一致会出现「换个引擎就报错」的怪问题。
///
/// 执行后再读一次 `sys_context` 核对：Oracle 对**不存在**的 schema 不报错（它要等到
/// 下一次名字解析才抛 ORA-00942），不核对的话界面会显示一个假名字。
///
/// 事务安全：`alter session` 是会话控制语句，不隐式提交当前事务（Oracle Concepts 的
/// 隐式提交清单里没有它），所以在有未提交 update 的会话上切 schema 不会提交掉改动。
fn effective_schema(
    conn: &Connection,
    name: &str,
    login_user: &str,
) -> Result<String, BridgeError> {
    let name = name.trim();
    let target = if name.is_empty() { login_user } else { name };
    let upper = target.trim().to_ascii_uppercase();
    if !crate::db_conns::valid_schema(&upper) {
        return Err(BridgeError::new(
            "sql",
            format!(
                "schema 名不合法：{upper}（只能字母开头，其余用字母、数字、下划线，最长 128 个字符）"
            ),
        ));
    }
    conn.execute(&format!("alter session set current_schema = {upper}"), &[])
        .map_err(drv_err)?;
    let now = current_schema_of(conn).unwrap_or_else(|| upper.clone());
    if !now.eq_ignore_ascii_case(&upper) {
        return Err(BridgeError::new(
            "sql",
            format!("切换默认 schema 没生效：期望 {upper}，当前仍是 {now}"),
        ));
    }
    Ok(now)
}

/// 优先使用认证握手里已有的版本，避免每次建连额外查询系统视图。
fn db_version(conn: &Connection) -> String {
    if let Ok(version) = conn.version() {
        if version.0 > 0 {
            return version.to_string();
        }
    }
    for sql in [
        "select version_full from product_component_version where product like 'Oracle Database%' and rownum = 1",
        "select version from product_component_version where product like 'Oracle Database%' and rownum = 1",
        "select banner from v$version where rownum = 1",
    ] {
        if let Some(v) = scalar_string(conn, sql) {
            if !v.trim().is_empty() {
                return v.trim().to_string();
            }
        }
    }
    String::new()
}

/// 取 `dbms_metadata.get_ddl(...)` 的 CLOB 文本。错误统一成消息字符串——调用方只关心
/// 「TABLE 不行就试 VIEW」。
fn metadata_ddl(conn: &Connection, sql: &str, name: &str) -> Result<String, String> {
    let row = conn
        .query_row(sql, &[&name as &dyn ToDbValue])
        .map_err(|e| drv_err(e).message)?;
    if let Ok(Some(s)) = row.get::<Option<String>>(0) {
        return Ok(s);
    }
    if let Ok(Some(mut lob)) = row.get::<Option<Lob>>(0) {
        let mut buf = Vec::new();
        lob.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        return Ok(String::from_utf8_lossy(&buf).to_string());
    }
    Ok(String::new())
}

fn body_len(m: &Map<String, Value>) -> usize {
    m.get("rows")
        .and_then(Value::as_array)
        .map(|a| a.len())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn result_cursors_keep_named_and_legacy_results_independent() {
        let mut cursors = ResultCursors::new();
        cursors.put(None, ("legacy", false));
        cursors.put(Some("a"), ("column-a", true));
        cursors.put(Some("b"), ("column-b", false));
        let first = cursors.take(Some("a")).unwrap();
        assert_eq!(first, ("column-a", true));
        // Fetch keeps the selected state only when it has more rows.
        cursors.put(Some("a"), first);
        assert_eq!(cursors.take(Some("b")), Some(("column-b", false)));
        assert_eq!(cursors.take(None), Some(("legacy", false)));
        assert_eq!(cursors.take(Some("a")), Some(("column-a", true)));
        assert!(cursors.take(Some("b")).is_none());
    }

    #[test]
    fn result_cursors_reject_overflow_without_evicting_existing_results() {
        let mut cursors = ResultCursors::new();
        for n in 0..MAX_RESULT_CURSORS {
            let id = n.to_string();
            cursors.check_capacity(Some(&id)).unwrap();
            cursors.put(Some(&id), n);
        }
        assert_eq!(
            cursors.check_capacity(Some("overflow")).unwrap_err().code,
            "cursor-limit"
        );
        assert_eq!(cursors.named.len(), MAX_RESULT_CURSORS);
        assert!(
            cursors.check_capacity(Some("0")).is_ok(),
            "同名替换不占新名额"
        );
        assert!(cursors.check_capacity(None).is_ok(), "保留旧调用的独立槽位");
        assert_eq!(cursors.take(Some("0")), Some(0));
        assert!(cursors.check_capacity(Some("overflow")).is_ok());
        assert_eq!(cursors.take(Some("31")), Some(31));
    }

    #[test]
    fn result_cursors_close_only_selected_and_clear_invalidates_all() {
        let mut cursors = ResultCursors::new();
        cursors.put(None, 0);
        cursors.put(Some("a"), 1);
        cursors.put(Some("b"), 2);
        assert_eq!(cursors.take(Some("a")), Some(1));
        assert!(cursors.take(Some("a")).is_none(), "关闭是幂等的");
        assert_eq!(cursors.take(Some("b")), Some(2));
        cursors.put(Some("b"), 2);
        cursors.clear();
        assert!(cursors.take(None).is_none());
        assert!(cursors.take(Some("b")).is_none());
    }

    #[test]
    fn named_more_is_cursor_closed_and_close_is_idempotent_without_connection() {
        let e = RustEngine::new();
        assert_eq!(
            e.call("more", &["2", "gone"], Duration::from_secs(5))
                .unwrap_err()
                .code,
            "cursor-closed"
        );
        assert_eq!(
            e.call("closeResult", &["gone"], Duration::from_secs(5))
                .unwrap()["closed"],
            false
        );
        assert!(e
            .call("closeResult", &[""], Duration::from_secs(5))
            .is_err());
    }

    /// 带 schema 的表名必须拆开：整串当 table_name 查会静默返回空，
    /// 上层据此判「没有主键」，SQL 控制台结果页就被锁成只读。
    #[test]
    fn 元数据表名按需拆出_owner() {
        assert_eq!(
            split_qualified("aier633.bd_material"),
            (Some("AIER633".into()), "BD_MATERIAL".into())
        );
        assert_eq!(
            split_qualified(" bd_material "),
            (None, "BD_MATERIAL".into()),
            "不带 schema 时不能凭空造 owner"
        );
        // 只有一个点、两侧都非空才算限定名；`a.` / `.b` 当普通表名处理
        assert_eq!(split_qualified("a."), (None, "A.".into()));
        assert_eq!(split_qualified(".b"), (None, ".B".into()));
    }

    /// 预览文案必须能被 `is_lob_preview` 认出来，而且不能把正常值误判成截断。
    ///
    /// 这条守住 P0：导出/传输复用网格的取数通道，它们只能靠文案判断截断。
    /// 一旦 `preview_text` 的措辞改了却没同步 `is_lob_preview`，导出的脚本里就会出现
    /// 「正文 + 一句中文提示」而零告警。
    #[test]
    fn 预览文案可判别且不误伤正常值() {
        let long = "字".repeat(LOB_PREVIEW + 1);
        let preview = preview_text(&long, Some(long.chars().count()));
        assert!(is_lob_preview(&preview), "截断后的预览必须能判出来");

        // 刚好到上限但没截断：文案里不该有提示，也不该被判成截断
        let exact = "字".repeat(LOB_PREVIEW);
        let same = preview_text(&exact, Some(exact.chars().count()));
        assert!(!is_lob_preview(&same), "没截断的值不能被误判");
        assert_eq!(same, exact);

        // 中文 CLOB 的字节数远大于字符数（3 字节/字）：必须按**字符**判，
        // 否则 3000 个汉字（9 KB）会被当成「共 9000 个字符、只显示前 8192」——
        // 提示既没发生也被写进值本身，导出脚本就带上了这句中文。
        let cjk = "凭".repeat(3000);
        let whole = preview_text(&cjk, Some(cjk.chars().count()));
        assert_eq!(whole, cjk, "全文都在手里就不能加截断提示");
        assert!(!is_lob_preview(&whole));

        // 字符总数未知（只读到字节上限）：照实说「8192+」，不当成确切数字
        let unknown = preview_text(&long, None);
        assert!(is_lob_preview(&unknown));
        assert!(unknown.contains(&format!("{LOB_PREVIEW}+")), "{unknown}");

        // 普通短值
        assert!(!is_lob_preview("普通文本"));
    }

    /// 全量通道（导出 / 搬运）超限时的标记也必须能被 `is_lob_preview` 认出来，
    /// 否则文件会被当成完整数据，「部分结果」改名与告警都不会触发。
    #[test]
    fn 全量通道的截断标记也能被导出识别() {
        let long = "字".repeat(CLOB_MAX + 1);
        let full = full_lob_text(&long, false);
        assert!(is_lob_preview(&full), "超限文本必须带截断标记");
        assert!(full.chars().count() > CLOB_MAX);
        let exact = "字".repeat(CLOB_MAX);
        let same = full_lob_text(&exact, false);
        assert!(!is_lob_preview(&same), "刚好到上限不能被误判");
        assert_eq!(same.chars().count(), CLOB_MAX);
        assert_eq!(full_lob_text("普通文本", false), "普通文本");
        // JVM 桥 `clobText(c, CLOB_MAX)` 用的是这句措辞，两边都要能认
        assert!(is_lob_preview("正文 …（共 123 个字符，只取前 1M）"));
    }

    /// 事务真源必须按会话 sid 问 `v$transaction`；`audsid` 对共享会话不可靠。
    #[test]
    fn 事务真源_sql_判据不跑偏() {
        assert!(TX_ACTIVE_SQL.contains("v$transaction"));
        assert!(TX_ACTIVE_SQL.contains("ses_addr"));
        assert!(TX_ACTIVE_SQL.contains("sys_context('userenv','sid')"));
        assert!(!TX_ACTIVE_SQL.contains("audsid"));
    }

    /// 事务计数要认 `commit` / `rollback` / `for update` / PL/SQL 块。
    ///
    /// 少计一次的代价是：切只读、重连、关标签触发的 rollback 会静默丢掉写入与行锁，
    /// 而界面一直显示「0 条未提交」。
    #[test]
    fn 事务计数认锁与plsql块() {
        for head in [
            "insert", "update", "merge", "lock", "begin", "declare", "call",
        ] {
            assert!(opens_transaction(head), "{head} 应该算开启事务");
        }
        for head in [
            "select", "with", "create", "alter", "commit", "rollback", "truncate",
        ] {
            assert!(!opens_transaction(head), "{head} 不应该算开启事务");
        }
    }

    /// 大文本探测 SQL：行号是 N+1（Oracle 的 rownum 从 1 起），列名原样加引号。
    #[test]
    fn 大文本探测sql_行号与列名都正确() {
        let sql = lob_probe_sql("select a, b from t where x = 1", "MY_COL", 0).unwrap();
        assert!(sql.contains("(select a, b from t where x = 1) t"), "{sql}");
        assert!(sql.contains("where \"__ncforge_rn\" = 1"), "{sql}");
        assert!(
            sql.starts_with("select \"MY_COL\" as \"__nc_lob\""),
            "{sql}"
        );

        let sql = lob_probe_sql("select 1 from dual", "c", 499).unwrap();
        assert!(sql.contains("= 500"), "{sql}");
    }

    /// 列名带引号要转义；空列名直接拒绝，绝不拼进 SQL。
    #[test]
    fn 大文本探测sql_列名按标识符转义() {
        let sql = lob_probe_sql("select 1 from dual", "A\"B", 0).unwrap();
        assert!(sql.contains("\"A\"\"B\""), "{sql}");
        assert!(lob_probe_sql("select 1 from dual", "  ", 0).is_err());
    }

    /// 连接阶段的 TCP 超时是「连不上库」，不是「语句已中断、会话仍然可用」。
    ///
    /// 驱动把 `io::ErrorKind::TimedOut` 也塞进 `CallTimeoutExceeded`（见
    /// `vendor/oracledb/src/error.rs` 的 `From<io::Error>`），两条路必须分开映射，
    /// 否则用户看到的是一个跟真实原因毫无关系的提示（实测 macOS 连不上 1521 就报这个）。
    #[test]
    fn 连接超时说连不上_语句超时才说被中断() {
        let e = connect_err(std::io::Error::from(std::io::ErrorKind::TimedOut).into());
        assert_eq!(e.code, "unreachable");
        assert!(e.message.contains("TCP"), "{}", e.message);

        let e = drv_err(std::io::Error::from(std::io::ErrorKind::TimedOut).into());
        assert_eq!(e.code, "timeout", "语句阶段的超时不能跟着改码");
        assert!(e.message.contains("会话仍然可用"));
    }

    /// 同一个驱动错误，用户点过停止就报 `cancelled`，否则保持 `timeout`。
    /// 前端靠这个码把「我主动停了」显示成已停止，而不是红色失败。
    #[test]
    fn 用户停止产生cancelled_真超时仍是timeout() {
        let stopped = AtomicBool::new(true);
        let e = classify_cancel(
            Err(drv_err(
                std::io::Error::from(std::io::ErrorKind::TimedOut).into(),
            )),
            &stopped,
        )
        .unwrap_err();
        assert_eq!(e.code, "cancelled");
        assert!(!stopped.load(Ordering::SeqCst), "标志用一次就该清掉");

        let timeout = AtomicBool::new(false);
        let e = classify_cancel(
            Err(drv_err(
                std::io::Error::from(std::io::ErrorKind::TimedOut).into(),
            )),
            &timeout,
        )
        .unwrap_err();
        assert_eq!(e.code, "timeout");
    }
    /// 对象类型会被拼进 `get_ddl('<type>', ?)`，所以「认不出来就 None」是安全边界，
    /// 这条用例是它的守门人：任何放宽都必须先过这里。
    #[test]
    fn 对象类型只认白名单其余当表() {
        assert_eq!(object_type_of(Some("package")), Some("PACKAGE"));
        assert_eq!(
            object_type_of(Some("  Package Body ")),
            Some("PACKAGE BODY")
        );
        assert_eq!(object_type_of(Some("SEQUENCE")), Some("SEQUENCE"));
        assert_eq!(object_type_of(Some("index")), Some("INDEX"));
        assert_eq!(object_type_of(Some("INDEX'; drop table t --")), None);
        // 表/视图走的是表那条路（TABLE 失败再回落 VIEW），不该被当对象类型
        assert_eq!(object_type_of(Some("TABLE")), None);
        assert_eq!(object_type_of(None), None);
        assert_eq!(object_type_of(Some("")), None);
        // 注入载体：拼进 SQL 前必须被白名单挡住
        assert_eq!(object_type_of(Some("PACKAGE'; drop table t --")), None);
        assert_eq!(object_type_of(Some("PACKAGE'")), None);
    }

    #[test]
    fn jdbc_连接串转_easy_connect() {
        assert_eq!(
            connect_string_from_jdbc("jdbc:oracle:thin:@10.200.22.144:1521/aier260824").unwrap(),
            "10.200.22.144:1521/aier260824"
        );
        assert_eq!(
            connect_string_from_jdbc("jdbc:oracle:thin:@//10.0.0.1:1521/ORCL").unwrap(),
            "10.0.0.1:1521/ORCL"
        );
        assert_eq!(
            connect_string_from_jdbc("jdbc:oracle:thin:@10.0.0.1:1521:orcl").unwrap(),
            "10.0.0.1:1521/orcl",
            "SID 写法要转成服务名写法"
        );
        assert_eq!(
            connect_string_from_jdbc("10.0.0.1:1521/ORCL").unwrap(),
            "10.0.0.1:1521/ORCL",
            "已经是裸串就原样用"
        );
        assert!(
            connect_string_from_jdbc("jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(HOST=h)))")
                .unwrap()
                .starts_with('(')
        );
        assert!(connect_string_from_jdbc("   ").is_err());
        assert!(connect_string_from_jdbc("jdbc:oracle:thin:@").is_err());
    }

    #[test]
    fn 非_plsql_去掉末尾分号() {
        assert_eq!(normalize("select 1 from dual;  "), "select 1 from dual");
        assert_eq!(
            normalize("begin null; end;"),
            "begin null; end;",
            "PL/SQL 的分号是语法的"
        );
        assert_eq!(normalize("select 1 from dual/"), "select 1 from dual");
    }

    #[test]
    fn 语句类别判定() {
        assert!(is_query(
            &leading_keywords("select * from a"),
            "select * from a"
        ));
        assert!(is_query(
            &leading_keywords("with x as (select 1 from dual) select * from x"),
            ""
        ));
        assert!(!is_query(&leading_keywords("update a set b = 1"), ""));
        assert!(is_plsql(&leading_keywords("declare begin null; end;")));
        assert!(is_ddl(&leading_keywords("create table t(a number)")));
        assert!(is_write(&leading_keywords(
            "merge into a using b on (1=1) when matched then update set c=1"
        )));
        assert!(!is_write(&leading_keywords(
            "select * from a where b = 'insert'"
        )));
    }

    #[test]
    fn 注释与字面量不参与判类() {
        let sql = "-- delete everything\nselect 1 from dual";
        assert!(is_query(&leading_keywords(sql), sql));
        let sql2 = "select '/* drop table t */' from dual";
        assert!(is_query(&leading_keywords(sql2), sql2));
        assert!(!is_ddl(&leading_keywords(sql2)));
    }

    #[test]
    fn 类型名与_jvm_桥对齐() {
        assert_eq!(base_type("VARCHAR2(20)"), "VARCHAR2");
        assert_eq!(base_type("number"), "NUMBER");
        assert_eq!(full_type("VARCHAR2", 20, None, 0), "VARCHAR2(20)");
        assert_eq!(full_type("NUMBER", 0, Some(10), 2), "NUMBER(10,2)");
        assert_eq!(full_type("NUMBER", 0, Some(10), 0), "NUMBER(10)");
        assert_eq!(full_type("DATE", 0, None, 0), "DATE");
    }

    #[test]
    fn 时间戳按_jvm_桥的格式输出() {
        let ts = oracledb::OracleTimestamp::new_date(2026, 10, 30);
        assert_eq!(fmt_timestamp(&ts, true), "2026-10-30 00:00:00");
    }

    #[test]
    fn 没有连接时命令报未连接() {
        let e = RustEngine::new();
        let err = e
            .call("exec", &["select 1 from dual"], Duration::from_secs(5))
            .unwrap_err();
        assert_eq!(err.code, "sql");
        assert!(err.message.contains("还没连"), "{}", err.message);
    }

    #[test]
    fn 没连上时取消明确报错() {
        let e = RustEngine::new();
        let err = e.cancel().unwrap_err();
        assert!(err.message.contains("还没连"), "{}", err.message);
    }

    #[test]
    fn 没连上时取大文本只报未连接() {
        // 这条路径曾经用 `self.conn.take()`：一旦中途早退，连接就被 drop 掉，
        // 会话永久停在「还没连数据库」。至少不能 panic、不能报一条看不懂的驱动错。
        let e = RustEngine::new();
        let err = e
            .call(
                "lobValue",
                &["select c from t", "0", "C", "1024", "5"],
                Duration::from_secs(5),
            )
            .unwrap_err();
        assert!(err.message.contains("还没连"), "{}", err.message);
    }

    #[test]
    fn 统计差值是四项各自相减() {
        let before = StatSnap {
            db_block_gets: 10,
            consistent_gets: 100,
            physical_reads: 5,
            execute_count: 1,
        };
        let after = StatSnap {
            db_block_gets: 12,
            consistent_gets: 130,
            physical_reads: 5,
            execute_count: 2,
        };
        let v = after.since(&before);
        assert_eq!(v["dbBlockGets"], 2);
        assert_eq!(v["consistentGets"], 30);
        assert_eq!(v["logicalReads"], 32, "逻辑读 = 当前读 + 一致读");
        assert_eq!(v["physicalReads"], 0);
        assert_eq!(v["executeCount"], 1);
    }

    #[test]
    fn 列中文名_sql_按表数给占位符() {
        // 占位符个数与表数必须一致：错一个是「参数个数不对」的 ORA 报错，
        // 而前端对这一路是静默失败的（表头退回显示类型），线上看不出来
        let one = columns_zh_sql(1);
        assert!(one.contains("in (:1)"), "{one}");
        let three = columns_zh_sql(3);
        assert!(three.contains("in (:1, :2, :3)"), "{three}");
        // 0 张表也不该拼出 `in ()`（Oracle 语法错）
        assert!(columns_zh_sql(0).contains("in (:1)"));
        // 只读元数据：这条 SQL 不该被误写成 DML
        assert!(three.trim_start().starts_with("select"));
    }

    #[test]
    fn 统计基线归零不产生负数() {
        // 重连 / ALTER SESSION 之后累计值可能比上一次小：夹到 0，
        // 界面不出现「-120 次逻辑读」这种明显错的值
        let before = StatSnap {
            db_block_gets: 50,
            consistent_gets: 900,
            physical_reads: 3,
            execute_count: 7,
        };
        let v = StatSnap::default().since(&before);
        assert_eq!(v["logicalReads"], 0);
        assert_eq!(v["physicalReads"], 0);
        assert_eq!(v["executeCount"], 0);
    }
}

fn decimal_number(input: &str) -> Result<oracledb::OracleNumber, BridgeError> {
    if input.len() > 400 {
        return Err(sql_err("绑定数字超出 Oracle 范围"));
    }
    let normalized;
    let text = if let Some(at) = input.find(['e', 'E']) {
        let exponent = input[at + 1..]
            .parse::<i32>()
            .map_err(|_| sql_err("数字指数无效"))?;
        if !(-130..=126).contains(&exponent) {
            return Err(sql_err("数字指数超出 Oracle 范围"));
        }
        let mantissa = &input[..at];
        let sign = if mantissa.starts_with('-') { "-" } else { "" };
        let unsigned = mantissa.trim_start_matches(['-', '+']);
        if unsigned.chars().filter(|c| *c == '.').count() > 1
            || unsigned.chars().any(|c| !c.is_ascii_digit() && c != '.')
        {
            return Err(sql_err("绑定数字无效"));
        }
        let point = unsigned.find('.').unwrap_or(unsigned.len()) as i32 + exponent;
        let digits = unsigned.replace('.', "");
        normalized = if point <= 0 {
            format!("{sign}0.{}{digits}", "0".repeat((-point) as usize))
        } else if point as usize >= digits.len() {
            format!(
                "{sign}{digits}{}",
                "0".repeat(point as usize - digits.len())
            )
        } else {
            format!(
                "{sign}{}.{}",
                &digits[..point as usize],
                &digits[point as usize..]
            )
        };
        normalized.as_str()
    } else {
        input
    };
    text.parse()
        .map_err(|_| sql_err("绑定数字无效或超出 Oracle 精度"))
}
#[cfg(test)]
mod bound_number_tests {
    use super::*;
    #[test]
    fn preserves_high_precision_and_scientific_numbers() {
        let s = "12345678901234567890123456789012345678";
        assert_eq!(decimal_number(s).unwrap().to_string(), s);
        assert_eq!(decimal_number("1.234e-4").unwrap().to_string(), "0.0001234");
        assert_eq!(decimal_number("-1.2E+3").unwrap().to_string(), "-1200");
    }
    #[test]
    fn rejects_sql_fragments_and_unbounded_exponents() {
        for s in ["1);delete from t--", "NaN", "1e999999", "1.2.3", "--1"] {
            assert!(decimal_number(s).is_err(), "{s}");
        }
    }
}
