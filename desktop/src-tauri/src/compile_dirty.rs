//! 编译脏集注册表：watcher 把 `.java` 改动（外部 SVN/其它编辑器，也包括本工作台保存）
//! 喂进来，`decide` 据此**只 stat 脏文件**，不必每次全模块扫描（大模块 ~1ms/文件）。
//!
//! 正确性靠 **epoch 模型**，不靠「相信监听器永远不丢」：
//! - 每个工作区一个 `epoch`。溢出 / rescan / 切工作区 / 监听出错 → `epoch++`。
//! - 每个模块记「我在哪个 epoch 建过基线（全扫一遍）」。`hint.reliable` 仅当
//!   模块基线 epoch == 当前 epoch。epoch 一涨，**所有**模块基线同时作废，下次 decide
//!   各自回落全扫重建——不会出现「A 全扫了就把全局标可信、B 还没扫却跟着跳」的漏编。
//! - 启动 / 切工作区先 `invalidate`：应用没跑期间磁盘发生了什么谁也不知道，首轮必须全扫。
//!
//! 全扫成功后 `baseline`（记 epoch + 清掉本模块脏集，因为全扫已覆盖）；可靠的增量
//! decide 成功后 `consume`（只移除本轮处理过的脏路径，期间新到的事件留着）。编译失败
//! 不 consume / 不 baseline：脏路径留着，下一轮重试。

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 给 `decide` 的脏集提示。`reliable=false` 时调用方必须回落全扫。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirtyHint {
    /// 落在本模块源码根下的脏 `.java`（绝对路径，含增 / 删 / 改；删除的路径 stat 不到）。
    pub paths: Vec<PathBuf>,
    /// 本模块已在当前 epoch 建过基线，脏集可信。
    pub reliable: bool,
}

struct Scope {
    dirty: BTreeSet<PathBuf>,
    epoch: u64,
    /// 模块名（小写）→ 建基线时的 epoch。
    baselined: HashMap<String, u64>,
}

impl Scope {
    fn new() -> Self {
        Self {
            dirty: BTreeSet::new(),
            epoch: 0,
            baselined: HashMap::new(),
        }
    }
}

static SCOPES: Mutex<Option<HashMap<String, Scope>>> = Mutex::new(None);

fn root_key(root: &Path) -> String {
    crate::build_layout::slash(root).to_ascii_lowercase()
}

fn under_roots(p: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|r| p.starts_with(r))
}

/// watcher 每批落地时调：累加脏 java；溢出 / rescan 抬高 epoch 作废所有基线。
pub fn mark(root: &Path, java: &[PathBuf], overflow: bool, rescan: bool) {
    let Ok(mut g) = SCOPES.lock() else {
        return;
    };
    let g = g.get_or_insert_with(HashMap::new);
    let s = g.entry(root_key(root)).or_insert_with(Scope::new);
    for p in java {
        s.dirty.insert(p.clone());
    }
    if overflow || rescan {
        s.epoch = s.epoch.saturating_add(1);
    }
}

/// 启动 / 切工作区 / 监听失效：脏集清空、epoch 抬高，首轮强制全扫建基线。
pub fn invalidate(root: &Path) {
    let Ok(mut g) = SCOPES.lock() else {
        return;
    };
    if let Some(g) = g.as_mut() {
        if let Some(s) = g.get_mut(&root_key(root)) {
            s.epoch = s.epoch.saturating_add(1);
            s.dirty.clear();
            s.baselined.clear();
        }
    }
}

/// 取本模块的脏集提示（不清除）。无登记 / 未建基线 → `reliable=false`。
pub fn hint(root: &Path, module: &str, roots: &[PathBuf]) -> DirtyHint {
    let Ok(g) = SCOPES.lock() else {
        return DirtyHint {
            paths: Vec::new(),
            reliable: false,
        };
    };
    let Some(s) = g.as_ref().and_then(|g| g.get(&root_key(root))) else {
        return DirtyHint {
            paths: Vec::new(),
            reliable: false,
        };
    };
    let reliable = s.baselined.get(&module.to_ascii_lowercase()).copied() == Some(s.epoch);
    let paths = s
        .dirty
        .iter()
        .filter(|p| under_roots(p, roots))
        .cloned()
        .collect();
    DirtyHint { paths, reliable }
}

