//! 混改文件按需求拆块的原料（按需求审查 P2）：还原每次 AI 写入**之前**的文件内容。
//!
//! cc-bridge 变更日志的每条记录带写入前的备份路径与写入前后的 sha256。
//! 前端拿「每次写入前的内容」串成一条版本链（下一次写入前 = 这一次写入后），
//! 逐步比对就能知道当前文件的每一行是哪一次写入带进来的，进而知道每个改动块属于哪个需求。
//!
//! 这里只负责读备份、校验、解码：
//! - 写入前文件不存在（`before` 为空且没有备份）：内容是空串；
//! - 备份缺失、读不了、或 sha256 对不上（被清理 / 被改过）：内容未知（`None`），前端把那一段归为来源不明；
//! - 解码规则与读文件完全一致（`workspace::decode_lossy`），否则 GBK 文件每行都会变成假差异。
//!
//! 另外按哈希从 NCForge 本地历史里补内容（调用方传 `extra`）：NCForge 保存前会把磁盘原内容归档，
//! 所以「AI 写完 → 你在 NCForge 里手改保存 → AI 再写」时，第一次写入**之后**的内容就在本地历史里，
//! 否则这一段只能和手改合并成一步（两边的块都会被标成「AI + 手改」）。

use std::collections::HashSet;
use std::path::Path;

use sha2::{Digest, Sha256};

use crate::req_store::{Touch, TouchSource};

/// 每个文件最多取最近多少次 AI 写入。更早的并进版本链起点（归为来源不明）。
pub const MAX_VERSIONS: usize = 40;

/// 单个版本最大字节数。超过的不读（对比本来也画不出：前端 4000 行上限）。
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    pub seq: u64,
    /// 这次写入之前的文件内容；`None` = 还原不出来。
    pub text: Option<String>,
}

/// 按哈希找到的一份内容（来自本地历史）。
#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Known {
    pub sha: String,
    pub text: String,
}

#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileVersions {
    /// 当前磁盘内容的 sha256（小写十六进制）；读不了为 None。
    pub working_sha: Option<String>,
    /// 按写入顺序（seq 升序）。
    pub versions: Vec<Version>,
    /// 本地历史里与某次写入前 / 后哈希相同的内容（前端用来补「写入后」的内容）。
    pub known: Vec<Known>,
}

/// 想从本地历史里找的哈希：每次 AI 写入后的，以及备份还原不出来的写入前的（小写）。
pub fn wanted_shas(touches: &[Touch]) -> HashSet<String> {
    touches
        .iter()
        .filter(|t| t.source == TouchSource::Ai)
        .flat_map(|t| [t.after_sha.as_deref(), t.before_sha.as_deref()])
        .flatten()
        .map(str::to_ascii_lowercase)
        .collect()
}

pub fn sha_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn read_small(path: &Path) -> Option<Vec<u8>> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
        return None;
    }
    std::fs::read(path).ok()
}

fn before_text(t: &Touch) -> Option<String> {
    match (&t.backup, &t.before_sha) {
        // 写入前文件不存在（新建）：cc-bridge 不记 before、也没有备份。
        (None, None) => Some(String::new()),
        (None, Some(_)) => None,
        (Some(backup), want) => {
            let bytes = read_small(Path::new(backup))?;
            // 有哈希就必须对得上：备份被清理后同名重建、或被手动改过，都不能拿来当原文。
            if let Some(want) = want {
                if !sha_hex(&bytes).eq_ignore_ascii_case(want) {
                    return None;
                }
            }
            Some(crate::workspace::decode_lossy(&bytes))
        }
    }
}

