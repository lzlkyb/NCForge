//! Bound queries and connection-wide query-only policy.
use super::db_cmds::{call_with_reconnect, slot_bridge};
use crate::state::AppState;
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};

#[tauri::command]
pub async fn db_exec_bound(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
    sql: String,
    params: Vec<Value>,
    max_rows: Option<u32>,
    timeout_sec: Option<u32>,
    slot: Option<String>,
) -> Result<Value, String> {
    let engine = slot_bridge(&state, &id, slot.as_deref())?;
    let mut args = vec![
        sql,
        max_rows.unwrap_or(500).clamp(1, 10000).to_string(),
        timeout_sec.unwrap_or(30).clamp(1, 3600).to_string(),
    ];
    for value in params {
        let (kind, text) = match value {
            Value::Null => ("null", String::new()),
            Value::String(s) => ("string", s),
            Value::Number(n) => ("number", n.to_string()),
            Value::Bool(b) => ("bool", b.to_string()),
            Value::Object(o) if o.len() == 1 && o.get("number").is_some_and(Value::is_string) => {
                ("number", o["number"].as_str().unwrap().to_string())
            }
            _ => return Err("绑定参数必须是单值".into()),
        };
        args.extend([kind.to_string(), text]);
    }
    let timeout = Duration::from_secs(timeout_sec.unwrap_or(30).clamp(1, 3600) as u64 + 30);
    call_with_reconnect(&state, &id, engine, "execBound", args, timeout, None).await
}

#[tauri::command]
pub async fn db_read_only(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
    enabled: Option<bool>,
) -> Result<Value, String> {
    let engine = slot_bridge(&state, &id, None)?;
    let policy = engine.policy.clone().ok_or("连接未登记只读状态")?;
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut mode = policy.write().map_err(|_| "数据库只读状态异常")?;
        if let Some(on) = enabled {
            if on != *mode {
                // Hold the policy write lock across verification and all session transitions.
                // Calls and session registration use its read lock, closing the race with new writes.
                let handles: Vec<_> = st
                    .db
                    .lock()
                    .map_err(|_| "数据库桥状态异常")?
                    .values()
                    .filter(|h| h.policy.as_ref().is_some_and(|p| Arc::ptr_eq(p, &policy)))
                    .cloned()
                    .collect();
                let timeout = Duration::from_secs(120);
                let mut live = Vec::new();
                for h in handles {
                    match h.raw_call("ping", &[], timeout) {
                        Ok(v) => {
                            let writes = v["tx"]["statements"]
                                .as_i64()
                                .ok_or("会话未提供事务状态，不能切换只读查询")?;
                            if writes > 0 {
                                return Err("有未提交写入，请先提交或回滚所有会话再切换只读查询"
                                    .to_string());
                            }
                            live.push(h);
                        }
                        // An explicitly disconnected slot has no transaction to switch.
                        Err(e) if e.message == "还没连数据库" => {}
                        Err(e) => return Err(format!("会话状态无法验证，只读模式未切换：{e}")),
                    }
                }
                let mut switched: Vec<Arc<crate::db_engine::EngineHandle>> = Vec::new();
                for h in live {
                    if let Err(e) =
                        h.raw_call("readOnly", &[if on { "true" } else { "false" }], timeout)
                    {
                        // Do not publish a partially verified policy. Restore every touched session.
                        let _ = h.raw_call(
                            "readOnly",
                            &[if *mode { "true" } else { "false" }],
                            timeout,
                        );
                        for previous in switched {
                            let _ = previous.raw_call(
                                "readOnly",
                                &[if *mode { "true" } else { "false" }],
                                timeout,
                            );
                        }
                        return Err(format!("只读模式未切换：{e}"));
                    }
                    switched.push(h);
                }
                *mode = on;
            }
        }
        let tx = engine
            .raw_call("ping", &[], Duration::from_secs(30))
            .map_err(|e| e.to_string())?["tx"]
            .clone();
        Ok(json!({"readOnly":*mode,"tx":tx}))
    })
    .await
    .map_err(|e| e.to_string())?
}
