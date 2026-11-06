//! 批量事务只在内存工作副本上推进；结构变化后重新扫描 span，保存最后只写一次。
use crate::bmf_model::BmfDoc;
use crate::bmf_write::{self, EditOp};
use std::collections::HashMap;

pub const MAX_EDIT_OPS: usize = 10_000;

fn group(op: &EditOp) -> u8 {
    match op {
        EditOp::SetAttr { .. } | EditOp::SetEntityKey { .. } => 0,
        EditOp::AddAttribute { .. } => 1,
        EditOp::AddEnumItem { .. } => 2,
        EditOp::AddEntity { .. } => 3,
        EditOp::AddEnum { .. } => 4,
        EditOp::AddRelation { .. } => 5,
        EditOp::DeleteNode { .. } => 6,
        EditOp::SetMapping { .. } => 7,
        EditOp::SetAccessorProperty { .. } => 8,
    }
}

/// 空 ID 在预览前只生成一次，前端拿回相同 ops 再保存，预览与落盘不会换 GUID。
pub fn stable_ops(ops: &[EditOp]) -> Vec<EditOp> {
    let mut out = ops.to_vec();
    for op in &mut out {
        let id = match op {
            EditOp::AddAttribute { id, .. }
            | EditOp::AddEnumItem { id, .. }
            | EditOp::AddEnum { id, .. }
            | EditOp::AddRelation { id, .. } => Some(id),
            EditOp::AddEntity { id, attrs, .. } => {
                for a in attrs {
                    if a.id.trim().is_empty() {
                        a.id = bmf_write::uuid_like();
                    }
                }
                Some(id)
            }
            _ => None,
        };
        if let Some(id) = id {
            if id.trim().is_empty() {
                *id = bmf_write::uuid_like();
            }
        }
    }
    out
}

fn coalesce(ops: &[EditOp]) -> Vec<EditOp> {
    let mut last = HashMap::new();
    let key = |op: &EditOp| match op {
        EditOp::SetAttr { id, name, .. } => Some((id.clone(), name.to_ascii_lowercase())),
        EditOp::SetEntityKey { entity, .. } => Some((entity.clone(), "keyattributeid".into())),
        EditOp::SetMapping {
            entity,
            interface_id,
            interface_attr_id,
            ..
        } => Some((
            entity.clone(),
            format!("mapping:{interface_id}:{interface_attr_id}"),
        )),
        EditOp::SetAccessorProperty { entity, name, .. } => {
            Some((entity.clone(), format!("accessor:{name}")))
        }
        _ => None,
    };
    for (i, op) in ops.iter().enumerate() {
        if let Some(key) = key(op) {
            last.insert(key, i);
        }
    }
    ops.iter()
        .enumerate()
        .filter(|(i, op)| key(op).is_none_or(|key| last[&key] == *i))
        .map(|(_, op)| op.clone())
        .collect()
}

pub fn apply(doc: &BmfDoc, ops: &[EditOp]) -> Result<Vec<u8>, String> {
    if ops.len() > MAX_EDIT_OPS {
        return Err(format!("一次草稿最多 {MAX_EDIT_OPS} 个操作，请分批保存"));
    }
    if ops.is_empty() {
        return Ok(doc.bytes.clone());
    }
    let ops = stable_ops(ops);
    let mut current = BmfDoc::from_bytes(doc.path.clone(), doc.bytes.clone())?;
    crate::bmf_resolve::carry_definitions(doc, &mut current);
    let mut start = 0;
    while start < ops.len() {
        let kind = group(&ops[start]);
        let mut end = start + 1;
        // 删除按顺序检查依赖；字段与属性修改合并为一批，千行粘贴只扫描一次。
        if kind != 6 {
            while end < ops.len() && group(&ops[end]) == kind {
                end += 1;
            }
        }
        let batch = coalesce(&ops[start..end]);
        let bytes = bmf_write::apply_snapshot(&current, &batch)?;
        let mut next = BmfDoc::from_bytes(doc.path.clone(), bytes)?;
        crate::bmf_resolve::carry_definitions(doc, &mut next);
        for entity in &next.entities {
            for attr in &entity.attrs {
                let old = current
                    .entities
                    .iter()
                    .find(|e| e.id == entity.id)
                    .and_then(|e| e.attrs.iter().find(|a| a.id == attr.id));
                if old.is_none_or(|a| {
                    a.type_name != attr.type_name
                        || a.data_type != attr.data_type
                        || a.style != attr.style
                }) {
                    crate::bmf_types::validate_type(&attr.type_name, &attr.data_type)?;
                    for mapping in entity.mappings.iter().filter(|m| m.attr_id == attr.id) {
                        let expected = next
                            .interfaces
                            .iter()
                            .find(|i| i.id == mapping.interface_id)
                            .and_then(|i| {
                                i.attrs.iter().find(|a| a.id == mapping.interface_attr_id)
                            })
                            .ok_or("字段被接口映射引用，但接口定义未加载；类型保持只读")?;
                        if !crate::bmf_types::mapping_compatible(&next, attr, expected) {
                            return Err(format!(
                                "字段 {} 修改后与接口属性 {} 类型不兼容",
                                attr.name, expected.name
                            ));
                        }
                    }
                }
            }
        }
        for interface in next.interfaces.iter().filter(|i| !i.external) {
            for attr in &interface.attrs {
                let old = current
                    .interfaces
                    .iter()
                    .find(|i| i.id == interface.id)
                    .and_then(|i| i.attrs.iter().find(|a| a.id == attr.id));
                if old.is_none_or(|a| {
                    a.type_name != attr.type_name
                        || a.data_type != attr.data_type
                        || a.style != attr.style
                }) {
                    crate::bmf_types::validate_type(&attr.type_name, &attr.data_type)?;
                    for entity in &next.entities {
                        for mapping in entity.mappings.iter().filter(|m| {
                            m.interface_id == interface.id
                                && m.interface_attr_id == attr.id
                                && !m.attr_id.is_empty()
                        }) {
                            if let Some(field) =
                                entity.attrs.iter().find(|a| a.id == mapping.attr_id)
                            {
                                if !crate::bmf_types::mapping_compatible(&next, field, attr) {
                                    return Err("接口属性修改后与已绑定字段不兼容".into());
                                }
                            }
                        }
                    }
                }
            }
        }
        current = next;
        start = end;
    }
    Ok(current.bytes)
}