/// 收集一个文件的版本链原料。`touches` 是需求表里这个文件的全部触达（含手改，这里只取 AI 的）；
/// `extra` 是调用方按 [`wanted_shas`] 从本地历史里取出的原字节，会重新校验哈希。
pub fn collect(path: &Path, touches: &[Touch], extra: &[Vec<u8>]) -> FileVersions {
    let working_sha = read_small(path).map(|b| sha_hex(&b));
    let wanted = wanted_shas(touches);
    let mut known: Vec<Known> = Vec::new();
    for bytes in extra {
        let sha = sha_hex(bytes);
        if wanted.contains(&sha) && !known.iter().any(|k| k.sha == sha) {
            known.push(Known {
                sha,
                text: crate::workspace::decode_lossy(bytes),
            });
        }
    }
    let mut ai: Vec<&Touch> = touches
        .iter()
        .filter(|t| t.source == TouchSource::Ai)
        .collect();
    ai.sort_by_key(|t| t.seq);
    let skip = ai.len().saturating_sub(MAX_VERSIONS);
    let versions = ai[skip..]
        .iter()
        .map(|t| Version {
            seq: t.seq,
            // 备份还原不出来时，再按写入前的哈希到本地历史里找
            text: before_text(t).or_else(|| {
                let want = t.before_sha.as_deref()?.to_ascii_lowercase();
                known.iter().find(|k| k.sha == want).map(|k| k.text.clone())
            }),
        })
        .collect();
    FileVersions {
        working_sha,
        versions,
        known,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ai(seq: u64, backup: Option<&Path>, before_sha: Option<String>) -> Touch {
        Touch {
            req: None,
            at_ms: seq,
            source: TouchSource::Ai,
            op: "edit".into(),
            tool: None,
            client: None,
            reason: None,
            before_sha,
            after_sha: None,
            backup: backup.map(|p| p.to_string_lossy().into_owned()),
            seq,
        }
    }

    #[test]
    fn 新建为空_备份校验通过才用_哈希不符或缺失为未知_手改不取() {
        let dir = tempfile::tempdir_in(crate::test_support::tmp("req-versions")).unwrap();
        let file = dir.path().join("A.java");
        std::fs::write(&file, "现在\n").unwrap();
        let good = dir.path().join("bak1");
        std::fs::write(&good, "第一版\n").unwrap();
        let bad = dir.path().join("bak2");
        std::fs::write(&bad, "被改过\n").unwrap();
        let mut manual = ai(9, None, None);
        manual.source = TouchSource::Manual;
        let touches = vec![
            ai(3, Some(&bad), Some(sha_hex("第二版\n".as_bytes()))),
            ai(1, None, None),
            ai(
                2,
                Some(&good),
                Some(sha_hex("第一版\n".as_bytes()).to_uppercase()),
            ),
            ai(4, Some(&dir.path().join("不存在")), None),
            ai(5, None, Some("aa".into())),
            manual,
        ];
        let v = collect(&file, &touches, &[]);
        assert_eq!(
            v.working_sha.as_deref(),
            Some(sha_hex("现在\n".as_bytes()).as_str())
        );
        let got: Vec<(u64, Option<&str>)> = v
            .versions
            .iter()
            .map(|x| (x.seq, x.text.as_deref()))
            .collect();
        assert_eq!(
            got,
            vec![
                (1, Some("")),
                (2, Some("第一版\n")),
                (3, None),
                (4, None),
                (5, None)
            ]
        );
        assert!(v.known.is_empty());

        // 本地历史里有「第二版」：补上 seq 3 的写入前内容；不相干的内容不收
        let mut t = touches.clone();
        t[0].after_sha = Some(sha_hex("第三版\n".as_bytes()));
        let extra = vec![
            "第二版\n".as_bytes().to_vec(),
            "无关".as_bytes().to_vec(),
            "第三版\n".as_bytes().to_vec(),
            "第二版\n".as_bytes().to_vec(),
        ];
        let v = collect(&file, &t, &extra);
        assert_eq!(v.versions[2].text.as_deref(), Some("第二版\n"));
        let shas: Vec<&str> = v.known.iter().map(|k| k.text.as_str()).collect();
        assert_eq!(shas, vec!["第二版\n", "第三版\n"], "去重、只收想要的哈希");
    }

    #[test]
    fn 只取最近若干次_gbk_按读文件规则解码() {
        let dir = tempfile::tempdir_in(crate::test_support::tmp("req-versions-b")).unwrap();
        let bak = dir.path().join("gbk");
        let (gbk, _, _) = encoding_rs::GBK.encode("中文注释\n");
        std::fs::write(&bak, &gbk).unwrap();
        let mut touches: Vec<Touch> = (1..=(MAX_VERSIONS as u64 + 5))
            .map(|s| ai(s, None, None))
            .collect();
        touches.push(ai(1000, Some(&bak), None));
        let v = collect(&dir.path().join("无"), &touches, &[]);
        assert!(v.working_sha.is_none());
        assert_eq!(v.versions.len(), MAX_VERSIONS);
        assert_eq!(v.versions[0].seq, 7);
        assert_eq!(
            v.versions.last().unwrap().text.as_deref(),
            Some("中文注释\n")
        );
    }
}
