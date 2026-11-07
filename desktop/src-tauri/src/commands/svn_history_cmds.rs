//! 版本阅读与冲突正文命令，沿用 SVN 桥、凭据和工作副本路径边界。
use super::svn_cmds as svn;
use crate::{
    config::AppConfig, security::path::display_path, state::AppState, svn_history::*, workspace,
};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::AppHandle;

fn check_root(cfg: &AppConfig, expected: &str) -> Result<PathBuf, String> {
    let actual = svn::root_of(cfg)?;
    let actual = std::fs::canonicalize(actual).map_err(|e| format!("工作副本不可用: {e}"))?;
    let requested =
        std::fs::canonicalize(expected).map_err(|_| "来源工作副本不可用".to_string())?;
    if actual != requested {
        return Err("工作副本已切换，请在来源工程重新操作".to_string());
    }
    Ok(crate::nc_home::strip_verbatim(&actual))
}

#[tauri::command]
pub async fn svn_history(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    root: String,
    path: String,
    limit: u32,
    from: i64,
) -> Result<HistoryResult, String> {
    let cfg = state.config.read().await.clone();
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let source = check_root(&cfg, &root)?;
        let target = svn::safe_path(&cfg, &path)?;
        let bridge = svn::bridge_for(&app, &st, &cfg)?;
        let info = svn::wc_info(&bridge, &source)?;
        svn::ensure_auth(&bridge, &cfg, &info.host)?;
        let value = bridge
            .call(
                "history",
                &[
                    &display_path(&target),
                    &limit.clamp(1, 200).to_string(),
                    &from.max(0).to_string(),
                ],
                svn::T_NET,
            )
            .map_err(|e| svn::split_code_label(e.code, e.message))?;
        serde_json::from_value(value).map_err(|e| format!("历史数据无效: {e}"))
    })
    .await
    .map_err(|e| format!("读取历史失败: {e}"))?
}

#[tauri::command]
pub async fn svn_revision_diff(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    root: String,
    repository_path: String,
    revision: i64,
) -> Result<RevisionDiff, String> {
    if revision < 1 {
        return Err("版本号必须大于零".to_string());
    }
    let cfg = state.config.read().await.clone();
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let source = check_root(&cfg, &root)?;
        let bridge = svn::bridge_for(&app, &st, &cfg)?;
        let info = svn::wc_info(&bridge, &source)?;
        svn::ensure_auth(&bridge, &cfg, &info.host)?;
        let value = bridge
            .call(
                "revision_diff",
                &[
                    &display_path(&source),
                    &repository_path,
                    &revision.to_string(),
                ],
                svn::T_NET,
            )
            .map_err(|e| svn::split_code_label(e.code, e.message))?;
        let (before_text, before_encoding) = decode_content(&value["before"])?;
        let (after_text, after_encoding) = decode_content(&value["after"])?;
        Ok(RevisionDiff {
            path: repository_path,
            before_path: value["beforePath"].as_str().unwrap_or("").to_string(),
            before_revision: value["beforeRevision"].as_i64().unwrap_or(0),
            revision,
            before_empty: value["beforeEmpty"].as_bool().unwrap_or(false),
            after_empty: value["afterEmpty"].as_bool().unwrap_or(false),
            before_text,
            after_text,
            before_encoding,
            after_encoding,
        })
    })
    .await
    .map_err(|e| format!("读取版本差异失败: {e}"))?
}

#[tauri::command]
pub async fn svn_blame_snapshot(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    root: String,
    path: String,
    revision: i64,
) -> Result<BlameSnapshot, String> {
    if revision < 0 {
        return Err("版本号不能小于零".to_string());
    }
    let cfg = state.config.read().await.clone();
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let source = check_root(&cfg, &root)?;
        let target = svn::safe_path(&cfg, &path)?;
        let bridge = svn::bridge_for(&app, &st, &cfg)?;
        let info = svn::wc_info(&bridge, &source)?;
        svn::ensure_auth(&bridge, &cfg, &info.host)?;
        let value = bridge
            .call(
                "blame_snapshot",
                &[&display_path(&target), &revision.to_string()],
                svn::T_NET,
            )
            .map_err(|e| svn::split_code_label(e.code, e.message))?;
        serde_json::from_value(value).map_err(|e| format!("追溯数据无效: {e}"))
    })
    .await
    .map_err(|e| format!("读取逐行追溯失败: {e}"))?
}

