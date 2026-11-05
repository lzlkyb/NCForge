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
    /// 删除任意可删节点（实体/属性/枚举/枚举项/关系）。容器与组件根不允许删；
    /// 仍被引用的节点会拒绝，避免留下悬空引用。
    DeleteNode { id: String },
    /// 新增实体（带空的 attributelist）。
    AddEntity {
        name: String,
        display_name: String,
        table: String,
        full_class: String,
        #[serde(default)]
        accessor: String,
        #[serde(default)]
        is_primary: bool,
        #[serde(default)]
        id: String,
        /// 随实体一起写入的字段（「复制已有实体」用它，避免两次保存之间引用不到新实体）。
        #[serde(default)]
        attrs: Vec<NewAttr>,
    },
    /// 新增枚举（带空的 enumitemlist）。
    AddEnum {
        name: String,
        display_name: String,
        #[serde(default = "dflt_type")]
        type_name: String,
        #[serde(default)]
        data_type: String,
        #[serde(default)]
        id: String,
    },
    /// 新增连接关系（聚合/参照/业务接口）。
    AddRelation {
        kind: String,
        name: String,
        source: String,
        target: String,
        #[serde(default)]
        src_attr_id: String,
        #[serde(default)]
        target_attr_id: String,
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

/// 新建实体时随实体写入的字段规格（与 AddAttribute 同字段名）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewAttr {
    pub name: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default = "dflt_style")]
    pub style: String,
    #[serde(default = "dflt_type")]
    pub type_name: String,
    #[serde(default)]
    pub data_type: String,
    #[serde(default)]
    pub db_type: String,
    #[serde(default)]
    pub length: Option<u32>,
    #[serde(default)]
    pub nullable: bool,
    #[serde(default)]
    pub default_value: String,
    #[serde(default)]
    pub is_key: bool,
    #[serde(default)]
    pub id: String,
}

/// 字段名口径与脚手架 `normalize_ident` 一致：小写字母开头，只含小写字母/数字/下划线。
/// 写回层再校验一次：命令可被前端以外调用，不能只靠界面禁用按钮。
fn is_field_ident(s: &str) -> bool {
    let mut it = s.bytes();
    match it.next() {
        Some(b) if b.is_ascii_lowercase() => {}
        _ => return false,
    }
    it.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// 只允许能通过官方工具与数据库校验的属性值。`escape_xml` 只管转义，不管内容合法性：
/// 以前长度提交 `NaN` / 负数会原样写进 BMF，下一次解析或建表才炸。
fn validate_attr_value(name: &str, value: &str) -> Result<(), String> {
    let attr = name.to_ascii_lowercase();
    let v = value.trim();
    match attr.as_str() {
        "length" => {
            if v.is_empty() {
                return Ok(());
            }
            let n: u32 = v
                .parse()
                .map_err(|_| format!("length 必须是正整数：{value}"))?;
            if n == 0 {
                return Err("length 必须大于 0".to_string());
            }
        }
        "sequence" | "precision" => {
            if !v.is_empty() {
                v.parse::<u32>()
                    .map_err(|_| format!("{name} 必须是非负整数：{value}"))?;
            }
        }
        "isnullable" | "iskey" if v != "true" && v != "false" => {
            return Err(format!("{name} 只能是 true 或 false：{value}"));
        }
        _ => {}
    }
    Ok(())
}

fn is_entity_name(s: &str) -> bool {
    let mut it = s.bytes();
    match it.next() {
        Some(b) if b.is_ascii_alphabetic() => {}
        _ => return false,
    }
    it.all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

fn is_table_name(s: &str) -> bool {
    let mut it = s.bytes();
    match it.next() {
        Some(b) if b.is_ascii_alphabetic() => {}
        _ => return false,
    }
    it.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'$' | b'#'))
}

fn is_accessor(s: &str) -> bool {
    !s.is_empty()
        && s.split('.').all(|seg| {
            !seg.is_empty()
                && seg
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'$')
        })
}

fn is_qualified_class(s: &str) -> bool {
    if !s.starts_with("nc.vo.") {
        return false;
    }
    s.split('.').all(|seg| !seg.is_empty() && seg.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'$'))
}

