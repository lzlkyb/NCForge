//! Build a bounded JaCoCo class directory that follows runtime classpath precedence.
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// JaCoCo rejects two different class bodies with one name, so the first root wins.
pub fn coverage_classes(
    directory: &Path,
    roots: &[PathBuf],
    cancel: &AtomicBool,
) -> Result<PathBuf, String> {
    let target = directory.join("coverage-classes");
    std::fs::create_dir(&target).map_err(|e| e.to_string())?;
    let mut seen = std::collections::HashSet::new();
    let mut visited = 0usize;
    let mut bytes = 0u64;
    for root in roots.iter().filter(|root| root.is_dir()) {
        let mut pending = vec![root.clone()];
        while let Some(path) = pending.pop() {
            if cancel.load(Ordering::Relaxed) {
                return Err("覆盖率报告准备已取消".into());
            }
            for entry in
                std::fs::read_dir(&path).map_err(|e| format!("读取覆盖率类目录失败：{e}"))?
            {
                let entry = entry.map_err(|e| e.to_string())?;
                visited += 1;
                if visited > 100_000 {
                    return Err("覆盖率类目录超过 100000 项，请缩小运行范围".into());
                }
                let kind = entry.file_type().map_err(|e| e.to_string())?;
                let metadata = entry.metadata().map_err(|e| e.to_string())?;
                if kind.is_symlink() || crate::build_layout::is_reparse(&metadata) {
                    continue;
                }
                let path = entry.path();
                if kind.is_dir() {
                    pending.push(path);
                    continue;
                }
                if !kind.is_file() || path.extension().is_none_or(|ext| ext != "class") {
                    continue;
                }
                let relative = path.strip_prefix(root).map_err(|e| e.to_string())?;
                if relative == Path::new("NcJavaTestRunner.class") {
                    continue;
                }
                let key = relative.to_string_lossy().into_owned();
                #[cfg(windows)]
                let key = key.to_lowercase();
                if !seen.insert(key) {
                    continue;
                }
                bytes = bytes.saturating_add(metadata.len());
                if bytes > 512 * 1024 * 1024 {
                    return Err("覆盖率类文件超过 512 MiB，请缩小运行范围".into());
                }
                let dest = target.join(relative);
                if let Some(parent) = dest.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                std::fs::copy(&path, &dest).map_err(|e| format!("准备覆盖率类文件失败：{e}"))?;
            }
        }
    }
    Ok(target)
}