#[tauri::command]
pub async fn svn_conflict_snapshot(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    root: String,
    path: String,
) -> Result<ConflictSnapshot, String> {
    let cfg = state.config.read().await.clone();
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        check_root(&cfg, &root)?;
        let target = svn::safe_path(&cfg, &path)?;
        let bridge = svn::bridge_for(&app, &st, &cfg)?;
        let value = bridge
            .call("conflict_snapshot", &[&display_path(&target)], svn::T_NET)
            .map_err(|e| svn::split_code_label(e.code, e.message))?;
        let working = workspace::read_text_file(&target).ok();
        Ok(ConflictSnapshot {
            tree_conflict: value["treeConflict"].as_bool().unwrap_or(false),
            property_conflict: value["propertyConflict"].as_bool().unwrap_or(false),
            text_conflict: value["textConflict"].as_bool().unwrap_or(false),
            mine: conflict_version(&value["mine"])?,
            base: conflict_version(&value["base"])?,
            theirs: conflict_version(&value["theirs"])?,
            working_readable: working.is_some(),
            working_has_markers: working
                .as_ref()
                .is_some_and(|v| has_conflict_markers(&v.text)),
        })
    })
    .await
    .map_err(|e| format!("读取冲突副本失败: {e}"))?
}

#[tauri::command]
pub async fn svn_resolve_working(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    root: String,
    path: String,
) -> Result<svn::ResolveResult, String> {
    let cfg = state.config.read().await.clone();
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let source = check_root(&cfg, &root)?;
        let target = svn::safe_path(&cfg, &path)?;
        let content = workspace::read_text_file(&target)?;
        if has_conflict_markers(&content.text) {
            return Err("工作副本仍含冲突标记，请完成手工合并并保存".to_string());
        }
        let bridge = svn::bridge_for(&app, &st, &cfg)?;
        let conflict = bridge
            .call("conflict_snapshot", &[&display_path(&target)], svn::T_NET)
            .map_err(|e| svn::split_code_label(e.code, e.message))?;
        if conflict["treeConflict"].as_bool().unwrap_or(false)
            || conflict["propertyConflict"].as_bool().unwrap_or(false)
        {
            return Err("树冲突或属性冲突需要 SVN 客户端处理".to_string());
        }
        if !conflict["textConflict"].as_bool().unwrap_or(false) {
            return Err("这个文件已经没有文本冲突".to_string());
        }
        let backup = svn::backup_conflict_files(&source, &target, &st.config_dir, &path)?;
        bridge
            .call("resolve_working", &[&display_path(&target)], svn::T_NET)
            .map_err(|e| svn::split_code_label(e.code, e.message))?;
        Ok(svn::ResolveResult {
            backup_dir: backup.map(|p| display_path(&p)),
        })
    })
    .await
    .map_err(|e| format!("保留合并结果失败: {e}"))?
}

// ─────────────────── 元数据页：按组件路径取历史与历史正文 ───────────────────

/// 版本正文（历史修订 / 冲突副本同口径：解码后统一 LF）。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionText {
    pub revision: i64,
    pub source_path: String,
    pub text: String,
    pub encoding: String,
    pub empty: bool,
}

/// 从文件路径向上找工作副本根。SVN 1.7+ 只有 WC 根带 `.svn`。
fn wc_root_of(file: &Path) -> Result<PathBuf, String> {
    let mut cur = file.to_path_buf();
    if cur.is_file() {
        cur.pop();
    }
    loop {
        if cur.join(".svn").is_dir() {
            return Ok(cur);
        }
        if !cur.pop() {
            return Err("这个组件不在 SVN 工作副本内".to_string());
        }
    }
}