/// 按节点类型校验被改的 XML 属性。写回命令可被前端以外调用，不能只靠界面禁用。
fn validate_node_attr(doc: &BmfDoc, node: &crate::bmf_model::XmlNode, name: &str, value: &str) -> Result<(), String> {
    let lower = name.to_ascii_lowercase();
    if lower == "id" {
        return Err("id 是引用锚点，不能在编辑里修改".to_string());
    }
    let v = value.trim();
    match node.name.as_str() {
        "attribute" => {
            validate_attr_value(name, value)?;
            match lower.as_str() {
                "name" | "fieldname" if !is_field_ident(v) => {
                    return Err(format!("字段名只能以小写字母开头，且只含小写字母、数字、下划线：{value}"))
                }
                "style" if !matches!(v, "SINGLE" | "REF" | "ARRAY") => {
                    return Err(format!("dataTypeStyle 只能是 SINGLE / REF / ARRAY：{value}"))
                }
                "typename" if v.is_empty() => return Err("typeName 不能为空".to_string()),
                "name" | "fieldname" => {
                    let dup = doc.entities.iter().flat_map(|e| e.attrs.iter()).any(|a| {
                        a.id != node.attr_or("id", "") &&
                            ((lower == "name" && a.name == v) || (lower == "fieldname" && a.field == v))
                    });
                    if dup {
                        return Err(format!("同一组件内已存在相同的{}：{v}", if lower == "name" { "字段名" } else { "列名" }));
                    }
                }
                _ => {}
            }
        }
        "entity" => match lower.as_str() {
            "name" if !is_entity_name(v) => {
                return Err(format!("实体名只能包含字母、数字、下划线，且以字母开头：{value}"))
            }
            "tablename" if !is_table_name(v) => {
                return Err(format!("表名只能包含字母、数字、下划线、$、#，且以字母开头：{value}"))
            }
            "fullclassname" if !is_qualified_class(v) => {
                return Err(format!("fullClassName 必须是 nc.vo. 开头的完整类名：{value}"))
            }
            "accessor" if !v.is_empty() && !is_accessor(v) => {
                return Err(format!("访问器只能是字母/数字/下划线：{value}"))
            }
            "isprimary" | "iskey" if v != "true" && v != "false" => {
                return Err(format!("{name} 只能是 true 或 false：{value}"))
            }
            "keyattributeid" if !v.is_empty() => {
                let id = node.attr_or("id", "");
                let own = doc.entities.iter().find(|e| e.id == id);
                if !own.map(|e| e.attrs.iter().any(|a| a.id == v)).unwrap_or(false) {
                    return Err("keyAttributeId 必须指向该实体内某个属性".to_string());
                }
            }
            _ => {}
        },
        "component" => match lower.as_str() {
            "name" | "namespace" | "ownmodule" if !is_field_ident(v) => {
                return Err(format!("{name} 只能用小写字母、数字、下划线，且以字母开头：{value}"))
            }
            "mainentity" if !v.is_empty() => {
                if !doc.entities.iter().any(|e| e.id == v) {
                    return Err("mainEntity 必须指向本组件内某个实体".to_string());
                }
            }
            "version" if v.parse::<u32>().is_err() => {
                return Err(format!("version 必须是非负整数：{value}"))
            }
            _ => {}
        },
        "Enumerate" => match lower.as_str() {
            "name" if !is_entity_name(v) => return Err(format!("枚举名只能包含字母、数字、下划线：{value}")),
            "typename" if v.is_empty() => return Err("枚举 typeName 不能为空".to_string()),
            _ => {}
        },
        "AggregationRelation" | "Reference" | "busiitfconnection" => match lower.as_str() {
            "source" | "target" if !doc.entities.iter().any(|e| e.id == v || e.name == v) => {
                return Err(format!("关系端点必须是本组件内的实体：{value}"))
            }
            "srcattributeid" | "targetattributeid"
                if !v.is_empty()
                    && !doc.entities.iter().flat_map(|e| e.attrs.iter()).any(|a| a.id == v) =>
            {
                return Err(format!("关系属性必须是本组件内的属性：{value}"))
            }
            _ => {}
        },
        _ => {}
    }
    Ok(())
}

