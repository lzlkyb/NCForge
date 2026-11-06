//! 本机原始 NC 1909 BMF 验收；来源和原字节 SHA 见 fixtures/bmf/uap-real/provenance.json。
//! 这验证 XML 语义与无损编辑，不代表已在 UAP Studio 中发布。
use nc_forge::bmf_model::BmfDoc;
use nc_forge::bmf_write::{self, EditOp};
use serde_json::json;
use std::path::PathBuf;

fn real(name: &str) -> BmfDoc {
    BmfDoc::open(
        &PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/bmf/uap-real")
            .join(name),
    )
    .unwrap()
}

#[test]
fn bmf_provenance_sha_and_noop_bytes_match_the_original_files() {
    let provenance: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/bmf/uap-real/provenance.json")).unwrap();
    for entry in provenance.as_array().unwrap() {
        let doc = real(entry["file"].as_str().unwrap());
        assert_eq!(
            bmf_write::sha256(&doc.bytes),
            entry["sha256"].as_str().unwrap()
        );
        assert_eq!(bmf_write::apply(&doc, &[]).unwrap(), doc.bytes);
        assert!(bmf_write::preview(&doc, &[]).unwrap().1.is_empty());
    }
}

#[test]
fn bmf_interface_only_component_is_a_real_model_with_six_attributes() {
    let doc = real("general_interface.bmf");
    assert!(doc.entities.is_empty());
    assert_eq!(doc.interfaces.len(), 2);
    assert_eq!(doc.interfaces[0].attrs.len(), 6);
    assert!(doc.unknown_tags.is_empty());
}

#[test]
fn bmf_reference_cells_mappings_accessor_parameters_and_multiplicity_are_distinct() {
    let doc = real("exsystem.bmf");
    assert_eq!(doc.entities.len(), 2);
    assert_eq!(doc.enums.len(), 1);
    assert_eq!(doc.references.len(), 2);
    assert_eq!(doc.relations.len(), 3);
    assert!(doc.relations.iter().any(|r| r.kind == "relation"));
    let aggregation = doc
        .relations
        .iter()
        .find(|r| r.kind == "AggregationRelation")
        .unwrap();
    assert_eq!(aggregation.source_constraint, "1");
    assert_eq!(aggregation.target_constraint, "1..n");
    let entity = doc
        .entities
        .iter()
        .find(|e| !e.mappings.is_empty())
        .unwrap();
    assert_eq!(entity.mappings.len(), 6);
    assert_eq!(entity.interface_ids.len(), 1);
    assert!(!entity.accessor_config.properties.is_empty());
    assert!(!doc.dependencies.is_empty());
    assert!(doc
        .relations
        .iter()
        .filter(|r| r.kind == "busiitfconnection")
        .all(|r| r.real_target != r.target));
}

#[test]
fn bmf_existing_relation_endpoints_are_read_only_but_multiplicity_remains_editable() {
    for file in ["exsystem.bmf", "structureorg.bmf"] {
        let doc = real(file);
        for relation in &doc.relations {
            for name in ["source", "target", "realsource", "realtarget"] {
                let error = bmf_write::apply(
                    &doc,
                    &[EditOp::SetAttr {
                        id: relation.id.clone(),
                        name: name.into(),
                        value: "new-endpoint".into(),
                    }],
                )
                .unwrap_err();
                assert!(error.contains("只读"), "{file} / {name}: {error}");
            }
        }
    }
    let doc = real("exsystem.bmf");
    let relation = doc
        .relations
        .iter()
        .find(|r| r.kind == "AggregationRelation")
        .unwrap();
    let out = bmf_write::apply(
        &doc,
        &[EditOp::SetAttr {
            id: relation.id.clone(),
            name: "targetConstraint".into(),
            value: "0..n".into(),
        }],
    )
    .unwrap();
    let after = BmfDoc::from_bytes(PathBuf::new(), out).unwrap();
    assert_eq!(
        after
            .relations
            .iter()
            .find(|r| r.id == relation.id)
            .unwrap()
            .target_constraint,
        "0..n"
    );
}

#[test]
fn bmf_inheritance_is_read_from_real_connection_with_an_external_reference_target() {
    let doc = real("structureorg.bmf");
    let relation = doc
        .relations
        .iter()
        .find(|r| r.kind == "ExtendConnection")
        .unwrap();
    assert!(doc
        .references
        .iter()
        .any(|r| r.id == relation.target && r.ref_id == relation.real_target));
}

