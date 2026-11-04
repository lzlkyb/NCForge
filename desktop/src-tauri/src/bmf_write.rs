//! BMF 受控写回（M2）。
//!
//! 四条不可调换的顺序：**校验原件 → 备份 → 原子写 → 出 diff**。
//!
//! - 校验原件用 SHA-256：`doc` 打开之后文件可能被 Eclipse / SVN / 别的会话改过，
//!   直接按内存里的 span 写回去会覆盖别人的改动。哈希不一致就报 `CONFLICT`。
//! - 所有编辑都在**原始字节**上做：只替换目标属性值/插入新节点，未知节点、属性
//!   顺序、CRLF 全部原样保留。
//! - 备份到 `{config_dir}/bmf_backup/<时间戳>-<文件名>`；备份失败就不写。
//! - 新建（脚手架）只允许目标不存在：目标存在直接拒绝，不做「先删再写」。

use std::path::Path;
use encoding_rs::GBK;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::atomic_file;
use crate::bmf_model::BmfDoc;
use crate::workspace::TextEncoding;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub path: String,
    pub backup: Option<String>,
    pub sha_before: String,
    pub sha_after: String,
    pub diff: String,
    pub changed: bool,
}

/// 一次编辑。只覆盖 M2 首期范围：改属性、加属性、加枚举项。
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum EditOp {
    /// 改已有属性的一个 XML 属性（displayName / length / isNullable / defaultValue / fieldName）。
    SetAttr { id: String, name: String, value: String },
    /// 改实体的 `keyAttributeId`（同时把目标属性 isKey 置 true 会另发一条 SetAttr）。
    SetEntityKey { entity: String, attr_id: String },
    /// 新增一个属性（SINGLE/REF）。`id` 为空时自动生成。
    AddAttribute {
        entity: String,
        name: String,
        display_name: String,
        #[serde(default = "dflt_style")]
        style: String,
        #[serde(default = "dflt_type")]
        type_name: String,
        #[serde(default)]
        data_type: String,
        #[serde(default)]
        db_type: String,
        #[serde(default)]
        length: Option<u32>,
        #[serde(default)]
        nullable: bool,
        #[serde(default)]
        default_value: String,
        #[serde(default)]
        is_key: bool,
        #[serde(default)]
        id: String,
    },
    AddEnumItem {
        enum_id: String,
        value: String,
        display: String,
        #[serde(default)]
        id: String,
    },
}

fn dflt_style() -> String {
    "SINGLE".into()
}
fn dflt_type() -> String {
    "String".into()
}

