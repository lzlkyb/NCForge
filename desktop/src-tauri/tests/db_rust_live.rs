//! 纯 Rust 引擎（`oracledb`）真库冒烟。
//!
//! **默认不跑**（`#[ignore]`）：要一台能连到 NC 数据库的机器（公司内网 + VPN）。
//!
//! ```bash
//! NC_RUST_URL='jdbc:oracle:thin:@10.200.22.144:1521/aier260824' \
//! NC_RUST_USER=aier633 NC_RUST_PASS=aier633 \
//!   cargo test --test db_rust_live -- --ignored --nocapture
//! ```
//!
//! 为什么要有这个文件：`db_rust.rs` 里的单测只能验证 SQL 分类、类型映射这些纯函数；
//! **能不能连上那台 19c、值取出来跟 JVM 桥是不是同一个样子、元数据命令的 SQL 有没有写错**，
//! 只有真库能回答。这里是 `RustEngine` 对外命令集的一次性全量核对，全部只读。

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

#[test]
#[ignore = "要连真实数据库"]
fn 纯rust引擎全命令真库核对() {
    let e = RustEngine::new();

    // ── connect ────────────────────────────────────────────────
    let info = call(&e, "connect", &[&url(), &user(), &pass(), "false"]);
    println!("[connect] {info}");
    assert_eq!(info["product"], "Oracle");
    assert!(
        info["version"].as_str().unwrap_or("").starts_with("19"),
        "期望 19c，实际 {}",
        info["version"]
    );
    assert_eq!(info["autoCommit"], false);

    // ── exec：中文 / 精度 / 日期格式 ───────────────────────────
    let r = call(
        &e,
        "exec",
        &[
            "select '中文水印' as 名称, 12345678901234567890123 as 巨数, \
             date '2026-10-30' as 日期, 3.14 as 圆周率 from dual",
            "500",
            "30",
        ],
    );
    println!("[exec select] {r}");
    assert_eq!(r["kind"], "rows");
    assert_eq!(r["columns"].as_array().unwrap().len(), 4);
    let row = r["rows"][0].as_array().expect("rows[0] 应是数组");
    assert_eq!(row[0], "中文水印");
    // 超过 15 位的数字要留成字符串，否则 JSON 的 f64 会把末几位吃掉
    assert_eq!(row[1], "12345678901234567890123");
    assert_eq!(row[2], "2026-10-30 00:00:00", "日期格式要和 JVM 桥一致");
    assert_eq!(r["hasMore"], false);
    assert_eq!(r["rowCount"], 1);

    // ── 分页：多取几条，验证 hasMore + more ────────────────────
    let r = call(
        &e,
        "exec",
        &[
            "select rownum as rn from dual connect by level <= 5",
            "3",
            "30",
        ],
    );
    println!("[exec 分页] {r}");
    assert_eq!(r["rows"].as_array().unwrap().len(), 3);
    assert_eq!(r["hasMore"], true, "刚好取满应当认为可能还有");
    let more = call(&e, "more", &["3"]);
    println!("[more] {more}");
    assert_eq!(more["rows"].as_array().unwrap().len(), 2);
    assert_eq!(more["hasMore"], false);

    // ── DBMS_OUTPUT ───────────────────────────────────────────
    let r = call(
        &e,
        "exec",
        &["begin dbms_output.put_line('探针输出'); end;", "500", "30"],
    );
    println!("[exec plsql] {r}");
    assert_eq!(r["kind"], "update");
    let out = r["output"].as_array().expect("output 应是数组");
    assert!(
        out.iter().any(|v| v.as_str() == Some("探针输出")),
        "DBMS_OUTPUT 没抓到：{out:?}"
    );

    // ── 事务：建表/写入/回滚，不留痕 ──────────────────────────
    // 上一轮中途失败可能留下这张表，先清掉（没有就算了）
    let _ = e.call(
        "exec",
        &["drop table ncforge_probe_tmp purge", "500", "30"],
        Duration::from_secs(30),
    );
    // 生产账号常常没有 CREATE TABLE 权限，没权限就跳过这一段（下面的元数据改用现有表）
    let created = match e.call(
        "exec",
        &[
            "create table ncforge_probe_tmp (id number, name varchar2(20))",
            "500",
            "30",
        ],
        Duration::from_secs(60),
    ) {
        Ok(r) => {
            println!("[exec create] {r}");
            assert_eq!(r["kind"], "update");
            true
        }
        Err(err) => {
            println!(
                "[跳过建表] 账号没有建表权限：[{}] {}",
                err.code, err.message
            );
            false
        }
    };

    if created {
        let r = call(
            &e,
            "exec",
            &[
                "insert into ncforge_probe_tmp values (1, '甲')",
                "500",
                "30",
            ],
        );
        assert_eq!(r["updateCount"], 1);
        assert_eq!(r["tx"]["statements"], 1, "手动提交模式下应当记一次在途语句");

        let r = call(&e, "rollback", &[]);
        println!("[rollback] {r}");
        assert_eq!(r["tx"]["statements"], 0);

        // 自动提交：打开后 insert 直接落地，再删掉
        let r = call(&e, "autocommit", &["true"]);
        assert_eq!(r["tx"]["autoCommit"], true);
        let r = call(
            &e,
            "exec",
            &[
                "insert into ncforge_probe_tmp values (2, '乙')",
                "500",
                "30",
            ],
        );
        assert_eq!(r["updateCount"], 1);
        let r = call(
            &e,
            "exec",
            &["select count(*) from ncforge_probe_tmp", "500", "30"],
        );
        println!("[自动提交后 count] {r}");
        // NUMBER 一律给字符串（与 JVM 桥的 BigDecimal.toPlainString() 对齐）
        assert_eq!(
            r["rows"][0][0], "1",
            "回滚掉的那行不该在，自动提交的那行该在"
        );
        call(&e, "autocommit", &["false"]);
    }

    // ── 元数据：tables / ncNames / columns / indexes / ddl / schema ──
    let t = call(&e, "tables", &[]);
    let tables = t["tables"].as_array().expect("tables 应是数组");
    println!(
        "[tables] 共 {} 个，前 5 个: {:?}",
        tables.len(),
        &tables[..5.min(tables.len())]
    );
    assert!(tables.len() > 100, "NC 库表数不该只有 {}", tables.len());

    let names = call(&e, "ncNames", &[]);
    println!(
        "[ncNames] 共 {} 条",
        names["names"].as_object().map(|m| m.len()).unwrap_or(0)
    );

    // 元数据用「目标表」= 自己建的那张（建不了就用库里第一张真表）
    let target = if created {
        "ncforge_probe_tmp".to_string()
    } else {
        tables[0]["name"].as_str().unwrap_or("DUAL").to_string()
    };
    println!("[元数据目标表] {target}");

    let cols = call(&e, "columns", &[&target]);
    println!("[columns] {cols}");
    let col_list = cols["columns"].as_array().expect("columns 应是数组");
    assert!(!col_list.is_empty(), "{target} 没取到列");
    if created {
        assert_eq!(col_list.len(), 2);
        assert_eq!(col_list[0]["name"], "ID");
    }

    let idx = call(&e, "indexes", &[&target]);
    println!("[indexes] {idx}");

    let ddl = call(&e, "ddl", &[&target]);
    let ddl_text = ddl["ddl"].as_str().unwrap_or("");
    println!("[ddl] {}", &ddl_text[..200.min(ddl_text.len())]);
    assert!(
        ddl_text.contains(&target.to_uppercase()),
        "取到的 DDL 里没有表名"
    );

    let plan = call(&e, "explain", &[&format!("select * from {target}")]);
    println!("[explain] {plan}");
    assert!(
        plan["plan"]
            .as_array()
            .map(|a| !a.is_empty())
            .unwrap_or(false),
        "执行计划是空的：{plan}"
    );

    let sc = call(&e, "schema", &["0", "5"]);
    println!("[schema] {sc}");
    assert_eq!(sc["rows"].as_array().unwrap().len(), 5);
    assert_eq!(sc["nextOffset"], 5);

    // ── 收尾：删表 + 断开 ─────────────────────────────────────
    if created {
        let r = call(
            &e,
            "exec",
            &["drop table ncforge_probe_tmp purge", "500", "30"],
        );
        println!("[exec drop] {r}");
    }
    let r = call(&e, "ping", &[]);
    assert_eq!(r["alive"], true);
    call(&e, "disconnect", &[]);
    let r = call(&e, "ping", &[]);
    assert_eq!(r["alive"], false, "断开后不该还活着");

    // 断开后再执行要给出「还没连数据库」而不是崩
    let err = e
        .call(
            "exec",
            &["select 1 from dual", "10", "5"],
            Duration::from_secs(5),
        )
        .expect_err("断开后执行应当报错");
    assert_eq!(err.code, "sql");
    println!("[断开后执行] {} ", err.message);
}

