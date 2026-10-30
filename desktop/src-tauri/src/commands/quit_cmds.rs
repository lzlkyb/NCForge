//! 退出流程：**点 X 就退出**，退出前问一遍未提交的事务。
//!
//! 为什么「问」这一步必须存在：关窗即退出意味着 Oracle 会话随进程结束，未提交的
//! 写入会被隐式回滚——用户点一下 X 就把半小时的批量更新弄丢了，而且没有任何提示。
//! 这是交接清单待办 ③ 要解决的唯一问题。
//!
//! 为什么判断放在 Rust 侧：界面只是「视图」，界面卡住或白屏时前端状态不可信；
//! 引擎句柄与事务计数在 `AppState.db` 里，那是权威数据。前端那份也要看（它更
//! 及时地知道刚执行完的那条语句），两边取并集。
//!
//! 时序（`CloseRequested` 是同步回调，不能 await）：
//! 1. 拦一次关窗 → 发 `app:quit-request` → 起 5 秒兜底计时；
//! 2. 前端第一件事发 `quit_check_acked`（表示「我活着，正在查」），再查事务；
//! 3. 干净 → `app_quit`（放行，窗口关闭，进程退出）；
//!    有事务 → 弹框，用户选提交/回滚，做完再 `app_quit`；
//! 4. 用户取消 → `quit_cancel` 复位，下次点 X 重新走一遍；
//! 5. 5 秒没 ack → 认为界面已卡死，直接退（这种状态下也弹不出框，只能靠
//!    Oracle 回滚）。

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{Emitter, Manager};

use crate::commands::db_cmds::call;
use crate::db_engine::{EngineHandle, EngineKind};
use crate::state::AppState;

/// 单个连接的探测超时。
///
/// ping 要拿会话锁——长查询正在跑时会排队。2 秒拿不到就标 `unknown`，
/// **不能**当成「没有事务」（那正是会静默丢数据的错）。
const PING_TIMEOUT: Duration = Duration::from_secs(2);

/// 等前端回话的上限。超过它说明界面已卡死/崩溃，继续等只会让应用关不掉。
const ACK_TIMEOUT: Duration = Duration::from_secs(5);

/// 关窗回调里调用：返回 `true` 表示这次关闭已被拦住，正在等前端确认。
///
/// 放行条件只有一个：`quit_approved` 已置位（前端完成确认，或兜底超时）。
pub fn begin_quit_check(window: &tauri::Window) -> bool {
    let app = window.app_handle().clone();
    let st = app.state::<Arc<AppState>>().inner().clone();

    if st.quit_approved.load(Ordering::SeqCst) {
        return false;
    }
    // 连点 X：已经拦住一次并在等回话了，别再发事件、再起计时器
    if st.quit_checking.swap(true, Ordering::SeqCst) {
        return true;
    }

    st.quit_acked.store(false, Ordering::SeqCst);
    if let Err(e) = window.emit("app:quit-request", ()) {
        // 发不出去就等于没人能确认：直接放行，别把用户关在应用里
        log::warn!("发送退出确认事件失败，直接退出：{e}");
        st.quit_approved.store(true, Ordering::SeqCst);
        return false;
    }

    let app2 = app.clone();
    let st2 = st.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(ACK_TIMEOUT).await;
        if !st2.quit_acked.load(Ordering::SeqCst) {
            log::warn!("退出确认 {ACK_TIMEOUT:?} 内没有回话，界面可能已卡死，直接退出");
            st2.quit_approved.store(true, Ordering::SeqCst);
            app2.exit(0);
        }
        st2.quit_checking.store(false, Ordering::SeqCst);
    });
    true
}

/// 前端告诉后端「我收到退出请求了，正在查」。
///
/// 只为一件事：停掉兜底强退计时。**不能省**——用户在一堆弹框上慢慢看的时候，
/// 5 秒计时到点会把人直接踢出去。
#[tauri::command]
pub fn quit_check_acked(state: tauri::State<'_, Arc<AppState>>) {
    state.quit_acked.store(true, Ordering::SeqCst);
}

/// 用户在退出确认框里点了「取消」：复位状态，下次点 X 重新走一遍。
#[tauri::command]
pub fn quit_cancel(state: tauri::State<'_, Arc<AppState>>) {
    state.quit_checking.store(false, Ordering::SeqCst);
}

