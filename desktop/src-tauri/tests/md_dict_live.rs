//! 真库快照：数据字典的取数 SQL 与装配（P0-3 A 批）。
//!
//! 默认不跑（`#[ignore]`）：要靠 VPN 连客户的 NC 库，CI 里没有。
//!
//! ```text
//! cargo test --test md_dict_live -- --ignored --nocapture --test-threads=1
//! ```
//!
//! 这个测试的价值在于**它跑的是 `md_dict_sql` 里那几条 SQL 本身**，不是另写一份
//! Python 脚本去"验同一件事"——另写一份就只能证明我抄对了，改代码后两边会各自漂移。
//!
//! 取连接的方式（按顺序回退，口令不经过命令行，避免写进日志）：
//! 1. `NCFORGE_DB_URL` / `NCFORGE_DB_USER` / `NCFORGE_DB_PASS`
//! 2. `NCFORGE_DB_URL` 缺省时读 `<NCFORGE_NC_HOME>/ierp/bin/prop.xml` 的 design 数据源
//! 3. 口令缺省时读 `%APPDATA%/com.aier.ncforge/config.json` 的 `db_password_dpapi`（DPAPI 解）
//!
//! 本机 2026-11-02 实测（`aier260824`，Oracle 19.3 / ZHS16GBK）：
//! - `md_table` 5 876 张、`md_column` 223 413 列、`displayname` 含中文 99%
//! - `bd_` 前缀 328 张表 → 18 657 列行（join `md_ormap` 后）→ 折叠回真实列数
//! - `bd_billtype` 41 列全部有中文名，映射到 3 个类 / 2 个 VO 类
//! - `industry` 为 NULL 的 26 张表里 25 张是二开扩展表（照抄 NC 的条件会丢掉它们）

use std::time::Duration;

use nc_forge::md_dict::{self, Grid};
use nc_forge::md_dict_sql::{self, TableFilter};

/// 连库。拿不到配置就 `None`（测试自行跳过，而不是失败——本机没有 VPN 时不该红）。
fn connect() -> Option<oracledb::Connection> {
    let url = std::env::var("NCFORGE_DB_URL").ok().or_else(|| {
        let home = std::env::var("NCFORGE_NC_HOME").unwrap_or_else(|_| "D:/ncc/1909home".into());
        let path = std::path::Path::new(&home).join("ierp/bin/prop.xml");
        let bytes = std::fs::read(path).ok()?;
        let prop = nc_forge::commands::parse_prop(&bytes, "prop.xml").ok()?;
        Some(prop.url)
    })?;
    let user = std::env::var("NCFORGE_DB_USER").ok().or_else(|| {
        let home = std::env::var("NCFORGE_NC_HOME").unwrap_or_else(|_| "D:/ncc/1909home".into());
        let path = std::path::Path::new(&home).join("ierp/bin/prop.xml");
        let bytes = std::fs::read(path).ok()?;
        let prop = nc_forge::commands::parse_prop(&bytes, "prop.xml").ok()?;
        Some(prop.user)
    })?;
    let pass = std::env::var("NCFORGE_DB_PASS").ok().or_else(|| {
        let appdata = std::env::var("APPDATA").ok()?;
        let path = std::path::Path::new(&appdata)
            .join("com.aier.ncforge")
            .join("config.json");
        let text = std::fs::read_to_string(path).ok()?;
        let cfg: serde_json::Value = serde_json::from_str(&text).ok()?;
        let b64 = cfg.get("db_password_dpapi")?.as_str()?;
        let raw = nc_forge::svn_cred::b64_decode(b64)?;
        let plain = nc_forge::svn_cred::dpapi_unprotect(&raw).ok()?;
        String::from_utf8(plain).ok()
    })?;

    let cs = nc_forge::db_rust::connect_string_from_jdbc(&url).ok()?;
    let cfg = oracledb::Config::default()
        .set_credentials(&user, &pass)
        .set_transport_connect_timeout(Some(Duration::from_secs(15)))
        .set_connect_string(&cs)
        .ok()?;
    oracledb::connect(cfg).ok()
}

