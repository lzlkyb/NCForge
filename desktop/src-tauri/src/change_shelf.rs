//! Named change copies preserve editor contents without touching the working tree.
//! Restores are planned against current disk snapshots and use the workspace transaction.
use crate::security::path::{display_path, resolve_safe_path};
use crate::workspace::{self, Eol, TextEncoding};
use crate::workspace_edit::FileEdit;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
const MAX_FILES: usize = 200;
const MAX_COPY_BYTES: usize = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
const MAX_COPIES: usize = 20;
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShelfFile {
    pub path: String,
    pub before_text: String,
    pub text: String,
    pub encoding: TextEncoding,
    pub has_bom: bool,
    pub eol: Eol,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Shelf {
    pub id: String,
    pub name: String,
    pub created: u64,
    pub files: Vec<ShelfFile>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShelfSummary {
    pub id: String,
    pub name: String,
    pub created: u64,
    pub files: usize,
}
fn stable_root(root: &Path) -> Result<PathBuf, String> {
    root.canonicalize()
        .map(|p| crate::nc_home::strip_verbatim(&p))
        .map_err(|e| e.to_string())
}
fn directory(config: &Path, root: &Path) -> Result<PathBuf, String> {
    let root = stable_root(root)?;
    let key = display_path(&root).replace('\\', "/").to_lowercase();
    Ok(config
        .join("change-shelves")
        .join(format!("{:x}", Sha256::digest(key.as_bytes()))))
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() < 80
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || b == b'-' || (b'a'..=b'f').contains(&b))
}
fn load(path: &Path) -> Result<Shelf, String> {
    let meta = fs::metadata(path).map_err(|e| format!("读取变更副本失败：{e}"))?;
    if meta.len() > MAX_COPY_BYTES as u64 {
        return Err("变更副本超过读取预算".into());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| format!("变更副本损坏：{e}"))
}
pub fn list(config: &Path, root: &Path) -> Result<Vec<ShelfSummary>, String> {
    let dir = directory(config, root)?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut copies = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().is_none_or(|e| e != "json") {
            continue;
        }
        // 🔴 一份坏 json 不能拖垮整个列表：原来 `load(&path)?` 会让 `list()` 直接 Err，
        // 用户看到的是「变更副本全没了」，而实际只有一份文件损坏（掉电/半截写入）。
        // 同仓其它 store（resource_pack / build_state）都是「损坏按空处理」，这里对齐。
        // 坏文件**不删**：留给用户自己处置，删了就是静默丢数据。
        let shelf = match load(&path) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[change-shelf] 跳过损坏的副本 {}：{e}", path.display());
                continue;
            }
        };
        copies.push(ShelfSummary {
            id: shelf.id,
            name: shelf.name,
            created: shelf.created,
            files: shelf.files.len(),
        });
    }
    copies.sort_by_key(|copy| std::cmp::Reverse(copy.created));
    Ok(copies)
}
pub fn read(config: &Path, root: &Path, id: &str) -> Result<Shelf, String> {
    if !valid_id(id) {
        return Err("变更副本标识无效".into());
    }
    load(&directory(config, root)?.join(format!("{id}.json")))
}
pub fn create(
    config: &Path,
    root: &Path,
    name: &str,
    files: Vec<FileEdit>,
) -> Result<ShelfSummary, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err("变更集名称须为 1 至 80 个字符".into());
    }
    if files.is_empty() || files.len() > MAX_FILES {
        return Err("请选择 1 至 200 个文件保存副本".into());
    }
    let root = stable_root(root)?;
    let whitelist = vec![display_path(&root)];
    let mut stored = Vec::new();
    let mut bytes = 0;
    let mut keys = std::collections::HashSet::new();
    for file in files {
        if file.delete || file.destination.is_some() {
            return Err("变更副本仅保存文件内容，不包含文件删除或移动".into());
        }
        let path = resolve_safe_path(&file.path, &whitelist, &[], true)?;
        let path = crate::nc_home::strip_verbatim(&path);
        // Missing files can retain unsaved models; None is a missing-file guard, not a wildcard.
        let before_text = if file.expected_mtime_ms.is_none() {
            if path.try_exists().map_err(|e| e.to_string())? || !file.expected_text.is_empty() {
                return Err(format!("CONFLICT:保存副本时文件已改变：{}", path.display()));
            }
            String::new()
        } else {
            let content = workspace::read_text_file(&path)?;
            if Some(content.mtime_ms) != file.expected_mtime_ms
                || content.text != file.expected_text
            {
                return Err(format!("CONFLICT:保存副本时文件已改变：{}", path.display()));
            }
            if !content.lossless || content.eol == Eol::Mixed {
                return Err("文件不能按原编码无损保存副本".into());
            }
            content.text
        };
        workspace::encode_text_file(&file.text, file.encoding, file.has_bom, file.eol)?;
        let relative = path
            .strip_prefix(&root)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .into_owned();
        if !keys.insert(relative.to_lowercase()) {
            return Err("副本包含重复文件".into());
        }
        bytes += file.text.len() + before_text.len();
        if bytes > MAX_COPY_BYTES {
            return Err("变更集内容超过 16 MiB，请缩小范围".into());
        }
        stored.push(ShelfFile {
            path: relative,
            before_text,
            text: file.text,
            encoding: file.encoding,
            has_bom: file.has_bom,
            eol: file.eol,
        });
    }
    let created = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as u64;
    let fingerprint = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&stored).map_err(|e| e.to_string())?)
    );
    let id = format!("{created}-{}", &fingerprint[..12]);
    let shelf = Shelf {
        id: id.clone(),
        name: name.into(),
        created,
        files: stored,
    };
    let serialized = serde_json::to_vec(&shelf).map_err(|e| e.to_string())?;
    if serialized.len() > MAX_COPY_BYTES {
        return Err("变更集序列化超过 16 MiB，请缩小范围".into());
    }
    let dir = directory(config, &root)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let existing = list(config, &root)?;
    let used = fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .filter_map(|e| e.metadata().ok())
        .map(|m| m.len())
        .sum::<u64>();
    if existing.len() >= MAX_COPIES || used + serialized.len() as u64 > MAX_TOTAL_BYTES {
        return Err("变更副本达到 20 份 / 64 MiB 预算，请删除不再需要的副本".into());
    }
    use std::io::Write;
    let path = dir.join(format!("{id}.json"));
    let mut output = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    if let Err(error) = output
        .write_all(&serialized)
        .and_then(|_| output.sync_all())
    {
        drop(output);
        let _ = fs::remove_file(&path);
        return Err(error.to_string());
    }
    Ok(ShelfSummary {
        id,
        name: name.into(),
        created,
        files: shelf.files.len(),
    })
}
pub fn remove(config: &Path, root: &Path, id: &str) -> Result<(), String> {
    if !valid_id(id) {
        return Err("变更副本标识无效".into());
    }
    fs::remove_file(directory(config, root)?.join(format!("{id}.json"))).map_err(|e| e.to_string())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShelfRestoreFile {
    pub path: String,
    pub before_text: String,
    pub expected_text: String,
    pub expected_mtime_ms: Option<u64>,
    pub text: String,
    pub delete: bool,
    pub encoding: TextEncoding,
    pub has_bom: bool,
    pub eol: Eol,
}
pub fn plan(config: &Path, root: &Path, id: &str) -> Result<Vec<ShelfRestoreFile>, String> {
    let shelf = read(config, root, id)?;
    let root = stable_root(root)?;
    let whitelist = vec![display_path(&root)];
    let mut plans = Vec::new();
    for file in shelf.files {
        let path = resolve_safe_path(
            &root.join(file.path).to_string_lossy(),
            &whitelist,
            &[],
            true,
        )?;
        let content = if path.exists() {
            Some(workspace::read_text_file(&path)?)
        } else {
            None
        };
        if content
            .as_ref()
            .is_some_and(|c| !c.lossless || c.eol == Eol::Mixed)
        {
            return Err("当前文件不能无损恢复，请先处理编码或换行".into());
        }
        let expected_text = content.as_ref().map(|c| c.text.clone()).unwrap_or_default();
        let expected_mtime_ms = content.as_ref().map(|c| c.mtime_ms);
        plans.push(ShelfRestoreFile {
            path: display_path(&path),
            before_text: expected_text.clone(),
            expected_text,
            expected_mtime_ms,
            text: file.text,
            delete: false,
            encoding: content
                .as_ref()
                .map(|c| c.encoding)
                .unwrap_or(file.encoding),
            has_bom: content.as_ref().map(|c| c.has_bom).unwrap_or(file.has_bom),
            eol: content.as_ref().map(|c| c.eol).unwrap_or(file.eol),
        });
    }
    Ok(plans)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn edit(path: &Path) -> FileEdit {
        let c = workspace::read_text_file(path).unwrap();
        FileEdit {
            path: display_path(path),
            expected_text: c.text,
            expected_mtime_ms: Some(c.mtime_ms),
            text: "class Changed {}\n".into(),
            destination: None,
            delete: false,
            encoding: c.encoding,
            has_bom: c.has_bom,
            eol: c.eol,
        }
    }
    #[test]
    fn copy_roundtrip_and_restore_plan_are_non_destructive() {
        let tmp = crate::test_support::tmp("change-shelf");
        let root = tmp.join("project");
        fs::create_dir(&root).unwrap();
        let file = root.join("A.java");
        fs::write(&file, "class A {}\n").unwrap();
        let copied = create(&tmp, &root, "需求 A", vec![edit(&file)]).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "class A {}\n");
        assert_eq!(list(&tmp, &root).unwrap().len(), 1);
        let restore = plan(&tmp, &root, &copied.id).unwrap();
        assert_eq!(restore[0].text, "class Changed {}\n");
        remove(&tmp, &root, &copied.id).unwrap();
        assert!(list(&tmp, &root).unwrap().is_empty());
        fs::remove_dir_all(&tmp).unwrap();
    }
    /// 🔴 一份坏 json 不能拖垮 list()/create()：掉电或半截写入留下一份损坏文件时，
    /// 原来整个列表直接 Err，用户看到「变更副本全没了」。坏文件跳过但**不删**。
    #[test]
    fn one_corrupt_copy_does_not_break_list_or_create() {
        let tmp = crate::test_support::tmp("change-shelf-corrupt");
        let root = tmp.join("project");
        fs::create_dir_all(&root).unwrap();
        let file = root.join("A.java");
        fs::write(&file, "class A {}\n").unwrap();
        let good = create(&tmp, &root, "好副本", vec![edit(&file)]).unwrap();

        // 往副本目录里塞一份坏 json（半截写入的样子）
        let dir = directory(&tmp, &root).unwrap();
        let broken = dir.join("broken.json");
        fs::write(&broken, "{\"id\":\"broken\",\"name\":").unwrap();

        let listed = list(&tmp, &root).expect("坏副本不该让列表整体失败");
        assert_eq!(listed.len(), 1, "好副本必须还在：{listed:?}");
        assert_eq!(listed[0].id, good.id);
        assert!(broken.exists(), "坏文件不许被静默删除");

        // create 也走 list（预算校验），同样不该被坏文件挡住
        let second =
            create(&tmp, &root, "第二份", vec![edit(&file)]).expect("坏副本不该让新建失败");
        assert_ne!(second.id, good.id);
        assert_eq!(list(&tmp, &root).unwrap().len(), 2);

        // 坏文件自己读还是要报错，不能假装它存在
        assert!(read(&tmp, &root, "broken").is_err());
        fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn refuses_stale_copy_and_path_escape() {
        let tmp = crate::test_support::tmp("change-shelf-stale");
        let root = tmp.join("project");
        fs::create_dir(&root).unwrap();
        let file = root.join("A.java");
        fs::write(&file, "A").unwrap();
        let input = edit(&file);
        fs::write(&file, "B").unwrap();
        assert!(create(&tmp, &root, "stale", vec![input]).is_err());
        let outside = tmp.join("outside.java");
        fs::write(&outside, "X").unwrap();
        assert!(create(&tmp, &root, "outside", vec![edit(&outside)]).is_err());
        assert!(read(&tmp, &root, "../escape").is_err());
        fs::remove_dir_all(&tmp).unwrap();
    }
    #[test]
    fn missing_file_buffer_is_durable_and_can_be_restored() {
        let tmp = crate::test_support::tmp("change-shelf-missing");
        let root = tmp.join("project");
        fs::create_dir(&root).unwrap();
        let file = root.join("A.java");
        fs::write(&file, "class A {}\n").unwrap();
        let mut input = edit(&file);
        fs::remove_file(&file).unwrap();
        input.expected_mtime_ms = None;
        input.expected_text.clear();
        input.text = "class NewerBuffer {}\n".into();
        let copied = create(&tmp, &root, "恢复前", vec![input]).unwrap();
        assert!(!file.exists());
        let saved = read(&tmp, &root, &copied.id).unwrap();
        assert!(saved.files[0].before_text.is_empty());
        assert_eq!(saved.files[0].text, "class NewerBuffer {}\n");
        let restore = plan(&tmp, &root, &copied.id).unwrap();
        assert_eq!(restore[0].expected_mtime_ms, None);
        assert_eq!(restore[0].text, "class NewerBuffer {}\n");
        fs::remove_dir_all(&tmp).unwrap();
    }
    #[test]
    fn missing_file_guard_refuses_a_recreated_file() {
        let tmp = crate::test_support::tmp("change-shelf-recreated");
        let root = tmp.join("project");
        fs::create_dir(&root).unwrap();
        let file = root.join("A.java");
        fs::write(&file, "external").unwrap();
        let mut input = edit(&file);
        input.expected_mtime_ms = None;
        input.expected_text.clear();
        assert!(create(&tmp, &root, "恢复前", vec![input])
            .unwrap_err()
            .contains("CONFLICT"));
        assert_eq!(fs::read_to_string(&file).unwrap(), "external");
        assert!(list(&tmp, &root).unwrap().is_empty());
        fs::remove_dir_all(&tmp).unwrap();
    }
}
