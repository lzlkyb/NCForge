//! Exact native-picker grants, scoped to one app lifetime. IPC never accepts an arbitrary destination path.
use crate::db_transfer::TransferFormat;
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::hash::BuildHasher;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_GRANTS: usize = 128;
#[derive(Debug, Clone, Serialize)]
pub struct DestinationGrant {
    pub token: String,
    pub path: String,
}
#[derive(Clone)]
struct Grant {
    path: PathBuf,
    parent: PathBuf,
}
#[derive(Default)]
struct Registry {
    grants: HashMap<String, Grant>,
    order: VecDeque<String>,
    active: HashSet<String>,
    sequence: u64,
}
#[derive(Clone, Default)]
pub struct DestinationRegistry {
    inner: Arc<Mutex<Registry>>,
}
pub struct DestinationLease {
    registry: DestinationRegistry,
    path: PathBuf,
}
impl DestinationLease {
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn verify(&self) -> Result<(), String> {
        verify_path(&self.path, self.path.parent().ok_or("目标路径无上级目录")?)
    }
}
impl Drop for DestinationLease {
    fn drop(&mut self) {
        self.registry
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .active
            .remove(&path_key(&self.path));
    }
}
impl DestinationRegistry {
    pub fn grant(&self, path: &Path) -> Result<DestinationGrant, String> {
        let parent = path
            .parent()
            .ok_or("保存路径没有上级目录")?
            .canonicalize()
            .map_err(|e| format!("保存目录不存在或无法访问：{e}"))?;
        let name = path.file_name().ok_or("保存路径缺少文件名")?;
        let canonical = parent.join(name);
        verify_path(&canonical, &parent)?;
        let mut r = self.inner.lock().map_err(|_| "保存授权状态异常")?;
        r.sequence = r.sequence.wrapping_add(1);
        // RandomState seeds from the OS. Tokens reveal neither filenames nor a reusable directory grant.
        let input = (
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos(),
            r.sequence,
        );
        let part = || std::collections::hash_map::RandomState::new().hash_one(input);
        let token = format!("{:016x}{:016x}", part(), part());
        while r.order.len() >= MAX_GRANTS {
            if let Some(old) = r.order.pop_front() {
                r.grants.remove(&old);
            }
        }
        r.order.push_back(token.clone());
        r.grants.insert(
            token.clone(),
            Grant {
                path: canonical.clone(),
                parent,
            },
        );
        Ok(DestinationGrant {
            token,
            path: crate::security::path::display_path(&canonical),
        })
    }
    pub fn resolve(&self, token: &str) -> Result<PathBuf, String> {
        let grant = self
            .inner
            .lock()
            .map_err(|_| "保存授权状态异常")?
            .grants
            .get(token)
            .cloned()
            .ok_or("保存位置授权已失效，请重新选择位置")?;
        verify_path(&grant.path, &grant.parent)?;
        Ok(grant.path)
    }
    pub fn lease(&self, token: &str) -> Result<DestinationLease, String> {
        let path = self.resolve(token)?;
        let mut r = self.inner.lock().map_err(|_| "保存授权状态异常")?;
        if !r.active.insert(path_key(&path)) {
            return Err("这个文件正在导出，请等待当前导出结束".into());
        }
        Ok(DestinationLease {
            registry: self.clone(),
            path,
        })
    }
}
fn path_key(path: &Path) -> String {
    let text = path.to_string_lossy().into_owned();
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text
    }
}
fn verify_path(path: &Path, parent: &Path) -> Result<(), String> {
    let actual = path
        .parent()
        .ok_or("目标路径没有上级目录")?
        .canonicalize()
        .map_err(|e| format!("保存目录无法访问：{e}"))?;
    if actual != parent {
        return Err("保存目录已发生变化，请重新选择位置".into());
    }
    if path.exists() && (!path.is_file() || path.canonicalize().map_err(|e| e.to_string())? != path)
    {
        return Err("保存位置不是普通文件或已变为链接，请重新选择位置".into());
    }
    Ok(())
}
pub fn file_name(requested: Option<&str>, fmt: TransferFormat) -> String {
    let raw = requested.unwrap_or("查询结果");
    let mut name: String = raw
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    name = name.trim().trim_matches('.').chars().take(160).collect();
    if name.is_empty() {
        name = "查询结果".into();
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit())
    {
        name.insert(0, '_');
    }
    if !name
        .to_ascii_lowercase()
        .ends_with(&format!(".{}", fmt.ext()))
    {
        name.push('.');
        name.push_str(fmt.ext());
    }
    name
}
pub fn verify_extension(path: &Path, fmt: TransferFormat) -> Result<(), String> {
    if !path
        .extension()
        .is_some_and(|ext| ext.to_string_lossy().eq_ignore_ascii_case(fmt.ext()))
    {
        return Err(format!(
            "保存文件需要 .{} 扩展名，请重新选择位置",
            fmt.ext()
        ));
    }
    Ok(())
}
/// A canceled/limited result must never overwrite a previously complete target, even on retries.
pub fn persist_partial(
    mut file: tempfile::NamedTempFile,
    desired: &Path,
    export_id: u64,
) -> Result<PathBuf, String> {
    let parent = desired.parent().ok_or("目标路径无上级目录")?;
    let stem = desired.file_stem().unwrap_or_default().to_string_lossy();
    let extension = desired.extension().unwrap_or_default().to_string_lossy();
    for n in 0..1000 {
        let suffix = if n == 0 {
            String::new()
        } else {
            format!("-{n}")
        };
        let path = parent.join(format!("{stem}.部分结果-{export_id}{suffix}.{extension}"));
        match file.persist_noclobber(&path) {
            Ok(_) => return Ok(path),
            Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => file = e.file,
            Err(e) => return Err(format!("保留部分结果失败：{}", e.error)),
        }
    }
    Err("部分结果文件名冲突过多，请清理导出目录后重试".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_grants_reusable_bounded_and_busy_files_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let registry = DestinationRegistry::default();
        let grant = registry.grant(&dir.path().join("a.csv")).unwrap();
        assert!(registry.resolve("a.csv").is_err());
        let lease = registry.lease(&grant.token).unwrap();
        assert!(registry.lease(&grant.token).is_err());
        drop(lease);
        assert!(registry.lease(&grant.token).is_ok());
        for i in 0..MAX_GRANTS {
            registry
                .grant(&dir.path().join(format!("{i}.csv")))
                .unwrap();
        }
        assert!(registry.resolve(&grant.token).is_err());
        assert_eq!(registry.inner.lock().unwrap().grants.len(), MAX_GRANTS);
    }
    #[test]
    fn partial_never_overwrites_existing_complete_or_previous_partial() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.json");
        std::fs::write(&path, "complete").unwrap();
        let file = tempfile::NamedTempFile::new_in(dir.path()).unwrap();
        std::fs::write(file.path(), "[]").unwrap();
        let part = persist_partial(file, &path, 7).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "complete");
        let file = tempfile::NamedTempFile::new_in(dir.path()).unwrap();
        let next = persist_partial(file, &path, 7).unwrap();
        assert_ne!(next, part);
    }
    #[test]
    fn names_cannot_supply_paths() {
        let n = file_name(Some("../../CON"), TransferFormat::Csv);
        assert!(!n.contains('/'));
        assert!(!n.contains('\\'));
        assert!(n.ends_with(".csv"));
    }
}