/// 在真库上跑一条 SQL，按桥的真实形状包成 Grid 再解析。
///
/// 列必须是 `{"name":…,"type":…}` **对象**（`NcDbBridge.columnsJson` 与
/// `db_rust::column_json` 都这么给）。这里若图省事塞字符串数组，就会绕过
/// `Grid` 的列名解析——而那正是"每列读成空串、字典变一堆空表却不报错"的地方，
/// 之前真踩过一次，所以测试必须照生产形状来。
fn run(conn: &oracledb::Connection, sql: &str) -> Grid {
    let mut cur = conn
        .query(sql, &[])
        .unwrap_or_else(|e| panic!("SQL 执行失败：{e}\n{sql}"));
    let cols: Vec<serde_json::Value> = cur
        .columns()
        .iter()
        .map(|c| serde_json::json!({ "name": c.name(), "type": format!("{:?}", c.db_type()) }))
        .collect();
    let n = cols.len();
    let mut rows: Vec<serde_json::Value> = Vec::new();
    for next in &mut cur {
        let row = next.unwrap_or_else(|e| panic!("取行失败：{e}"));
        rows.push(serde_json::Value::Array(
            (0..n).map(|i| cell(&row, i)).collect(),
        ));
    }
    Grid::parse(&serde_json::json!({ "columns": cols, "rows": rows }))
        .unwrap_or_else(|e| panic!("{e}\n{sql}"))
}

/// 一个格子 → JSON。驱动把 NUMBER 也按字符串给（与 JVM 桥 `toPlainString()` 对齐），
/// 所以先试字符串，取不出来再退数字，最后给占位——和 `db_rust::cell_json` 一个路子。
fn cell(row: &oracledb::Row, i: usize) -> serde_json::Value {
    match row.get::<Option<String>>(i) {
        Ok(Some(s)) => serde_json::Value::String(s),
        Ok(None) => serde_json::Value::Null,
        Err(_) => match row.get::<Option<i64>>(i) {
            Ok(Some(n)) => serde_json::json!(n),
            Ok(None) => serde_json::Value::Null,
            Err(_) => serde_json::Value::String("<unsupported>".into()),
        },
    }
}

fn filter_prefix(p: &str) -> TableFilter {
    TableFilter {
        prefix: p.into(),
        ..Default::default()
    }
}

