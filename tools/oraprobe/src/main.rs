//! B 方案判定探针
//!
//! 用 Oracle 官方纯 Rust thin 驱动 `oracledb 26.0.0-beta.5` 直连 NC 库，
//! 逐项验证它能否替换现在那套 `NcDbBridge.java` + JVM 的方案。
//!
//! 为什么要这个探针：本机（开发机）不在内网，连不上 10.200.22.144，
//! 所以「B 方案行不行」只能在能连库的机器上判定。一次运行会把所有 gate 都测完。
//!
//! 用法：
//!   cargo run --release -- <host:port/service> <user> <password>
//!   例：cargo run --release -- 10.200.22.144:1521/aier260824 aier633 口令
//!
//! 每一项独立，前一项失败不影响后面的（除了连接本身）。
//! 连接阶段单独用 catch_unwind 兜住——11G 密码 verifier 会让驱动 panic 而不是返回错误
//! （oracle/rust-oracledb#63），不兜住整个进程就没了。

use std::panic::{self, AssertUnwindSafe};
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 {
        eprintln!("用法: oraprobe <host:port/service> <user> <password>");
        eprintln!("  例: oraprobe 10.200.22.144:1521/aier260824 aier633 你的口令");
        std::process::exit(2);
    }
    let (target, user, pass) = (&args[1], &args[2], &args[3]);

    println!("═══════════════════════════════════════════════════════════");
    println!(" B 方案判定探针 · oracledb 26.0.0-beta.5（Oracle 官方纯 Rust）");
    println!(" 目标: {target}   用户: {user}");
    println!(" 进程 PID: {}  （要测内存就看这个 PID 的工作集）", std::process::id());
    println!("═══════════════════════════════════════════════════════════");

    // ── Gate 1：能不能连上 ──────────────────────────────────────
    println!("\n【Gate 1】建立连接");
    let cfg = oracledb::Config::default()
        .set_credentials(user, pass)
        .set_connect_string(target.as_str());
    let cfg = match cfg {
        Ok(c) => c,
        Err(e) => {
            println!("  [×] 连接串解析失败: {e}");
            println!("\n结论：连接串格式不被接受，B 方案在这一步就断了。");
            return;
        }
    };

    let t0 = Instant::now();
    let conn = match panic::catch_unwind(AssertUnwindSafe(|| oracledb::connect(cfg))) {
        Ok(Ok(c)) => c,
        Ok(Err(e)) => {
            println!("  [×] 连接失败（{} ms）: {e}", t0.elapsed().as_millis());
            println!("\n结论：连不上。先排除网络/口令/服务名，再谈 B 方案。");
            return;
        }
        Err(_) => {
            println!("  [×] 连接过程中 panic（{} ms）", t0.elapsed().as_millis());
            println!("      ↑ 这是 11G 密码 verifier 撞上 oracle/rust-oracledb#63，");
            println!("        驱动里 AUTH_PBKDF2_VGEN_COUNT 那句 unwrap() 拿到 None。");
            println!("\n结论：B 方案在你们的账号上不可用——不是报错，是进程崩溃。");
            println!("      除非自己打 #63 的补丁并长期维护 fork，否则到此为止。");
            return;
        }
    };
    println!("  [✓] 连接成功（{} ms）", t0.elapsed().as_millis());

    // ── Gate 2：库版本（决定官方支持与否）──────────────────────
    println!("\n【Gate 2】服务器版本（官方只承诺 12/18/19/21/26，不支持 11g）");
    let banner = q1(&conn, "SELECT banner FROM v$version WHERE ROWNUM = 1")
        .or_else(|_| q1(&conn, "SELECT version FROM v$instance"))
        .or_else(|_| {
            q1(
                &conn,
                "SELECT version FROM product_component_version \
                 WHERE product LIKE 'Oracle Database%' AND ROWNUM = 1",
            )
        });
    match banner {
        Ok(v) => {
            println!("  服务器: {v}");
            let v = v.to_lowercase();
            if v.contains("11.") {
                println!("  [×] 11g —— 官方 README 的支持列表里没有 11g，B 方案出局。");
            } else if v.contains("12.") || v.contains("18.") || v.contains("19.")
                || v.contains("21.") || v.contains("23.") || v.contains("26.")
            {
                println!("  [✓] 在官方支持范围内");
            } else {
                println!("  [?] 版本不在已知列表里，需人工判断");
            }
        }
        Err(e) => println!("  [×] 查不到版本（可能权限不足）: {e}"),
    }

    // ── Gate 3：账号的密码 verifier 类型 ───────────────────────
    println!("\n【Gate 3】账号密码 verifier（12C 才走 PBKDF2 分支）");
    match q1(
        &conn,
        "SELECT password_versions FROM user_users WHERE username = USER",
    ) {
        Ok(v) => {
            println!("  password_versions = {v}");
            if v.contains("12C") {
                println!("  [✓] 有 12C verifier，驱动的认证分支能走通");
            } else {
                println!("  [!] 没有 12C verifier —— 本次能连只是运气（可能服务端允许回退）");
            }
        }
        Err(e) => println!("  [?] 查不到（11g 无此列 / 权限不足）: {e}"),
    }

    // ── Gate 4：基本查询与中文 ─────────────────────────────────
    println!("\n【Gate 4】基本查询 / 中文 / 数字精度");
    match conn.query_row("SELECT 1 AS n, '中文测试' AS s FROM dual", &[]) {
        Ok(row) => {
            let n: i64 = row.get(0).unwrap_or(-1);
            let s: String = row.get(1).unwrap_or_default();
            println!("  [{}] n={n} s={s}", if n == 1 && s == "中文测试" { '✓' } else { '×' });
        }
        Err(e) => println!("  [×] {e}"),
    }
    match q1(
        &conn,
        "SELECT TO_CHAR(123456789012345678901234567890.123456789) FROM dual",
    ) {
        Ok(v) => println!("  [✓] 大 NUMBER 精度: {v}"),
        Err(e) => println!("  [×] 大 NUMBER: {e}"),
    }

    // ── Gate 5：CLOB（NC 里大量 CLOB 字段）────────────────────
    println!("\n【Gate 5】CLOB 读取");
    match q1(&conn, "SELECT TO_CLOB('第一章测试内容') FROM dual") {
        Ok(v) => println!("  [✓] CLOB: {v}"),
        Err(e) => println!("  [×] CLOB: {e}"),
    }

    // ── Gate 6：DBMS_OUTPUT（桥里在用，K 组的「输出」标签靠它）──
    println!("\n【Gate 6】DBMS_OUTPUT（需要 OUT 绑定）");
    let enable = conn.execute("BEGIN DBMS_OUTPUT.ENABLE(1000000); END;", &[]);
    match enable {
        Err(e) => println!("  [×] enable 失败: {e}"),
        Ok(_) => {
            let put = conn.execute(
                "BEGIN DBMS_OUTPUT.PUT_LINE('hello from rust'); END;",
                &[],
            );
            if let Err(e) = put {
                println!("  [×] put_line 失败: {e}");
            } else {
                // get_line(line OUT VARCHAR2, status OUT NUMBER)
                let l = String::new();
                let s = String::new();
                match conn.execute(
                    "BEGIN DBMS_OUTPUT.GET_LINE(:1, :2); END;",
                    &[&l as &dyn oracledb::ToDbValue, &s as &dyn oracledb::ToDbValue],
                ) {
                    Ok(mut r) => {
                        let row = r.out_bind_data();
                        let line: String = row.get(0).unwrap_or_default();
                        let status: String = row.get(1).unwrap_or_default();
                        if line.contains("hello from rust") {
                            println!("  [✓] 取回: {line}（status={status}）");
                        } else {
                            println!("  [!] 调通了但没取到内容: line={line:?} status={status:?}");
                        }
                    }
                    Err(e) => println!("  [×] get_line 失败（OUT 绑定不支持）: {e}"),
                }
            }
        }
    }

    // ── Gate 7：REF CURSOR ────────────────────────────────────
    println!("\n【Gate 7】REF CURSOR（PL/SQL 返回结果集）");
    let rc = String::new();
    match conn.execute(
        "BEGIN OPEN :1 FOR SELECT 1 AS n FROM dual; END;",
        &[&rc as &dyn oracledb::ToDbValue],
    ) {
        Ok(mut r) => match r.out_bind_data().get::<oracledb::Cursor>(0) {
            Ok(mut cursor) => match cursor.next() {
                Some(Ok(row)) => {
                    let n: i64 = row.get(0).unwrap_or(-1);
                    println!("  [✓] REF CURSOR 取到 n={n}");
                }
                Some(Err(e)) => println!("  [!] 绑上了但取行失败: {e}"),
                None => println!("  [!] 绑上了但游标为空"),
            },
            Err(e) => println!("  [×] 取游标失败: {e}"),
        },
        Err(e) => println!("  [×] OPEN FOR 失败: {e}"),
    }

    // ── Gate 8：事务 ─────────────────────────────────────────
    println!("\n【Gate 8】事务（默认手动提交）");
    match conn.commit() {
        Ok(_) => println!("  [✓] commit 可用"),
        Err(e) => println!("  [×] commit: {e}"),
    }

    // ── Gate 9：取消能力（待办①，官方没有）────────────────────
    println!("\n【Gate 9】运行中取消（待办①）");
    println!("  [×] 驱动没有 cancel/break API（oracle/rust-oracledb#24 未实现）");
    println!("      现方案（JDBC）有 Statement.cancel()，B 方案反而退化。");
    println!("      官方原话：已知限制，打算随 async API 一起解决，需要不少工作。");

    println!("\n═══════════════════════════════════════════════════════════");
    println!(" 完成。把上面 [×] / [!] 的行发回去即可判定。");

    // 可选：第 5 个参数 = 额外开几个连接（测多连接内存），第 6 个 = 保持秒数
    if let Some(n) = args.get(4).and_then(|s| s.parse::<usize>().ok()) {
        let mut extra = Vec::new();
        for i in 0..n {
            let c = oracledb::Config::default()
                .set_credentials(user, pass)
                .set_connect_string(target.as_str());
            match c.and_then(oracledb::connect) {
                Ok(c) => {
                    let _ = c.execute("SELECT 1 FROM dual", &[]);
                    extra.push(c);
                    println!(" [多连接] 第 {} 个建立成功", i + 2);
                }
                Err(e) => println!(" [多连接] 第 {} 个失败: {e}", i + 2),
            }
        }
        println!(" 共 {} 个连接，PID {} 可供测内存", extra.len() + 1, std::process::id());
    }

    if let Some(hold) = args.get(5) {
        if let Ok(secs) = hold.parse::<u64>() {
            println!(" [保持连接 {secs} 秒]");
            std::thread::sleep(std::time::Duration::from_secs(secs));
        }
    }
    println!("═══════════════════════════════════════════════════════════");
}

/// 取第一行第一列，统一成字符串。
fn q1(conn: &oracledb::Connection, sql: &str) -> Result<String, String> {
    let row = conn.query_row(sql, &[]).map_err(|e| e.to_string())?;
    row.get::<String>(0).map_err(|e| e.to_string())
}
