//! 按 Reference 的相对路径读取外部接口定义。无递归索引、无数据库访问、无写句柄。
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use crate::bmf_model::BmfDoc;
use crate::bmf_semantics::BusinessInterface;

const MAX_MODULE_DIRS: usize = 512;
const MAX_DEFINITION_BYTES: u64 = 2 * 1024 * 1024;
const MAX_READ_BYTES: u64 = 16 * 1024 * 1024;

fn relative_path(raw: &str) -> Option<PathBuf> {
    let parts: Vec<_> = raw.split(['\\', '/']).filter(|s| !s.is_empty()).collect();
    if parts.is_empty()
        || parts.len() > 32
        || parts
            .iter()
            .any(|s| *s == "." || *s == ".." || s.contains(':'))
    {
        return None;
    }
    let path: PathBuf = parts.iter().collect();
    path.extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("bmf"))
        .then_some(path)
}

fn module_dirs(source: &Path, roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    // 当前模块优先；支持 METADATA 中任意深度的文件。
    if let Some(metadata) = source.ancestors().find(|p| {
        p.file_name()
            .is_some_and(|n| n.eq_ignore_ascii_case("METADATA"))
    }) {
        if let Some(module) = metadata.parent() {
            dirs.push(module.to_path_buf());
        }
    }
    for root in roots {
        dirs.push(root.clone());
        let parent = if root.join("modules").is_dir() {
            root.join("modules")
        } else {
            root.clone()
        };
        if let Ok(read) = std::fs::read_dir(parent) {
            let mut children: Vec<_> = read
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .take(MAX_MODULE_DIRS)
                .collect();
            children.sort();
            dirs.extend(children);
        }
    }
    let mut seen = HashSet::new();
    dirs.retain(|p| seen.insert(p.clone()));
    dirs.truncate(MAX_MODULE_DIRS);
    dirs
}

