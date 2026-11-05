//! F3：在工作区组件与 NC 安装目录里的**同名组件**之间做结构对比。
//!
//! 只做「找文件 + 返回路径」这一件事，解析与 diff 在命令层 / 前端完成。
//!
//! 三条边界：
//! 1. **只读**：本模块只有 `read_dir` / `metadata`，不打开写句柄，不带任何写函数。
//! 2. **不做全量索引**：NC home 下组件以万计，全量解析要几十秒；这里只按
//!    `<NCHOME>/modules/*/METADATA/**/*.bmf` 的**文件名**找同名文件，不读内容。
//! 3. **文件名即组件编码**：这是 NC 的约定（索引与新建向导也按它校验）。名字对不上时
//!    宁可返回空候选，也不去逐份解析上万份 BMF 猜 `component/@name`。

use std::path::{Path, PathBuf};

use serde::Serialize;

/// NC 安装目录里的一个同名组件副本。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub path: String,
    /// `modules/<模块>` 的目录名。
    pub module: String,
    pub size: u64,
    pub mtime_ms: u64,
}

/// 工作区 BMF 所在的模块（`…/<模块>/METADATA/x.bmf`）；不在 METADATA 下返回 None。
pub fn module_of(path: &Path) -> Option<String> {
    let metadata = path.parent()?;
    if !metadata
        .file_name()
        .is_some_and(|n| n.eq_ignore_ascii_case("METADATA"))
    {
        return None;
    }
    metadata
        .parent()
        .and_then(|p| p.file_name())
        .map(|s| s.to_string_lossy().into_owned())
}

/// 在 `<home>/modules/*/METADATA` 下按文件名找 `component.bmf`（大小写不敏感）。
///
/// 返回全部命中而不是第一个：同一组件可能被多个模块装过（自研模块 + 原厂模块），
/// 让用户看到并选择，比替他猜更安全。`preferred` 只是把同模块的候选排到前面。
pub fn find_candidates(
    home: &Path,
    component: &str,
    preferred: Option<&str>,
) -> Result<Vec<Candidate>, String> {
    let want = component.trim();
    if want.is_empty() {
        return Err("组件编码为空，先打开一个 BMF".to_string());
    }
    let modules = home.join("modules");
    let read = std::fs::read_dir(&modules)
        .map_err(|e| format!("读不到 {}：{e}（NC 安装目录是否还在这个位置？）", modules.display()))?;
    let mut module_dirs: Vec<PathBuf> = read
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| e.path())
        .collect();
    module_dirs.sort();

    let mut out = Vec::new();
    for dir in module_dirs {
        let Some(module) = dir.file_name().map(|s| s.to_string_lossy().into_owned()) else {
            continue;
        };
        // 与索引同一套目录遍历规则（跳过 src/classes/out/.svn…），避免这里多出一份口径。
        for file in crate::bmf_index::list_bmfs(&dir) {
            let hit = file
                .file_stem()
                .is_some_and(|stem| stem.to_string_lossy().eq_ignore_ascii_case(want));
            if !hit {
                continue;
            }
            let meta = match std::fs::metadata(&file) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let mtime_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            out.push(Candidate {
                path: file.to_string_lossy().into_owned(),
                module: module.clone(),
                size: meta.len(),
                mtime_ms,
            });
        }
    }

    if let Some(prefer) = preferred {
        out.sort_by_key(|c| !c.module.eq_ignore_ascii_case(prefer));
    }
    Ok(out)
}

/// 选一个候选：没指定就用第一个；指定了必须命中候选（前端只能从列表里选，
/// 不接受任意路径，这样「只读范围」永远限定在刚扫出来的那批文件里）。
pub fn pick(candidates: &[Candidate], requested: Option<&str>) -> Result<Option<Candidate>, String> {
    let Some(req) = requested.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(candidates.first().cloned());
    };
    candidates
        .iter()
        .find(|c| same_path(&c.path, req))
        .cloned()
        .map(Some)
        .ok_or_else(|| format!("{req} 不在安装目录的同名组件候选里，请重新扫描"))
}

