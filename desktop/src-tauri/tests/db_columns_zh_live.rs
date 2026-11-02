//! 真库快照：SQL 结果表头的列中文名（`db_meta kind=columnsZh`）。
//!
//! 默认不跑（`#[ignore]`）：要连客户的 NC 库（走 VPN），CI 里没有。
//!
//! ```text
//! cargo test --test db_columns_zh_live -- --ignored --nocapture --test-threads=1
//! ```
//!
//! 为什么值得单跑一遍：这段是**按表**查 `md_column`，拼错表名、`in (:1,:2)` 的参数
//! 个数对不上、或者驱动绑定类型不对，表现都是「安静地一个中文名都没有」——
//! 界面上只是表头继续显示类型，没人会去查是不是元数据没取到。
//!
//! 用 `columns_zh_sql()` 而不是在测试里另写一条 SQL：另写一份只能证明我抄对了，
//! 改代码之后两边会各自漂移。

use std::time::Duration;

use nc_forge::db_rust::columns_zh_sql;
use oracledb::ToDbValue;

/// 连库。拿不到配置就 `None`（测试自行跳过，而不是失败——本机没有 VPN 时不该红）。
fn connect() -> Option<oracledb::Connection> {
    let prop = || {
        let home = std::env::var("NCFORGE_NC_HOME").unwrap_or_else(|_| "D:/ncc/1909home".into());
        let path = std::path::Path::new(&home).join("ierp/bin/prop.xml");
        let bytes = std::fs::read(path).ok()?;
        nc_forge::commands::parse_prop(&bytes, "prop.xml").ok()
    };
    let url = std::env::var("NCFORGE_DB_URL")
        .ok()
        .or_else(|| prop().map(|p| p.url))?;
    let user = std::env::var("NCFORGE_DB_USER")
        .ok()
        .or_else(|| prop().map(|p| p.user))?;
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

#[test]
#[ignore = "要连客户的 NC 库（走 VPN）"]
fn 按表取列中文名() {
    let Some(conn) = connect() else {
        eprintln!("跳过：没有可用的库连接（VPN 没连或没有配置）");
        return;
    };

    let tables = ["bd_material", "bd_marbasclass"];
    let sql = columns_zh_sql(tables.len());
    let vals: Vec<&dyn ToDbValue> = tables.iter().map(|t| t as &dyn ToDbValue).collect();
    let mut cur = conn
        .query(&sql, &vals)
        .unwrap_or_else(|e| panic!("SQL 执行失败：{e}\n{sql}"));

    let mut hit = 0usize;
    let mut code: Option<String> = None;
    let mut sample: Vec<String> = Vec::new();
    for next in &mut cur {
        let row = next.unwrap_or_else(|e| panic!("取行失败：{e}"));
        let t: Option<String> = row.get(0).ok().flatten();
        let c: Option<String> = row.get(1).ok().flatten();
        let v: Option<String> = row.get(2).ok().flatten();
        let (Some(t), Some(c), Some(v)) = (t, c, v) else {
            continue;
        };
        if t == "bd_material" && sample.len() < 6 {
            sample.push(format!("{c}={v}"));
        }
        if t == "bd_material" && c == "code" {
            code = Some(v);
        }
        hit += 1;
    }

    eprintln!(
        "取到 {hit} 条列中文名；bd_material 前几列：{}",
        sample.join(" / ")
    );
    assert!(
        hit > 0,
        "两张表一条中文名都没取到：SQL 或参数绑定有问题\n{sql}"
    );
    let m = code.expect("bd_material.code 应该有中文名（这张表的中文名覆盖率是满的）");
    assert_eq!(
        m, "物料编码",
        "表结构变了？bd_material.code 的中文名不是「物料编码」"
    );
}
