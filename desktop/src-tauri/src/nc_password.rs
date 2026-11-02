//! NC 操作员密码哈希与「重置密码」SQL 的生成（**只生成，不执行**）。
//!
//! 两套方案按版本分，前缀就是库里密文的开头，可以互相验证：
//!
//! - NC65 / NC6.x：`U_U++--V` + 小写十六进制 `MD5(cuserid || 密码)`
//! - NCC / NC Cloud：`S_S++` + 标准 Base64 的 `SHA-256(cuserid || 密码)`
//!
//! 已知向量（与公开资料里的例子逐字节一致，单测钉住）：
//! `100112100000000010B4` + `nc@123` → `U_U++--V05ea3e38…d3027`；
//! `1001N31000000000000B` + `nc@123` → `S_S++IP3Ne7ro…JWU=`。
//!
//! 字节口径是 UTF-8。ASCII 临时密码与服务端字符集无关；含中文的密码在服务端
//! 用平台默认字符集（常见 GBK）校验时可能对不上，界面上要提示这一点。
//!
//! 这个模块**不发 SQL 给数据库**：只拼出文本，由用户自己复制或保存后执行。

use base64::Engine as _;
// md-5 0.11 与 sha2 0.10 各自依赖不同版本的 digest：两个 Digest trait 分别引入，
// 调用处用完全限定写法，避免方法解析撞在一起。
use md5::{Digest as Md5Digest, Md5};
use sha2::{Digest as Sha2Digest, Sha256};

pub const NC65_PREFIX: &str = "U_U++--V";
pub const NCC_PREFIX: &str = "S_S++";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scheme {
    Nc65,
    Ncc,
}

impl Scheme {
    pub fn parse(s: &str) -> Result<Self, String> {
        match s.trim() {
            "nc65" | "NC65" | NC65_PREFIX => Ok(Self::Nc65),
            "ncc" | "NCC" | NCC_PREFIX => Ok(Self::Ncc),
            other => Err(format!("未知密码方案：{other}（只支持 nc65 / ncc）")),
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Self::Nc65 => "nc65",
            Self::Ncc => "ncc",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Nc65 => "NC65（U_U++--V + MD5）",
            Self::Ncc => "NCC（S_S++ + Base64(SHA-256)）",
        }
    }

    /// 从库里现有密文的前缀认出方案（用户列表用来给默认值）。
    pub fn from_hash_head(head: &str) -> Option<Self> {
        let h = head.trim();
        if h.starts_with(NC65_PREFIX) {
            Some(Self::Nc65)
        } else if h.starts_with(NCC_PREFIX) {
            Some(Self::Ncc)
        } else {
            None
        }
    }
}

/// 生成写进 `user_password` 的密文。
pub fn encoded_password(scheme: Scheme, cuserid: &str, plaintext: &str) -> String {
    let seed = format!("{cuserid}{plaintext}");
    match scheme {
        Scheme::Nc65 => {
            let digest = <Md5 as Md5Digest>::digest(seed.as_bytes());
            format!("{NC65_PREFIX}{}", hex_lower(digest.as_slice()))
        }
        Scheme::Ncc => {
            let digest = <Sha256 as Sha2Digest>::digest(seed.as_bytes());
            format!(
                "{NCC_PREFIX}{}",
                base64::engine::general_purpose::STANDARD.encode(digest.as_slice())
            )
        }
    }
}

#[derive(Debug, Clone)]
pub struct ResetUser {
    pub cuserid: String,
    pub user_code: String,
}

/// 拼重置脚本：每个用户一条 `update`，最后一条 `commit;`。
///
/// 密码明文不进脚本（只进哈希），所以脚本可以安全地存盘 / 发给同事执行。
pub fn reset_sql(
    scheme: Scheme,
    users: &[ResetUser],
    plaintext: &str,
    stamp: &str,
) -> Result<String, String> {
    if plaintext.is_empty() {
        return Err("新密码不能为空".to_string());
    }
    if users.is_empty() {
        return Err("先选至少一个操作员".to_string());
    }
    let mut out = String::new();
    out.push_str(&format!(
        "-- {} 操作员密码重置（{} 个用户）\n",
        scheme.label(),
        users.len()
    ));
    out.push_str(&format!("-- 生成时间：{}\n", comment_safe(stamp)));
    out.push_str("-- 只改 sm_user.user_password；账号被锁定的要另行处理 sm_user_ex 的锁定记录。\n");
    out.push_str("-- 本工具不会执行这条脚本，请确认目标库后手动运行。\n\n");
    for u in users {
        let id = u.cuserid.trim();
        if id.is_empty() {
            return Err("有个操作员缺少 cuserid，定位不到要改哪一行".to_string());
        }
        out.push_str(&format!(
            "-- {}（cuserid={}）\n",
            comment_safe(&u.user_code),
            id
        ));
        out.push_str(&format!(
            "update sm_user set user_password = '{}' where cuserid = '{}';\n\n",
            encoded_password(scheme, id, plaintext),
            sql_literal(id)
        ));
    }
    out.push_str("commit;\n");
    Ok(out)
}

