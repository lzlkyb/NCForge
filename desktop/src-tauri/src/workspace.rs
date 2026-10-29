//! 工作区文件访问：列目录、读写文本文件（保留原编码与换行）。
//!
//! 纯逻辑模块，**不含 tauri 类型**：本机给 tauri 开 test feature 会让测试二进制
//! 启动即挂（缺 ProcessPrng 导出），所以可测试的逻辑一律放这里，命令层只做转发。
//!
//! 编码规则（M0 实测 13778 个源文件）：
//! - 合法 UTF-8 且含非 ASCII（或带 BOM）→ UTF-8；
//! - 非法 UTF-8 → GBK；
//! - 纯 ASCII → GBK（NC 源码惯例，之后敲进中文也按 GBK 存）。
//!
//! 换行：前端编辑器只接触 `\n`；读时把 CRLF 归一，写时按原换行还原。
//! 混合换行 / 孤立 CR 的文件标 `MIXED`：保存会改动全部行尾（SVN 里是整文件 diff），
//! 所以写入时拒绝，必须由前端显式选择统一成 LF 或 CRLF 才允许。

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use encoding_rs::GBK;
use serde::{Deserialize, Serialize};

/// 目录树里不展示的目录（版本库元数据，用户不会想编辑）。
const HIDDEN_DIRS: [&str; 2] = [".svn", ".git"];

/// 单文件大小上限：再大的文本不适合塞进编辑器。
const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirItem {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TextEncoding {
    #[serde(rename = "UTF-8")]
    Utf8,
    #[serde(rename = "GBK")]
    Gbk,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Eol {
    #[serde(rename = "LF")]
    Lf,
    #[serde(rename = "CRLF")]
    Crlf,
    #[serde(rename = "MIXED")]
    Mixed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    /// 给编辑器的文本：非 MIXED 时只含 `\n`；MIXED 时保持原样（前端只读展示）。
    pub text: String,
    pub encoding: TextEncoding,
    pub has_bom: bool,
    pub eol: Eol,
    /// 按检测出的编码/换行重新编码能否得到与磁盘逐字节相同的内容。
    /// 为 false 说明含无法无损往返的字符，保存会改动原文件，前端应只读。
    pub lossless: bool,
    pub size: u64,
    pub mtime_ms: u64,
}

/// 列出目录：目录在前，其余按名字（不分大小写）排序；跳过 `.svn` / `.git`。
pub fn list_dir(dir: &Path) -> Result<Vec<DirItem>, String> {
    let rd = std::fs::read_dir(dir).map_err(|e| format!("读取目录失败: {e}"))?;
    let mut items = Vec::new();
    for entry in rd {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(md) = entry.metadata() else { continue };
        if md.is_dir() && HIDDEN_DIRS.contains(&name.as_str()) {
            continue;
        }
        items.push(DirItem {
            name,
            is_dir: md.is_dir(),
            size: md.len(),
        });
    }
    items.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(items)
}

// ---------------------------------------------------------------------------
// 文件树操作：新建 / 重命名 / 删除
//
// 和读写一样，这一层只管「路径已经过白名单校验」之后的事；越界判断在
// `security::path::resolve_safe_path` 里做，命令层转发前完成。
// ---------------------------------------------------------------------------

/// Windows 文件名里不允许出现的字符。
const BAD_NAME_CHARS: [char; 9] = ['\\', '/', ':', '*', '?', '"', '<', '>', '|'];

/// Windows 保留设备名。注意 `CON.java` 这种带扩展名的同样建不出来，所以只比对第一个点之前的部分。
const RESERVED_NAMES: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// 统计目录文件数的上限：再多数下去也没有意义（删除确认只要个量级）。
const COUNT_FILES_CAP: u64 = 20000;

/// 新建的条目类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NewEntryKind {
    File,
    Dir,
}

/// 校验一个条目名（不含路径分隔符）。
///
/// 前端有一份同样的规则做即时反馈，后端仍要拦一遍：名字最终落盘，
/// 绕过界面直接调命令也应该被拒绝。错误文案直接给用户看，所以要能读懂。
pub fn validate_entry_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("名字不能为空".to_string());
    }
    if name.trim() != name {
        return Err("名字首尾不能有空格".to_string());
    }
    if let Some(c) = name.chars().find(|c| BAD_NAME_CHARS.contains(c)) {
        return Err(format!("名字不能包含 {c}（\\ / : * ? \" < > |）"));
    }
    if name.chars().any(char::is_control) {
        return Err("名字不能包含控制字符".to_string());
    }
    if name.ends_with('.') {
        return Err("名字不能以点结尾".to_string());
    }
    if name.chars().count() > 120 {
        return Err("名字太长".to_string());
    }
    let stem = name.split('.').next().unwrap_or(name);
    if RESERVED_NAMES.iter().any(|r| r.eq_ignore_ascii_case(stem)) {
        return Err(format!("{stem} 是 Windows 保留名，不能用作文件名"));
    }
    Ok(())
}