/// 在内存里执行编辑，返回新字节。**不碰磁盘**——预览与保存共用这一条路径。
pub fn apply(doc: &BmfDoc, ops: &[EditOp]) -> Result<Vec<u8>, String> {
    // 所有 span 都是**原始字节**里的位置。边改边写会让后面的 span 全部偏移，
    // 所以先收集 (start, end, 新字节)，再按位置倒序应用。
    let mut edits: Vec<(usize, usize, Vec<u8>)> = Vec::new();
    let mut added: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
    for op in ops {
        match op {
            EditOp::SetAttr { id, name, value } => {
                let node = doc.find_node(id).ok_or_else(|| format!("找不到节点 {id}"))?;
                let attr = node
                    .attrs
                    .iter()
                    .find(|a| a.name.eq_ignore_ascii_case(name))
                    .ok_or_else(|| format!("{} 上没有属性 {name}", node.name))?;
                let enc = encode(doc.encoding, &escape_xml(value))?;
                edits.push((attr.value_span.start, attr.value_span.end, enc));
            }
            EditOp::SetEntityKey { entity, attr_id } => {
                let node = doc.find_node(entity).ok_or_else(|| format!("找不到实体 {entity}"))?;
                if node.name != "entity" {
                    return Err(format!("{entity} 不是 entity 节点"));
                }
                let attr = node
                    .attrs
                    .iter()
                    .find(|a| a.name == "keyAttributeId")
                    .ok_or("entity 上没有 keyAttributeId 属性")?;
                edits.push((
                    attr.value_span.start,
                    attr.value_span.end,
                    encode(doc.encoding, attr_id)?,
                ));
            }
            EditOp::AddAttribute {
                entity,
                name,
                display_name,
                style,
                type_name,
                data_type,
                db_type,
                length,
                nullable,
                default_value,
                is_key,
                id,
            } => {
                let ent = doc.entities.iter().find(|e| e.id == *entity || e.name == *entity)
                    .ok_or_else(|| format!("找不到实体 {entity}"))?;
                let key = (ent.id.clone(), name.clone());
                if ent.attrs.iter().any(|a| a.name == *name) || !added.insert(key) {
                    return Err(format!("实体 {} 已有属性 {}", ent.name, name));
                }
                let node = doc.find_node(&ent.id).ok_or("实体节点丢失")?;
                let list = node
                    .child("attributelist")
                    .ok_or_else(|| format!("实体 {} 没有 attributelist", ent.name))?;
                let attr_id = if id.is_empty() { uuid_like() } else { id.clone() };
                let seq = ent.attrs.iter().map(|a| a.sequence).max().unwrap_or(-1) + 1;
                let xml = format!(
                    "<attribute accessStrategy=\"\" classID=\"{}\" dataType=\"{}\" dataTypeStyle=\"{}\" dbtype=\"{}\" defaultValue=\"{}\" displayName=\"{}\" fieldName=\"{}\" fieldType=\"{}\" id=\"{}\" isKey=\"{}\" isNullable=\"{}\" length=\"{}\" name=\"{}\" precise=\"\" sequence=\"{}\" typeDisplayName=\"{}\" typeName=\"{}\"/>",
                    ent.id,
                    xml_attr(data_type),
                    xml_attr(style),
                    xml_attr(db_type),
                    xml_attr(default_value),
                    xml_attr(display_name),
                    xml_attr(name),
                    xml_attr(if db_type.is_empty() { "" } else { db_type }),
                    attr_id,
                    is_key,
                    nullable,
                    length.map(|l| l.to_string()).unwrap_or_default(),
                    xml_attr(name),
                    seq,
                    xml_attr(type_name),
                    xml_attr(type_name)
                );
                edits.push(container_edit(doc, list, "attributelist", &xml));
            }
            EditOp::AddEnumItem { enum_id, value, display, id } => {
                let n = doc.find_node(enum_id).ok_or_else(|| format!("找不到枚举 {enum_id}"))?;
                let list = n.child("enumitemlist").ok_or("枚举没有 enumitemlist")?;
                let item_id = if id.is_empty() { uuid_like() } else { id.clone() };
                let seq = list.children.iter().filter(|c| c.name == "enumitem").count();
                let xml = format!(
                    "<enumitem description=\"\" enumDisplay=\"{}\" enumID=\"{}\" enumValue=\"{}\" hidden=\"false\" id=\"{}\" sequence=\"{}\"/>",
                    xml_attr(display),
                    xml_attr(enum_id),
                    xml_attr(value),
                    item_id,
                    seq
                );
                edits.push(container_edit(doc, list, "enumitemlist", &xml));
            }
        }
    }
    edits.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
    let mut bytes = doc.bytes.clone();
    let mut last_start = bytes.len() + 1;
    for (start, end, data) in edits {
        if end > last_start {
            return Err("编辑位置重叠：同一次提交里改了同一段内容".to_string());
        }
        bytes.splice(start..end, data);
        last_start = start;
    }
    Ok(bytes)
}

/// 往容器里追加一个子节点。空容器 `<x/>` 要先展开成 `<x>…</x>`。
fn container_edit(
    doc: &BmfDoc,
    node: &crate::bmf_model::XmlNode,
    tag: &str,
    xml: &str,
) -> (usize, usize, Vec<u8>) {
    if node.self_closing {
        let outer = indent_before(doc, node.start);
        let inner = format!("{outer}  ");
        return (
            node.end.saturating_sub(2),
            node.end,
            format!(">\r\n{inner}{xml}\r\n{outer}</{tag}>").into_bytes(),
        );
    }
    let indent = node
        .children
        .first()
        .map(|c| indent_before(doc, c.start))
        .unwrap_or_else(|| format!("{}  ", indent_before(doc, node.start)));
    let close = format!("</{tag}>");
    let at = node
        .end
        .checked_sub(close.len())
        .filter(|i| doc.bytes[*i..node.end] == *close.as_bytes())
        .unwrap_or(node.end);
    (at, at, format!("{indent}{xml}\r\n").into_bytes())
}

