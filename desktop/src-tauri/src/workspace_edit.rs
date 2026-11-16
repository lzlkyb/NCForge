//! Cross-file edit plans preflight every original byte and encoding before writing.
//! Failed plans restore only files that still match our own writes, preserving external edits.
use crate::workspace::{self, Eol, TextEncoding};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

const MAX_FILES: usize = 400;
const MAX_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEdit {
    pub path: String,
    pub expected_text: String,
    pub expected_mtime_ms: Option<u64>,
    pub text: String,
    pub destination: Option<String>,
    #[serde(default)]
    pub delete: bool,
    pub encoding: TextEncoding,
    pub has_bom: bool,
    pub eol: Eol,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditOutcome {
    pub written: Vec<String>,
    pub renamed: Vec<(String, String)>,
    pub deleted: Vec<String>,
}
struct Work {
    source: PathBuf,
    destination: PathBuf,
    before: Option<Vec<u8>>,
    after: Vec<u8>,
    mtime: Option<u64>,
    delete: bool,
    /// 只改大小写的同目录改名（Windows 上 `A.java` → `a.java`）。
    case_only: bool,
}

fn key(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").to_lowercase()
}

/// 是否「同一个文件、只有大小写不同」。
///
/// 🔴 Windows 文件系统大小写不敏感：`A.java` 与 `a.java` 是**同一个文件**，
/// `destination.exists()` 为真不代表目标被占用。原来 `source != destination &&
/// destination.exists()` 直接拒绝，导致重构里的纯大小写改名在 Windows 上永远失败；
/// `workspace::rename_entry` 早就有 `is_same_path` 特判，事务路径漏了这一层。
///
/// 判据与 `rename_entry` 一致：canonicalize 后相等即同一文件（顺带解掉符号链接）。
/// 只在大小写不敏感的平台认这条，Linux 上 `A.java`/`a.java` 是两个文件，必须仍按占用拒绝。
fn case_only_rename(source: &Path, destination: &Path) -> bool {
    if source == destination || key(source) != key(destination) {
        return false;
    }
    if !cfg!(windows) {
        return false;
    }
    match (fs::canonicalize(source), fs::canonicalize(destination)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}
fn resolve(root: &Path, path: &str) -> Result<PathBuf, String> {
    let resolved = crate::security::path::resolve_safe_path(
        path,
        &[root.to_string_lossy().into_owned()],
        &[],
        true,
    )?;
    if key(&resolved)
        == key(&crate::nc_home::strip_verbatim(
            &fs::canonicalize(root).map_err(|e| e.to_string())?,
        ))
    {
        return Err("不能重构工程根目录".into());
    }
    Ok(resolved)
}
fn prepare(root: &Path, edits: Vec<FileEdit>) -> Result<Vec<Work>, String> {
    if edits.is_empty() || edits.len() > MAX_FILES {
        return Err("重构清单为空或超过 400 个文件".into());
    }
    let mut work = Vec::new();
    let mut paths = HashSet::new();
    let mut targets = HashSet::new();
    let mut bytes = 0;
    for edit in edits {
        let source = resolve(root, &edit.path)?;
        let destination = match edit.destination.as_deref() {
            Some(want) => {
                let checked = resolve(root, want)?;
                // 🔴 `resolve_safe_path` 对已存在路径会 canonicalize，而 Windows 的
                // canonicalize 返回**磁盘上的真实大小写** —— 用户要把 `A.java` 改成
                // `a.java`，安全检查通过后名字又被还原成 `A.java`，纯大小写改名就白做了。
                // 安全校验仍走 canonicalize 后的 checked（白名单/穿越判定不变），
                // 只在「与源是同一文件、仅大小写不同」时把用户请求的拼写换回来。
                if cfg!(windows) && key(&checked) == key(&source) {
                    let requested = PathBuf::from(want);
                    let name = requested.file_name().map(|n| n.to_owned());
                    match (name, checked.parent()) {
                        (Some(name), Some(parent)) => parent.join(name),
                        _ => checked,
                    }
                } else {
                    checked
                }
            }
            None => resolve(root, &edit.path)?,
        };
        if !paths.insert(key(&source)) || (!edit.delete && !targets.insert(key(&destination))) {
            return Err("重构清单包含重复文件或目标".into());
        }
        let before = if let Some(expected) = edit.expected_mtime_ms {
            let content = workspace::read_text_file(&source)?;
            if content.mtime_ms != expected || content.text != edit.expected_text {
                return Err(format!("CONFLICT:预览后文件已改变：{}", source.display()));
            }
            if !content.lossless || content.eol == Eol::Mixed {
                return Err(format!("文件编码或换行不能无损改写：{}", source.display()));
            }
            if content.encoding != edit.encoding
                || content.has_bom != edit.has_bom
                || content.eol != edit.eol
            {
                return Err("文件格式在预览后发生变化".into());
            }
            Some(fs::read(&source).map_err(|e| e.to_string())?)
        } else {
            if source.exists() || !edit.expected_text.is_empty() || edit.delete {
                return Err("新建文件的目标已存在或清单不合法".into());
            }
            None
        };
        let case_only = case_only_rename(&source, &destination);
        if source != destination && !case_only && destination.exists() {
            return Err(format!("移动目标已存在：{}", destination.display()));
        }
        let after = workspace::encode_text_file(&edit.text, edit.encoding, edit.has_bom, edit.eol)?;
        bytes += before.as_ref().map_or(0, Vec::len) + after.len();
        if bytes > MAX_BYTES || after.len() as u64 > workspace::MAX_FILE_BYTES {
            return Err("重构文本超过内存或单文件大小上限".into());
        }
        work.push(Work {
            source,
            destination,
            before,
            after,
            mtime: edit.expected_mtime_ms,
            delete: edit.delete,
            case_only,
        });
    }
    for item in &work {
        // 纯大小写改名的目标就是源文件自己，不算「循环移动」
        if item.source != item.destination
            && !item.case_only
            && paths.contains(&key(&item.destination))
        {
            return Err("移动目标也是本次源文件，请拆分循环移动".into());
        }
    }
    Ok(work)
}
fn unchanged(item: &Work) -> bool {
    match &item.before {
        Some(before) => fs::read(&item.source).is_ok_and(|now| now == *before),
        None => !item.source.exists(),
    }
}
fn exclusive_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| format!("创建目标失败 {}：{e}", path.display()))?;
    if let Err(error) = file.write_all(bytes).and_then(|()| file.sync_all()) {
        drop(file);
        // This handle created the new path; an incomplete write must not remain as an apparent success.
        let _ = fs::remove_file(path);
        return Err(format!("写入目标失败 {}：{error}", path.display()));
    }
    Ok(())
}

