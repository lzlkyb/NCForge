//! 数据库引擎抽象：把「用什么驱动连 Oracle」从命令层里摘出来。
//!
//! 为什么要有这一层：`commands/db_cmds.rs` 里那九百多行，本质全是「拼一行命令 →
//! 拿回制表符分隔的文本」，与底下是 JDBC 还是纯 Rust 驱动毫无关系。抽出来以后换引擎
//! 只需在 [`Engine`] 里加一个分支，命令层一个字都不用改。
//!
//! 目前只有 [`EngineKind::Java`]（常驻 JVM + `NcDbBridge`）一种实现。二期要接的
//! 纯 Rust 驱动（`oracledb`）能力与它**不一致**，所以这里用 [`Caps`] 把差异显式化：
//! 前端拿它决定「停止」按钮能不能用、哪些来源的连接不支持，而不是让用户撞上去才发现。

use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;

use crate::db_bridge::{Bridge, BridgeEnv, BridgeError};

/// 引擎种类。前端与日志里用它区分「这次查询走的是哪条路」。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EngineKind {
    /// 常驻 JVM + JDBC（`NcDbBridge`），能力最全。
    Java,
    /// 纯 Rust 驱动（`oracledb`）。**尚未实现**，接口位先留好。
    Rust,
}

impl EngineKind {
    pub fn label(self) -> &'static str {
        match self {
            EngineKind::Java => "JVM 桥",
            EngineKind::Rust => "纯 Rust 驱动",
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
    /// JVM 桥。`cancel` / `multi_session` 在 A 方案落地后转 `true`，其余本来就有。
    pub const JAVA: Caps = Caps {
        cancel: true,
        refcursor: true,
        prop_decrypt: true,
        multi_session: true,
    };

    /// 纯 Rust 驱动的**预期**能力（二期接入时按实测校正）：
    /// 驱动没有 break/cancel API（oracle/rust-oracledb#24 官方确认要等 async API）、
    /// REF CURSOR 实测 `PLS-00707`、prop.xml 解密只能另起一次性 JVM。
    pub const RUST: Caps = Caps {
        cancel: false,
        refcursor: false,
        prop_decrypt: false,
        multi_session: true,
    };
}

enum Engine {
    /// `sid` 是这个连接在共享 JVM 里的会话名（用连接 id，天然唯一）。
    Java { bridge: Arc<Bridge>, sid: String },
}

/// 一条连接背后的执行器。对外只暴露「跑命令」，不暴露底下是进程还是线程。
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

    pub fn kind(&self) -> EngineKind {
        match self.inner {
            Engine::Java { .. } => EngineKind::Java,
        }
    }

    pub fn caps(&self) -> Caps {
        match self.inner {
            Engine::Java { .. } => Caps::JAVA,
        }
    }

    /// 跑一条命令，返回桥给的 `data` 对象。
    ///
    /// 阻塞调用（内部等 stdout 行），调用方要放在 `spawn_blocking` 里。
    ///
    /// 超时按「发取消、不杀进程」处置：一个 JVM 里通常还有别的连接，
    /// 为一个慢查询杀掉进程会把它们一起带走。取消要带上会话名，所以由这里补发。
    pub fn call(
        &self,
        cmd: &str,
        args: &[&str],
        timeout: Duration,
    ) -> Result<Value, BridgeError> {
        match &self.inner {
            Engine::Java { bridge, sid } => {
                match bridge.call_in_session(sid, cmd, args, timeout) {
                    Err(e) if e.code == "timeout" => {
                        let _ = bridge.send_cancel_in_session(sid);
                        Err(e)
                    }
                    other => other,
                }
            }
        }
    }

    /// 取消正在执行的语句。**不占用** `call` 的调用锁——它要能在一条长查询等待期间插进去。
    pub fn cancel(&self) -> Result<(), BridgeError> {
        match &self.inner {
            Engine::Java { bridge, sid } => bridge.send_cancel_in_session(sid),
        }
    }

    pub fn alive(&self) -> bool {
        match &self.inner {
            Engine::Java { bridge, .. } => bridge.alive(),
        }
    }

    /// 断开**这条会话**（不是杀进程）：别的连接可能还在用同一个 JVM。
    ///
    /// 最后一条会话释放后，`Arc<Bridge>` 归零触发进程退出——所以应用退出时不用额外收尾。
    pub fn shutdown(&self) {
        match &self.inner {
            Engine::Java { bridge, sid } => {
                let _ = bridge.send_in_session(sid, "disconnect", &[]);
            }
        }
    }

    /// 这个句柄背后的 Java 进程与 `env` 是不是同一套（java 路径与 classpath 都没变）。
    ///
    /// 变了就说明用户换了 NC home 或补装了驱动，旧进程里的驱动不对，得重建。
    pub fn matches_env(&self, env: &BridgeEnv) -> bool {
        match &self.inner {
            Engine::Java { bridge, .. } => {
                bridge.env().java == env.java && bridge.env().jars == env.jars
            }
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
