//! 启动配置库的命令层：list / save / delete / duplicate。
//!
//! 与全局配置（`config.json`）刻意分开：那边是「这台机器上怎么用」，这边是
//! 「这个工程有哪几种起法」，跟着工程走、可以进 SVN。四个命令都是
//! 「读全量 → 改一条 → 写全量」，串行化闸门在 [`AppState::update_launch_configs`]
//! （与 `config_write` 同型，理由见那边的注释）。
//!
//! 启动配置**不执行任何东西**：它只是把一次启动的要素存下来，真正去起进程的仍是
//! `server_start` / `client_start` / `java_run`（它们各自接收覆盖参数）。

use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::app_error::AppError;
use crate::launch_config::{self, LaunchConfig};
use crate::state::AppState;

/// 命令的返回体：全量配置 + 读取时攒下的说明。
///
/// 为什么连 save / delete 也返回全量：前端拿到即可刷新，省掉「改完再 list 一次」
/// 的那一趟 IPC；而那一路恰好最容易和并发的一次保存交叉，拿到旧列表。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchConfigList {
    pub configs: Vec<LaunchConfig>,
    /// 读取时跳过/降级的条目说明（文件损坏、重名、校验不过）。正常为空。
    pub notes: Vec<String>,
    /// `save` / `duplicate` 入库后的那条配置 id；`list` / `delete` 恒为 null。
    ///
    /// 前端「保存后顺手选中新建的这条」本该靠前后列表做差集，但差集在缓存
    /// 还没预热时（`before` 为空集）恒真，会选中列表里第一条旧配置；duplicate
    /// 又会换 id，也得多写一层特判。由后端直接给出答案最省事也最不会错。
    pub saved_id: Option<String>,
}

/// 列出当前工程的启动配置。没有选工作区时返回空列表（不是错误）——
/// 面板在没选工程时本来就不展示启动按钮，不该弹一次错。
#[tauri::command]
pub async fn launch_config_list(
    state: State<'_, Arc<AppState>>,
) -> Result<LaunchConfigList, AppError> {
    let st = state.inner().clone();
    let raw = st.config.read().await.workspace_root.clone();
    let Some(raw) = raw.filter(|r| !r.trim().is_empty()) else {
        return Ok(LaunchConfigList {
            configs: Vec::new(),
            notes: Vec::new(),
            saved_id: None,
        });
    };
    let root = std::path::PathBuf::from(raw.trim());
    let (configs, notes) =
        tauri::async_runtime::spawn_blocking(move || launch_config::load_with_notes(&root))
            .await
            .map_err(|e| {
                AppError::internal("launch.readFailed", format!("读取任务异常退出：{e}"))
            })?;
    Ok(LaunchConfigList {
        configs: configs.configs,
        notes,
        saved_id: None,
    })
}

/// 新增或更新一条（`id` 为空串 = 新建）。返回入库后的全量列表与这条的 id。
#[tauri::command]
pub async fn launch_config_save(
    state: State<'_, Arc<AppState>>,
    config: LaunchConfig,
) -> Result<LaunchConfigList, AppError> {
    let st = state.inner().clone();
    let (file, notes, saved) = st
        .update_launch_configs(|f| launch_config::upsert(f, config.clone()))
        .await
        .map_err(classify_edit_error)?;
    Ok(LaunchConfigList {
        configs: file.configs,
        notes,
        saved_id: Some(saved.id),
    })
}

/// 删除一条。
#[tauri::command]
pub async fn launch_config_delete(
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<LaunchConfigList, AppError> {
    let st = state.inner().clone();
    let (file, notes, ()) = st
        .update_launch_configs(|f| launch_config::remove(f, &id))
        .await
        .map_err(classify_edit_error)?;
    Ok(LaunchConfigList {
        configs: file.configs,
        notes,
        saved_id: None,
    })
}

/// 复制一条（名字加「副本」后缀，插在原件后面）。
#[tauri::command]
pub async fn launch_config_duplicate(
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<LaunchConfigList, AppError> {
    let st = state.inner().clone();
    let (file, notes, created) = st
        .update_launch_configs(|f| launch_config::duplicate(f, &id))
        .await
        .map_err(classify_edit_error)?;
    Ok(LaunchConfigList {
        configs: file.configs,
        notes,
        saved_id: Some(created.id),
    })
}

/// 供 `server_start` / `server_command_line` 校验启动配置带来的覆盖值。
///
/// 单独抽出来是因为两处都要校验，而规则必须与配置库里那份一致：
/// 界面手填和选配置是同一条路，不该有两套边界。
pub(crate) fn check_middleware_overrides(
    heap_mb: Option<u32>,
    hotwebs: Option<&[String]>,
) -> Result<(), AppError> {
    crate::launch::validate_heap_mb(heap_mb).map_err(|e| AppError::input("launch.badHeap", e))?;
    launch_config::validate_hotwebs(hotwebs)
        .map_err(|e| AppError::input("launch.badHotwebs", e))?;
    Ok(())
}

/// 供 `client_start` / `client_command_line` 校验堆上限覆盖值。
pub(crate) fn check_client_overrides(heap_mb: Option<u32>) -> Result<(), AppError> {
    crate::launch::validate_heap_mb(heap_mb).map_err(|e| AppError::input("launch.badHeap", e))
}

/// 把 save / delete / duplicate 的错误归类：找不到是数据问题，其余照旧。
///
/// 不为每个失败点发明 code：前端只对 `launch.notFound` 做特殊呈现（「配置已被
/// 别人删了」），其余统一走 detail——重名、越界这些 detail 本身就是可执行的建议。
pub(crate) fn classify_edit_error(e: String) -> AppError {
    if e.contains("不存在") || e.contains("已被删除") {
        AppError::data("launch.notFound", e)
    } else {
        AppError::data("launch.saveFailed", e)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 覆盖参数复用同一套校验() {
        assert!(check_middleware_overrides(Some(4096), None).is_ok());
        assert!(check_middleware_overrides(Some(70000), None).is_err());
        assert!(check_middleware_overrides(None, Some(&["a,b".to_string()])).is_err());
        assert!(check_client_overrides(Some(768)).is_ok());
        assert!(check_client_overrides(Some(1)).is_err());
    }

    #[test]
    fn 删除类错误归类为找不到() {
        let e = classify_edit_error("配置不存在或已被删除".into());
        assert_eq!(e.code, "launch.notFound");
        let e = classify_edit_error("已存在同名配置".into());
        assert_eq!(e.code, "launch.saveFailed");
    }

    #[test]
    fn 空列表序列化成前端形状() {
        let list = LaunchConfigList {
            configs: Vec::new(),
            notes: vec!["坏了".into()],
            saved_id: None,
        };
        let json = serde_json::to_value(&list).unwrap();
        assert_eq!(json["configs"].as_array().unwrap().len(), 0);
        assert_eq!(json["notes"][0], "坏了");
        //  camelCase 是 IPC 契约；savedId 恒在（null 也算），前端不用判字段有无
        assert!(json.get("configs").is_some() && json.get("notes").is_some());
        assert!(json["savedId"].is_null());
    }

    #[test]
    fn 一条配置序列化时带kind标签() {
        let file = crate::launch_config::LaunchConfigFile::new();
        assert!(file.configs.is_empty());
        let json = serde_json::to_value(LaunchConfig {
            id: "lc-1".into(),
            name: "日常".into(),
            target: crate::launch_config::LaunchTarget::Middleware(Default::default()),
        })
        .unwrap();
        assert_eq!(json["target"]["kind"], "middleware");
        assert_eq!(json["name"], "日常");
    }
}