/// 用户列表查询：按账号 / 姓名过滤，最多 `limit` 行（`rownum` 截断，不产生 `more` 游标）。
///
/// 只取密文前 8 个字符：够认出方案（`U_U++--V` 正好 8 位），又不把哈希带回界面。
pub fn user_list_sql(filter: &str, limit: usize) -> String {
    let cond = filter.trim();
    let where_clause = if cond.is_empty() {
        String::new()
    } else {
        let pat = like_literal(cond);
        format!(
            "where user_code like '%{pat}%' escape '\\' or user_name like '%{pat}%' escape '\\'"
        )
    };
    format!(
        "select * from (select cuserid, user_code, user_name, enablestate, \
         substr(user_password, 1, 8) as pwd_head from sm_user {where_clause} \
         order by user_code) where rownum <= {limit}"
    )
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

/// 注释里不能有换行：换个行就能把后面的 SQL 顶出注释范围。
fn comment_safe(s: &str) -> String {
    let one = s.replace(['\r', '\n'], " ");
    let t = one.trim();
    if t.chars().count() > 80 {
        format!("{}…", t.chars().take(80).collect::<String>())
    } else {
        t.to_string()
    }
}

fn sql_literal(s: &str) -> String {
    s.replace('\'', "''")
}

/// LIKE 里的 `%` / `_` / 反斜杠按字面量处理（与 `escape '\'` 配对）。
fn like_literal(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('\'', "''")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 公开资料里的例子：NC65、cuserid + nc@123。
    #[test]
    fn nc65_已知向量() {
        assert_eq!(
            encoded_password(Scheme::Nc65, "100112100000000010B4", "nc@123"),
            "U_U++--V05ea3e38a4ecf81e6bb827fb242d3027"
        );
    }

    /// 公开资料里的例子：NCC、cuserid + nc@123。
    #[test]
    fn ncc_已知向量() {
        assert_eq!(
            encoded_password(Scheme::Ncc, "1001N31000000000000B", "nc@123"),
            "S_S++IP3Ne7rodHjjIUDGhl9bD0yjAkHMy/kb0oPe0cRuJWU="
        );
    }

    #[test]
    fn 密码相同但用户不同密文不同() {
        let a = encoded_password(Scheme::Nc65, "1001A", "abc123");
        let b = encoded_password(Scheme::Nc65, "1001B", "abc123");
        assert_ne!(a, b);
        assert!(a.starts_with(NC65_PREFIX) && a.len() == NC65_PREFIX.len() + 32);
    }

    #[test]
    fn 方案解析与从密文前缀识别() {
        assert_eq!(Scheme::parse("nc65").unwrap(), Scheme::Nc65);
        assert_eq!(Scheme::parse("S_S++").unwrap(), Scheme::Ncc);
        assert!(Scheme::parse("sha1").is_err());
        assert_eq!(Scheme::from_hash_head("U_U++--V05ea3e"), Some(Scheme::Nc65));
        assert_eq!(Scheme::from_hash_head("S_S++IP3Ne7ro"), Some(Scheme::Ncc));
        assert_eq!(Scheme::from_hash_head(""), None);
    }

    #[test]
    fn 重置脚本一个用户一条且明文不落盘() {
        let users = vec![
            ResetUser {
                cuserid: "1001A".into(),
                user_code: "admin".into(),
            },
            ResetUser {
                cuserid: "1001B".into(),
                user_code: "zhangsan".into(),
            },
        ];
        let sql = reset_sql(Scheme::Nc65, &users, "Temp#2026", "2026-11-02 10:00").unwrap();
        assert_eq!(sql.matches("update sm_user set user_password").count(), 2);
        assert!(sql.contains("where cuserid = '1001A';"));
        assert!(sql.contains("where cuserid = '1001B';"));
        assert!(sql.contains("-- admin（cuserid=1001A）"));
        assert!(sql.contains("2026-11-02 10:00"));
        assert!(sql.ends_with("commit;\n"));
        // 明文绝不能出现：脚本要能安全地存盘 / 转给别人
        assert!(!sql.contains("Temp#2026"));
        // 密文与单算的一致
        assert!(sql.contains(&encoded_password(Scheme::Nc65, "1001A", "Temp#2026")));
    }

    #[test]
    fn 空密码空用户与未知方案都是人话错误() {
        let u = vec![ResetUser {
            cuserid: "1".into(),
            user_code: "a".into(),
        }];
        assert_eq!(
            reset_sql(Scheme::Nc65, &u, "", "t").unwrap_err(),
            "新密码不能为空"
        );
        assert!(reset_sql(Scheme::Nc65, &[], "x", "t")
            .unwrap_err()
            .contains("至少一个"));
        assert!(Scheme::parse("plain").unwrap_err().contains("未知密码方案"));
    }

    #[test]
    fn 注释里的换行被压平免得顶出注释() {
        let users = vec![ResetUser {
            cuserid: "1' or '1'='1".into(),
            user_code: "a\nmore".into(),
        }];
        let sql = reset_sql(Scheme::Ncc, &users, "x", "t\nb").unwrap();
        assert!(sql.contains("-- a more（cuserid=1' or '1'='1）"));
        assert!(sql.contains("where cuserid = '1'' or ''1''=''1';"));
        assert!(!sql.lines().any(|l| l == "more"));
        assert!(!sql.contains("t\nb"));
    }

    #[test]
    fn 用户列表查询按需加条件并限行() {
        let sql = user_list_sql("", 501);
        assert!(!sql.contains("where user_code"));
        assert!(sql.contains("rownum <= 501"));
        assert!(sql.contains("substr(user_password, 1, 8)"));

        let sql = user_list_sql(" 张 100% ", 501);
        assert!(sql.contains("user_code like '%张 100\\%%' escape '\\'"));
        assert!(sql.contains("user_name like"));
        let sql = user_list_sql("o'neil_x", 501);
        assert!(sql.contains("o''neil\\_x"));
    }
}
