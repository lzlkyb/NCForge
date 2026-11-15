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
}

fn key(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").to_lowercase()
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
        let destination = resolve(root, edit.destination.as_deref().unwrap_or(&edit.path))?;
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
        if source != destination && destination.exists() {
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
        });
    }
    for item in &work {
        if item.source != item.destination && paths.contains(&key(&item.destination)) {
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
            if item.source == item.destination && item.before.is_some() {
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
            if (item.delete || item.source != item.destination) && item.before.is_some() {
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
            let restored = if item.source == item.destination {
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
