//! REF CURSOR 探针（缺口一）：决定「隐式结果集」与「OUT 绑定」两条路哪条走得通。
//!
//! **默认不跑**（`#[ignore]`）：要连真实数据库（公司内网 + VPN）。
//!
//! ```bash
//! NC_RUST_URL='jdbc:oracle:thin:@10.200.22.144:1521/aier260824' \
//! NC_RUST_USER=aier633 NC_RUST_PASS=aier633 \
//!   cargo test --test db_refcursor_probe -- --ignored --nocapture --test-threads=1
//! ```
//!
//! # 为什么这几个场景能定方向
//!
//! 上游调研（方案文档 1.1 / 7.3）已确认：
//! - 驱动**完全没有 OUT 绑定 API**（`bind_params.rs` 只有输入值），这是 `PLS-00707` 的根因；
//! - 但 `execute.rs:102` 已经置了 `TTC_EXEC_FLAGS_IMPLICIT_RESULTSET`，而
//!   `constants.rs:206` 的 `_TTC_MSG_TYPE_IMPLICIT_RESULTSET = 27` **全仓无人引用**。
//!
//! 于是 R2 就是分水岭：
//! - **报协议错误** ⇒ 消息分发不认 27 号，方案 A 要连消息表一起改（改动面 +N 行）；
//! - **静默成功但拿不到行** ⇒ 更糟：服务端发了结果集而我们整个丢掉，用户以为执行完了；
//! - **拿到行** ⇒ 说明已经通了，只差把它暴露出来。
//!
//! python-oracledb thin 已支持隐式结果集（其文档 30.5 节专讲），所以协议侧是通的。

// 场景名用中文（可读性优先），否则 clippy 的 snake_case 会在 -D warnings 口径下报错。
#![allow(non_snake_case)]

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

fn assert_alive(conn: &Connection, tag: &str) {
    let mut cur = conn.query("select 1 from dual", &[]).expect("select 失败");
    let row = cur.next().expect("无行").expect("取行失败");
    let v: i64 = row.get(0).expect("取列失败");
    println!("    {tag} 之后 select 1 from dual = {v}");
    assert_eq!(v, 1, "{tag} 之后会话应仍可用");
}

/// 跑一条语句，把结果或错误原样打印，不断言（探针的职责是观察）。
fn try_exec(conn: &Connection, label: &str, sql: &str, params: &[&dyn ToDbValue]) {
    println!("[{label}] sql = {sql}");
    print!("    ");
    match conn.execute(sql, params) {
        Ok(_) => println!("成功（注意：成功不等于拿到结果集，要看有没有行）"),
        Err(e) => println!("错误 kind={:?} msg={}", e.kind(), e),
    }
}

/// R1：确认根因。带占位符的 `open :1 for`，占位符传空串。
/// 预期 `PLS-00707`；若返回别的错，方案文档 1.1 的根因判断要修正。
#[test]
#[ignore = "要连真实数据库；需先挂 VPN"]
fn R1_open占位符预期PLS00707() {
    let conn = connect();
    assert_alive(&conn, "R1 前置");
    let s = String::new();
    try_exec(
        &conn,
        "R1",
        "begin open :1 for select 1 as x from dual; end;",
        &[&s as &dyn ToDbValue],
    );
    assert_alive(&conn, "R1");
}

/// R2：分水岭。`dbms_sql.return_result` 走隐式结果集，驱动已置 flag 但没实现消息 27。
#[test]
#[ignore = "要连真实数据库；需先挂 VPN"]
fn R2_return_result隐式结果集() {
    let conn = connect();
    try_exec(
        &conn,
        "R2",
        "declare rc sys_refcursor; \
         begin open rc for select 111 as a, 'abc' as b from dual; \
         dbms_sql.return_result(rc); end;",
        &[] as &[&dyn ToDbValue],
    );
    assert_alive(&conn, "R2");
}

