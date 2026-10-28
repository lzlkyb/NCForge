//! 「已审」标记的本地存储。
//!
//! 设计约束（决定这里必须存什么）：
//! - 标记**不进 SVN**，是审查进度的本地记录，存在配置目录的 JSON 里；
//! - 必须能自动失效：同一个文件的 BASE 版本变了（别人提交了 / 自己更新了），
//!   或者文件在本地又被改过（mtime/size 变了），旧结论就不能再算数——
//!   否则会出现「界面说已审、实际内容已经不是审过的那份」，比不标更危险。
//!
//! 所以一条标记记住四元组：路径 + BASE 版本号 + mtime + size，四项全等才算有效。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ReviewMark {
    /// 标记时看到的 BASE 版本号（未纳管文件为 -1）。
    pub revision: i64,
    /// 文件修改时间（毫秒）。用毫秒而不是秒：同一秒内改两次是常事。
    pub mtime_ms: u64,
    pub size: u64,
    /// 标记时间（毫秒），只用于展示「什么时候审的」。
    pub at_ms: u64,
}

/// 一条标记此刻是否还算数。
pub fn is_valid(mark: &ReviewMark, revision: i64, mtime_ms: u64, size: u64) -> bool {
    mark.revision == revision && mark.mtime_ms == mtime_ms && mark.size == size
}

/// 存储用的 key：Windows 路径大小写不敏感，统一小写 + 正斜杠，避免同一文件两条记录。
pub fn key_of(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").to_lowercase()
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
    pub fn retain_valid(&mut self, probe: impl Fn(&str) -> Option<(u64, u64)>) -> usize {
        self.marks.retain(|key, mark| match probe(key) {
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
                mtime_ms: 10,
                size: 100,
                at_ms: 0,
            },
        );
        s.marks.insert(
            "c:/b.java".into(),
            ReviewMark {
                revision: 2,
                mtime_ms: 20,
                size: 200,
                at_ms: 0,
            },
        );
        let n = s.retain_valid(|k| match k {
            "c:/a.java" => Some((10, 100)),
            _ => None, // b.java 已不存在
        });
        assert_eq!(n, 1);
        assert!(s.marks.contains_key("c:/a.java"));
    }
}
