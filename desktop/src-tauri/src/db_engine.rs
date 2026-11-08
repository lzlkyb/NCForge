//! 数据库引擎抽象：把「用什么驱动连 Oracle」从命令层里摘出来。
//!
//! 为什么要有这一层：`commands/db_cmds.rs` 里那九百多行，本质全是「拼一行命令 →
//! 拿回制表符分隔的文本」，与底下是 JDBC 还是纯 Rust 驱动毫无关系。抽出来以后换引擎
//! 只需在 [`Engine`] 里加一个分支，命令层一个字都不用改。
//!
//! 目前有两条实现：[`EngineKind::Java`]（常驻 JVM + `NcDbBridge`）与
//! [`EngineKind::Rust`]（Oracle 官方纯 Rust 驱动 `oracledb`，见 `vendor/oracledb`）。
//! 两者的能力**不一致**，所以用 [`Caps`] 把差异显式化：前端拿它决定「停止」按钮能不能用、
//! 哪些能力这条连接没有，而不是让用户撞上去才发现。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::db_bridge::{Bridge, BridgeEnv, BridgeError};

/// 引擎种类。前端与日志里用它区分「这次查询走的是哪条路」，连接配置里也存这个值。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EngineKind {
    /// 常驻 JVM + JDBC（`NcDbBridge`），能力最全，也是默认。
    Java,
    /// 纯 Rust 驱动（`oracledb`）。内存省得多；取消能力由我们对驱动打的补丁提供，
    /// prop.xml 口令则靠「首次连接时由 JVM 解一次、存 DPAPI」绕开。
    Rust,
}

impl EngineKind {
    pub fn label(self) -> &'static str {
        match self {
            EngineKind::Java => "JVM 桥",
            EngineKind::Rust => "纯 Rust 驱动",
        }
    }

    /// 配置里存的是字符串，认不出来就按默认的 JVM 桥处理（老配置里没这个字段）。
    pub fn parse(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "rust" => EngineKind::Rust,
            _ => EngineKind::Java,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            EngineKind::Java => "java",
            EngineKind::Rust => "rust",
        }
    }
}

/// 引擎能力位。**必须与实现同步**：写了 `true` 就代表这条路径真的能跑通。
#[derive(Debug, Clone, Copy, serde::Serialize)]
pub struct Caps {
    /// 语句执行中能取消（JDBC 的 `Statement.cancel()`）。
    pub cancel: bool,
    /// 能从 PL/SQL 取 REF CURSOR（**完整**：`open :1 for` 的 OUT 绑定 + `dbms_sql.return_result` 两种形态）。
    pub refcursor: bool,
    /// 能解 NC `prop.xml` 里加密的口令（要用 NC 自带的 `PropXMLReader`，只在 JVM 里可用）。
    pub prop_decrypt: bool,
    /// 一个进程能带多条连接。为 `false` 时内存随连接数线性增长。
    pub multi_session: bool,
    /// 能列会话与锁（`v$session` / `v$locked_object`）。**权限不够不算没有这个能力**：
    /// 能力位说的是「这条命令有实现」，拿不拿得到锁信息由 `granted` 字段表达。
    pub sessions: bool,
    /// 执行语句时能回实际统计（逻辑读/物理读/影响行数）。需要读 `v$mystat`。
    pub stats: bool,
}

impl Caps {
    /// JVM 桥。取消靠 `Statement.cancel()`，一个 JVM 带多条会话（A 方案）。
    ///
    /// `refcursor: true` 到 2026-10-31 才是真的：此前桥用普通 `Statement` 执行用户 SQL，
    /// `open :1 for …` 里的游标 OUT 参数表达不了（真库报 `ORA-01008 并非所有变量都已绑定`），
    /// 「两种形态都通」其实只通了 `dbms_sql.return_result` 那一种。现在 `exec` 认出
    /// `open :N for` 就走 `prepareCall` + `registerOutParameter(CURSOR)`，两种都通
    /// （`tests/db_refcursor_probe.rs` R5 是守卫）。
    pub const JAVA: Caps = Caps {
        cancel: true,
        refcursor: true,
        prop_decrypt: true,
        multi_session: true,
        sessions: true,
        stats: true,
    };

    /// 纯 Rust 驱动的能力（2026-10-30 按 `db_rust.rs` + vendored 驱动的实际实现校正，
    /// 2026-10-31 P0 补注）：
    /// - `cancel`：**有**。上游 issue #24 没有 break API，我们在 `vendor/oracledb` 里补了
    ///   `BreakHandle`（切片读 + INTERRUPT 标记），见该目录 `FORK.md`。
    /// - `refcursor`：**只有一半**，所以仍是 `false`。`dbms_sql.return_result` 与嵌套游标列
    ///   已经能出多结果集（`db_rust.rs::implicit_sets`，vendor 补丁四），但 JDBC 风格的
    ///   `open :1 for …` 要 OUT 绑定（`BindParameters` 只有输入值），仍报 `PLS-00707`。
    ///   两种形态都通之后再翻成 `true`——写 `true` 就代表整条路能跑。
    ///   ⚠️ **P0 之后「用户视角」不再撞墙**：这类语句会被 `db_engine::refcursor_need` 认出来，
    ///   改到同一连接的 JVM 桥临时会话上执行（`commands::db_cmds::exec_via_java`）。
    ///   但这**不是这个引擎的能力**，所以能力位照旧是 `false`：界面上「引擎选择」说的是
    ///   「这条引擎自己能不能做」，路由只是兜底，且不参与本连接的事务。
    /// - `prop_decrypt`：仍然没有 —— 解 prop.xml 要用 NC 的 Java 类。但连接可以工作：
    ///   首次连接时由 JVM 桥解一次口令、DPAPI 存起来（`db_cmds::prop_password_ready`）。
    /// - `multi_session`：有。每条连接一个 `Connection`，内存本来就与连接数同阶。
    /// - `sessions`：有。`db_rust.rs::sessions()` 直接查 `v$session` / `v$locked_object`，
    ///   与 JVM 桥同形（缺权限时靠 `granted:false` 表达，不靠能力位）。
    /// - `stats`：有（A2）。`db_exec` 执行前后各读一次 `v$mystat` 取差值放进 `stats`；
    ///   账号读不到统计视图时 `stats` 是 `null`，界面不显示那一行 —— 能力位说的是
    ///   「这条路径有实现」，拿不拿得到数字由响应里的 `stats: null` 表达。
    pub const RUST: Caps = Caps {
        cancel: true,
        refcursor: false,
        prop_decrypt: false,
        multi_session: true,
        sessions: true,
        stats: true,
    };