/// 只解析路径精确命中的小文件；同一个外部组件即使有多个接口也只读一次。
/// 多份不同定义不猜胜者：返回可见原因并保持只读，防止用错版本修改映射。
pub fn enrich(doc: &mut BmfDoc, roots: &[PathBuf]) {
    doc.interfaces.retain(|i| !i.external);
    if doc.references.is_empty() {
        return;
    }
    let dirs = module_dirs(&doc.path, roots);
    let mut cache: HashMap<PathBuf, Vec<BusinessInterface>> = HashMap::new();
    let local: HashSet<_> = doc.interfaces.iter().map(|i| i.id.clone()).collect();
    let mut resolved: HashMap<String, BusinessInterface> = HashMap::new();
    let mut conflicts = HashSet::new();
    let mut read_bytes = 0;
    for reference in &mut doc.references {
        if local.contains(&reference.ref_id) {
            reference.resolution.clear();
            continue;
        }
        let Some(relative) = relative_path(&reference.metadata_path) else {
            reference.resolution = "引用路径不合法；保留原文只读".into();
            continue;
        };
        let mut hits = Vec::new();
        for dir in &dirs {
            let candidate = dir.join("METADATA").join(&relative);
            let (Ok(base), Ok(path)) = (dir.canonicalize(), candidate.canonicalize()) else {
                continue;
            };
            // 拒绝跳出模块的链接及路径；元数据里的路径不能让读层任意访问文件。
            if !path.starts_with(base) {
                continue;
            }
            if !cache.contains_key(&path) {
                let Ok(meta) = std::fs::metadata(&path) else {
                    continue;
                };
                if meta.len() > MAX_DEFINITION_BYTES || read_bytes + meta.len() > MAX_READ_BYTES {
                    continue;
                }
                read_bytes += meta.len();
                let definitions = BmfDoc::open(&path)
                    .map(|external| {
                        let sha = crate::bmf_write::sha256(&external.bytes);
                        external
                            .interfaces
                            .into_iter()
                            .map(|mut i| {
                                i.external = true;
                                i.source_path = path.to_string_lossy().into_owned();
                                i.definition_sha = sha.clone();
                                i
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                cache.insert(path.clone(), definitions);
            }
            if let Some(interface) = cache[&path].iter().find(|i| i.id == reference.ref_id) {
                hits.push(interface.clone());
            }
        }
        let Some(first) = hits.first() else {
            reference.resolution = "未找到接口定义；外部实体、缺失文件或超出读取预算".into();
            continue;
        };
        if hits
            .iter()
            .any(|i| i.definition_sha != first.definition_sha)
            || resolved
                .get(&reference.ref_id)
                .is_some_and(|i| i.definition_sha != first.definition_sha)
        {
            conflicts.insert(reference.ref_id.clone());
        } else {
            resolved
                .entry(reference.ref_id.clone())
                .or_insert_with(|| first.clone());
            reference.resolution.clear();
        }
    }
    // 同一 ID 的不同 Reference 也可能指向不同版本，不能因第一个已加载就跳过后面的路径。
    let mut attached = local;
    for reference in &mut doc.references {
        if conflicts.contains(&reference.ref_id) {
            reference.resolution = "存在多个不同版本的接口定义；映射只读".into();
        } else if let Some(interface) = resolved.get(&reference.ref_id) {
            if attached.insert(reference.ref_id.clone()) {
                doc.interfaces.push(interface.clone());
            }
        }
    }
}

/// 事务投影复用已经读取的定义，只保留仍存在且路径未改的引用；删除引用不能留下幽灵接口。
pub fn carry_definitions(before: &BmfDoc, after: &mut BmfDoc) {
    after.interfaces.retain(|i| !i.external);
    let mut retained = HashSet::new();
    for reference in &mut after.references {
        if let Some(previous) = before.references.iter().find(|r| {
            r.id == reference.id
                && r.ref_id == reference.ref_id
                && r.metadata_path == reference.metadata_path
                && r.module == reference.module
        }) {
            reference.resolution = previous.resolution.clone();
            retained.insert(reference.ref_id.clone());
        }
    }
    let mut known: HashSet<_> = after.interfaces.iter().map(|i| i.id.clone()).collect();
    after.interfaces.extend(
        before
            .interfaces
            .iter()
            .filter(|i| i.external && retained.contains(&i.id) && known.insert(i.id.clone()))
            .cloned(),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_are_relative_bmf_paths_and_cannot_escape_roots() {
        assert_eq!(
            relative_path(r"\meta\general_interface.bmf"),
            Some(PathBuf::from("meta").join("general_interface.bmf"))
        );
        for raw in [
            "../private.bmf",
            "C:/private.bmf",
            "a/../../private.bmf",
            "a.xml",
        ] {
            assert!(relative_path(raw).is_none());
        }
    }

    #[test]
    fn real_external_interface_resolves_by_path_and_id_without_writing() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("uapbs/METADATA/meta");
        std::fs::create_dir_all(&target).unwrap();
        let original = include_bytes!("../tests/fixtures/bmf/uap-real/general_interface.bmf");
        let path = target.join("general_interface.bmf");
        std::fs::write(&path, original).unwrap();
        let mut doc = BmfDoc::from_bytes(
            PathBuf::from("matters.bmf"),
            include_bytes!("../tests/fixtures/bmf/uap-real/matters.bmf").to_vec(),
        )
        .unwrap();
        enrich(&mut doc, &[temp.path().to_path_buf()]);
        assert_eq!(doc.interfaces.len(), 1);
        assert!(doc.interfaces[0].external);
        assert_eq!(doc.interfaces[0].attrs.len(), 6);
        assert_eq!(std::fs::read(path).unwrap(), original);
    }

    #[test]
    fn different_paths_for_the_same_interface_id_cannot_pick_a_version() {
        let temp = tempfile::tempdir().unwrap();
        let metadata = temp.path().join("module/METADATA");
        std::fs::create_dir_all(&metadata).unwrap();
        for (file, display) in [("first.bmf", "First"), ("second.bmf", "Second")] {
            std::fs::write(
                metadata.join(file),
                format!(r#"<component><celllist><busiIterface id="i" displayName="{display}"/></celllist></component>"#),
            )
            .unwrap();
        }
        let mut doc = BmfDoc::from_bytes(
            metadata.join("source.bmf"),
            br#"<component><celllist><entity id="e"><attributelist><attribute id="a" name="code" typeName="String"/></attributelist><busiitfs><itfid>i</itfid></busiitfs><busimaps/></entity><Reference id="r1" refId="i" mdFilePath="first.bmf"/><Reference id="r2" refId="i" mdFilePath="second.bmf"/></celllist></component>"#.to_vec(),
        )
        .unwrap();
        enrich(&mut doc, &[]);
        assert!(doc.interfaces.is_empty());
        assert!(doc
            .references
            .iter()
            .all(|r| r.resolution.contains("多个不同版本")));
        assert!(crate::bmf_write::apply(
            &doc,
            &[crate::bmf_write::EditOp::SetMapping {
                entity: "e".into(),
                interface_id: "i".into(),
                interface_attr_id: "ia".into(),
                attr_id: "a".into(),
            }]
        )
        .is_err());
    }

    #[test]
    fn projection_carries_only_unchanged_references_and_their_resolution() {
        let mut before = BmfDoc::from_bytes(
            PathBuf::new(),
            br#"<component><celllist><Reference id="r" refId="i" mdFilePath="first.bmf"/></celllist></component>"#.to_vec(),
        )
        .unwrap();
        before.references[0].resolution = "读取说明".into();
        before.interfaces.push(BusinessInterface {
            id: "i".into(),
            external: true,
            ..Default::default()
        });
        let mut unchanged = BmfDoc::from_bytes(PathBuf::new(), before.bytes.clone()).unwrap();
        carry_definitions(&before, &mut unchanged);
        assert_eq!(unchanged.interfaces.len(), 1);
        assert_eq!(unchanged.references[0].resolution, "读取说明");

        let mut changed = unchanged.clone();
        changed.references[0].metadata_path = "second.bmf".into();
        carry_definitions(&before, &mut changed);
        assert!(changed.interfaces.is_empty());

        let mut removed = unchanged;
        removed.references.clear();
        carry_definitions(&before, &mut removed);
        assert!(removed.interfaces.is_empty());
    }
}
