//! 撤销 / 冲突备份目录（`.ncforge-<kind>-<毫秒时间戳>`）的盘点与清理。
//!
//! 撤销和冲突二选一在落盘前都会把原文件拷一份到工作副本**上一级**
//! （`commands::svn_cmds::backup_root`）——那一步救过命，但目录只增不删：
//! 一个工程干上几个月，旁边就散着几十上百个 `.ncforge-revert-*`，没人知道
//! 哪个还能删、删了会不会后悔。这个模块只做两件事：**列出来**（几个文件、
//! 多大、什么时候）和**按名字精确删掉指定的那几个**。
//!
//! 删除是全仓唯一的「删用户目录」动作，所以校验放在这一层而不是命令层：
//! ① 目录名必须是我们自己写的那个形状；② 父目录必须是调用方给的基线目录之一
//! （canonicalize 后逐个比）；③ 不跟随符号链接。任何一条不满足就拒绝——
//! 宁可少删一个，也不能删错一个。

use std::path::{Path, PathBuf};

/// 目录名前缀：与 `svn_cmds::backup_root` 的 `format!(".ncforge-{tag}-{ts}")` 对齐。
const PREFIX: &str = ".ncforge-";

/// 统计时的条目上限。备份目录是我们自己拷出来的文件（几个到几十个），
/// 正常永远碰不到这个数；设上限只是防止有人往里面手动塞了棵大树把界面卡死。
const MAX_ENTRIES: usize = 50_000;

/// 一个备份目录。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupDir {
    /// 目录名（删除时前端回传的就是它，不传路径）。
    pub name: String,
    pub path: String,
    /// `revert`（撤销本地改动）/ `resolve`（冲突二选一）。
    pub kind: String,
    pub files: usize,
    pub bytes: u64,
    /// 目录名里的时间戳（毫秒），用于「什么时候备份的」。
    pub at_ms: u64,
}

/// 目录名 → (kind, 毫秒时间戳)。只认我们自己写的那两种，其余一律 None。
pub fn parse_name(name: &str) -> Option<(&'static str, u64)> {
    let rest = name.strip_prefix(PREFIX)?;
    let (kind, ts) = match rest.strip_prefix("revert-") {
        Some(t) => ("revert", t),
        None => ("resolve", rest.strip_prefix("resolve-")?),
    };
    // 纯 ASCII 数字、非空、不超过 20 位（毫秒时间戳 13 位；限长度是防 parse 溢出）
    if ts.is_empty() || ts.len() > 20 || !ts.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((kind, ts.parse::<u64>().ok()?))
}

/// 递归统计（文件数, 字节数）。不跟符号链接、不跟目录联接的另一侧。
pub fn dir_size(dir: &Path) -> (usize, u64) {
    let mut files = 0usize;
    let mut bytes = 0u64;
    let mut stack = vec![dir.to_path_buf()];
    let mut seen = 0usize;
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else {
            continue;
        };
        for e in entries.flatten() {
            seen += 1;
            if seen > MAX_ENTRIES {
                return (files, bytes);
            }
            let Ok(t) = e.file_type() else { continue };
            if t.is_symlink() {
                continue;
            }
            if t.is_dir() {
                stack.push(e.path());
            } else if t.is_file() {
                files += 1;
                if let Ok(md) = e.metadata() {
                    bytes += md.len();
                }
            }
        }
    }
    (files, bytes)
}

/// 盘点一个基线目录下的备份（按时间倒序）。目录不存在就是空的。
pub fn scan(base: &Path) -> Vec<BackupDir> {
    let Ok(entries) = std::fs::read_dir(base) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for e in entries.flatten() {
        let Some(name) = e.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let Some((kind, at_ms)) = parse_name(&name) else {
            continue;
        };
        // symlink_metadata：符号链接在这里不是目录（is_dir 为 false），直接跳过——
        // 删一个指向别处的链接等于删别处。
        let Ok(md) = std::fs::symlink_metadata(e.path()) else {
            continue;
        };
        if !md.is_dir() {
            continue;
        }
        let (files, bytes) = dir_size(&e.path());
        out.push(BackupDir {
            name,
            path: e.path().display().to_string(),
            kind: kind.to_string(),
            files,
            bytes,
            at_ms,
        });
    }
    out.sort_by_key(|b| std::cmp::Reverse(b.at_ms));
    out
}

/// 跨多个基线目录盘点（工作副本上一级 + 配置目录），按时间倒序、按路径去重。
///
/// 基线之间可能指向同一个物理目录（配置目录恰好是工作副本上一级，或调用方把
/// 同一路径写成 `D:\a` 与 `D:\a\`）：先按 canonicalize 后的值给基线去重，
/// 否则同一批备份会在列表里出现两遍，文件数与体积也跟着双算。
/// 去重只用规范化结果做 key，实际扫描仍用原写法——`canonicalize` 在 Windows 上
/// 会带上 `\\?\` 前缀，那玩意不能进 `BackupDir.path`（界面要显示它）。
pub fn scan_all(bases: &[PathBuf]) -> Vec<BackupDir> {
    let mut out: Vec<BackupDir> = Vec::new();
    let mut seen: Vec<PathBuf> = Vec::new();
    for base in bases {
        let key = base.canonicalize().unwrap_or_else(|_| base.clone());
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        for d in scan(base) {
            if !out.iter().any(|x| x.path == d.path) {
                out.push(d);
            }
        }
    }
    out.sort_by_key(|b| std::cmp::Reverse(b.at_ms));
    out
}