/// R3：多个结果集，验证「按顺序返回多个结果集」能否实现。
#[test]
#[ignore = "要连真实数据库；需先挂 VPN"]
fn R3_多个return_result() {
    let conn = connect();
    try_exec(
        &conn,
        "R3",
        "declare rc sys_refcursor; \
         begin \
           open rc for select 1 as n from dual; dbms_sql.return_result(rc); \
           open rc for select 'x' as s from dual; dbms_sql.return_result(rc); \
         end;",
        &[] as &[&dyn ToDbValue],
    );
    assert_alive(&conn, "R3");
}

/// R4：真实形态——游标绑到占位符（方案 D 要兜的那类）。
#[test]
#[ignore = "要连真实数据库；需先挂 VPN"]
fn R4_占位符游标_真实形态() {
    let conn = connect();
    let s = String::new();
    try_exec(
        &conn,
        "R4",
        "begin open :1 for select table_name from all_tables where rownum <= 3; end;",
        &[&s as &dyn ToDbValue],
    );
    assert_alive(&conn, "R4");
}

/// R6：**现成管道能不能跑**。嵌套游标列（`select cursor(...) from dual`）。
///
/// 这条不是 REF CURSOR，但它走的路和消息 27 的后半段**完全一样**：
/// `CachedStatement::from_cursor_response`（读 ub1 长度 + describe + ub2 cursor id）
/// → `PendingDbValue::Cursor` → `DbValue::Cursor` → `FromDbValue for Cursor`。
///
/// 若这里能拿到行，方案 A 的改动面就只剩「消息 27 的分发与循环 + 对外 API」；
/// 若这里也拿不到，说明 `from_cursor_response` 是个没被验证过的死代码，工作量要重估。
#[test]
#[ignore = "要连真实数据库；需先挂 VPN"]
fn R6_嵌套游标列() {
    let conn = connect();
    assert_alive(&conn, "R6 前置");
    println!(
        "[R6] sql = select cursor(select 100 as z from dual) as c, 42 as n, 'abc' as s from dual"
    );
    let mut cur = match conn.query(
        "select cursor(select 100 as z from dual) as c, 42 as n, 'abc' as s from dual",
        &[],
    ) {
        Ok(c) => c,
        Err(e) => {
            println!("    外层查询失败 kind={:?} msg={e}", e.kind());
            return;
        }
    };
    let mut row = match cur.next() {
        Some(Ok(r)) => r,
        Some(Err(e)) => {
            println!("    取行失败 msg={e}");
            return;
        }
        None => {
            println!("    没有行");
            return;
        }
    };
    // `Row::get` 走的是 `ColumnData::Borrowed`，而 cursor 是不可克隆的值，
    // 只有 `Row::take`（Owned）能把它取出来——这本身也是个要记下来的事实。
    // 关键判据：游标列后面的普通列如果读对了，说明「describe + cursor id」没有字节错位。
    let n: i64 = row.take(1).unwrap_or(-1);
    let s: String = row.take(2).unwrap_or_default();
    println!("    后续普通列 n={n} s={s:?}（应为 42 / \"abc\"）");
    match row.take::<oracledb::Cursor>(0) {
        Ok(child) => {
            let cols: Vec<String> = child
                .columns()
                .iter()
                .map(|m| m.name().to_string())
                .collect();
            println!("    子游标列 = {cols:?}，开始取行");
            for r in child {
                match r {
                    Ok(r) => {
                        let v: i64 = r.get(0).unwrap_or(-1);
                        println!("    子游标行 = {v}");
                    }
                    Err(e) => {
                        // 取行失败后 Iterator 仍会再试（end_of_fetch 未置位），
                        // 探针里必须自己 break，否则无限重试。
                        println!("    子游标取行失败 msg={e}（停止重试）");
                        break;
                    }
                }
            }
        }
        Err(e) => println!("    取 cursor 列失败 msg={e}"),
    }
    assert_alive(&conn, "R6");
}