/// 语句中途取消：`dbms_lock.sleep` 跑 30 秒，1 秒后点「停止」必须很快回来。
///
/// 这条是 vendored 驱动补丁（`vendor/oracledb` 的 `BreakHandle`）的唯一端到端验证：
/// 单测只能证明「原子位被置了」，能不能真的把服务器那条语句打断只有真库能回答。
#[test]
#[ignore = "要连真实数据库"]
fn 纯rust引擎能在语句执行中途取消() {
    use std::sync::Arc;
    use std::time::Instant;

    let e = Arc::new(RustEngine::new());
    call(&e, "connect", &[&url(), &user(), &pass(), "false"]);

    let t0 = Instant::now();
    // 另起一个线程跑长语句：主线程要能在它阻塞期间调用 cancel
    let worker = {
        let e = e.clone();
        std::thread::spawn(move || {
            e.call(
                "exec",
                &["begin dbms_lock.sleep(30); end;", "10", "30"],
                Duration::from_secs(60),
            )
        })
    };
    std::thread::sleep(Duration::from_secs(1));
    let sent = Instant::now();
    e.cancel().expect("cancel 应当接受请求");
    let out = worker.join().expect("执行线程不该崩");
    let elapsed = sent.elapsed();
    println!(
        "[cancel] 请求后 {:?} 返回；整条语句耗时 {:?}；结果 {:?}",
        elapsed,
        t0.elapsed(),
        out.as_ref().map(|_| "成功").map_err(|e| &e.message)
    );
    assert!(out.is_err(), "被取消的语句应当以错误返回，而不是正常跑完");
    assert!(
        elapsed < Duration::from_secs(10),
        "取消用了 {elapsed:?}，太慢（30 秒的语句没被打断？）"
    );

    // 取消之后连接必须还能用，否则这个能力等于「把连接弄死」
    let r = call(&e, "exec", &["select 1 from dual", "10", "10"]);
    assert_eq!(r["rows"][0][0], "1");
    println!("[cancel 后复用] ok");
    call(&e, "disconnect", &[]);
}
