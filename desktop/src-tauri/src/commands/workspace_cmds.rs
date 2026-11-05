//! 工作区文件命令：选定工程根目录、列目录、读/写文本文件、新建/重命名/删除。
//!
//! 所有路径都先过 `security::path::resolve_safe_path`（白名单 = 当前工作区根），
//! 前端传 `..` 或结构上越界的路径会被拒绝。真正的 IO 都在 `workspace.rs`（纯逻辑，可单测），
//! 这里只做「解析路径 + 转发 + 放进阻塞线程」。

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::encoding_reg::{self, EncodingMark, EncodingRegistry};
use crate::security::path::display_path;
use crate::state::AppState;
use crate::workspace::{self, DirItem, Eol, FileContent, NewEntryKind, TextEncoding};

/// 换工作区时把文件监听跟着换掉（旧监听 Drop 即停）。
///
/// 监听起不来不影响切目录：树还有展开与手动刷新，监听只决定「外部改动后要不要自动刷新」。
pub fn restart_watcher(app: &tauri::AppHandle, state: &AppState, root: &str) {
    let handle = app.clone();
    let emit: Arc<dyn Fn(crate::watcher::WatchBatch) + Send + Sync> = Arc::new(move |batch| {
        if let Err(e) = handle.emit(
            "fs-changed",
            serde_json::json!({ "dirs": batch.dirs, "rescan": batch.rescan }),
        ) {
            log::warn!("推送 fs-changed 失败：{e}");
        }
    });
    *state.watcher.lock().unwrap_or_else(|e| e.into_inner()) =
        match crate::watcher::WorkspaceWatcher::start(PathBuf::from(root), emit) {
            Ok(w) => Some(w),
            Err(e) => {
                log::warn!("文件监听未启动：{e}");
                None
            }
        };
}

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
///
/// async：内部走 `spawn_blocking`。canonicalize 是同步磁盘操作，在命令体里逐个
/// 文件跑会把 IPC 层堵住（审查报告 D2）。
async fn resolve_in_workspace(state: &AppState, requested: &str) -> Result<PathBuf, String> {
    let root = workspace_root(state).await?;
    let target = if requested.is_empty() {
        root.as_str()
    } else {
        requested
    };
    crate::security::path::resolve_safe_path_async(target.to_string(), vec![root], Vec::new(), true)
        .await
}

/// 只读浏览的白名单：当前工作区 + 依赖闭包里各工程的根。
///
/// 文件树把关联工程并排显示，展开其它工程时也要能列目录；但新建/改名/删除/写文件
/// 仍只认当前工作区（`resolve_in_workspace`）——浏览不等于能改别人的工程。
///
/// `pub(crate)`：`nc_manifest_cmds` 取每个工程根的 manifest.xml 时用同一份白名单，
/// 不能再自己拼一遍（两处规则迟早走偏）。
pub(crate) async fn allowed_read_roots(state: &AppState) -> Vec<String> {
    let cfg = state.config.read().await.clone();
    let Some(primary) = cfg.workspace_root.clone() else {
        return Vec::new();
    };
    let primary_path = PathBuf::from(&primary);
    if !primary_path.is_dir() {
        return vec![primary];
    }
    let overrides = crate::eclipse_cp::active_overrides(&cfg.linked_overrides);
    let fallback = primary.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut roots = vec![primary];
        for p in crate::eclipse_cp::projects(&primary_path, &overrides) {
            let Some(root) = p.root else { continue };
            if !PathBuf::from(&root).is_dir() {
                continue;
            }
            if !roots.iter().any(|r| r.eq_ignore_ascii_case(&root)) {
                roots.push(root);
            }
        }
        roots
    })
    .await
    .unwrap_or_else(|_| vec![fallback])
}

/// 选择工程目录（系统文件夹对话框）。用户取消返回 null。
///
/// 对话框由后端拉起，前端不直接拿 `dialog:` 权限：插件权限一旦授予 WebView，
/// 任意脚本都能弹文件对话框；这里前端只拿到一个用户明确点选的路径字符串。
#[tauri::command]
pub async fn pick_folder(
    app: tauri::AppHandle,
    title: Option<String>,
    default_path: Option<String>,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // 挂到主窗口上：对话框与工作台同一个 owner，切换窗口时不会跑到后面去
        let owner = app.get_webview_window("main");
        let mut dialog = app.dialog().file();
        if let Some(w) = &owner {
            dialog = dialog.set_parent(w);
        }
        let dialog = match title.filter(|t| !t.trim().is_empty()) {
            Some(t) => dialog.set_title(t),
            None => dialog,
        };
        let dialog = match default_path
            .filter(|p| PathBuf::from(p.as_str()).is_dir())
        {
            Some(p) => dialog.set_directory(p),
            None => dialog,
        };
        dialog
            .blocking_pick_folder()
            // `simplified` 去掉 Windows 的 `\\?\` 前缀，和 set_workspace 的展示形态一致
            .map(|p| p.simplified().to_string())
    })
    .await
    .map_err(|e| format!("文件夹选择器异常：{e}"))
}

