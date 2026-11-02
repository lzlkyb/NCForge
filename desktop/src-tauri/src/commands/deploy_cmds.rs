//! 「配置投送」命令层：预览 / 落地 / 清理 / 状态。
//!
//! 算法全在 `nchome_deploy.rs`（纯逻辑、可单测）；这里只做三件事：
//! 取配置 → 解析 NCHOME 与工程组合 → 把阻塞的磁盘操作丢进 `spawn_blocking`。
//!
//! 与启动/编译的挂点同一份输入（`deploy_for_workspace`），保证界面上看到的
//! 「将要投送什么」和实际启动时写下去的完全一致。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::eclipse_cp;
use crate::nc_home;
use crate::nchome_deploy::{self, CleanupReport, DeployReport, DeployStatus};
use crate::state::AppState;

struct Inputs {
    config_dir: PathBuf,
    workspace: Option<PathBuf>,
    home: PathBuf,
    overrides: Vec<eclipse_cp::LinkedOverride>,
}

async fn inputs(state: &AppState) -> Result<Inputs, String> {
    let (config_dir, cfg) = {
        let cfg = state.config.read().await.clone();
        (state.config_dir.clone(), cfg)
    };
    let workspace = cfg
        .workspace_root
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    // NC home 解析失败在预览/状态下也是可读错误：界面据此提示去服务页选目录
    let home = nc_home::resolve(cfg.nc_home.as_deref())?;
    Ok(Inputs {
        config_dir,
        workspace,
        home: PathBuf::from(home.root),
        overrides: eclipse_cp::active_overrides(&cfg.linked_overrides),
    })
}

fn workspace_of(inputs: &Inputs) -> Result<&Path, String> {
    inputs
        .workspace
        .as_deref()
        .ok_or_else(|| "尚未选择工作区目录".to_string())
}

/// 预览：算出本次会新增/更新/接管/跳过哪些文件，不做任何写入。
#[tauri::command]
pub async fn deploy_preview(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<DeployReport, String> {
    let inputs = inputs(&state).await?;
    let ws = workspace_of(&inputs)?.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        nchome_deploy::deploy_for_workspace(
            &inputs.config_dir,
            &ws,
            &inputs.home,
            &inputs.overrides,
            false,
        )
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 落地：按预览的同一套规则写文件（manifest + 备份）。
#[tauri::command]
pub async fn deploy_apply(state: tauri::State<'_, Arc<AppState>>) -> Result<DeployReport, String> {
    let inputs = inputs(&state).await?;
    let ws = workspace_of(&inputs)?.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        nchome_deploy::deploy_for_workspace(
            &inputs.config_dir,
            &ws,
            &inputs.home,
            &inputs.overrides,
            true,
        )
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 清理：只删 manifest 里登记为「写过」且内容未变的文件，并还原备份。
#[tauri::command]
pub async fn deploy_cleanup(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<CleanupReport, String> {
    let inputs = inputs(&state).await?;
    tauri::async_runtime::spawn_blocking(move || {
        nchome_deploy::cleanup(&inputs.config_dir, &inputs.home)
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 当前部署状态（服务页卡片）。
#[tauri::command]
pub async fn deploy_status(state: tauri::State<'_, Arc<AppState>>) -> Result<DeployStatus, String> {
    let inputs = inputs(&state).await?;
    tauri::async_runtime::spawn_blocking(move || {
        nchome_deploy::status(&inputs.config_dir, &inputs.home)
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}