/// 把一个名字解析成**确认可删**的绝对路径。
///
/// 三道门：名字形状、父目录白名单（canonicalize 后比）、不是符号链接。
pub fn confirm_target(bases: &[PathBuf], name: &str) -> Result<PathBuf, String> {
    if parse_name(name).is_none() {
        return Err(format!("「{name}」不是工作台生成的备份目录名，拒绝删除"));
    }
    for base in bases {
        let cand = base.join(name);
        let Ok(md) = std::fs::symlink_metadata(&cand) else {
            continue;
        };
        if !md.is_dir() {
            continue;
        }
        let (Ok(cb), Ok(cc)) = (base.canonicalize(), cand.canonicalize()) else {
            continue;
        };
        // 规范化后父目录必须正好是基线目录：`..`、大小写变体、链接都被这一步挡掉
        if cc.parent() == Some(cb.as_path()) {
            return Ok(cc);
        }
    }
    Err(format!("「{name}」不在允许的备份目录里，拒绝删除"))
}

/// 删掉一个备份目录，返回释放的字节数。
pub fn delete(bases: &[PathBuf], name: &str) -> Result<u64, String> {
    let path = confirm_target(bases, name)?;
    let (_, bytes) = dir_size(&path);
    std::fs::remove_dir_all(&path).map_err(|e| format!("删除 {} 失败: {e}", path.display()))?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "ncforge-bk-test-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn 目录名只认我们自己写的那两种() {
        assert_eq!(
            parse_name(".ncforge-revert-1761750000000"),
            Some(("revert", 1_761_750_000_000))
        );
        assert_eq!(
            parse_name(".ncforge-resolve-1761749000000"),
            Some(("resolve", 1_761_749_000_000))
        );
        // 形状不对的一律不认
        for bad in [
            ".ncforge-revert-",
            ".ncforge-revert-abc",
            ".ncforge-other-1761750000000",
            "ncforge-revert-1761750000000",
            ".ncforge-revert-1761750000000.bak",
            ".ncforge-revert-17617500000001234567890123",
        ] {
            assert_eq!(parse_name(bad), None, "{bad} 不该被认成备份目录");
        }
    }

    #[test]
    fn 盘点只列备份目录且按时间倒序() {
        let base = temp_dir("scan");
        std::fs::create_dir_all(base.join(".ncforge-revert-1000")).unwrap();
        std::fs::write(base.join(".ncforge-revert-1000/a.java"), b"hello").unwrap();
        std::fs::create_dir_all(base.join(".ncforge-resolve-2000/sub")).unwrap();
        std::fs::write(base.join(".ncforge-resolve-2000/sub/b.txt"), b"12345").unwrap();
        // 干扰项：名字不合规、以及同名但是文件
        std::fs::create_dir_all(base.join("待上线补丁")).unwrap();
        std::fs::write(base.join(".ncforge-revert-3000"), b"not a dir").unwrap();

        let list = scan(&base);
        assert_eq!(list.len(), 2, "只该列出两个真正的备份目录");
        assert_eq!(list[0].name, ".ncforge-resolve-2000", "时间新的排前面");
        assert_eq!(list[0].files, 1);
        assert_eq!(list[0].bytes, 5);
        assert_eq!(list[1].kind, "revert");
        assert_eq!(list[1].bytes, 5);

        // 跨基线去重：同一个目录传两次也只出现一次
        let all = scan_all(&[base.clone(), base.clone()]);
        assert_eq!(all.len(), 2);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn 同一目录的两种写法不会把备份列两遍() {
        let base = temp_dir("scan-dup");
        std::fs::create_dir_all(base.join(".ncforge-revert-1000")).unwrap();
        std::fs::write(base.join(".ncforge-revert-1000/a.java"), b"hello").unwrap();

        // 以前去重是按 `path` 字符串比：基线目录被写成 `D:\x` 与 `D:\x\.`（尾部
        // 斜杠同理）时拼出来的路径不同，同一批备份会列两遍、体积双算。
        let alt = base.join(".");
        let list = scan_all(&[base.clone(), alt]);
        assert_eq!(list.len(), 1, "同一目录被列了两遍: {list:?}");
        assert_eq!(list[0].files, 1);
        assert_eq!(list[0].bytes, 5);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn 删除拒绝越界与非法名() {
        let base = temp_dir("reject");
        let outside = temp_dir("outside");
        std::fs::write(outside.join("keep.txt"), b"x").unwrap();

        // 非法名字（含路径分隔符、..）在第一步就被挡
        for bad in ["../outside", ".ncforge-revert-1000/..", "随便一个目录"] {
            assert!(
                confirm_target(std::slice::from_ref(&base), bad).is_err(),
                "{bad}"
            );
        }
        // 名字合规但不在基线目录里
        assert!(confirm_target(std::slice::from_ref(&base), ".ncforge-revert-9999").is_err());
        assert!(delete(std::slice::from_ref(&base), "../outside").is_err());
        assert!(outside.join("keep.txt").exists(), "越界删除必须什么都没动");
        std::fs::remove_dir_all(&base).ok();
        std::fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn 删除按名字删掉整个目录并回报字节数() {
        let base = temp_dir("delete");
        let dir = base.join(".ncforge-revert-1000");
        std::fs::create_dir_all(dir.join("pu")).unwrap();
        std::fs::write(dir.join("pu/a.java"), b"1234").unwrap();
        std::fs::create_dir_all(base.join(".ncforge-revert-2000")).unwrap();

        let freed = delete(std::slice::from_ref(&base), ".ncforge-revert-1000").unwrap();
        assert_eq!(freed, 4);
        assert!(!dir.exists());
        assert!(
            base.join(".ncforge-revert-2000").exists(),
            "别的备份不能连带删掉"
        );
        std::fs::remove_dir_all(&base).ok();
    }
}
