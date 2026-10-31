//! 取消延迟黑盒对照探针（缺口三）。
//!
//! **为什么是黑盒**：要判断取消延迟在客户端还是服务端，不需要改驱动打点——
//! 客户端切片是 **100ms 固定值**，所以：
//! - 若延迟是**客户端轮询**造成的，实测值必然是 100ms 的整数倍；
//! - 若延迟在**服务端**，实测值不会落在 100ms 的整数倍上。
//!
//! **第一轮实测（2026-10-31，19c）暴露的疑点**：sleep 语句的中断时点从 50ms 到
//! 1500ms 变化，返回时间恒定 ~3.01s。延迟不随中断时点增长 ⇒ 不是「interrupt 后
//! 服务端再算 2 秒」，而是**查询开始后 ~3s 处的某个固定边界**。两个候选解释：
//!   1. `dbms_lock.sleep` 的等待被服务端切成 ~3s 的块，中断只在块边界生效；
//!   2. 客户端有某个 3s 幻影读超时，到点自己报错（与 interrupt 无关）。
//!
//! 第二轮探针把这两件事分开，并回答产品真正关心的问题：
//!   - 场景 C（sleep(6) 不中断）：6s 还能成功 ⇒ 没有幻影超时，排除解释 2；
//!   - 场景 E（中断推到 3.1s/4.5s/5.5s）：若都 ~6.0s 返回 ⇒ 块边界假说成立；
//!   - 场景 B（真·CPU 长查询，自然运行 ~10s）：产品里「取消」取消的就是这种语句，
//!     它的取消延迟才是缺口三的答案（sleep 只是测试便利，不是真实负载）。
//!
//! **默认不跑**（`#[ignore]`）：要连真实数据库（公司内网 + VPN）。
//!
//! ```bash
//! NC_RUST_URL='jdbc:oracle:thin:@10.200.22.144:1521/aier260824' \
//! NC_RUST_USER=aier633 NC_RUST_PASS=aier633 \
//!   cargo test --test db_break_probe -- --ignored --nocapture --test-threads=1
//! ```
//!
//! 对照基准（上游 cloudcoms 原型，方案文档 7.2）：同一套 break 设计在
//! 23.26 Free / 21c XE 上是 **45ms**；我们在 19c 的 sleep 语句上是 ~3s 块边界。

// 场景名用中文（可读性优先），否则 clippy 的 snake_case 会在 -D warnings 口径下报错。
#![allow(non_snake_case)]

use std::thread;
use std::time::{Duration, Instant};

use nc_forge::db_rust::connect_string_from_jdbc;
use oracledb::{Connection, ToDbValue};

/// 复用引擎自己的转换函数：探针与产品代码走同一条路径，
/// 顺带也验证了这个 `pub fn`（它此前只被 db_rust.rs 内部调用）。
fn connect_string() -> String {
    let u = std::env::var("NC_RUST_URL")
        .unwrap_or_else(|_| "jdbc:oracle:thin:@10.200.22.144:1521/aier260824".into());
    connect_string_from_jdbc(&u).expect("连接串转换失败")
}
fn user() -> String {
    std::env::var("NC_RUST_USER").unwrap_or_else(|_| "aier633".into())
}
fn pass() -> String {
    std::env::var("NC_RUST_PASS").unwrap_or_else(|_| "aier633".into())
}

fn connect() -> Connection {
    let (u, p) = (user(), pass());
    let cfg = oracledb::Config::default()
        .set_credentials(&u, &p)
        .set_connect_string(&connect_string())
        .expect("连接串不合法");
    match oracledb::connect(cfg) {
        Ok(c) => c,
        Err(e) => panic!("连不上 {}：{}", connect_string(), e),
    }
}

/// 会话还活着的自检：探针之间互相不能影响。
fn assert_alive(conn: &Connection, tag: &str) {
    let mut cur = conn.query("select 1 from dual", &[]).expect("select 失败");
    let row = cur.next().expect("无行").expect("取行失败");
    let v: i64 = row.get(0).expect("取列失败");
    println!("    {tag} 之后 select 1 from dual = {v}");
    assert_eq!(v, 1, "{tag} 之后会话应仍可用");
}