/// 全扫成功：记本模块基线 epoch，并清掉本模块脏集（全扫已覆盖这些改动）。
pub fn baseline(root: &Path, module: &str, roots: &[PathBuf]) {
    let Ok(mut g) = SCOPES.lock() else {
        return;
    };
    let g = g.get_or_insert_with(HashMap::new);
    let s = g.entry(root_key(root)).or_insert_with(Scope::new);
    s.baselined.insert(module.to_ascii_lowercase(), s.epoch);
    s.dirty.retain(|p| !under_roots(p, roots));
}

/// 可靠增量成功：只移除本轮处理过的脏路径，期间新到的事件保留。
pub fn consume(root: &Path, paths: &[PathBuf]) {
    let Ok(mut g) = SCOPES.lock() else {
        return;
    };
    if let Some(s) = g.as_mut().and_then(|g| g.get_mut(&root_key(root))) {
        for p in paths {
            s.dirty.remove(p);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roots(tag: &str) -> (PathBuf, Vec<PathBuf>) {
        let root = PathBuf::from(format!("C:/ws-{tag}"));
        let rs = vec![root.join("m/src/public")];
        (root, rs)
    }

    #[test]
    fn 未建基线时不可信() {
        let (root, rs) = roots("unbase");
        mark(&root, &[root.join("m/src/public/A.java")], false, false);
        let h = hint(&root, "m", &rs);
        assert!(!h.reliable, "没全扫建基线前必须不可信");
        assert_eq!(h.paths.len(), 1);
    }

    #[test]
    fn 基线后可信且清掉本模块脏集() {
        let (root, rs) = roots("base");
        let a = root.join("m/src/public/A.java");
        mark(&root, std::slice::from_ref(&a), false, false);
        baseline(&root, "m", &rs);
        let h = hint(&root, "m", &rs);
        assert!(h.reliable);
        assert!(h.paths.is_empty(), "全扫已覆盖，脏集应清空：{:?}", h.paths);
        // 基线后新到的改动照常进脏集
        mark(&root, std::slice::from_ref(&a), false, false);
        let h2 = hint(&root, "m", &rs);
        assert!(h2.reliable);
        assert_eq!(h2.paths, vec![a]);
    }

    #[test]
    fn 溢出抬高epoch作废所有模块基线() {
        let (root, rs) = roots("overflow");
        let rs_b = vec![root.join("n/src/public")];
        baseline(&root, "m", &rs);
        baseline(&root, "n", &rs_b);
        assert!(hint(&root, "m", &rs).reliable);
        assert!(hint(&root, "n", &rs_b).reliable);
        // 溢出：两个模块基线同时作废，谁都不能跳
        mark(&root, &[], true, false);
        assert!(!hint(&root, "m", &rs).reliable, "溢出后 m 必须回落全扫");
        assert!(!hint(&root, "n", &rs_b).reliable, "溢出后 n 必须回落全扫");
        // m 重建基线不影响 n（n 还没全扫，不能跟着变可信）
        baseline(&root, "m", &rs);
        assert!(hint(&root, "m", &rs).reliable);
        assert!(!hint(&root, "n", &rs_b).reliable, "n 没重建基线仍不可信");
    }

    #[test]
    fn rescan与invalidate同样作废() {
        let (root, rs) = roots("rescan");
        baseline(&root, "m", &rs);
        mark(&root, &[], false, true);
        assert!(!hint(&root, "m", &rs).reliable);
        baseline(&root, "m", &rs);
        assert!(hint(&root, "m", &rs).reliable);
        invalidate(&root);
        assert!(!hint(&root, "m", &rs).reliable);
    }

    #[test]
    fn hint只含本模块源码根下的路径() {
        let (root, rs) = roots("filter");
        let a = root.join("m/src/public/A.java");
        let b = root.join("n/src/public/B.java");
        // 先建基线再 mark：baseline 会清本模块脏集，mark 必须在它之后才能留在 hint 里。
        baseline(&root, "m", &rs);
        mark(&root, &[a.clone(), b], false, false);
        let h = hint(&root, "m", &rs);
        assert_eq!(h.paths, vec![a], "别的模块的脏路径不该进 m 的 hint");
    }

    #[test]
    fn consume只移除处理过的路径() {
        let (root, rs) = roots("consume");
        let a = root.join("m/src/public/A.java");
        let b = root.join("m/src/public/B.java");
        baseline(&root, "m", &rs);
        mark(&root, &[a.clone(), b.clone()], false, false);
        consume(&root, &[a]);
        let h = hint(&root, "m", &rs);
        assert_eq!(h.paths, vec![b], "consume 只移除处理过的，新到的留着");
    }
}
