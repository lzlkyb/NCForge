//! 按改动块的「已审」落盘（按需求审查 P1）。
//!
//! key = `归一路径|块内容指纹`（前端 `reviewSession.reviewedKey` 生成）：块内容一变指纹就变，
//! 旧标记天然不再命中，不用另写失效逻辑。顺带存下标记时的块文本，
//! 以后做「只看这次改了什么」（上次审过的版本 → 现在）要用。
//!
//! 只存在配置目录，不进 SVN。文件不再在 SVN 改动里（已提交 / 已还原）时由 [`BlockStore::prune`] 清掉。

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

/// 存下的块文本上限（字符）。超长的块不存文本，只存标记。
const TEXT_MAX_CHARS: usize = 16 * 1024;

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockMark {
    pub at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

#[derive(Debug, Default, Clone, serde::Serialize, serde::Deserialize)]
pub struct BlockStore {
    #[serde(flatten)]
    pub marks: BTreeMap<String, BlockMark>,
}

/// key 里的路径部分（`|` 之前）。
fn path_part(key: &str) -> &str {
    key.split_once('|').map_or(key, |(p, _)| p)
}

impl BlockStore {
    pub fn path(config_dir: &Path) -> PathBuf {
        config_dir.join("review-blocks.json")
    }

    /// 读盘。文件不存在 / 损坏都返回空表：审查进度丢了不值得打断用户（与 svn-review.json 同口径）。
    pub fn load(config_dir: &Path) -> Self {
        let path = Self::path(config_dir);
        match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
                log::warn!("块级审查标记损坏，按空表处理（{path:?}: {e}）");
                Self::default()
            }),
            Err(_) => Self::default(),
        }
    }

    pub fn save(&self, config_dir: &Path) -> Result<(), String> {
        let text = serde_json::to_vec(self).map_err(|e| format!("序列化块级审查标记失败: {e}"))?;
        crate::atomic_file::write_atomic(&Self::path(config_dir), &text)
    }

    /// 标记 / 取消。`texts` 与 `keys` 一一对应，可以短于 `keys`（缺的就不存文本）。
    pub fn set(&mut self, keys: &[String], texts: &[Option<String>], reviewed: bool, now_ms: u64) {
        for (i, key) in keys.iter().enumerate() {
            if !reviewed {
                self.marks.remove(key);
                continue;
            }
            let text = texts
                .get(i)
                .cloned()
                .flatten()
                .filter(|t| t.chars().count() <= TEXT_MAX_CHARS);
            self.marks.insert(
                key.clone(),
                BlockMark {
                    at_ms: now_ms,
                    text,
                },
            );
        }
    }

    /// 只留仍在 SVN 改动里的文件的标记。`changed` 是归一路径（小写 + 正斜杠）。
    /// 调用方必须传**完整、成功**的一次扫描结果。
    pub fn prune(&mut self, changed: &HashSet<String>) -> usize {
        let before = self.marks.len();
        self.marks.retain(|k, _| changed.contains(path_part(k)));
        before - self.marks.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 标记_取消_清理_持久化() {
        let dir = tempfile::tempdir_in(crate::test_support::tmp("review-blocks")).unwrap();
        let mut s = BlockStore::default();
        let keys = vec!["c:/w/a.java|f1".to_string(), "c:/w/b.java|f2".to_string()];
        s.set(&keys, &[Some("块文本".into())], true, 5);
        assert_eq!(s.marks["c:/w/a.java|f1"].text.as_deref(), Some("块文本"));
        assert!(s.marks["c:/w/b.java|f2"].text.is_none());
        s.set(&keys[..1], &[], false, 6);
        assert!(!s.marks.contains_key("c:/w/a.java|f1"));
        s.set(&keys[..1], &[Some("x".repeat(TEXT_MAX_CHARS + 1))], true, 7);
        assert!(s.marks["c:/w/a.java|f1"].text.is_none(), "超长不存文本");
        s.save(dir.path()).unwrap();
        let mut back = BlockStore::load(dir.path());
        assert_eq!(back.marks.len(), 2);
        let changed: HashSet<String> = ["c:/w/a.java".to_string()].into();
        assert_eq!(back.prune(&changed), 1);
        assert!(back.marks.contains_key("c:/w/a.java|f1"));
    }
}
