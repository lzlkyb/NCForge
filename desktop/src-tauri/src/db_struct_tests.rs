use super::*;

fn col(name: &str, ty: &str, nullable: bool) -> StructColumn {
    StructColumn {
        name: name.into(),
        ty: ty.into(),
        nullable,
        default_text: None,
        comment: None,
    }
}

fn table(columns: Vec<StructColumn>, pk: &[&str], indexes: Vec<StructIndex>) -> TableStruct {
    TableStruct {
        label: "NC65.BD_MATERIAL".into(),
        columns,
        pk: pk.iter().map(|s| s.to_string()).collect(),
        pk_name: Some("PK_BD_MATERIAL".into()),
        indexes,
        comment: None,
    }
}

fn row(cells: &[&str]) -> Vec<Option<String>> {
    cells.iter().map(|c| Some(c.to_string())).collect()
}

#[test]
fn 类型归一成ddl写法() {
    // char_length 优先：VARCHAR2(40 CHAR) 与 VARCHAR2(40) 不是两种东西
    assert_eq!(
        format_type("VARCHAR2", Some(120), Some(40), None, None),
        "VARCHAR2(40)"
    );
    assert_eq!(
        format_type("NUMBER", None, None, Some(12), Some(2)),
        "NUMBER(12,2)"
    );
    assert_eq!(
        format_type("NUMBER", None, None, Some(12), Some(0)),
        "NUMBER(12)"
    );
    assert_eq!(format_type("NUMBER", None, None, None, None), "NUMBER");
    // 自带精度的不能再拼一次括号
    assert_eq!(
        format_type("TIMESTAMP(6)", None, None, Some(6), None),
        "TIMESTAMP(6)"
    );
    assert_eq!(format_type("RAW", Some(16), None, None, None), "RAW(16)");
    assert_eq!(format_type("date", None, None, None, None), "DATE");
}

#[test]
fn 列解析_空注释当没有_默认值去换行() {
    let rows = vec![
        row(&["ID", "NUMBER", "22", "", "", "12", "0", "N", "\n", ""]),
        row(&[
            "MEMO", "VARCHAR2", "120", "40", "C", "", "", "Y", "'x' ", "备注",
        ]),
        row(&[
            "BLANK", "VARCHAR2", "10", "10", "C", "", "", "Y", "null", "  ",
        ]),
    ];
    let cols = parse_columns(&rows);
    assert_eq!(cols.len(), 3);
    assert_eq!(cols[0].ty, "NUMBER(12)");
    assert!(!cols[0].nullable);
    // Oracle 的 data_default 永远带回车；不去掉的话「有默认值 vs 没默认值」永远判不等
    assert_eq!(cols[0].default_text, None);
    assert_eq!(cols[1].default_text.as_deref(), Some("'x'"));
    assert_eq!(cols[1].comment.as_deref(), Some("备注"));
    assert_eq!(cols[2].default_text, None);
    assert_eq!(cols[2].comment, None);
}

#[test]
fn 索引按名字归组_函数索引跳过() {
    let rows = vec![
        row(&["IDX_A", "UNIQUE", "CODE", "1"]),
        row(&["IDX_A", "UNIQUE", "ORG", "2"]),
        row(&["IDX_FN", "NONUNIQUE", "", "1"]),
        row(&["IDX_B", "NONUNIQUE", "NAME", "1"]),
    ];
    let ix = parse_indexes(&rows);
    assert_eq!(ix.len(), 2, "{ix:?}");
    assert_eq!(ix[0].columns, vec!["CODE".to_string(), "ORG".to_string()]);
    assert!(ix[0].unique);
    assert_eq!(ix[1].name, "IDX_B");
}

#[test]
fn 混合列的函数索引整条丢掉() {
    // 一列有表达式、一列没有：只丢表达式那列会生成一个「少一列」的索引，比不生成更坏
    let rows = vec![
        row(&["IDX_MIX", "NONUNIQUE", "CODE", "1"]),
        row(&["IDX_MIX", "NONUNIQUE", "", "2"]),
    ];
    assert!(parse_indexes(&rows).is_empty());
}

#[test]
fn 主键索引不算多出来的索引() {
    let ix = vec![
        StructIndex {
            name: "PK_X".into(),
            unique: true,
            columns: vec!["ID".into()],
        },
        StructIndex {
            name: "IDX_A".into(),
            unique: false,
            columns: vec!["CODE".into()],
        },
    ];
    let left = drop_pk_index(ix, &["ID".to_string()]);
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].name, "IDX_A");
}

#[test]
fn 完全一致时没有任何差异() {
    let cols = vec![
        col("ID", "NUMBER(12)", false),
        col("NAME", "VARCHAR2(40)", true),
    ];
    let d = diff(
        table(cols.clone(), &["ID"], vec![]),
        table(cols, &["ID"], vec![]),
    );
    assert!(d.is_clean(), "{d:?}");
    assert!(d.ddl.is_empty());
}

