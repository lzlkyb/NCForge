//! 重置操作员密码：**只读** `sm_user` 列出账号，再按 NC 的哈希方案拼出 `update` 脚本。
//!
//! **绝不执行**：这里没有任何写库路径，生成的 SQL 只回给前端，由用户自己复制 / 保存后
//! 拿去确认执行。连改密码这种操作都替用户敲下去，一次手滑就是全账套登录不进去。
//!
//! 列账号用临时会话（拿不到口令才复用现有句柄）：查询带 `rownum` 截断，不会留下
//! 需要 `more` 的游标去顶掉控制台的「加载更多」。哈希与 SQL 拼装是纯函数，
//! 见 [`crate::nc_password`]（带公开向量的单测）。

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;

use crate::commands::db_cmds::{
    call, drop_bridge, existing_bridge, find_conn, open_temp_session, prop_password_ready,
    PROBE_CONF,
};
use crate::commands::db_search_cmds::cell_text;
use crate::db_engine::EngineKind;
use crate::nc_password::{self, ResetUser, Scheme};
use crate::state::AppState;

/// 一次最多列这么多账号；到上限就提示用筛选缩小范围。
const USER_LIMIT: usize = 501;
const LIST_TIMEOUT_SEC: u32 = 30;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NcUserOut {
    pub cuserid: String,
    pub user_code: String,
    pub user_name: String,
    /// NC 的启停用编码（1 未启用 / 2 已启用 / 3 已停用），原样交给界面。
    pub enable_state: String,
    /// 现有密文认出来的方案：`nc65` / `ncc` / null（认不出）。
    pub scheme: Option<String>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserListOut {
    pub users: Vec<NcUserOut>,
    /// 还有更多账号没列出来（按筛选条件收窄）。
    pub truncated: bool,
    /// 独立会话开不出来、复用了现有句柄（控制台的「加载更多」可能受影响）。
    pub shared_session: bool,
}

/// 列出 `sm_user` 里的操作员（只读）。
#[tauri::command]
pub async fn db_user_list(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
    filter: Option<String>,
) -> Result<UserListOut, String> {
    let st = state.inner().clone();
    let cfg = st.config.read().await.clone();
    let mut conn = find_conn(&cfg, &id)?;
    let engine = EngineKind::parse(&conn.engine);
    if engine != EngineKind::Java && conn.source == "prop" {
        prop_password_ready(&app, &st, &cfg, &mut conn, None, PROBE_CONF).await?;
    }

    let owned = open_temp_session(&app, &st, &cfg, &conn, engine, "users").await;
    let shared_session = owned.is_none();
    let (key, handle) = match owned {
        Some((k, h)) => (Some(k), h),
        None => {
            let h = existing_bridge(&st, &id).map_err(|_| {
                "列不了账号：这个连接还没连上，而且开不出独立会话（手动连接的口令没记住）"
                    .to_string()
            })?;
            (None, h)
        }
    };

    let sql = nc_password::user_list_sql(filter.as_deref().unwrap_or_default(), USER_LIMIT);
    let res = call(
        handle.clone(),
        "exec",
        vec![sql, USER_LIMIT.to_string(), LIST_TIMEOUT_SEC.to_string()],
        Duration::from_secs(u64::from(LIST_TIMEOUT_SEC) + 30),
    )
    .await;
    if let Some(key) = key {
        let _ = call(handle, "disconnect", vec![], Duration::from_secs(10)).await;
        drop_bridge(&st, &key);
    }

    let body = res.map_err(|e| {
        if e.contains("sm_user") || e.contains("SM_USER") || e.contains("00942") {
            format!("读不到 sm_user：{e}（重置密码只适用于 NC 账套库）")
        } else {
            e
        }
    })?;
    let users = parse_users(&body);
    Ok(UserListOut {
        truncated: users.len() >= USER_LIMIT,
        users,
        shared_session,
    })
}

fn parse_users(body: &Value) -> Vec<NcUserOut> {
    let Some(rows) = body.get("rows").and_then(Value::as_array) else {
        return Vec::new();
    };
    rows.iter()
        .take(USER_LIMIT)
        .filter_map(|r| {
            let cells = r.as_array()?;
            let cuserid = cell_text(cells.first()).unwrap_or_default();
            if cuserid.trim().is_empty() {
                return None;
            }
            let head = cell_text(cells.get(4)).unwrap_or_default();
            Some(NcUserOut {
                cuserid,
                user_code: cell_text(cells.get(1)).unwrap_or_default(),
                user_name: cell_text(cells.get(2)).unwrap_or_default(),
                enable_state: cell_text(cells.get(3)).unwrap_or_default(),
                scheme: Scheme::from_hash_head(&head).map(|s| s.id().to_string()),
            })
        })
        .collect()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetUserIn {
    pub cuserid: String,
    #[serde(default)]
    pub user_code: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordResetReq {
    /// `nc65` / `ncc`。
    pub scheme: String,
    /// 新明文密码：只在内存里算哈希，不写日志、不进 SQL。
    pub password: String,
    pub users: Vec<ResetUserIn>,
    /// 脚本头部的时间标注（前端给本地时间）。
    #[serde(default)]
    pub generated_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordResetOut {
    pub sql: String,
    pub count: usize,
}

/// 生成重置脚本。纯计算，没有连接、没有执行。
#[tauri::command]
pub fn db_password_reset_sql(req: PasswordResetReq) -> Result<PasswordResetOut, String> {
    let scheme = Scheme::parse(&req.scheme)?;
    let mut seen = HashSet::new();
    let users: Vec<ResetUser> = req
        .users
        .into_iter()
        .filter(|u| seen.insert(u.cuserid.trim().to_string()))
        .map(|u| ResetUser {
            cuserid: u.cuserid,
            user_code: u.user_code,
        })
        .collect();
    let sql = nc_password::reset_sql(
        scheme,
        &users,
        &req.password,
        req.generated_at.as_deref().unwrap_or_default(),
    )?;
    Ok(PasswordResetOut {
        count: users.len(),
        sql,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn 行解析认得出两种方案与空密文() {
        let body = json!({
            "kind": "rows",
            "rows": [
                ["1001A", "admin", "管理员", 2, "U_U++--V"],
                ["1001B", "ncc", "云用户", "1", "S_S++IP"],
                ["1001C", "empty", null, 3, null],
                ["", "bad", "空主键", 2, null]
            ]
        });
        let users = parse_users(&body);
        assert_eq!(users.len(), 3, "空 cuserid 的行要被丢掉");
        assert_eq!(users[0].enable_state, "2");
        assert_eq!(users[0].scheme.as_deref(), Some("nc65"));
        assert_eq!(users[1].scheme.as_deref(), Some("ncc"));
        assert_eq!(users[2].scheme, None);
        assert_eq!(users[2].user_name, "");
    }

    #[test]
    fn 没有结果集时返回空列表() {
        assert!(parse_users(&json!({ "kind": "error" })).is_empty());
    }
}