/// R7：对照 R6——**普通游标的分页 fetch 是否正常**。
///
/// 如果这条能完整取回 500 行，说明 `TTC_RPC_FETCH` + ub2 cursor id 对普通游标是好的，
/// R6 的 `ORA-01001` 就不是「fetch 消息写错」，而是 ref cursor 语义问题
/// （python thin 根本没有 FETCH 这条 RPC，取行一律走 REEXECUTE_AND_FETCH）。
#[test]
#[ignore = "要连真实数据库；需先挂 VPN"]
fn R7_普通游标分页fetch() {
    let conn = connect();
    let cur = match conn.query(
        "select object_name from all_objects where rownum <= 500",
        &[],
    ) {
        Ok(c) => c,
        Err(e) => {
            println!("[R7] 查询失败 msg={e}");
            return;
        }
    };
    let mut n = 0usize;
    let mut err = None;
    for r in cur {
        match r {
            Ok(_) => n += 1,
            Err(e) => {
                err = Some(e.to_string());
                break;
            }
        }
        if n > 2000 {
            break; // 防御：不该发生，防止探针挂死
        }
    }
    println!("[R7] 取回 {n} 行，错误 = {err:?}（期望 500 行 / None）");
    assert_alive(&conn, "R7");
}

/// R8：隐式结果集完整链路（块 b）——`dbms_sql.return_result` 能不能真拿到行。
///
/// 块 b 之前这里报 `UnknownTtcMessageType(27)`；补上 27 号消息解析后，
/// 期望「1 个结果集、2 列、1 行 (111, "abc")」，且取完后会话正常。
#[test]
#[ignore = "要连真实数据库；需先挂 VPN"]
fn R8_隐式结果集取行() {
    let conn = connect();
    let mut result = match conn.execute(
        "declare rc sys_refcursor; \
         begin open rc for select 111 as a, 'abc' as b from dual; \
         dbms_sql.return_result(rc); end;",
        &[] as &[&dyn ToDbValue],
    ) {
        Ok(r) => r,
        Err(e) => {
            println!("[R8] 执行失败 kind={:?} msg={e}", e.kind());
            return;
        }
    };
    let mut sets = result.implicit_resultsets();
    println!("[R8] 结果集个数 = {}（期望 1）", sets.len());
    for (i, cur) in sets.iter_mut().enumerate() {
        let cols: Vec<String> = cur.columns().iter().map(|m| m.name().to_string()).collect();
        println!("    结果集 {i} 列 = {cols:?}（期望 [\"A\", \"B\"]）");
        let mut n = 0usize;
        let mut err = None;
        for r in cur {
            match r {
                Ok(mut row) => {
                    let a: i64 = row.take(0).unwrap_or(-1);
                    let b: String = row.take(1).unwrap_or_default();
                    println!("    行 = ({a}, {b:?})（期望 (111, \"abc\")）");
                    n += 1;
                }
                Err(e) => {
                    // 取行失败后 Iterator 不会置 end_of_fetch，必须自己 break。
                    err = Some(e.to_string());
                    break;
                }
            }
            if n > 100 {
                break;
            }
        }
        println!("    结果集 {i} 行数 = {n}，错误 = {err:?}");
    }
    assert_alive(&conn, "R8");
}

/// R9：多个隐式结果集，验证「按 return_result 顺序返回」。
#[test]
#[ignore = "要连真实数据库；需先挂 VPN"]
fn R9_多个隐式结果集顺序() {
    let conn = connect();
    let mut result = match conn.execute(
        "declare rc sys_refcursor; \
         begin \
           open rc for select 1 as n from dual; dbms_sql.return_result(rc); \
           open rc for select 'x' as s from dual; dbms_sql.return_result(rc); \
         end;",
        &[] as &[&dyn ToDbValue],
    ) {
        Ok(r) => r,
        Err(e) => {
            println!("[R9] 执行失败 msg={e}");
            return;
        }
    };
    let mut sets = result.implicit_resultsets();
    println!("[R9] 结果集个数 = {}（期望 2）", sets.len());
    for (i, cur) in sets.iter_mut().enumerate() {
        let cols: Vec<String> = cur.columns().iter().map(|m| m.name().to_string()).collect();
        let mut vals: Vec<String> = Vec::new();
        for r in cur {
            match r {
                Ok(mut row) => {
                    let v: String = row.take(0).unwrap_or_default();
                    vals.push(v);
                }
                Err(e) => {
                    println!("    结果集 {i} 取行失败 msg={e}");
                    break;
                }
            }
        }
        println!("    结果集 {i}: 列 = {cols:?} 值 = {vals:?}");
    }
    assert_alive(&conn, "R9");
}

