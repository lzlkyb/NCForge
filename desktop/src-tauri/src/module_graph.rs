//! 派生模块依赖图：NC 单根 `.classpath` 工作区没有显式模块依赖
//! （`build_engine::module_deps` 在这种工作区推出来是空的），make 编排 /
//! 下游失效 / 真实分层需要的边只能从源码引用派生。
//!
//! 原料全部已有：清单里的外部引用聚合（`build_state::ExtRefs`，编译时顺带算）
//! × 工作区类型索引（`workspace_types`，FQCN → 模块）。这里只做 join，不扫源码。
//!
//! **图是优化不是正确性前提**：清单读不出 / 索引没建好 → 没有边，编排退化为
//! 现状（classpath 声明顺序 + 单层），传播另有文本边与保底档兜底。

use std::collections::{HashMap, HashSet};

use crate::build_state::{ExtRefs, Manifest};
use crate::workspace_types::WorkspaceTypes;

/// 类型索引的 join 表：FQCN → 声明模块；包 → (简单名, 声明模块)。
/// 同名类分布在多个模块时全部保留（NC 常态），join 出多条边宁可多编。
pub struct TypeMaps {
    fq: HashMap<String, Vec<String>>,
    pkg: HashMap<String, Vec<(String, String)>>,
}

pub fn type_maps(types: &WorkspaceTypes) -> TypeMaps {
    let mut fq: HashMap<String, Vec<String>> = HashMap::new();
    let mut pkg: HashMap<String, Vec<(String, String)>> = HashMap::new();
    for hit in types.hits() {
        if hit.module.is_empty() {
            continue; // jar 条目不参与工作区模块图
        }
        fq.entry(hit.name.to_ascii_lowercase())
            .or_default()
            .push(hit.module.clone());
        pkg.entry(hit.package.to_ascii_lowercase())
            .or_default()
            .push((hit.simple.to_ascii_lowercase(), hit.module.clone()));
    }
    TypeMaps { fq, pkg }
}

/// 外部引用聚合 → 依赖模块集合（不含自身去重，调用方过滤）。
/// join 键一律小写归一：`ExtRefs` 的产出端已小写，这里再归一一次是防御——
/// 大小写漂移会让边静默消失，宁可多算一次 lowercase。
pub fn join_ext(ext: &ExtRefs, maps: &TypeMaps) -> Vec<String> {
    let mut out: HashSet<String> = HashSet::new();
    for f in &ext.fq {
        if let Some(ms) = maps.fq.get(&f.to_ascii_lowercase()) {
            out.extend(ms.iter().cloned());
        }
    }
    for w in &ext.wild {
        if let Some(entries) = maps.pkg.get(&w.to_ascii_lowercase()) {
            // 通配 import 也只连「正文点名了简单类名」的模块（与同包分支、文件级
            // referrers_of_names 同款）。真通配引用必在正文点名该类型，故不会漏依赖；
            // 不过滤会把整包所有模块连进来，传递闭包爆炸→「编译本模块」实编大半个
            // 工作区（2026-11-19 实测中位闭包 35/59 模块、~98% 源文件）。
            for (simple, m) in entries {
                if ext.simple.binary_search(simple).is_ok() {
                    out.insert(m.clone());
                }
            }
        }
    }
    // 同包跨模块：本模块的包 × 正文出现过的简单名（ext.simple 已排序，二分命中）
    for p in &ext.packages {
        if let Some(entries) = maps.pkg.get(&p.to_ascii_lowercase()) {
            for (simple, m) in entries {
                if ext.simple.binary_search(simple).is_ok() {
                    out.insert(m.clone());
                }
            }
        }
    }
    let mut v: Vec<String> = out.into_iter().collect();
    v.sort();
    v
}