/// 执行编辑并预览 diff（不写盘）。
pub fn preview(doc: &BmfDoc, ops: &[EditOp]) -> Result<(Vec<u8>, String), String> {
    let new = apply(doc, ops)?;
    let diff = diff_text(&doc.bytes, &new);
    Ok((new, diff))
}

/// 保存：哈希校验 + 备份 + 原子写 + diff。
pub fn save(doc: &BmfDoc, ops: &[EditOp], backup_dir: &Path) -> Result<WriteResult, String> {
    let new = apply(doc, ops)?;
    let current = std::fs::read(&doc.path).map_err(|e| format!("读取原文件失败：{e}"))?;
    let sha_before = sha256(&current);
    if sha_before != sha256(&doc.bytes) {
        return Err("CONFLICT: 文件在打开之后被其他程序改过，请重新加载后再改".to_string());
    }
    if new == current {
        return Ok(WriteResult {
            path: doc.path.to_string_lossy().into_owned(),
            backup: None,
            sha_before: sha_before.clone(),
            sha_after: sha_before,
            diff: String::new(),
            changed: false,
        });
    }
    let backup = Some(backup(&doc.path, backup_dir)?);
    atomic_file::write_atomic(&doc.path, &new)?;
    Ok(WriteResult {
        path: doc.path.to_string_lossy().into_owned(),
        backup,
        sha_before,
        sha_after: sha256(&new),
        diff: diff_text(&current, &new),
        changed: true,
    })
}

/// 新建文件（脚手架生成）。目标已存在 → 拒绝；父目录不存在 → 建出来。
pub fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if path.exists() {
        return Err(format!("目标已存在，拒绝覆盖：{}", path.display()));
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建目录失败：{e}"))?;
    }
    atomic_file::write_atomic(path, bytes)
}

/// 备份到 `backup_dir/<时间戳>-<文件名>`。返回备份的绝对路径。
pub fn backup(path: &Path, backup_dir: &Path) -> Result<String, String> {
    std::fs::create_dir_all(backup_dir).map_err(|e| format!("创建备份目录失败：{e}"))?;
    let name = path.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or("file.bmf".into());
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dest = backup_dir.join(format!("{stamp}-{name}"));
    std::fs::copy(path, &dest).map_err(|e| format!("备份失败：{e}"))?;
    Ok(dest.to_string_lossy().into_owned())
}

pub fn sha256(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}

fn encode(enc: TextEncoding, s: &str) -> Result<Vec<u8>, String> {
    match enc {
        TextEncoding::Utf8 => Ok(s.as_bytes().to_vec()),
        TextEncoding::Gbk => {
            let (cow, _, bad) = GBK.encode(s);
            if bad {
                Err(format!("内容含 GBK 无法表示的字符：{s}"))
            } else {
                Ok(cow.into_owned())
            }
        }
    }
}

fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn xml_attr(s: &str) -> String {
    escape_xml(s)
}

/// 取容器起始标签所在行的缩进（新增节点与同层节点对齐）。
fn indent_before(doc: &BmfDoc, start: usize) -> String {
    let line_start = doc.bytes[..start].iter().rposition(|b| *b == b'\n').map(|i| i + 1).unwrap_or(0);
    let s = &doc.bytes[line_start..start];
    let ws: Vec<u8> = s.iter().copied().take_while(|b| *b == b' ' || *b == b'\t').collect();
    String::from_utf8_lossy(&ws).into_owned()
}

fn diff_text(old: &[u8], new: &[u8]) -> String {
    let a = String::from_utf8_lossy(old).replace("\r\n", "\n");
    let b = String::from_utf8_lossy(new).replace("\r\n", "\n");
    similar::TextDiff::from_lines(&a, &b)
        .unified_diff()
        .header("原文件", "修改后")
        .to_string()
}