/// R10：0 行的隐式结果集——列元数据是否仍在（空结果集也要出表头）。
#[test]
#[ignore = "要连真实数据库；需先挂 VPN"]
fn R10_空隐式结果集() {
    let conn = connect();
    let mut result = match conn.execute(
        "declare rc sys_refcursor; \
         begin open rc for select table_name, tablespace_name \
           from all_tables where 1 = 0; dbms_sql.return_result(rc); end;",
        &[] as &[&dyn ToDbValue],
    ) {
        Ok(r) => r,
        Err(e) => {
            println!("[R10] 执行失败 msg={e}");
            return;
        }
    };
    let mut sets = result.implicit_resultsets();
    println!("[R10] 结果集个数 = {}（期望 1）", sets.len());
    for (i, cur) in sets.iter_mut().enumerate() {
        let cols: Vec<String> = cur.columns().iter().map(|m| m.name().to_string()).collect();
        let mut n = 0usize;
        let mut err = None;
        for r in cur {
            match r {
                Ok(_) => n += 1,
                Err(e) => {
                    err = Some(e.to_string());
                    break;
                }
            }
        }
        println!("    结果集 {i}: 列 = {cols:?}（期望 2 列）行数 = {n} 错误 = {err:?}");
    }
    assert_alive(&conn, "R10");
}

/// R11：游标不泄漏——反复执行 `return_result` 但**完全不看**结果集，
/// 也不能把会话的 `open_cursors`（默认 300）攒爆。
///
/// 这条专门盯 `ExecResult` 的 Drop：子语句是裸 `CachedStatement`，
/// 不主动归还就会一直挂在服务端。
#[test]
#[ignore = "要连真实数据库；需先挂 VPN"]
fn R11_未取结果集不泄漏游标() {
    let conn = connect();
    let n = 400;
    let mut fail = None;
    for i in 0..n {
        match conn.execute(
            "declare rc sys_refcursor; \
             begin open rc for select 1 as n from dual; \
             dbms_sql.return_result(rc); end;",
            &[] as &[&dyn ToDbValue],
        ) {
            Ok(result) => drop(result),
            Err(e) => {
                fail = Some((i, e.to_string()));
                break;
            }
        }
    }
    println!("[R11] 连跑 {n} 次不取结果集，失败 = {fail:?}（期望 None）");
    assert!(
        fail.is_none(),
        "子游标没归还，第 {} 次就撞上 open_cursors 上限：{:?}",
        n,
        fail
    );
    assert_alive(&conn, "R11");
}

