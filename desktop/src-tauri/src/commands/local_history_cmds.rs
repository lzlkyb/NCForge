//! 本地历史命令：归档 / 列表 / 读取预览 / 恢复。
//!
//! 与 `search_cmds` 同一种范式：路径参数只是「哪个文件」，真正的归档 IO 在
//! `crate::local_history`（纯逻辑 + 单测）里。但**入参路径必须先过工作区白名单**：
//! history 目录本身在配置目录下，可 `restore` 会把历史字节**写回目标文件**，
//! 少了这一关就等于给 WebView 开了一个任意路径写口子。

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;

use crate::local_history::{self, HistoryVersion, KEEP_PER_FILE, MAX_PREVIEW_BYTES};
use crate::security::path::resolve_safe_path;
use crate::state::AppState;
use crate::workspace;

/// 把前端路径解析成工作区内（或不存在但在工作区内）的真实路径。
///
/// 与 `workspace_cmds::resolve_in_workspace` 同一把尺子：`..` 穿越、符号链接
/// 逃逸、绝对路径越界都会被拒。历史页只对工作区文件有意义，收紧没有损失。
fn resolve_history_path(root: &str, requested: &str) -> Result<PathBuf, String> {
    // 这里 canonicalize 后的路径与 local_history::stable_key 的键一致
    // （后者同样 canonicalize 并去 `\\?\` 前缀），历史版本不会因入口变化而失联。
    resolve_safe_path(requested, &[root.to_string()], &[], true)
}

async fn resolve_in_workspace(state: &AppState, requested: &str) -> Result<PathBuf, String> {
    let root = state
        .config
        .read()
        .await
        .workspace_root
        .clone()
        .ok_or_else(|| "尚未选择工作区目录".to_string())?;
    resolve_history_path(&root, requested)
}

/// 一个历史版本的预览内容。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionPreview {
    /// 原始字节数。
    pub size: u64,
    /// 解码后的文本（按检测出的编码，GBK 也能看）。超大版本为 `null`。
    pub text: Option<String>,
    /// 文本是否因过大被截断。
    pub truncated: bool,
    /// 这一版归档时间（Unix ms），与列表里的 `ts` 一致。
    pub ts: u64,
}

/// 归档一个文件的当前磁盘内容。内容没变返回 `null`（前端不用提示）。
///
/// 前端在**保存之前**调它：拿到的是改动前的内容，这是本地历史最有价值的一版。
#[tauri::command]
pub async fn local_history_capture(
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
) -> Result<Option<String>, String> {
    let cfg = state.config_dir.clone();
    let p = resolve_in_workspace(&state, &path).await?;
    tauri::async_runtime::spawn_blocking(move || local_history::capture(&cfg, &p, KEEP_PER_FILE))
        .await
        .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 列出一个文件的历史版本（最新在前）。
#[tauri::command]
pub async fn local_history_list(
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
) -> Result<Vec<HistoryVersion>, String> {
    let cfg = state.config_dir.clone();
    let p = resolve_in_workspace(&state, &path).await?;
    tauri::async_runtime::spawn_blocking(move || local_history::list(&cfg, &p))
        .await
        .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 读一个历史版本用于预览（差异对比用）。超大版本只回大小。
#[tauri::command]
pub async fn local_history_read(
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
    id: String,
) -> Result<VersionPreview, String> {
    let cfg = state.config_dir.clone();
    let p = resolve_in_workspace(&state, &path).await?;
    let (bytes, ts) = tauri::async_runtime::spawn_blocking(move || {
        let vs = local_history::list(&cfg, &p)?;
        let v = vs
            .into_iter()
            .find(|v| v.id == id)
            .ok_or_else(|| "这个版本已经不在历史里了（可能被上限淘汰）".to_string())?;
        let bytes = local_history::read_version(&cfg, &p, &id)?;
        Ok::<_, String>((bytes, v.ts))
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))??;
    let size = bytes.len() as u64;
    let (text, truncated) = if size > MAX_PREVIEW_BYTES as u64 {
        (None, true)
    } else {
        (Some(workspace::decode_lossy(&bytes)), false)
    };
    Ok(VersionPreview {
        size,
        text,
        truncated,
        ts,
    })
}

/// 恢复一个历史版本（把那时的字节写回文件）。
///
/// `expected_mtime_ms`（前端传 `expectedMtimeMs`，Tauri 自动转换）：前端读文件时
/// 记下的 mtime；磁盘被改过就报 `CONFLICT`。
/// 恢复前会先把当前内容归档一版——恢复也是一次改动，得能再退回来。
#[tauri::command]
pub async fn local_history_restore(
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
    id: String,
    expected_mtime_ms: Option<u64>,
) -> Result<(), String> {
    let cfg = state.config_dir.clone();
    let p = resolve_in_workspace(&state, &path).await?;
    tauri::async_runtime::spawn_blocking(move || {
        local_history::restore(&cfg, &p, &id, expected_mtime_ms)
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ncwb-hist-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn 工作区内路径放行_越界与穿越一律拒绝() {
        let root = tmpdir("root");
        let inside = root.join("src").join("A.java");
        std::fs::create_dir_all(inside.parent().unwrap()).unwrap();
        std::fs::write(&inside, "int a;").unwrap();
        let outside = tmpdir("outside");
        let outside_file = outside.join("secret.txt");
        std::fs::write(&outside_file, "x").unwrap();

        let root_s = root.to_string_lossy().to_string();
        assert!(resolve_history_path(&root_s, &inside.to_string_lossy()).is_ok());
        // 已删除但仍在工作区内的文件：恢复需要用这个入口写回去
        let gone = root.join("src").join("Gone.java");
        assert!(resolve_history_path(&root_s, &gone.to_string_lossy()).is_ok());
        assert!(resolve_history_path(&root_s, &outside_file.to_string_lossy()).is_err());
        let dotted = root.join("..").join("escape.java");
        assert!(resolve_history_path(&root_s, &dotted.to_string_lossy()).is_err());
        assert!(resolve_history_path(&root_s, "").is_err());
    }
}
