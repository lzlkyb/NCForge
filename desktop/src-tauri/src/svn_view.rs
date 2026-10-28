//! 版本控制页的纯逻辑：忽略规则、状态字母、按模块分组。
//!
//! 放在这里而不是命令层的理由：这三件事**不碰 IO、不碰 tauri**，可以直接单测。
//! 真实工作副本里 12757 个条目只有 28 处真改动，其余全是 `classes/`、`.nc-compile`、
//! `*.mine` 这类噪音——过滤规则写错的表现是「改动列表混进几百行构建产物」，
//! 靠肉眼在界面上看是发现不了的，只能靠测试盯住。

use std::path::Path;

/// 桥返回的一条原始状态。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RawEntry {
    /// 绝对路径（桥给的是 `File.getPath()`，Windows 反斜杠）。
    pub path: String,
    /// SVNKit 的状态名：modified / added / deleted / unversioned / conflicted / missing …
    pub status: String,
    /// 工作副本里的版本号，未纳管为 -1。
    #[serde(default)]
    pub revision: i64,
    /// 是否目录（未纳管目录不展开，只给一行）。
    #[serde(default)]
    pub dir: bool,
}

/// 给前端的一条改动。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ChangeItem {
    /// 绝对路径，前端点开文件、算 diff 都用它。
    pub path: String,
    /// 相对工作区根，正斜杠。
    pub rel: String,
    /// 所属模块（工作区下的第一段目录），根目录下的文件为「根目录」。
    pub module: String,
    /// 状态字母：M A D ? C ! R G。
    pub letter: String,
    pub status: String,
    pub revision: i64,
    pub is_dir: bool,
    /// 是否被忽略规则挡掉（构建产物、冲突残留）。
    ///
    /// 标记放在条目上而不是整份结果过滤掉：「显示全部」只是界面开关，
    /// 让后端按开关重扫一遍等于点一下按钮等 7.6 秒，而扫出来的东西完全一样。
    pub ignored: bool,
}

/// 一个模块分组。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ChangeGroup {
    pub module: String,
    pub items: Vec<ChangeItem>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ChangesView {
    pub groups: Vec<ChangeGroup>,
    /// 过滤后剩下的条目数。
    pub shown: usize,
    /// 桥报上来的条目总数（含被过滤掉的）。
    pub total: usize,
    /// 被忽略规则挡掉的条数——界面用它说明「还有 N 条构建产物没显示」。
    pub ignored: usize,
}

/// SVN 状态名 → 单字母。未知状态一律给 `?`，不猜。
pub fn status_letter(status: &str) -> &'static str {
    match status {
        "modified" => "M",
        "added" => "A",
        "deleted" => "D",
        "replaced" => "R",
        "conflicted" => "C",
        "missing" => "!",
        "merged" => "G",
        "obstructed" => "~",
        "unversioned" => "?",
        _ => "?",
    }
}

/// 构建产物 / 冲突残留 / 自己的工作文件：默认不当作「改动」显示。
///
/// 判断只看**相对路径**，不看绝对路径——工作区根可能就叫 `classes`（不可能，但规则
/// 不该依赖根名）。目录按整段匹配（`classes/` 之下全部忽略），文件按后缀匹配。
pub fn is_ignored(rel: &str, is_dir: bool) -> bool {
    let rel = rel.replace('\\', "/");
    let segs: Vec<&str> = rel.split('/').filter(|s| !s.is_empty()).collect();
    if segs.is_empty() {
        return false;
    }
    // 目录名（任意层级）命中即忽略，其后代自然也忽略
    const IGNORED_DIRS: [&str; 6] = [
        "classes",
        "out",
        "target",
        ".nc-compile",
        ".ncforge-tmp",
        "bin",
    ];
    for (i, seg) in segs.iter().enumerate() {
        let is_last = i == segs.len() - 1;
        if (!is_last || is_dir) && IGNORED_DIRS.contains(&seg.to_ascii_lowercase().as_str()) {
            return true;
        }
    }
    let name = segs[segs.len() - 1];
    let lower = name.to_ascii_lowercase();
    // 冲突残留：Eclipse/SVN 的 .mine、.r1234
    if lower.ends_with(".mine") || is_rev_suffix(&lower) {
        return true;
    }
    if is_dir {
        return false;
    }
    const IGNORED_EXT: [&str; 6] = [".class", ".jar", ".zip", ".log", ".tmp", ".bak"];
    IGNORED_EXT.iter().any(|e| lower.ends_with(e))
}