/// 真正退出：置放行位，再关一次窗。
///
/// 为什么用「再关一次窗」而不是 `app.exit(0)`：关窗会走完整的 `CloseRequested` →
/// 窗口销毁 → `RunEvent::Exit` 链路，jdtls 与数据库桥的清理都在 `Exit` 里。
/// 只有窗口已经不在（理论上不会）才退化成直接 `exit`。
#[tauri::command]
pub fn app_quit(app: tauri::AppHandle, state: tauri::State<'_, Arc<AppState>>) {
    state.quit_approved.store(true, Ordering::SeqCst);
    match app.get_webview_window("main") {
        Some(w) => {
            if let Err(e) = w.close() {
                log::warn!("退出时关窗失败，改为直接退出：{e}");
                app.exit(0);
            }
        }
        None => app.exit(0),
    }
}

/// 列出所有活着的连接上「有未提交写入」的情况。
///
/// 只回 `id` 与事务数据，不回连接名/环境——那些在配置文件里，前端 `dbStore` 手上
/// 就有，让 Rust 再抄一份只会两边不同步。探测失败的连接标 `unknown`，前端要显示
/// 「探测超时」而不是当成干净。
#[tauri::command]
pub async fn db_pending_tx(state: tauri::State<'_, Arc<AppState>>) -> Result<Value, String> {
    let handles: Vec<(String, Arc<EngineHandle>)> = {
        let map = state
            .db
            .lock()
            .map_err(|_| "数据库连接状态异常".to_string())?;
        map.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    };

    let mut conns = Vec::with_capacity(handles.len());
    for (id, h) in handles {
        let kind = h.kind();
        let r = call(h, "ping", Vec::new(), PING_TIMEOUT).await;
        conns.push(pending_row(&id, kind, r));
    }
    Ok(json!({ "conns": conns }))
}

fn pending_row(id: &str, kind: EngineKind, r: Result<Value, String>) -> Value {
    let engine = kind.as_str();
    let v = match r {
        Ok(v) => v,
        Err(e) => {
            return json!({
                "id": id, "state": "unknown", "engine": engine, "message": strip_code(&e),
            })
        }
    };
    // 桥的 ping 即使失败也返回 200 结构（`alive: false` + 上一次的事务数据），
    // 那份数据是残留的，不能信。
    if !v.get("alive").and_then(Value::as_bool).unwrap_or(true) {
        return json!({
            "id": id, "state": "unknown", "engine": engine, "message": "连接已断开",
        });
    }
    let tx = v.get("tx").cloned().unwrap_or(Value::Null);
    let statements = tx.get("statements").and_then(Value::as_i64).unwrap_or(0);
    let auto_commit = tx
        .get("autoCommit")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    // 只有写语句会累加 statements（DDL 会重置），所以「>0」就等价于「有未提交的写入」
    let pending = !auto_commit && statements > 0;
    json!({
        "id": id,
        "state": if pending { "pending" } else { "clean" },
        "engine": engine,
        "statements": statements,
        "rows": tx.get("rows").and_then(Value::as_i64).unwrap_or(0),
        "since": tx.get("since").and_then(Value::as_i64).unwrap_or(0),
    })
}

/// 去掉 `code|` 前缀（`call` 统一加了它，界面这里不做分类，只显示人话）。
fn strip_code(s: &str) -> String {
    s.split_once('|')
        .map(|(_, m)| m.to_string())
        .unwrap_or_else(|| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tx(statements: i64, rows: i64, auto: bool) -> Value {
        json!({ "alive": true, "tx": { "autoCommit": auto, "statements": statements, "rows": rows, "since": 1_700_000_000_000i64 } })
    }

    #[test]
    fn 关掉自动提交且有写语句才算有事务() {
        let row = pending_row("c1", EngineKind::Java, Ok(tx(2, 10, false)));
        assert_eq!(row["state"], "pending");
        assert_eq!(row["statements"], 2);
        assert_eq!(row["rows"], 10);
    }

    #[test]
    fn 自动提交下没有待确认的事务() {
        // 自动提交模式下每条语句都落盘了，退出不会丢东西
        let row = pending_row("c1", EngineKind::Rust, Ok(tx(5, 99, true)));
        assert_eq!(row["state"], "clean");
    }

    #[test]
    fn 探测超时标未知而不是干净() {
        let row = pending_row("c1", EngineKind::Java, Err("bridge|查询超时".into()));
        assert_eq!(row["state"], "unknown");
        assert_eq!(row["message"], "查询超时");
    }

    #[test]
    fn 连接已断开标未知() {
        let row = pending_row(
            "c1",
            EngineKind::Java,
            Ok(json!({ "alive": false, "tx": { "statements": 3 } })),
        );
        assert_eq!(row["state"], "unknown");
    }
}