    /// 按引擎种类取能力位。**连上之前**前端就要知道能力（决定「停止」能不能点、
    /// 引擎选择器里哪些项标灰），此时还没有句柄可问，只能按种类查表。
    pub fn of(kind: EngineKind) -> Caps {
        match kind {
            EngineKind::Java => Caps::JAVA,
            EngineKind::Rust => Caps::RUST,
        }
    }
}

enum Engine {
    /// `sid` 是这个连接在共享 JVM 里的会话名（用连接 id，天然唯一）。
    Java { bridge: Arc<Bridge>, sid: String },
    /// 一条连接一个驱动会话，整块状态由引擎自己的锁串行保护。
    ///
    /// 套 `Box` 是为了不让这个变体把 `Engine` 撑大：连接对象比桥的 `Arc` 重得多，
    /// 而 `Engine` 会跟着每个 `EngineHandle` 分配（句柄存在 `AppState` 里，不止一个）。
    Rust(Box<crate::db_rust::RustEngine>),
}

/// 一条连接背后的执行器。对外只暴露「跑命令」，不暴露底下是进程还是连接。
pub struct EngineHandle {
    inner: Engine,
    pub policy: Option<Arc<std::sync::RwLock<bool>>>,
    recovery: Mutex<Recovery>,
    cancel_epoch: AtomicU64,
    closed: AtomicBool,
}

const PROBE_AFTER: Duration = Duration::from_secs(60);
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Default)]
struct Recovery {
    last_success: Option<Instant>,
    auto_commit: bool,
    session_used: bool,
    may_have_transaction: bool,
    lost: bool,
}

/// 一条命令**执行成功后**更新「可能有未提交事务」标志。
///
/// 只在 `call_guarded` 的成功路径调用：执行失败的 DML 走 `map_err` 提前返回，
/// 不该把会话锁成「有未提交事务」（否则改连接设置后的重新连接会被永久误拒，P1-1）。
/// 判定前把 SQL 归一（去字面量/注释 + 小写化），手写大写 `COMMIT;` 也能清掉标志。
fn settle_transaction_flag(
    state: &mut Recovery,
    cmd: &str,
    sql: &str,
    stateful_execution: bool,
    readonly: bool,
) {
    // PL/SQL and SELECT FOR UPDATE can open transactions outside the DML counter.
    if stateful_execution && !state.auto_commit && !readonly {
        state.may_have_transaction = true;
    }
    if matches!(cmd, "commit" | "rollback")
        || state.auto_commit
        || stateful_execution
            && matches!(
                strip_literals(sql)
                    .trim()
                    .trim_end_matches(';')
                    .trim_end()
                    .to_ascii_lowercase()
                    .as_str(),
                "commit" | "rollback"
            )
    {
        state.may_have_transaction = false;
    }
}

/// 重连前「有没有未提交事务」的唯一裁决。
///
/// `confirmed` 是 `v$transaction` 给的真源：`Some(false)` = 数据库确认这条会话没有事务，
/// 可以直接放行；`Some(true)` = 确认有事务；`None` = 字典不可读（低权限账号、连接已坏），
/// 退回本地标志与 DML 计数。
///
/// 🔴 真源优先而不是「两者取或」：手写大写 COMMIT、PL/SQL 内部提交、别的工具回滚之后，
/// 本地计数会一直是脏的。若让本地标志有一票否决权，用户会被永久锁在
/// 「请先提交或回滚」，只能杀进程重开 —— 这正是老工具比我们确定的那一层。
pub(crate) fn reconnect_blocked(
    confirmed: Option<bool>,
    local_flag: bool,
    local_statements: u64,
) -> bool {
    match confirmed {
        Some(false) => false,
        Some(true) => true,
        None => local_flag || local_statements > 0,
    }
}

pub(crate) fn connection_lost(message: &str) -> bool {
    let text = message.to_ascii_lowercase();
    let jdbc_code = text
        .strip_prefix("ora ")
        .and_then(|rest| rest.split_once('：'))
        .and_then(|(code, _)| code.parse::<u32>().ok());
    matches!(
        jdbc_code,
        Some(3113 | 3114 | 1012 | 2396 | 28 | 17008 | 17410)
    ) || [
        "os error 10054",
        "os error 10053",
        "connection reset",
        "broken pipe",
        "ora-03113",
        "ora-03114",
        "ora-01012",
        "ora-02396",
        "ora-00028",
        "ora-17008",
        "ora-17410",
        "no more data to read from socket",
        // thin 驱动的 TTC 流一旦错位就是**永久性**的：后续每条语句都会继续
        // 把上次残留的字节当消息头读（`unknown TTC message type 32/0/50/1…`）。
        // 必须按「连接丢失」处理，否则界面会一直复用这条坏连接。
        "unknown ttc message type",
    ]
    .iter()
    .any(|code| text.contains(code))
}

