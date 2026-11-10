//! 数据库连接配置的纯逻辑：id、环境名、`.properties` 解析、旧版单连接配置的迁移。
//!
//! 不碰桥、不碰 IPC，单测能覆盖到的都放这里；命令层（`commands/db_conn_cmds.rs`）只做编排。

use crate::config::{AppConfig, DbConnConfig};

/// 环境标签。只决定颜色与「生产库写前确认」，不限制任何权限。
pub const ENVS: [&str; 4] = ["dev", "test", "prod", "other"];

/// 连接颜色的可选键。**只认这一组**，前端把它们当 `data-color` 枚举映射到样式表。
///
/// 为什么不让用户填任意色值：这个值会写进 `data-color` 并进入渲染路径，一旦允许
/// 自由文本就等于让配置决定样式，拼错时整行变透明或串到别处。用固定枚举，
/// 加颜色就改这一处 + 样式表，绕不过门禁里的裸色值检查。
pub const CONN_COLORS: [&str; 7] = ["red", "orange", "amber", "green", "blue", "purple", "gray"];

/// 颜色键的规范化：不认识的一律落空串（= 不标记），不报错——
/// 手改配置写错一个词不该让整条连接存不下来。
pub fn normalize_color(color: &str) -> String {
    let c = color.trim().to_lowercase();
    if CONN_COLORS.contains(&c.as_str()) {
        c
    } else {
        String::new()
    }
}

