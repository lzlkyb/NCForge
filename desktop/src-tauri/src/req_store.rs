//! 需求表：「按需求审查」的数据真源（规划见 docs/NCForge-cc-bridge联动-规划-2026-11-11.md）。
//!
//! 每个工作区一份 JSON，存在配置目录下，不进 SVN：
//! - 需求：名字（= 补丁名去掉日期）、别名（改名 / 合并前的名字）、状态、出包记录；
//! - 触达：哪个文件被哪个需求改过（来自 cc-bridge 变更日志，或在 NCForge 里手改保存）；
//! - 认领：用户把文件手工归到某个需求，优先于触达。
//!
//! 改动全集以 SVN 改动列表为准：这里只回答「某个改动文件属于哪些需求」。文件提交或还原后
//! 不再出现在 SVN 改动里，它的触达与认领由 [`ReqStore::prune`] 清掉，免得下次再改时误归旧需求。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// 名字长度上限（字符），与 cc-bridge 一致。
const NAME_MAX_CHARS: usize = 200;
/// 每个文件最多留几条触达（只留最新的）。归属只看「有哪些需求」，不需要全部历史。
const MAX_TOUCHES_PER_FILE: usize = 50;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReqStatus {
    Open,
    Closed,
}

/// 一次出包记录。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackRecord {
    pub zip: String,
    pub at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Requirement {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    pub status: ReqStatus,
    pub created_ms: u64,
    #[serde(default)]
    pub packages: Vec<PackRecord>,
}

/// 触达来源。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TouchSource {
    /// AI 经 cc-bridge 写入（变更日志）。
    Ai,
    /// 在 NCForge 里手改保存。
    Manual,
}

/// 一次对文件的改动。`req` 为空 = 改了但没声明属于哪个需求。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Touch {
    pub req: Option<String>,
    pub at_ms: u64,
    pub source: TouchSource,
    #[serde(default)]
    pub op: String,
    #[serde(default)]
    pub tool: Option<String>,
    #[serde(default)]
    pub client: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub before_sha: Option<String>,
    #[serde(default)]
    pub after_sha: Option<String>,
    #[serde(default)]
    pub backup: Option<String>,
    /// cc-bridge 序号；手改为 0。
    #[serde(default)]
    pub seq: u64,
}

/// 变更日志读到哪里了。
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalCursor {
    /// 正在读的文件日期（YYYYMMDD）。
    pub day: String,
    /// 该文件已读字节数（只到最后一个完整行）。
    pub offset: u64,
    /// 已处理的最大序号，用来去重。
    pub seq: u64,
    /// 最后一条属于本工作区的记录时间（毫秒），给界面判断「日志是不是没开」。
    #[serde(default)]
    pub last_at_ms: u64,
}

#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReqStore {
    #[serde(default)]
    pub reqs: Vec<Requirement>,
    /// 状态栏「当前需求」：在 NCForge 里手改保存的文件归到这里。
    #[serde(default)]
    pub current: Option<String>,
    /// 文件 key（见 [`key_of`]）→ 触达，按时间升序。
    #[serde(default)]
    pub touches: BTreeMap<String, Vec<Touch>>,
    /// 文件 key → 人工认领的需求 id。优先于触达。
    #[serde(default)]
    pub claims: BTreeMap<String, String>,
    /// 文件 key → 原样路径（key 是小写的，展示和对比要原样）。
    #[serde(default)]
    pub paths: BTreeMap<String, String>,
    #[serde(default)]
    pub cursor: JournalCursor,
}

/// 文件 key：小写 + 正斜杠，与 `svn_review::key_of` 同一口径。
pub fn key_of(path: &str) -> String {
    path.replace('\\', "/").to_lowercase()
}

/// 需求名清洗：与 cc-bridge 的 `normalize_change_set` 一致，变更日志里的名字与这里手输的名字才能逐字对上。
pub fn normalize_name(raw: &str) -> Option<String> {
    let cleaned: String = raw
        .trim()
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .take(NAME_MAX_CHARS)
        .collect();
    let cleaned = cleaned.trim().to_string();
    (!cleaned.is_empty()).then_some(cleaned)
}

fn new_id(now_ms: u64) -> String {
    static N: AtomicU64 = AtomicU64::new(0);
    format!("r{now_ms:x}{:x}", N.fetch_add(1, Ordering::Relaxed))
}