type ReconnectArgs = (&'static str, Vec<String>);

impl EngineHandle {
    pub fn java(bridge: Arc<Bridge>, session_id: impl Into<String>) -> Self {
        Self {
            policy: None,
            recovery: Mutex::default(),
            cancel_epoch: AtomicU64::new(0),
            closed: AtomicBool::new(false),
            inner: Engine::Java {
                bridge,
                sid: session_id.into(),
            },
        }
    }

    pub fn rust() -> Self {
        Self {
            inner: Engine::Rust(Box::default()),
            policy: None,
            recovery: Mutex::default(),
            cancel_epoch: AtomicU64::new(0),
            closed: AtomicBool::new(false),
        }
    }

    pub fn with_policy(mut self, policy: Arc<std::sync::RwLock<bool>>) -> Self {
        self.policy = Some(policy);
        self
    }

    pub fn raw_call(
        &self,
        cmd: &str,
        args: &[&str],
        timeout: Duration,
    ) -> Result<Value, BridgeError> {
        match &self.inner {
            Engine::Java { bridge, sid } => bridge.call_in_session(sid, cmd, args, timeout),
            Engine::Rust(eng) => eng.call(cmd, args, timeout),
        }
    }

    pub fn kind(&self) -> EngineKind {
        match self.inner {
            Engine::Java { .. } => EngineKind::Java,
            Engine::Rust(_) => EngineKind::Rust,
        }
    }

    pub fn caps(&self) -> Caps {
        match self.inner {
            Engine::Java { .. } => Caps::JAVA,
            Engine::Rust(_) => Caps::RUST,
        }
    }

    /// 跑一条命令，返回桥给的 `data` 对象。
    ///
    /// 阻塞调用，调用方要放在 `spawn_blocking` 里。
    ///
    /// 超时在两条路上的处置不同：
    /// - JVM 桥：发取消、不杀进程（一个 JVM 里通常还有别的连接，为一个慢查询杀掉进程会把
    ///   它们一起带走）。取消要带上会话名，所以由这里补发。
    /// - 纯 Rust：同样发中断（`db_rust` 里走 `BreakHandle`），到点仍不返回就按超时返回。
    pub fn call(&self, cmd: &str, args: &[&str], timeout: Duration) -> Result<Value, BridgeError> {
        self.call_guarded(cmd, args, timeout, |_| Ok(None))
    }

    pub(crate) fn call_guarded(
        &self,
        cmd: &str,
        args: &[&str],
        timeout: Duration,
        reconnect: impl FnOnce(bool) -> Result<Option<ReconnectArgs>, BridgeError>,
    ) -> Result<Value, BridgeError> {
        let epoch = self.cancel_epoch.load(Ordering::Relaxed);
        let policy = self
            .policy
            .as_ref()
            .map(|p| p.read().unwrap_or_else(|e| e.into_inner()));
        let readonly = policy.as_ref().is_some_and(|p| **p);
        let mut state = if cmd == "idlePing" {
            self.recovery
                .try_lock()
                .map_err(|_| BridgeError::new("timeout", "会话正在使用"))?
        } else {
            self.recovery.lock().unwrap_or_else(|e| e.into_inner())
        };
        if self.closed.load(Ordering::Acquire) {
            return Err(BridgeError::new("session-lost", "该会话已经关闭"));
        }
        if cmd == "idlePing" {
            // SQL 可能改变包状态或会话设置，即使事务计数为零也不能静默回收。
            if state.session_used || state.lost {
                return Err(BridgeError::new("busy", "该会话需要保留"));
            }
            return match self.raw_call("probe", &[], PROBE_TIMEOUT) {
                Err(e) if e.code == "session-lost" || connection_lost(&e.message) => {
                    Ok(serde_json::json!({"alive": false}))
                }
                result => result,
            };
        }
        if readonly {
            if matches!(
                cmd,
                "exec" | "execBound" | "execFull" | "execFullBound" | "query"
            ) && !readonly_query(args.first().copied().unwrap_or(""))
            {
                return Err(BridgeError::new(
                    "readonly",
                    "只读查询模式仅允许 SELECT 查询；关闭后才能写入",
                ));
            }
            if matches!(cmd, "explain" | "autocommit") {
                return Err(BridgeError::new("readonly", "只读查询模式不允许此操作"));
            }
        }
        if matches!(cmd, "reconnect" | "reconnectConfigured") {
            if !state.lost && cmd == "reconnect" {
                return Err(BridgeError::new("sql", "该会话未确认断开"));
            }
            if !state.lost {
                // Check under the session lock so a write cannot slip in before reconnect.
                // 先问数据库真源（`v$transaction`）。查不到（低权限 / 连接已坏）时
                // confirmed=None，自动退回原来那套保守的本地判定。
                let confirmed = self
                    .raw_call("txActive", &[], PROBE_TIMEOUT)
                    .ok()
                    .and_then(|v| v.get("active").and_then(Value::as_bool));
                // ping 的失败仍要按「连接丢失」记账，不能因为真源可用就吞掉。
                let status = self
                    .raw_call("ping", &[], PROBE_TIMEOUT)
                    .map_err(|e| Self::record_loss(&mut state, e, false))?;
                let local_statements = status
                    .pointer("/tx/statements")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                if reconnect_blocked(confirmed, state.may_have_transaction, local_statements) {
                    return Err(BridgeError::new(
                        "sql",
                        "请先提交或回滚当前会话（可执行 COMMIT 或 ROLLBACK），再重新连接",
                    ));
                }
                // 数据库确认没有事务：把本地的脏标志一起清掉，别让下一次重连再撞同一堵墙。
                if confirmed == Some(false) {
                    state.may_have_transaction = false;
                }
            }
            self.reopen(&mut state, timeout, reconnect)?;
            if readonly {
                self.raw_call("readOnly", &["true"], timeout)
                    .map_err(|e| Self::record_loss(&mut state, e, false))?;
            }
            return Ok(serde_json::json!({"autoCommit": state.auto_commit && !readonly}));
        }
        let connecting = matches!(cmd, "connect" | "connectProp");
        if state.lost && !connecting {
            return Err(BridgeError::new(
                "session-lost",
                "数据库会话已断开，请重新连接并核对事务状态",
            ));
        }
        // execFull / execFullBound 是导出与搬运的取数通道，语义上就是执行：
        // 少了它们会绕过只读策略、取消 epoch、以及「会话被用过」的标记。
        let execution = matches!(cmd, "exec" | "execBound" | "execFull" | "execFullBound");
        if execution
            && state
                .last_success
                .is_some_and(|t| t.elapsed() >= PROBE_AFTER)
        {
            match self.raw_call("probe", &[], PROBE_TIMEOUT) {
                Ok(v) if v.get("alive").and_then(Value::as_bool) == Some(true) => {}
                Ok(v) if v.get("alive").and_then(Value::as_bool).is_none() => {
                    return Err(BridgeError::new(
                        "probe-failed",
                        "连接探测未返回有效状态，SQL 尚未发送",
                    ));
                }
                Err(e) if e.code != "session-lost" && !connection_lost(&e.message) => {
                    return Err(BridgeError::new(
                        "probe-failed",
                        format!("连接探测失败，SQL 尚未发送。{}", e.message),
                    ));
                }
                _ => {
                    state.lost = true;
                    if state.session_used {
                        return Err(BridgeError::new("session-lost", "数据库会话已断开，当前 SQL 尚未发送。请核对旧会话的事务和设置后重新连接"));
                    }
                    self.reopen(&mut state, Duration::from_secs(15), reconnect)
                        .map_err(|e| {
                            BridgeError::new(
                                "session-lost",
                                format!(
                                    "数据库会话已断开，当前 SQL 尚未发送。重连失败：{}",
                                    e.message
                                ),
                            )
                        })?;
                }
            }
        }
        if self.closed.load(Ordering::Acquire) {
            return Err(BridgeError::new(
                "session-lost",
                "该会话已经关闭，SQL 尚未发送",
            ));
        }
        if execution && self.cancel_epoch.load(Ordering::Relaxed) != epoch {
            return Err(BridgeError::new(
                "sql",
                "ORA-01013：执行已取消，SQL 尚未发送",
            ));
        }
        if readonly
            && !matches!(
                cmd,
                "connect"
                    | "connectProp"
                    | "disconnect"
                    | "hello"
                    | "propList"
                    | "propCred"
                    | "ping"
            )
        {
            if let Err(e) = self.raw_call("readOnly", &["true"], timeout) {
                return Err(Self::record_loss(&mut state, e, false));
            }
        }
        if execution && self.cancel_epoch.load(Ordering::Relaxed) != epoch {
            return Err(BridgeError::new(
                "sql",
                "ORA-01013：执行已取消，SQL 尚未发送",
            ));
        }
        let sql = args.first().copied().unwrap_or("");
        let stateful_execution = execution && !stateless_query(sql);
        if cmd == "setSchema" || stateful_execution {
            state.session_used = true;
        }
        let result = match &self.inner {
            Engine::Java { bridge, sid } => match bridge.call_in_session(sid, cmd, args, timeout) {
                Err(e) if e.code == "timeout" => {
                    let _ = bridge.send_cancel_in_session(sid);
                    Err(e)
                }
                other => other,
            },
            Engine::Rust(eng) => eng.call(cmd, args, timeout),
        };
        let result = result.map_err(|e| Self::record_loss(&mut state, e, !connecting))?;
        if connecting {
            *state = Recovery {
                auto_commit: result
                    .get("autoCommit")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                ..Recovery::default()
            };
        } else if cmd == "autocommit" {
            state.auto_commit = args.first() == Some(&"true");
        }
        // 只在执行成功之后更新事务标志：失败的 DML 走上面的 `?` 提前返回，
        // 不该把会话锁成「有未提交事务」（否则重新连接会被永久误拒，P1-1）。
        settle_transaction_flag(&mut state, cmd, sql, stateful_execution, readonly);
        if readonly && connecting {
            self.raw_call("readOnly", &["true"], timeout)?;
        }
        if cmd != "ping" {
            state.last_success = Some(Instant::now());
        }
        Ok(result)
    }

    fn reopen(
        &self,
        state: &mut Recovery,
        timeout: Duration,
        reconnect: impl FnOnce(bool) -> Result<Option<ReconnectArgs>, BridgeError>,
    ) -> Result<(), BridgeError> {
        if self.closed.load(Ordering::Acquire) {
            return Err(BridgeError::new("session-lost", "该会话已经关闭"));
        }
        let Some((cmd, args)) = reconnect(state.auto_commit)? else {
            return Err(BridgeError::new(
                "session-lost",
                "数据库会话已断开，当前 SQL 尚未发送，请重新连接",
            ));
        };
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let result = self.raw_call(cmd, &args, timeout)?;
        *state = Recovery {
            auto_commit: result
                .get("autoCommit")
                .and_then(Value::as_bool)
                .unwrap_or(state.auto_commit),
            last_success: Some(Instant::now()),
            ..Recovery::default()
        };
        Ok(())
    }

    fn record_loss(state: &mut Recovery, error: BridgeError, sent: bool) -> BridgeError {
        if error.code != "session-lost" && !connection_lost(&error.message) {
            return error;
        }
        state.lost = true;
        let hint = if sent {
            "数据库会话已断开，执行或事务结果需核对"
        } else {
            "数据库会话已断开，当前 SQL 尚未发送"
        };
        BridgeError::new("session-lost", format!("{hint}。{}", error.message))
    }

    /// 列中文名：`{names:{"表|列":中文名}, count:N}`。
    ///
    /// 两个引擎取数方式不同，但**组装只有一份**（[`crate::db_zh`]）：
    /// - Rust 引擎用绑定变量（`columnsZh`，表名不拼进 SQL）；
    /// - JVM 桥用通用只读 `query`。**不能用 `exec`**：它开头就 `closeCursor()`，
    ///   会把用户结果集的「加载更多」游标顶掉，表现为「跑完这句之后加载更多没了」。
    pub fn columns_zh(&self, tables: &str, timeout: Duration) -> Result<Value, BridgeError> {
        match &self.inner {
            Engine::Rust(_) => self.call("columnsZh", &[tables], timeout),
            Engine::Java { .. } => {
                let names = crate::db_zh::sanitize(tables);
                if names.is_empty() {
                    return Ok(serde_json::json!({ "names": {}, "count": 0 }));
                }
                let sql = crate::db_zh::select_sql(&names);
                let max = crate::db_zh::max_rows();
                let out = self.call("query", &[&sql, &max], timeout)?;
                crate::db_zh::names_from_rows(&out)
            }
        }
    }

    /// 取消正在执行的语句。**不占用** `call` 的调用锁——它要能在一条长查询等待期间插进去。
    ///
    /// 两个引擎都支持，但机制不同：JVM 桥走 `Statement.cancel()`（另一条线程发给服务器），
    /// 纯 Rust 走 vendored 驱动里的 `BreakHandle`（置原子位，阻塞读分片时读到并发 INTERRUPT 标记）。
    pub fn cancel(&self) -> Result<(), BridgeError> {
        self.cancel_epoch.fetch_add(1, Ordering::Relaxed);
        match &self.inner {
            Engine::Java { bridge, sid } => bridge.send_cancel_in_session(sid),
            Engine::Rust(eng) => eng.cancel(),
        }
    }

    pub fn alive(&self) -> bool {
        match &self.inner {
            Engine::Java { bridge, .. } => bridge.alive(),
            Engine::Rust(eng) => eng.alive(),
        }
    }

    /// 断开**这条连接**（不是杀进程）：别的连接可能还在用同一个 JVM。
    ///
    /// 最后一条会话释放后，`Arc<Bridge>` 归零触发进程退出——所以应用退出时不用额外收尾。
    pub fn shutdown(&self) {
        self.closed.store(true, Ordering::Release);
        match &self.inner {
            Engine::Java { bridge, sid } => {
                let _ = bridge.send_in_session(sid, "disconnect", &[]);
            }
            Engine::Rust(eng) => eng.shutdown(),
        }
    }

    /// 这个句柄背后的 Java 进程与 `env` 是不是同一套（java 路径与 classpath 都没变）。
    ///
    /// 变了就说明用户换了 NC home 或补装了驱动，旧进程里的驱动不对，得重建。
    /// 纯 Rust 引擎不看 `env`（它不用 NC 的 jar），永远算「没变」。
    pub fn matches_env(&self, env: &BridgeEnv) -> bool {
        match &self.inner {
            Engine::Java { bridge, .. } => {
                bridge.env().java == env.java && bridge.env().jars == env.jars
            }
            Engine::Rust(_) => true,
        }
    }
}

// ─────────────────── REF CURSOR 语句形态判定（P0 能力路由） ───────────────────

/// 这条语句**为什么**不能留在纯 Rust 引擎上跑。
///
/// 两种形态互斥，取更严重的那种（OUT 绑定是硬失败，取不到行是静默失败）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefcursorNeed {
    /// `begin open :1 for … end;` —— 游标是 **OUT 绑定参数**。
    /// Rust 驱动的 `BindParameters` 只有输入值，没有 OUT 方向，真库实测报
    /// `ORA-06550 / PLS-00707`（2026-10-31，`tests/db_refcursor_probe.rs` R4）。
    OutBind,
    /// 本地声明了 `sys_refcursor` 并 `open … for`，但**既没有** `dbms_sql.return_result`
    /// **也不在同一个块里 fetch**：Rust 能把块执行完，但行永远取不出来 —— 界面显示
    /// 「执行成功」却没有结果，比报错更难查。
    CursorWithoutResultSet,
}

