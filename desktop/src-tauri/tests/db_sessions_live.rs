//! 会话与锁面板（A1）的真库快照。
//!
//! **默认不跑**（`#[ignore]`）：要一台能连到 NC 数据库的机器（公司内网 + VPN）。
//!
//! ```bash
//! cargo test --test db_sessions_live -- --ignored --nocapture --test-threads=1
//! ```
//!
//! 为什么要有这个文件：`sessions` 这条命令的 SQL 一旦写错（列名、`v$` 视图的权限、
//! `wasNull` 的处理），界面上表现是「面板空白」而不是报错——**空列表和最坏情况长得一样**。
//! 所以必须对着真库断言：形状对不对、自己这条会话在不在、`granted` 是不是布尔。
//!
//! 覆盖不了的：低权限账号读不到 `v$locked_object` 时 `granted=false` 的降级路径，
//! 需要一把没有 `SELECT ON V_$LOCKED_OBJECT` 的账号；本文件只断言「有权限时 granted 为 true」。

use std::time::Duration;

use nc_forge::db_rust::RustEngine;
use serde_json::Value;

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

fn url() -> String {
    env_or(
        "NC_RUST_URL",
        "jdbc:oracle:thin:@10.200.22.144:1521/aier260824",
    )
}

fn user() -> String {
    env_or("NC_RUST_USER", "aier633")
}

fn pass() -> String {
    env_or("NC_RUST_PASS", "aier633")
}

fn call(e: &RustEngine, cmd: &str, args: &[&str]) -> Value {
    match e.call(cmd, args, Duration::from_secs(60)) {
        Ok(v) => v,
        Err(err) => panic!("命令 {cmd} 失败：[{}] {}", err.code, err.message),
    }
}

fn connect() -> RustEngine {
    let e = RustEngine::new();
    call(&e, "connect", &[&url(), &user(), &pass(), "false"]);
    e
}

#[test]
#[ignore = "要连真实数据库"]
fn 会话面板能列出自己这条会话且字段齐全() {
    let e = connect();
    let v = call(&e, "sessions", &[]);
    println!("[sessions] {v}");

    // granted 必须是布尔（false = 读不到 v$locked_object，界面靠它显示授权提示）
    assert!(
        v["granted"].is_boolean(),
        "granted 必须是布尔，实际 {:?}",
        v["granted"]
    );
    let rows = v["rows"].as_array().expect("rows 必须是数组");
    assert!(!rows.is_empty(), "至少应该能看到自己这条会话");

    // 自己这条：用户名匹配、状态 ACTIVE（查询本身就在跑）、字段类型对
    let me = rows
        .iter()
        .find(|r| {
            r["user"]
                .as_str()
                .unwrap_or("")
                .eq_ignore_ascii_case(&user())
                && r["status"].as_str() == Some("ACTIVE")
        })
        .unwrap_or_else(|| panic!("没找到自己这条会话（用户 {}）：{v}", user()));
    assert!(me["sid"].as_i64().unwrap_or(0) > 0, "sid 应该是正数");
    assert!(me["serial"].as_i64().unwrap_or(0) > 0, "serial 应该是正数");
    assert!(me["locked"].is_array(), "locked 必须是数组");
    assert!(me["sql"].is_string(), "sql 必须是字符串（读不到就是空串）");
    assert!(
        me["blocker"].is_null() || me["blocker"].is_i64(),
        "blocker 只能是 null 或数字"
    );
    // 截断到 300 字符以内（面板只用来认「是哪条」）
    let sql = me["sql"].as_str().unwrap_or("");
    assert!(sql.chars().count() <= 300, "SQL 文本应截断到 300 字符");

    // 每一行都要七字段齐全，少一个前端就会显示 undefined
    for r in rows {
        for k in [
            "sid",
            "serial",
            "user",
            "machine",
            "program",
            "status",
            "blocker",
            "event",
            "waitClass",
            "waitSec",
            "elapsedSec",
            "sqlId",
            "locked",
            "sql",
        ] {
            assert!(
                !r[k].is_null() || k == "serial" || k == "blocker",
                "缺字段 {k}：{r}"
            );
        }
    }

    let _ = call(&e, "disconnect", &[]);
}

#[test]
#[ignore = "要连真实数据库"]
fn 别人在跑长查询时能看到它() {
    let watcher = connect();
    let my_sid = call(
        &watcher,
        "exec",
        &["select sys_context('userenv','sid') from dual", "10", "30"],
    );
    let my_sid: i64 = my_sid["rows"][0][0]
        .as_str()
        .unwrap_or("0")
        .parse()
        .unwrap_or(0);
    println!("[sessions] 自己的 SID = {my_sid}");

    // 只看「除自己以外还在 ACTIVE 的会话」有几条：拿开工前的数当基线
    let others = |mine: i64| -> usize {
        let v = call(&watcher, "sessions", &[]);
        v["rows"]
            .as_array()
            .map(|rows| {
                rows.iter()
                    .filter(|r| {
                        r["sid"].as_i64().unwrap_or(-1) != mine
                            && r["status"].as_str() == Some("ACTIVE")
                    })
                    .count()
            })
            .unwrap_or(0)
    };
    let base = others(my_sid);

    // 让 worker 跑一条 ~9 秒的 CPU 查询（30M 约 4.4 秒，翻倍留余量）
    let worker = std::thread::spawn(move || {
        let e = connect();
        let _ = e.call(
            "exec",
            &[
                "select count(*) from dual connect by level <= 60000000",
                "10",
                "60",
            ],
            Duration::from_secs(60),
        );
        e
    });

    // 轮询最多 8 秒。断言用「别人的 ACTIVE 会话变多了」而不是 SQL 文本：
    // **`v$sql` 在普通账号下往往查不到别人的语句**（本机实测连自己的都读不到，
    // 只剩 sql_id），拿 SQL 文本当判据会让这条测试假红。
    let mut seen = false;
    for _ in 0..16 {
        std::thread::sleep(Duration::from_millis(500));
        if others(my_sid) > base {
            seen = true;
            println!(
                "[sessions] 看到别人正在跑（基线 {base} → {}",
                others(my_sid)
            );
            break;
        }
    }
    assert!(
        seen,
        "轮询 8 秒没看到别人正在跑的长查询（基线 {base} 条）——面板在真库上等于没用"
    );

    let _ = worker.join();
    let _ = call(&watcher, "disconnect", &[]);
}
