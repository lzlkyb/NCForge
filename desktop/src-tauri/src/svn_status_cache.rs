//! SVN 状态的增量缓存：脏模块记账 + 上次扫描结果落盘。
//!
//! 为什么需要它：一次全量 `svn status` 在这台机器的工作副本上要 7.6 秒（热缓存）
//! 到 54 秒（冷缓存），而用户真正关心的只是「哪几个模块有改动」。Subclipse 的做法
//! 是用 Eclipse 的资源增量只重扫变化目录；我们没有 resource delta，但 `watcher.rs`
//! 已经用 notify 盯着整棵工作区，于是让它顺手维护「哪个模块脏了」。
//!
//! **三条安全底线，破了会静默漏改动 —— 那比慢严重得多：**
//! 1. 只有**本进程**扫过的缓存才可信（[`StatusCache::usable`] 比 `session`）：
//!    应用关着的时候 Eclipse / 命令行改成什么样 watcher 都看不见，跨进程复用缓存
//!    等于把那些改动藏起来。
//! 2. **丢过事件就必须全量**（`lost_at`）：队列溢出或平台报「事件可能丢失」之后，
//!    脏集合已经不再完整，「没脏」这个结论也就不成立。
//! 3. **提交预检永远全量**（`svn_cmds::svn_status(force)`）：漏一个文件就是漏一次
//!    提交，这里省下的几秒钟远不值得。
//!
//! 模块的划分与 Java 桥一致：工作副本根算一个单元（模块名 `""`，只扫直接子项），
//! 每个一级目录算一个。桥按同样的划分扫、按同样的名字回报，两边才能对得上。

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use crate::svn_view::RawEntry;

/// 缓存文件名（放在 `{config_dir}/svn/` 下，与 SVNKit 自己的 config 同目录）。
pub const CACHE_FILE: &str = "status-cache.json";

/// 条目总数上限：超过就不落盘。正常工作副本只有几十条，几百 MB 的 JSON
/// 只会拖慢启动时的解析，而那种量级本来也不该走增量。
const MAX_CACHED_ENTRIES: usize = 20_000;

/// 本进程的会话号：进程启动时刻的毫秒时间戳。
///
/// 只用「是不是这个进程写的」这一件事，不参与业务判断，所以时间戳足够。
fn session_id() -> u64 {
    static ID: OnceLock<u64> = OnceLock::new();
    *ID.get_or_init(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    })
}

/// 全局单调序号：所有「脏」与「丢失」都挂在这条线上，扫描起点也是一个序号。
fn next_seq() -> u64 {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    SEQ.fetch_add(1, Ordering::Relaxed) + 1
}

#[derive(Default)]
struct Dirty {
    /// 模块名 → 最后一次变脏的序号。序号大于扫描起点的条目说明「扫描期间又变了」，
    /// 这一轮不能用它的新结果，得留给下一轮。
    modules: BTreeMap<String, u64>,
    /// 脏集合已经不可信的起点序号（watcher 刚起 / 丢过事件）。
    lost_at: Option<u64>,
}

/// 按工作副本根分别记账：换工作区之后再切回来，旧根的记录还在（但会因
/// `watch_root` 重新置「不可信」，见下）。
static DIRTY: Mutex<BTreeMap<PathBuf, Dirty>> = Mutex::new(BTreeMap::new());

/// 一次扫描起点。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirtyView {
    /// 本次扫描的起点序号，扫描成功后交给 [`settle`]。
    pub point: u64,
    /// 需要重扫的模块。`None` = 脏集合不可信，**必须全量**。
    pub modules: Option<BTreeSet<String>>,
}

/// 路径属于哪个模块（与 Java 桥的划分一致）。
///
/// - `<root>/x/A.java` → `"x"`
/// - `<root>/a.java`、`<root>` 自身 → `""`（根层）
/// - `<root>/.svn/entries` → `""`、`<root>/x/.svn/entries` → `"x"`
///   元数据目录不是模块，它变了说明**它所在的那个目录**的条目变了（SVN 1.6 的
///   「每目录一份 .svn」），所以归属要看 `.svn` 前面那一段。
pub fn module_of(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let segs: Vec<&str> = rel
        .components()
        .filter_map(|c| match c {
            Component::Normal(s) => s.to_str(),
            _ => None,
        })
        .collect();
    match segs.as_slice() {
        // 根自己，或者只有一段（直接子项，由根层的 IMMEDIATES 覆盖）
        [] | [_] => Some(String::new()),
        // `<root>/.svn/entries`：根那一层的元数据变了，归根模块
        [first, ..] if is_meta(first) => Some(String::new()),
        // `<模块>/…` 与 `<模块>/.svn/…` 都归这个模块
        [module, ..] => Some((*module).to_string()),
    }
}

