//! 双引擎一致性：同一批 SQL 分别走 JVM 桥和纯 Rust 驱动，比结果。
//!
//! **默认不跑**（`#[ignore]`）。为什么要它：两个引擎最终显示在同一个结果表格里，
//! 取值规则只要有一处不一样（比如 NUMBER 一边给字符串一边给数字），
//! 用户就会看到「同一条 SQL 换条连接结果就变了」，而这种差异靠看代码发现不了。
//!
//! ```bash
//! NC_HOME=d:/ncc/1909home NC_DB_DS=design \
//! NC_RUST_URL='jdbc:oracle:thin:@10.200.22.144:1521/aier260824' \
//! NC_RUST_USER=aier633 NC_RUST_PASS=aier633 \
//!   cargo test --test db_engine_equiv -- --ignored --nocapture
//! ```

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use nc_forge::db_bridge;
use nc_forge::db_engine::EngineHandle;
use nc_forge::db_rust::RustEngine;
use serde_json::Value;

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

fn jvm_handle() -> Option<(EngineHandle, String)> {
    let home = std::env::var("NC_HOME").ok().map(PathBuf::from)?;
    if !home.is_dir() {
        return None;
    }
    let driver = db_bridge::find_driver(&home)?;
    let env = db_bridge::env(
        home.join("ufjdk/bin/java.exe"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/ncdb/ncdb.jar"),
        driver,
        db_bridge::nc_decrypt_jars(&home),
        std::env::temp_dir().join("ncforge-equiv"),
    );
    let h = EngineHandle::java(Arc::new(db_bridge::Bridge::new(env)), "equiv");
    let home_s = home.display().to_string();
    let ds = env_or("NC_DB_DS", "design");
    h.call(
        "connectProp",
        &[&home_s, &ds, "false"],
        Duration::from_secs(90),
    )
    .expect("JVM 桥连不上（先确认 VPN 与 prop.xml）");
    Some((h, home_s))
}

/// 只比结果本身：`ms` / `output` / `tx` 是各自实现的内部状态，不该拿来比。
fn cells(v: &Value) -> (Value, Value) {
    (v["columns"].clone(), v["rows"].clone())
}

#[test]
#[ignore = "要连真实数据库"]
fn 两个引擎的取值规则一致() {
    let Some((jvm, _home)) = jvm_handle() else {
        println!("没有设置 NC_HOME，跳过");
        return;
    };
    let rust = RustEngine::new();
    let info = rust
        .call(
            "connect",
            &[
                &env_or(
                    "NC_RUST_URL",
                    "jdbc:oracle:thin:@10.200.22.144:1521/aier260824",
                ),
                &env_or("NC_RUST_USER", "aier633"),
                &env_or("NC_RUST_PASS", "aier633"),
                "false",
            ],
            Duration::from_secs(60),
        )
        .expect("Rust 引擎连不上");
    println!("Rust 连上：{}", info["version"]);

    // 每种类型一条，覆盖结果表格会遇到的取值分支
    let cases = [
        "select 11 as 整数, 12345678901234567890123 as 巨数, 3.14 as 小数 from dual",
        "select 0.000001 as 极小, 1e20 as 科学, -0.5 as 负 from dual",
        "select '中文水印' as 文本, null as 空值, '' as 空串 from dual",
        "select date '2026-10-30' as 日期 from dual",
        "select timestamp '2026-10-30 12:34:56.789' as 时间戳 from dual",
        "select to_clob('大文本内容') as clob  from dual",
        "select hextoraw('4f4b') as raw值 from dual",
        "select cast(1 as binary_double) as bd, cast(2 as binary_float) as bf from dual",
        "select count(*) as 表数 from user_tables",
        "select table_name, column_id from user_tab_columns where rownum <= 3",
        "select 1 as a from dual union all select 2 from dual union all select null from dual",
    ];

    let mut diffs = 0;
    // 真实 CLOB 列：动态找一张有 CLOB 的表，两个引擎各取一行比。计算列 `to_clob(..)`
    // 服务器描述出来可能是 LONG，真表列才能代表界面上会遇到的绝大多数情况。
    let found = jvm
        .call(
            "exec",
            &[
                "select table_name, column_name from user_tab_columns \
                 where data_type = 'CLOB' and rownum <= 1",
                "5",
                "120",
            ],
            Duration::from_secs(150),
        )
        .unwrap();
    let mut cases: Vec<String> = cases.iter().map(|s| s.to_string()).collect();
    if let Some(row) = found["rows"].as_array().and_then(|a| a.first()) {
        let sql = format!(
            "select {} as 真表列 from {} where rownum <= 1",
            row[1].as_str().unwrap_or("1"),
            row[0].as_str().unwrap_or("dual")
        );
        println!("动态样例：{sql}");
        cases.push(sql);
    }
    for sql in cases.iter().map(|s| s.as_str()) {
        let a = jvm
            .call("exec", &[sql, "20", "60"], Duration::from_secs(60))
            .unwrap_or_else(|e| panic!("JVM 执行失败：{sql}\n{}", e.message));
        let b = rust
            .call("exec", &[sql, "20", "60"], Duration::from_secs(60))
            .unwrap_or_else(|e| panic!("Rust 执行失败：{sql}\n{}", e.message));
        let (ca, ra) = cells(&a);
        let (cb, rb) = cells(&b);
        if ca != cb || ra != rb {
            diffs += 1;
            println!("\n✗ 不一致：{sql}");
            if ca != cb {
                println!("  列 JVM : {ca}\n  列 Rust: {cb}");
            }
            if ra != rb {
                println!("  行 JVM : {ra}\n  行 Rust: {rb}");
            }
        } else {
            println!(
                "✓ {sql}\n   {}",
                &ra.to_string()[..120.min(ra.to_string().len())]
            );
        }
    }
    assert_eq!(diffs, 0, "{diffs} 条 SQL 两个引擎结果不同");

    // 分页：一次只取 7 行，连取三页。验证 Rust 侧的游标续取没有漏行/重行，
    // 且「还有没有更多」的判定与 JVM 桥一致（这是最容易差一行的地方）。
    let sql = "select table_name from user_tables order by table_name";
    let mut page_jvm = jvm
        .call("exec", &[sql, "7", "60"], Duration::from_secs(60))
        .unwrap();
    let mut page_rust = rust
        .call("exec", &[sql, "7", "60"], Duration::from_secs(60))
        .unwrap();
    for p in 1..=3 {
        let (ca, ra) = cells(&page_jvm);
        let (cb, rb) = cells(&page_rust);
        assert_eq!(ca, cb, "第 {p} 页列不同");
        assert_eq!(ra, rb, "第 {p} 页行不同");
        assert_eq!(
            page_jvm["hasMore"], page_rust["hasMore"],
            "第 {p} 页的 hasMore 不同"
        );
        println!(
            "第 {p} 页 {} 行，hasMore={}",
            ra.as_array().unwrap().len(),
            page_rust["hasMore"]
        );
        page_jvm = jvm.call("more", &["7"], Duration::from_secs(60)).unwrap();
        page_rust = rust.call("more", &["7"], Duration::from_secs(60)).unwrap();
    }
}

#[test]
#[ignore = "要连真实数据库"]
fn 两个引擎的元数据一致() {
    let Some((jvm, _home)) = jvm_handle() else {
        println!("没有设置 NC_HOME，跳过");
        return;
    };
    let rust = RustEngine::new();
    rust.call(
        "connect",
        &[
            &env_or(
                "NC_RUST_URL",
                "jdbc:oracle:thin:@10.200.22.144:1521/aier260824",
            ),
            &env_or("NC_RUST_USER", "aier633"),
            &env_or("NC_RUST_PASS", "aier633"),
            "false",
        ],
        Duration::from_secs(60),
    )
    .expect("Rust 引擎连不上");

    let t = "bd_defdoc";

    // 表清单：两边都是「用户自己的表 + 视图」，数量应当一致
    let a = jvm.call("tables", &[], Duration::from_secs(120)).unwrap();
    let b = rust.call("tables", &[], Duration::from_secs(120)).unwrap();
    println!("tables: JVM {} / Rust {}", a["count"], b["count"]);
    assert_eq!(
        a["count"], b["count"],
        "表清单数量不同（JVM {} vs Rust {}）",
        a["count"], b["count"]
    );

    // 列清单：名字、类型、可空、主键、中文名，逐字段比
    let a = jvm.call("columns", &[t], Duration::from_secs(60)).unwrap();
    let b = rust.call("columns", &[t], Duration::from_secs(60)).unwrap();
    let ca = a["columns"].as_array().unwrap();
    let cb = b["columns"].as_array().unwrap();
    println!("columns: JVM {} / Rust {}", ca.len(), cb.len());
    for (x, y) in ca.iter().zip(cb.iter()) {
        for k in ["name", "type", "full", "size", "nullable", "pk", "zh"] {
            if x[k] != y[k] {
                println!("  ✗ {}.{k}: JVM {:?} vs Rust {:?}", x["name"], x[k], y[k]);
            }
        }
    }
    assert_eq!(ca.len(), cb.len(), "列数不同");

    // 索引
    let a = jvm.call("indexes", &[t], Duration::from_secs(60)).unwrap();
    let b = rust.call("indexes", &[t], Duration::from_secs(60)).unwrap();
    println!("indexes: JVM {} / Rust {}", a["indexes"], b["indexes"]);
    assert_eq!(a["indexes"], b["indexes"], "索引清单不同");

    // 中文表名
    let a = jvm.call("ncNames", &[], Duration::from_secs(120)).unwrap();
    let b = rust.call("ncNames", &[], Duration::from_secs(120)).unwrap();
    println!("ncNames: JVM {} / Rust {}", a["count"], b["count"]);
    assert_eq!(a["count"], b["count"], "中文表名数量不同");

    jvm.shutdown();
}
