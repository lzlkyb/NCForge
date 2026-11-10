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
//! 1. 拦一次关窗 → 发 `app:quit-request`（带本轮 `round`）→ 起 5 秒兜底计时；
//! 2. 前端第一件事发 `quit_check_acked`（表示「我活着，正在查」），再查事务；
//!    收到同一轮的重投时也重发 ack，不重新跑一遍检查；
//! 3. 干净 → `app_quit`（放行，窗口关闭，进程退出）；
//!    有事务 → 弹框，用户选提交/回滚，做完再 `app_quit`；
//! 4. 用户取消 → `quit_cancel` 复位并作废旧轮，下次点 X 重新走一遍；
//! 5. 5 秒没 ack 且轮次仍匹配 → 认为界面已卡死，直接退（这种状态下也弹不出框）。
//!
//! **两处不能放行的地方**：emit 失败时保持窗口（放行会跳过整个守卫，静默丢数据）；
//! 事务探测结果要逐项保留（整体超时把已成功的 pending 一起丢掉，会让「提交」空转）。
//!
//! `quit_checking` 只由 `quit_cancel` / `app_quit` / 强退复位，计时器不碰它——
//! 确认框还开着时再点一次 X 曾因此启动第二轮、5 秒后强退，丢掉全部未保存内容。

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use serde_json::{json, Value};
use tauri::{Emitter, Manager};

use crate::commands::db_cmds::{call, split_slot_key};
use crate::db_engine::{EngineHandle, EngineKind};
use crate::state::AppState;

/// 单个连接的探测超时。
///
/// ping 要拿会话锁——长查询正在跑时会排队。2 秒拿不到就标 `unknown`，
/// **不能**当成「没有事务」（那正是会静默丢数据的错）。
const PING_TIMEOUT: Duration = Duration::from_secs(2);

/// 全部连接探测的总 deadline。探测是并行的，理论上最慢就等于最慢的那一条；
/// 有本地脏计数时要再追一次 `txStatus`（ping + 真源两次往返），所以留出两倍余量。
/// 超过它说明有连接把流程挂住了，没出结果的一律按 `unknown` 报——退出探测宁可
/// 误报「可能有事务」，也不能当 clean 放行。
const PENDING_TX_DEADLINE: Duration = Duration::from_secs(5);

/// 等前端回话的上限。超过它说明界面已卡死/崩溃，继续等只会让应用关不掉。
const ACK_TIMEOUT: Duration = Duration::from_secs(5);

/// 关窗回调里调用：返回 `true` 表示这次关闭已被拦住，正在等前端确认。
///
/// 放行条件只有一个：`quit_approved` 已置位（前端完成确认）。emit 失败**不再**
/// 放行——那会跳过未保存检查与事务确认，静默丢掉编辑内容与未提交写入。
///
/// 一轮一 id：`quit_round` 每轮递增，兜底计时器只在 round 仍匹配且本轮没收到
/// ack 时才强退。连点 X 只重发事件让前端补 ack，不重置 `quit_acked`、不起新计时器。
pub fn begin_quit_check(window: &tauri::Window) -> bool {
    let app = window.app_handle().clone();
    let st = app.state::<Arc<AppState>>().inner().clone();

    if st.quit_approved.load(Ordering::SeqCst) {
        return false;
    }

    let is_new_round = !st.quit_checking.swap(true, Ordering::SeqCst);
    let round = if is_new_round {
        // 只有真正开始新一轮才清 ack：确认框未决时连点 X 不能把已置位的 ack 抹掉。
        st.quit_acked.store(false, Ordering::SeqCst);
        st.quit_round.fetch_add(1, Ordering::SeqCst) + 1
    } else {
        st.quit_round.load(Ordering::SeqCst)
    };

    if let Err(e) = window.emit("app:quit-request", json!({ "round": round })) {
        // 事件通道异常时前端收不到确认请求。保持窗口并给出降级提示；再点一次 X
        // 会重试。本轮作废，旧计时器（若已起）不会再强退。
        log::error!("发送退出确认事件失败，保持窗口：{e}");
        let _ = window.emit("app:quit-guard-error", ());
        if is_new_round {
            st.quit_checking.store(false, Ordering::SeqCst);
            st.quit_round.fetch_add(1, Ordering::SeqCst);
        }
        return true;
    }

    if !is_new_round {
        // 同一轮的重投：计时器已经在跑，只需让前端补一次 ack，不再起第二个。
        return true;
    }

    let app2 = app.clone();
    let st2 = st.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(ACK_TIMEOUT).await;
        // 轮次已变（取消后重新点 X / emit 失败作废 / 已经强退）→ 这是上一轮的计时器。
        if st2.quit_round.load(Ordering::SeqCst) != round {
            return;
        }
        if st2.quit_acked.load(Ordering::SeqCst) {
            // 前端活着并且已经确认收到，确认框可能还开着：本轮绝不强退。
            // quit_checking 由 quit_cancel / app_quit / 强退复位，计时器不碰它。
            return;
        }
        log::warn!("退出确认 {ACK_TIMEOUT:?} 内没有回话，界面可能已卡死，直接退出");
        st2.quit_approved.store(true, Ordering::SeqCst);
        st2.quit_checking.store(false, Ordering::SeqCst);
        st2.quit_round.fetch_add(1, Ordering::SeqCst);
        app2.exit(0);
    });
    true
}