/// 在 `parent` 下新建空文件或文件夹，返回新条目的路径。
pub fn create_entry(parent: &Path, name: &str, kind: NewEntryKind) -> Result<PathBuf, String> {
    validate_entry_name(name)?;
    if !parent.is_dir() {
        return Err(format!("目录不存在：{}", parent.display()));
    }
    let target = parent.join(name);
    if target.exists() {
        return Err("已存在同名文件或文件夹".to_string());
    }
    match kind {
        // create_new：万一别处刚好同时建了同名文件，也不会被覆盖
        NewEntryKind::File => {
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)
                .map_err(|e| format!("新建文件失败：{e}"))?;
        }
        NewEntryKind::Dir => {
            std::fs::create_dir(&target).map_err(|e| format!("新建文件夹失败：{e}"))?;
        }
    }
    Ok(target)
}

/// 两个路径是否指向同一个实体。Windows 上只改大小写时新旧路径是同一文件，需要特判。
fn is_same_path(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

/// 重命名（同目录内改名），返回新路径。
pub fn rename_entry(old: &Path, new_name: &str) -> Result<PathBuf, String> {
    validate_entry_name(new_name)?;
    let parent = old
        .parent()
        .ok_or_else(|| "无法重命名工作区根目录".to_string())?;
    let target = parent.join(new_name);
    if target == old {
        return Ok(target);
    }
    if target.exists() {
        if !is_same_path(old, &target) {
            return Err("已存在同名文件或文件夹".to_string());
        }
        // 只改大小写：Windows 不允许一步 rename 到「同名但大小写不同」的路径，
        // 先落到一个中转名，再改成目标名。失败时尽量还原，别把文件丢在中转名上。
        let tmp = parent.join(format!(".ncforge-renaming-{}", std::process::id()));
        std::fs::rename(old, &tmp).map_err(|e| format!("重命名失败：{e}"))?;
        if let Err(e) = std::fs::rename(&tmp, &target) {
            let _ = std::fs::rename(&tmp, old);
            return Err(format!("重命名失败：{e}"));
        }
        return Ok(target);
    }
    std::fs::rename(old, &target).map_err(|e| format!("重命名失败：{e}"))?;
    Ok(target)
}

/// 删除文件或文件夹。文件夹必须显式带 `recursive`（前端会先问一次并报出文件数）。
pub fn delete_entry(path: &Path, recursive: bool) -> Result<(), String> {
    // symlink_metadata：符号链接按「文件」删，不跟进去删目标
    let md = std::fs::symlink_metadata(path).map_err(|e| format!("找不到要删除的条目：{e}"))?;
    if md.is_dir() {
        if !recursive {
            return Err("这是文件夹，需要确认递归删除".to_string());
        }
        std::fs::remove_dir_all(path).map_err(|e| format!("删除文件夹失败：{e}"))?;
    } else {
        std::fs::remove_file(path).map_err(|e| format!("删除文件失败：{e}"))?;
    }
    Ok(())
}

/// 数一个目录下有多少个文件（递归，跳过 `.svn` / `.git`），删除确认弹窗用。
/// 到 `COUNT_FILES_CAP` 就停——用户要的是「大概多少个」，不是精确值。
pub fn count_files(dir: &Path) -> u64 {
    fn walk(dir: &Path, acc: &mut u64) {
        if *acc >= COUNT_FILES_CAP {
            return;
        }
        let Ok(rd) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in rd.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let Ok(md) = entry.metadata() else { continue };
            if md.is_dir() {
                if HIDDEN_DIRS.contains(&name.as_ref()) {
                    continue;
                }
                walk(&entry.path(), acc);
            } else {
                *acc += 1;
            }
        }
    }
    let mut acc = 0;
    walk(dir, &mut acc);
    // 触顶时多给 1：让界面能区分「正好两万个」和「远远不止」——
    // 否则删除确认里那句「共 20000 个文件」在超大目录上是句假话。
    if acc >= COUNT_FILES_CAP {
        COUNT_FILES_CAP + 1
    } else {
        acc
    }
}