impl RefcursorNeed {
    /// 给人看的一句话，写进结果里的 `fallback.reason`。
    pub fn reason(self) -> &'static str {
        match self {
            RefcursorNeed::OutBind => {
                "游标是 OUT 绑定参数（`open :1 for …`），纯 Rust 驱动没有 OUT 绑定"
            }
            RefcursorNeed::CursorWithoutResultSet => {
                "打开了游标却没有 dbms_sql.return_result，纯 Rust 驱动取不到行"
            }
        }
    }
}

/// 判定一条 SQL 要不要改走 JVM 桥。
///
/// **只认能安全识别的形态**，认不出就返回 `None`（留在原引擎，按原文报错）。
/// 宁可让用户在老路径上看到 `PLS-00707`，也不要瞎猜着把语句发到另一个引擎去——
/// 那会把「一条语句失败」变成「一条语句悄悄跑在另一个会话/事务里」。
pub fn refcursor_need(sql: &str) -> Option<RefcursorNeed> {
    let code = strip_literals(sql);
    let mut out_bind = false;
    let mut opens_ident_for = false;
    for (at, _) in code.match_indices("open") {
        if !word_boundary(&code, at, 4) {
            continue;
        }
        let rest = code[at + 4..].trim_start();
        if let Some(after_colon) = rest.strip_prefix(':') {
            // `open :1 for`：冒号后面是数字占位符，再往后必须是 for
            let digits = after_colon.len()
                - after_colon
                    .trim_start_matches(|c: char| c.is_ascii_digit())
                    .len();
            if digits > 0 && after_colon[digits..].trim_start().starts_with("for") {
                out_bind = true;
            }
        } else if rest.starts_with(|c: char| c.is_alphabetic() || c == '_') {
            // `open rc for`：标识符形态。名字不校验（可能是包里的游标），后面跟 for 就算
            let name_len = rest
                .char_indices()
                .find(|(_, c)| !(c.is_ascii_alphanumeric() || matches!(c, '_' | '$' | '#')))
                .map(|(i, _)| i)
                .unwrap_or(rest.len());
            if rest[name_len..].trim_start().starts_with("for") {
                opens_ident_for = true;
            }
        }
    }
    if out_bind {
        return Some(RefcursorNeed::OutBind);
    }
    // `return_result` 是 Rust 已经支持的那条路（隐式结果集，多结果集标签都有），必须放行；
    // `fetch` 说明这个块自己把游标消费掉了，没有「取不出来的行」这回事
    if code.contains("sys_refcursor")
        && !code.contains("return_result")
        && !code.contains("fetch")
        && opens_ident_for
    {
        return Some(RefcursorNeed::CursorWithoutResultSet);
    }
    None
}

