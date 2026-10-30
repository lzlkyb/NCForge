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
    /// 能从 PL/SQL 取 REF CURSOR。
    pub refcursor: bool,
    /// 能解 NC `prop.xml` 里加密的口令（要用 NC 自带的 `PropXMLReader`，只在 JVM 里可用）。
    pub prop_decrypt: bool,
    /// 一个进程能带多条连接。为 `false` 时内存随连接数线性增长。
    pub multi_session: bool,
}

impl Caps {
    /// JVM 桥。四条都有：取消靠 `Statement.cancel()`，一个 JVM 带多条会话（A 方案）。
    pub const JAVA: Caps = Caps {
        cancel: true,
        refcursor: true,
        prop_decrypt: true,
        multi_session: true,
    };

    /// 纯 Rust 驱动的能力（2026-10-30 按 `db_rust.rs` + vendored 驱动的实际实现校正）：
    /// - `cancel`：**有**。上游 issue #24 没有 break API，我们在 `vendor/oracledb` 里补了
    ///   `BreakHandle`（切片读 + INTERRUPT 标记），见该目录 `FORK.md`。
    /// - `refcursor`：没有。实测 `PLS-00707`。
    /// - `prop_decrypt`：仍然没有 —— 解 prop.xml 要用 NC 的 Java 类。但连接可以工作：
    ///   首次连接时由 JVM 桥解一次口令、DPAPI 存起来（`db_cmds::prop_password_ready`）。
    /// - `multi_session`：有。每条连接一个 `Connection`，内存本来就与连接数同阶。
    pub const RUST: Caps = Caps {
        cancel: true,
        refcursor: false,
        prop_decrypt: false,
        multi_session: true,
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
        assert!(!c.refcursor, "REF CURSOR 实测 PLS-00707");
        assert!(
            !c.prop_decrypt,
            "解 prop.xml 要用 NC 的 Java 类，Rust 侧调不到"
        );
        assert!(c.multi_session, "一条连接一个驱动会话，不存在进程底价");
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
}