impl ReqStore {
    /// 每个工作区一份：文件名取根目录 key 的 sha256 前 16 位，避免路径里的盘符、斜杠。
    pub fn path(config_dir: &Path, root: &str) -> PathBuf {
        use sha2::{Digest, Sha256};
        let h = Sha256::digest(key_of(root).trim_end_matches('/').as_bytes());
        let hex: String = h.iter().take(8).map(|b| format!("{b:02x}")).collect();
        config_dir.join("requirements").join(format!("{hex}.json"))
    }

    /// 读盘。不存在返回空表；损坏时把坏文件改名保留再返回空表——不能静默覆盖掉用户建的需求。
    pub fn load(config_dir: &Path, root: &str) -> Self {
        let path = Self::path(config_dir, root);
        let Ok(text) = std::fs::read_to_string(&path) else {
            return Self::default();
        };
        match serde_json::from_str(&text) {
            Ok(s) => s,
            Err(e) => {
                let bad = path.with_extension(format!("bad-{}.json", now_ms()));
                let _ = std::fs::rename(&path, &bad);
                log::warn!("需求表损坏，已另存为 {bad:?} 并按空表处理：{e}");
                Self::default()
            }
        }
    }

    pub fn save(&self, config_dir: &Path, root: &str) -> Result<(), String> {
        let path = Self::path(config_dir, root);
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("创建需求目录失败: {e}"))?;
        }
        let text = serde_json::to_vec_pretty(self).map_err(|e| format!("序列化需求表失败: {e}"))?;
        crate::atomic_file::write_atomic(&path, &text)
    }

    pub fn find(&self, id: &str) -> Option<&Requirement> {
        self.reqs.iter().find(|r| r.id == id)
    }

    fn find_mut(&mut self, id: &str) -> Result<&mut Requirement, String> {
        self.reqs
            .iter_mut()
            .find(|r| r.id == id)
            .ok_or_else(|| "需求不存在（可能已被合并）".to_string())
    }

    /// 按名字或别名找需求（大小写敏感，与 cc-bridge 一致）。
    pub fn by_name(&self, name: &str) -> Option<&Requirement> {
        self.reqs
            .iter()
            .find(|r| r.name == name || r.aliases.iter().any(|a| a == name))
    }

    /// 新建需求；同名（含别名）已存在时报错。
    pub fn create(&mut self, raw: &str, now_ms: u64) -> Result<String, String> {
        let name = normalize_name(raw).ok_or("需求名不能为空")?;
        if let Some(r) = self.by_name(&name) {
            return Err(format!("已有同名需求「{}」", r.name));
        }
        Ok(self.insert(name, now_ms))
    }

    fn insert(&mut self, name: String, now_ms: u64) -> String {
        let id = new_id(now_ms);
        self.reqs.push(Requirement {
            id: id.clone(),
            name,
            aliases: Vec::new(),
            status: ReqStatus::Open,
            created_ms: now_ms,
            packages: Vec::new(),
        });
        id
    }

    /// 变更日志用：按名字取需求，没有就建；已关闭的又有新改动就重新打开。
    pub fn ensure(&mut self, name: &str, now_ms: u64) -> String {
        let found = self.by_name(name).map(|r| r.id.clone());
        match found {
            Some(id) => {
                if let Ok(r) = self.find_mut(&id) {
                    r.status = ReqStatus::Open;
                }
                id
            }
            None => self.insert(name.to_string(), now_ms),
        }
    }

    /// 改名：旧名进别名，模型之后用旧名写的条目照样归这里。
    pub fn rename(&mut self, id: &str, raw: &str) -> Result<(), String> {
        let name = normalize_name(raw).ok_or("需求名不能为空")?;
        if let Some(other) = self.by_name(&name) {
            if other.id != id {
                return Err(format!("已有同名需求「{}」，请用「合并」", other.name));
            }
        }
        let r = self.find_mut(id)?;
        if r.name == name {
            return Ok(());
        }
        let old = std::mem::replace(&mut r.name, name.clone());
        r.aliases.retain(|a| *a != name);
        if !r.aliases.contains(&old) {
            r.aliases.push(old);
        }
        Ok(())
    }

    /// 把 `from` 并进 `into`：名字与别名都变成 `into` 的别名，触达、认领、当前需求、出包记录全部改指。
    pub fn merge(&mut self, from: &str, into: &str) -> Result<(), String> {
        if from == into {
            return Err("不能合并到自己".into());
        }
        self.find(into).ok_or("目标需求不存在")?;
        let pos = self
            .reqs
            .iter()
            .position(|r| r.id == from)
            .ok_or("要合并的需求不存在")?;
        let gone = self.reqs.remove(pos);
        let target = self.find_mut(into)?;
        for n in std::iter::once(gone.name).chain(gone.aliases) {
            if n != target.name && !target.aliases.contains(&n) {
                target.aliases.push(n);
            }
        }
        target.packages.extend(gone.packages);
        target.status = ReqStatus::Open;
        for list in self.touches.values_mut() {
            for t in list.iter_mut() {
                if t.req.as_deref() == Some(from) {
                    t.req = Some(into.to_string());
                }
            }
        }
        for v in self.claims.values_mut() {
            if v == from {
                *v = into.to_string();
            }
        }
        if self.current.as_deref() == Some(from) {
            self.current = Some(into.to_string());
        }
        Ok(())
    }

    /// 关闭 / 重新打开。关闭时它的人工认领一并解除（文件回到未认领或已提交），当前需求也清掉。
    pub fn set_status(&mut self, id: &str, open: bool) -> Result<(), String> {
        self.find_mut(id)?.status = if open {
            ReqStatus::Open
        } else {
            ReqStatus::Closed
        };
        if !open {
            self.claims.retain(|_, v| v != id);
            if self.current.as_deref() == Some(id) {
                self.current = None;
            }
        }
        Ok(())
    }

    pub fn set_current(&mut self, id: Option<&str>) -> Result<(), String> {
        if let Some(id) = id {
            if self.find(id).ok_or("需求不存在")?.status == ReqStatus::Closed {
                return Err("已关闭的需求不能设为当前需求".into());
            }
        }
        self.current = id.map(str::to_string);
        Ok(())
    }

    /// 人工认领：`id = None` 解除认领。
    pub fn claim(&mut self, paths: &[String], id: Option<&str>) -> Result<(), String> {
        if let Some(id) = id {
            // 已关闭的需求不接收新文件：关闭时会解除它的认领，接收了也立刻失效。
            if self.find(id).ok_or("需求不存在")?.status == ReqStatus::Closed {
                return Err("需求已关闭，先重新打开再归入".into());
            }
        }
        for p in paths {
            let key = key_of(p);
            match id {
                Some(id) => {
                    self.claims.insert(key.clone(), id.to_string());
                    self.paths.insert(key, p.clone());
                }
                None => {
                    self.claims.remove(&key);
                }
            }
        }
        Ok(())
    }

    /// 记一次触达。同一文件只留最新的 [`MAX_TOUCHES_PER_FILE`] 条。
    pub fn touch(&mut self, path: &str, t: Touch) {
        let key = key_of(path);
        self.paths.insert(key.clone(), path.to_string());
        let list = self.touches.entry(key).or_default();
        list.push(t);
        if list.len() > MAX_TOUCHES_PER_FILE {
            let drop = list.len() - MAX_TOUCHES_PER_FILE;
            list.drain(..drop);
        }
    }

    /// 手改保存：归到当前需求；没选当前需求就记一条「无需求」的手改（界面上进未认领）。
    pub fn note_manual(&mut self, path: &str, now_ms: u64) {
        let req = self.current.clone();
        self.touch(
            path,
            Touch {
                req,
                at_ms: now_ms,
                source: TouchSource::Manual,
                op: "edit".into(),
                tool: None,
                client: None,
                reason: None,
                before_sha: None,
                after_sha: None,
                backup: None,
                seq: 0,
            },
        );
    }

    /// 只留仍在 SVN 改动里的文件：已提交 / 已还原的文件，它的历史对以后的归属没有意义，
    /// 留着反而会把下一次改动误归到旧需求。返回清掉的文件数。
    ///
    /// 调用方必须传**完整、成功**的一次扫描结果；扫描中途或失败时传进来会误删。
    pub fn prune(&mut self, changed: &std::collections::HashSet<String>) -> usize {
        let before = self.touches.len() + self.claims.len();
        self.touches.retain(|k, _| changed.contains(k));
        self.claims.retain(|k, _| changed.contains(k));
        let touches = &self.touches;
        let claims = &self.claims;
        self.paths
            .retain(|k, _| touches.contains_key(k) || claims.contains_key(k));
        before - (self.touches.len() + self.claims.len())
    }

    /// 一个文件属于哪些需求：有人工认领就只算认领；否则取触达里出现过的、未关闭的需求（按首次出现顺序）。
    pub fn reqs_of(&self, key: &str) -> Vec<String> {
        if let Some(id) = self.claims.get(key) {
            return vec![id.clone()];
        }
        let mut out: Vec<String> = Vec::new();
        for t in self.touches.get(key).into_iter().flatten() {
            let Some(id) = &t.req else { continue };
            let open = self.find(id).is_some_and(|r| r.status == ReqStatus::Open);
            if open && !out.contains(id) {
                out.push(id.clone());
            }
        }
        out
    }

    /// 与已有需求名很像的需求（疑似敲错）→ 建议合并到的需求 id。规则与 cc-bridge 的回显一致。
    pub fn merge_hint(&self, id: &str) -> Option<String> {
        let me = self.find(id)?;
        self.reqs
            .iter()
            .filter(|r| r.id != id && r.status == ReqStatus::Open && r.created_ms <= me.created_ms)
            .filter_map(|r| similarity(&me.name, &r.name).map(|d| (d, r.id.clone())))
            .min()
            .map(|(_, id)| id)
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 两个名字是否「只差一点」，是则返回距离（越小越像）。
/// 忽略大小写与 `_` `-` 空格后相同、一个包含另一个（如后补了清单号）、或编辑距离很小。
fn similarity(a: &str, b: &str) -> Option<usize> {
    let squash = |s: &str| -> Vec<char> {
        s.chars()
            .filter(|c| !matches!(c, '_' | '-' | ' '))
            .flat_map(char::to_lowercase)
            .collect()
    };
    let (x, y) = (squash(a), squash(b));
    if x.is_empty() || y.is_empty() {
        return None;
    }
    if x == y {
        return Some(0);
    }
    let (short, long) = if x.len() <= y.len() {
        (&x, &y)
    } else {
        (&y, &x)
    };
    if short.len() >= 4 && long.windows(short.len()).any(|w| w == short.as_slice()) {
        return Some(1);
    }
    let limit = (short.len() / 8).clamp(1, 3);
    let d = levenshtein(&x, &y);
    (d <= limit).then_some(d)
}

fn levenshtein(a: &[char], b: &[char]) -> usize {
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0; b.len() + 1];
    for (i, ca) in a.iter().enumerate() {
        cur[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let cost = usize::from(ca != cb);
            cur[j + 1] = (prev[j + 1] + 1).min(cur[j] + 1).min(prev[j] + cost);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn ai(req: Option<&str>, at: u64) -> Touch {
        Touch {
            req: req.map(str::to_string),
            at_ms: at,
            source: TouchSource::Ai,
            op: "edit".into(),
            tool: None,
            client: None,
            reason: None,
            before_sha: None,
            after_sha: None,
            backup: None,
            seq: at,
        }
    }

    #[test]
    fn 名字清洗与同名拦截() {
        let mut s = ReqStore::default();
        assert_eq!(normalize_name("  a/b:c  ").as_deref(), Some("a_b_c"));
        assert!(s.create("   ", 1).is_err());
        let id = s.create("7691_退库", 1).unwrap();
        assert!(s.create("7691_退库", 2).is_err(), "同名要拦");
        s.rename(&id, "7691_退库锁库存").unwrap();
        assert!(s.create("7691_退库", 3).is_err(), "旧名已是别名，也要拦");
        assert_eq!(s.by_name("7691_退库").unwrap().id, id);
    }

    #[test]
    fn 合并后触达认领当前需求全部改指() {
        let mut s = ReqStore::default();
        let a = s.create("退库锁库存", 1).unwrap();
        let b = s.create("7691_退库锁库存", 2).unwrap();
        s.touch("C:/w/A.java", ai(Some(&a), 10));
        s.claim(&["C:/w/B.java".into()], Some(&a)).unwrap();
        s.set_current(Some(&a)).unwrap();
        assert_eq!(s.merge_hint(&b), Some(a.clone()), "后补清单号应提示合并");
        s.merge(&a, &b).unwrap();
        assert!(s.find(&a).is_none());
        assert_eq!(s.reqs_of(&key_of("C:/w/A.java")), vec![b.clone()]);
        assert_eq!(s.reqs_of(&key_of("C:/w/B.java")), vec![b.clone()]);
        assert_eq!(s.current.as_deref(), Some(b.as_str()));
        assert_eq!(s.by_name("退库锁库存").unwrap().id, b, "旧名字进别名");
    }

    #[test]
    fn 归属_认领优先_关闭的需求不算_混改两个都算() {
        let mut s = ReqStore::default();
        let a = s.create("A需求", 1).unwrap();
        let b = s.create("B需求", 2).unwrap();
        let k = key_of("C:/w/X.java");
        s.touch("C:/w/X.java", ai(Some(&a), 10));
        s.touch("C:/w/X.java", ai(None, 11));
        s.touch("C:/w/X.java", ai(Some(&b), 12));
        assert_eq!(s.reqs_of(&k), vec![a.clone(), b.clone()], "混改");
        s.set_status(&a, false).unwrap();
        assert_eq!(s.reqs_of(&k), vec![b.clone()]);
        s.claim(&["C:/w/X.java".into()], Some(&a)).unwrap_err();
        s.set_status(&a, true).unwrap();
        s.claim(&["C:/w/X.java".into()], Some(&a)).unwrap();
        assert_eq!(s.reqs_of(&k), vec![a.clone()], "认领优先");
        s.set_status(&a, false).unwrap();
        assert_eq!(s.reqs_of(&k), vec![b], "关闭时认领解除");
    }

    #[test]
    fn 清理只留仍在改动里的文件_手改归当前需求() {
        let mut s = ReqStore::default();
        let a = s.create("A", 1).unwrap();
        s.set_current(Some(&a)).unwrap();
        s.note_manual("C:/w/Keep.java", 5);
        s.note_manual("C:/w/Gone.java", 6);
        let changed: HashSet<String> = [key_of("C:/w/Keep.java")].into();
        assert_eq!(s.prune(&changed), 1);
        assert_eq!(s.reqs_of(&key_of("C:/w/Keep.java")), vec![a]);
        assert!(!s.paths.contains_key(&key_of("C:/w/Gone.java")));
        s.set_current(None).unwrap();
        s.note_manual("C:/w/Keep.java", 7);
        assert_eq!(
            s.touches[&key_of("C:/w/Keep.java")].last().unwrap().req,
            None
        );
    }

    #[test]
    fn 触达条数有上限_已关闭需求有新改动会重开() {
        let mut s = ReqStore::default();
        for i in 0..(MAX_TOUCHES_PER_FILE as u64 + 5) {
            s.touch("C:/w/A.java", ai(None, i));
        }
        let list = &s.touches[&key_of("C:/w/A.java")];
        assert_eq!(list.len(), MAX_TOUCHES_PER_FILE);
        assert_eq!(list[0].at_ms, 5, "丢的是最旧的");
        let id = s.ensure("新需求", 1);
        s.set_status(&id, false).unwrap();
        assert_eq!(s.ensure("新需求", 2), id);
        assert_eq!(s.find(&id).unwrap().status, ReqStatus::Open);
    }

    #[test]
    fn 持久化_每个工作区一份_损坏文件另存不覆盖() {
        let dir = tempfile::tempdir_in(crate::test_support::tmp("req-store")).unwrap();
        let mut s = ReqStore::default();
        s.create("A", 1).unwrap();
        s.save(dir.path(), "C:/work/aier/newar").unwrap();
        assert_eq!(
            ReqStore::load(dir.path(), r"C:\Work\Aier\Newar\")
                .reqs
                .len(),
            1,
            "大小写与斜杠不影响"
        );
        assert!(ReqStore::load(dir.path(), "C:/work/other").reqs.is_empty());
        let p = ReqStore::path(dir.path(), "C:/work/aier/newar");
        std::fs::write(&p, b"{oops").unwrap();
        assert!(ReqStore::load(dir.path(), "C:/work/aier/newar")
            .reqs
            .is_empty());
        let kept = std::fs::read_dir(p.parent().unwrap())
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .contains("bad-")
            })
            .count();
        assert_eq!(kept, 1, "损坏文件要另存保留");
    }
}