/// 纯大小写改名 + 内容改写：源 → 中转名 → 目标，全程不覆盖别人的文件。
///
/// 与 `workspace::rename_entry` 同一套中转名策略（随机名、落盘前再确认没被占用），
/// 区别是这里还要把新内容写进去，所以中转名那一步用 `exclusive_write` 而不是 rename：
/// 先把新内容写到中转名，再删源、再把中转名改成目标。任一步失败都把源恢复回去。
fn case_rename(item: &Work) -> Result<(), String> {
    let parent = item
        .destination
        .parent()
        .ok_or_else(|| "无法重命名工作区根目录".to_string())?;
    let tmp = {
        let probe = tempfile::Builder::new()
            .prefix(".ncforge-recase-")
            .suffix(".tmp")
            .tempfile_in(parent)
            .map_err(|e| format!("重命名失败：{e}"))?;
        let path = probe.path().to_path_buf();
        drop(probe);
        path
    };
    if fs::symlink_metadata(&tmp).is_ok() {
        return Err("重命名失败：中转名被占用，请重试".into());
    }
    // 新内容先落中转名：写失败时源文件还没动，直接返回即可
    exclusive_write(&tmp, &item.after)?;
    if let Err(e) = fs::remove_file(&item.source) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("移除源文件失败：{e}"));
    }
    if let Err(e) = fs::rename(&tmp, &item.destination) {
        // 目标没落地：把中转名搬回源路径，绝不把用户文件留在临时名下
        if fs::symlink_metadata(&item.source).is_err() {
            let _ = fs::rename(&tmp, &item.source);
        }
        return Err(format!("重命名失败：{e}"));
    }
    Ok(())
}