/// 元数据页只认工作区与链接工程内的文件：历史命令不接受任意本地路径。
fn checked_target(cfg: &AppConfig, path: &str) -> Result<(PathBuf, PathBuf), String> {
    let primary = super::bmf_cmds::primary_root(cfg)?;
    let overrides = crate::eclipse_cp::active_overrides(&cfg.linked_overrides);
    let allowed: Vec<PathBuf> = super::bmf_cmds::roots(&primary, &overrides)
        .into_iter()
        .map(|r| r.path)
        .collect();
    let file = std::fs::canonicalize(path.trim()).map_err(|_| "组件文件不可用".to_string())?;
    let inside = allowed.iter().any(|root| {
        let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.clone());
        file.starts_with(root)
    });
    if !inside {
        return Err("只支持工作区或链接工程内的组件".to_string());
    }
    let wc = wc_root_of(&file)?;
    Ok((file, wc))
}

/// 组件在 SVN 里的历史。SC 根由文件路径推导——链接工程的工作副本不在主工作区下面。
#[tauri::command]
pub async fn bmf_history(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
    limit: u32,
    from: i64,
) -> Result<HistoryResult, String> {
    let cfg = state.config.read().await.clone();
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (file, wc) = checked_target(&cfg, &path)?;
        let bridge = svn::bridge_for(&app, &st, &cfg)?;
        let info = svn::wc_info(&bridge, &wc)?;
        svn::ensure_auth(&bridge, &cfg, &info.host)?;
        let value = bridge
            .call(
                "history",
                &[
                    &display_path(&file),
                    &limit.clamp(1, 200).to_string(),
                    &from.max(0).to_string(),
                ],
                svn::T_NET,
            )
            .map_err(|e| svn::split_code_label(e.code, e.message))?;
        serde_json::from_value(value).map_err(|e| format!("历史数据无效: {e}"))
    })
    .await
    .map_err(|e| format!("读取历史失败: {e}"))?
}

/// 某个修订里的组件正文。`afterText` 就是该修订的完整文件，交前端解析成语义模型。
#[tauri::command]
pub async fn bmf_revision_text(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
    repository_path: String,
    revision: i64,
) -> Result<RevisionText, String> {
    if revision < 1 {
        return Err("版本号必须大于零".to_string());
    }
    let cfg = state.config.read().await.clone();
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (file, wc) = checked_target(&cfg, &path)?;
        let bridge = svn::bridge_for(&app, &st, &cfg)?;
        let info = svn::wc_info(&bridge, &wc)?;
        svn::ensure_auth(&bridge, &cfg, &info.host)?;
        let value = bridge
            .call(
                "revision_diff",
                &[&display_path(&wc), &repository_path, &revision.to_string()],
                svn::T_NET,
            )
            .map_err(|e| svn::split_code_label(e.code, e.message))?;
        let (text, encoding) = decode_content(&value["after"])?;
        Ok(RevisionText {
            revision,
            source_path: display_path(&file),
            empty: value["afterEmpty"].as_bool().unwrap_or(false),
            text,
            encoding,
        })
    })
    .await
    .map_err(|e| format!("读取修订正文失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "ncforge-bmf-history-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn wc_root_is_found_from_a_nested_file() {
        let root = tmpdir("wc");
        std::fs::create_dir_all(root.join(".svn")).unwrap();
        std::fs::create_dir_all(root.join("uapbd").join("METADATA")).unwrap();
        let file = root.join("uapbd").join("METADATA").join("demo.bmf");
        std::fs::write(&file, b"<component/>").unwrap();
        assert_eq!(wc_root_of(&file).unwrap(), root);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn file_without_working_copy_is_rejected() {
        let root = tmpdir("nocopy");
        let file = root.join("demo.bmf");
        std::fs::write(&file, b"<component/>").unwrap();
        assert!(wc_root_of(&file)
            .unwrap_err()
            .contains("不在 SVN 工作副本内"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn stale_or_missing_workspace_is_rejected() {
        let cfg = AppConfig::default();
        assert!(check_root(&cfg, "C:/not-a-workspace").is_err());
    }
}