/// R5：对照组。同一形态在 JVM 桥（JDBC）上能不能跑。
///
/// 需要 NC_HOME + ncdb.jar，缺了就跳过。
///
/// # 为什么要真跑一遍，而不是「JDBC 应该能跑」
///
/// P0「语句自动回落 JVM 桥」的全部价值都押在这条上：如果桥自己也跑不了，回落只是把
/// 一个报错换成另一个报错。**实测结论（2026-10-31）**：桥原来也跑不了
/// （`ORA-01008 并非所有变量都已绑定`，因为它用普通 `Statement`，没有 OUT 绑定）。
/// 补上 `prepareCall` + `registerOutParameter(CURSOR)` 之后才通 —— 这条用例就是那道守卫。
#[test]
#[ignore = "要连真实数据库；需先挂 VPN"]
fn R5_对照_JVM桥能跑() {
    let Some(h) = jvm_session() else {
        return;
    };
    let t = std::time::Duration::from_secs(30);
    // 与 R4 逐字相同的语句
    let sql = "begin open :1 for select table_name from all_tables where rownum <= 3; end;";
    let v = h
        .call("exec", &[sql, "10", "30"], t)
        .expect("桥执行 OUT 绑定形态失败");
    assert_eq!(v["kind"], "rows", "应当是结果集：{v}");
    let rows = v["rows"].as_array().map(|a| a.len()).unwrap_or(0);
    assert!(rows > 0, "应当取到行（P0 回落的前提）：{v}");
    assert_eq!(v["rowCount"].as_u64(), Some(rows as u64));

    // 两个游标：第一个进顶层，其余进 sets（与 Rust 引擎同形）
    let two = "begin open :1 for select 1 as a from dual; \
               open :2 for select 'x' as b from dual; end;";
    let v2 = h
        .call("exec", &[two, "10", "30"], t)
        .expect("两个游标执行失败");
    // 注意：JVM 桥把所有值都编码成字符串（`"1"`），Rust 引擎给的是类型化 JSON（`1`）——
    // 这是两条引擎既有的差异，前端按字符串渲染，这里按桥的约定断言。
    assert_eq!(v2["rows"][0][0], "1", "第一个游标应在顶层：{v2}");
    let sets = v2["sets"].as_array().expect("第二个游标应进 sets");
    assert_eq!(sets.len(), 1, "只该有一个附加结果集：{v2}");
    assert_eq!(sets[0]["rows"][0][0], "x");

    // 取满就停下，`more` 还能接着取（说明桥里游标没被关掉）
    let page = "begin open :1 for select table_name from all_tables where rownum <= 8; end;";
    let v3 = h.call("exec", &[page, "3", "30"], t).expect("分页执行失败");
    assert_eq!(v3["rowCount"].as_u64(), Some(3));
    assert_eq!(v3["hasMore"], true, "8 行只取 3 行，应当还有：{v3}");
    let v4 = h.call("more", &["3"], t).expect("加载更多失败");
    assert_eq!(
        v4["rowCount"].as_u64(),
        Some(3),
        "第二页应当也是 3 行：{v4}"
    );
}

/// 起一个连好库的 JVM 桥会话；没有 NC_HOME 就返回 None（跳过）。
fn jvm_session() -> Option<nc_forge::db_engine::EngineHandle> {
    let home = std::env::var("NC_HOME")
        .ok()
        .map(std::path::PathBuf::from)
        .filter(|p| p.is_dir());
    let Some(home) = home else {
        println!("[R5] 未设 NC_HOME，跳过");
        return None;
    };
    let bridge = std::sync::Arc::new(nc_forge::db_bridge::Bridge::new(jvm_env(&home)));
    let h = nc_forge::db_engine::EngineHandle::java(bridge, "probe-r5");
    let url = std::env::var("NC_RUST_URL")
        .unwrap_or_else(|_| "jdbc:oracle:thin:@10.200.22.144:1521/aier260824".into());
    let (u, p) = (user(), pass());
    if let Err(e) = h.call(
        "connect",
        &[url.as_str(), u.as_str(), p.as_str(), "false"],
        std::time::Duration::from_secs(30),
    ) {
        println!("[R5] 连不上，跳过：{e}");
        return None;
    }
    Some(h)
}

/// 探针内的 JVM 环境：直接按 NC home 拼，不经过 `AppHandle`（测试里没有 Tauri）。
fn jvm_env(home: &std::path::Path) -> nc_forge::db_bridge::BridgeEnv {
    let jar = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/ncdb/ncdb.jar");
    let driver = nc_forge::db_bridge::find_driver(home)
        .unwrap_or_else(|| panic!("{} 下没有 Oracle 驱动", home.display()));
    nc_forge::db_bridge::env(
        home.join("ufjdk/bin/java.exe"),
        jar,
        driver,
        nc_forge::db_bridge::nc_decrypt_jars(home),
        std::env::temp_dir().join("ncforge-r5-probe"),
    )
}