/// 元数据目录名（`watcher.rs` 的忽略表，比较忽略大小写）。
fn is_meta(name: &str) -> bool {
    [".svn", ".git", ".idea"]
        .iter()
        .any(|d| name.eq_ignore_ascii_case(d))
}

/// watcher 起来（或换了工作区）时登记一次。
///
/// 每次都置「不可信」：切工作区期间旧根没人盯着，同根重启也说明中间断过。
/// 代价只是多一次全量扫描，换来的是「增量绝不漏改动」。
pub fn watch_root(root: &Path) {
    let mut map = match DIRTY.lock() {
        Ok(m) => m,
        Err(p) => p.into_inner(),
    };
    let seq = next_seq();
    let d = map.entry(root.to_path_buf()).or_default();
    d.lost_at = Some(seq);
}

/// 记录一批「工作副本里有东西变了」的路径。`lost` = 这批事件不完整（队列溢出）。
pub fn mark_dirty(root: &Path, paths: &[PathBuf], lost: bool) {
    if paths.is_empty() && !lost {
        return;
    }
    let mut map = match DIRTY.lock() {
        Ok(m) => m,
        Err(p) => p.into_inner(),
    };
    let seq = next_seq();
    let d = map.entry(root.to_path_buf()).or_default();
    if lost {
        d.lost_at = Some(seq);
    }
    // 同一批共用一个序号：这一批里的先后顺序对增量没有意义
    for p in paths {
        if let Some(m) = module_of(root, p) {
            d.modules.insert(m, seq);
        }
    }
}

/// 取本次扫描的起点与要扫的模块。
pub fn dirty_snapshot(root: &Path) -> DirtyView {
    let point = next_seq();
    let map = match DIRTY.lock() {
        Ok(m) => m,
        Err(p) => p.into_inner(),
    };
    match map.get(root) {
        // 没登记过（watcher 没跑起来）或丢过事件：只能全量
        Some(d) if d.lost_at.is_none() => DirtyView {
            point,
            modules: Some(d.modules.keys().cloned().collect()),
        },
        _ => DirtyView {
            point,
            modules: None,
        },
    }
}

/// 扫描成功之后收账：清掉「起点之前」的脏标记。
///
/// 用序号而不是直接清空，是因为扫描期间（尤其全量那十几秒）还会不断有事件进来：
/// 那些事件的序号比 `point` 大，属于「这一轮没读到」的改动，必须留着。
pub fn settle(root: &Path, point: u64) {
    let mut map = match DIRTY.lock() {
        Ok(m) => m,
        Err(p) => p.into_inner(),
    };
    if let Some(d) = map.get_mut(root) {
        d.modules.retain(|_, v| *v > point);
        if d.lost_at.is_some_and(|s| s <= point) {
            d.lost_at = None;
        }
    }
}

/// 落盘的上次扫描结果。
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusCache {
    /// 写这份缓存的进程会话号，见 [`session_id`]。
    pub session: u64,
    /// 工作副本根（与 `svn_status` 里用的字符串同一形态）。
    pub root: String,
    pub generated_at_ms: u64,
    /// 模块名 → 该模块上次的原始条目。
    pub modules: BTreeMap<String, Vec<RawEntry>>,
}

impl StatusCache {
    /// 这份缓存能不能用来做增量。
    pub fn usable(&self, root: &str) -> bool {
        self.session == session_id() && self.root == root
    }

    pub fn empty(root: &str, generated_at_ms: u64) -> Self {
        Self {
            session: session_id(),
            root: root.to_string(),
            generated_at_ms,
            modules: BTreeMap::new(),
        }
    }

    /// 把这一轮扫到的模块合并进来。
    ///
    /// `requested` 是**请求**要扫的模块：请求了却不在 `scanned` 里的说明它已经不是
    /// 一个目录（增量期间被删 / 改名），它的旧条目必须抹掉 —— 留着会让已删除的模块
    /// 一直挂在改动列表上。
    pub fn merge(
        &mut self,
        requested: &BTreeSet<String>,
        scanned: &BTreeMap<String, Vec<RawEntry>>,
        generated_at_ms: u64,
    ) {
        for name in requested {
            match scanned.get(name) {
                Some(items) => {
                    self.modules.insert(name.clone(), items.clone());
                }
                None => {
                    self.modules.remove(name);
                }
            }
        }
        self.generated_at_ms = generated_at_ms;
    }

    /// 全量结果整体替换（不能合并：模块被删时旧条目会留在缓存里）。
    pub fn replace(&mut self, scanned: &BTreeMap<String, Vec<RawEntry>>, generated_at_ms: u64) {
        self.modules = scanned.clone();
        self.generated_at_ms = generated_at_ms;
    }