/// 执行中从另一个线程发起中断，返回 (总耗时 ms, 结果描述)。
fn timed_interrupt(conn: &Connection, sql: &str, interrupt_after: Duration) -> (u128, String) {
    let handle = conn.break_handle().expect("拿不到中断句柄");
    let t0 = Instant::now();
    thread::spawn(move || {
        thread::sleep(interrupt_after);
        handle.interrupt();
    });
    let res = conn.execute(sql, &[] as &[&dyn ToDbValue]);
    let elapsed = t0.elapsed().as_millis();
    let desc = match res {
        Ok(_) => "成功返回（未被中断）".to_string(),
        Err(e) => format!("错误 kind={:?} msg={}", e.kind(), e),
    };
    (elapsed, desc)
}

/// 场景 A：PL/SQL sleep。与 FORK.md 记录的实测场景一致，作为可复现锚点。
#[test]
#[ignore = "要连真实数据库；需先挂 VPN"]
fn 场景A_sleep语句中断延迟() {
    let conn = connect();
    let (ms, err) = timed_interrupt(
        &conn,
        "begin dbms_lock.sleep(30); end;",
        Duration::from_secs(1),
    );
    println!("[A sleep(30) 1s 后中断] {ms}ms 返回：{err}");
    println!("    判读：{ms} / 100 = {}", ms as f64 / 100.0);
    assert_alive(&conn, "A");
}

/// 场景 B1：真·CPU 长查询的自然运行时间（不中断）。
/// 第一轮 3M level 只要 ~1s（探针白跑了）；30M 在这台库上会因资源报错，
/// 10M 应能跑完。两者共同标定 B2 的「未被取消」下界：B2 明显早于这些数
/// 才说明取消真的生效了。
#[test]
#[ignore = "要连真实数据库；需先挂 VPN"]
fn 场景B1_CU长查询基线() {
    let conn = connect();
    let sql = "select count(*) from (select 1 from dual connect by level <= 30000000)";
    let t0 = Instant::now();
    let r = conn.execute(sql, &[] as &[&dyn ToDbValue]);
    println!(
        "[B1 基线 CPU 30M] {}ms，ok={}，错误={:?}",
        t0.elapsed().as_millis(),
        r.is_ok(),
        r.as_ref().err()
    );
    assert_alive(&conn, "B1");
}

/// 场景 B1b：10M 级 CPU 长查询基线（预期能正常跑完），给出「不取消会跑多久」的干净下界。
#[test]
#[ignore = "要连真实数据库；需先挂 VPN"]
fn 场景B1b_CU长查询基线10M() {
    let conn = connect();
    let sql = "select count(*) from (select 1 from dual connect by level <= 10000000)";
    let t0 = Instant::now();
    let r = conn.execute(sql, &[] as &[&dyn ToDbValue]);
    println!(
        "[B1b 基线 CPU 10M] {}ms，ok={}，错误={:?}",
        t0.elapsed().as_millis(),
        r.is_ok(),
        r.as_ref().err()
    );
    assert_alive(&conn, "B1b");
}

/// 场景 B2：同一条 CPU 长查询，1s 后中断。
/// 产品里用户点「取消」取消的就是这种语句——它的取消延迟才是缺口三的答案。
/// 若 ~1.1s 返回 ⇒ 取消几乎即时；若 ~3s ⇒ 存在秒级取消延迟；若 ~10s ⇒ 取消没生效。
#[test]
#[ignore = "要连真实数据库；需先挂 VPN"]
fn 场景B2_CU长查询1秒后中断() {
    let conn = connect();
    let sql = "select count(*) from (select 1 from dual connect by level <= 30000000)";
    let (ms, err) = timed_interrupt(&conn, sql, Duration::from_secs(1));
    println!("[B2 CPU 30M 1s 后中断] {ms}ms 返回：{err}");
    println!(
        "    取消延迟 ≈ {}ms（总耗时 - 1000ms）",
        ms.saturating_sub(1000)
    );
    assert_alive(&conn, "B2");
}

/// 场景 C：sleep(6) 不中断的基线。
/// 第一轮 sleep(3) 不中断恰好 3.01s 成功，与「3s 幻影超时」是 photo finish；
/// 6s 还能成功返回 ⇒ 客户端没有幻影读超时，A/D/E 的 3s 返回只能来自中断路径。
#[test]
#[ignore = "要连真实数据库；需先挂 VPN"]
fn 场景C_不中断基线() {
    let conn = connect();
    let t0 = Instant::now();
    let r = conn.execute("begin dbms_lock.sleep(6); end;", &[] as &[&dyn ToDbValue]);
    println!(
        "[C 基线 sleep(6)] {}ms，结果 {}",
        t0.elapsed().as_millis(),
        if r.is_ok() { "成功" } else { "失败" }
    );
    assert!(r.is_ok(), "6 秒的 sleep 必须正常返回（否则存在幻影读超时）");
    assert_alive(&conn, "C");
}

