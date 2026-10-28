//! Eclipse 逐文件编码登记：`.settings/org.eclipse.core.resources.prefs`。
//!
//! NC 工程默认编码是 GBK，个别文件在 Eclipse 里被单独登记成 UTF-8。登记行长这样：
//!
//! ```text
//! encoding//gl/src/public/nc/itf/glcom/reckoning/IRefreshPeriodService.java=UTF-8
//! ```
//!
//! `encoding/` 是 Eclipse 的前缀，后面接的是「工作区内绝对路径」，于是出现两个斜杠；
//! 去掉前缀再忽略前导斜杠，剩下的就是相对工作区根的路径。
//!
//! 这里只做一件有用的事：找出「磁盘上是 UTF-8 且含中文，但 Eclipse 会按 GBK 读」的
//! `.java` 文件。这类文件用 Eclipse 编出来的 class 里中文字符串常量是乱码，而工作台
//! 按内容探测编码、产物是对的。不标出来，用户对比两边产物时只会以为是工作台编错了。

use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;

/// 偏好文件相对工作区根的位置。没有它很正常：没在 Eclipse 里改过编码的工程就没有。
pub const PREFS_REL: &str = ".settings/org.eclipse.core.resources.prefs";

/// 超过这个大小的 `.java` 不读：几 MB 的源文件极罕见，为判断编码整份读进来不划算。
const MAX_SCAN_BYTES: u64 = 4 * 1024 * 1024;

/// 逐文件编码登记表。键是「相对工作区根、小写、正斜杠」的路径。
#[derive(Debug, Default, Clone)]
pub struct EncodingRegistry {
    entries: HashMap<String, String>,
}

impl EncodingRegistry {
    /// 读工作区里的偏好文件；读不到（工程没登记过编码）就当空表。
    pub fn load(root: &Path) -> Self {
        let path = root
            .join(".settings")
            .join("org.eclipse.core.resources.prefs");
        match std::fs::read(&path) {
            Ok(bytes) => Self::parse(&String::from_utf8_lossy(&bytes)),
            Err(_) => Self::default(),
        }
    }

    /// 解析偏好文件正文。只认 `encoding/` 开头的键，其余（`eclipse.preferences.version` 等）忽略。
    pub fn parse(text: &str) -> Self {
        let mut entries = HashMap::new();
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let Some((key, value)) = line.split_once('=') else {
                continue;
            };
            // 先把分隔符统一成正斜杠再剥前缀：Eclipse 写的是正斜杠，但手工编辑过的文件里见过反斜杠
            let key = key.trim().replace('\\', "/");
            let Some(rest) = key.strip_prefix("encoding/") else {
                continue;
            };
            let rel = normalize_rel(rest);
            let enc = value.trim();
            if rel.is_empty() || enc.is_empty() {
                continue;
            }
            entries.insert(rel, enc.to_string());
        }
        Self { entries }
    }

    /// 该文件登记的编码；None = 没登记。
    pub fn get(&self, rel: &str) -> Option<&str> {
        self.entries.get(rel).map(String::as_str)
    }

    /// 该文件是否登记为 UTF-8。
    pub fn is_utf8(&self, rel: &str) -> bool {
        self.get(rel)
            .is_some_and(|v| v.eq_ignore_ascii_case("UTF-8"))
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// 返回给前端的标记：文件路径 + 偏好里登记的编码（None = 没登记）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncodingMark {
    pub path: String,
    pub registered: Option<String>,
}

/// 一个需要提示的文件：它是 UTF-8，但 Eclipse 不会按 UTF-8 读。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncodingIssue {
    /// 偏好里登记的编码；None = 没登记，Eclipse 用工程默认（本工程是 GBK）。
    pub registered: Option<String>,
}

/// 判断单个文件要不要标记。四条同时成立才算：
/// 是 `.java`、是合法 UTF-8、含非 ASCII 字节、没有 BOM、偏好里不是 UTF-8。
///
/// 返回 `None` 表示「不用管」，不代表文件坏了。
pub fn check_java(file: &Path, root: &Path, reg: &EncodingRegistry) -> Option<EncodingIssue> {
    if !is_java_source(file) {
        return None;
    }
    let meta = std::fs::metadata(file).ok()?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_SCAN_BYTES {
        return None;
    }
    let bytes = std::fs::read(file).ok()?;
    if !looks_utf8_with_non_ascii(&bytes) {
        return None;
    }
    let rel = rel_key(file, root)?;
    if reg.is_utf8(&rel) {
        return None;
    }
    Some(EncodingIssue {
        registered: reg.get(&rel).map(str::to_string),
    })
}

/// 只看扩展名，用来在扫描前把非 `.java` 的路径整个筛掉。
pub fn is_java_source(path: &Path) -> bool {
    path.extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("java"))
}

/// 合法 UTF-8、有非 ASCII 字节、且没有 BOM。
///
/// 有 BOM 的 UTF-8 不算：Eclipse 认 BOM，会按 UTF-8 读，不会出错。
fn looks_utf8_with_non_ascii(bytes: &[u8]) -> bool {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return false;
    }
    if !bytes.iter().any(|b| *b >= 0x80) {
        return false;
    }
    std::str::from_utf8(bytes).is_ok()
}

/// 相对工作区根的规范化键：小写、正斜杠分隔。Windows 文件系统不区分大小写，键也得跟着不区分。
fn rel_key(file: &Path, root: &Path) -> Option<String> {
    let rel = file.strip_prefix(root).ok()?;
    let mut out = String::new();
    for part in rel.components() {
        let s = part.as_os_str().to_string_lossy().to_lowercase();
        if s.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push('/');
        }
        out.push_str(&s);
    }
    Some(out)
}

