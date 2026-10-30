//! prop.xml 口令「解一次就存」的真库验证（对应 `db_cmds::prop_password_ready` 的链路）。
//!
//! **默认不跑**（`#[ignore]`）：要 NC home + 能连到内网库。
//!
//! ```bash
//! NC_HOME=D:/ncc/1909home NC_DB_DS=design \
//!   cargo test --test prop_cred_live -- --ignored --nocapture
//! ```
//!
//! 链路：JVM 桥 `propCred` 按 prop.xml 解出 url/user/口令 → 纯 Rust 引擎拿这三样直连。
//! 这条测试证明的是「Rust 引擎的连接不需要 JVM 常驻」——解口令那一次用完即可，
//! 之后同一套参数就能在没有 classpath 的情况下连上。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use nc_forge::db_bridge;
use nc_forge::db_engine::EngineHandle;
use nc_forge::db_rust::RustEngine;

fn home() -> Option<PathBuf> {
    std::env::var("NC_HOME")
        .ok()
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
}

fn jar() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/ncdb/ncdb.jar")
}

fn env_for(nc_home: &Path) -> db_bridge::BridgeEnv {
    let driver = db_bridge::find_driver(nc_home)
        .unwrap_or_else(|| panic!("{} 下没有 Oracle 驱动", nc_home.display()));
    db_bridge::env(
        nc_home.join("ufjdk/bin/java.exe"),
        jar(),
        driver,
        db_bridge::nc_decrypt_jars(nc_home),
        std::env::temp_dir().join("ncforge-prop-live"),
    )
}

#[test]
#[ignore = "要 NC home + 真实数据库"]
fn prop_口令解一次就能被纯rust引擎使用() {
    let Some(nc_home) = home() else {
        println!("没有设 NC_HOME，跳过");
        return;
    };
    let ds = std::env::var("NC_DB_DS").unwrap_or_else(|_| "design".into());
    let home_s = nc_home.display().to_string();
    let bridge = Arc::new(db_bridge::Bridge::new(env_for(&nc_home)));
    let java = EngineHandle::java(bridge, "prop-cred");

    // ── 1. JVM 桥按 prop.xml 解一次 ─────────────────────────────
    let cred = java
        .call("propCred", &[&home_s, &ds], Duration::from_secs(60))
        .expect("propCred 应当能读到数据源");
    let url = cred.get("url").and_then(|v| v.as_str()).unwrap_or("");
    let user = cred.get("user").and_then(|v| v.as_str()).unwrap_or("");
    let pass = cred.get("password").and_then(|v| v.as_str()).unwrap_or("");
    println!(
        "[propCred] ds={ds} url={url} user={user} 口令长度={}",
        pass.chars().count()
    );
    assert!(!url.is_empty(), "prop.xml 里这个数据源没有 databaseUrl");
    assert!(!user.is_empty(), "prop.xml 里这个数据源没有 user");
    assert!(!pass.is_empty(), "prop.xml 里这个数据源没有口令");

    // ── 2. 纯 Rust 引擎用这组参数直连（不再需要 JVM）─────────────
    let e = RustEngine::new();
    let info = e
        .call(
            "connect",
            &[url, user, pass, "true"],
            Duration::from_secs(60),
        )
        .expect("纯 Rust 引擎应当能用 prop.xml 的口令连上");
    println!("[rust connect] {info}");
    assert_eq!(info["product"], "Oracle");

    let r = e
        .call(
            "exec",
            &["select user from dual", "5", "30"],
            Duration::from_secs(60),
        )
        .expect("连上后应当能查询");
    println!("[rust 当前用户] {r}");

    let _ = e.call("disconnect", &[], Duration::from_secs(10));
}