/// 纯大小写改名的回滚：把原内容写回去，再把名字改回原来的大小写。
///
/// 同样要走中转名（Windows 一步改不回去）。内容先恢复，改名失败只影响名字、不丢数据，
/// 所以两步的错误分开报，让用户知道「内容已恢复但名字没改回来」。
fn case_rollback(item: &Work, before: &[u8]) -> Result<(), String> {
    let parent = item
        .source
        .parent()
        .ok_or_else(|| "无法重命名工作区根目录".to_string())?;
    let tmp = {
        let probe = tempfile::Builder::new()
            .prefix(".ncforge-recase-back-")
            .suffix(".tmp")
            .tempfile_in(parent)
            .map_err(|e| format!("回滚重命名失败：{e}"))?;
        let path = probe.path().to_path_buf();
        drop(probe);
        path
    };
    if fs::symlink_metadata(&tmp).is_ok() {
        return Err("回滚重命名失败：中转名被占用".into());
    }
    exclusive_write(&tmp, before)?;
    if let Err(e) = fs::remove_file(&item.destination) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("回滚移除目标失败：{e}"));
    }
    fs::rename(&tmp, &item.source).map_err(|e| {
        // 内容已在中转名里，绝不能静默丢掉：把它搬回目标路径保底
        if fs::symlink_metadata(&item.destination).is_err() {
            let _ = fs::rename(&tmp, &item.destination);
        }
        format!("内容已恢复但名字没改回原大小写：{e}")
    })
}