#[test]
fn 列增删改的状态与差异字段() {
    let left = table(
        vec![
            col("ID", "NUMBER(12)", false),
            col("MEMO", "VARCHAR2(400)", true),
        ],
        &["ID"],
        vec![],
    );
    let mut right = table(
        vec![col("ID", "NUMBER(10)", false), col("OLD", "DATE", true)],
        &["ID"],
        vec![],
    );
    right.comment = None;

    let d = diff(left, right);
    let by = |n: &str| d.columns.iter().find(|c| c.name == n).unwrap();
    assert_eq!(by("ID").status, DiffStatus::Changed);
    // 类型不同只报一条，不把「可空」也带出来（都是 not null）
    assert_eq!(by("ID").changes.len(), 1);
    assert_eq!(by("ID").changes[0].field, "类型");
    assert_eq!(by("MEMO").status, DiffStatus::OnlyLeft);
    assert_eq!(by("OLD").status, DiffStatus::OnlyRight);

    // 先删后加：反过来会在同名临时列上撞车
    let sqls: Vec<&str> = d.ddl.iter().map(|s| s.sql.as_str()).collect();
    let drop_at = sqls
        .iter()
        .position(|s| s.contains("drop column OLD"))
        .unwrap();
    let add_at = sqls.iter().position(|s| s.contains("add (MEMO")).unwrap();
    assert!(drop_at < add_at, "{sqls:?}");
    assert!(d.ddl[drop_at].destructive);
    assert!(!d.ddl[add_at].destructive);
}

#[test]
fn 索引按列组合配对_名字不同只提示不改() {
    let l = table(
        vec![col("CODE", "VARCHAR2(40)", true)],
        &[],
        vec![StructIndex {
            name: "IDX_CODE".into(),
            unique: false,
            columns: vec!["CODE".into()],
        }],
    );
    let r = table(
        vec![col("CODE", "VARCHAR2(40)", true)],
        &[],
        vec![StructIndex {
            name: "IDX_CODE_01".into(),
            unique: false,
            columns: vec!["CODE".into()],
        }],
    );
    let d = diff(l, r);
    assert_eq!(d.indexes[0].status, DiffStatus::Same);
    assert!(d.indexes[0].renamed);
    assert!(d.is_clean());
    // 只是改名，不该生成 drop + create
    assert!(d.ddl.is_empty(), "{:?}", d.ddl);
}

#[test]
fn 主键变化先生成删除再生成新增() {
    let cols = vec![
        col("ID", "NUMBER(12)", false),
        col("CODE", "VARCHAR2(40)", false),
    ];
    let l = table(cols.clone(), &["ID"], vec![]);
    let r = table(cols, &["CODE"], vec![]);
    let d = diff(l, r);
    assert!(d.pk_changed);
    assert!(d.ddl[0].sql.contains("drop primary key"), "{:?}", d.ddl);
    assert!(d.ddl.last().unwrap().sql.contains("primary key (ID)"));
    // 删主键必须先于加索引：先建索引会让 PK 索引重名
    let add_pk = d
        .ddl
        .iter()
        .position(|s| s.sql.contains("add constraint"))
        .unwrap();
    assert_eq!(add_pk, d.ddl.len() - 1);
}

#[test]
fn 右侧没有主键时只生成新增() {
    let l = table(vec![col("ID", "NUMBER(12)", false)], &["ID"], vec![]);
    let r = table(vec![col("ID", "NUMBER(12)", false)], &[], vec![]);
    let d = diff(l, r);
    assert!(d.ddl.iter().all(|s| !s.sql.contains("drop primary key")));
    assert!(d.ddl[0].sql.contains("add constraint"));
}

#[test]
fn 标识符不普通时加引号() {
    assert_eq!(q("BD_MATERIAL"), "BD_MATERIAL");
    assert_eq!(q("bd_material"), "bd_material");
    assert_eq!(q("A B"), "\"A B\"");
    assert_eq!(q("A\"B"), "\"A\"\"B\"");
    assert_eq!(q(""), "\"\"");
}

#[test]
fn 注释差异生成comment语句() {
    let mut l = table(vec![col("ID", "NUMBER(12)", false)], &[], vec![]);
    let r = table(vec![col("ID", "NUMBER(12)", false)], &[], vec![]);
    l.comment = Some("物料".into());
    let d = diff(l, r);
    assert!(d.comment_changed);
    let stmt = d
        .ddl
        .iter()
        .find(|s| s.sql.starts_with("comment on table"))
        .unwrap();
    assert_eq!(stmt.sql, "comment on table NC65.BD_MATERIAL is '物料';");
}

#[test]
fn 返回体不是结果集时报错而不是空结构() {
    let err = body_rows(&serde_json::json!({ "kind": "update", "affected": 1 })).unwrap_err();
    assert!(err.contains("没有返回结果集"), "{err}");
    let rows = body_rows(&serde_json::json!({
        "kind": "rows",
        "rows": [["A", 1, null]]
    }))
    .unwrap();
    assert_eq!(rows[0][0].as_deref(), Some("A"));
    assert_eq!(rows[0][1].as_deref(), Some("1"));
    assert_eq!(rows[0][2], None);
}