/// 去掉字符串常量与注释（顺便转小写），避免 `'open :1 for'` 这种字面量被当成真语句。
///
/// 逐字节处理：只有 ASCII 会变（大小写折叠），其余字节原样拷贝，所以结果仍是合法 UTF-8。
pub fn readonly_query(sql: &str) -> bool {
    let code = strip_literals(sql).to_ascii_lowercase();
    let words: Vec<&str> = code
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .filter(|w| !w.is_empty())
        .collect();
    matches!(words.first(), Some(&"select") | Some(&"with"))
        && !code.trim_end().trim_end_matches(';').contains(';')
        && !words.iter().any(|w| {
            matches!(
                *w,
                "insert"
                    | "update"
                    | "delete"
                    | "merge"
                    | "alter"
                    | "drop"
                    | "create"
                    | "begin"
                    | "declare"
                    | "commit"
                    | "rollback"
                    | "function"
                    | "procedure"
                    | "into"
            )
        })
}
fn stateless_query(sql: &str) -> bool {
    let code = strip_literals(sql).to_ascii_lowercase();
    let identifier = |c: char| c.is_alphanumeric() || matches!(c, '_' | '$' | '#');
    if !readonly_query(sql)
        || code
            .split(|c| !identifier(c))
            .any(|word| matches!(word, "currval" | "nextval"))
    {
        return false;
    }
    // Grouping, pagination subqueries and ordinary aggregates do not retain
    // state. A qualified, quoted or unknown function may modify package state.
    code.match_indices('(').all(|(at, _)| {
        let prefix = code[..at].trim_end();
        let start = prefix.trim_end_matches(identifier).len();
        let qualifier = prefix[..start].trim_end();
        if qualifier.ends_with(['.', '"']) {
            return false;
        }
        matches!(
            &prefix[start..],
            "" | "select"
                | "from"
                | "in"
                | "exists"
                | "where"
                | "and"
                | "or"
                | "not"
                | "as"
                | "count"
                | "sum"
                | "avg"
                | "min"
                | "max"
        )
    })
}

