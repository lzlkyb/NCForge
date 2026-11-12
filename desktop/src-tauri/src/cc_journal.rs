//! 读 cc-bridge 的变更日志（开放能力，契约见 cc-bridge 仓库 `docs/开放能力-变更日志.md`）。
//!
//! - 位置：Windows `%APPDATA%\com.ccbridge.desktop\journal\changes-YYYYMMDD.jsonl`，
//!   macOS `~/Library/Application Support/com.ccbridge.desktop/journal/`。
//! - 只追加、按天切文件、整份过期删除。所以记住「读到哪个文件的哪个字节」做增量读，
//!   再用 `seq` 去重兜底；只读到最后一个换行符（写到一半的行下次再读）。
//! - 只留工作区内的条目；不认识的格式版本（`v` ≠ 1）跳过。
//!
//! 变更日志在 cc-bridge 里**默认关闭**：目录不存在或从没读到本工作区的记录时，界面提示去开启。

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use crate::req_store::{key_of, ReqStore, Touch, TouchSource};

/// 一次同步最多读多少字节，防止头一次启用时把 30 天的大日志一口气读进内存；剩下的下次再读。
const MAX_BYTES_PER_SYNC: u64 = 32 * 1024 * 1024;

/// cc-bridge 的数据目录名（Tauri identifier）。
const BRIDGE_ID: &str = "com.ccbridge.desktop";

/// 默认的日志目录；取不到用户目录时为 None。
pub fn default_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let base = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME")
        .map(|h| PathBuf::from(h).join("Library").join("Application Support"));
    #[cfg(not(any(windows, target_os = "macos")))]
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")));
    base.map(|b| b.join(BRIDGE_ID).join("journal"))
}

/// 一次同步的结果。
#[derive(Debug, Default, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOutcome {
    /// 日志目录是否存在（不存在 = cc-bridge 没装或从没开过变更日志）。
    pub found: bool,
    /// 本次新记入的、属于本工作区的条目数。
    pub added: usize,
    /// 还有没读完的（触及单次上限）。
    pub more: bool,
}

/// 变更日志里的一条（只取用得上的字段；未知字段忽略）。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    v: u32,
    seq: u64,
    at: String,
    op: String,
    path: String,
    #[serde(default)]
    from: Option<String>,
    #[serde(default)]
    backup: Option<String>,
    #[serde(default)]
    before: Option<Snap>,
    #[serde(default)]
    after: Option<Snap>,
    #[serde(default)]
    call: Option<Call>,
    #[serde(default)]
    change_set: Option<String>,
    #[serde(default)]
    reason: Option<String>,
}

#[derive(serde::Deserialize)]
struct Snap {
    #[serde(default)]
    sha256: Option<String>,
}

#[derive(serde::Deserialize)]
struct Call {
    #[serde(default)]
    tool: Option<String>,
    #[serde(default)]
    client: Option<String>,
}

/// 日志目录里的 `(日期, 路径)`，按日期升序。
fn journal_files(dir: &Path) -> Vec<(String, PathBuf)> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<(String, PathBuf)> = rd
        .filter_map(Result::ok)
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let day = name.strip_prefix("changes-")?.strip_suffix(".jsonl")?;
            (day.len() == 8 && day.bytes().all(|b| b.is_ascii_digit()))
                .then(|| (day.to_string(), e.path()))
        })
        .collect();
    out.sort();
    out
}

/// 从游标处继续读，把本工作区的条目记进需求表。只改内存里的 `store`，落盘由调用方做。
pub fn sync(store: &mut ReqStore, dir: &Path, root: &str) -> SyncOutcome {
    let mut out = SyncOutcome {
        found: dir.is_dir(),
        ..Default::default()
    };
    if !out.found {
        return out;
    }
    let prefix = format!("{}/", key_of(root).trim_end_matches('/'));
    let mut budget = MAX_BYTES_PER_SYNC;
    for (day, path) in journal_files(dir) {
        if day < store.cursor.day {
            continue;
        }
        let start = if day == store.cursor.day {
            store.cursor.offset
        } else {
            0
        };
        let Ok(mut f) = std::fs::File::open(&path) else {
            continue;
        };
        let len = f.metadata().map(|m| m.len()).unwrap_or(0);
        // 文件比游标短：只可能是被删后重建了，从头读（seq 去重兜底）。
        let start = if len < start { 0 } else { start };
        let want = (len - start).min(budget);
        if f.seek(SeekFrom::Start(start)).is_err() {
            continue;
        }
        let mut buf = Vec::with_capacity(want as usize);
        if f.take(want).read_to_end(&mut buf).is_err() {
            continue;
        }
        // 只处理完整的行；写到一半的最后一行留到下次。
        let complete = buf.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
        for line in buf[..complete].split(|b| *b == b'\n') {
            if let Some(e) = parse_line(line) {
                if e.seq <= store.cursor.seq && store.cursor.seq > 0 {
                    continue;
                }
                store.cursor.seq = store.cursor.seq.max(e.seq);
                if apply(store, e, &prefix) {
                    out.added += 1;
                }
            }
        }
        store.cursor.day = day;
        store.cursor.offset = start + complete as u64;
        budget -= complete as u64;
        // 受单次上限截断了本文件，或预算已用完：剩下的下次再读。
        // （只是末尾半行没写完不算：那时 want == len - start。）
        if want < len - start || budget == 0 {
            out.more = true;
            break;
        }
    }
    out
}