fn same_path(a: &str, b: &str) -> bool {
    if a.eq_ignore_ascii_case(b) {
        return true;
    }
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ncwb-nchome-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn write_bmf(home: &Path, module: &str, name: &str) -> PathBuf {
        let dir = home.join("modules").join(module).join("METADATA");
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        fs::write(&p, b"<component name=\"x\"><celllist/></component>").unwrap();
        p
    }

    #[test]
    fn finds_same_named_component_in_every_module() {
        let home = tmpdir("find");
        let a = write_bmf(&home, "uapbd", "demo.bmf");
        let b = write_bmf(&home, "gl", "demo.bmf");
        write_bmf(&home, "gl", "other.bmf");
        let got = find_candidates(&home, "demo", None).unwrap();
        let paths: Vec<&str> = got.iter().map(|c| c.path.as_str()).collect();
        assert_eq!(paths.len(), 2, "{paths:?}");
        assert!(paths.contains(&a.to_string_lossy().as_ref()));
        assert!(paths.contains(&b.to_string_lossy().as_ref()));
        assert!(got.iter().all(|c| c.size > 0));
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn preferred_module_comes_first() {
        let home = tmpdir("prefer");
        write_bmf(&home, "gl", "demo.bmf");
        write_bmf(&home, "uapbd", "demo.bmf");
        let got = find_candidates(&home, "demo", Some("uapbd")).unwrap();
        assert_eq!(got[0].module, "uapbd");
        let got = find_candidates(&home, "demo", Some("GL")).unwrap();
        assert_eq!(got[0].module, "gl", "模块名按大小写不敏感比较");
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn stem_match_is_case_insensitive_and_missing_is_empty() {
        let home = tmpdir("case");
        write_bmf(&home, "uapbd", "DEMO.BMF");
        assert_eq!(find_candidates(&home, "demo", None).unwrap().len(), 1);
        assert!(find_candidates(&home, "nope", None).unwrap().is_empty());
        assert!(find_candidates(&home, "  ", None).is_err());
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn skips_src_classes_and_svn_dirs_like_the_index() {
        let home = tmpdir("skip");
        let module = home.join("modules").join("uapbd");
        for sub in ["src", "classes", ".svn"] {
            let dir = module.join(sub).join("METADATA");
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("demo.bmf"), b"<component/>").unwrap();
        }
        write_bmf(&home, "uapbd", "demo.bmf");
        assert_eq!(find_candidates(&home, "demo", None).unwrap().len(), 1);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn missing_modules_dir_is_an_error_not_empty() {
        let home = tmpdir("no-modules");
        let err = find_candidates(&home, "demo", None).unwrap_err();
        assert!(err.contains("modules"), "{err}");
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn pick_only_accepts_scanned_candidates() {
        let home = tmpdir("pick");
        write_bmf(&home, "uapbd", "demo.bmf");
        let list = find_candidates(&home, "demo", None).unwrap();
        assert_eq!(pick(&list, None).unwrap().unwrap().path, list[0].path);
        assert!(pick(&list, Some(&list[0].path)).unwrap().is_some());
        let outside = home.join("modules").join("uapbd").join("METADATA").join("other.bmf");
        fs::write(&outside, b"<component/>").unwrap();
        let err = pick(&list, Some(&outside.to_string_lossy())).unwrap_err();
        assert!(err.contains("不在"), "{err}");
        assert!(pick(&[], None).unwrap().is_none());
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn module_of_requires_metadata_parent() {
        assert_eq!(
            module_of(Path::new("D:/w/uapbd/METADATA/demo.bmf")).as_deref(),
            Some("uapbd")
        );
        assert_eq!(module_of(Path::new("D:/w/uapbd/demo.bmf")), None);
    }
}
