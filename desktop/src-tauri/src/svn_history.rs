//! 历史与冲突的纯数据转换。固定版本正文不复用工作副本编码或行号。
use crate::{svn_cred, workspace};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPath {
    pub path: String,
    pub action: String,
    pub copy_from_path: Option<String>,
    pub copy_from_revision: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub revision: i64,
    pub author: String,
    pub date: i64,
    pub message: String,
    pub paths: Vec<HistoryPath>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryResult {
    pub repository_path: String,
    pub entries: Vec<HistoryEntry>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotLine {
    pub revision: i64,
    pub author: String,
    pub date: i64,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameSnapshot {
    pub source_revision: i64,
    pub text: String,
    pub encoding: String,
    pub lines: Vec<SnapshotLine>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionDiff {
    pub path: String,
    pub before_path: String,
    pub before_revision: i64,
    pub revision: i64,
    pub before_empty: bool,
    pub after_empty: bool,
    pub before_text: String,
    pub after_text: String,
    pub before_encoding: String,
    pub after_encoding: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictVersion {
    pub role: String,
    pub name: String,
    pub revision: i64,
    pub binary: bool,
    pub text: String,
    pub encoding: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictSnapshot {
    pub tree_conflict: bool,
    pub property_conflict: bool,
    pub text_conflict: bool,
    pub mine: Option<ConflictVersion>,
    pub base: Option<ConflictVersion>,
    pub theirs: Option<ConflictVersion>,
    pub working_readable: bool,
    pub working_has_markers: bool,
}

pub fn decode_content(value: &serde_json::Value) -> Result<(String, String), String> {
    let encoded = value.as_str().ok_or("正文数据缺失")?;
    let bytes = svn_cred::b64_decode(encoded).ok_or("正文编码数据无效")?;
    if bytes.contains(&0) {
        return Err("二进制内容不能作为文本展示".to_string());
    }
    let encoding = match workspace::detect_encoding(&bytes) {
        workspace::TextEncoding::Utf8 => "UTF-8",
        workspace::TextEncoding::Gbk => "GBK",
    };
    Ok((
        workspace::decode_lossy(&bytes)
            .trim_start_matches('\u{feff}')
            .replace("\r\n", "\n"),
        encoding.to_string(),
    ))
}

pub fn conflict_version(value: &serde_json::Value) -> Result<Option<ConflictVersion>, String> {
    if value.is_null() {
        return Ok(None);
    }
    let binary = value["binary"].as_bool().unwrap_or(false);
    let (text, encoding) = if binary {
        (String::new(), String::new())
    } else {
        decode_content(&value["content"])?
    };
    Ok(Some(ConflictVersion {
        role: value["role"].as_str().unwrap_or("").to_string(),
        name: value["name"].as_str().unwrap_or("").to_string(),
        revision: value["revision"].as_i64().unwrap_or(-1),
        binary,
        text,
        encoding,
    }))
}

pub fn has_conflict_markers(text: &str) -> bool {
    text.lines().any(|line| {
        ["<<<<<<<", "|||||||", "=======", ">>>>>>>"]
            .iter()
            .any(|mark| {
                line.strip_prefix(mark).is_some_and(|suffix| {
                    suffix.is_empty() || suffix.starts_with(char::is_whitespace)
                })
            })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn markers_are_only_recognized_as_conflict_lines() {
        assert!(has_conflict_markers(
            "<<<<<<< mine\r\nclass A {}\r\n=======\r\n>>>>>>> .r8"
        ));
        assert!(has_conflict_markers("||||||| .r7"));
        assert!(!has_conflict_markers(
            "String s = \"<<<<<<<\";\n// =======\n========"
        ));
    }
    #[test]
    fn snapshots_decode_their_own_encoding_and_reject_binary() {
        let (bytes, _, _) = encoding_rs::GBK.encode("服务器内容\r\n");
        let encoded = svn_cred::b64_encode(&bytes);
        let (text, encoding) = decode_content(&serde_json::json!(encoded)).unwrap();
        assert_eq!(text, "服务器内容\n");
        assert_eq!(encoding, "GBK");
        assert!(decode_content(&serde_json::json!(svn_cred::b64_encode(b"a\0b"))).is_err());
    }
}
