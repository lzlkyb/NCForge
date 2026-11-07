//! 测试专用小工具。`#[cfg(test)]` 下才编译，不影响发布产物。
//!
//! 目前只有一件事：给出**规范化后**的临时目录。存在的理由是 2026-11-06 那批
//! 只在 CI 上红的测试。

use std::path::PathBuf;

/// 取一个干净的临时目录，返回**规范化后**的路径。
///
/// 为什么必须 `canonicalize`：
///   · macOS 的 `std::env::temp_dir()` 是 `/var/folders/...`，而 `/var` 本身是
///     `/private/var` 的符号链接。产品代码（`canonicalize`、`strip_verbatim`）
///     给出的是 `/private/var/...`，两边字符串不一致，于是断言只在该平台红。
///   · Windows CI 的用户名是 8.3 短名（`C:\Users\RUNNER~1`），与展开后的长名同理。
///
/// 这两类差异**本地 Windows 全绿时完全看不到**（本地用户名不是短名、临时目录也
/// 不是符号链接），所以只能靠「测试侧先规范化」这条纪律提前消掉。
///
/// 语义：同名目录先删后建，测试可以重复跑；返回的路径已存在且绝对。
pub fn tmp(tag: &str) -> PathBuf {
    let raw = std::env::temp_dir().join(format!("ncf-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&raw);
    std::fs::create_dir_all(&raw).expect("建临时目录");
    raw.canonicalize().unwrap_or(raw)
}

/// 同 [`tmp`]，但用给定名字（不拼 pid），用于需要固定目录名的场景。
///
/// 注意：固定名字意味着并发跑同一测试会互相踩 —— 只在确实要求稳定路径时用。
#[allow(dead_code)]
pub fn tmp_named(name: &str) -> PathBuf {
    let raw = std::env::temp_dir().join(name);
    let _ = std::fs::remove_dir_all(&raw);
    std::fs::create_dir_all(&raw).expect("建临时目录");
    raw.canonicalize().unwrap_or(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tmp_返回已存在且已规范化的绝对路径() {
        let d = tmp("self-check");
        assert!(d.is_absolute(), "应当是绝对路径：{d:?}");
        assert!(d.is_dir(), "应当已经建好：{d:?}");
        // 规范化过的路径再 canonicalize 应当不变（符号链接已经解开）
        assert_eq!(d.canonicalize().unwrap(), d, "返回的路径必须已经是规范形式");
    }

    #[test]
    fn tmp_可重复调用_同名目录先清空() {
        let d = tmp("repeat");
        std::fs::write(d.join("leftover.txt"), b"x").unwrap();
        let again = tmp("repeat");
        assert_eq!(d, again);
        assert!(!again.join("leftover.txt").exists(), "同名目录应先删后建");
    }
}