/// 场景 D：interrupt 落在语句执行的不同时点（第一轮锚点数据复跑）。
/// 延迟若随时点剧烈变化 ⇒ 与服务端执行进度相关；若稳定在 100ms 整数倍 ⇒ 客户端切片。
#[test]
#[ignore = "要连真实数据库；需先挂 VPN"]
fn 场景D_不同中断时点() {
    let conn = connect();
    for after_ms in [50u64, 300, 800, 1500] {
        let (ms, err) = timed_interrupt(
            &conn,
            "begin dbms_lock.sleep(20); end;",
            Duration::from_millis(after_ms),
        );
        println!("[D +{after_ms}ms 处中断] {ms}ms 返回：{err}");
        assert_alive(&conn, "D");
    }
}

/// 场景 E：把中断推到 3.1s / 4.5s / 5.5s，检验「3 秒分块」假说（块边界 3s/6s/9s…）。
/// - 分块假说：三次都 ~6.0s 返回（都落在 3-6s 块里）；
/// - 「interrupt 后固定 ~2s」假说：分别 ~5.1 / ~6.5 / ~7.5s；
/// - 「查询开始后固定 3s」假说：仍 ~3.01s（但那要求中断被完全忽略，与 A/D 矛盾）。
#[test]
#[ignore = "要连真实数据库；需先挂 VPN"]
fn 场景E_sleep晚段中断() {
    let conn = connect();
    for after_ms in [3100u64, 4500, 5500] {
        let (ms, err) = timed_interrupt(
            &conn,
            "begin dbms_lock.sleep(20); end;",
            Duration::from_millis(after_ms),
        );
        println!("[E +{after_ms}ms 处中断] {ms}ms 返回：{err}");
        assert_alive(&conn, "E");
    }
}

/// 场景 F：等锁取消。holder 会话对自己账号下一张表的一行加行锁**不提交**，
/// waiter 会话对同一行 `for update` 会阻塞在行锁（TX enqueue）上，1s / 4s 后中断 waiter。
///
/// dbms_lock.sleep 已证明有 3s 块边界，但行锁等待是产品里最常见的「卡住」形态
/// （别人开着事务没提交，用户的 update/DML 挂住），等待机制不同，必须单独测。
/// 两个时点用来区分「3s 块边界（3/6/9…）」与「查询开始后固定 3s」：
/// 块边界假说下 1s 与 4s 的中断都应在 ~3s / ~6s 返回。
/// 账号下没有表就跳过（打印出来，不当成通过）。
#[test]
#[ignore = "要连真实数据库；需先挂 VPN"]
fn 场景F_等锁取消() {
    let holder = connect();
    let table: Option<String> = {
        let mut cur = holder
            .query("select table_name from user_tables where rownum = 1", &[])
            .expect("查 user_tables 失败");
        match cur.next() {
            Some(Ok(row)) => Some(row.get(0).expect("取列失败")),
            _ => None,
        }
    };
    let Some(table) = table else {
        println!("[F] 账号下没有表，跳过（此场景未测）");
        return;
    };
    let lock_sql = format!("select rowid from {table} where rownum = 1 for update");
    holder
        .execute(&lock_sql, &[] as &[&dyn ToDbValue])
        .expect("holder 加行锁失败");
    println!("[F] holder 已锁住 {table} 的一行且不提交");

    let waiter = connect();
    for after_ms in [1000u64, 4000] {
        let handle = waiter.break_handle().expect("拿不到中断句柄");
        let t0 = Instant::now();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(after_ms));
            handle.interrupt();
        });
        let r = waiter.execute(&lock_sql, &[] as &[&dyn ToDbValue]);
        let ms = t0.elapsed().as_millis();
        match &r {
            Ok(_) => {
                println!("[F 等锁 +{after_ms}ms 处中断] {ms}ms 成功返回（锁没堵上？表可能是空的）")
            }
            Err(e) => println!(
                "[F 等锁 +{after_ms}ms 处中断] {ms}ms 错误 kind={:?} msg={}",
                e.kind(),
                e
            ),
        }
        println!(
            "    取消延迟 ≈ {}ms（总耗时 - {after_ms}ms）",
            ms.saturating_sub(after_ms as u128)
        );
    }

    let _ = holder.execute("rollback", &[] as &[&dyn ToDbValue]);
    assert_alive(&waiter, "F waiter");
    assert_alive(&holder, "F holder");
}
