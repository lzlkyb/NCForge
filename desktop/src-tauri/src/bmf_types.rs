//! 与前端共用的 UAP 基础类型目录，来源和 SHA 记录在本次真实样本验收中。
use crate::bmf_model::{Attr, BmfDoc};
use crate::bmf_semantics::InterfaceAttr;
use serde::Deserialize;
use std::sync::OnceLock;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseType {
    pub id: String,
    pub name: String,
    pub db_type: String,
    pub length: Option<u32>,
    pub precision: Option<u32>,
}

pub fn catalog() -> &'static [BaseType] {
    static TYPES: OnceLock<Vec<BaseType>> = OnceLock::new();
    TYPES.get_or_init(|| {
        serde_json::from_str(include_str!("../../src/lib/bmfBaseTypes.json"))
            .expect("内置 UAP 类型目录必须合法")
    })
}

pub fn base_type(name: &str, id: &str) -> Option<&'static BaseType> {
    if !id.is_empty() {
        return catalog().iter().find(|t| t.id == id);
    }
    let mut found = catalog().iter().filter(|t| t.name == name);
    let first = found.next()?;
    found.next().is_none().then_some(first)
}

pub fn validate_type(name: &str, id: &str) -> Result<(), String> {
    if let Some(t) = base_type(name, id) {
        if t.name != name {
            return Err(format!(
                "类型 {name} 与 dataType {} 不匹配（应为 {}）",
                t.id, t.name
            ));
        }
    }
    Ok(())
}

fn value_type<'a>(doc: &BmfDoc, name: &'a str, style: &str, id: &str) -> Option<&'a str> {
    if style == "REF" {
        return Some("String");
    }
    if doc.enums.iter().any(|e| e.id == id) {
        return Some("Integer");
    }
    match name {
        "UFID" | "String" | "CUSTOM" | "Multilangtext" | "MEMO" => Some("String"),
        "UFDouble" | "UFMoney" | "BigDecimal" => Some("UFDouble"),
        "Integer" | "UFBoolean" | "UFDate" | "UFDateTime" | "UFTime" | "UFLiteralDate" => {
            Some(name)
        }
        "IMAGE" | "BLOB" => Some("byte[]"),
        _ => None,
    }
}

/// NC 参照存储键值，UFID/多语文本等可映射到 String；未知类型只接受相同 ID。
/// 不能把生成器的未知类型 String 回退当作接口兼容性，否则错误映射会被误放行。
pub fn mapping_compatible(doc: &BmfDoc, attr: &Attr, interface: &InterfaceAttr) -> bool {
    if attr.style == "ARRAY" || interface.style == "ARRAY" {
        return attr.style == interface.style
            && !attr.data_type.is_empty()
            && attr.data_type == interface.data_type;
    }
    match (
        value_type(doc, &attr.type_name, &attr.style, &attr.data_type),
        value_type(
            doc,
            &interface.type_name,
            &interface.style,
            &interface.data_type,
        ),
    ) {
        (Some(a), Some(b)) => a == b,
        _ => {
            !attr.data_type.is_empty()
                && attr.data_type == interface.data_type
                && attr.style == interface.style
        }
    }
}
