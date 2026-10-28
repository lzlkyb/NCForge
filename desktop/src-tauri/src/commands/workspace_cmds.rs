//! 工作区文件命令：选定工程根目录、列目录、读/写文本文件、新建/重命名/删除。
//!
//! 所有路径都先过 `security::path::resolve_safe_path`（白名单 = 当前工作区根），
//! 前端传 `..` 或结构上越界的路径会被拒绝。真正的 IO 都在 `workspace.rs`（纯逻辑，可单测），
//! 这里只做「解析路径 + 转发 + 放进阻塞线程」。

use std::path::PathBuf;
use std::sync::Arc;

use crate::encoding_reg::{self, EncodingMark, EncodingRegistry};
use crate::security::path::{display_path, resolve_safe_path};
use crate::state::AppState;
use crate::workspace::{self, DirItem, Eol, FileContent, NewEntryKind, TextEncoding};

/// 当前工作区根；未选择时返回 Err，让前端引导用户先选目录。
async fn workspace_root(state: &AppState) -> Result<String, String> {
    state
        .config
        .read()
        .await
        .workspace_root
        .clone()
        .ok_or_else(|| "尚未选择工作区目录".to_string())
}

/// 把前端传来的路径解析成工作区内的真实路径（空路径 = 工作区根本身）。
async fn resolve_in_workspace(state: &AppState, requested: &str) -> Result<PathBuf, String> {
    let root = workspace_root(state).await?;
    let target = if requested.is_empty() {
        root.as_str()
    } else {
        requested
    };
    resolve_safe_path(target, std::slice::from_ref(&root), &[], true)
}

/// 读当前工作区根（未选择为 null）。
#[tauri::command]
pub async fn get_workspace(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Option<String>, String> {
    Ok(state.config.read().await.workspace_root.clone())
}

/// 设置工作区根并落盘。返回规范化后的路径（去掉 `\\?\` 前缀），前端用它刷新显示。
#[tauri::command]
pub async fn set_workspace(
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
) -> Result<String, String> {
    let canonical = std::fs::canonicalize(path.trim()).map_err(|e| format!("目录不可用: {e}"))?;
    if !canonical.is_dir() {
        return Err("选择的不是目录".to_string());
    }
    let shown = display_path(&canonical);
    // update_config 而不是「读一份改一份写回去」：与服务页的 NC home / 堆上限
    // 共用同一把写锁，避免两处同时改配置时互相覆盖
    let target = shown.clone();
    state
        .update_config(move |cfg| {
            cfg.workspace_root = Some(target);
            Ok(())
        })
        .await?;
    Ok(shown)
}

/// 列目录（`path` 为空 = 工作区根）。
#[tauri::command]
pub async fn fs_list_dir(
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
) -> Result<Vec<DirItem>, String> {
    let dir = resolve_in_workspace(&state, &path).await?;
    tauri::async_runtime::spawn_blocking(move || workspace::list_dir(&dir))
        .await
        .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 读文本文件（识别编码/换行，校验能否无损往返）。
#[tauri::command]
pub async fn fs_read_file(
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
) -> Result<FileContent, String> {
    let file = resolve_in_workspace(&state, &path).await?;
    tauri::async_runtime::spawn_blocking(move || workspace::read_text_file(&file))
        .await
        .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 写文本文件，返回新的修改时间。磁盘已被其他程序改过时返回以 `CONFLICT` 开头的错误。
#[tauri::command]
pub async fn fs_write_file(
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
    text: String,
    encoding: TextEncoding,
    has_bom: bool,
    eol: Eol,
    expected_mtime_ms: Option<u64>,
) -> Result<u64, String> {
    if path.is_empty() {
        return Err("缺少文件路径".to_string());
    }
    let file = resolve_in_workspace(&state, &path).await?;
    tauri::async_runtime::spawn_blocking(move || {
        workspace::write_text_file(&file, &text, encoding, has_bom, eol, expected_mtime_ms)
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 在 `parent` 下新建空文件或文件夹，返回新条目的完整路径（前端拿它去打开/展开）。
#[tauri::command]
pub async fn fs_create(
    state: tauri::State<'_, Arc<AppState>>,
    parent: String,
    name: String,
    kind: NewEntryKind,
) -> Result<String, String> {
    let dir = resolve_in_workspace(&state, &parent).await?;
    let created =
        tauri::async_runtime::spawn_blocking(move || workspace::create_entry(&dir, &name, kind))
            .await
            .map_err(|e| format!("后台任务失败: {e}"))??;
    Ok(display_path(&created))
}

/// 同目录内改名，返回新路径。新名字可以是仅大小写不同的（Windows 上要中转到临时名）。
#[tauri::command]
pub async fn fs_rename(
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
    new_name: String,
) -> Result<String, String> {
    if path.is_empty() {
        return Err("不能重命名工作区根目录".to_string());
    }
    let old = resolve_in_workspace(&state, &path).await?;
    let renamed =
        tauri::async_runtime::spawn_blocking(move || workspace::rename_entry(&old, &new_name))
            .await
            .map_err(|e| format!("后台任务失败: {e}"))??;
    Ok(display_path(&renamed))
}

/// 删除文件或文件夹。文件夹必须带 `recursive`，前端会先数清文件数再问一次。
#[tauri::command]
pub async fn fs_delete(
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
    recursive: bool,
) -> Result<(), String> {
    if path.is_empty() {
        return Err("不能删除工作区根目录".to_string());
    }
    let target = resolve_in_workspace(&state, &path).await?;
    tauri::async_runtime::spawn_blocking(move || workspace::delete_entry(&target, recursive))
        .await
        .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 编码标记：挑出「磁盘上是 UTF-8、Eclipse 却会按 GBK 读」的 `.java` 文件。
///
/// 只影响展示（树上标 `UTF-8!`），不改任何文件；解析不了的路径直接跳过——
/// 树传上来的路径本来就是工作区内的，跳过只可能是文件刚被删掉。
#[tauri::command]
pub async fn fs_encoding_marks(
    state: tauri::State<'_, Arc<AppState>>,
    paths: Vec<String>,
) -> Result<Vec<EncodingMark>, String> {
    let root = workspace_root(&state).await?;
    let mut targets: Vec<(String, PathBuf)> = Vec::new();
    for shown in paths {
        if !encoding_reg::is_java_source(std::path::Path::new(&shown)) {
            continue;
        }
        let Ok(file) = resolve_safe_path(&shown, std::slice::from_ref(&root), &[], true) else {
            continue;
        };
        targets.push((shown, file));
    }
    if targets.is_empty() {
        return Ok(Vec::new());
    }
    tauri::async_runtime::spawn_blocking(move || {
        // 根也要 canonicalize：文件和根必须同一种形态，strip_prefix 才不会因为 `\\?\` 前缀对不上
        let root = std::fs::canonicalize(&root).unwrap_or_else(|_| PathBuf::from(&root));
        let reg = EncodingRegistry::load(&root);
        targets
            .into_iter()
            .filter_map(|(shown, file)| {
                encoding_reg::check_java(&file, &root, &reg).map(|issue| EncodingMark {
                    path: shown,
                    registered: issue.registered,
                })
            })
            .collect()
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))
}

/// 数目录下的文件数（递归），删除确认弹窗用。传文件路径返回 1。
#[tauri::command]
pub async fn fs_count_files(
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
) -> Result<u64, String> {
    let target = resolve_in_workspace(&state, &path).await?;
    tauri::async_runtime::spawn_blocking(move || {
        if target.is_dir() {
            workspace::count_files(&target)
        } else {
            1
        }
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))
}