#[test]
fn bmf_mapping_and_accessor_edit_only_touch_the_verified_values() {
    let mut doc = real("matters.bmf");
    let mut interface = real("general_interface.bmf").interfaces.remove(0);
    interface.external = true;
    doc.interfaces.push(interface);
    let entity = &doc.entities[0];
    let mapping = entity
        .mappings
        .iter()
        .find(|m| m.attr_id == entity.attrs[0].id)
        .unwrap();
    let code = entity.attrs.iter().find(|a| a.name == "vcode").unwrap();
    let property = &entity.accessor_config.properties[0];
    let ops: Vec<EditOp> = vec![
        json!({"op":"setMapping","entity":entity.id,"interfaceId":mapping.interface_id,"interfaceAttrId":mapping.interface_attr_id,"attrId":code.id}),
        json!({"op":"setAccessorProperty","entity":entity.id,"name":property.name,"value":"nc.vo.demo.NewWrapper"}),
    ].into_iter().map(|v| serde_json::from_value(v).unwrap()).collect();
    let out = bmf_write::apply(&doc, &ops).unwrap();
    let next = BmfDoc::from_bytes(PathBuf::new(), out).unwrap();
    let changed = next.entities[0]
        .mappings
        .iter()
        .find(|m| m.interface_attr_id == mapping.interface_attr_id)
        .unwrap();
    assert_eq!(changed.attr_id, code.id);
    assert_eq!(
        next.entities[0].accessor_config.properties[0].value,
        "nc.vo.demo.NewWrapper"
    );
    let expected = String::from_utf8(doc.bytes.clone())
        .unwrap()
        .replacen(
            &format!("attrid=\"{}\"", mapping.attr_id),
            &format!("attrid=\"{}\"", code.id),
            1,
        )
        .replacen(
            &format!("value=\"{}\"", property.value),
            "value=\"nc.vo.demo.NewWrapper\"",
            1,
        );
    assert_eq!(String::from_utf8(next.bytes).unwrap(), expected);
}

#[test]
fn bmf_deleting_interface_implementation_clears_its_declaration_and_mappings() {
    let doc = real("matters.bmf");
    let relation = doc
        .relations
        .iter()
        .find(|r| r.kind == "busiitfconnection")
        .unwrap();
    let bytes = bmf_write::apply(
        &doc,
        &[EditOp::DeleteNode {
            id: relation.id.clone(),
        }],
    )
    .unwrap();
    let after = BmfDoc::from_bytes(PathBuf::new(), bytes).unwrap();
    assert!(after.relations.is_empty());
    assert!(after.entities[0].interface_ids.is_empty());
    assert!(after.entities[0].mappings.is_empty());
    assert_eq!(after.references.len(), doc.references.len());
    assert_eq!(
        after.entities[0]
            .attrs
            .iter()
            .map(|a| &a.raw)
            .collect::<Vec<_>>(),
        doc.entities[0]
            .attrs
            .iter()
            .map(|a| &a.raw)
            .collect::<Vec<_>>()
    );
    let reference = &after.references[0];
    let bytes = bmf_write::apply(
        &after,
        &[EditOp::DeleteNode {
            id: reference.id.clone(),
        }],
    )
    .unwrap();
    let removed = BmfDoc::from_bytes(PathBuf::new(), bytes).unwrap();
    assert!(removed.references.is_empty());
    assert!(!removed
        .dependencies
        .iter()
        .any(|d| d.entity_id == reference.ref_id));
}

