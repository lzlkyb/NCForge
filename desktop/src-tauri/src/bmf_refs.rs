//! F1：跨工程引用扫描（只读）。
//!
//! 判据只用「类的全名」（实体的 `fullClassName`、枚举的 `fullClassName`）：
//! 它是跨组件唯一稳定的引用键。短类名会误伤同名类，不做模糊匹配。
//! 扫描范围与左栏索引同一批文件（`bmf_index::list_bmfs`），不另造一套遍历规则。

use serde::Serialize;
use std::path::PathBuf;

use crate::bmf_model::BmfDoc;

pub const MAX_HITS: usize = 500;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefHit {
    /// 引用方的 BMF 路径。
    pub path: String,
    pub component: String,
    pub entity: String,
    pub attr: String,
    /// `typeName` 或 `refModelName`。
    pub field: String,
    pub value: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefScan {
    pub hits: Vec<RefHit>,
    pub scanned: usize,
    /// 解析失败被跳过的文件数（坏 XML 不应该让整次扫描失败）。
    pub skipped: usize,
    /// 命中超过上限被截断。
    pub truncated: bool,
}

/// 目标组件里可被外部引用的键：`小写全名 → 显示用名字`。
fn keys(target: &BmfDoc) -> std::collections::HashMap<String, String> {
    let mut m = std::collections::HashMap::new();
    for e in &target.entities {
        let k = e.full_class.trim();
        if !k.is_empty() {
            m.insert(k.to_lowercase(), e.name.clone());
        }
    }
    for e in &target.enums {
        let k = e.full_class.trim();
        if !k.is_empty() {
            m.entry(k.to_lowercase()).or_insert_with(|| e.name.clone());
        }
    }
    m
}

/// 在已解析的其他组件里找对 `target` 的引用。
pub fn references(target: &BmfDoc, others: &[BmfDoc]) -> RefScan {
    let keys = keys(target);
    let mut out = RefScan {
        scanned: others.len(),
        ..RefScan::default()
    };
    if keys.is_empty() {
        return out;
    }
    'docs: for doc in others {
        for ent in &doc.entities {
            for attr in &ent.attrs {
                for (field, value) in [("typeName", &attr.type_name), ("refModelName", &attr.ref_model)] {
                    let v = value.trim();
                    if v.is_empty() || !keys.contains_key(&v.to_lowercase()) {
                        continue;
                    }
                    if out.hits.len() >= MAX_HITS {
                        out.truncated = true;
                        break 'docs;
                    }
                    out.hits.push(RefHit {
                        path: doc.path.to_string_lossy().into_owned(),
                        component: doc.component.name.clone(),
                        entity: ent.name.clone(),
                        attr: attr.name.clone(),
                        field: field.to_string(),
                        value: v.to_string(),
                    });
                }
            }
        }
    }
    out
}

/// 连同解析失败计数一起扫描一组文件。目标文件自身会被跳过。
pub fn scan_files(target_path: &std::path::Path, files: &[PathBuf]) -> Result<RefScan, String> {
    let target = BmfDoc::open(target_path)?;
    let target_norm = target_path.canonicalize().unwrap_or_else(|_| target_path.to_path_buf());
    let mut docs = Vec::new();
    let mut skipped = 0;
    for f in files {
        let norm = f.canonicalize().unwrap_or_else(|_| f.clone());
        if norm == target_norm {
            continue;
        }
        match BmfDoc::open(f) {
            Ok(d) => docs.push(d),
            Err(_) => skipped += 1,
        }
    }
    let mut out = references(&target, &docs);
    out.skipped = skipped;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TARGET: &str = "<component id=\"c\" name=\"c\" namespace=\"m\" ownModule=\"m\"><celllist>\r\n  <entity id=\"e\" name=\"H\" tableName=\"t\" fullClassName=\"nc.vo.m.c.H\"><attributelist/></entity>\r\n  <Enumerate id=\"n1\" name=\"st\" typeName=\"String\" fullClassName=\"nc.vo.m.c.StEnum\"><enumitemlist/></Enumerate>\r\n</celllist></component>";
    const OTHER: &str = "<component id=\"d\" name=\"d\" namespace=\"m\" ownModule=\"m\"><celllist>\r\n  <entity id=\"x\" name=\"B\" tableName=\"tb\" fullClassName=\"nc.vo.m.d.B\">\r\n    <attributelist>\r\n      <attribute id=\"a1\" name=\"h\" fieldName=\"h\" typeName=\"nc.vo.m.c.H\"/>\r\n      <attribute id=\"a2\" name=\"h2\" fieldName=\"h2\" refModelName=\"NC.VO.M.C.H\"/>\r\n      <attribute id=\"a3\" name=\"s\" fieldName=\"s\" typeName=\"String\"/>\r\n      <attribute id=\"a4\" name=\"e\" fieldName=\"e\" typeName=\"nc.vo.m.c.StEnum\"/>\r\n    </attributelist>\r\n  </entity>\r\n</celllist></component>";

    fn doc(name: &str, xml: &str) -> BmfDoc {
        BmfDoc::from_bytes(PathBuf::from(name), xml.as_bytes().to_vec()).unwrap()
    }

    #[test]
    fn finds_type_name_and_ref_model_by_full_class() {
        let scan = references(&doc("c.bmf", TARGET), &[doc("d.bmf", OTHER)]);
        assert_eq!(scan.scanned, 1);
        assert_eq!(scan.hits.len(), 3, "{:?}", scan.hits);
        assert!(scan.hits.iter().all(|h| h.component == "d" && h.entity == "B"));
        assert!(scan.hits.iter().any(|h| h.attr == "h2" && h.field == "refModelName" && h.value == "NC.VO.M.C.H"));
        assert!(scan.hits.iter().any(|h| h.attr == "e" && h.value == "nc.vo.m.c.StEnum"));
        assert!(!scan.hits.iter().any(|h| h.attr == "s" || h.attr == "a3"));
    }

    #[test]
    fn ignores_short_names_and_empty_targets() {
        let short = "<component id=\"d\" name=\"d\"><celllist><entity id=\"x\" name=\"B\"><attributelist><attribute id=\"a\" name=\"h\" typeName=\"H\"/></attributelist></entity></celllist></component>";
        let scan = references(&doc("c.bmf", TARGET), &[doc("d.bmf", short)]);
        assert!(scan.hits.is_empty());

        let empty = "<component id=\"d\" name=\"d\"><celllist><entity id=\"x\" name=\"B\"><attributelist/></entity></celllist></component>";
        let scan = references(&doc("c.bmf", empty), &[doc("e.bmf", OTHER)]);
        assert!(scan.hits.is_empty());
    }
}
