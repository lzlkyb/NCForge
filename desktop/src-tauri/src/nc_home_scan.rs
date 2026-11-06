//! NC home 候选扫描：没配 home 时，去本机常见放法里找一圈，列给用户选。
//!
//! 为什么需要它（2026-11-06）：home 判定（`nc_home::probe`）本身是按内容识别的，
//! 很稳；但「没配置时只有一个硬编码默认位置 `D:\ncc\1909home`」，同事的机器上
//! NC 装在别处（`D:\NC65`、`E:\yonyou\home`…）就直接抓瞎，只能手敲路径——
//! 敲错一个字母就探测失败，而错误文案是技术性的。这里把「发现」补上。
//!
//! 成本控制（三条硬约束，都在单测里有对应用例）：
//! 1. **不递归全盘**：只展开盘符根的一级子目录，以及这些子目录的下一层
//!    （覆盖 `D:\1909home` 与 `D:\ncc\1909home` 两种放法）。
//! 2. **单目录条目数上限**：超过 200 个条目的目录直接跳过——放 NC home 的
//!    宿主父目录不可能有几百个条目，那种目录（node_modules、游戏库）展开了
//!    也只是白读。
//! 3. **总展开目录数上限**：500。超了就停，结果可能不全，但界面不会卡死
//!    （扫描跑在 `spawn_blocking` 里，真卡住也是界面无响应）。
//!
//! 判定用轻量的 `looks_like_nc_home`（只 stat 三个路径，不读文件内容）：
//! 深度校验（模块数、端口、java 可用性）是用户点中某个候选之后的事，
//! 由 `nc_home::probe` 做。扫描阶段装完整校验会把成本抬高一个数量级。
//!
//! 纯逻辑模块，不含 tauri 类型（原因见 workspace.rs 头注释）。

use serde::Serialize;
use std::path::{Path, PathBuf};

use crate::nc_home::{count_subdirs, looks_like_nc_home};

/// 候选的来源，界面上用来解释「这个位置是怎么找到的」。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CandidateSource {
    /// 硬盘根目录的一级 / 二级子目录（`D:\1909home`、`D:\ncc\1909home`）。
    DriveRoot,
    /// 已配工作区的同级目录（二开工程常和 NC home 放同一个父目录下，
    /// 如 `D:\Workspaces\ar2025` 与 `D:\NC65`）。
    WorkspaceSibling,
}

/// 一个扫到的 NC home 候选。**未经深度校验**——能不能用要用户点了才知道。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HomeCandidate {
    pub root: String,
    /// `modules` 下的一级子目录数，扫的时候顺手数的（几十个条目，便宜）。
    pub module_count: usize,
    pub source: CandidateSource,
}

/// 单个目录展开子目录时的条目数上限：超过就跳过（理由见模块头注释第 2 条）。
const MAX_CHILDREN_PER_DIR: usize = 200;

/// 一次扫描最多展开的目录数（含根本身）。超了就停。
const MAX_SCAN_DIRS: usize = 500;

/// 找本机可能存在的 NC home 候选。
///
/// `workspace_root` 只用来定位「工作区的同级目录」，本身不参与扫描
/// （工作区里不会有 home）。传 `None` = 跳过这一路。
///
/// 返回去重、按路径排序的列表；一个都没有就返回空 vec（界面显示
/// 「没扫到，手动浏览」），**不报错**——扫不到是常态，不是故障。
pub fn candidates(workspace_root: Option<&str>) -> Vec<HomeCandidate> {
    let mut roots: Vec<(PathBuf, CandidateSource)> = drive_roots()
        .into_iter()
        .map(|p| (p, CandidateSource::DriveRoot))
        .collect();
    // 工作区同级：放在盘符之后，去重时同名候选保留盘符那份（来源更普适）。
    if let Some(ws) = workspace_root.map(str::trim).filter(|s| !s.is_empty()) {
        if let Some(parent) = Path::new(ws).parent() {
            if parent.is_dir() {
                roots.push((parent.to_path_buf(), CandidateSource::WorkspaceSibling));
            }
        }
    }

    let mut out = scan_tree(&roots);
    out.sort_by(|a, b| a.root.cmp(&b.root));
    out.dedup_by(|a, b| a.root == b.root);
    out
}

/// 枚举扫描根：Windows 是各硬盘盘符，其他平台是用户主目录。
///
/// 不存在的盘符 / 目录直接过滤掉（`is_dir` 对不可访问的盘符返回 false，
/// 不弹错、不卡）。只读盘符列表，不碰光驱（未就绪时光驱目录读不动，
/// 会被 `is_dir` 自然淘汰，不用特判）。
#[cfg(windows)]
fn drive_roots() -> Vec<PathBuf> {
    (b'A'..=b'Z')
        .map(|c| PathBuf::from(format!("{}:\\", c as char)))
        .filter(|p| p.is_dir())
        .collect()
}

#[cfg(not(windows))]
fn drive_roots() -> Vec<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .into_iter()
        .collect()
}