#[test]
fn bmf_duplicate_implementation_keeps_shared_mappings_until_the_last_connection_is_deleted() {
    let doc = real("matters.bmf");
    let relation = doc
        .relations
        .iter()
        .find(|r| r.kind == "busiitfconnection")
        .unwrap();
    let original = doc.find_node(&relation.id).unwrap().raw(&doc.bytes);
    let duplicate = original.replace(
        &format!("id=\"{}\"", relation.id),
        "id=\"duplicate-connection\"",
    );
    let xml = String::from_utf8(doc.bytes.clone()).unwrap().replacen(
        &original,
        &format!("{original}\n{duplicate}"),
        1,
    );
    let before = BmfDoc::from_bytes(PathBuf::new(), xml.into_bytes()).unwrap();
    let bytes = bmf_write::apply(
        &before,
        &[EditOp::DeleteNode {
            id: relation.id.clone(),
        }],
    )
    .unwrap();
    let after = BmfDoc::from_bytes(PathBuf::new(), bytes).unwrap();
    assert_eq!(after.entities[0].interface_ids.len(), 1);
    assert_eq!(after.entities[0].mappings.len(), 6);
    let bytes = bmf_write::apply(
        &after,
        &[EditOp::DeleteNode {
            id: "duplicate-connection".into(),
        }],
    )
    .unwrap();
    let removed = BmfDoc::from_bytes(PathBuf::new(), bytes).unwrap();
    assert!(removed.entities[0].interface_ids.is_empty());
    assert!(removed.entities[0].mappings.is_empty());
}

#[test]
fn bmf_reference_cannot_be_deleted_while_an_implementation_without_a_connection_uses_it() {
    let doc = real("matters.bmf");
    let relation = doc
        .relations
        .iter()
        .find(|r| r.kind == "busiitfconnection")
        .unwrap();
    let xml = String::from_utf8(doc.bytes.clone())
        .unwrap()
        .replace(&doc.find_node(&relation.id).unwrap().raw(&doc.bytes), "");
    let before = BmfDoc::from_bytes(PathBuf::new(), xml.into_bytes()).unwrap();
    assert!(bmf_write::apply(
        &before,
        &[EditOp::DeleteNode {
            id: doc.references[0].id.clone()
        }]
    )
    .is_err());
}

#[test]
fn bmf_new_implementation_can_map_an_entity_with_missing_optional_containers() {
    let before = BmfDoc::from_bytes(
        PathBuf::new(),
        br#"<component><celllist><entity id="e" name="Entity"><attributelist><attribute id="a" name="code" typeName="String" dataType="BS000010000100001001"/></attributelist></entity><busiIterface id="i"><busiItfAttrs><busiItAttr id="ia" name="code" typeName="String" dataType="BS000010000100001001"/></busiItfAttrs></busiIterface></celllist></component>"#.to_vec(),
    )
    .unwrap();
    let ops = vec![
        json!({"op":"addRelation","kind":"busiitfconnection","source":"e","target":"i","name":"","id":"r"}),
        json!({"op":"setMapping","entity":"e","interfaceId":"i","interfaceAttrId":"ia","attrId":"a"}),
    ].into_iter().map(|v| serde_json::from_value(v).unwrap()).collect::<Vec<EditOp>>();
    let out = bmf_write::apply(&before, &ops).unwrap();
    let after = BmfDoc::from_bytes(PathBuf::new(), out).unwrap();
    assert_eq!(after.entities[0].interface_ids, vec!["i"]);
    assert_eq!(after.entities[0].mappings.len(), 1);
}

#[test]
fn bmf_local_interface_type_dependencies_cannot_be_deleted() {
    let before = BmfDoc::from_bytes(
        PathBuf::new(),
        br#"<component><celllist><entity id="e" name="Entity"><attributelist/></entity><Enumerate id="n" name="State"><enumitemlist><enumitem id="v" enumValue="1"/></enumitemlist></Enumerate><busiIterface id="i"><busiItfAttrs><busiItAttr id="ie" dataType="e" typeName="Entity" dataTypeStyle="ARRAY"/><busiItAttr id="in" dataType="n" typeName="State"/></busiItfAttrs></busiIterface></celllist></component>"#.to_vec(),
    )
    .unwrap();
    for id in ["e", "n"] {
        assert!(bmf_write::apply(&before, &[EditOp::DeleteNode { id: id.into() }]).is_err());
    }
}

#[test]
fn bmf_mapping_blocks_interface_deletion_even_when_the_declaration_is_missing() {
    let before = BmfDoc::from_bytes(
        PathBuf::new(),
        br#"<component><celllist><entity id="e"><attributelist/><busimaps><busimap busiitfid="i" busiitfattrid="ia" attrid=""/></busimaps></entity><busiIterface id="i"><busiItfAttrs><busiItAttr id="ia"/></busiItfAttrs></busiIterface></celllist></component>"#.to_vec(),
    )
    .unwrap();
    assert!(bmf_write::apply(&before, &[EditOp::DeleteNode { id: "i".into() }]).is_err());
}