/// 前端告诉后端「我收到退出请求了，正在查」。
///
/// 只为一件事：停掉兜底强退计时。**不能省**——用户在一堆弹框上慢慢看的时候，
/// 5 秒计时到点会把人直接踢出去。
#[tauri::command]
pub fn quit_check_acked(state: tauri::State<'_, Arc<AppState>>) {
    // 本轮置位后不再重置（重置只发生在 begin_quit_check 的新一轮）。
    // 前端对重复事件也会重发这个命令，重复置位是幂等的。
    state.quit_acked.store(true, Ordering::SeqCst);
}

/// 用户在退出确认框里点了「取消」：复位状态并作废旧轮计时器，下次点 X 重新走一遍。
#[tauri::command]
pub fn quit_cancel(state: tauri::State<'_, Arc<AppState>>) {
    state.quit_checking.store(false, Ordering::SeqCst);
    state.quit_round.fetch_add(1, Ordering::SeqCst);
}

/// 真正退出：置放行位，再关一次窗。
///
/// 为什么用「再关一次窗」而不是 `app.exit(0)`：关窗会走完整的 `CloseRequested` →
/// 窗口销毁 → `RunEvent::Exit` 链路，jdtls 与数据库桥的清理都在 `Exit` 里。
/// 只有窗口已经不在（理论上不会）才退化成直接 `exit`。
#[tauri::command]
pub fn app_quit(app: tauri::AppHandle, state: tauri::State<'_, Arc<AppState>>) {
    state.quit_approved.store(true, Ordering::SeqCst);
    state.quit_checking.store(false, Ordering::SeqCst);
    state.quit_round.fetch_add(1, Ordering::SeqCst);
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
/// 就有，让 Rust 再抄一份只会两边不同步。探测失败/连接已断的连接按写计数分类：
/// 计数为 0 说明本会话没有未提交写入，直接算干净；有写入或没拿到结果才标 `unknown`，
/// 并带 `reason` 让前端说清「会话已结束」还是「只是这次探不到」。
#[tauri::command]
pub async fn db_pending_tx(state: tauri::State<'_, Arc<AppState>>) -> Result<Value, String> {
    let handles: Vec<(String, Arc<EngineHandle>)> = {
        let map = state
            .db
            .lock()
            .map_err(|_| "数据库连接状态异常".to_string())?;
        map.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    };
    // 原始 key → 引擎种类。总 deadline 到了要给「没出结果」的会话补 unknown 行，
    // 那时候句柄已经被 move 进 future 了，只剩这份表。
    let kinds: std::collections::HashMap<String, EngineKind> =
        handles.iter().map(|(k, h)| (k.clone(), h.kind())).collect();
    let all_keys: Vec<String> = handles.iter().map(|(k, _)| k.clone()).collect();

    // 并行探测：串行时最坏是「连接数 × PING_TIMEOUT」——五个卡住的连接就是十秒
    // 关不掉窗口。每条自带 timeout，外面再用总 deadline 兜住「某条把整个流程拖住」。
    //
    // **必须逐条收集**：原先用 `join_all(...).unwrap_or_default()`，总 deadline 一超时
    // 就把已经成功返回的 pending 结果一起丢掉，全部补成 unknown，前端「提交」循环
    // 一次都不执行却照样 app_quit —— 用户看到「已提交并退出」，实际全部隐式回滚。
    let mut futs = futures_util::stream::FuturesUnordered::new();
    for (key, h) in handles {
        futs.push(async move {
            let kind = h.kind();
            // A0 的独立会话槽（`c1#2`）属于同一条连接：按连接 id 归并，
            // 否则确认框里会出现「prod」「prod#2」两条同名连接，用户不知道该点哪个。
            let (id, _) = split_slot_key(&key);
            let probed = tokio::time::timeout(PING_TIMEOUT, async {
                let p = call(h.clone(), "ping", Vec::new(), PING_TIMEOUT).await;
                // 本地计数说「有未提交写入」时再问一次数据库真源。
                // 手写 COMMIT / PL/SQL 内部提交都不会让这个计数归零，不问一句就会把用户
                // 永久挡在确认框前（`v$transaction` 是唯一能纠正它的东西）。
                // 计数为 0 时**不查**：退出路径要快，绝大多数情况本来就没有事务。
                if needs_confirm(&p) {
                    call(h, "txStatus", Vec::new(), PING_TIMEOUT).await.or(p)
                } else {
                    p
                }
            })
            .await
            .unwrap_or_else(|_| Err("退出探测超时".to_string()));
            // 先算出结果行再 move `key`：`id` 借用了 `key`，同一个表达式里
            // move 会与借用冲突（E0505）。拆两句对语义没有影响。
            let row = pending_row(id, kind, probed);
            (key, row)
        });
    }
    let mut done: Vec<(String, Value)> = Vec::new();
    let _ = tokio::time::timeout(PENDING_TX_DEADLINE, async {
        while let Some(row) = futs.next().await {
            done.push(row);
        }
    })
    .await;
    // 按原始 key 补行，不能按连接 id：同一条连接的 primary 与槽是不同的 future，
    // 只探完 primary 不能替槽说「干净」——merge_sessions 的规则是「任一条 unknown
    // 整条 unknown」，漏掉槽的 unknown 正好把可能丢数据的那个藏起来。
    let got: std::collections::HashSet<String> = done.iter().map(|(k, _)| k.clone()).collect();
    let mut conns: Vec<Value> = done.into_iter().map(|(_, r)| r).collect();
    for key in &all_keys {
        if got.contains(key) {
            continue;
        }
        if let Some(kind) = kinds.get(key).copied() {
            let (id, _) = split_slot_key(key);
            conns.push(pending_row(id, kind, Err("退出探测超时".to_string())));
        }
    }
    Ok(json!({ "conns": merge_sessions(conns) }))
}

/// 把同一连接的多条会话（primary + 槽）合成一行。
///
/// 规则：
/// - 任一条会话 `unknown` → 整条标 `unknown`（可能丢数据的那个不能藏在 pending 后面）；
/// - 语句数 / 行数**相加**（退出时要提交的是全部会话的写入）；
/// - 开始时刻取最早的（显示「已持续」更保守）。
fn merge_sessions(rows: Vec<Value>) -> Vec<Value> {
    let mut order: Vec<String> = Vec::new();
    let mut acc: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
    for row in rows {
        let id = row
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        match acc.get_mut(&id) {
            None => {
                order.push(id.clone());
                acc.insert(id, row);
            }
            Some(cur) => {
                let state = |v: &Value| {
                    v.get("state")
                        .and_then(Value::as_str)
                        .unwrap_or("clean")
                        .to_string()
                };
                let num = |v: &Value, k: &str| v.get(k).and_then(Value::as_i64).unwrap_or(0);
                cur["statements"] = json!(num(cur, "statements") + num(&row, "statements"));
                cur["rows"] = json!(num(cur, "rows") + num(&row, "rows"));
                let a = num(cur, "since");
                let b = num(&row, "since");
                cur["since"] = json!(match (a, b) {
                    (0, x) => x,
                    (x, 0) => x,
                    (x, y) => x.min(y),
                });
                let (sa, sb) = (state(cur), state(&row));
                if sa == "unknown" || sb == "unknown" {
                    cur["state"] = json!("unknown");
                    // 原因跟着 unknown 会话走，前端据此区分「会话已结束」与「只是探不到」。
                    if cur.get("reason").is_none() || cur["reason"].is_null() {
                        cur["reason"] = row.get("reason").cloned().unwrap_or(Value::Null);
                    }
                    if cur.get("message").is_none() {
                        cur["message"] = row.get("message").cloned().unwrap_or(Value::Null);
                    }
                } else if sa == "pending" || sb == "pending" {
                    cur["state"] = json!("pending");
                    // 有活着的待提交事务：断连原因不再适用，别让前端拿它去选文案。
                    cur["reason"] = Value::Null;
                } else {
                    // 两条都干净时，「数据库已确认没有事务」必须两条都确认过才算；
                    // 任一条没核对（null）就回 null，让界面还有机会补上刚落下的语句。
                    let confirmed = confirmed_clean(cur) && confirmed_clean(&row);
                    cur["active"] = if confirmed { json!(false) } else { Value::Null };
                    if cur.get("reason").is_none() || cur["reason"].is_null() {
                        if let Some(reason) = row.get("reason") {
                            cur["reason"] = reason.clone();
                        }
                    }
                }
            }
        }
    }
    order.into_iter().filter_map(|id| acc.remove(&id)).collect()
}

/// 这一行是否带着「数据库确认没有未提交事务」的结论（`active:false`）。
fn confirmed_clean(v: &Value) -> bool {
    v.get("active").and_then(Value::as_bool) == Some(false)
}

/// ping 结果里「本地计数说有未提交写入」吗？只有这种时候才值得再问一次数据库真源。
fn needs_confirm(ping: &Result<Value, String>) -> bool {
    let Ok(v) = ping else { return false };
    let Some(tx) = v.get("tx") else { return false };
    let statements = tx.get("statements").and_then(Value::as_i64).unwrap_or(0);
    let auto_commit = tx
        .get("autoCommit")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    !auto_commit && statements > 0
}

/// 断连原因。JVM 桥的 `alive:false` 是 `conn == null || isClosed()`，会话确实结束了；
/// 纯 Rust 驱动的 `alive:false` 是 `probe_conn` 失败，只是这次探不到，会话可能还在。
fn dead_reason(kind: EngineKind) -> &'static str {
    match kind {
        EngineKind::Java => "disconnected",
        EngineKind::Rust => "unreachable",
    }
}