/// `.r123` / `.r1234.2` 这类冲突副本后缀。
fn is_rev_suffix(lower: &str) -> bool {
    let mut rest = lower;
    // 允许尾部再挂序号（.r1234.2）
    if let Some(dot) = rest.rfind('.') {
        if rest[dot + 1..].chars().all(|c| c.is_ascii_digit()) && dot + 1 < rest.len() {
            rest = &rest[..dot];
        }
    }
    match rest.rfind(".r") {
        Some(i) => {
            let digits = &rest[i + 2..];
            !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit())
        }
        None => false,
    }
}

/// 相对路径 → 模块名（第一段目录）。根下的文件归「根目录」。
pub fn module_of(rel: &str) -> String {
    let rel = rel.replace('\\', "/");
    let mut segs = rel.split('/').filter(|s| !s.is_empty());
    match (segs.next(), segs.next()) {
        (Some(first), Some(_)) => first.to_string(),
        _ => "根目录".to_string(),
    }
}

/// 相对路径（正斜杠）。不在根之下时原样返回。
pub fn relative(root: &Path, path: &Path) -> String {
    match path.strip_prefix(root) {
        Ok(p) => p.to_string_lossy().replace('\\', "/"),
        Err(_) => path.to_string_lossy().replace('\\', "/"),
    }
}