    /// 去掉目录已经不存在的模块。
    ///
    /// 增量只重扫「脏」的模块，而 `svn mv` / 删除一个模块目录时，**新旧名字都不会**
    /// 出现在这次的 `requested` 里（事件报的是新路径，旧名字没人提），旧条目就会
    /// 一直挂在改动列表上。一次 `is_dir` 换掉这个坑。
    pub fn prune_missing(&mut self, root: &Path) {
        self.modules
            .retain(|name, _| name.is_empty() || root.join(name).is_dir());
    }

    /// 所有模块的条目拍平（顺序按模块名，模块内保持桥返回的顺序）。
    pub fn flatten(&self) -> Vec<RawEntry> {
        self.modules
            .values()
            .flat_map(|items| items.iter().cloned())
            .collect()
    }

    pub fn entry_count(&self) -> usize {
        self.modules.values().map(|v| v.len()).sum()
    }
}

pub fn cache_path(config_dir: &Path) -> PathBuf {
    config_dir.join("svn").join(CACHE_FILE)
}

/// 读缓存。坏文件 / 旧格式一律当没有 —— 缓存丢了只是慢一次，绝不值得报错。
pub fn load(config_dir: &Path) -> Option<StatusCache> {
    let bytes = std::fs::read(cache_path(config_dir)).ok()?;
    serde_json::from_slice::<StatusCache>(&bytes).ok()
}