/// 分组名：去首尾空白、压缩内部连续空白。空串 = 未分组。
///
/// 不做大小写归一：中文分组名不受影响，而 `Prod` / `prod` 被强行合并反而会让
/// 用户改过的名字突然变形。分组是显示用的，两个名字就是两个组。
pub fn normalize_group(group: &str) -> String {
    group.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 保活间隔的下限（秒）。比这更密只是在审计日志里刷屏，换不来更多安全性。
pub const KEEP_ALIVE_MIN: u32 = 30;
/// 保活间隔的上限（秒）。一小时才 ping 一次的会话基本已经死了，再留着这个选项只会误导。
pub const KEEP_ALIVE_MAX: u32 = 3600;
/// 保活间隔的默认值（秒）。**不是 0**：见 `DbConnConfig::keep_alive_sec` 的注释。
pub const KEEP_ALIVE_DEFAULT: u32 = 240;

/// 保活间隔的规范化：`0` = 关（保留），其余夹在 [`KEEP_ALIVE_MIN`]～[`KEEP_ALIVE_MAX`]。
///
/// 夹边而不是报错：这个值既可能来自下拉框，也可能来自手改的 config.json。
/// 手写 `5` 想要「5 秒一次」是误解，静默改成 30 秒比让整条连接存不下来合理得多。
pub fn normalize_keep_alive(sec: u32) -> u32 {
    if sec == 0 {
        0
    } else {
        sec.clamp(KEEP_ALIVE_MIN, KEEP_ALIVE_MAX)
    }
}

/// 去掉注释与空白之后还有没有内容。
///
/// 纯注释的一段不能当语句发出去：Oracle 收到 `/* 尾巴; */` 会报「无效 SQL 语句」，
/// 而用户只是写了个注解。注释里出现分号时恰好会切出这种一段。
fn has_code(sql: &str) -> bool {
    let cs: Vec<char> = sql.chars().collect();
    let mut i = 0;
    while i < cs.len() {
        let c = cs[i];
        if c == '-' && cs.get(i + 1) == Some(&'-') {
            while i < cs.len() && cs[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if c == '/' && cs.get(i + 1) == Some(&'*') {
            i += 2;
            while i < cs.len() && !(cs[i] == '*' && cs.get(i + 1) == Some(&'/')) {
                i += 1;
            }
            i += 2;
            continue;
        }
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        return true;
    }
    false
}

/// 启动脚本的切分：按**分号**切成一条条语句，认字符串 / 注释 / `BEGIN…END;` 块。
///
/// 为什么不按行切：`ALTER SESSION` 常写成一行一句，但 PL/SQL 块、以及把参数写在
/// 下一行续着的写法都存在；按行切会把一个合法语句劈成两半，然后报一条与用户输入
/// 毫无关系的语法错误。
///
/// 与前端 `lib/sqlSplit.ts` 的口径一致的地方：PL/SQL 块**保留**结尾的 `;`（Oracle
/// 要求 `END;` 在语句里），普通语句去掉结尾的 `;`（JDBC 收到会报 ORA-00911）。
/// 不一致的地方：不认 `CREATE OR REPLACE PROCEDURE` / `CREATE TRIGGER` 这类
/// 「建对象」脚本——启动脚本不是建对象的场合，撞上了会按分号切开并让数据库报错，
/// 比猜错边界后静默执行半条更安全。
pub fn split_init_sql(text: &str) -> Vec<String> {
    let cs: Vec<char> = text.chars().collect();
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut line_comment = false;
    let mut block_comment = false;
    // 本条是不是 PL/SQL 块（首词是 begin / declare）：是的话分号只在 END 之后才算终结
    let mut plsql = false;
    let mut head_done = false;
    let mut word = String::new();
    let mut last = String::new();
    let mut prev = String::new();
    let mut i = 0;
    while i < cs.len() {
        let c = cs[i];
        if line_comment {
            cur.push(c);
            if c == '\n' {
                line_comment = false;
            }
            i += 1;
            continue;
        }
        if block_comment {
            cur.push(c);
            if c == '*' && cs.get(i + 1) == Some(&'/') {
                cur.push('/');
                block_comment = false;
                i += 2;
                continue;
            }
            i += 1;
            continue;
        }
        if let Some(q) = quote {
            cur.push(c);
            if c == q {
                // `''` / `""` 是转义，不结束字面量
                if cs.get(i + 1) == Some(&q) {
                    cur.push(q);
                    i += 2;
                    continue;
                }
                quote = None;
            }
            i += 1;
            continue;
        }
        if c == '-' && cs.get(i + 1) == Some(&'-') {
            line_comment = true;
            cur.push_str("--");
            i += 2;
            continue;
        }
        if c == '/' && cs.get(i + 1) == Some(&'*') {
            block_comment = true;
            cur.push_str("/*");
            i += 2;
            continue;
        }
        if c == '\'' || c == '"' {
            quote = Some(c);
            cur.push(c);
            i += 1;
            continue;
        }
        if c == ';' {
            // `END;` 的 `end` 还没从 word 落到 last，先冲刷一次再判
            if !word.is_empty() {
                prev = std::mem::replace(&mut last, std::mem::take(&mut word));
            }
            let block_end = plsql && (last == "end" || prev == "end");
            if plsql && !block_end {
                cur.push(c);
                i += 1;
                continue;
            }
            let body = cur.trim();
            if !body.is_empty() && has_code(body) {
                // PL/SQL 块的结尾分号是语法的一部分，必须留着
                out.push(if plsql {
                    format!("{body};")
                } else {
                    body.to_string()
                });
            }
            cur.clear();
            plsql = false;
            head_done = false;
            last.clear();
            prev.clear();
            i += 1;
            continue;
        }
        if c.is_alphanumeric() || matches!(c, '_' | '$' | '#') {
            word.push(c.to_ascii_lowercase());
            cur.push(c);
            i += 1;
            continue;
        }
        if !word.is_empty() {
            if !head_done {
                plsql = word == "begin" || word == "declare";
                head_done = true;
            }
            prev = std::mem::replace(&mut last, std::mem::take(&mut word));
        }
        cur.push(c);
        i += 1;
    }
    if !word.is_empty() {
        prev = std::mem::replace(&mut last, std::mem::take(&mut word));
    }
    // 末尾没有分号也算一条：用户少写一个分号不该让整段脚本静默丢掉
    let body = cur.trim();
    if !body.is_empty() && has_code(body) {
        out.push(if plsql && (last == "end" || prev == "end") {
            format!("{body};")
        } else {
            body.to_string()
        });
    }
    out
}

/// 不认识的环境名一律归「其他」，免得手改配置写错后界面拿不到颜色。
pub fn normalize_env(env: &str) -> String {
    let e = env.trim().to_lowercase();
    if ENVS.contains(&e.as_str()) {
        e
    } else {
        "other".to_string()
    }
}

/// 新连接的 id：毫秒时间戳 + 进程内序号，同一毫秒连点两次也不撞。
pub fn new_id() -> String {
    use std::sync::atomic::{AtomicU32, Ordering};
    static SEQ: AtomicU32 = AtomicU32::new(0);
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("c{ms:x}{:x}", SEQ.fetch_add(1, Ordering::Relaxed))
}

/// 由连接串取一个默认名：`jdbc:oracle:thin:@10.200.22.144:1521/aier260824` → `aier260824`。
pub fn default_name(url: &str) -> String {
    let tail = url.rsplit(['/', ':']).next().unwrap_or("").trim();
    if tail.is_empty() {
        "未命名连接".to_string()
    } else {
        tail.to_string()
    }
}

/// 同一个库同一个账号算重复（导入 prop.xml 时据此标「已添加」）。
pub fn same_target(a_url: &str, a_user: &str, b_url: &str, b_user: &str) -> bool {
    a_url.trim().eq_ignore_ascii_case(b_url.trim())
        && a_user.trim().eq_ignore_ascii_case(b_user.trim())
}

/// 默认 schema 名的规范化：去空白、转大写（Oracle 里不带引号的标识符一律大写）。
///
/// 不做合法性修补（不删字符、不截断）：改名字不如让 `valid_schema` 明确报错，
/// 否则用户以为设上了 `aier633`，实际存的是别的东西。
pub fn normalize_schema(s: &str) -> String {
    s.trim().to_ascii_uppercase()
}

/// schema 名能不能直接拼进 `alter session set current_schema = …`。
///
/// **这个名字绑不进绑定变量**（`alter session` 的标识符位置不接受占位符），只能拼串，
/// 所以必须只认 Oracle 标识符的字符集：字母开头，其余为字母 / 数字 / `_$#`，最长 128
/// （12.2 之后的上限；11g 的上限 30 更严，这里按宽的放，超长由数据库自己报错）。
/// 允许 `$` `#` 是因为 NC 库里真有 `NC$…` 这类对象名。
pub fn valid_schema(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 128
        && b[0].is_ascii_alphabetic()
        && b.iter()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'$' | b'#'))
}

/// 解析 `.properties`：认 `url` / `user` / `pwd`（与 nc-db 工具 `ncdb.sh --conf` 同格式），
/// 口令键也认 `password`。返回 `(url, user, 口令)`。
///
/// 只做 properties 格式里会真用到的部分：`=` 或 `:` 分隔、`#` `!` 注释、
/// `\:` `\=` `\\` 转义。JDBC URL 里的冒号常被写成 `\:`，不还原就连不上。
pub fn parse_properties(text: &str) -> Result<(String, String, String), String> {
    let mut url = None;
    let mut user = None;
    let mut pwd = None;
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with('!') {
            continue;
        }
        let Some(pos) = split_pos(line) else {
            continue;
        };
        let key = unescape(line[..pos].trim()).to_lowercase();
        let value = unescape(line[pos + 1..].trim());
        match key.as_str() {
            "url" => url = Some(value),
            "user" | "username" => user = Some(value),
            "pwd" | "password" => pwd = Some(value),
            _ => {}
        }
    }
    let url = url
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "文件里没有 url".to_string())?;
    Ok((url, user.unwrap_or_default(), pwd.unwrap_or_default()))
}