fn dead_message(kind: EngineKind) -> &'static str {
    match kind {
        EngineKind::Java => "连接已断开",
        EngineKind::Rust => "连接探测失败",
    }
}

fn tx_num(tx: &Value, key: &str) -> i64 {
    tx.get(key).and_then(Value::as_i64).unwrap_or(0)
}

fn pending_row(id: &str, kind: EngineKind, r: Result<Value, String>) -> Value {
    let engine = kind.as_str();
    let v = match r {
        Ok(v) => v,
        Err(e) => {
            let message = strip_code(&e);
            // 超时与普通探测失败要分开：超时还有机会用界面上的最后已知计数兜底，
            // 普通失败可能只是桥忙 / 会话锁排队，不能据此说「没有写入」。
            let reason = if message.contains("超时") {
                "timeout"
            } else {
                "probe-error"
            };
            return json!({
                "id": id, "state": "unknown", "engine": engine, "reason": reason, "message": message,
            });
        }
    };
    let tx = v.get("tx").cloned().unwrap_or(Value::Null);
    let statements = tx_num(&tx, "statements");
    // 桥的 ping 即使失败也返回 200 结构（`alive: false` + 上一次的事务数据）。
    // 写计数为 0 是「本会话没执行过未提交写入」的正向证据：SELECT 不计数，
    // DDL / COMMIT / ROLLBACK 会清零。不能按 `alive:false` 一律 unknown——
    // 纯查询会话正是这样被误报成「退出前还有事务」的。
    if !v.get("alive").and_then(Value::as_bool).unwrap_or(true) {
        if statements == 0 {
            return json!({
                "id": id, "state": "clean", "engine": engine, "reason": dead_reason(kind),
                "statements": 0, "rows": 0, "since": 0,
            });
        }
        return json!({
            "id": id, "state": "unknown", "engine": engine, "reason": dead_reason(kind),
            "message": dead_message(kind), "statements": statements,
            "rows": tx_num(&tx, "rows"), "since": tx_num(&tx, "since"),
        });
    }
    let auto_commit = tx
        .get("autoCommit")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    // `active` 只有 `txStatus` 带出来（`tx.active`），是 `v$transaction` 的真源：
    //   true  → 库里确实有未提交事务；
    //   false → 库里没有，本地计数是脏的（手写 COMMIT / PL/SQL 内部提交），不能拿它拦人；
    //   null  → 查不了（没授权 / 字典被锁），退回本地计数，绝不把「查不了」当「没有事务」。
    let db_active = v
        .get("active")
        .and_then(Value::as_bool)
        .or_else(|| tx.get("active").and_then(Value::as_bool));
    let pending = match db_active {
        Some(active) => active,
        // 只有写语句会累加 statements（DDL 会重置），所以「>0」就等价于「有未提交的写入」
        None => !auto_commit && statements > 0,
    };
    json!({
        "id": id,
        "state": if pending { "pending" } else { "clean" },
        "engine": engine,
        // 真源结论（`v$transaction`）：`false` = 数据库确认没有事务，界面上那份旧计数
        // 不能把它翻回 pending；`null` = 没核对（计数为 0，没去查）或查不了。
        "active": db_active,
        "statements": statements,
        "rows": tx_num(&tx, "rows"),
        "since": tx_num(&tx, "since"),
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
        assert_eq!(row["reason"], "timeout");
        assert_eq!(row["message"], "查询超时");
    }

    #[test]
    fn 连接已断开且有写语句标未知() {
        let row = pending_row(
            "c1",
            EngineKind::Java,
            Ok(json!({ "alive": false, "tx": { "statements": 3 } })),
        );
        assert_eq!(row["state"], "unknown");
        assert_eq!(row["reason"], "disconnected");
        assert_eq!(row["statements"], 3);
    }

    /// 纯查询会话没有写语句：断连后不该再拦退出。SELECT 不累加计数，
    /// DDL / COMMIT / ROLLBACK 会清零，所以 0 是正向证据，不是「没查到」。
    #[test]
    fn 连接已断开但没有写语句算干净() {
        let row = pending_row(
            "c1",
            EngineKind::Java,
            Ok(json!({ "alive": false, "tx": { "autoCommit": false, "statements": 0 } })),
        );
        assert_eq!(row["state"], "clean");
        assert_eq!(row["reason"], "disconnected");
    }

    /// 纯 Rust 驱动的 `alive:false` 只是探测失败，和「会话已关闭」不是一回事；
    /// 但写计数为 0 同样能证明没有未提交写入。
    #[test]
    fn 纯rust探测失败但没有写语句也算干净() {
        let row = pending_row(
            "c1",
            EngineKind::Rust,
            Ok(json!({ "alive": false, "tx": { "autoCommit": false, "statements": 0 } })),
        );
        assert_eq!(row["state"], "clean");
        assert_eq!(row["reason"], "unreachable");
    }

    /// 真源说「库里没有未提交事务」时，本地脏计数（手写 COMMIT 之后不会归零）不能拿来拦人。
    #[test]
    fn 真源说没有事务时不看本地脏计数() {
        let row = pending_row(
            "c1",
            EngineKind::Java,
            Ok(json!({
                "alive": true,
                "active": false,
                "tx": { "autoCommit": false, "statements": 7, "rows": 40, "since": 1 }
            })),
        );
        assert_eq!(row["state"], "clean");
    }

    /// 反过来也要认：本地计数是 0，但数据库说事务还在（计数被 DDL 重置过）。
    #[test]
    fn 真源说有事务时即使计数为零也要确认() {
        let row = pending_row(
            "c1",
            EngineKind::Rust,
            Ok(json!({
                "alive": true,
                "active": true,
                "tx": { "autoCommit": false, "statements": 0, "rows": 0, "since": 0 }
            })),
        );
        assert_eq!(row["state"], "pending");
    }

    /// `txStatus` 查不了（active 为 null，例如没权限看 `v$transaction`）时退回本地计数，
    /// 不能当成「没有事务」放行。
    #[test]
    fn 真源查不了时退回本地计数() {
        let row = pending_row(
            "c1",
            EngineKind::Rust,
            Ok(json!({
                "alive": true,
                "active": null,
                "tx": { "autoCommit": false, "statements": 2, "rows": 2, "since": 1 }
            })),
        );
        assert_eq!(row["state"], "pending");
    }

    /// 快路径：本地计数为 0 或自动提交时不追 `txStatus`，退出探测不能为每条连接多花一次往返。
    #[test]
    fn 只有计数大于零才追真源() {
        assert!(!needs_confirm(&Ok(tx(0, 0, false))));
        assert!(!needs_confirm(&Ok(tx(3, 5, true))));
        assert!(needs_confirm(&Ok(tx(1, 1, false))));
        assert!(!needs_confirm(&Ok(json!({ "alive": false }))));
        assert!(!needs_confirm(&Err("超时".to_string())));
    }

    #[test]
    fn 同一连接的多条会话合成一行() {
        // A0 之后一个连接上可能同时有 primary 与两个槽：退出时要提交的是全部写入
        let rows = vec![
            pending_row("c1", EngineKind::Java, Ok(tx(1, 5, false))),
            pending_row("c1", EngineKind::Java, Ok(tx(2, 7, false))),
        ];
        let merged = merge_sessions(rows);
        assert_eq!(merged.len(), 1, "不能出现「c1」「c1#2」两条同名连接");
        assert_eq!(merged[0]["statements"], 3);
        assert_eq!(merged[0]["rows"], 12);
        assert_eq!(merged[0]["state"], "pending");
    }

    #[test]
    fn 合并后保留未知原因() {
        let rows = vec![
            pending_row("c1", EngineKind::Rust, Ok(tx(0, 0, false))),
            pending_row("c1", EngineKind::Rust, Err("退出探测超时".into())),
        ];
        let merged = merge_sessions(rows);
        assert_eq!(merged[0]["state"], "unknown");
        assert_eq!(merged[0]["reason"], "timeout");
    }

    #[test]
    fn 合并出待提交事务时清掉断连原因() {
        let rows = vec![
            pending_row(
                "c1",
                EngineKind::Java,
                Ok(json!({ "alive": false, "tx": { "autoCommit": false, "statements": 0 } })),
            ),
            pending_row("c1", EngineKind::Java, Ok(tx(2, 3, false))),
        ];
        let merged = merge_sessions(rows);
        assert_eq!(merged[0]["state"], "pending");
        assert!(merged[0]["reason"].is_null());
    }

    #[test]
    fn 任一会话探测超时整条标未知() {
        let rows = vec![
            pending_row("c1", EngineKind::Java, Ok(tx(1, 5, false))),
            pending_row("c1", EngineKind::Rust, Err("bridge|查询超时".into())),
        ];
        let merged = merge_sessions(rows);
        assert_eq!(merged.len(), 1);
        assert_eq!(
            merged[0]["state"], "unknown",
            "一条会话状态不明时不能报「有事务」，也不能报「干净」"
        );
        assert_eq!(merged[0]["message"], "查询超时");
    }

    #[test]
    fn 不同连接不会被合并() {
        let rows = vec![
            pending_row("c1", EngineKind::Java, Ok(tx(1, 1, false))),
            pending_row("c2", EngineKind::Java, Ok(tx(2, 2, false))),
        ];
        let merged = merge_sessions(rows);
        assert_eq!(merged.len(), 2);
    }
}
