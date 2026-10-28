//! SVN 凭据：读用户已有的缓存、用 DPAPI 加解密、以及自己那份的落盘。
//!
//! 背景（都是本机实测来的）：
//! - Eclipse / 命令行 svn 把账号存在 `%APPDATA%\Subversion\auth\svn.simple\<hash>`，
//!   文件是 `K <len>` / 键 / `V <len>` / 值 / … / `END` 的纯文本格式，密码字段的
//!   `passtype` 通常是 `wincrypt`——即 Windows DPAPI（当前用户）加密后的 base64。
//! - **那个缓存里可能只有用户名没有密码**：Eclipse 关掉「保存密码」时就是这样，
//!   此时只能让用户输一次，之后我们自己存。
//! - DPAPI 只能由**同一用户**解开，换机器/换用户必然失败，所以永远要能回退到「让用户输」。
//!
//! 不做的事：不试 JNA（Eclipse 自带那份是 32 位，我们的 JVM 是 64 位），
//! 不把密码写进日志、不放进错误信息、不随补丁包外发。

use std::path::{Path, PathBuf};

/// SVN 缓存里的一条认证记录。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AuthRecord {
    /// 服务器给的 realm 串，如 `<http://10.200.22.231:996> VisualSVN Server`。
    pub realm: String,
    pub username: Option<String>,
    /// `passtype` + 密码密文。`passtype` 不是 `wincrypt` 时不尝试解密（本机只会是它）。
    pub password: Option<Vec<u8>>,
    pub passtype: Option<String>,
}

/// 解析一个 svn.simple 认证文件。格式非法（缺 END / 长度对不上）时返回 `None`。
///
/// 长度字段不校验字节数——SVN 自己写的时候按值字节数写，但中文/特殊字符会让
/// 「字符数」与「字节数」不一致；这里按行读值，长度只当参考，不拿来切片。
pub fn parse_auth_file(text: &str) -> Option<AuthRecord> {
    let mut lines = text.lines();
    let mut rec = AuthRecord::default();
    let mut saw_end = false;
    while let Some(line) = lines.next() {
        let line = line.trim_end_matches('\r');
        if line == "END" {
            saw_end = true;
            break;
        }
        if !line.starts_with("K ") {
            return None;
        }
        let key = lines.next()?.to_string();
        let vtag = lines.next()?;
        if !vtag.trim_end_matches('\r').starts_with("V ") {
            return None;
        }
        let value = lines.next()?.trim_end_matches('\r').to_string();
        match key.as_str() {
            "svn:realmstring" => rec.realm = value,
            "username" => rec.username = Some(value),
            "passtype" => rec.passtype = Some(value),
            "password" => rec.password = Some(value.into_bytes()),
            _ => {}
        }
    }
    if !saw_end {
        return None;
    }
    Some(rec)
}

/// 用户的 Subversion 认证缓存目录。
pub fn user_auth_dir() -> Option<PathBuf> {
    let appdata = std::env::var_os("APPDATA")?;
    let dir = PathBuf::from(appdata)
        .join("Subversion")
        .join("auth")
        .join("svn.simple");
    dir.is_dir().then_some(dir)
}

/// 在缓存里找一条 realm 含 `host_hint` 的记录。
///
/// 同一台机器可能有多个 SVN 服务器（本机就有一条 `svn://10.201.17.8` 的旧记录），
/// 所以必须按 host 过滤，不能「取第一条」——取错就是拿着别人的账号去连另一台服务器。
pub fn find_cached(auth_dir: &Path, host_hint: &str) -> Option<AuthRecord> {
    let entries = std::fs::read_dir(auth_dir).ok()?;
    let mut best: Option<AuthRecord> = None;
    for e in entries.flatten() {
        let text = match std::fs::read(e.path()) {
            Ok(b) => String::from_utf8_lossy(&b).to_string(),
            Err(_) => continue,
        };
        let rec = match parse_auth_file(&text) {
            Some(r) => r,
            None => continue,
        };
        if !rec.realm.contains(host_hint) {
            continue;
        }
        // 有密码的那条优先（可能是后来 Eclipse 又存了一次）
        let better = best
            .as_ref()
            .map(|b| b.password.is_none() && rec.password.is_some())
            .unwrap_or(true);
        if better {
            best = Some(rec);
        }
    }
    best
}

/// 从 URL 里取主机（用于匹配 realm）。解析失败返回空串。
pub fn host_of(url: &str) -> String {
    let rest = url.split("://").nth(1).unwrap_or("");
    let authority = rest.split('/').next().unwrap_or("");
    let host = authority.rsplit('@').next().unwrap_or(authority);
    host.split(':').next().unwrap_or("").to_string()
}

// ───────────────────────── DPAPI ─────────────────────────