fn normalize_rel(raw: &str) -> String {
    raw.replace('\\', "/")
        .trim_start_matches('/')
        .to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::PathBuf;

    const SAMPLE: &str = "\
eclipse.preferences.version=1
encoding//gl/src/client/nc/ui/glcom/reckoning/Step3Model.java=UTF-8
encoding//ic/src/private/nc/bs/ic/m4d/insert/InsertBP.java=GBK
encoding//pu/src/private/nc/bs/pu/aier/service/sign/AierLoadSignPdfBO.java=utf-8
other.key=whatever
";

    #[test]
    fn 解析只留_encoding_开头的键() {
        let reg = EncodingRegistry::parse(SAMPLE);
        assert_eq!(reg.len(), 3);
        assert_eq!(
            reg.get("gl/src/client/nc/ui/glcom/reckoning/step3model.java"),
            Some("UTF-8")
        );
        assert!(reg.is_utf8("pu/src/private/nc/bs/pu/aier/service/sign/aierloadsignpdfbo.java"));
        assert!(!reg.is_utf8("ic/src/private/nc/bs/ic/m4d/insert/insertbp.java"));
        assert!(reg
            .get("ic/src/private/nc/bs/ic/m4d/insert/insertbp.java")
            .is_some());
    }

    #[test]
    fn 值是大小写不敏感的() {
        let reg = EncodingRegistry::parse("encoding//a/B.java=utf-8");
        assert!(reg.is_utf8("a/b.java"));
    }

    #[test]
    fn 反斜杠写的键也能认() {
        let reg = EncodingRegistry::parse(r"encoding\\a\b\C.java=UTF-8");
        assert!(reg.is_utf8("a/b/c.java"));
    }

    #[test]
    fn 空行与残缺行直接跳过() {
        let reg = EncodingRegistry::parse("\n\nencoding/\nencoding//a.java=\n=1\n");
        assert!(reg.is_empty());
    }

    #[test]
    fn utf8_有中文且未登记的要标记() {
        let d = temp_dir("mark-unregistered");
        let src = d.join("src");
        std::fs::create_dir_all(&src).unwrap();
        let f = src.join("VoucherBO.java");
        write(&f, "// 中文注释\npublic class VoucherBO {}\n");
        let reg = EncodingRegistry::parse("");
        let issue = check_java(&f, &d, &reg).expect("应当标记");
        assert_eq!(issue.registered, None);
        cleanup(&d);
    }

    #[test]
    fn 登记为_gbk_的_utf8_文件也要标记() {
        let d = temp_dir("mark-as-gbk");
        let f = d.join("AierSaleBackForHh.java");
        write(&f, "// 中文\n");
        let reg = EncodingRegistry::parse("encoding//AierSaleBackForHh.java=GBK\n");
        let issue = check_java(&f, &d, &reg).expect("应当标记");
        assert_eq!(issue.registered.as_deref(), Some("GBK"));
        cleanup(&d);
    }

    #[test]
    fn 已登记为_utf8_的不标记() {
        let d = temp_dir("registered");
        let f = d.join("Step3Model.java");
        write(&f, "// 中文\n");
        let reg = EncodingRegistry::parse("encoding//Step3Model.java=UTF-8\n");
        assert!(check_java(&f, &d, &reg).is_none());
        cleanup(&d);
    }

    #[test]
    fn 纯_ascii_和_gbk_文件都不标记() {
        let d = temp_dir("plain");
        let ascii = d.join("Plain.java");
        write(&ascii, "public class Plain {}\n");
        let gbk = d.join("Gbk.java");
        // 「中文」的 GBK 编码不是合法 UTF-8
        std::fs::write(&gbk, [0xD6u8, 0xD0, 0xCE, 0xC4]).unwrap();
        let reg = EncodingRegistry::parse("");
        assert!(check_java(&ascii, &d, &reg).is_none());
        assert!(check_java(&gbk, &d, &reg).is_none());
        cleanup(&d);
    }

    #[test]
    fn 带_bom_的_utf8_不标记() {
        let d = temp_dir("bom");
        let f = d.join("Bom.java");
        let mut bytes = vec![0xEFu8, 0xBB, 0xBF];
        bytes.extend_from_slice("// 中文\n".as_bytes());
        std::fs::write(&f, bytes).unwrap();
        assert!(check_java(&f, &d, &EncodingRegistry::parse("")).is_none());
        cleanup(&d);
    }

    #[test]
    fn 非_java_文件不看() {
        let d = temp_dir("not-java");
        let f = d.join("a.properties");
        write(&f, "键=值\n");
        assert!(check_java(&f, &d, &EncodingRegistry::parse("")).is_none());
        cleanup(&d);
    }

    #[test]
    fn 工作区外的文件返回_none() {
        let d = temp_dir("outside");
        let other = temp_dir("outside-other");
        let f = other.join("X.java");
        write(&f, "// 中文\n");
        assert!(check_java(&f, &d, &EncodingRegistry::parse("")).is_none());
        cleanup(&d);
        cleanup(&other);
    }

    #[test]
    fn 扩展名大小写不敏感() {
        assert!(is_java_source(Path::new("C:/a/B.JAVA")));
        assert!(!is_java_source(Path::new("C:/a/B.java.bak")));
    }

    // ---- 临时目录：wstest 没引 tempfile，自己拼一个够用的 ----

    fn temp_dir(tag: &str) -> PathBuf {
        let mut d = std::env::temp_dir();
        d.push(format!("ncforge-enc-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn write(path: &Path, text: &str) {
        let mut f = std::fs::File::create(path).unwrap();
        f.write_all(text.as_bytes()).unwrap();
    }

    fn cleanup(d: &Path) {
        let _ = std::fs::remove_dir_all(d);
    }
}