/// 在内存里执行编辑，返回新字节。**不碰磁盘**——预览与保存共用这一条路径。
pub fn apply(doc: &BmfDoc, ops: &[EditOp]) -> Result<Vec<u8>, String> {
    // 所有 span 都是**原始字节**里的位置。边改边写会让后面的 span 全部偏移，
    // 所以先收集 (start, end, 新字节)，再按位置倒序应用。
    let mut edits: Vec<(usize, usize, Vec<u8>)> = Vec::new();
    let mut added: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
    // 同一批里新增的实体/枚举/关系也要去重：校验拿的是打开时的 doc，看不到还没落地的兄弟操作。
    let mut new_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    // 新增实体的 name/id → 生成的 id，供同批 AddRelation 解析端点。
    let mut new_entities: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut new_tables: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut new_enum_names: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut new_relations: std::collections::HashSet<(String, String, String)> =
        std::collections::HashSet::new();
    for op in ops {
        match op {
            EditOp::SetAttr { id, name, value } => {
                validate_attr_value(name, value)?;
                let node = doc.find_node(id).ok_or_else(|| format!("找不到节点 {id}"))?;
                validate_node_attr(doc, node, name, value)?;
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
                let ent = doc
                    .entities
                    .iter()
                    .find(|e| e.id == *entity || e.name == *entity)
                    .ok_or_else(|| format!("找不到实体 {entity}"))?;
                if !attr_id.trim().is_empty() && !ent.attrs.iter().any(|a| a.id == *attr_id) {
                    return Err(format!("主键必须指向实体 {} 内的属性", ent.name));
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
                if !is_field_ident(name) {
                    return Err(format!("字段名只能以小写字母开头，且只含小写字母、数字、下划线：{name}"));
                }
                if *length == Some(0) {
                    return Err("length 必须大于 0".to_string());
                }
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
                let xml = attribute_xml(AttributeSpec {
                    class_id: &ent.id,
                    id: &attr_id,
                    name,
                    display_name,
                    type_name,
                    data_type,
                    db_type,
                    style,
                    length: *length,
                    nullable: *nullable,
                    default_value,
                    is_key: *is_key,
                    seq,
                });
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
            EditOp::DeleteNode { id } => {
                let node = doc.find_node(id).ok_or_else(|| format!("找不到节点 {id}"))?;
                check_deletable(doc, node)?;
                edits.push(removal_edit(doc, node));
            }
            EditOp::AddEntity {
                name,
                display_name,
                table,
                full_class,
                accessor,
                is_primary,
                id,
                attrs,
            } => {
                let name = name.trim();
                let table = table.trim();
                let full_class = full_class.trim();
                if !is_entity_name(name) {
                    return Err(format!("实体名只能包含字母、数字、下划线，且以字母开头：{name}"));
                }
                if !is_table_name(table) {
                    return Err(format!("表名只能包含字母、数字、下划线、$、#，且以字母开头：{table}"));
                }
                if !is_qualified_class(full_class) {
                    return Err(format!("fullClassName 必须是 nc.vo. 开头的完整类名：{full_class}"));
                }
                let accessor = if accessor.trim().is_empty() {
                    full_class.to_string()
                } else {
                    accessor.trim().to_string()
                };
                if !is_accessor(&accessor) {
                    return Err(format!("访问器必须是合法的类名：{accessor}"));
                }
                if doc.entities.iter().any(|e| e.name == name) || new_entities.contains_key(name) {
                    return Err(format!("组件里已有实体 {name}"));
                }
                if doc.entities.iter().any(|e| e.table == table) || !new_tables.insert(table.to_string()) {
                    return Err(format!("组件里已有实体使用表 {table}"));
                }
                if doc.entities.iter().any(|e| e.full_class == full_class) {
                    return Err(format!("组件里已有实体使用类 {full_class}"));
                }
                let new_id = if id.trim().is_empty() { uuid_like() } else { id.trim().to_string() };
                if doc.find_node(&new_id).is_some() || !new_ids.insert(new_id.clone()) {
                    return Err(format!("节点 id 已存在：{new_id}"));
                }
                // 字段随实体一次写入：复制实体时字段必须和实体同批落地，
                // 否则第二次保存前拿不到新实体的节点。
                let mut seen = std::collections::HashSet::new();
                let mut attr_xmls = Vec::new();
                let mut key_id = String::new();
                for (i, a) in attrs.iter().enumerate() {
                    let an = a.name.trim();
                    if !is_field_ident(an) {
                        return Err(format!("字段名只能以小写字母开头，且只含小写字母、数字、下划线：{an}"));
                    }
                    if !seen.insert(an.to_string()) {
                        return Err(format!("实体 {name} 里字段重复：{an}"));
                    }
                    if a.length == Some(0) {
                        return Err("length 必须大于 0".to_string());
                    }
                    if a.type_name.trim().is_empty() {
                        return Err(format!("字段 {an} 的 typeName 不能为空"));
                    }
                    let aid = if a.id.trim().is_empty() { uuid_like() } else { a.id.trim().to_string() };
                    if doc.find_node(&aid).is_some() || !new_ids.insert(aid.clone()) {
                        return Err(format!("节点 id 已存在：{aid}"));
                    }
                    if a.is_key && key_id.is_empty() {
                        key_id = aid.clone();
                    }
                    attr_xmls.push(attribute_xml(AttributeSpec {
                        class_id: &new_id,
                        id: &aid,
                        name: an,
                        display_name: &a.display_name,
                        type_name: a.type_name.trim(),
                        data_type: &a.data_type,
                        db_type: &a.db_type,
                        style: &a.style,
                        length: a.length,
                        nullable: a.nullable,
                        default_value: &a.default_value,
                        is_key: a.is_key,
                        seq: i as i32,
                    }));
                }
                new_entities.insert(name.to_string(), new_id.clone());
                new_entities.insert(new_id.clone(), new_id.clone());
                let cell = doc.root.child("celllist").ok_or("组件没有 celllist")?;
                let indent = child_indent(doc, cell);
                let eol = eol_str(doc);
                let list_xml = if attr_xmls.is_empty() {
                    "<attributelist/>".to_string()
                } else {
                    format!(
                        "<attributelist>{eol}{indent}    {}{eol}{indent}  </attributelist>",
                        attr_xmls.join(&format!("{eol}{indent}    "))
                    )
                };
                let xml = format!(
                    "<entity accessor=\"{}\" displayName=\"{}\" fullClassName=\"{}\" id=\"{}\" isPrimary=\"{}\" keyAttributeId=\"{}\" name=\"{}\" tableName=\"{}\">{eol}{indent}  {list_xml}{eol}{indent}</entity>",
                    xml_attr(&accessor),
                    xml_attr(display_name),
                    xml_attr(full_class),
                    new_id,
                    is_primary,
                    key_id,
                    xml_attr(name),
                    xml_attr(table)
                );
                edits.push(container_edit(doc, cell, "celllist", &xml));
            }
            EditOp::AddEnum {
                name,
                display_name,
                type_name,
                data_type,
                id,
            } => {
                let name = name.trim();
                if !is_entity_name(name) {
                    return Err(format!("枚举名只能包含字母、数字、下划线，且以字母开头：{name}"));
                }
                if type_name.trim().is_empty() {
                    return Err("枚举 typeName 不能为空".to_string());
                }
                if doc.enums.iter().any(|e| e.name == name) || !new_enum_names.insert(name.to_string()) {
                    return Err(format!("组件里已有枚举 {name}"));
                }
                let new_id = if id.trim().is_empty() { uuid_like() } else { id.trim().to_string() };
                if doc.find_node(&new_id).is_some() || !new_ids.insert(new_id.clone()) {
                    return Err(format!("节点 id 已存在：{new_id}"));
                }
                let cell = doc.root.child("celllist").ok_or("组件没有 celllist")?;
                let indent = child_indent(doc, cell);
                let eol = eol_str(doc);
                let xml = format!(
                    "<Enumerate dataType=\"{}\" displayName=\"{}\" id=\"{}\" name=\"{}\" typeName=\"{}\">{eol}{indent}  <enumitemlist/>{eol}{indent}</Enumerate>",
                    xml_attr(data_type.trim()),
                    xml_attr(display_name),
                    new_id,
                    xml_attr(name),
                    xml_attr(type_name.trim())
                );
                edits.push(container_edit(doc, cell, "celllist", &xml));
            }
            EditOp::AddRelation {
                kind,
                name,
                source,
                target,
                src_attr_id,
                target_attr_id,
                id,
            } => {
                if !matches!(kind.as_str(), "AggregationRelation" | "Reference" | "busiitfconnection") {
                    return Err(format!("不支持的关系类型 {kind}（只支持聚合/参照/业务接口）"));
                }
                let src_id = doc
                    .entities
                    .iter()
                    .find(|e| e.id == *source || e.name == *source)
                    .map(|e| e.id.clone())
                    .or_else(|| new_entities.get(source.trim()).cloned())
                    .ok_or_else(|| format!("关系源端不是本组件内的实体：{source}"))?;
                let tgt_id = doc
                    .entities
                    .iter()
                    .find(|e| e.id == *target || e.name == *target)
                    .map(|e| e.id.clone())
                    .or_else(|| new_entities.get(target.trim()).cloned())
                    .ok_or_else(|| format!("关系目标端不是本组件内的实体：{target}"))?;
                if src_id == tgt_id {
                    return Err("关系两端不能是同一个实体".to_string());
                }
                let attr_ok = |entity_id: &str, attr_id: &str| {
                    doc.entities
                        .iter()
                        .find(|e| e.id == entity_id)
                        .map(|e| e.attrs.iter().any(|a| a.id == attr_id))
                        .unwrap_or(false)
                };
                if !src_attr_id.trim().is_empty() && !attr_ok(&src_id, src_attr_id) {
                    return Err(format!("源属性必须属于实体 {source}"));
                }
                if !target_attr_id.trim().is_empty() && !attr_ok(&tgt_id, target_attr_id) {
                    return Err(format!("目标属性必须属于实体 {target}"));
                }
                if doc
                    .relations
                    .iter()
                    .any(|r| r.kind == *kind && r.source == src_id && r.target == tgt_id)
                    || !new_relations.insert((kind.clone(), src_id.clone(), tgt_id.clone()))
                {
                    return Err("同类型关系已存在".to_string());
                }
                let new_id = if id.trim().is_empty() { uuid_like() } else { id.trim().to_string() };
                if doc.find_node(&new_id).is_some() || !new_ids.insert(new_id.clone()) {
                    return Err(format!("节点 id 已存在：{new_id}"));
                }
                let xml = format!(
                    "<{kind} id=\"{}\" name=\"{}\" source=\"{}\" srcAttributeid=\"{}\" target=\"{}\" targetAttributeid=\"{}\"/>",
                    new_id,
                    xml_attr(name),
                    src_id,
                    xml_attr(src_attr_id.trim()),
                    tgt_id,
                    xml_attr(target_attr_id.trim())
                );
                match doc.root.child("connectlist") {
                    Some(list) => edits.push(container_edit(doc, list, "connectlist", &xml)),
                    None => {
                        // connectlist 是 celllist 的兄弟节点，不能塞进 celllist。
                        let cell = doc.root.child("celllist").ok_or("组件没有 celllist，无法新增关系")?;
                        let indent = indent_before(doc, cell.start);
                        let eol = eol_str(doc);
                        let block = format!(
                            "{eol}{indent}<connectlist>{eol}{indent}  {xml}{eol}{indent}</connectlist>"
                        );
                        edits.push((cell.end, cell.end, block.into_bytes()));
                    }
                }
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

struct AttributeSpec<'a> {
    class_id: &'a str,
    id: &'a str,
    name: &'a str,
    display_name: &'a str,
    type_name: &'a str,
    data_type: &'a str,
    db_type: &'a str,
    style: &'a str,
    length: Option<u32>,
    nullable: bool,
    default_value: &'a str,
    is_key: bool,
    seq: i32,
}

/// 一行 `<attribute/>`。加字段与「新增实体带字段」共用，避免两处属性顺序/默认值漂移。
fn attribute_xml(s: AttributeSpec) -> String {
    format!(
        "<attribute accessStrategy=\"\" classID=\"{}\" dataType=\"{}\" dataTypeStyle=\"{}\" dbtype=\"{}\" defaultValue=\"{}\" displayName=\"{}\" fieldName=\"{}\" fieldType=\"{}\" id=\"{}\" isKey=\"{}\" isNullable=\"{}\" length=\"{}\" name=\"{}\" precise=\"\" sequence=\"{}\" typeDisplayName=\"{}\" typeName=\"{}\"/>",
        xml_attr(s.class_id),
        xml_attr(s.data_type),
        xml_attr(s.style),
        xml_attr(s.db_type),
        xml_attr(s.default_value),
        xml_attr(s.display_name),
        xml_attr(s.name),
        xml_attr(s.db_type),
        s.id,
        s.is_key,
        s.nullable,
        s.length.map(|l| l.to_string()).unwrap_or_default(),
        xml_attr(s.name),
        s.seq,
        xml_attr(s.type_name),
        xml_attr(s.type_name)
    )
}

/// 可删除的节点类型与引用检查。只放行叶子/带自身容器的已知类型：
/// 容器、组件根、未知标签一律不删（删了解析器可能直接失败）。
fn check_deletable(doc: &BmfDoc, node: &crate::bmf_model::XmlNode) -> Result<(), String> {
    let id = node.attr_or("id", "");
    if id.is_empty() {
        return Err(format!("<{}> 没有 id，无法安全删除", node.name));
    }
    match node.name.as_str() {
        "entity" => {
            if doc.component.main_entity == id {
                return Err("该实体是组件主实体（mainEntity），先改主实体再删".to_string());
            }
            if doc.relations.iter().any(|r| r.source == id || r.target == id) {
                return Err("实体仍被连接关系引用，先删关系".to_string());
            }
            let entity = doc.entities.iter().find(|e| e.id == id);
            if let Some(e) = entity {
                let referenced = doc.entities.iter().flat_map(|x| x.attrs.iter()).any(|a| {
                    a.data_type == e.name || a.ref_target == e.name || a.data_type == id
                });
                if referenced {
                    return Err(format!("实体 {} 仍被字段 dataType 引用，先改字段", e.name));
                }
            }
            Ok(())
        }
        "attribute" => {
            let owner = doc.entities.iter().find(|e| e.attrs.iter().any(|a| a.id == id));
            if let Some(e) = owner {
                if e.key_attr_id == id {
                    return Err(format!("字段 {} 是实体主键，先改主键再删", e.name));
                }
                if e.attrs.iter().any(|a| a.id == id && a.is_key) {
                    return Err("字段标了 isKey，先取消主键标记再删".to_string());
                }
            }
            if doc
                .relations
                .iter()
                .any(|r| r.src_attr_id == id || r.target_attr_id == id)
            {
                return Err("字段仍被连接关系引用，先删关系".to_string());
            }
            Ok(())
        }
        "Enumerate" => {
            let en = doc.enums.iter().find(|e| e.id == id);
            if let Some(e) = en {
                let referenced = doc
                    .entities
                    .iter()
                    .flat_map(|x| x.attrs.iter())
                    .any(|a| a.type_name == e.name || a.data_type == e.name || a.ref_target == e.name);
                if referenced {
                    return Err(format!("枚举 {} 仍被字段引用，先改字段类型", e.name));
                }
            }
            Ok(())
        }
        "enumitem" | "AggregationRelation" | "Reference" | "busiitfconnection" => Ok(()),
        other => Err(format!(
            "<{other}> 不是可删除的节点类型（只支持实体/属性/枚举/枚举项/关系）"
        )),
    }
}

/// 删除节点。节点独占一行时连缩进与行尾一起删（不留空行）；同行还有别的内容时
/// 只删节点本身的字节。
fn removal_edit(doc: &BmfDoc, node: &crate::bmf_model::XmlNode) -> (usize, usize, Vec<u8>) {
    let b = &doc.bytes;
    let line_start = b[..node.start]
        .iter()
        .rposition(|x| *x == b'\n')
        .map(|i| i + 1)
        .unwrap_or(0);
    let prefix_is_ws = b[line_start..node.start]
        .iter()
        .all(|x| matches!(x, b' ' | b'\t' | b'\r'));
    let mut after = node.end;
    while after < b.len() && matches!(b[after], b' ' | b'\t' | b'\r') {
        after += 1;
    }
    let alone = prefix_is_ws && (after == b.len() || b[after] == b'\n');
    if alone {
        let end = if after < b.len() { after + 1 } else { after };
        (line_start, end, Vec::new())
    } else {
        (node.start, node.end, Vec::new())
    }
}

fn eol_str(doc: &BmfDoc) -> &'static str {
    match doc.eol {
        crate::workspace::Eol::Lf => "\n",
        _ => "\r\n",
    }
}

/// 容器追加子节点时该用的缩进：优先跟随第一个子节点，空容器则比容器多两级。
fn child_indent(doc: &BmfDoc, node: &crate::bmf_model::XmlNode) -> String {
    node.children
        .first()
        .map(|c| indent_before(doc, c.start))
        .unwrap_or_else(|| format!("{}  ", indent_before(doc, node.start)))
}

/// 往容器里追加一个子节点。空容器 `<x/>` 要先展开成 `<x>…</x>`。
fn container_edit(
    doc: &BmfDoc,
    node: &crate::bmf_model::XmlNode,
    tag: &str,
    xml: &str,
) -> (usize, usize, Vec<u8>) {
    let eol = eol_str(doc);
    if node.self_closing {
        let outer = indent_before(doc, node.start);
        let inner = child_indent(doc, node);
        return (
            node.end.saturating_sub(2),
            node.end,
            format!(">{eol}{inner}{xml}{eol}{outer}</{tag}>").into_bytes(),
        );
    }
    let indent = child_indent(doc, node);
    let close = format!("</{tag}>");
    let at = node
        .end
        .checked_sub(close.len())
        .filter(|i| doc.bytes[*i..node.end] == *close.as_bytes())
        .unwrap_or(node.end);
    (at, at, format!("{indent}{xml}{eol}").into_bytes())
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
    fn set_attr_rejects_invalid_length_and_booleans() {
        let d = doc();
        for bad in ["NaN", "-1", "0", "12.5"] {
            let err = apply(
                &d,
                &[EditOp::SetAttr {
                    id: "a1".into(),
                    name: "length".into(),
                    value: bad.into(),
                }],
            )
            .unwrap_err();
            assert!(err.contains("length"), "{bad} → {err}");
        }
        let err = apply(
            &d,
            &[EditOp::SetAttr {
                id: "a1".into(),
                name: "isNullable".into(),
                value: "yes".into(),
            }],
        )
        .unwrap_err();
        assert!(err.contains("true"));
        // 空长度 = 移除该属性，是合法编辑
        apply(
            &d,
            &[EditOp::SetAttr {
                id: "a1".into(),
                name: "length".into(),
                value: String::new(),
            }],
        )
        .unwrap();
    }

    #[test]
    fn add_attribute_rejects_bad_identifier_and_zero_length() {
        let d = doc();
        for (name, len, want) in [
            ("BadName", Some(20), "字段名"),
            ("1abc", Some(20), "字段名"),
            ("ok_name", Some(0), "length"),
        ] {
            let err = apply(
                &d,
                &[EditOp::AddAttribute {
                    entity: "e".into(),
                    name: name.into(),
                    display_name: String::new(),
                    style: "SINGLE".into(),
                    type_name: "String".into(),
                    data_type: String::new(),
                    db_type: String::new(),
                    length: len,
                    nullable: true,
                    default_value: String::new(),
                    is_key: false,
                    id: String::new(),
                }],
            )
            .unwrap_err();
            assert!(err.contains(want), "{name}/{len:?} → {err}");
        }
    }

    #[test]
    fn set_attr_rejects_identity_and_conflicting_names() {
        let d = doc();
        let err = apply(
            &d,
            &[EditOp::SetAttr {
                id: "a1".into(),
                name: "id".into(),
                value: "a9".into(),
            }],
        )
        .unwrap_err();
        assert!(err.contains("引用锚点"), "{err}");

        // 先加一个字段，再把主键改成同名字段 → 拒绝
        let with_extra = apply(
            &d,
            &[EditOp::AddAttribute {
                entity: "e".into(),
                name: "vbillcode".into(),
                display_name: String::new(),
                style: "SINGLE".into(),
                type_name: "String".into(),
                data_type: String::new(),
                db_type: String::new(),
                length: Some(20),
                nullable: true,
                default_value: String::new(),
                is_key: false,
                id: "a2".into(),
            }],
        )
        .unwrap();
        let d2 = BmfDoc::from_bytes(PathBuf::new(), with_extra).unwrap();
        let err = apply(
            &d2,
            &[EditOp::SetAttr {
                id: "a1".into(),
                name: "name".into(),
                value: "vbillcode".into(),
            }],
        )
        .unwrap_err();
        assert!(err.contains("已存在"), "{err}");
    }

    #[test]
    fn set_entity_key_must_belong_to_the_entity() {
        let d = doc();
        let err = apply(
            &d,
            &[EditOp::SetEntityKey {
                entity: "e".into(),
                attr_id: "i1".into(),
            }],
        )
        .unwrap_err();
        assert!(err.contains("主键"), "{err}");
        apply(
            &d,
            &[EditOp::SetEntityKey {
                entity: "e".into(),
                attr_id: "a1".into(),
            }],
        )
        .unwrap();
    }

    #[test]
    fn delete_node_removes_the_whole_line() {
        let d = doc();
        let with_extra = apply(
            &d,
            &[EditOp::AddAttribute {
                entity: "e".into(),
                name: "memo".into(),
                display_name: "备注".into(),
                style: "SINGLE".into(),
                type_name: "String".into(),
                data_type: String::new(),
                db_type: "varchar".into(),
                length: Some(101),
                nullable: true,
                default_value: String::new(),
                is_key: false,
                id: "a2".into(),
            }],
        )
        .unwrap();
        let d2 = BmfDoc::from_bytes(PathBuf::new(), with_extra).unwrap();
        let new = apply(&d2, &[EditOp::DeleteNode { id: "a2".into() }]).unwrap();
        let s = String::from_utf8(new.clone()).unwrap();
        assert!(!s.contains("memo"));
        assert!(!s.contains("\n\n"), "删除后不应留下空行");
        let d3 = BmfDoc::from_bytes(PathBuf::new(), new).unwrap();
        assert_eq!(d3.entities[0].attrs.len(), 1);
        assert_eq!(d3.entities[0].attrs[0].id, "a1");
    }

    #[test]
    fn delete_is_refused_while_still_referenced() {
        let d = doc();
        let err = apply(&d, &[EditOp::DeleteNode { id: "a1".into() }]).unwrap_err();
        assert!(err.contains("主键"), "{err}");
        let err = apply(&d, &[EditOp::DeleteNode { id: "e".into() }]).unwrap_err();
        assert!(err.contains("mainEntity"), "{err}");
        // 组件根不是可删除节点类型
        let err = apply(&d, &[EditOp::DeleteNode { id: "c".into() }]).unwrap_err();
        assert!(err.contains("可删除"), "{err}");
    }

    #[test]
    fn add_entity_enum_and_relation_round_trip() {
        let d = doc();
        let new = apply(
            &d,
            &[
                EditOp::AddEntity {
                    name: "H2".into(),
                    display_name: "子表".into(),
                    table: "t2".into(),
                    full_class: "nc.vo.m.c.H2".into(),
                    accessor: "nc.vo.m.c.H2".into(),
                    is_primary: false,
                    id: "e2".into(),
                    attrs: vec![],
                },
                EditOp::AddEnum {
                    name: "billstatus".into(),
                    display_name: "单据状态".into(),
                    type_name: "String".into(),
                    data_type: "BS2".into(),
                    id: "n2".into(),
                },
                EditOp::AddRelation {
                    kind: "AggregationRelation".into(),
                    name: "H-H2".into(),
                    source: "e".into(),
                    target: "e2".into(),
                    src_attr_id: String::new(),
                    target_attr_id: String::new(),
                    id: "r1".into(),
                },
            ],
        )
        .unwrap();
        let s = String::from_utf8(new.clone()).unwrap();
        assert!(s.contains("\n  <entity "), "新增实体应与已有实体同缩进：\n{s}");
        let d2 = BmfDoc::from_bytes(PathBuf::from("t3.bmf"), new).unwrap();
        assert_eq!(d2.entities.len(), 2);
        assert!(d2.entities.iter().any(|e| e.id == "e2" && e.attrs.is_empty()));
        assert_eq!(d2.enums.len(), 2);
        assert!(d2.enums.iter().any(|e| e.id == "n2" && e.name == "billstatus"));
        assert_eq!(d2.relations.len(), 1);
        assert_eq!(d2.relations[0].source, "e");
        assert_eq!(d2.relations[0].target, "e2");
        assert!(d2.root.child("connectlist").is_some());
    }

    #[test]
    fn add_entity_validates_shape_and_uniqueness() {
        let d = doc();
        let mk = |name: &str, table: &str, class: &str| EditOp::AddEntity {
            name: name.into(),
            display_name: String::new(),
            table: table.into(),
            full_class: class.into(),
            accessor: String::new(),
            is_primary: false,
            id: String::new(),
            attrs: vec![],
        };
        for (op, want) in [
            (mk("1bad", "tx", "nc.vo.m.c.X"), "实体名"),
            (mk("H3", "1bad", "nc.vo.m.c.X"), "表名"),
            (mk("H3", "tx", "com.other.X"), "fullClassName"),
            (mk("H", "tx", "nc.vo.m.c.X"), "已有实体"),
            (mk("H3", "t", "nc.vo.m.c.X"), "已有实体使用表"),
        ] {
            let err = apply(&d, &[op]).unwrap_err();
            assert!(err.contains(want), "{want} → {err}");
        }
    }

    #[test]
    fn add_entity_with_attrs_lands_fields_and_key() {
        let d = doc();
        let new = apply(
            &d,
            &[EditOp::AddEntity {
                name: "H2".into(),
                display_name: "复制来的表头".into(),
                table: "t2".into(),
                full_class: "nc.vo.m.c.H2".into(),
                accessor: "nc.vo.m.c.H2".into(),
                is_primary: false,
                id: "e2".into(),
                attrs: vec![
                    NewAttr {
                        name: "pk_head".into(),
                        display_name: "主键".into(),
                        style: "SINGLE".into(),
                        type_name: "UFID".into(),
                        data_type: String::new(),
                        db_type: "char".into(),
                        length: Some(20),
                        nullable: false,
                        default_value: String::new(),
                        is_key: true,
                        id: "b1".into(),
                    },
                    NewAttr {
                        name: "vbillcode".into(),
                        display_name: "单据号".into(),
                        style: "SINGLE".into(),
                        type_name: "String".into(),
                        data_type: String::new(),
                        db_type: "varchar".into(),
                        length: Some(40),
                        nullable: true,
                        default_value: "''".into(),
                        is_key: false,
                        id: "b2".into(),
                    },
                ],
            }],
        )
        .unwrap();
        let d2 = BmfDoc::from_bytes(PathBuf::from("t4.bmf"), new).unwrap();
        let e = d2.entities.iter().find(|x| x.id == "e2").unwrap();
        assert_eq!(e.name, "H2");
        assert_eq!(e.attrs.len(), 2);
        assert_eq!(e.key_attr_id, "b1");
        let code = e.attrs.iter().find(|a| a.name == "vbillcode").unwrap();
        assert_eq!(code.length, Some(40));
        assert!(code.nullable);
        assert_eq!(code.default_value, "''");
        assert_eq!(e.attrs[1].sequence, 1);
    }

    #[test]
    fn add_entity_with_attrs_rejects_duplicate_fields() {
        let d = doc();
        let attr = |id: &str| NewAttr {
            name: "same".into(),
            display_name: String::new(),
            style: "SINGLE".into(),
            type_name: "String".into(),
            data_type: String::new(),
            db_type: String::new(),
            length: Some(20),
            nullable: true,
            default_value: String::new(),
            is_key: false,
            id: id.into(),
        };
        let err = apply(
            &d,
            &[EditOp::AddEntity {
                name: "H2".into(),
                display_name: String::new(),
                table: "t2".into(),
                full_class: "nc.vo.m.c.H2".into(),
                accessor: String::new(),
                is_primary: false,
                id: "e2".into(),
                attrs: vec![attr("b1"), attr("b2")],
            }],
        )
        .unwrap_err();
        assert!(err.contains("字段重复"), "{err}");
    }

    #[test]
    fn add_relation_rejects_unknown_endpoints_and_duplicates() {
        let d = doc();
        let mk = |source: &str, target: &str| EditOp::AddRelation {
            kind: "Reference".into(),
            name: String::new(),
            source: source.into(),
            target: target.into(),
            src_attr_id: String::new(),
            target_attr_id: String::new(),
            id: String::new(),
        };
        let err = apply(&d, &[mk("e", "nope")]).unwrap_err();
        assert!(err.contains("目标端"), "{err}");
        let err = apply(&d, &[mk("e", "e")]).unwrap_err();
        assert!(err.contains("同一个实体"), "{err}");

        let two = apply(
            &d,
            &[EditOp::AddEntity {
                name: "H2".into(),
                display_name: String::new(),
                table: "t2".into(),
                full_class: "nc.vo.m.c.H2".into(),
                accessor: String::new(),
                is_primary: false,
                id: "e2".into(),
                attrs: vec![],
            }],
        )
        .unwrap();
        let d2 = BmfDoc::from_bytes(PathBuf::new(), two).unwrap();
        apply(&d2, &[mk("e", "e2")]).unwrap();
        let err = apply(&d2, &[mk("e", "e2"), mk("e", "e2")]).unwrap_err();
        assert!(err.contains("已存在"), "{err}");
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
