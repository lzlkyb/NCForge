//! 按改动块的「已审」落盘（按需求审查 P1）。
//!
//! key = `归一路径|块内容指纹`（前端 `reviewSession.reviewedKey` 生成）：块内容一变指纹就变，
//! 旧标记天然不再命中，不用另写失效逻辑。顺带存下标记时的块文本与基线侧行区间：
//! 基线（SVN BASE）在 update 之前不变，所以「同一段基线上审过、现在指纹变了」= 需重审，
//! 「只看这次改了什么」就是「当时审过的块文本 → 现在」的小对比。
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
    /// 基线侧行区间 `[起, 止]`（前端 ChangedBlock 的 oldStart / oldEnd）。P1 存的标记没有。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range: Option<[u32; 2]>,
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

    /// 标记 / 取消。`texts`、`ranges` 与 `keys` 一一对应，可以短于 `keys`（缺的就不存）。
    pub fn set(
        &mut self,
        keys: &[String],
        texts: &[Option<String>],
        ranges: &[[u32; 2]],
        reviewed: bool,
        now_ms: u64,
    ) {
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
                    range: ranges.get(i).copied(),
                },
            );
        }
    }

    /// 只留仍在 SVN 改动里的文件的标记。`changed` 是归一路径（小写 + 正斜杠）。
    /// 调用方必须传**完整、成功**的一次扫描结果。
    ///
    /// 🔴 **`root` 是本次扫描的工作区根，必须传**：这份表是 config_dir 下的**全局单文件**，
    /// key 是绝对路径，多个工作区的标记共存其中（不像 `ReqStore` 按根分文件）。
    /// 纯差集 `retain(changed.contains(..))` 会把**别的工程**的标记一并删光——
    /// 切到工程 B 后 B 的任意一次成功扫描就清空 A 的审查进度。
    /// 所以只处理属于本根的路径，根外的标记原样保留。
    pub fn prune(&mut self, changed: &HashSet<String>, root: &str) -> usize {
        let prefix = root_key_prefix(root);
        let before = self.marks.len();
        self.marks
            .retain(|k, _| !under_root(path_part(k), &prefix) || changed.contains(path_part(k)));
        before - self.marks.len()
    }
}

/// 归一化的根前缀（小写 + 正斜杠 + 结尾斜杠）。空根返回空串。
fn root_key_prefix(root: &str) -> String {
    let norm = root.replace('\\', "/").to_lowercase();
    let trimmed = norm.trim_end_matches('/');
    if trimmed.is_empty() {
        String::new()
    } else {
        format!("{trimmed}/")
    }
}

/// 路径是否在该根之下。**空根一律判否**：拿不到根时宁可不清，也不能误删全部。
/// 前缀带结尾斜杠，`c:/w` 不会匹配到 `c:/work/...`。
fn under_root(path: &str, prefix: &str) -> bool {
    !prefix.is_empty() && path.starts_with(prefix)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 标记_取消_清理_持久化() {
        let dir = tempfile::tempdir_in(crate::test_support::tmp("review-blocks")).unwrap();
        let mut s = BlockStore::default();
        let keys = vec!["c:/w/a.java|f1".to_string(), "c:/w/b.java|f2".to_string()];
        s.set(&keys, &[Some("块文本".into())], &[[3, 5]], true, 5);
        assert_eq!(s.marks["c:/w/a.java|f1"].text.as_deref(), Some("块文本"));
        assert_eq!(s.marks["c:/w/a.java|f1"].range, Some([3, 5]));
        assert!(s.marks["c:/w/b.java|f2"].text.is_none());
        assert!(s.marks["c:/w/b.java|f2"].range.is_none());
        s.set(&keys[..1], &[], &[], false, 6);
        assert!(!s.marks.contains_key("c:/w/a.java|f1"));
        s.set(
            &keys[..1],
            &[Some("x".repeat(TEXT_MAX_CHARS + 1))],
            &[],
            true,
            7,
        );
        assert!(s.marks["c:/w/a.java|f1"].text.is_none(), "超长不存文本");
        s.save(dir.path()).unwrap();
        let mut back = BlockStore::load(dir.path());
        assert_eq!(back.marks.len(), 2);
        // P1 存的标记没有 range 字段，仍能读回
        let old: BlockStore = serde_json::from_str(r#"{"c:/w/x.java|f":{"atMs":1}}"#).unwrap();
        assert!(old.marks["c:/w/x.java|f"].range.is_none());
        let changed: HashSet<String> = ["c:/w/a.java".to_string()].into();
        assert_eq!(back.prune(&changed, "C:\\w"), 1);
        assert!(back.marks.contains_key("c:/w/a.java|f1"));
    }

    /// 回归：全局单文件里混着两个工程的标记，B 的扫描不能删掉 A 的进度。
    #[test]
    fn 清理只作用于本工作区_别的工程标记原样保留() {
        let mut s = BlockStore::default();
        let keys = vec![
            "c:/proj_a/x.java|f1".to_string(),
            "c:/proj_a/y.java|f2".to_string(),
            "c:/proj_b/z.java|f3".to_string(),
        ];
        s.set(&keys, &[], &[], true, 1);
        // 工程 B 扫描：只有 z.java 还在改动里
        let changed: HashSet<String> = ["c:/proj_b/z.java".to_string()].into();
        assert_eq!(s.prune(&changed, "C:\\proj_b"), 0, "B 的扫描不该删任何东西");
        assert_eq!(s.marks.len(), 3, "A 的两个标记必须还在");

        // 回到工程 A 扫描：y.java 已提交，只清它
        let changed_a: HashSet<String> = ["c:/proj_a/x.java".to_string()].into();
        assert_eq!(s.prune(&changed_a, "c:/proj_a"), 1);
        assert!(s.marks.contains_key("c:/proj_a/x.java|f1"));
        assert!(!s.marks.contains_key("c:/proj_a/y.java|f2"));
        assert!(
            s.marks.contains_key("c:/proj_b/z.java|f3"),
            "B 的标记不受影响"
        );
    }

    /// 前缀必须带分隔符：`c:/w` 不能吃掉 `c:/work`；空根一律不清。
    #[test]
    fn 根前缀按分隔符匹配_空根不清理() {
        let mut s = BlockStore::default();
        s.set(
            &[
                "c:/work/a.java|f1".to_string(),
                "c:/w/b.java|f2".to_string(),
            ],
            &[],
            &[],
            true,
            1,
        );
        let changed: HashSet<String> = ["c:/w/b.java".to_string()].into();
        assert_eq!(s.prune(&changed, "c:/w"), 0, "c:/work 不在 c:/w 之下");
        assert_eq!(s.marks.len(), 2);
        // 根拿不到时宁可不清，也不能把全部标记删光
        assert_eq!(s.prune(&HashSet::new(), ""), 0);
        assert_eq!(s.marks.len(), 2);
    }
}
