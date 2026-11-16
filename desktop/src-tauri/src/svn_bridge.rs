//! SVN 桥：常驻 JVM + 行协议。协议本体在 `java_bridge.rs`，这里只有 SVN 专属的部分。
//!
//! **硬性约束：必须传 `--config <自己的目录>`。** 不给的话 SVNKit 会读写用户的
//! `%APPDATA%\Subversion\auth`，实测会把已缓存的密码**改写成只剩用户名**（踩过两次，
//! 见 `docs/交接清单-2026-10-27.md` 的 5.5 节）。
//!
//! Jar 列表固定在 `BRIDGE_JARS`。SVNKit 用 **1.10.11**：它内部保留了 format 10
//! （SVN 1.6「每目录一份元数据」）的完整旧实现（`wc2.old.*`），实测对老副本做
//! commit/update/revert/add/delete/blame **不会升级工作副本格式**；同时能读 1.7+
//! 新格式（根目录一份 `.svn/wc.db`）。旧注释「SVNKit 1.8+ 不支持 format 10」是错的。
//! 之前带 1.3.5 只能读 format 10，遇到用户的新格式副本会报
//! 「appears to be part of Subversion 1.7 (SVNKit 1.4) or greater」——升级即为修这个。
//!
//! 文件名**不带版本号**：升级只换内容不改名，`BRIDGE_JARS`/打包清单/错误文案都稳定。
//! 依赖按官方 1.10.11 pom 对齐：sqljet 1.1.15 / antlr-runtime 3.4 / sequence-library 1.0.4 /
//! lz4-java 1.4.1（commit 必需，缺了报 `NoClassDefFoundError: net.jpountz.lz4.LZ4Factory`）/
//! trilead-ssh2 build222（svn+ssh）。jna/sshd/jsch 是可选 keyring/SSH 传输，桥用自有
//! config 目录 + trilead，不需要。

use std::path::{Path, PathBuf};

pub use crate::java_bridge::{encode_request, Bridge, BridgeEnv, BridgeError};

/// 桥需要的 jar 列表（顺序无所谓，classpath 是并列的）。
pub const BRIDGE_JARS: [&str; 7] = [
    "ncsvn.jar",
    "svnkit.jar",
    "trilead.jar",
    "sqljet.jar",
    "antlr-runtime.jar",
    "sequence-library.jar",
    "lz4-java.jar",
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