/// 各模块的依赖模块（只认工作区内部模块，排除自身）。
/// 键为清单里的模块名原样；调用方按小写归一后使用。
pub fn deps_from_manifests(
    manifests: &[Manifest],
    maps: &TypeMaps,
    modules: &[String],
) -> HashMap<String, Vec<String>> {
    let known: HashSet<String> = modules.iter().map(|m| m.to_ascii_lowercase()).collect();
    let mut out = HashMap::new();
    for m in manifests {
        let deps: Vec<String> = join_ext(&m.ext, maps)
            .into_iter()
            .filter(|d| {
                !d.eq_ignore_ascii_case(&m.module) && known.contains(&d.to_ascii_lowercase())
            })
            .collect();
        out.insert(m.module.clone(), deps);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_types::TypeHit;

    fn hit(name: &str, package: &str, simple: &str, module: &str) -> TypeHit {
        TypeHit {
            name: name.to_string(),
            simple: simple.to_string(),
            package: package.to_string(),
            kind: 5,
            file: format!("{module}/src/public/{simple}.java"),
            module: module.to_string(),
            jar: String::new(),
            line: 1,
            column: 1,
        }
    }

    fn maps_of(hits: Vec<TypeHit>) -> TypeMaps {
        let mut fq: HashMap<String, Vec<String>> = HashMap::new();
        let mut pkg: HashMap<String, Vec<(String, String)>> = HashMap::new();
        for h in hits {
            fq.entry(h.name.to_ascii_lowercase())
                .or_default()
                .push(h.module.clone());
            pkg.entry(h.package.to_ascii_lowercase())
                .or_default()
                .push((h.simple.to_ascii_lowercase(), h.module.clone()));
        }
        TypeMaps { fq, pkg }
    }

    #[test]
    fn explicit_import_wildcard_and_same_package_edges() {
        let maps = maps_of(vec![
            hit("p.A", "p", "A", "ma"),
            hit("p.B", "p", "B", "ma"),
            hit("q.C", "q", "C", "mb"),
            hit("r.D", "r", "D", "mc"),
        ]);
        let ext = ExtRefs {
            fq: vec!["p.A".into()],
            wild: vec!["q".into()],
            packages: vec!["r".into()],
            // 通配 q 需正文点名 c 才连 mb；同包 r 需点名 d 才连 mc
            simple: vec!["c".into(), "d".into(), "unrelated".into()],
        };
        let deps = join_ext(&ext, &maps);
        assert_eq!(
            deps,
            vec!["ma".to_string(), "mb".to_string(), "mc".to_string()]
        );
    }

    #[test]
    fn wildcard_needs_mention_not_whole_package() {
        // 反例守卫：通配 import q.* 不得把整包所有模块连进来（闭包爆炸根因）。
        let maps = maps_of(vec![hit("q.C", "q", "C", "mb"), hit("q.E", "q", "E", "md")]);
        // 正文只点名 C → 只连 mb，不连 md
        let ext = ExtRefs {
            fq: vec![],
            wild: vec!["q".into()],
            packages: vec![],
            simple: vec!["c".into()],
        };
        assert_eq!(join_ext(&ext, &maps), vec!["mb".to_string()]);
        // 点名 E → 连 md
        let ext_e = ExtRefs {
            simple: vec!["e".into()],
            ..ext.clone()
        };
        assert_eq!(join_ext(&ext_e, &maps), vec!["md".to_string()]);
        // 一个都没点名 → 通配不连任何模块（旧语义会连 mb+md，正是要修的过连）
        let ext_none = ExtRefs {
            simple: vec!["unrelated".into()],
            ..ext.clone()
        };
        assert_eq!(join_ext(&ext_none, &maps), Vec::<String>::new());
    }

    #[test]
    fn same_package_needs_mention_and_self_excluded() {
        let maps = maps_of(vec![hit("p.A", "p", "A", "ma"), hit("p.B", "p", "B", "mb")]);
        // 同包但正文只点名 A（住在 ma）→ 只连 ma，不连 mb
        let ext = ExtRefs {
            fq: vec![],
            wild: vec![],
            packages: vec!["p".into()],
            simple: vec!["a".into()],
        };
        assert_eq!(join_ext(&ext, &maps), vec!["ma".to_string()]);
        // 点名 B → 连到 mb；自身模块由 deps_from_manifests 排除
        let ext2 = ExtRefs {
            simple: vec!["b".into()],
            ..ext.clone()
        };
        assert_eq!(join_ext(&ext2, &maps), vec!["mb".to_string()]);
    }

    #[test]
    fn deps_from_manifests_filters_unknown_and_self() {
        let maps = maps_of(vec![
            hit("p.A", "p", "A", "ma"),
            hit("q.C", "q", "C", "outside"),
        ]);
        let m = Manifest {
            schema: crate::build_state::SCHEMA,
            workspace: "C:/ws".into(),
            module: "mb".into(),
            source_roots: vec![],
            outputs: vec![],
            sources: vec![],
            ext: ExtRefs {
                fq: vec!["p.A".into(), "q.C".into()],
                ..Default::default()
            },
            classpath_fp: "a".into(),
            compiler_fp: "b".into(),
            seed_jars: vec![],
            last_success_ms: 1,
            last_attempt: None,
        };
        let deps = deps_from_manifests(&[m], &maps, &["ma".to_string(), "mb".to_string()]);
        assert_eq!(deps.get("mb").unwrap(), &vec!["ma".to_string()]);
    }
}