fn mtime_ms(path: &Path) -> Result<u64, String> {
    let md = std::fs::metadata(path).map_err(|e| format!("读取文件信息失败: {e}"))?;
    let modified = md
        .modified()
        .map_err(|e| format!("读取修改时间失败: {e}"))?;
    let ms = modified
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    Ok(ms as u64)
}

/// 统计换行形态。孤立 CR、或 CRLF 与孤立 LF 并存都算 MIXED；没有任何换行按 CRLF（Windows 工程惯例）。
fn detect_eol(bytes: &[u8]) -> Eol {
    let (mut crlf, mut lone_lf, mut lone_cr) = (0usize, 0usize, 0usize);
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\r' if bytes.get(i + 1) == Some(&b'\n') => {
                crlf += 1;
                i += 1;
            }
            b'\r' => lone_cr += 1,
            b'\n' => lone_lf += 1,
            _ => {}
        }
        i += 1;
    }
    if lone_cr > 0 || (crlf > 0 && lone_lf > 0) {
        Eol::Mixed
    } else if lone_lf > 0 {
        Eol::Lf
    } else {
        Eol::Crlf
    }
}

/// 解码：返回（文本，编码，是否带 UTF-8 BOM，解码时是否遇到无法映射的字节）。
fn decode(bytes: &[u8]) -> (String, TextEncoding, bool, bool) {
    let (body, bom) = match bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        Some(rest) => (rest, true),
        None => (bytes, false),
    };
    match std::str::from_utf8(body) {
        Ok(s) if bom || !s.is_ascii() => (s.to_owned(), TextEncoding::Utf8, bom, false),
        Ok(s) => (s.to_owned(), TextEncoding::Gbk, false, false),
        Err(_) => {
            let (cow, _, had_errors) = GBK.decode(body);
            (cow.into_owned(), TextEncoding::Gbk, false, had_errors)
        }
    }
}

/// 只判断编码（给编译器给每个源文件标 `[GBK]` / `[UTF-8]` 用），规则与读文件完全一致。
pub fn detect_encoding(bytes: &[u8]) -> TextEncoding {
    decode(bytes).1
}

/// 把字节按检测出的编码解码成文本（分析 import 等场景用，不关心是否无损）。
pub fn decode_lossy(bytes: &[u8]) -> String {
    decode(bytes).0
}

fn encode(text: &str, encoding: TextEncoding, has_bom: bool) -> Result<Vec<u8>, String> {
    match encoding {
        TextEncoding::Utf8 => {
            let mut out = Vec::with_capacity(text.len() + 3);
            if has_bom {
                out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
            }
            out.extend_from_slice(text.as_bytes());
            Ok(out)
        }
        TextEncoding::Gbk => {
            let (cow, _, had_errors) = GBK.encode(text);
            if had_errors {
                // 指出第一个写不出的字符：只说「请改用 UTF-8」用户无从下手，
                // 而字符级线索（常常是 emoji、生僻字、全角符号）能一眼定位。
                let bad = text.chars().find(|c| GBK.encode(&c.to_string()).2);
                let what = match bad {
                    Some(c) => format!("「{c}」"),
                    None => "部分字符".to_string(),
                };
                return Err(format!(
                    "UNENCODABLE:内容含 GBK 表示不了的字符 {what}，只能转成 UTF-8 保存"
                ));
            }
            Ok(cow.into_owned())
        }
    }
}

/// 把编辑器的 `\n` 文本还原成目标换行。先把已有的 CRLF 归一，避免出现 `\r\r\n`。
fn apply_eol(text: &str, eol: Eol) -> Result<String, String> {
    match eol {
        Eol::Lf => Ok(text.replace("\r\n", "\n")),
        Eol::Crlf => Ok(text.replace("\r\n", "\n").replace('\n', "\r\n")),
        Eol::Mixed => Err("混合换行的文件不能直接保存，请先选择统一成 LF 或 CRLF".to_string()),
    }
}