#[test]
#[ignore = "要连客户的 NC 库（走 VPN）"]
fn 前缀取表_列_实体并装配() {
    let Some(conn) = connect() else {
        eprintln!("跳过：没有可用的库连接（VPN 没连或没有配置）");
        return;
    };

    let sql = md_dict_sql::tables_sql(&filter_prefix("bd_"), md_dict_sql::MAX_TABLES).unwrap();
    println!("--- 表清单 SQL ---\n{sql}");
    let tables = md_dict::read_tables(&run(&conn, &sql));
    println!("bd_ 前缀 {} 张表", tables.len());
    assert!(tables.len() > 200, "bd_ 应该有两百多张表");
    assert!(
        tables.iter().all(|t| !t.name.is_empty()),
        "表名不能为空（列名下标对不上时会这样）"
    );
    assert!(
        tables.iter().any(|t| t.name == "bd_billtype"),
        "bd_billtype 必须在列表里"
    );

    // 扩展表：`industry` 为 NULL 的那批，照抄 NC 自己的 SQL 会漏掉
    let ext = tables.iter().filter(|t| t.is_extend).count();
    println!("其中二开扩展表 {ext} 张");

    let ids: Vec<String> = tables.iter().map(|t| t.id.clone()).collect();
    let mut cols = Vec::new();
    for s in md_dict_sql::columns_sqls(&ids) {
        cols.extend(md_dict::read_columns(&run(&conn, &s)));
    }
    let mut ents = Vec::new();
    for s in md_dict_sql::entities_sqls(&ids) {
        ents.extend(md_dict::read_entities(&run(&conn, &s)));
    }
    println!("列 × 属性 {} 行，实体 {} 组", cols.len(), ents.len());
    assert!(
        cols.len() > ids.len(),
        "join 后行数应多于表数（说明属性确实被取到了）"
    );

    let dict = md_dict::build(&tables, &cols, &ents);
    let (t_n, c_n, no_name) = md_dict::stats(&dict);
    println!("装配结果：{t_n} 表 / {c_n} 列 / 缺中文 {no_name} 列");
    assert_eq!(t_n, tables.len());
    // 中文覆盖率：本库实测全列有中文的表 95%
    let named = c_n - no_name;
    println!("中文覆盖 {:.1}%", named as f64 * 100.0 / c_n.max(1) as f64);
    assert!(
        named * 100 / c_n.max(1) > 80,
        "中文覆盖率异常低，可能是 displayname 没取到或编码问题"
    );

    // 定锚：bd_billtype 41 列、41 列都有中文名、映射到多个实体
    let bt = dict.iter().find(|t| t.name == "bd_billtype").unwrap();
    println!(
        "bd_billtype：{} 列，中文名缺 {}，实体 {:?}",
        bt.columns.len(),
        bt.columns
            .iter()
            .filter(|c| c.display_name.is_empty())
            .count(),
        bt.entities
            .iter()
            .map(|e| e.class_name.as_str())
            .collect::<Vec<_>>()
    );
    assert_eq!(bt.columns.len(), 41, "join 后未折叠会虚高到 96");
    assert!(
        bt.columns.iter().all(|c| !c.display_name.is_empty()),
        "bd_billtype 的 41 列在库里全有中文名"
    );
    assert!(
        bt.entities
            .iter()
            .any(|e| e.full_class_name.contains("BilltypeVO")),
        "应能定位到 BilltypeVO"
    );
    // 折叠：属性按名去重。实测 bd_billtype 有 19 列在 join 后各出 2 条属性，
    // 它们的属性名相同、中文名不同（billstyle →「单据大类」/「系统类别(单据大类)」），
    // 应合成一条并把中文名并列，而不是输出两行同名属性。
    for c in &bt.columns {
        let mut names: Vec<&str> = c.props.iter().map(|p| p.name.as_str()).collect();
        let before = names.len();
        names.sort_unstable();
        names.dedup();
        assert_eq!(
            before,
            names.len(),
            "{} 的属性名重复了：{:?}",
            c.name,
            names
        );
    }
    let joined = bt
        .columns
        .iter()
        .filter(|c| c.props.iter().any(|p| p.display_name.contains(" / ")))
        .count();
    println!("bd_billtype 中属性中文名并列的列：{joined} 个");
    for c in bt
        .columns
        .iter()
        .filter(|c| c.props.iter().any(|p| p.display_name.contains(" / ")))
        .take(3)
    {
        println!(
            "  {} → {:?}",
            c.name,
            c.props
                .iter()
                .map(|p| (p.name.as_str(), p.display_name.as_str()))
                .collect::<Vec<_>>()
        );
    }

    // 扩展表的中文覆盖（实测 100%）
    if let Some(e) = dict.iter().find(|t| t.is_extend) {
        let miss = e
            .columns
            .iter()
            .filter(|c| c.display_name.is_empty())
            .count();
        println!("扩展表 {}：{} 列，缺中文 {miss}", e.name, e.columns.len());
    }

    // 缺表检测
    let miss = md_dict::missing_tables(
        &["bd_billtype".to_string(), "zz_not_a_table".to_string()],
        &dict,
    );
    assert_eq!(miss, vec!["zz_not_a_table".to_string()]);
}

#[test]
#[ignore = "要连客户的 NC 库（走 VPN）"]
fn 关键词与不存在的表都按预期返回() {
    let Some(conn) = connect() else {
        eprintln!("跳过：没有可用的库连接");
        return;
    };

    // 关键词同时命中表名与中文名（「票据」在中文名里）
    let sql = md_dict_sql::tables_sql(
        &TableFilter {
            keyword: "票据".into(),
            ..Default::default()
        },
        md_dict_sql::MAX_TABLES,
    )
    .unwrap();
    let rows = md_dict::read_tables(&run(&conn, &sql));
    println!("关键词「票据」命中 {} 张", rows.len());
    assert!(!rows.is_empty(), "中文关键词应该能命中");

    // 不存在的表名：不报错，返回空（由 missing_tables 报给用户）
    let sql = md_dict_sql::tables_sql(
        &TableFilter {
            names: vec!["zz_not_a_table".into()],
            ..Default::default()
        },
        md_dict_sql::MAX_TABLES,
    )
    .unwrap();
    let rows = md_dict::read_tables(&run(&conn, &sql));
    assert!(rows.is_empty(), "查不到就是空，不该是错");

    // 单引号不会被当成 SQL 注入（表名来自库里元数据，不保证规范）
    let sql = md_dict_sql::tables_sql(
        &TableFilter {
            names: vec!["a'b".into()],
            ..Default::default()
        },
        md_dict_sql::MAX_TABLES,
    )
    .unwrap();
    let rows = md_dict::read_tables(&run(&conn, &sql));
    assert!(rows.is_empty());
}
