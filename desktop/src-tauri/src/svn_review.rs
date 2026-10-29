//! 「已审」标记的本地存储。
//!
//! 设计约束（决定这里必须存什么）：
//! - 标记**不进 SVN**，是审查进度的本地记录，存在配置目录的 JSON 里；
//! - 必须能自动失效：同一个文件的 BASE 版本变了（别人提交了 / 自己更新了），
//!   或者文件在本地又被改过（mtime/size 变了），旧结论就不能再算数——
//!   否则会出现「界面说已审、实际内容已经不是审过的那份」，比不标更危险。
//!
//! 所以一条标记记住四元组：路径 + BASE 版本号 + mtime + size，四项全等才算有效。

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ReviewMark {
    /// 标记时看到的 BASE 版本号（未纳管文件为 -1）。
    pub revision: i64,
    /// 原始大小写（与盘上完全一致）的绝对路径。
    ///
    /// 存储用的 key 是小写化的（Windows 大小写不敏感，同一文件不能存两条）。但 key
    /// 还会被当成**文件系统路径**去 stat（`valid_marks` / `retain_valid`）：在大小写
    /// 敏感的系统上（macOS、Linux，CI 就是在上面跑的），小写化后的 `d:/work/a.java`
    /// 根本不存在，于是每一条标记都被判成「文件不在了」而静默失效。所以另存一份原样
    /// 路径。`#[serde(default)]` 用于读老版本写下的标记：那时没有这个字段，读回来是
    /// 空串，`fs_path` 会退回 key（Windows 上仍然可用，正是老记录的产生环境）。
    #[serde(default)]
    pub path: String,
    /// 文件修改时间（毫秒）。用毫秒而不是秒：同一秒内改两次是常事。
    pub mtime_ms: u64,
    pub size: u64,
    /// 标记时间（毫秒），只用于展示「什么时候审的」。
    pub at_ms: u64,
}

impl ReviewMark {
    /// 拿去 stat 的路径：优先原样路径，老记录（没有 `path` 字段）退回 key。
    pub fn fs_path<'a>(&'a self, key: &'a str) -> &'a Path {
        Path::new(if self.path.is_empty() {
            key
        } else {
            self.path.as_str()
        })
    }
}

/// 一条标记此刻是否还算数。
pub fn is_valid(mark: &ReviewMark, revision: i64, mtime_ms: u64, size: u64) -> bool {
    mark.revision == revision && mark.mtime_ms == mtime_ms && mark.size == size
}

/// 存储用的 key：Windows 路径大小写不敏感，统一小写 + 正斜杠，避免同一文件两条记录。
pub fn key_of(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").to_lowercase()
}

fn mtime_ms(path: &Path) -> Option<u64> {
    let md = std::fs::metadata(path).ok()?;
    let t = md.modified().ok()?;
    Some(t.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as u64)
}

/// 仍然有效的标记（返回 key 列表）。
///
/// 四项全等见 `is_valid`：**BASE 版本号 + mtime + 长度**，外加「文件还在」。
/// `revisions` 是本次扫描每个条目的 BASE 版本号——以前调用方只比 mtime/size，
/// `is_valid` 的 revision 参数在生产代码里从没被喂过真值，等于「版本变了就失效」
/// 这条承诺没实现。现在按扫描结果比对：别人提交了这个文件、或自己更新过，旧结论立刻作废。
///
/// 不在本次改动列表里的 key（已经干净 / 已提交）拿不到新版本号，退回标记自己记的
/// 那个——不让 revision 维度把它们误杀（它们的 mtime/size 检查照旧）。
///
/// stat 的是 `mark.path`（原始大小写），不是小写化的 key，理由见 `ReviewMark::path`。
pub fn valid_marks(store: &ReviewStore, revisions: &HashMap<String, i64>) -> Vec<String> {
    let mut out = Vec::new();
    for (key, mark) in &store.marks {
        let p = mark.fs_path(key);
        let (Some(mt), Ok(md)) = (mtime_ms(p), std::fs::metadata(p)) else {
            continue;
        };
        let rev = revisions.get(key).copied().unwrap_or(mark.revision);
        if is_valid(mark, rev, mt, md.len()) {
            out.push(key.clone());
        }
    }
    out
}

/// 标记表：key → 标记。
#[derive(Debug, Default, Clone, serde::Serialize, serde::Deserialize)]
pub struct ReviewStore {
    #[serde(flatten)]
    pub marks: BTreeMap<String, ReviewMark>,
}