/// 读文本文件，识别编码与换行，并校验能否无损往返。
pub fn read_text_file(path: &Path) -> Result<FileContent, String> {
    let md = std::fs::metadata(path).map_err(|e| format!("读取文件信息失败: {e}"))?;
    if !md.is_file() {
        return Err("不是文件".to_string());
    }
    if md.len() > MAX_FILE_BYTES {
        return Err(format!(
            "文件过大（{} MB），超过 {} MB 上限",
            md.len() / 1024 / 1024,
            MAX_FILE_BYTES / 1024 / 1024
        ));
    }
    let bytes = std::fs::read(path).map_err(|e| format!("读取文件失败: {e}"))?;
    if bytes.contains(&0) {
        return Err("疑似二进制文件，不按文本打开".to_string());
    }
    let mtime = mtime_ms(path)?;
    let eol = detect_eol(&bytes);
    let (raw_text, encoding, has_bom, decode_err) = decode(&bytes);

    // 无损校验：用将来保存时同样的路径重建字节，必须与磁盘逐字节一致。
    let rebuilt = match eol {
        Eol::Mixed => encode(&raw_text, encoding, has_bom),
        _ => apply_eol(&raw_text.replace("\r\n", "\n"), eol)
            .and_then(|t| encode(&t, encoding, has_bom)),
    };
    let lossless = !decode_err && rebuilt.map(|b| b == bytes).unwrap_or(false);

    let text = if eol == Eol::Crlf {
        raw_text.replace("\r\n", "\n")
    } else {
        raw_text
    };
    Ok(FileContent {
        text,
        encoding,
        has_bom,
        eol,
        lossless,
        size: bytes.len() as u64,
        mtime_ms: mtime,
    })
}