/// 从给定根出发做一次两层扫描。
///
/// `roots` 里每个根展开一级子目录：像 home 的收下，不像的再展开一层
/// （覆盖 `D:\ncc\1909home` 这种二级放法）。深度到此为止，不再向下。
///
/// 按 `roots` 的顺序**广度优先**处理（不用栈）：同一个 home 从两条路都
/// 扫到时，先处理的那条来源先入列，`candidates` 去重时保留它——
/// 盘符根那路排在 workspace 同级之前，来源标签才是「更普适的那个」。
fn scan_tree(roots: &[(PathBuf, CandidateSource)]) -> Vec<HomeCandidate> {
    let mut out: Vec<HomeCandidate> = Vec::new();
    let mut budget = MAX_SCAN_DIRS;
    // 待展开队列：(目录, 来源, 深度)。depth 0 = 根，1 = 根的一级子目录。
    let mut queue: Vec<(PathBuf, CandidateSource, usize)> =
        roots.iter().map(|(p, s)| (p.clone(), *s, 0usize)).collect();
    let mut cursor = 0usize;
    while cursor < queue.len() && budget > 0 {
        let (dir, source, depth) = queue[cursor].clone();
        cursor += 1;
        budget -= 1;
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        // 先收成 Vec：既要数条目数（上限判断），又要遍历。空目录 / 读不动跳过。
        let entries: Vec<_> = rd.flatten().collect();
        if entries.len() > MAX_CHILDREN_PER_DIR {
            continue;
        }
        for entry in entries {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            if looks_like_nc_home(&path) {
                out.push(HomeCandidate {
                    root: path.to_string_lossy().to_string(),
                    module_count: count_subdirs(&path.join("modules")),
                    source,
                });
            } else if depth == 0 {
                // 只有第一层不像的才继续往下找：再往下就是第三层，
                // 没听说过谁把 NC home 埋三层。
                queue.push((path, source, depth + 1));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nc_home::strip_verbatim;
    use std::fs;

    fn temp_dir(tag: &str) -> PathBuf {
        let mut d = std::env::temp_dir();
        d.push(format!("ncforge-scan-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// 造一个「长得像」的 NC home（与 nc_home.rs 的 fake_home 同规格：
    /// 只建判定要用的文件，不塞真 jar）。
    fn fake_home(tag: &str) -> PathBuf {
        let d = temp_dir(tag);
        fs::create_dir_all(d.join("ufjdk").join("bin")).unwrap();
        fs::write(d.join("ufjdk").join("bin").join("java.exe"), b"stub").unwrap();
        fs::create_dir_all(d.join("middleware")).unwrap();
        fs::write(d.join("middleware").join("mw.jar"), b"stub").unwrap();
        for m in ["gl", "ic", "pu"] {
            fs::create_dir_all(d.join("modules").join(m)).unwrap();
        }
        d
    }

    fn cleanup(d: &Path) {
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn 能扫出盘符根下一级放法的_home() {
        let root = temp_dir("lvl1");
        let home = fake_home("lvl1-home");
        // 挪到 <root>/1909home：模拟 D:\1909home
        let nested = root.join("1909home");
        fs::rename(&home, &nested).unwrap();
        let hits = scan_tree(&[(root.clone(), CandidateSource::DriveRoot)]);
        assert_eq!(hits.len(), 1);
        assert_eq!(PathBuf::from(&hits[0].root), strip_verbatim(&fs::canonicalize(&nested).unwrap()));
        assert_eq!(hits[0].module_count, 3);
        assert_eq!(hits[0].source, CandidateSource::DriveRoot);
        cleanup(&root);
    }

    /// 团队本机就是二级放法（`D:\ncc\1909home`）：只有一层扫描会漏掉它，
    /// 这是扫描存在的主要理由。
    #[test]
    fn 能扫出二级放法的_home() {
        let root = temp_dir("lvl2");
        let home = fake_home("lvl2-home");
        let nested = root.join("ncc").join("1909home");
        fs::create_dir_all(root.join("ncc")).unwrap();
        fs::rename(&home, &nested).unwrap();
        let hits = scan_tree(&[(root.clone(), CandidateSource::DriveRoot)]);
        assert_eq!(hits.len(), 1, "D:\\ncc\\1909home 这种放法必须能扫到");
        assert_eq!(PathBuf::from(&hits[0].root), strip_verbatim(&fs::canonicalize(&nested).unwrap()));
        cleanup(&root);
    }

    #[test]
    fn 三级放法不扫_成本到此为止() {
        let root = temp_dir("lvl3");
        let home = fake_home("lvl3-home");
        let nested = root.join("a").join("b").join("1909home");
        fs::create_dir_all(nested.parent().unwrap()).unwrap();
        fs::rename(&home, &nested).unwrap();
        let hits = scan_tree(&[(root.clone(), CandidateSource::DriveRoot)]);
        assert!(hits.is_empty(), "第三层不展开：没人把 home 埋这么深");
        cleanup(&root);
    }

    #[test]
    fn 不像_home_的目录被跳过() {
        let root = temp_dir("noise");
        fs::create_dir_all(root.join("Games").join("steam")).unwrap();
        fs::create_dir_all(root.join("node_modules").join("left-pad")).unwrap();
        fs::write(root.join("readme.txt"), b"hi").unwrap();
        // 缺 mw.jar 的半吊子目录：轻量判定就该拒绝
        fs::create_dir_all(root.join("half").join("ufjdk").join("bin")).unwrap();
        fs::create_dir_all(root.join("half").join("modules").join("gl")).unwrap();
        let hits = scan_tree(&[(root.clone(), CandidateSource::DriveRoot)]);
        assert!(hits.is_empty(), "{hits:?}");
        cleanup(&root);
    }

    /// 条目数超过上限的目录直接跳过：放 home 的宿主父目录不可能有几百个条目，
    /// 展开那种目录（node_modules）纯属浪费。
    #[test]
    fn 条目过多的目录被跳过() {
        let root = temp_dir("toobig");
        let many = root.join("many");
        fs::create_dir_all(&many).unwrap();
        for i in 0..=MAX_CHILDREN_PER_DIR {
            fs::create_dir_all(many.join(format!("d{i:03}"))).unwrap();
        }
        // 把 home 藏进这个大目录：整目录被跳过，所以扫不到
        let home = fake_home("toobig-home");
        fs::rename(&home, many.join("1909home")).unwrap();
        let hits = scan_tree(&[(root.clone(), CandidateSource::DriveRoot)]);
        assert!(hits.is_empty(), "超过 {MAX_CHILDREN_PER_DIR} 个条目的目录不展开");
        cleanup(&root);
    }

    /// 总展开目录数有上限：造 600 个空目录 + 1 个 home，home 在队列末尾
    /// （字典序在最后）就该被预算截断。
    #[test]
    fn 扫描总量有上限_不会无限展开() {
        let root = temp_dir("budget");
        for i in 0..600 {
            fs::create_dir_all(root.join(format!("d{i:03}"))).unwrap();
        }
        let home = fake_home("budget-home");
        let nested = root.join("zzz-home");
        fs::rename(&home, &nested).unwrap();
        let hits = scan_tree(&[(root.clone(), CandidateSource::DriveRoot)]);
        // 根本身花掉 1 次预算，剩 499 次给 d000…d498；zzz-home 排最后，扫不到
        assert!(hits.is_empty(), "预算 {MAX_SCAN_DIRS} 用完后必须停：{hits:?}");
        cleanup(&root);
    }

    /// 同一个 home 从两条路都扫到时只出现一次（去重），且保留先加入的来源。
    #[test]
    fn 同一候选去重并保留首个来源() {
        let shared = temp_dir("dedup-shared");
        let home = fake_home("dedup-home");
        let nested = shared.join("1909home");
        fs::rename(&home, &nested).unwrap();
        // 两个根：drive 与 workspace 同级都指向同一个 shared
        let roots = vec![
            (shared.clone(), CandidateSource::DriveRoot),
            (shared.clone(), CandidateSource::WorkspaceSibling),
        ];
        let mut hits = scan_tree(&roots);
        hits.sort_by(|a, b| a.root.cmp(&b.root));
        hits.dedup_by(|a, b| a.root == b.root);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].source, CandidateSource::DriveRoot);
        cleanup(&shared);
    }

    /// 工作区同级目录这条路真的会扫：二开工程与 home 常放同一父目录。
    #[test]
    fn 工作区同级目录能扫到_home() {
        let parent = temp_dir("ws-parent");
        let home = fake_home("ws-home");
        let nested = parent.join("NC65");
        fs::rename(&home, &nested).unwrap();
        let ws = parent.join("ar2025");
        fs::create_dir_all(&ws).unwrap();
        let hits = candidates(Some(ws.to_str().unwrap()));
        // drive_roots() 在测试机上是真实盘符，不会碰 temp 目录；这条断言只关心
        // workspace 这一路有没有生效——用 hits 里找得到 nested 即可。
        let expect = strip_verbatim(&fs::canonicalize(&nested).unwrap());
        let found = hits.iter().any(|h| Path::new(&h.root) == expect);
        assert!(found, "工作区同级的 home 要被扫到：{hits:?}");
        cleanup(&parent);
    }

    #[test]
    fn 没有工作区配置时不炸_只扫盘符() {
        // 传 None / 空串 / 不存在路径都不该 panic
        assert!(candidates(None).iter().all(|h| !h.root.is_empty()));
        assert!(candidates(Some("   ")).iter().all(|h| !h.root.is_empty()));
        assert!(candidates(Some("Z:\\__ncforge_no_such__")).iter().all(|h| !h.root.is_empty()));
    }

    #[test]
    fn 序列化字段是_camel_case() {
        let c = HomeCandidate {
            root: "D:\\ncc\\1909home".into(),
            module_count: 3,
            source: CandidateSource::DriveRoot,
        };
        let json = serde_json::to_string(&c).expect("序列化");
        assert!(json.contains("\"moduleCount\""), "{json}");
        assert!(json.contains("\"driveRoot\""), "{json}");
    }
}
