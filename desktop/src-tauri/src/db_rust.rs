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

use std::io::Read;
use std::panic::{self, AssertUnwindSafe};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use oracledb::{
    BreakHandle, Connection, Cursor, Error, ErrorKind, ExecResult, Lob, Metadata, Row, ToDbValue,
};
use serde_json::{json, Map, Value};

use crate::java_bridge::BridgeError;

/// CLOB 一次最多读这么多字符（与 JVM 桥一致：再长也不展开，避免一条记录撑爆前端）。
const CLOB_MAX: usize = 1024 * 1024;
/// DBMS_OUTPUT 一次最多取这么多行。
const OUTPUT_MAX: usize = 5000;

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

fn other_err(m: impl Into<String>) -> BridgeError {
    BridgeError::new("other", m)
}

fn not_connected() -> BridgeError {
    sql_err("还没连数据库")
}

/// 驱动的错误 → 我们的错误码。带 `ORA-xxxxx` 前缀，命令层的 `map_sql_error` 靠它分流
/// （认证失败弹输口令框、网络不通单独提示）。
fn drv_err(e: Error) -> BridgeError {
    match e.kind() {
        ErrorKind::DbError(d) => {
            BridgeError::new("sql", format!("ORA-{:05}：{}", d.code(), d.message()))
        }
        // 两种情况走同一个错误：用户点了「停止」（驱动发 INTERRUPT 打断），
        // 或者调用超时到期（兜底）。对用户来说都是「这条语句没跑完」。
        ErrorKind::CallTimeoutExceeded => BridgeError::new(
            "timeout",
            "语句已中断（点了停止，或等待超过超时时间）。会话仍然可用",
        ),
        ErrorKind::DeadConnection => BridgeError::new("sql", "连接已断开（数据库或网络关闭了它）"),
        _ => BridgeError::new("sql", e.to_string()),
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
}

/// 「当前这条连接的中断句柄」。`None` = 没连上。
type BreakerSlot = Arc<Mutex<Option<BreakHandle>>>;

struct Session {
    conn: Option<Connection>,
    /// 「加载更多」用的游标。Oracle 游标不能回退，必须留着才能接着取。
    cursor: Option<Cursor>,
    /// 结果集的列（`columns` 字段原样），分页时复用。
    columns: Vec<Value>,
    auto_commit: bool,
    tx_statements: i64,
    tx_rows: i64,
    tx_since: i64,
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
                cursor: None,
                columns: Vec::new(),
                auto_commit: false,
                tx_statements: 0,
                tx_rows: 0,
                tx_since: 0,
                breaker: breaker.clone(),
            }),
            breaker,
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
                h.interrupt();
                Ok(())
            }
            None => Err(not_connected()),
        }
    }

    /// 跑一条命令。阻塞调用，调用方要放在 `spawn_blocking` 里。
    pub fn call(&self, cmd: &str, args: &[&str], timeout: Duration) -> Result<Value, BridgeError> {
        let mut s = self.lock();
        // 11g 密码校验器的 panic（#63）必须在这里拦下：它一炸就是整个进程退出
        match panic::catch_unwind(AssertUnwindSafe(|| s.dispatch(cmd, args, timeout))) {
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
        }
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
    fn dispatch(
        &mut self,
        cmd: &str,
        a: &[&str],
        _timeout: Duration,
    ) -> Result<Value, BridgeError> {
        match cmd {
            "connect" => {
                let auto = a.get(3).map(|v| v.eq_ignore_ascii_case("true")).unwrap_or(false);
                self.connect(a.first().copied().unwrap_or(""), a.get(1).copied().unwrap_or(""), a.get(2).copied().unwrap_or(""), auto)
            }
            "connectProp" => Err(other_err(
                "纯 Rust 驱动解不了 NC prop.xml 里加密的口令（那要用 NC 自带的 PropXMLReader，只有 JVM 里能跑）。\
                 这个连接请改用「JVM 桥」，或者导入 .properties / 手工填连接参数",
            )),
            "exec" => self.exec(
                a.first().copied().unwrap_or(""),
                int_arg(a, 1, 500),
                int_arg(a, 2, 30),
            ),
            "more" => self.more(int_arg(a, 0, 500)),
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
            "ping" => {
                let alive = self.ping().is_ok();
                Ok(json!({ "alive": alive, "tx": self.tx_json() }))
            }
            "disconnect" => {
                self.close();
                Ok(json!({}))
            }
            "tables" => self.tables(),
            "ncNames" => self.nc_names(),
            "columns" => self.columns(a.first().copied().unwrap_or("")),
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
            // 真正的中断走 `RustEngine::cancel()`（不经过会话锁），这条命令只是占位
            "cancel" => Err(other_err("请用引擎层的 cancel，不要发 cancel 命令")),
            other => Err(other_err(format!("纯 Rust 引擎不认识这个命令：{other}"))),
        }
    }

    fn conn_ref(&self) -> Result<&Connection, BridgeError> {
        self.conn.as_ref().ok_or_else(not_connected)
    }

    fn reset_tx(&mut self) {
        self.tx_statements = 0;
        self.tx_rows = 0;
        self.tx_since = 0;
    }

    fn reset_all(&mut self) {
        self.cursor = None;
        self.columns.clear();
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

    fn close_cursor(&mut self) {
        // 驱动的 Cursor 没有显式 close：丢掉即可，语句随 Drop 归还
        self.cursor = None;
        self.columns.clear();
    }

    fn close(&mut self) {
        self.drop_breaker();
        if let Some(conn) = self.conn.take() {
            self.cursor = None;
            self.columns.clear();
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
    ) -> Result<Value, BridgeError> {
        self.close();
        let cs = connect_string_from_jdbc(url).map_err(sql_err)?;
        let cfg = oracledb::Config::default()
            .set_credentials(user, pass)
            // 连不通的库不能一直挂着：JVM 桥那边是 `oracle.net.CONNECT_TIMEOUT=15000`，
            // 这里对齐成同一个数。不设的话退到系统 TCP 超时，界面上会转两三分钟。
            .set_transport_connect_timeout(Some(Duration::from_secs(15)))
            .set_connect_string(&cs)
            .map_err(drv_err)?;
        let conn = oracledb::connect(cfg).map_err(drv_err)?;
        // DBMS_OUTPUT 默认关着：打开后 PL/SQL 里的 put_line 才能在「输出」标签看到。
        // 没权限也不影响连库。
        let _ = conn.execute("begin dbms_output.enable(1000000); end;", &[]);
        let login_user =
            scalar_string(&conn, "select user from dual").unwrap_or_else(|| user.to_string());
        let version = db_version(&conn);
        self.auto_commit = auto;
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
            "autoCommit": auto,
        }))
    }

    // ───────────────────── 执行 ─────────────────────

    fn exec(
        &mut self,
        raw: &str,
        max_rows: usize,
        timeout_sec: usize,
    ) -> Result<Value, BridgeError> {
        if self.conn.is_none() {
            return Err(not_connected());
        }
        self.close_cursor();
        let sql = normalize(raw);
        if sql.is_empty() {
            return Err(sql_err("空语句"));
        }
        let head = leading_keywords(&sql);
        let max_rows = max_rows.clamp(1, 10_000);
        let t0 = Instant::now();

        // 双重保险：用户点「停止」走中断句柄（立刻生效），这里的读超时只是兜底
        // ——万一中断没能打断（比如语句在服务端排队还没开始跑），也别让界面无限等。
        if let Ok(conn) = self.conn_ref() {
            let _ =
                conn.set_call_timeout(Some(Duration::from_secs(timeout_sec.max(1) as u64 + 10)));
        }
        // A2 Autotrace：执行前后各读一次 `v$mystat`，差值才是这条语句的真实开销。
        // 读不到（低权限账号没有 V_$MYSTAT 授权）就是 None，界面据此**不显示这一行**，
        // 而不是给一排 0 让人以为「这条 SQL 一次逻辑读都没花」。
        let before = self.conn_ref().ok().and_then(stat_snapshot);
        let out = self.run(&sql, &head, max_rows);
        if let Ok(conn) = self.conn_ref() {
            let _ = conn.set_call_timeout(None);
        }
        let after = self.conn_ref().ok().and_then(stat_snapshot);

        let mut body = out?;
        body.insert("ms".into(), json!(t0.elapsed().as_millis() as u64));
        body.insert(
            "stats".into(),
            match (before, after) {
                (Some(b), Some(a)) => a.since(&b),
                _ => Value::Null,
            },
        );
        body.insert("output".into(), json!(self.take_output()));
        body.insert("tx".into(), self.tx_json());
        Ok(Value::Object(body))
    }

    /// 真正执行。`conn` 先取出来再用，避免「同一次调用里既要 `&mut self` 又要 `&self.conn`」。
    fn run(
        &mut self,
        sql: &str,
        head: &str,
        max_rows: usize,
    ) -> Result<Map<String, Value>, BridgeError> {
        let conn = self.conn.take().ok_or_else(not_connected)?;
        let r = self.run_with(&conn, sql, head, max_rows);
        self.conn = Some(conn);
        r
    }

    fn run_with(
        &mut self,
        conn: &Connection,
        sql: &str,
        head: &str,
        max_rows: usize,
    ) -> Result<Map<String, Value>, BridgeError> {
        let mut body = Map::new();
        if is_query(head, sql) {
            let mut cur = conn.query(sql, &[]).map_err(drv_err)?;
            let columns: Vec<Value> = cur.columns().iter().map(column_json).collect();
            let types: Vec<String> = cur
                .columns()
                .iter()
                .map(|m| base_type(&type_label(m)))
                .collect();
            self.columns = columns.clone();
            let (rows, has_more) = page(&mut cur, &types, max_rows)?;
            body.insert("kind".into(), json!("rows"));
            body.insert("columns".into(), Value::Array(columns));
            body.insert("rows".into(), json!(rows));
            body.insert("hasMore".into(), json!(has_more));
            if has_more {
                self.cursor = Some(cur);
            }
            // `select … for update` 也算开了事务（和 JVM 桥一致）
            if has_for_update(sql) {
                self.track_tx("lock", 0);
            }
            body.insert("rowCount".into(), json!(body_len(&body)));
        } else {
            let mut res = conn.execute(sql, &[]).map_err(drv_err)?;
            let n = res.rows_affected();
            // 隐式结果集（`dbms_sql.return_result`）：PL/SQL 块自己开的 ref cursor，
            // 服务端按 TTC 27 号消息下发，驱动侧已解析（vendor 补丁四）。
            let sets = implicit_sets(&mut res, max_rows)?;
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

    fn more(&mut self, max_rows: usize) -> Result<Value, BridgeError> {
        let max_rows = max_rows.clamp(1, 10_000);
        let t0 = Instant::now();
        let types: Vec<String> = self
            .columns
            .iter()
            .map(|c| base_type(c.get("type").and_then(Value::as_str).unwrap_or("")))
            .collect();
        let Some(cur) = self.cursor.as_mut() else {
            return Err(sql_err(
                "没有可以继续读取的结果（游标已关闭，重新执行一次）",
            ));
        };
        let (rows, has_more) = page(cur, &types, max_rows)?;
        if !has_more {
            self.cursor = None;
        }
        let count = rows.len();
        Ok(json!({
            "rows": rows,
            "rowCount": count,
            "hasMore": has_more,
            "ms": t0.elapsed().as_millis() as u64,
        }))
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
        if is_write(head) {
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
        let sql = "select table_name, 'TABLE' from user_tables where table_name not like 'BIN$%' \
                   union all select view_name, 'VIEW' from user_views order by 1";
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

    fn columns(&self, table: &str) -> Result<Value, BridgeError> {
        let conn = self.conn_ref()?;
        let t = table.to_uppercase();
        let zh = self.nc_column_names(conn, table);
        let pk = self.pk_columns(conn, &t)?;
        let sql =
            "select c.column_name, c.data_type, c.char_length, c.data_precision, c.data_scale, \
                   c.nullable, c.data_default, cc.comments \
                   from user_tab_columns c left join user_col_comments cc \
                   on cc.table_name = c.table_name and cc.column_name = c.column_name \
                   where c.table_name = :1 order by c.column_id";
        let cur = conn.query(sql, &[&t as &dyn ToDbValue]).map_err(drv_err)?;
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

    fn pk_columns(&self, conn: &Connection, table: &str) -> Result<Vec<String>, BridgeError> {
        let sql = "select cc.column_name from user_constraints c \
                   join user_cons_columns cc on cc.constraint_name = c.constraint_name \
                   where c.table_name = :1 and c.constraint_type = 'P' order by cc.position";
        let cur = conn
            .query(sql, &[&table as &dyn ToDbValue])
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
        let sql = "select i.index_name, i.uniqueness, i.status, ic.column_name \
                   from user_indexes i join user_ind_columns ic on ic.index_name = i.index_name \
                   where i.table_name = :1 order by i.index_name, ic.column_position";
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
    /// 为什么用 `user_objects` 而不是 `all_objects`：二开账号通常只有自己 schema 的权限，
    /// `all_objects` 会扫到别人的几千张表、还要额外授权，而对象树只关心「我能改的东西」。
    /// `generated = 'N'` 排掉系统生成的（回收站对象、LOB 索引之类）。
    fn objects(&self) -> Result<Value, BridgeError> {
        let conn = self.conn_ref()?;
        let sql = "select object_name, object_type, status, to_char(created, 'YYYY-MM-DD') \
                   from user_objects \
                   where object_type in ('PACKAGE','PACKAGE BODY','PROCEDURE','FUNCTION', \
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

    /// 库内源码（`user_source`）。序列、同义词这类没有源码的对象返回空 `lines`。
    ///
    /// `order by type, line`：字典序里 `PACKAGE` 排在 `PACKAGE BODY` 之前，
    /// 正好是「规范在前、实现在后」的阅读顺序（`TYPE` / `TYPE BODY` 同理）。
    fn source(&self, name: &str) -> Result<Value, BridgeError> {
        let conn = self.conn_ref()?;
        let n = name.to_uppercase();
        let sql = "select type, line, text from user_source where name = :1 order by type, line";
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
/// 成本是每次执行多两次往返（~1 ms 级）。差值里**包含**这两次统计查询自己的开销
/// （约十几次逻辑读），与 PL/SQL Developer 的 autotrace 同口径，不额外剔除。
fn stat_snapshot(conn: &Connection) -> Option<StatSnap> {
    let sql = format!(
        "select n.name, m.value from v$mystat m, v$statname n \
          where n.statistic# = m.statistic# and n.name in ({STAT_NAMES})"
    );
    let cur = conn.query(&sql, &[]).ok()?;
    let mut s = StatSnap::default();
    let mut found = 0usize;
    for row in cur {
        let Ok(row) = row else { return None };
        let name: String = row
            .get::<Option<String>>(0)
            .ok()
            .flatten()
            .unwrap_or_default();
        let v: i64 = row.get::<Option<i64>>(1).ok().flatten().unwrap_or(0);
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
    (found > 0).then_some(s)
}

// ───────────────────────── 结果集转换 ─────────────────────────

/// 从游标取最多 `max_rows` 行。返回（行, 是否可能还有）。
///
/// 取满就停、不预读下一行：Oracle 游标不能回退，预读会把一行吞掉（JVM 桥踩过这个坑）。
/// 把 `dbms_sql.return_result` 交回来的每个结果集取成 JSON（顺序与 `return_result` 一致）。
///
/// **不接「加载更多」**：会话里只留一条分页游标（`Session.cursor`），多结果集时没法给每个
/// 都留一条，而按「最后点过的那个」留会让用户以为另一条也能接着取。所以每个结果集一次取
/// `max_rows` 行，取满就给 `hasMore: true`（前端提示调大「每次取」再执行），然后让游标
/// 随 `Cursor` 一起 drop —— `Statement::new` 的 `return_on_drop` 会把它还给客户端，
/// 否则会话游标会一路漏到 `open_cursors` 上限（探针 R11 验过）。
fn implicit_sets(res: &mut ExecResult, max_rows: usize) -> Result<Vec<Value>, BridgeError> {
    let mut sets = Vec::new();
    for mut cur in res.implicit_resultsets() {
        let columns: Vec<Value> = cur.columns().iter().map(column_json).collect();
        let types: Vec<String> = cur
            .columns()
            .iter()
            .map(|m| base_type(&type_label(m)))
            .collect();
        let (rows, has_more) = page(&mut cur, &types, max_rows)?;
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
) -> Result<(Vec<Value>, bool), BridgeError> {
    let mut rows = Vec::with_capacity(max_rows.min(64));
    for _ in 0..max_rows {
        match cur.next() {
            Some(Ok(row)) => rows.push(row_json(&row, types)),
            Some(Err(e)) => return Err(drv_err(e)),
            // 取不满 = 确实没有更多了
            None => return Ok((rows, false)),
        }
    }
    // 刚好取满：可能还有，也可能正好取完——留给下一次 more 判定（不预读，预读会吞掉一行）
    Ok((rows, true))
}

fn row_json(row: &Row, types: &[String]) -> Value {
    let mut out = Vec::with_capacity(types.len());
    for (i, ty) in types.iter().enumerate() {
        out.push(cell_json(row, i, ty));
    }
    Value::Array(out)
}

/// 一列 → JSON。约定与 JVM 桥的 `value()` 逐条对齐（日期格式、大数字保精度、CLOB 截断…）。
fn cell_json(row: &Row, i: usize, base: &str) -> Value {
    if base.starts_with("DATE") || base.starts_with("TIMESTAMP") {
        let with_frac = base.starts_with("TIMESTAMP");
        if let Ok(Some(ts)) = row.get::<Option<oracledb::OracleTimestamp>>(i) {
            return json!(fmt_timestamp(&ts, with_frac));
        }
        return Value::Null;
    }
    if base == "BLOB" {
        if let Ok(Some(b)) = row.get::<Option<Vec<u8>>>(i) {
            return json!(format!("<BLOB {}B>", b.len()));
        }
    }
    if base == "RAW" || base == "LONG RAW" {
        if let Ok(Some(b)) = row.get::<Option<Vec<u8>>>(i) {
            return json!(hex(&b, 64));
        }
    }
    if base == "CLOB" || base == "NCLOB" || base == "LONG" {
        if let Ok(Some(mut lob)) = row.get::<Option<Lob>>(i) {
            let size = lob.get_size().unwrap_or(0);
            let mut buf = String::new();
            let mut taken = Vec::new();
            if lob.read_to_end(&mut taken).is_ok() {
                buf = String::from_utf8_lossy(&taken[..taken.len().min(CLOB_MAX)]).to_string();
                if size > CLOB_MAX {
                    buf.push_str(&format!("…（共 {size} 字节，只取前 1M）"));
                }
            }
            return json!(buf);
        }
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

/// 服务端版本。`v$version` 常没权限，退到 `product_component_version`。
fn db_version(conn: &Connection) -> String {
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
