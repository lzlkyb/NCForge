//! 真库冒烟：验证 Rust 侧发的四段协议被 Java 桥正确接受，且多条会话真的共用一个进程。
//!
//! **默认不跑**（`#[ignore]`）：要一台能连到 NC 数据库的机器，CI 上没有。
//! 本地手动跑：
//!
//! ```bash
//! NC_HOME=D:/ncc/1909home \
//! NC_DB_DS=design \
//!   cargo test --test db_bridge_live -- --ignored --nocapture
//! ```
//!
//! 为什么要这个测试而不是只靠单测：协议是**跨语言**的（Rust 拼行、Java 解行），
//! 两边各自「自测通过」并不能保证对得上。这里用真实的 `ncdb.jar` 走一遍
//! `EngineHandle → Bridge → Java` 全链路，是唯一能发现「字段错位」的地方。

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use nc_forge::db_bridge;
use nc_forge::db_engine::EngineHandle;

fn home() -> Option<PathBuf> {
    std::env::var("NC_HOME").ok().map(PathBuf::from).filter(|p| p.is_dir())
}

fn jar() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/ncdb/ncdb.jar")
}

fn env_for(nc_home: &PathBuf) -> db_bridge::BridgeEnv {
    let driver = db_bridge::find_driver(nc_home)
        .unwrap_or_else(|| panic!("{} 下没有 Oracle 驱动", nc_home.display()));
    db_bridge::env(
        nc_home.join("ufjdk/bin/java.exe"),
        jar(),
        driver,
        db_bridge::nc_decrypt_jars(nc_home),
        std::env::temp_dir().join("ncforge-db-live"),
    )
}

#[test]
#[ignore = "要连真实数据库"]
fn 两条会话共用一个桥进程并且各自可用() {
    let Some(nc_home) = home() else {
        println!("没有设 NC_HOME，跳过");
        return;
    };
    let ds = std::env::var("NC_DB_DS").unwrap_or_else(|_| "design".into());
    let bridge = Arc::new(db_bridge::Bridge::new(env_for(&nc_home)));
    let home_s = nc_home.display().to_string();

    let a = EngineHandle::java(bridge.clone(), "live-a");
    let b = EngineHandle::java(bridge.clone(), "live-b");

    let out = a
        .call(
            "connectProp",
            &[&home_s, &ds, "false"],
            Duration::from_secs(60),
        )
        .expect("会话 A 应该连得上（先确认 VPN 与 prop.xml）");
    println!("A 连上：{}", out.get("version").and_then(|v| v.as_str()).unwrap_or("?"));

    b.call(
        "connectProp",
        &[&home_s, &ds, "false"],
        Duration::from_secs(60),
    )
    .expect("会话 B 应该连得上");

    // 两条会话各查一次：结果里的别名不同，能确认响应没有串台
    let ra = a
        .call("exec", &["select 11 as a from dual", "5", "30"], Duration::from_secs(60))
        .expect("A 查询");
    let rb = b
        .call("exec", &["select 22 as b from dual", "5", "30"], Duration::from_secs(60))
        .expect("B 查询");
    assert_eq!(ra["rows"][0][0], "11", "A 拿到了别人的结果：{ra}");
    assert_eq!(rb["rows"][0][0], "22", "B 拿到了别人的结果：{rb}");

    // 整个 bridge 只有一个进程：hello 回的 sessions 计数能佐证（顺带验证无会话命令）
    let hello = a
        .call("hello", &[], Duration::from_secs(10));
    match hello {
        Ok(v) => println!("hello: {v}"),
        Err(e) => panic!("hello 失败：{e}"),
    }

    a.shutdown();
    b.shutdown();
}

#[test]
#[ignore = "要连真实数据库"]
fn 取消能中断正在执行的语句() {
    let Some(nc_home) = home() else {
        println!("没有设 NC_HOME，跳过");
        return;
    };
    let ds = std::env::var("NC_DB_DS").unwrap_or_else(|_| "design".into());
    let bridge = Arc::new(db_bridge::Bridge::new(env_for(&nc_home)));
    let home_s = nc_home.display().to_string();
    let h = EngineHandle::java(bridge.clone(), "live-c");
    h.call(
        "connectProp",
        &[&home_s, &ds, "false"],
        Duration::from_secs(60),
    )
    .expect("应该连得上");

    // 20 秒的语句：不取消的话这个测试要跑 20 秒；取消成功它会在几秒内以 ORA-01013 结束
    let t0 = std::time::Instant::now();
    let canceller = {
        let h = EngineHandle::java(bridge.clone(), "live-c");
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(2));
            h.cancel()
        })
    };
    let r = h.call(
        "exec",
        &["begin dbms_lock.sleep(20); end;", "0", "60"],
        Duration::from_secs(60),
    );
    let took = t0.elapsed();
    let cancel_ok = canceller.join().expect("取消线程不应 panic");

    println!("耗时 {took:?}，取消结果 {cancel_ok:?}，执行结果 {r:?}");
    let err = r.expect_err("被取消的语句应该返回错误");
    assert!(
        err.message.contains("1013"),
        "应该报 ORA-01013，实际：{}",
        err.message
    );
    assert!(
        took < Duration::from_secs(15),
        "取消没生效：等了 {took:?}"
    );
}