/// 写缓存。失败只影响下一次的启动速度，不打断当前扫描。
pub fn save(config_dir: &Path, cache: &StatusCache) {
    if cache.entry_count() > MAX_CACHED_ENTRIES {
        return;
    }
    let path = cache_path(config_dir);
    if let Some(dir) = path.parent() {
        if std::fs::create_dir_all(dir).is_err() {
            return;
        }
    }
    if let Ok(bytes) = serde_json::to_vec(cache) {
        let _ = crate::atomic_file::write_atomic(&path, &bytes);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root(name: &str) -> PathBuf {
        crate::test_support::tmp(name)
    }

    fn raw(path: &str, status: &str) -> RawEntry {
        RawEntry {
            path: path.to_string(),
            status: status.to_string(),
            revision: 1,
            dir: false,
        }
    }

    #[test]
    fn 模块归属与桥的划分一致() {
        // `PathBuf::from("C:")` 是「C 盘的当前目录」而不是根，join 出来的相对路径
        // strip_prefix 会失败 —— 这里必须要真绝对路径。
        let r = PathBuf::from("C:/ws");
        let cases = [
            ("C:/ws/x/A.java", "x"),
            ("C:/ws/a.java", ""),
            ("C:/ws", ""),
            // 元数据目录归属它所在的那一层
            ("C:/ws/.svn/entries", ""),
            ("C:/ws/x/.svn/entries", "x"),
            ("C:/ws/x/.svn", "x"),
        ];
        for (p, want) in cases {
            assert_eq!(module_of(&r, Path::new(p)).as_deref(), Some(want), "{p}");
        }
        // 工作副本之外：不关心
        assert_eq!(module_of(&r, Path::new("C:/other/x/A.java")), None);
    }

    #[test]
    fn 没登记过的根必须全量() {
        let r = root("svn-cache-unwatched");
        assert_eq!(dirty_snapshot(&r).modules, None);
    }

    #[test]
    fn 登记之后只扫变脏的模块() {
        let r = root("svn-cache-dirty");
        watch_root(&r);
        // 刚起来时不可信
        let first = dirty_snapshot(&r);
        assert_eq!(first.modules, None);
        settle(&r, first.point);

        let after = dirty_snapshot(&r);
        assert_eq!(after.modules, Some(BTreeSet::new()), "全量之后应该是空的");
        settle(&r, after.point);

        mark_dirty(&r, &[r.join("pu").join("A.java")], false);
        mark_dirty(&r, &[r.join("ic").join("B.java")], false);
        let view = dirty_snapshot(&r);
        let got = view.modules.expect("应该只扫脏模块");
        assert_eq!(
            got,
            BTreeSet::from(["pu".to_string(), "ic".to_string()]),
            "两个模块都脏了"
        );
        settle(&r, view.point);
        assert_eq!(dirty_snapshot(&r).modules, Some(BTreeSet::new()));
    }

    #[test]
    fn 扫描期间的新改动不会被这一轮清掉() {
        let r = root("svn-cache-race");
        watch_root(&r);
        settle(&r, dirty_snapshot(&r).point);
        mark_dirty(&r, &[r.join("pu").join("A.java")], false);

        // 扫描开始
        let view = dirty_snapshot(&r);
        assert_eq!(view.modules.as_ref().map(|s| s.len()), Some(1));
        // 扫描过程中又改了另一个模块
        mark_dirty(&r, &[r.join("ic").join("B.java")], false);
        settle(&r, view.point);

        let left = dirty_snapshot(&r).modules.expect("应该还有脏模块");
        assert_eq!(
            left,
            BTreeSet::from(["ic".to_string()]),
            "pu 已被这一轮覆盖，ic 是扫描期间变的，必须留到下一轮"
        );
    }

    #[test]
    fn 丢过事件就要重新全量() {
        let r = root("svn-cache-lost");
        watch_root(&r);
        settle(&r, dirty_snapshot(&r).point);
        assert!(dirty_snapshot(&r).modules.is_some());

        mark_dirty(&r, &[r.join("pu").join("A.java")], true);
        assert_eq!(
            dirty_snapshot(&r).modules,
            None,
            "事件不完整时「没脏」的结论不成立，必须全量"
        );
        // 全量扫完之后恢复
        settle(&r, dirty_snapshot(&r).point);
        assert!(dirty_snapshot(&r).modules.is_some());
    }

    #[test]
    fn 另一个根的脏标记不会串味() {
        let a = root("svn-cache-a");
        let b = root("svn-cache-b");
        watch_root(&a);
        settle(&a, dirty_snapshot(&a).point);
        mark_dirty(&a, &[a.join("pu").join("A.java")], false);
        // b 从没登记过 → 全量，而不是拿到 a 的模块
        assert_eq!(dirty_snapshot(&b).modules, None);
        assert_eq!(
            dirty_snapshot(&a).modules.as_ref().map(|s| s.len()),
            Some(1)
        );
    }

    #[test]
    fn 缓存去掉被删除的模块_保留其他模块() {
        let mut c = StatusCache::empty("C:/ws", 1);
        c.replace(
            &BTreeMap::from([
                ("pu".to_string(), vec![raw("C:/ws/pu/A.java", "modified")]),
                ("ic".to_string(), vec![raw("C:/ws/ic/B.java", "modified")]),
            ]),
            1,
        );
        let requested = BTreeSet::from(["pu".to_string(), "ic".to_string()]);
        // ic 这一轮请求了但桥没返回（目录没了）
        c.merge(
            &requested,
            &BTreeMap::from([("pu".to_string(), vec![raw("C:/ws/pu/A.java", "added")])]),
            2,
        );
        assert_eq!(c.modules.len(), 1, "已消失的模块必须从缓存里去掉");
        assert_eq!(c.modules["pu"][0].status, "added");
        assert_eq!(c.generated_at_ms, 2);
    }

    #[test]
    fn 增量之后抹掉已改名的模块目录() {
        let root = crate::test_support::tmp("svn-cache-prune");
        std::fs::create_dir_all(root.join("pu")).expect("建模块目录");
        let mut c = StatusCache::empty("ws", 1);
        c.replace(
            &BTreeMap::from([
                (String::new(), vec![raw("ws/.module_prj", "modified")]),
                ("pu".to_string(), vec![raw("ws/pu/A.java", "modified")]),
                // 这个模块目录已经被改名 / 删掉了
                ("gone".to_string(), vec![raw("ws/gone/B.java", "modified")]),
            ]),
            1,
        );
        c.prune_missing(&root);
        assert_eq!(
            c.modules.keys().cloned().collect::<Vec<_>>(),
            vec![String::new(), "pu".to_string()],
            "根层永远保留，存在的模块保留，消失的剔除"
        );
    }

    #[test]
    fn 落盘往返并区分会话() {
        let dir = crate::test_support::tmp("svn-cache-disk");
        let mut c = StatusCache::empty("C:/ws", 7);
        c.replace(
            &BTreeMap::from([("pu".to_string(), vec![raw("C:/ws/pu/A.java", "modified")])]),
            7,
        );
        save(&dir, &c);
        let back = load(&dir).expect("应该读得回来");
        assert_eq!(back.flatten().len(), 1);
        assert_eq!(back.generated_at_ms, 7);
        assert!(back.usable("C:/ws"));
        assert!(!back.usable("C:/other"), "根不同不能用");
        // 换个会话号（模拟上次运行留下的）就应该判不可用
        let mut other = back.clone();
        other.session = session_id().wrapping_add(1);
        assert!(!other.usable("C:/ws"), "跨进程缓存不可信");
    }

    #[test]
    fn 坏缓存文件当没有() {
        let dir = crate::test_support::tmp("svn-cache-bad");
        std::fs::create_dir_all(cache_path(&dir).parent().unwrap()).expect("建目录");
        std::fs::write(cache_path(&dir), b"{ not json").expect("写坏文件");
        assert!(load(&dir).is_none());
    }
}