/// 原始状态 → 界面视图：拼字段、打忽略标记、按模块分组（模块按条目数降序，条目按路径升序）。
///
/// **不在这里按忽略规则删条目**：条目带上 `ignored` 标记，由界面决定显不显示。
/// 这样左栏那个「显示全部」开关是纯前端的，不会又触发一次全量 status。
pub fn build_changes(root: &Path, raw: &[RawEntry]) -> ChangesView {
    let mut items: Vec<ChangeItem> = Vec::new();
    for e in raw {
        let p = Path::new(&e.path);
        let rel = relative(root, p);
        items.push(ChangeItem {
            path: e.path.clone(),
            module: module_of(&rel),
            ignored: is_ignored(&rel, e.dir),
            rel,
            letter: status_letter(&e.status).to_string(),
            status: e.status.clone(),
            revision: e.revision,
            is_dir: e.dir,
        });
    }
    items.sort_by_key(|a| a.rel.to_lowercase());

    let mut groups: Vec<ChangeGroup> = Vec::new();
    for item in items {
        match groups.iter_mut().find(|g| g.module == item.module) {
            Some(g) => g.items.push(item),
            None => groups.push(ChangeGroup {
                module: item.module.clone(),
                items: vec![item],
            }),
        }
    }
    groups.sort_by(|a, b| {
        b.items
            .len()
            .cmp(&a.items.len())
            .then_with(|| a.module.cmp(&b.module))
    });
    let ignored: usize = groups
        .iter()
        .map(|g| g.items.iter().filter(|i| i.ignored).count())
        .sum();
    let shown: usize = groups.iter().map(|g| g.items.len()).sum::<usize>() - ignored;
    ChangesView {
        groups,
        shown,
        total: raw.len(),
        ignored,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn raw(path: &str, status: &str, dir: bool) -> RawEntry {
        RawEntry {
            path: path.to_string(),
            status: status.to_string(),
            revision: 1,
            dir,
        }
    }

    #[test]
    fn 状态名映射到字母() {
        assert_eq!(status_letter("modified"), "M");
        assert_eq!(status_letter("unversioned"), "?");
        assert_eq!(status_letter("conflicted"), "C");
        assert_eq!(status_letter("deleted"), "D");
        assert_eq!(status_letter("什么鬼"), "?");
    }

    #[test]
    fn 构建产物与冲突残留被忽略() {
        assert!(is_ignored("baseapp/classes/nc/ui/A.class", false));
        assert!(is_ignored("gsp/classes", true));
        assert!(is_ignored("newar/.nc-compile", true));
        assert!(is_ignored("pu/src/A.java.mine", false));
        assert!(is_ignored("pu/src/A.java.r14231", false));
        assert!(is_ignored("pu/src/A.java.r14231.2", false));
        assert!(is_ignored("pu/src/A.class", false));
        // 真改动不能误杀
        assert!(!is_ignored("pu/src/private/nc/impl/A.java", false));
        assert!(!is_ignored(".module_prj", false));
        // 名字里带 r 数字但不是冲突后缀
        assert!(!is_ignored("pu/src/Rule2.java", false));
        assert!(!is_ignored("pu/src/r1200/Rule.java", false));
        // classes 出现在文件名里不算目录
        assert!(!is_ignored("pu/src/ClassesHelper.java", false));
    }

    #[test]
    fn 模块取第一段目录_根下文件归根目录() {
        assert_eq!(module_of("pu/src/A.java"), "pu");
        assert_eq!(module_of(".module_prj"), "根目录");
        assert_eq!(module_of("ic/eye/A.java"), "ic");
    }

    #[test]
    fn 分组按条目数降序且构建产物只打标记不删除() {
        // 组件拼路径：Unix 上反斜杠不是分隔符，strip_prefix 对 Windows
        // 字面量直接失败，rel 退化成整条绝对路径、模块名全乱
        // （2026-10-28 macOS CI 实测）。
        let root = PathBuf::from("C:").join("ws");
        let raw = vec![
            raw(
                &root.join("pu").join("A.java").to_string_lossy(),
                "modified",
                false,
            ),
            raw(
                &root
                    .join("pu")
                    .join("classes")
                    .join("A.class")
                    .to_string_lossy(),
                "unversioned",
                false,
            ),
            raw(
                &root.join("ic").join("B.java").to_string_lossy(),
                "added",
                false,
            ),
            raw(
                &root.join("ic").join("C.java").to_string_lossy(),
                "modified",
                false,
            ),
            raw(
                &root.join(".module_prj").to_string_lossy(),
                "modified",
                false,
            ),
        ];
        let v = build_changes(&root, &raw);
        assert_eq!(v.total, 5);
        // 构建产物仍在分组里（界面按标记隐藏），但计数不含它
        assert_eq!(v.ignored, 1);
        assert_eq!(v.shown, 4);
        assert_eq!(v.groups[0].module, "ic");
        assert_eq!(v.groups[0].items.len(), 2);
        assert_eq!(v.groups[1].module, "pu");
        assert_eq!(v.groups[1].items.len(), 2);
        assert_eq!(v.groups[2].module, "根目录");
        let class_item = v.groups[1]
            .items
            .iter()
            .find(|i| i.rel.ends_with(".class"))
            .expect("构建产物应仍在列表里");
        assert!(class_item.ignored, "构建产物必须带 ignored 标记");
        assert!(!v.groups[1]
            .items
            .iter()
            .any(|i| i.rel.ends_with("A.java") && i.ignored));
    }

    #[test]
    fn 相对路径统一正斜杠() {
        // 组件拼路径：Unix 上 strip_prefix 对 Windows 字面量失败，
        // 拿到的是整条绝对路径（2026-10-28 macOS CI 实测）。
        let root = PathBuf::from("C:").join("ws");
        let p = root.join("pu").join("src").join("A.java");
        assert_eq!(relative(&root, &p), "pu/src/A.java");
    }
}
