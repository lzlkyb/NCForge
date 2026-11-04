//! 工程 `manifest.xml` 的业务组件清单：给文件树做「业务组件」徽章、给搜索做组件范围，
//! 以及回答「磁盘上有、登记表里没有」的那些模块叫什么。
//!
//! 解析逻辑与格式判断全在 `nc_manifest.rs`（纯逻辑、可单测），这里只解析工程根 + 转发。
//! 读不到就不给徽章——manifest 不是树的真源，它坏了不能影响树。

use std::path::PathBuf;
use std::sync::Arc;

use crate::nc_manifest::{self, ManifestAudit, NcManifest};
use crate::state::AppState;

/// 把可选参数解析成一个在白名单里的绝对路径（不传 = 当前工作区根）。
///
/// 白名单与 `fs_list_dir` 一致：当前工作区 + 关联工程根。多工程树里每个工程各有
/// 一份 manifest，前端按工程根分别取；只认当前工作区的话，关联工程那一列的模块
/// 会一个徽章都没有。
pub(super) async fn resolve_root(
    state: &AppState,
    root: Option<String>,
) -> Result<PathBuf, String> {
    let requested = match root {
        Some(r) if !r.trim().is_empty() => r,
        _ => state
            .config
            .read()
            .await
            .workspace_root
            .clone()
            .ok_or_else(|| "尚未选择工作区目录".to_string())?,
    };
    let roots = super::workspace_cmds::allowed_read_roots(state).await;
    if roots.is_empty() {
        return Err("尚未选择工作区目录".to_string());
    }
    crate::security::path::resolve_safe_path_async(requested, roots, Vec::new(), true).await
}

/// 读某个工程根的 `manifest.xml`（不传 = 当前工作区根）。
#[tauri::command]
pub async fn nc_manifest(
    state: tauri::State<'_, Arc<AppState>>,
    root: Option<String>,
) -> Result<NcManifest, String> {
    let dir = resolve_root(state.inner(), root).await?;
    tauri::async_runtime::spawn_blocking(move || nc_manifest::read(&dir))
        .await
        .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 登记缺口：磁盘上有模块目录、manifest 没登记的那些（不传 root = 当前工作区根）。
///
/// 只做解释，不做体检报告：登记表由 NC 设计器维护，平台/工具模块本来就不在里面，
/// 界面只陈述「这 N 个目录没登记」这个事实，用来回答「为什么 `aim` 不在组件范围里」。
#[tauri::command]
pub async fn nc_manifest_audit(
    state: tauri::State<'_, Arc<AppState>>,
    root: Option<String>,
) -> Result<ManifestAudit, String> {
    let dir = resolve_root(state.inner(), root).await?;
    tauri::async_runtime::spawn_blocking(move || {
        // manifest 读不到就整块不给（前端不显示那行提示）：没有登记表时「缺口」
        // 这个词没有意义，列出全部模块只会变成噪声。
        let manifest = nc_manifest::read(&dir)?;
        let on_disk = crate::eclipse_cp::module_dirs_of(&dir);
        Ok(nc_manifest::audit(&manifest, &on_disk))
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}
