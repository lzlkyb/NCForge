//! 多操作事务的回归契约：预览和保存使用同一份稳定 ID，失败不产生部分写入。
use std::path::PathBuf;

use nc_forge::bmf_model::BmfDoc;
use nc_forge::bmf_write::{self, EditOp};
use serde_json::{json, Value};

const XML: &str = r#"<component id="c" name="demo"><celllist>
<entity id="e" name="Head" tableName="head" fullClassName="nc.vo.demo.Head" keyAttributeId=""><attributelist>
<attribute id="a" name="code" fieldName="code" displayName="编码" sequence="0" isKey="false" isNullable="true" length="20"/>
</attributelist></entity>
<entity id="b" name="Body" tableName="body" fullClassName="nc.vo.demo.Body" keyAttributeId=""><attributelist/></entity>
</celllist><connectlist><AggregationRelation id="r" source="e" target="b" srcAttributeid="a"/></connectlist><Future x="原样"/></component>"#;

fn doc() -> BmfDoc {
    BmfDoc::from_bytes(PathBuf::from("transaction.bmf"), XML.as_bytes().to_vec()).unwrap()
}
fn ops(values: Vec<Value>) -> Vec<EditOp> {
    values
        .into_iter()
        .map(|v| serde_json::from_value(v).unwrap())
        .collect()
}
fn add(id: &str, name: &str) -> Value {
    json!({"op":"addAttribute","entity":"e","name":name,"displayName":name,"id":id})
}

#[test]
fn bmf_later_operation_can_edit_a_new_field_and_make_it_the_key() {
    let out = bmf_write::apply(
        &doc(),
        &ops(vec![
            add("new", "extra"),
            json!({"op":"setAttr","id":"new","name":"displayName","value":"新字段"}),
            json!({"op":"setAttr","id":"new","name":"isKey","value":"true"}),
            json!({"op":"setEntityKey","entity":"e","attrId":"new"}),
        ]),
    )
    .unwrap();
    let next = BmfDoc::from_bytes(PathBuf::new(), out).unwrap();
    assert_eq!(next.entities[0].key_attr_id, "new");
    assert_eq!(next.entities[0].attrs[1].display_name, "新字段");
    assert!(next.entities[0].attrs[1].is_key);
}

#[test]
fn bmf_consecutive_additions_keep_input_order_and_unique_sequences() {
    let out = bmf_write::apply(
        &doc(),
        &ops(vec![
            add("a1", "first"),
            add("a2", "second"),
            add("a3", "third"),
        ]),
    )
    .unwrap();
    let next = BmfDoc::from_bytes(PathBuf::new(), out).unwrap();
    assert_eq!(
        next.entities[0]
            .attrs
            .iter()
            .map(|a| (&*a.name, a.sequence))
            .collect::<Vec<_>>(),
        vec![("code", 0), ("first", 1), ("second", 2), ("third", 3)]
    );
}

#[test]
fn bmf_repeated_edits_take_the_last_value_without_overlapping_spans() {
    let out = bmf_write::apply(
        &doc(),
        &ops(vec![
            json!({"op":"setAttr","id":"a","name":"displayName","value":"一"}),
            json!({"op":"setAttr","id":"a","name":"displayName","value":"二"}),
        ]),
    )
    .unwrap();
    assert_eq!(
        BmfDoc::from_bytes(PathBuf::new(), out).unwrap().entities[0].attrs[0].display_name,
        "二"
    );
}

#[test]
fn bmf_reference_aliases_cannot_add_duplicate_uap_relations() {
    let make = |kind: &str, id: &str| json!({"op":"addRelation","kind":kind,"source":"e","target":"b","name":"","id":id});
    let first = bmf_write::apply(&doc(), &ops(vec![make("Reference", "ref-1")])).unwrap();
    let next = BmfDoc::from_bytes(PathBuf::new(), first).unwrap();
    assert!(next.relations.iter().any(|r| r.kind == "relation"));
    assert!(bmf_write::apply(&next, &ops(vec![make("Reference", "ref-2")])).is_err());
    assert!(bmf_write::apply(
        &doc(),
        &ops(vec![make("Reference", "ref-1"), make("relation", "ref-2")])
    )
    .is_err());

    let legacy = BmfDoc::from_bytes(
        PathBuf::new(),
        XML.replace("AggregationRelation", "Reference").into_bytes(),
    )
    .unwrap();
    assert!(bmf_write::apply(&legacy, &ops(vec![make("relation", "ref-1")])).is_err());
}