/// 选择单个文件（系统文件对话框）。用户取消返回 null。
///
/// 与 `pick_folder` 同一套约束：对话框由后端拉起，WebView 不拿 `dialog:` 权限。
/// `extensions` 只影响筛选列表，不改变「用户能选什么」——调用方仍需自己校验扩展名。
#[tauri::command]
pub async fn pick_file(
    app: tauri::AppHandle,
    title: Option<String>,
    default_path: Option<String>,
    extensions: Option<Vec<String>>,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let owner = app.get_webview_window("main");
        let mut dialog = app.dialog().file();
        if let Some(w) = &owner {
            dialog = dialog.set_parent(w);
        }
        if let Some(t) = title.filter(|t| !t.trim().is_empty()) {
            dialog = dialog.set_title(t);
        }
        let exts: Vec<String> = extensions
            .unwrap_or_default()
            .into_iter()
            .map(|e| e.trim().trim_start_matches('.').to_string())
            .filter(|e| !e.is_empty())
            .collect();
        if !exts.is_empty() {
            let refs: Vec<&str> = exts.iter().map(String::as_str).collect();
            dialog = dialog.add_filter("支持的文件", &refs);
        }
        let dialog = match default_path
            .filter(|p| PathBuf::from(p.as_str()).is_dir())
        {
            Some(p) => dialog.set_directory(p),
            None => dialog,
        };
        dialog
            .blocking_pick_file()
            .map(|p| p.simplified().to_string())
    })
    .await
    .map_err(|e| format!("文件选择器异常：{e}"))
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
    app: tauri::AppHandle,
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
    restart_watcher(&app, &state, &shown);
    Ok(shown)
}

/// 列目录（`path` 为空 = 工作区根）。
///
/// 白名单放宽到「当前工作区 + 关联工程根」：文件树要能浏览其它工程的目录，
/// 这只是读列表；写操作仍只允许当前工作区。
#[tauri::command]
pub async fn fs_list_dir(
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
) -> Result<Vec<DirItem>, String> {
    let roots = allowed_read_roots(&state).await;
    if roots.is_empty() {
        return Err("尚未选择工作区目录".to_string());
    }
    let target = if path.is_empty() {
        roots[0].clone()
    } else {
        path
    };
    let dir =
        crate::security::path::resolve_safe_path_async(target, roots, Vec::new(), true).await?;
    tauri::async_runtime::spawn_blocking(move || workspace::list_dir(&dir))
        .await
        .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 索引单个已展开源码根的包目录，沿用文件树的读取范围。
#[tauri::command]
pub async fn fs_package_dirs(
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
) -> Result<Vec<workspace::PackageDir>, String> {
    let roots = allowed_read_roots(&state).await;
    if roots.is_empty() || path.is_empty() {
        return Err("未指定源码根".into());
    }
    let dir = crate::security::path::resolve_safe_path_async(path, roots, Vec::new(), true).await?;
    tauri::async_runtime::spawn_blocking(move || workspace::package_dirs(&dir))
        .await
        .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 只识别当前已展开目录里的 Java 文件，读取权限与列目录一致。
#[tauri::command]
pub async fn fs_java_kinds(
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
    names: Vec<String>,
) -> Result<std::collections::BTreeMap<String, crate::java_tree::JavaKind>, String> {
    if names.len() > crate::java_tree::MAX_BATCH || path.is_empty() {
        return Err("Java 类型识别批次超出范围".into());
    }
    let roots = allowed_read_roots(&state).await;
    let dir = crate::security::path::resolve_safe_path_async(path, roots, Vec::new(), true).await?;
    tauri::async_runtime::spawn_blocking(move || crate::java_tree::kinds_in_directory(&dir, names))
        .await
        .map_err(|e| format!("后台任务失败: {e}"))
}

/// Java 大纲可以查看关联工程，权限与文件树一致。
#[tauri::command]
pub async fn fs_java_outline_source(
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
) -> Result<String, String> {
    let roots = allowed_read_roots(&state).await;
    let file = crate::security::path::resolve_safe_path_async(path, roots, Vec::new(), true).await?;
    tauri::async_runtime::spawn_blocking(move || {
        if !encoding_reg::is_java_source(&file) || !file.is_file() {
            return Err("只支持 Java 源文件".into());
        }
        let size = file.metadata().map_err(|e| format!("读取 Java 文件失败：{e}"))?.len();
        if size > 512 * 1024 {
            return Err("文件过大，请在编辑器中查看结构".into());
        }
        workspace::read_text_file(&file).map(|doc| doc.text)
    }).await.map_err(|e| format!("后台任务失败: {e}"))?
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
        // 逐个 canonicalize 是同步磁盘操作：走 spawn_blocking，不能在命令体里排队跑
        // （一棵树可能一次传上百个 .java，审查报告 D2）
        let file = crate::security::path::resolve_safe_path_async(
            shown.clone(),
            vec![root.clone()],
            Vec::new(),
            true,
        )
        .await;
        if let Ok(file) = file {
            targets.push((shown, file));
        }
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
