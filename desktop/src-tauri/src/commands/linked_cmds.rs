//! 工程关联（多工程）的 IPC 命令：读依赖链、改覆盖表、切工作区。
//!
//! 为什么单独一个模块而不是塞进 `workspace_cmds`：这里的「工程」是**依赖闭包**里的
//! 每个工程，不是一个目录——切换工作区只是它的一个动作。放一起会让 `workspace_cmds`
//! 从「文件系统操作」变成「类路径解析」，职责糊掉。
//!
//! 真源仍是 `.classpath`（见 `eclipse_cp`）。这里的覆盖表只影响**我们怎么算类路径**，
//! 不回写任何工程文件。

use std::path::PathBuf;
use std::sync::Arc;

use crate::config::LinkedOverrideConfig;
use crate::eclipse_cp::{self, LinkedGraph, OverrideAction};
use crate::state::AppState;

/// 解析当前工作区的依赖闭包，返回给「工程关联」页。
///
/// `root` 可选：不传就用配置里的工作区根。传了用来「预演」——界面在切换工作区之前
/// 先看看那个工程依赖了谁，不必先改配置（切了再切回去是有代价的：jdt.ls 要重建索引）。
#[tauri::command]
pub async fn linked_projects(
    state: tauri::State<'_, Arc<AppState>>,
    root: Option<String>,
) -> Result<LinkedGraph, String> {
    let cfg = state.config.read().await.clone();
    let primary = match root.map(|r| r.trim().to_string()).filter(|r| !r.is_empty()) {
        Some(r) => PathBuf::from(r),
        None => cfg
            .workspace_root
            .clone()
            .map(PathBuf::from)
            .ok_or_else(|| "还没有选择工作区目录，先去「文件」页打开一个工程".to_string())?,
    };
    if !primary.is_dir() {
        return Err(format!("工作区目录不存在：{}", primary.display()));
    }
    let home = crate::nc_home::resolve(cfg.nc_home.as_deref())?;
    let nc_home = PathBuf::from(&home.root);

    // 读盘 + 解析依赖，节点多时（250 个模块）也要几百毫秒，别占着 async 线程
    tauri::async_runtime::spawn_blocking(move || {
        let overrides = eclipse_cp::active_overrides(&cfg.linked_overrides);
        eclipse_cp::graph(&primary, &nc_home, &overrides)
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))
}

/// 覆盖表里的一条（前端提交的形态）。动作非法时**整体拒绝**，不做「跳过坏条目」：
/// 保存路径上的静默丢弃会让用户以为存上了，改了半天不生效还找不到原因。
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverrideInput {
    pub action: String,
    #[serde(default)]
    pub target: String,
    #[serde(default)]
    pub dir: Option<String>,
}

/// 全量替换覆盖表并落盘。返回落盘后的列表（前端据此刷新，避免本地状态与服务端漂移）。
#[tauri::command]
pub async fn set_linked_overrides(
    state: tauri::State<'_, Arc<AppState>>,
    overrides: Vec<OverrideInput>,
) -> Result<Vec<LinkedOverrideConfig>, String> {
    let mut cleaned: Vec<LinkedOverrideConfig> = Vec::with_capacity(overrides.len());
    for (i, o) in overrides.into_iter().enumerate() {
        let action = OverrideAction::parse(&o.action).ok_or_else(|| {
            format!(
                "第 {} 条覆盖的动作 {:?} 不认识（只认 disable / front / add）",
                i + 1,
                o.action
            )
        })?;
        let target = o.target.trim().to_string();
        let dir = o
            .dir
            .as_deref()
            .map(str::trim)
            .filter(|d| !d.is_empty())
            .map(str::to_string);
        match action {
            OverrideAction::Add if dir.is_none() => {
                return Err(format!("第 {} 条「追加目录」没填路径", i + 1));
            }
            OverrideAction::Add => {}
            _ if target.is_empty() => {
                return Err(format!("第 {} 条覆盖没填工程名", i + 1));
            }
            _ => {}
        }
        cleaned.push(LinkedOverrideConfig {
            action: action.as_str().to_string(),
            target,
            dir,
        });
    }

    let saved = cleaned.clone();
    state
        .update_config(move |cfg| {
            cfg.linked_overrides = cleaned;
            Ok(())
        })
        .await?;
    Ok(saved)
}

/// 检查各工程的产物是否比源码旧（D4 的**全量**版本）。
///
/// 🔴 必须按需触发（「工程关联」页的按钮），**不要**挂到编译流程里：
/// 真机实测三工程整树扫描 8.3 秒（12k 个 java / 13k 个 class、149k 个目录条目，
/// 本机目录枚举约 15k 条目/秒），见 `compile_diag::stale_diagnostics`。
/// 编译流程内只做按类判断（毫秒级）。
#[tauri::command]
pub async fn check_artifacts(
    state: tauri::State<'_, Arc<AppState>>,
    root: Option<String>,
) -> Result<Vec<crate::compile_diag::Diagnostic>, String> {
    let cfg = state.config.read().await.clone();
    let primary = match root.map(|r| r.trim().to_string()).filter(|r| !r.is_empty()) {
        Some(r) => PathBuf::from(r),
        None => cfg
            .workspace_root
            .clone()
            .map(PathBuf::from)
            .ok_or_else(|| "还没有选择工作区目录，先去「文件」页打开一个工程".to_string())?,
    };
    if !primary.is_dir() {
        return Err(format!("工作区目录不存在：{}", primary.display()));
    }
    let home = crate::nc_home::resolve(cfg.nc_home.as_deref())?;
    let nc_home = PathBuf::from(&home.root);

    // 扫盘 8 秒级，绝不占 async 线程
    tauri::async_runtime::spawn_blocking(move || {
        let overrides = eclipse_cp::active_overrides(&cfg.linked_overrides);
        let g = eclipse_cp::graph(&primary, &nc_home, &overrides);
        crate::compile_diag::stale_diagnostics(&g.projects)
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))
}