#[test]
fn bmf_many_new_relations_create_only_one_missing_connectlist() {
    let xml = XML.replace(
        r#"<connectlist><AggregationRelation id="r" source="e" target="b" srcAttributeid="a"/></connectlist>"#,
        "",
    );
    let before = BmfDoc::from_bytes(PathBuf::new(), xml.into_bytes()).unwrap();
    let out = bmf_write::apply(
        &before,
        &ops(vec![
            json!({"op":"addEntity","id":"extra","name":"Extra","displayName":"Extra","table":"extra","fullClass":"nc.vo.demo.Extra"}),
            json!({"op":"addRelation","kind":"relation","source":"e","target":"b","name":"","id":"r1"}),
            json!({"op":"addRelation","kind":"relation","source":"e","target":"extra","name":"","id":"r2"}),
        ]),
    )
    .unwrap();
    let next = BmfDoc::from_bytes(PathBuf::new(), out).unwrap();
    assert_eq!(next.relations.len(), 2);
    assert_eq!(
        next.root
            .children
            .iter()
            .filter(|n| n.name == "connectlist")
            .count(),
        1
    );
}

#[test]
fn bmf_batch_inheritance_cannot_form_a_cycle() {
    let result = bmf_write::apply(
        &doc(),
        &ops(vec![
            json!({"op":"addRelation","kind":"ExtendConnection","source":"e","target":"b","name":"","id":"extends-1"}),
            json!({"op":"addRelation","kind":"ExtendConnection","source":"b","target":"e","name":"","id":"extends-2"}),
        ]),
    );
    assert!(result.unwrap_err().contains("循环"));
}

#[test]
fn bmf_inheritance_cannot_add_a_second_parent() {
    let result = bmf_write::apply(
        &doc(),
        &ops(vec![
            json!({"op":"addEntity","id":"extra","name":"Extra","displayName":"Extra","table":"extra","fullClass":"nc.vo.demo.Extra"}),
            json!({"op":"addRelation","kind":"ExtendConnection","source":"e","target":"b","name":"","id":"extends-1"}),
            json!({"op":"addRelation","kind":"ExtendConnection","source":"e","target":"extra","name":"","id":"extends-2"}),
        ]),
    );
    assert!(result.unwrap_err().contains("继承父类"));
}

#[test]
fn bmf_deleting_a_relation_then_its_field_is_one_valid_transaction() {
    let out = bmf_write::apply(
        &doc(),
        &ops(vec![
            json!({"op":"deleteNode","id":"r"}),
            json!({"op":"deleteNode","id":"a"}),
        ]),
    )
    .unwrap();
    let next = BmfDoc::from_bytes(PathBuf::new(), out).unwrap();
    assert!(next.relations.is_empty());
    assert!(next.entities[0].attrs.is_empty());
}

#[test]
fn bmf_new_field_ids_cannot_collide_with_existing_or_new_nodes() {
    assert!(bmf_write::apply(&doc(), &ops(vec![add("a", "collision")])).is_err());
    assert!(bmf_write::apply(
        &doc(),
        &ops(vec![add("same", "first"), add("same", "second")])
    )
    .is_err());
}

#[test]
fn bmf_equal_field_names_in_different_entities_are_valid() {
    let out = bmf_write::apply(&doc(), &ops(vec![
        json!({"op":"addAttribute","entity":"b","name":"code","displayName":"code","id":"body-code"}),
        json!({"op":"setAttr","id":"a","name":"fieldName","value":"code"}),
    ])).unwrap();
    assert_eq!(
        BmfDoc::from_bytes(PathBuf::new(), out).unwrap().entities[1].attrs[0].field,
        "code"
    );
}

#[test]
fn bmf_an_invalid_later_operation_leaves_the_file_and_backup_directory_untouched() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("demo.bmf");
    std::fs::write(&path, XML).unwrap();
    let opened = BmfDoc::open(&path).unwrap();
    let backup = temp.path().join("backup");
    let result = bmf_write::save(
        &opened,
        &ops(vec![
            add("new", "extra"),
            json!({"op":"setAttr","id":"a","name":"length","value":"-1"}),
        ]),
        &backup,
    );
    assert!(result.is_err());
    assert_eq!(std::fs::read(&path).unwrap(), opened.bytes);
    assert!(!backup.exists());
}

#[test]
fn bmf_bom_crlf_and_unknown_content_survive_a_batch_and_sha_conflicts_reject_it() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("demo.bmf");
    let bytes = format!("\u{feff}{}", XML.replace('\n', "\r\n")).into_bytes();
    std::fs::write(&path, &bytes).unwrap();
    let opened = BmfDoc::open(&path).unwrap();
    let changes = ops(vec![
        add("new", "extra"),
        json!({"op":"setAttr","id":"a","name":"displayName","value":"名称"}),
    ]);
    let out = bmf_write::apply(&opened, &changes).unwrap();
    assert!(out.starts_with(&[0xef, 0xbb, 0xbf]));
    assert!(out
        .windows(b"<Future x=\"".len())
        .any(|b| b == b"<Future x=\""));
    assert!(!out.windows(2).any(|b| b[1] == b'\n' && b[0] != b'\r'));
    std::fs::write(&path, b"external change").unwrap();
    assert!(
        bmf_write::save(&opened, &changes, &temp.path().join("backup"))
            .unwrap_err()
            .contains("CONFLICT")
    );
    assert_eq!(std::fs::read(&path).unwrap(), b"external change");
}