impl ReviewStore {
    pub fn path(config_dir: &Path) -> PathBuf {
        config_dir.join("svn-review.json")
    }
    /// 读盘。文件不存在/损坏都返回空表——审查进度丢了不值得打断用户。
    pub fn load(config_dir: &Path) -> Self {
        let path = Self::path(config_dir);
        match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
                log::warn!("审查标记损坏，按空表处理（{path:?}: {e}）");
                Self::default()
            }),
            Err(_) => Self::default(),
        }
    }

    pub fn save(&self, config_dir: &Path) -> Result<(), String> {
        let path = Self::path(config_dir);
        let text =
            serde_json::to_string_pretty(self).map_err(|e| format!("序列化审查标记失败: {e}"))?;
        std::fs::write(&path, text).map_err(|e| format!("写审查标记失败: {e}"))
    }

    /// 清理失效标记，返回剩余条数。
    ///
    /// 这里**只比 mtime/size**：BASE 版本号只有扫工作副本状态时才知道，
    /// 那一刻由调用方（`svn_status`）顺带比，所以不在磁盘清理这条路径上。
    ///
    /// `probe` 同时拿到 key 与整条标记：要 stat 的是 `mark.path`（原始大小写），
    /// 而不是 key（小写化后可能是个不存在的路径，见 `ReviewMark::path`）。
    pub fn retain_valid(
        &mut self,
        probe: impl Fn(&str, &ReviewMark) -> Option<(u64, u64)>,
    ) -> usize {
        self.marks.retain(|key, mark| match probe(key, mark) {
            Some((mtime, size)) => mark.mtime_ms == mtime && mark.size == size,
            // 文件不在了（被删/改名）就丢掉标记
            None => false,
        });
        self.marks.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 四项全等才算有效() {
        let m = ReviewMark {
            revision: 14231,
            path: String::new(),
            mtime_ms: 1_700_000_000_123,
            size: 4096,
            at_ms: 0,
        };
        assert!(is_valid(&m, 14231, 1_700_000_000_123, 4096));
        assert!(
            !is_valid(&m, 14232, 1_700_000_000_123, 4096),
            "版本变了要失效"
        );
        assert!(
            !is_valid(&m, 14231, 1_700_000_000_999, 4096),
            "改动过要失效"
        );
        assert!(
            !is_valid(&m, 14231, 1_700_000_000_123, 4097),
            "长度变了要失效"
        );
    }

    #[test]
    fn key_大小写与斜杠归一() {
        let a = key_of(Path::new(r"C:\work\aier\Newar\PU\A.java"));
        let b = key_of(Path::new("c:/work/aier/newar/pu/a.java"));
        assert_eq!(a, b);
    }

    #[test]
    fn 清理失效标记_文件消失也算失效() {
        let mut s = ReviewStore::default();
        s.marks.insert(
            "c:/a.java".into(),
            ReviewMark {
                revision: 1,
                path: String::new(),
                mtime_ms: 10,
                size: 100,
                at_ms: 0,
            },
        );
        s.marks.insert(
            "c:/b.java".into(),
            ReviewMark {
                revision: 2,
                path: String::new(),
                mtime_ms: 20,
                size: 200,
                at_ms: 0,
            },
        );
        let n = s.retain_valid(|k, _m| match k {
            "c:/a.java" => Some((10, 100)),
            _ => None, // b.java 已不存在
        });
        assert_eq!(n, 1);
        assert!(s.marks.contains_key("c:/a.java"));
    }

    #[test]
    fn 标记按本次扫描的版本号失效() {
        // 真文件：valid_marks 要 stat，塞假数据测不出「版本变了但文件没动」这一类
        let dir = std::env::temp_dir().join(format!(
            "ncforge-rv-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("A.java");
        std::fs::write(&file, b"abcd").unwrap();

        let key = key_of(&file);
        let mut store = ReviewStore::default();
        store.marks.insert(
            key.clone(),
            ReviewMark {
                revision: 5,
                path: file.display().to_string(),
                mtime_ms: mtime_ms(&file).unwrap(),
                size: 4,
                at_ms: 0,
            },
        );

        // 版本一致 → 有效
        assert_eq!(
            valid_marks(&store, &HashMap::from([(key.clone(), 5)])),
            vec![key.clone()]
        );
        // 版本变了（别人提交了这个文件 / 自己更新过）→ 立即失效，哪怕文件一个字节都没动
        assert!(
            valid_marks(&store, &HashMap::from([(key.clone(), 6)])).is_empty(),
            "BASE 版本变了，旧结论不能再算数"
        );
        // 本次扫描没列出这个文件（已经干净）：退回标记自己的版本，不误杀
        assert_eq!(valid_marks(&store, &HashMap::new()), vec![key.clone()]);

        // 内容变了（长度不同）→ 失效
        std::fs::write(&file, b"abcde").unwrap();
        assert!(valid_marks(&store, &HashMap::from([(key, 5)])).is_empty());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 标记里存原样路径_stat_不用小写化的_key() {
        let on_disk = ReviewMark {
            revision: 1,
            path: "D:/work/Aier/Newar/PU/A.java".into(),
            mtime_ms: 1,
            size: 2,
            at_ms: 0,
        };
        // 原样路径优先：大小写敏感的盘上只有这一个能 stat 到
        assert_eq!(
            on_disk.fs_path("d:/work/aier/newar/pu/a.java"),
            Path::new("D:/work/Aier/Newar/PU/A.java")
        );
        // 老记录没有 path 字段：退回 key（Windows 上照样能用）
        let legacy = ReviewMark {
            revision: 1,
            path: String::new(),
            mtime_ms: 1,
            size: 2,
            at_ms: 0,
        };
        assert_eq!(
            legacy.fs_path("c:/work/aier/a.java"),
            Path::new("c:/work/aier/a.java")
        );
    }
}