pub fn apply(root: &Path, edits: Vec<FileEdit>) -> Result<EditOutcome, String> {
    let work = prepare(root, edits)?;
    let mut written: Vec<usize> = Vec::new();
    let mut removed: Vec<usize> = Vec::new();
    let mut created_dirs = Vec::new();
    let result = (|| {
        for (index, item) in work.iter().enumerate() {
            if !unchanged(item) {
                return Err(format!(
                    "CONFLICT:文件在应用过程中改变：{}",
                    item.source.display()
                ));
            }
            if item.delete {
                continue;
            }
            if item.case_only {
                // Windows 不允许一步 rename 到「同名但大小写不同」的路径，
                // 与 `workspace::rename_entry` 同一套：先落中转名，再改成目标名。
                case_rename(item)?;
            } else if item.source == item.destination && item.before.is_some() {
                crate::atomic_file::write_atomic_checked(&item.source, &item.after, item.mtime)?;
            } else {
                let mut missing = Vec::new();
                let mut parent = item.destination.parent();
                while let Some(dir) = parent {
                    if dir.exists() {
                        break;
                    }
                    missing.push(dir.to_path_buf());
                    parent = dir.parent();
                }
                for dir in missing.into_iter().rev() {
                    resolve(root, &dir.to_string_lossy())?;
                    fs::create_dir(&dir).map_err(|e| format!("创建包目录失败：{e}"))?;
                    created_dirs.push(dir);
                }
                resolve(root, &item.destination.to_string_lossy())?;
                exclusive_write(&item.destination, &item.after)?;
            }
            written.push(index);
        }
        for (index, item) in work.iter().enumerate() {
            // case_only 已经在上一步整体改名到位，源路径就是目标路径，不能再删一次
            if !item.case_only
                && (item.delete || item.source != item.destination)
                && item.before.is_some()
            {
                if !unchanged(item) {
                    return Err(format!(
                        "CONFLICT:移动或删除前源文件改变：{}",
                        item.source.display()
                    ));
                }
                fs::remove_file(&item.source).map_err(|e| format!("移除源文件失败：{e}"))?;
                removed.push(index);
            }
        }
        Ok(())
    })();
    if let Err(error) = result {
        let mut failures = Vec::new();
        for index in removed.into_iter().rev() {
            let item = &work[index];
            if let Some(before) = &item.before {
                if let Err(e) = exclusive_write(&item.source, before) {
                    failures.push(e);
                }
            }
        }
        for index in written.into_iter().rev() {
            let item = &work[index];
            if !fs::read(&item.destination).is_ok_and(|now| now == item.after) {
                failures.push(format!(
                    "回滚时目标已被外部修改，保留当前内容：{}",
                    item.destination.display()
                ));
                continue;
            }
            // case_only 的目标与源是同一个文件（只差大小写），回滚要「写回原内容 + 改回原名」，
            // 不能走「删掉目标」那条——那会把用户文件删没。
            let restored = if item.case_only {
                match &item.before {
                    Some(before) => case_rollback(item, before),
                    None => fs::remove_file(&item.destination).map_err(|e| e.to_string()),
                }
            } else if item.source == item.destination {
                match &item.before {
                    Some(before) => {
                        let expected = fs::metadata(&item.source)
                            .and_then(|meta| meta.modified())
                            .ok()
                            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|duration| duration.as_millis() as u64);
                        crate::atomic_file::write_atomic_checked(&item.source, before, expected)
                    }
                    None => fs::remove_file(&item.destination).map_err(|e| e.to_string()),
                }
            } else {
                fs::remove_file(&item.destination).map_err(|e| e.to_string())
            };
            if let Err(e) = restored {
                failures.push(e);
            }
        }
        for dir in created_dirs.into_iter().rev() {
            let _ = fs::remove_dir(dir);
        }
        return Err(if failures.is_empty() {
            format!("{error}；本次已应用的改动已回滚")
        } else {
            format!("{error}；部分回滚未完成：{}", failures.join("；"))
        });
    }
    Ok(EditOutcome {
        written: work
            .iter()
            .filter(|w| !w.delete)
            .map(|w| crate::security::path::display_path(&w.destination))
            .collect(),
        renamed: work
            .iter()
            .filter(|w| w.source != w.destination)
            .map(|w| {
                (
                    crate::security::path::display_path(&w.source),
                    crate::security::path::display_path(&w.destination),
                )
            })
            .collect(),
        deleted: work
            .iter()
            .filter(|w| w.delete)
            .map(|w| crate::security::path::display_path(&w.source))
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn edit(path: &Path, destination: Option<&Path>) -> FileEdit {
        let content = workspace::read_text_file(path).unwrap();
        FileEdit {
            path: path.to_string_lossy().into(),
            expected_text: content.text,
            expected_mtime_ms: Some(content.mtime_ms),
            text: "// 接口\nclass B {}\n".into(),
            destination: destination.map(|p| p.to_string_lossy().into()),
            delete: false,
            encoding: content.encoding,
            has_bom: content.has_bom,
            eol: content.eol,
        }
    }
    /// 🔴 Windows 上 `A.java` → `a.java` 是同一个文件，`destination.exists()` 为真
    /// 不代表目标被占用。原来预检直接拒绝，重构里的纯大小写改名永远失败；
    /// `workspace::rename_entry` 早有 is_same_path 特判，事务路径漏了。
    #[cfg(windows)]
    #[test]
    fn case_only_rename_is_allowed_on_windows() {
        let dir = crate::test_support::tmp("workspace-edit-recase");
        let a = dir.join("Voucher.java");
        let b = dir.join("voucher.java");
        fs::write(&a, "class A {}\n").unwrap();
        assert!(case_only_rename(&a, &b), "同一文件只差大小写必须认");
        let result = apply(&dir, vec![edit(&a, Some(&b))]).expect("纯大小写改名不该被拒");
        assert_eq!(result.renamed.len(), 1, "要报成改名，前端才会跟着换标签");
        // 目录里只有一份文件，且名字是新的大小写
        let names: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
            .collect();
        assert_eq!(names, vec!["voucher.java".to_string()], "实测 {names:?}");
        assert_eq!(
            workspace::read_text_file(&b).unwrap().text,
            "// 接口\nclass B {}\n"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    /// 判据本身：不同文件、跨目录、完全同名都不算纯大小写改名。
    #[test]
    fn case_only_predicate_is_narrow() {
        let dir = crate::test_support::tmp("workspace-edit-recase-pred");
        let a = dir.join("A.java");
        fs::write(&a, "x").unwrap();
        assert!(!case_only_rename(&a, &a), "完全同名不是改名");
        assert!(!case_only_rename(&a, &dir.join("B.java")), "不同名字不是");
        assert!(
            !case_only_rename(&a, &dir.join("pkg").join("a.java")),
            "跨目录不是纯大小写改名"
        );
        // 目标不存在（canonicalize 失败）时不认，交给正常的移动路径
        assert!(!case_only_rename(&a, &dir.join("missing.java")));
        fs::remove_dir_all(&dir).unwrap();
    }

    /// 真正被占用的目标仍要拒绝——放宽的只有「同一个文件」这一种。
    #[cfg(windows)]
    #[test]
    fn occupied_destination_is_still_rejected() {
        let dir = crate::test_support::tmp("workspace-edit-recase-occupied");
        let a = dir.join("A.java");
        let b = dir.join("B.java");
        fs::write(&a, "class A {}\n").unwrap();
        fs::write(&b, "existing\n").unwrap();
        assert!(apply(&dir, vec![edit(&a, Some(&b))]).is_err());
        assert_eq!(fs::read_to_string(&b).unwrap(), "existing\n");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rejects_stale_plan_before_writing_any_file() {
        let dir = crate::test_support::tmp("workspace-edit-stale");
        let a = dir.join("A.java");
        let b = dir.join("B.java");
        fs::write(&a, "class A {}\n").unwrap();
        fs::write(&b, "class B {}\n").unwrap();
        let edits = vec![edit(&a, None), edit(&b, None)];
        fs::write(&b, "class External {}\n").unwrap();
        assert!(apply(&dir, edits).unwrap_err().contains("CONFLICT"));
        assert_eq!(fs::read_to_string(&a).unwrap(), "class A {}\n");
        fs::remove_dir_all(&dir).unwrap();
    }
    #[test]
    fn moves_file_and_preserves_original_encoding_and_eol() {
        let dir = crate::test_support::tmp("workspace-edit-move");
        let a = dir.join("A.java");
        let b = dir.join("pkg").join("B.java");
        let (bytes, _, _) = encoding_rs::GBK.encode("// 接口\r\nclass A {}\r\n");
        fs::write(&a, &bytes).unwrap();
        let result = apply(&dir, vec![edit(&a, Some(&b))]).unwrap();
        assert_eq!(result.renamed.len(), 1);
        assert!(!a.exists());
        let content = workspace::read_text_file(&b).unwrap();
        assert_eq!(content.encoding, TextEncoding::Gbk);
        assert_eq!(content.eol, Eol::Crlf);
        fs::remove_dir_all(&dir).unwrap();
    }
    #[test]
    fn rejects_destination_overwrite_and_escape() {
        let dir = crate::test_support::tmp("workspace-edit-bounds");
        let a = dir.join("A.java");
        let b = dir.join("B.java");
        fs::write(&a, "class A {}\n").unwrap();
        fs::write(&b, "existing\n").unwrap();
        assert!(apply(&dir, vec![edit(&a, Some(&b))]).is_err());
        let outside = dir.parent().unwrap().join("outside.java");
        assert!(apply(&dir, vec![edit(&a, Some(&outside))]).is_err());
        assert_eq!(fs::read_to_string(&b).unwrap(), "existing\n");
        fs::remove_dir_all(&dir).unwrap();
    }
}