/// 写文本文件，返回写入后的修改时间。
///
/// - `expected_mtime_ms`：读取时记下的修改时间；磁盘上已变（别的程序/AI 改过）则返回以
///   `CONFLICT` 开头的错误，不覆盖。
/// - 先写同目录临时文件再 rename，写到一半断电不会留下半截源码。
pub fn write_text_file(
    path: &Path,
    text: &str,
    encoding: TextEncoding,
    has_bom: bool,
    eol: Eol,
    expected_mtime_ms: Option<u64>,
) -> Result<u64, String> {
    if let Some(expected) = expected_mtime_ms {
        if mtime_ms(path)? != expected {
            return Err("CONFLICT: 文件在磁盘上已被其他程序修改".to_string());
        }
    }
    let bytes = encode(&apply_eol(text, eol)?, encoding, has_bom)?;

    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("无效的文件名")?;
    let tmp = path.with_file_name(format!(".{file_name}.{}.nc-tmp", std::process::id()));
    if let Err(e) = std::fs::write(&tmp, &bytes) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("写临时文件失败: {e}"));
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("替换原文件失败（文件可能只读或被占用）: {e}"));
    }
    mtime_ms(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("ncwb-ws-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn gbk_file_roundtrips_and_keeps_crlf() {
        let d = tmpdir("gbk");
        let p = d.join("a.java");
        let (gbk, _, _) = GBK.encode("// 接口：凭证\r\nint a;\r\n");
        std::fs::write(&p, &gbk).unwrap();
        let c = read_text_file(&p).unwrap();
        assert_eq!(c.encoding, TextEncoding::Gbk);
        assert_eq!(c.eol, Eol::Crlf);
        assert!(c.lossless);
        assert_eq!(c.text, "// 接口：凭证\nint a;\n");
        write_text_file(&p, &c.text, c.encoding, c.has_bom, c.eol, Some(c.mtime_ms)).unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), gbk.as_ref());
    }

    #[test]
    fn utf8_with_chinese_stays_utf8() {
        let d = tmpdir("u8");
        let p = d.join("b.java");
        std::fs::write(&p, "// 接口\nint b;\n".as_bytes()).unwrap();
        let c = read_text_file(&p).unwrap();
        assert_eq!(c.encoding, TextEncoding::Utf8);
        assert_eq!(c.eol, Eol::Lf);
        assert!(c.lossless);
    }

    #[test]
    fn pure_ascii_defaults_to_gbk_and_bom_is_kept() {
        let d = tmpdir("ascii");
        let p = d.join("c.java");
        std::fs::write(&p, b"int c;\r\n").unwrap();
        assert_eq!(read_text_file(&p).unwrap().encoding, TextEncoding::Gbk);

        let p2 = d.join("d.java");
        let mut bom = vec![0xEF, 0xBB, 0xBF];
        bom.extend_from_slice(b"int d;\n");
        std::fs::write(&p2, &bom).unwrap();
        let c = read_text_file(&p2).unwrap();
        assert_eq!((c.encoding, c.has_bom), (TextEncoding::Utf8, true));
        assert!(c.lossless);
        write_text_file(&p2, &c.text, c.encoding, c.has_bom, c.eol, None).unwrap();
        assert_eq!(std::fs::read(&p2).unwrap(), bom);
    }

    #[test]
    fn mixed_eol_is_flagged_and_refuses_save() {
        let d = tmpdir("mixed");
        let p = d.join("e.java");
        std::fs::write(&p, b"a\r\nb\nc\r\n").unwrap();
        let c = read_text_file(&p).unwrap();
        assert_eq!(c.eol, Eol::Mixed);
        assert!(write_text_file(&p, &c.text, c.encoding, c.has_bom, c.eol, None).is_err());
        // 显式统一成 CRLF 后允许保存
        write_text_file(&p, "a\nb\nc\n", c.encoding, c.has_bom, Eol::Crlf, None).unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"a\r\nb\r\nc\r\n");
        // 孤立 CR 也算混合
        std::fs::write(&p, b"a\rb\n").unwrap();
        assert_eq!(read_text_file(&p).unwrap().eol, Eol::Mixed);
    }

    #[test]
    fn no_trailing_newline_is_preserved() {
        let d = tmpdir("nonl");
        let p = d.join("f.java");
        std::fs::write(&p, b"a\r\nb").unwrap();
        let c = read_text_file(&p).unwrap();
        assert!(c.lossless);
        write_text_file(&p, &c.text, c.encoding, c.has_bom, c.eol, None).unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"a\r\nb");
    }

    #[test]
    fn invalid_gbk_bytes_are_not_lossless() {
        let d = tmpdir("bad");
        let p = d.join("g.java");
        std::fs::write(&p, [0x61, 0xFF, 0xFE, 0x62]).unwrap();
        assert!(!read_text_file(&p).unwrap().lossless);
    }

    #[test]
    fn gbk_cannot_encode_emoji_but_utf8_can() {
        let d = tmpdir("emoji");
        let p = d.join("h.java");
        std::fs::write(&p, b"int h;\n").unwrap();
        assert!(write_text_file(
            &p,
            "// \u{1F600}\n",
            TextEncoding::Gbk,
            false,
            Eol::Lf,
            None
        )
        .is_err());
        assert!(write_text_file(
            &p,
            "// \u{1F600}\n",
            TextEncoding::Utf8,
            false,
            Eol::Lf,
            None
        )
        .is_ok());
    }

    #[test]
    fn external_modification_is_detected() {
        let d = tmpdir("conflict");
        let p = d.join("i.java");
        std::fs::write(&p, b"int i;\n").unwrap();
        let c = read_text_file(&p).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(30));
        std::fs::write(&p, b"int j;\n").unwrap(); // 别的程序改了
        let e = write_text_file(&p, &c.text, c.encoding, c.has_bom, c.eol, Some(c.mtime_ms))
            .unwrap_err();
        assert!(e.starts_with("CONFLICT"));
        assert_eq!(std::fs::read(&p).unwrap(), b"int j;\n"); // 没被覆盖
    }

    #[test]
    fn list_dir_sorts_dirs_first_and_hides_svn() {
        let d = tmpdir("ls");
        std::fs::create_dir_all(d.join(".svn")).unwrap();
        std::fs::create_dir_all(d.join("zdir")).unwrap();
        std::fs::write(d.join("B.txt"), b"").unwrap();
        std::fs::write(d.join("a.txt"), b"").unwrap();
        let names: Vec<_> = list_dir(&d).unwrap().into_iter().map(|i| i.name).collect();
        assert_eq!(names, vec!["zdir", "a.txt", "B.txt"]);
    }

    #[test]
    fn entry_name_validation_follows_windows_rules() {
        for bad in [
            "",
            "   ",
            " a.java",
            "a.java ",
            "a/b.java",
            "a\\b.java",
            "a:b.java",
            "a?b.java",
            "a*b.java",
            "a|b.java",
            "a\"b.java",
            "a<b.java",
            "a.b.",
            "con",
            "CON.java",
            "lpt9.txt",
        ] {
            assert!(validate_entry_name(bad).is_err(), "应拒绝：{bad:?}");
        }
        for ok in [
            "NewVoucherBO.java",
            "nc.voucher",
            "接口-转换.xml",
            "a b.txt",
            "console.java",
            "条目",
        ] {
            assert!(validate_entry_name(ok).is_ok(), "应通过：{ok:?}");
        }
    }

    #[test]
    fn create_entry_writes_empty_file_and_refuses_duplicate() {
        let d = tmpdir("create");
        let f = create_entry(&d, "A.java", NewEntryKind::File).unwrap();
        assert_eq!(std::fs::read(&f).unwrap(), b"");
        // 同名再建：文件、目录都拒绝
        assert!(create_entry(&d, "A.java", NewEntryKind::File).is_err());
        assert!(create_entry(&d, "A.java", NewEntryKind::Dir).is_err());
        let sub = create_entry(&d, "pkg", NewEntryKind::Dir).unwrap();
        assert!(sub.is_dir());
        // 父目录不存在 / 名字非法
        assert!(create_entry(&d.join("nope"), "B.java", NewEntryKind::File).is_err());
        assert!(create_entry(&d, "a:b", NewEntryKind::File).is_err());
    }

    #[test]
    fn rename_entry_keeps_content_and_refuses_occupied_target() {
        let d = tmpdir("rename");
        let a = create_entry(&d, "A.java", NewEntryKind::File).unwrap();
        std::fs::write(&a, b"class A {}\n").unwrap();
        let b = rename_entry(&a, "B.java").unwrap();
        assert_eq!(b.file_name().unwrap(), "B.java");
        assert!(!a.exists());
        assert_eq!(std::fs::read(&b).unwrap(), b"class A {}\n");

        create_entry(&d, "C.java", NewEntryKind::File).unwrap();
        assert!(rename_entry(&b, "C.java").is_err());
        assert!(rename_entry(&b, "x/y.java").is_err());
        assert_eq!(std::fs::read(&b).unwrap(), b"class A {}\n"); // 失败不动原文件
    }

    #[test]
    fn rename_entry_can_change_case_only() {
        let d = tmpdir("rename-case");
        let a = create_entry(&d, "Voucher.java", NewEntryKind::File).unwrap();
        std::fs::write(&a, b"// keep\n").unwrap();
        let b = rename_entry(&a, "voucher.java").unwrap();
        assert_eq!(std::fs::read(&b).unwrap(), b"// keep\n");
        assert_eq!(std::fs::read_dir(&d).unwrap().count(), 1); // 没有留下中转名
    }

    #[test]
    fn delete_entry_needs_recursive_for_dirs() {
        let d = tmpdir("delete");
        let sub = create_entry(&d, "pkg", NewEntryKind::Dir).unwrap();
        std::fs::write(sub.join("A.java"), b"").unwrap();
        assert!(delete_entry(&sub, false).is_err());
        assert!(sub.exists());
        delete_entry(&sub, true).unwrap();
        assert!(!sub.exists());
        let f = create_entry(&d, "B.java", NewEntryKind::File).unwrap();
        delete_entry(&f, false).unwrap();
        assert!(!f.exists());
    }

    #[test]
    fn count_files_walks_recursively_and_skips_svn() {
        let d = tmpdir("count");
        std::fs::create_dir_all(d.join("pkg/deep")).unwrap();
        std::fs::create_dir_all(d.join(".svn")).unwrap();
        std::fs::write(d.join("a.java"), b"").unwrap();
        std::fs::write(d.join("pkg/b.java"), b"").unwrap();
        std::fs::write(d.join("pkg/deep/c.java"), b"").unwrap();
        std::fs::write(d.join(".svn/entries"), b"").unwrap();
        assert_eq!(count_files(&d), 3);
    }
}