fn strip_literals(sql: &str) -> String {
    let b = sql.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'\'' => {
                i += 1;
                while i < b.len() {
                    if b[i] == b'\'' {
                        if i + 1 < b.len() && b[i + 1] == b'\'' {
                            i += 2;
                            continue;
                        }
                        i += 1;
                        break;
                    }
                    i += 1;
                }
                out.push(b' ');
            }
            b'-' if i + 1 < b.len() && b[i + 1] == b'-' => {
                while i < b.len() && b[i] != b'\n' {
                    i += 1;
                }
                out.push(b' ');
            }
            b'/' if i + 1 < b.len() && b[i + 1] == b'*' => {
                i += 2;
                while i + 1 < b.len() && !(b[i] == b'*' && b[i + 1] == b'/') {
                    i += 1;
                }
                i = (i + 2).min(b.len());
                out.push(b' ');
            }
            c => {
                out.push(c.to_ascii_lowercase());
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `word`（长度 `len`）出现在 `at` 处时，两侧不能是标识符字符（`open_x` / `reopen` 不算）。
fn word_boundary(s: &str, at: usize, len: usize) -> bool {
    let is_word = |c: u8| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'$' | b'#');
    let b = s.as_bytes();
    let before_ok = at == 0 || !is_word(b[at - 1]);
    let after_ok = at + len >= b.len() || !is_word(b[at + len]);
    before_ok && after_ok
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn configured_reconnect_refuses_potentially_untracked_transaction() {
        let engine = EngineHandle::rust();
        engine.recovery.lock().unwrap().may_have_transaction = true;
        let error = engine
            .call_guarded("reconnectConfigured", &[], PROBE_TIMEOUT, |_| {
                panic!("不能替换可能有未提交写入的会话")
            })
            .unwrap_err();
        assert_eq!(error.code, "sql");
        assert!(error.message.contains("请先提交或回滚"));
    }

    // ── P1-1：手写大写 COMMIT / 执行失败的 DML 不该把会话锁成「有未提交事务」 ──

    /// 真源裁决的四种组合：本地脏计数不能压过数据库的「没有事务」。
    #[test]
    fn db_truth_overrides_stale_local_transaction_counter() {
        // 真源说没有：本地两个计数器都脏着，也必须放行
        assert!(!reconnect_blocked(Some(false), true, 7));
        // 真源说有：即使本地一条都没记（PL/SQL 内部开的事务），也要拦
        assert!(reconnect_blocked(Some(true), false, 0));
        // 真源不可读：完全退回本地判定，两种脏状态都拦、干净状态放行
        assert!(reconnect_blocked(None, true, 0));
        assert!(reconnect_blocked(None, false, 3));
        assert!(!reconnect_blocked(None, false, 0));
    }

    #[test]
    fn uppercase_commit_clears_pending_transaction_flag() {
        for sql in ["COMMIT", "RoLlBaCk"] {
            let mut st = Recovery {
                may_have_transaction: true,
                ..Recovery::default()
            };
            settle_transaction_flag(&mut st, "exec", sql, true, false);
            assert!(!st.may_have_transaction, "大写 {sql:?} 应清掉标志");
        }
    }

    #[test]
    fn commit_with_trailing_semicolons_clears_flag() {
        for sql in ["commit;", "COMMIT;;;", "COMMIT ;"] {
            let mut st = Recovery {
                may_have_transaction: true,
                ..Recovery::default()
            };
            settle_transaction_flag(&mut st, "exec", sql, true, false);
            assert!(!st.may_have_transaction, "带分号的 {sql:?} 应清掉标志");
        }
    }

    #[test]
    fn commit_with_comments_clears_flag() {
        for sql in ["-- 说明\nCOMMIT;", "/* c */ ROLLBACK;", "COMMIT; -- 说明"] {
            let mut st = Recovery {
                may_have_transaction: true,
                ..Recovery::default()
            };
            settle_transaction_flag(&mut st, "exec", sql, true, false);
            assert!(!st.may_have_transaction, "带注释的 {sql:?} 应清掉标志");
        }
    }

    /// thin 驱动 TTC 错位是永久性的，必须判成连接丢失，不能让界面继续复用坏连接。
    #[test]
    fn unknown_ttc_message_type_is_connection_lost() {
        for message in [
            "internal error: unknown TTC message type 32 at packet 1, offset 11",
            "internal error: unknown TTC message type 0 at packet 1, offset 2482",
            "internal error: unknown TTC message type 50 at packet 1, offset 11",
        ] {
            assert!(connection_lost(message), "{message}");
        }
        assert!(!connection_lost("ORA-00942: table or view does not exist"));
    }

    #[test]
    fn failed_dml_does_not_set_transaction_flag() {
        let engine = EngineHandle::rust();
        // 空引擎执行必然失败；关键是失败路径不能把标志置起来
        let err = engine
            .call_guarded("exec", &["UPDATE t SET x = 1"], PROBE_TIMEOUT, |_| {
                panic!("失败的 DML 不该触发重连")
            })
            .unwrap_err();
        assert!(
            !engine.recovery.lock().unwrap().may_have_transaction,
            "执行失败的 DML 不该把会话锁成有未提交事务：{err}"
        );
    }

    #[test]
    fn expired_session_is_checked_before_sql_and_only_safe_sessions_can_reopen() {
        for session_used in [false, true] {
            let engine = EngineHandle::rust();
            {
                let mut state = engine.recovery.lock().unwrap();
                state.last_success = Some(Instant::now() - PROBE_AFTER);
                state.session_used = session_used;
                state.auto_commit = true;
            }
            let mut reconnects = 0;
            let error = engine
                .call_guarded("exec", &["select 1 from dual"], PROBE_TIMEOUT, |auto| {
                    assert!(auto, "恢复时沿用当前会话的事务模式");
                    reconnects += 1;
                    Err(BridgeError::new("need-password", "测试：需要口令"))
                })
                .unwrap_err();
            assert_eq!(error.code, "session-lost");
            assert!(error.message.contains("尚未发送"));
            assert_eq!(reconnects, usize::from(!session_used));
            assert!(engine.recovery.lock().unwrap().lost);
        }
    }

    #[test]
    fn connection_reset_after_dispatch_requires_explicit_reconnect() {
        let engine = EngineHandle::rust();
        let error = EngineHandle::record_loss(
            &mut engine.recovery.lock().unwrap(),
            BridgeError::new("sql", "stream operation failed (os error 10054)"),
            true,
        );
        assert_eq!(error.code, "session-lost");
        assert!(error.message.contains("结果需核对"));
        for cmd in ["exec", "commit", "more"] {
            let error = engine
                .call_guarded(cmd, &[], PROBE_TIMEOUT, |_| panic!("不可重连并重放"))
                .unwrap_err();
            assert_eq!(error.code, "session-lost");
        }
    }

    #[test]
    fn recovery_distinguishes_pagination_from_session_bound_expressions() {
        assert!(stateless_query(
            "select * from (select a.* from (select * from t) a where rownum <= 201) where rn > 0"
        ));
        assert!(stateless_query("select count(*) from t where id in (1, 2)"));
        assert!(!stateless_query("select pkg.count(*) from dual"));
        assert!(!stateless_query("select sequence_1.nextval from dual"));
        assert!(!stateless_query("select * from t for update"));
    }

    fn fake_bridge() -> Arc<Bridge> {
        Arc::new(Bridge::new(BridgeEnv {
            java: PathBuf::from("java"),
            jars: vec![PathBuf::from("a.jar")],
            config_dir: PathBuf::from("/tmp"),
            main_class: "NcDbBridge".into(),
            label: "数据库".into(),
            xmx_mb: 256,
        }))
    }

    #[test]
    fn java_引擎自报能力与实现一致() {
        let h = EngineHandle::java(fake_bridge(), "conn-1");
        assert_eq!(h.kind(), EngineKind::Java);
        let c = h.caps();
        // 这四个值必须与 NcDbBridge 的真实实现同步，改了实现要回来改这里
        assert!(c.cancel, "桥里 cancel 走 Statement.cancel()，不占调用锁");
        assert!(c.refcursor, "JDBC 支持 REF CURSOR");
        assert!(c.prop_decrypt, "桥里用 PropXMLReader 解 prop.xml");
        assert!(c.multi_session, "一个 JVM 带多条会话");
        assert!(
            c.sessions,
            "A1：v$session / v$locked_object 两个引擎都实现了"
        );
        assert!(c.stats, "A2：执行前后各读一次 v$mystat 取差值");
    }

    #[test]
    fn rust_引擎自报能力与实现一致() {
        let h = EngineHandle::rust();
        assert_eq!(h.kind(), EngineKind::Rust);
        let c = h.caps();
        // 这两条是驱动/架构的硬约束，实现改了要回来改这里
        assert!(
            c.cancel,
            "取消靠 vendor/oracledb 里的 BreakHandle 补丁（issue #24）"
        );
        // 只通了 `dbms_sql.return_result`，`open :1 for` 的 OUT 绑定仍不支持 ⇒ 整体不算有
        assert!(
            !c.refcursor,
            "REF CURSOR 只有一半：隐式结果集能出多结果集，OUT 绑定仍报 PLS-00707"
        );
        assert!(
            !c.prop_decrypt,
            "解 prop.xml 要用 NC 的 Java 类，Rust 侧调不到"
        );
        assert!(c.multi_session, "一条连接一个驱动会话，不存在进程底价");
        assert!(
            c.sessions,
            "A1：v$session / v$locked_object 直接查 v$session 系视图"
        );
        assert!(c.stats, "A2：v$mystat 前后差值，与 JVM 桥同一组统计项");
        // 按种类查表要和真实句柄一致
        assert_eq!(Caps::of(EngineKind::Rust).cancel, c.cancel);
        assert_eq!(
            Caps::of(EngineKind::Java).cancel,
            EngineHandle::java(fake_bridge(), "c").caps().cancel
        );
    }

    #[test]
    fn 引擎名解析认不出就回默认() {
        assert_eq!(EngineKind::parse("rust"), EngineKind::Rust);
        assert_eq!(EngineKind::parse(" RUST "), EngineKind::Rust);
        assert_eq!(EngineKind::parse("java"), EngineKind::Java);
        // 老配置里没有这个字段，反序列化出来是空串
        assert_eq!(EngineKind::parse(""), EngineKind::Java);
        assert_eq!(EngineKind::parse("oracle"), EngineKind::Java);
        assert_eq!(EngineKind::Rust.as_str(), "rust");
    }

    #[test]
    fn rust_句柄不看_classpath() {
        let h = EngineHandle::rust();
        // 纯 Rust 引擎不加载 NC 的 jar，所以 env 变了对它没影响（不能因此被重建）
        let env = BridgeEnv {
            java: PathBuf::from("java"),
            jars: vec![PathBuf::from("a.jar")],
            config_dir: PathBuf::from("/tmp"),
            main_class: "NcDbBridge".into(),
            label: "数据库".into(),
            xmx_mb: 256,
        };
        assert!(h.matches_env(&env));
    }

    #[test]
    fn 环境比对看_java_与_classpath() {
        let h = EngineHandle::java(fake_bridge(), "conn-1");
        let mut same = BridgeEnv {
            java: PathBuf::from("java"),
            jars: vec![PathBuf::from("a.jar")],
            config_dir: PathBuf::from("/tmp"),
            main_class: "NcDbBridge".into(),
            label: "数据库".into(),
            xmx_mb: 256,
        };
        assert!(h.matches_env(&same));
        same.java = PathBuf::from("另一个java");
        assert!(!h.matches_env(&same), "换了 java 就该重建");
        same.java = PathBuf::from("java");
        same.jars = vec![PathBuf::from("b.jar")];
        assert!(!h.matches_env(&same), "换了 classpath 就该重建");
    }

    // ── REF CURSOR 形态判定 ──
    //
    // 每条用例都对应一个「判错的后果」，不是凑数：
    // 判漏 = 用户在 Rust 引擎上撞 PLS-00707 或者拿到空结果；判多 = 语句被悄悄搬到
    // 另一条会话上执行（事务不再归这条连接管）。

    #[test]
    fn 占位符游标判为_out_bind() {
        // 真库实测原文（probe R4）：这条在 Rust 上必然 PLS-00707
        assert_eq!(
            refcursor_need(
                "begin open :1 for select table_name from all_tables where rownum <= 3; end;"
            ),
            Some(RefcursorNeed::OutBind)
        );
        // 多位数、大小写、空格变体
        assert_eq!(
            refcursor_need("BEGIN\n  OPEN :10 FOR select 1 from dual;\nEND;"),
            Some(RefcursorNeed::OutBind)
        );
        assert_eq!(
            refcursor_need("begin open:2 for select 1 from dual; end;"),
            Some(RefcursorNeed::OutBind)
        );
    }

    #[test]
    fn 本地游标没有_return_result_判为取不到行() {
        assert_eq!(
            refcursor_need("declare rc sys_refcursor; begin open rc for select 1 from dual; end;"),
            Some(RefcursorNeed::CursorWithoutResultSet)
        );
    }

    #[test]
    fn 已经支持的形态一律放行() {
        // 隐式结果集：Rust 侧早就能出多结果集了，绝不能把它搬去 JVM
        assert_eq!(
            refcursor_need(
                "declare rc sys_refcursor; begin open rc for select 1 from dual; \
                 dbms_sql.return_result(rc); end;"
            ),
            None
        );
        // 块自己 fetch 完了：没有「取不出来的行」这回事
        assert_eq!(
            refcursor_need(
                "declare rc sys_refcursor; n number; begin open rc for select 1 from dual; \
                 fetch rc into n; close rc; end;"
            ),
            None
        );
        // 普通语句与普通绑定变量都不是游标
        assert_eq!(
            refcursor_need("select * from bd_material where id = :1"),
            None
        );
        assert_eq!(
            refcursor_need("begin insert into t (a) values (:1); end;"),
            None
        );
        assert_eq!(refcursor_need("update t set a = 1 where b = 2"), None);
    }

    #[test]
    fn 字面量与注释里的形态不算() {
        // 报错信息 / 文档字符串里经常写着这句 SQL
        assert_eq!(
            refcursor_need(
                "select 'begin open :1 for select 1 from dual; end;' as sample from dual"
            ),
            None
        );
        assert_eq!(
            refcursor_need("-- begin open :1 for select 1 from dual;\nselect 1 from dual"),
            None
        );
        assert_eq!(refcursor_need("/* open :1 for */ select 1 from dual"), None);
        // 标识符里带 open 也不算（`reopen` / `open_flag`）
        assert_eq!(refcursor_need("select reopen, open_flag from t"), None);
    }
}

#[cfg(test)]
mod readonly_tests {
    use super::*;
    #[test]
    fn accepts_selects_ctes_comments_and_string_literals() {
        for sql in [
            "select 'update delete; begin' from dual",
            "-- delete\nselect * from t",
            "with q as (select 1 x from dual) select * from q",
            "select 1 from dual;",
        ] {
            assert!(readonly_query(sql), "{sql}");
        }
    }
    #[test]
    fn rejects_write_lock_plsql_and_multiple_statement_paths() {
        for sql in [
            "update t set x=1",
            "select * from t for update",
            "begin null; end;",
            "with function f return number is begin return 1; end; select f() from dual",
            "select 1 from dual; delete from t",
            "commit",
            "alter session set current_schema=x",
        ] {
            assert!(!readonly_query(sql), "{sql}");
        }
    }
    #[test]
    fn policy_blocks_primary_slot_and_bound_write_before_driver_execution() {
        let policy = Arc::new(std::sync::RwLock::new(true));
        let primary = EngineHandle::rust().with_policy(policy.clone());
        let slot = EngineHandle::rust().with_policy(policy);
        for h in [&primary, &slot] {
            for cmd in ["exec", "execBound", "execFull", "execFullBound", "query"] {
                assert_eq!(
                    h.call(cmd, &["delete from t"], Duration::from_secs(1))
                        .unwrap_err()
                        .code,
                    "readonly"
                );
            }
        }
    }
}
