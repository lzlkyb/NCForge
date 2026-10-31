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

use std::sync::Arc;
use std::time::Duration;

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
}

impl EngineHandle {
    pub fn java(bridge: Arc<Bridge>, session_id: impl Into<String>) -> Self {
        Self {
            inner: Engine::Java {
                bridge,
                sid: session_id.into(),
            },
        }
    }

    pub fn rust() -> Self {
        Self {
            inner: Engine::Rust(Box::default()),
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
        match &self.inner {
            Engine::Java { bridge, sid } => match bridge.call_in_session(sid, cmd, args, timeout) {
                Err(e) if e.code == "timeout" => {
                    let _ = bridge.send_cancel_in_session(sid);
                    Err(e)
                }
                other => other,
            },
            Engine::Rust(eng) => eng.call(cmd, args, timeout),
        }
    }

    /// 取消正在执行的语句。**不占用** `call` 的调用锁——它要能在一条长查询等待期间插进去。
    ///
    /// 两个引擎都支持，但机制不同：JVM 桥走 `Statement.cancel()`（另一条线程发给服务器），
    /// 纯 Rust 走 vendored 驱动里的 `BreakHandle`（置原子位，阻塞读分片时读到并发 INTERRUPT 标记）。
    pub fn cancel(&self) -> Result<(), BridgeError> {
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