/// 第一个未转义的 `=` 或 `:`。
fn split_pos(line: &str) -> Option<usize> {
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 2,
            b'=' | b':' => return Some(i),
            _ => i += 1,
        }
    }
    None
}

fn unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars();
    while let Some(c) = it.next() {
        if c == '\\' {
            if let Some(n) = it.next() {
                out.push(match n {
                    't' => '\t',
                    'n' => '\n',
                    other => other,
                });
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// 旧版只有一套 `db_url / db_user / db_password_dpapi`：首次打开新数据库页时迁成一条手动连接。
/// 返回是否迁了。旧字段保留不删（字段只增不改，降级回老版本还能用）。
pub fn migrate_legacy(cfg: &mut AppConfig) -> bool {
    let Some(url) = cfg.db_url.clone().filter(|s| !s.trim().is_empty()) else {
        return false;
    };
    let user = cfg.db_user.clone().unwrap_or_default();
    if cfg
        .db_conns
        .iter()
        .any(|c| same_target(&c.url, &c.user, &url, &user))
    {
        return false;
    }
    cfg.db_conns.push(DbConnConfig {
        id: new_id(),
        name: default_name(&url),
        env: "test".to_string(),
        source: "manual".to_string(),
        url,
        user,
        prop_ds: None,
        password_dpapi: cfg.db_password_dpapi.clone(),
        auto_commit: false,
        engine: String::new(),
        note: "旧版配置迁移".to_string(),
        default_schema: String::new(),
        no_stmt_cache: false,
        group: String::new(),
        color: String::new(),
        keep_alive_sec: KEEP_ALIVE_DEFAULT,
        init_sql: String::new(),
    });
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 环境名不认识就归其他() {
        assert_eq!(normalize_env(" PROD "), "prod");
        assert_eq!(normalize_env("生产"), "other");
    }

    #[test]
    fn 默认名取服务名或_sid() {
        assert_eq!(
            default_name("jdbc:oracle:thin:@10.200.22.144:1521/aier260824"),
            "aier260824"
        );
        assert_eq!(default_name("jdbc:oracle:thin:@h:1521:orcl"), "orcl");
        assert_eq!(default_name(""), "未命名连接");
    }

    #[test]
    fn properties_认转义与注释() {
        let text = "# 老测试库\nurl=jdbc\\:oracle\\:thin\\:@10.200.23.50\\:1521/aier0910\nuser : aier633\npassword=a\\=b\n";
        let (url, user, pwd) = parse_properties(text).unwrap();
        assert_eq!(url, "jdbc:oracle:thin:@10.200.23.50:1521/aier0910");
        assert_eq!(user, "aier633");
        assert_eq!(pwd, "a=b");
    }

    #[test]
    fn properties_缺_url_要报错() {
        assert!(parse_properties("user=a\npwd=b").is_err());
    }

    #[test]
    fn 旧配置只迁一次() {
        let mut cfg = AppConfig {
            db_url: Some("jdbc:oracle:thin:@h:1521/svc".into()),
            db_user: Some("u".into()),
            db_password_dpapi: Some("x".into()),
            ..Default::default()
        };
        assert!(migrate_legacy(&mut cfg));
        assert!(!migrate_legacy(&mut cfg), "同一个库不能迁两次");
        assert_eq!(cfg.db_conns.len(), 1);
        assert_eq!(cfg.db_conns[0].password_dpapi.as_deref(), Some("x"));
        assert_eq!(cfg.db_conns[0].name, "svc");
    }

    #[test]
    fn 没有旧配置不迁() {
        let mut cfg = AppConfig::default();
        assert!(!migrate_legacy(&mut cfg));
        assert!(cfg.db_conns.is_empty());
    }

    #[test]
    fn id_不重复() {
        assert_ne!(new_id(), new_id());
    }

    /// schema 名会被拼进 `alter session set current_schema = …`（标识符位置不接受绑定
    /// 变量），所以字符集必须卡死：放过一个分号就等于放开了任意 SQL。
    #[test]
    fn schema_名只认_oracle_标识符() {
        assert!(valid_schema("AIER633"));
        assert!(valid_schema("NC$DEV"));
        assert!(valid_schema("A_1#B"));
        assert!(!valid_schema(""));
        assert!(!valid_schema("1AIER"), "不能数字开头");
        assert!(!valid_schema("AIER 633"), "不能有空格");
        assert!(!valid_schema("x; drop table t"));
        assert!(!valid_schema("A.B"), "带点是另一条路径，这里不收");
        assert!(!valid_schema(&"A".repeat(129)), "超过 128 个字符");
        assert!(valid_schema(&"A".repeat(128)));
    }

    /// 规范化只做去空白 + 转大写：Oracle 里不带引号的标识符一律大写。
    /// 不修补非法字符——让 `valid_schema` 明确报错，而不是把 `aie r` 悄悄改成 `AIER`。
    #[test]
    fn schema_名统一大写并去空白() {
        assert_eq!(normalize_schema(" aier633 "), "AIER633");
        assert_eq!(normalize_schema(""), "");
        assert_eq!(normalize_schema("aie r"), "AIE R");
    }

    /// 颜色只认白名单：这个值会进前端的 `data-color`，放行任意字符串等于让配置决定样式。
    /// 认不出的一律落空串（= 不标记），不报错——手改配置写错一个词不该让连接存不下来。
    #[test]
    fn 颜色只认白名单其余落空() {
        assert_eq!(normalize_color("red"), "red");
        assert_eq!(normalize_color("  PURPLE "), "purple");
        assert_eq!(normalize_color("#ff0000"), "");
        assert_eq!(normalize_color("red; background:url(x)"), "");
        assert_eq!(normalize_color(""), "");
        assert_eq!(CONN_COLORS.len(), 7);
    }

    /// 分组名去首尾、压内部连续空白；不做大小写归一（中文名不受影响，
    /// 而把 `Prod` 合并成 `prod` 会让用户刚改的名字突然变形）。
    #[test]
    fn 分组名压缩空白但保留大小写() {
        assert_eq!(normalize_group("  客户 A   生产 "), "客户 A 生产");
        assert_eq!(normalize_group("Prod  "), "Prod");
        assert_eq!(normalize_group(""), "");
    }

    /// 保活间隔：0 保留为「关」，其余夹到 30～3600 秒。
    /// 手写 `5` 想要「5 秒一次」是误解，静默改成 30 比让整条连接存不下来合理。
    #[test]
    fn 保活间隔零保留其余夹边() {
        assert_eq!(normalize_keep_alive(0), 0);
        assert_eq!(normalize_keep_alive(5), KEEP_ALIVE_MIN);
        assert_eq!(normalize_keep_alive(240), 240);
        assert_eq!(normalize_keep_alive(86_400), KEEP_ALIVE_MAX);
    }

    /// 启动脚本按分号切，认字符串、注释与 `BEGIN…END;` 块。
    /// PL/SQL 块**保留**结尾分号（Oracle 要求 `END;`），普通语句去掉
    /// （JDBC 收到尾分号会报 ORA-00911）。
    #[test]
    fn 启动脚本按分号切且认字符串与块() {
        assert_eq!(
            split_init_sql("alter session set nls_date_format='YYYY-MM-DD HH24:MI:SS'"),
            ["alter session set nls_date_format='YYYY-MM-DD HH24:MI:SS'"]
        );
        assert_eq!(
            split_init_sql("alter session set nls_date_format='A;B';\nselect 1 from dual;"),
            [
                "alter session set nls_date_format='A;B'",
                "select 1 from dual"
            ]
        );
        // 注释里的分号不切
        assert_eq!(
            split_init_sql("-- 一句说明；带分号\nselect 1 from dual;\n/* 尾巴; */"),
            ["-- 一句说明；带分号\nselect 1 from dual"]
        );
        // PL/SQL 块整体的结尾分号要留着，块内的分号不能切
        assert_eq!(
            split_init_sql(
                "begin\n  null;\n  execute immediate 'alter session set nls_sort=binary';\nend;"
            ),
            ["begin\n  null;\n  execute immediate 'alter session set nls_sort=binary';\nend;"]
        );
        // 末尾漏了分号也算一条；空串/纯空白切不出东西
        assert_eq!(split_init_sql("select 1 from dual"), ["select 1 from dual"]);
        assert!(split_init_sql("  \n\t ").is_empty());
        assert!(split_init_sql(";;").is_empty());
    }
}