/// UUID v4 形态的随机 ID。不引入 uuid 依赖：用时间 + 进程 + 计数器做种子，
/// 只需要「同一次生成内不重复、跨会话极难撞」。
pub fn uuid_like() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let mut x = nanos ^ (std::process::id() as u64).rotate_left(17) ^ n.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    let mut next = || {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        x
    };
    let a = next();
    let b = next();
    format!(
        "{:08x}-{:04x}-4{:03x}-{:x}{:03x}-{:012x}",
        (a >> 32) as u32,
        (a >> 16) as u16,
        a & 0xfff,
        ((b >> 60) as u8 & 0x3) | 0x8,
        (b >> 48) & 0xfff,
        b & 0xffff_ffff_ffff
    )
}

/// 由稳定种子推导一个 UUID 形态的 id（脚手架里的主键/聚合属性用）。
///
/// 为什么不用随机：`keyAttributeId` 和 `AggregationRelation.srcAttributeid` 要引用
/// 同一个属性 id，而这两处是在不同函数里拼出来的。确定性推导比「先生成再传三层」
/// 更难接错。
pub fn uuid_from_seed(seed: &str) -> String {
    let d = Sha256::digest(seed.as_bytes());
    let h = |i: usize| format!("{:02x}", d[i]);
    // 8-4-4-4-12；第 3 组固定版本 4，第 4 组高位固定 10xx。
    let variant = format!("{:02x}", (d[8] & 0x3f) | 0x80);
    let group3 = ((d[6] as u16) << 8 | d[7] as u16) & 0xfff;
    format!(
        "{}{}{}{}-{}{}-4{:03x}-{}{}-{}{}{}{}{}{}",
        h(0), h(1), h(2), h(3),
        h(4), h(5),
        group3,
        variant, h(9),
        h(10), h(11), h(12), h(13), h(14), h(15)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bmf_model::BmfDoc;
    use std::path::PathBuf;

    const XML: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\r\n<component id=\"c\" name=\"c\" namespace=\"m\" ownModule=\"m\" mainEntity=\"e\"><celllist>\r\n  <entity id=\"e\" name=\"H\" tableName=\"t\" fullClassName=\"nc.vo.m.c.H\" isPrimary=\"true\" keyAttributeId=\"a1\">\r\n    <attributelist>\r\n      <attribute id=\"a1\" name=\"pk\" fieldName=\"pk\" displayName=\"主键\" typeName=\"UFID\" length=\"20\" isKey=\"true\" sequence=\"0\"/>\r\n    </attributelist>\r\n  </entity>\r\n  <Enumerate id=\"n1\" name=\"st\" typeName=\"String\"><enumitemlist>\r\n    <enumitem id=\"i1\" enumValue=\"1\" enumDisplay=\"A\"/>\r\n  </enumitemlist></Enumerate>\r\n</celllist></component>\r\n";

    fn doc() -> BmfDoc {
        BmfDoc::from_bytes(PathBuf::from("t.bmf"), XML.as_bytes().to_vec()).unwrap()
    }

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ncwb-bmfw-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn set_attr_keeps_every_other_byte() {
        let d = doc();
        let new = apply(
            &d,
            &[EditOp::SetAttr {
                id: "a1".into(),
                name: "displayName".into(),
                value: "主键（改）".into(),
            }],
        )
        .unwrap();
        let s = String::from_utf8(new.clone()).unwrap();
        assert!(s.contains("displayName=\"主键（改）\""));
        assert!(s.contains("\r\n"));
        // 只多出中文的字节，其余结构原样
        assert_eq!(s.matches("<attribute ").count(), 1);
        assert_eq!(new.len(), d.bytes.len() + "（改）".len());
    }

    #[test]
    fn add_attribute_is_indented_and_parsable() {
        let d = doc();
        let new = apply(
            &d,
            &[EditOp::AddAttribute {
                entity: "e".into(),
                name: "vbillcode".into(),
                display_name: "单据号".into(),
                style: "SINGLE".into(),
                type_name: "String".into(),
                data_type: "BS2".into(),
                db_type: "varchar".into(),
                length: Some(40),
                nullable: true,
                default_value: String::new(),
                is_key: false,
                id: String::new(),
            }],
        )
        .unwrap();
        let d2 = BmfDoc::from_bytes(PathBuf::from("t2.bmf"), new).unwrap();
        let a = d2.entities[0].attrs.iter().find(|a| a.name == "vbillcode").unwrap();
        assert_eq!(a.length, Some(40));
        assert!(a.id.len() > 10);
        // 缩进与已有的 attribute 对齐
        assert!(String::from_utf8(d2.bytes).unwrap().contains("      <attribute"));
    }

    #[test]
    fn add_duplicate_attribute_is_refused() {
        let d = doc();
        let err = apply(
            &d,
            &[EditOp::AddAttribute {
                entity: "e".into(),
                name: "pk".into(),
                display_name: String::new(),
                style: "SINGLE".into(),
                type_name: "String".into(),
                data_type: String::new(),
                db_type: String::new(),
                length: None,
                nullable: true,
                default_value: String::new(),
                is_key: false,
                id: String::new(),
            }],
        )
        .unwrap_err();
        assert!(err.contains("已有属性"));
    }

    #[test]
    fn add_enum_item_keeps_enum_valid() {
        let d = doc();
        let new = apply(
            &d,
            &[EditOp::AddEnumItem {
                enum_id: "n1".into(),
                value: "2".into(),
                display: "停用".into(),
                id: String::new(),
            }],
        )
        .unwrap();
        let d2 = BmfDoc::from_bytes(PathBuf::new(), new).unwrap();
        assert_eq!(d2.enums[0].items.len(), 2);
        assert_eq!(d2.enums[0].items[1].display, "停用");
    }

    #[test]
    fn save_backs_up_and_detects_conflict() {
        let d = tmpdir("save");
        let p = d.join("t.bmf");
        std::fs::write(&p, XML).unwrap();
        let doc = BmfDoc::open(&p).unwrap();
        let backup_dir = d.join("bak");
        let r = save(
            &doc,
            &[EditOp::SetAttr {
                id: "a1".into(),
                name: "displayName".into(),
                value: "X".into(),
            }],
            &backup_dir,
        )
        .unwrap();
        assert!(r.changed);
        assert!(r.diff.contains("displayName=\"X\""));
        let b = r.backup.unwrap();
        assert_eq!(std::fs::read(&b).unwrap(), XML.as_bytes());

        // 磁盘被改过 → 用旧 doc 再写必须拒绝
        let mut changed = std::fs::read(&p).unwrap();
        changed.push(b' ');
        std::fs::write(&p, &changed).unwrap();
        let err = save(&doc, &[], &backup_dir).unwrap_err();
        assert!(err.starts_with("CONFLICT"));
    }

    #[test]
    fn no_op_save_does_not_touch_the_file() {
        let d = tmpdir("noop");
        let p = d.join("t.bmf");
        std::fs::write(&p, XML).unwrap();
        let doc = BmfDoc::open(&p).unwrap();
        let r = save(&doc, &[], &d.join("bak")).unwrap();
        assert!(!r.changed);
        assert!(r.backup.is_none());
        assert_eq!(std::fs::read(&p).unwrap(), XML.as_bytes());
    }

    #[test]
    fn write_new_refuses_existing_path() {
        let d = tmpdir("new");
        let p = d.join("a.bmf");
        write_new(&p, b"x").unwrap();
        let err = write_new(&p, b"y").unwrap_err();
        assert!(err.contains("拒绝覆盖"));
        assert_eq!(std::fs::read(&p).unwrap(), b"x");
    }

    #[test]
    fn uuid_like_has_v4_shape_and_no_collisions() {
        let mut seen = std::collections::HashSet::new();
        for _ in 0..1000 {
            let u = uuid_like();
            assert_eq!(u.len(), 36);
            assert_eq!(u.as_bytes()[14], b'4');
            assert!(seen.insert(u));
        }
    }

    #[test]
    fn seeded_uuid_is_stable_and_well_formed() {
        let a = uuid_from_seed("entity:pk_head");
        let b = uuid_from_seed("entity:pk_head");
        let c = uuid_from_seed("entity:pk_body");
        assert_eq!(a, b);
        assert_ne!(a, c);
        let groups: Vec<usize> = a.split('-').map(|g| g.chars().count()).collect();
        assert_eq!(groups, vec![8, 4, 4, 4, 12]);
        assert_eq!(a.as_bytes()[14], b'4');
        assert!(matches!(a.as_bytes()[19], b'8' | b'9' | b'a' | b'b'));
    }
}
