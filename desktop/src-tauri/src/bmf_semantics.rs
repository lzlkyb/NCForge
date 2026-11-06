//! UAP 设计态语义。标签与属性名来自本机原始 BMF 和 NCMDP 6.5 的序列化契约。
//! Reference 是 celllist 中的外部引用；接口实现与普通关联分别位于 connectlist。
use serde::Serialize;

use crate::bmf_model::{decode_entities, XmlNode};
use crate::workspace::decode_lossy;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterfaceAttr {
    pub id: String,
    pub name: String,
    pub display_name: String,
    pub data_type: String,
    pub type_name: String,
    pub style: String,
    pub db_type: String,
    pub sequence: i32,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BusinessInterface {
    pub id: String,
    pub name: String,
    pub display_name: String,
    pub full_class: String,
    pub attrs: Vec<InterfaceAttr>,
    /// 外部定义仅用于类型检查和定位，永远不参与当前文件的字节写回。
    pub external: bool,
    pub source_path: String,
    pub definition_sha: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterfaceMapping {
    pub interface_id: String,
    pub interface_attr_id: String,
    pub entity_id: String,
    pub attr_id: String,
    pub attr_path: String,
    pub attr_path_id: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessorProperty {
    pub name: String,
    pub display_name: String,
    pub value: String,
    pub sequence: i32,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessorConfig {
    pub name: String,
    pub display_name: String,
    pub full_class: String,
    pub properties: Vec<AccessorProperty>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reference {
    pub id: String,
    pub ref_id: String,
    pub name: String,
    pub display_name: String,
    pub full_class: String,
    pub module: String,
    pub metadata_path: String,
    pub resolution: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dependency {
    pub entity_id: String,
    pub metadata_path: String,
}

pub fn text(node: &XmlNode, bytes: &[u8]) -> String {
    if !node.children.is_empty() || node.self_closing {
        return String::new();
    }
    let end = bytes[node.start_tag_end..node.end]
        .iter()
        .position(|b| *b == b'<')
        .map(|n| node.start_tag_end + n)
        .unwrap_or(node.end);
    decode_entities(&decode_lossy(&bytes[node.start_tag_end..end]))
        .trim()
        .to_string()
}

pub fn read_interface(node: &XmlNode) -> BusinessInterface {
    let mut attrs = node
        .child("busiItfAttrs")
        .map(|list| {
            list.children
                .iter()
                .filter(|n| n.name == "busiItAttr")
                .map(|n| InterfaceAttr {
                    id: n.attr_or("id", ""),
                    name: n.attr_or("name", ""),
                    display_name: n.attr_or("displayName", ""),
                    data_type: n.attr_or("dataType", ""),
                    type_name: n.attr_or("typeName", ""),
                    style: n.attr_or("dataTypeStyle", "SINGLE"),
                    db_type: n.attr_or("dbtype", ""),
                    sequence: n.attr("sequence").and_then(|v| v.parse().ok()).unwrap_or(0),
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    attrs.sort_by_key(|a| a.sequence);
    BusinessInterface {
        id: node.attr_or("id", ""),
        name: node.attr_or("name", ""),
        display_name: node.attr_or("displayName", ""),
        full_class: node.attr_or("fullClassName", ""),
        attrs,
        ..Default::default()
    }
}

pub fn read_reference(node: &XmlNode) -> Reference {
    Reference {
        id: node.attr_or("id", ""),
        ref_id: node.attr_or("refId", ""),
        name: node.attr_or("name", ""),
        display_name: node.attr_or("displayName", ""),
        full_class: node.attr_or("fullClassName", ""),
        module: node.attr_or("moduleName", ""),
        metadata_path: node.attr_or("mdFilePath", ""),
        resolution: String::new(),
    }
}

pub fn entity_interfaces(node: &XmlNode, bytes: &[u8]) -> Vec<String> {
    node.child("busiitfs")
        .map(|list| {
            list.children
                .iter()
                .filter(|n| n.name == "itfid")
                .map(|n| text(n, bytes))
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

pub fn entity_mappings(node: &XmlNode) -> Vec<InterfaceMapping> {
    node.child("busimaps")
        .map(|list| {
            list.children
                .iter()
                .filter(|n| n.name == "busimap")
                .map(|n| InterfaceMapping {
                    interface_id: n.attr_or("busiitfid", ""),
                    interface_attr_id: n.attr_or("busiitfattrid", ""),
                    entity_id: n.attr_or("cellid", node.attr("id").unwrap_or("")),
                    attr_id: n.attr_or("attrid", ""),
                    attr_path: n.attr_or("attrpath", ""),
                    attr_path_id: n.attr_or("attrpathid", ""),
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn entity_accessor(node: &XmlNode) -> AccessorConfig {
    let Some(acc) = node.child("accessor") else {
        return AccessorConfig::default();
    };
    let mut properties = acc
        .child("properties")
        .map(|list| {
            list.children
                .iter()
                .filter(|n| n.name == "property")
                .map(|n| AccessorProperty {
                    name: n.attr_or("name", ""),
                    display_name: n.attr_or("displayName", ""),
                    value: n.attr_or("value", ""),
                    sequence: n.attr("sequence").and_then(|s| s.parse().ok()).unwrap_or(0),
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    properties.sort_by_key(|p| p.sequence);
    AccessorConfig {
        name: acc.attr_or("name", ""),
        display_name: acc.attr_or("displayName", ""),
        full_class: acc.attr_or("classFullname", ""),
        properties,
    }
}