#[cfg(windows)]
mod dpapi {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB,
    };

    fn blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        }
    }

    /// 解密：输入是 DPAPI 密文（svn.simple 里 `password` 字段的 base64 解开后的字节）。
    pub fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
        unsafe {
            let input = blob(data);
            let mut out = CRYPT_INTEGER_BLOB::default();
            CryptUnprotectData(&input, None, None, None, None, 0, &mut out)
                .map_err(|e| format!("DPAPI 解密失败（凭据可能不是本机/本用户加密的）: {e}"))?;
            let bytes = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
            let _ = LocalFree(HLOCAL(out.pbData as _));
            Ok(bytes)
        }
    }

    /// 加密：我们自己保存密码时用，落盘的密文只能由当前用户解开。
    pub fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
        unsafe {
            let input = blob(data);
            let mut out = CRYPT_INTEGER_BLOB::default();
            CryptProtectData(&input, None, None, None, None, 0, &mut out)
                .map_err(|e| format!("DPAPI 加密失败: {e}"))?;
            let bytes = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
            let _ = LocalFree(HLOCAL(out.pbData as _));
            Ok(bytes)
        }
    }
}

#[cfg(windows)]
pub use dpapi::{protect as dpapi_protect, unprotect as dpapi_unprotect};

#[cfg(not(windows))]
pub fn dpapi_unprotect(_data: &[u8]) -> Result<Vec<u8>, String> {
    Err("DPAPI 只在 Windows 上可用".to_string())
}

#[cfg(not(windows))]
pub fn dpapi_protect(_data: &[u8]) -> Result<Vec<u8>, String> {
    Err("DPAPI 只在 Windows 上可用".to_string())
}

/// base64 解码（认证文件里的密文是 base64）。自己写，省一个依赖。
pub fn b64_decode(s: &str) -> Option<Vec<u8>> {
    const INVALID: u8 = 0xFF;
    let mut table = [INVALID; 256];
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    for (i, c) in alphabet.iter().enumerate() {
        table[*c as usize] = i as u8;
    }
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let mut buf: u32 = 0;
    let mut bits = 0;
    for c in s.bytes() {
        if c == b'=' || c == b'\n' || c == b'\r' || c == b' ' {
            continue;
        }
        let v = table[c as usize];
        if v == INVALID {
            return None;
        }
        buf = (buf << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Some(out)
}

pub fn b64_encode(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "K 8\npasstype\nV 8\nwincrypt\nK 8\npassword\nV 12\nQUJDREVGR0g=\nK 15\nsvn:realmstring\nV 43\n<http://10.200.22.231:996> VisualSVN Server\nK 8\nusername\nV 3\nlzl\nEND\n";

    #[test]
    fn 解析认证文件() {
        let r = parse_auth_file(SAMPLE).expect("应能解析");
        assert_eq!(r.username.as_deref(), Some("lzl"));
        assert_eq!(r.passtype.as_deref(), Some("wincrypt"));
        assert_eq!(r.password.as_deref(), Some("QUJDREVGR0g=".as_bytes()));
        assert!(r.realm.contains("10.200.22.231"));
    }

    #[test]
    fn 只有用户名没有密码也算合法() {
        let only_user = "K 15\nsvn:realmstring\nV 43\n<http://h> r\nK 8\nusername\nV 3\nlzl\nEND\n";
        let r = parse_auth_file(only_user).expect("应能解析");
        assert_eq!(r.username.as_deref(), Some("lzl"));
        assert!(r.password.is_none());
    }

    #[test]
    fn 缺_end_的文件不算() {
        let broken = "K 8\nusername\nV 3\nlzl\n";
        assert!(parse_auth_file(broken).is_none());
    }

    #[test]
    fn 主机名从_url_里取() {
        assert_eq!(
            host_of("http://10.200.22.231:996/svn/SCM/ar"),
            "10.200.22.231"
        );
        assert_eq!(host_of("https://user@svn.corp/svn/x"), "svn.corp");
        assert_eq!(host_of("乱写的"), "");
    }

    #[test]
    fn base64_往返() {
        for case in ["", "a", "ab", "abc", "abcd", "中文密码"] {
            let enc = b64_encode(case.as_bytes());
            let dec = b64_decode(&enc).expect("应能解码");
            assert_eq!(String::from_utf8(dec).unwrap(), case);
        }
        assert!(b64_decode("!!!!").is_none());
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_加密后能解回来() {
        let secret = b"p@ss word";
        let enc = dpapi_protect(secret).expect("加密应成功");
        assert_ne!(enc, secret.to_vec());
        let dec = dpapi_unprotect(&enc).expect("解密应成功");
        assert_eq!(dec, secret.to_vec());
    }
}