fn parse_line(line: &[u8]) -> Option<Entry> {
    if line.iter().all(u8::is_ascii_whitespace) {
        return None;
    }
    let e: Entry = serde_json::from_slice(line).ok()?;
    (e.v == 1).then_some(e)
}

/// 把一条记进需求表；不属于本工作区返回 false。
fn apply(store: &mut ReqStore, e: Entry, prefix: &str) -> bool {
    let inside = |p: &str| key_of(p).starts_with(prefix);
    let from_inside = e.from.as_deref().is_some_and(inside);
    if !inside(&e.path) && !from_inside {
        return false;
    }
    let at_ms = parse_rfc3339_ms(&e.at).unwrap_or(0);
    let req = e
        .change_set
        .as_deref()
        .and_then(crate::req_store::normalize_name)
        .map(|name| store.ensure(&name, at_ms));
    let (tool, client) = e.call.map(|c| (c.tool, c.client)).unwrap_or((None, None));
    let touch = Touch {
        req,
        at_ms,
        source: TouchSource::Ai,
        op: e.op.clone(),
        tool,
        client,
        reason: e.reason,
        before_sha: e.before.and_then(|s| s.sha256),
        after_sha: e.after.and_then(|s| s.sha256),
        backup: e.backup,
        seq: e.seq,
    };
    // 移动：源路径在 SVN 里显示为删除，也要归到同一个需求。
    if e.op == "move" && from_inside {
        if let Some(from) = &e.from {
            let mut t = touch.clone();
            t.op = "delete".into();
            t.after_sha = None;
            store.touch(from, t);
        }
    }
    if inside(&e.path) {
        store.touch(&e.path, touch);
    }
    store.cursor.last_at_ms = store.cursor.last_at_ms.max(at_ms);
    true
}

