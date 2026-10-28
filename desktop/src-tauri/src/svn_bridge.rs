//! SVN 桥：常驻 JVM + 行协议。协议本体在 `java_bridge.rs`，这里只有 SVN 专属的部分。
//!
//! **硬性约束：必须传 `--config <自己的目录>`。** 不给的话 SVNKit 会读写用户的
//! `%APPDATA%\Subversion\auth`，实测会把已缓存的密码**改写成只剩用户名**（踩过两次，
//! 见 `docs/交接清单-2026-10-27.md` 的 5.5 节）。
//!
//! Jar 列表固定在 `BRIDGE_JARS`：工作副本是 format 10（SVN 1.6 时代「每目录一份元数据」），
//! 命令行 svn 1.7+ 与 SVNKit 1.8+ 都不支持，只能带 SVNKit 1.3.5。

use std::path::{Path, PathBuf};

pub use crate::java_bridge::{encode_request, Bridge, BridgeEnv, BridgeError};

/// 桥需要的 jar 列表（顺序无所谓，classpath 是并列的）。
pub const BRIDGE_JARS: [&str; 5] = [
    "ncsvn.jar",
    "svnkit.jar",
    "trilead.jar",
    "sqljet.1.0.4.jar",
    "antlr-runtime-3.1.3.jar",
];

/// 在候选目录里找齐所有 jar，返回 (jar 列表, 所在目录)。
pub fn find_jars(dirs: &[PathBuf]) -> Option<(Vec<PathBuf>, PathBuf)> {
    for dir in dirs {
        let mut jars = Vec::with_capacity(BRIDGE_JARS.len());
        let mut ok = true;
        for name in BRIDGE_JARS {
            let p = dir.join(name);
            if p.is_file() {
                jars.push(p);
            } else {
                ok = false;
                break;
            }
        }
        if ok {
            return Some((jars, dir.clone()));
        }
    }
    None
}

/// 桥的工作目录是否存在（不存在则建）。
pub fn ensure_dir(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("创建目录失败 {dir:?}: {e}"))
}

/// 组装 SVN 桥的环境：主类固定，堆 384M 够用（blame 大文件也够）。
pub fn env(java: PathBuf, jars: Vec<PathBuf>, config_dir: PathBuf) -> BridgeEnv {
    BridgeEnv {
        java,
        jars,
        config_dir,
        main_class: "NcSvnBridge".to_string(),
        label: "SVN".to_string(),
        xmx_mb: 384,
    }
}