/// 解析 `2026-11-12T10:05:33.123+08:00` 这类 RFC 3339 时间为 Unix 毫秒。
/// 只支持 cc-bridge 实际写出的形态（秒后可选小数、`Z` 或 `±HH:MM`），其余返回 None。
pub fn parse_rfc3339_ms(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b't' | b' ') {
        return None;
    }
    let num = |r: std::ops::Range<usize>| -> Option<i64> { s.get(r)?.parse().ok() };
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, se) = (num(11..13)?, num(14..16)?, num(17..19)?);
    let mut i = 19;
    let mut ms = 0i64;
    if b.get(i) == Some(&b'.') {
        let start = i + 1;
        i = start;
        while b.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        let frac = s.get(start..i)?;
        let first3: String = frac.chars().chain("000".chars()).take(3).collect();
        ms = first3.parse().ok()?;
    }
    let offset_min = match b.get(i)? {
        b'Z' | b'z' => 0,
        c @ (b'+' | b'-') => {
            let oh = num(i + 1..i + 3)?;
            let om = num(i + 4..i + 6)?;
            let sign = if *c == b'+' { 1 } else { -1 };
            sign * (oh * 60 + om)
        }
        _ => return None,
    };
    // 公历日期 → 自 1970-01-01 起的天数（Howard Hinnant 的 days_from_civil）。
    let yy = if mo <= 2 { y - 1 } else { y };
    let era = yy.div_euclid(400);
    let yoe = yy - era * 400;
    let doy = (153 * (mo + if mo > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let secs = days * 86_400 + h * 3600 + mi * 60 + se - offset_min * 60;
    u64::try_from(secs * 1000 + ms).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn line(seq: u64, path: &str, cs: Option<&str>) -> String {
        serde_json::json!({
            "v": 1, "seq": seq, "at": "2026-11-12T10:05:33.123+08:00", "op": "edit",
            "path": path, "from": null, "backup": null,
            "before": {"size": 1, "sha256": "aa"}, "after": {"size": 2, "sha256": "bb"},
            "call": {"id": "c-1", "tool": "edit_files", "client": "claude-code", "source": null},
            "changeSet": cs, "reason": "原因", "futureField": 1
        })
        .to_string()
            + "\n"
    }

    fn append(dir: &Path, day: &str, text: &str) {
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join(format!("changes-{day}.jsonl")))
            .unwrap();
        f.write_all(text.as_bytes()).unwrap();
    }

    #[test]
    fn 时间解析() {
        assert_eq!(parse_rfc3339_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339_ms("1970-01-01T08:00:00.5+08:00"), Some(500));
        assert_eq!(
            parse_rfc3339_ms("2026-11-12T10:05:33.123+08:00"),
            Some(1_794_449_133_123)
        );
        assert_eq!(parse_rfc3339_ms("不是时间"), None);
    }

    #[test]
    fn 增量读_只留工作区内_半行下次再读_跨天接续() {
        let dir = tempfile::tempdir_in(crate::test_support::tmp("cc-journal-a")).unwrap();
        let root = r"C:\work\aier\newar";
        let mut s = ReqStore::default();
        assert!(!sync(&mut s, &dir.path().join("none"), root).found);

        append(
            dir.path(),
            "20261111",
            &line(1, r"C:\work\aier\newar\pu\A.java", Some("7691_退库")),
        );
        append(
            dir.path(),
            "20261111",
            &line(2, r"C:\work\other\B.java", Some("别的")),
        );
        let half = line(3, r"C:\work\aier\newar\pu\C.java", None);
        append(dir.path(), "20261111", &half[..half.len() / 2]);
        let o = sync(&mut s, dir.path(), root);
        assert_eq!((o.found, o.added), (true, 1));
        assert_eq!(s.reqs.len(), 1, "工作区外的变更集不建需求");
        assert_eq!(s.reqs[0].name, "7691_退库");

        append(dir.path(), "20261111", &half[half.len() / 2..]);
        append(
            dir.path(),
            "20261112",
            &line(4, r"C:/Work/Aier/Newar/pu/A.java", Some("7691_退库")),
        );
        let o = sync(&mut s, dir.path(), root);
        assert_eq!(o.added, 2, "补全的半行 + 第二天的一条");
        let a = &s.touches[&key_of(r"C:\work\aier\newar\pu\A.java")];
        assert_eq!(a.len(), 2, "大小写不同仍是同一文件");
        assert_eq!(a[1].after_sha.as_deref(), Some("bb"));
        assert_eq!(a[1].client.as_deref(), Some("claude-code"));
        assert!(s.touches[&key_of(r"C:\work\aier\newar\pu\C.java")][0]
            .req
            .is_none());
        assert_eq!(
            sync(&mut s, dir.path(), root).added,
            0,
            "没有新内容不重复记"
        );
        assert_eq!(s.cursor.day, "20261112");
    }

    #[test]
    fn 旧文件被删与重复序号都不重复记_移动的源也归属() {
        let dir = tempfile::tempdir_in(crate::test_support::tmp("cc-journal-b")).unwrap();
        let root = "C:/w";
        let mut s = ReqStore::default();
        append(dir.path(), "20261110", &line(5, "C:/w/A.java", Some("X")));
        sync(&mut s, dir.path(), root);
        std::fs::remove_file(dir.path().join("changes-20261110.jsonl")).unwrap();
        // 故意重放一条旧序号：不应记入
        append(dir.path(), "20261111", &line(5, "C:/w/A.java", Some("X")));
        let mv = serde_json::json!({"v":1,"seq":6,"at":"2026-11-11T00:00:00Z","op":"move",
            "path":"C:/w/New.java","from":"C:/w/Old.java","changeSet":"X"})
        .to_string()
            + "\n";
        append(dir.path(), "20261111", &mv);
        append(
            dir.path(),
            "20261111",
            &(serde_json::json!({"v":2,"seq":7,"at":"x","op":"edit","path":"C:/w/A.java"})
                .to_string()
                + "\n"),
        );
        let o = sync(&mut s, dir.path(), root);
        assert_eq!(o.added, 1, "只有移动那条是新的；v=2 跳过");
        let x = s.by_name("X").unwrap().id.clone();
        assert_eq!(s.reqs_of(&key_of("C:/w/Old.java")), vec![x.clone()]);
        assert_eq!(s.reqs_of(&key_of("C:/w/New.java")), vec![x]);
    }
}
