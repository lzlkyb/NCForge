//! 多方言建表 SQL 渲染（预览物，不执行）。
//!
//! 8 种方言与官方 `com.yonyou.studio.mdp.database` 的 `TranslateTo*` 对齐：
//! DB2 / GBase / Informix / Oracle / Oscar / PostgreSQL / SQLServer / Sybase。
//!
//! 纪律：
//! 1. 类型映射先归一成 `Logical`（Id/Text/Decimal/...），再落方言；不再为每个方言
//!    复制一遍 `dbtype/fieldType/typeName` 回退逻辑。
//! 2. 未识别类型不猜：列类型写 `/* 未识别类型 */` 并进 warnings。
//! 3. 外键默认不生成；开了 `with_foreign_keys` 才按 `AggregationRelation` 出。
//! 4. 「只生成扩展表」当前无数据支撑——BMF 模型里没有扩展表标记，只给提示，不伪造。

use std::collections::HashSet;

use crate::bmf_gen_types::{Artifact, Family, GenProfile, SqlDialect};
use crate::bmf_model::{Attr, BmfDoc, Entity};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Logical {
    Char(u32),
    Varchar(u32),
    Memo,
    Int,
    Decimal(u32, u32),
    Bool,
    Date,
    Time,
    DateTime,
    Blob,
    Clob,
}

fn default_len(ty: &str) -> u32 {
    match ty {
        "UFID" => 20,
        "CUSTOM" => 101,
        "MEMO" | "Multilangtext" => 200,
        "UFBoolean" => 1,
        "UFDate" | "UFDateTime" => 19,
        "UFLiteralDate" => 10,
        "UFTime" => 8,
        _ => 50,
    }
}

/// 归一类型。`None` = 不认识，调用方必须报出来。
fn logical_type(a: &Attr) -> Option<Logical> {
    let dt = if a.db_type.trim().is_empty() {
        a.field_type.to_lowercase()
    } else {
        a.db_type.to_lowercase()
    };
    let len = a.length.unwrap_or(0);
    match dt.trim() {
        "" => infer(a),
        "char" | "nchar" => Some(Logical::Char(if len > 0 { len } else { 20 })),
        "varchar" | "varchar2" | "nvarchar" | "nvarchar2" => {
            Some(Logical::Varchar(if len > 0 { len } else { default_len(&a.type_name) }))
        }
        "decimal" | "number" | "numeric" => Some(Logical::Decimal(
            if len > 0 { len } else { 28 },
            a.precision.unwrap_or(8),
        )),
        "int" | "integer" | "smallint" | "bigint" => Some(Logical::Int),
        "date" => Some(Logical::Date),
        "datetime" | "timestamp" => Some(Logical::DateTime),
        "time" => Some(Logical::Time),
        "image" | "blob" | "long raw" => Some(Logical::Blob),
        "clob" | "text" | "memo" => Some(Logical::Clob),
        _ => None,
    }
}

fn infer(a: &Attr) -> Option<Logical> {
    let ty = a.type_name.as_str();
    let len = a.length.unwrap_or(0);
    Some(match ty {
        "UFID" => Logical::Char(if len > 0 { len } else { 20 }),
        "String" | "CUSTOM" | "user" | "group" | "org" | "org_v" | "admin" => {
            Logical::Varchar(if len > 0 { len } else { default_len(ty) })
        }
        "Multilangtext" => Logical::Varchar(if len > 0 { len } else { 200 }),
        "MEMO" => Logical::Memo,
        "Integer" => Logical::Int,
        "UFDouble" | "UFMoney" | "BigDecimal" => {
            Logical::Decimal(if len > 0 { len } else { 28 }, a.precision.unwrap_or(8))
        }
        "UFBoolean" => Logical::Bool,
        "UFDate" => Logical::Char(if len > 0 { len } else { 19 }),
        "UFDateTime" => Logical::Char(if len > 0 { len } else { 19 }),
        "UFLiteralDate" => Logical::Char(if len > 0 { len } else { 10 }),
        "UFTime" => Logical::Char(if len > 0 { len } else { 8 }),
        "IMAGE" | "BLOB" => Logical::Blob,
        "CLOB" => Logical::Clob,
        _ => return None,
    })
}

fn column_type(d: SqlDialect, t: Logical) -> String {
    match (d, t) {
        (SqlDialect::Oracle, Logical::Char(n)) => format!("char({n})"),
        (SqlDialect::Oracle, Logical::Varchar(n)) => format!("varchar2({n})"),
        (SqlDialect::Oracle, Logical::Memo) => "varchar2(2000)".into(),
        (SqlDialect::Oracle, Logical::Int) => "number(10)".into(),
        (SqlDialect::Oracle, Logical::Decimal(p, s)) => format!("number({p},{s})"),
        (SqlDialect::Oracle, Logical::Bool) => "char(1)".into(),
        (SqlDialect::Oracle, Logical::Date) => "date".into(),
        (SqlDialect::Oracle, Logical::Time) => "char(8)".into(),
        (SqlDialect::Oracle, Logical::DateTime) => "char(19)".into(),
        (SqlDialect::Oracle, Logical::Blob) => "blob".into(),
        (SqlDialect::Oracle, Logical::Clob) => "clob".into(),

        // 神通（Oscar）与 Oracle 同族，但 varchar2/number 不保证所有版本都开，
        // 用标准 varchar/numeric 更稳。
        (SqlDialect::Oscar, Logical::Char(n)) => format!("char({n})"),
        (SqlDialect::Oscar, Logical::Varchar(n)) => format!("varchar({n})"),
        (SqlDialect::Oscar, Logical::Memo) => "varchar(2000)".into(),
        (SqlDialect::Oscar, Logical::Int) => "int".into(),
        (SqlDialect::Oscar, Logical::Decimal(p, s)) => format!("numeric({p},{s})"),
        (SqlDialect::Oscar, Logical::Bool) => "char(1)".into(),
        (SqlDialect::Oscar, Logical::Date) => "date".into(),
        (SqlDialect::Oscar, Logical::Time) => "char(8)".into(),
        (SqlDialect::Oscar, Logical::DateTime) => "char(19)".into(),
        (SqlDialect::Oscar, Logical::Blob) => "blob".into(),
        (SqlDialect::Oscar, Logical::Clob) => "clob".into(),

        (SqlDialect::Postgresql, Logical::Char(n)) => format!("char({n})"),
        (SqlDialect::Postgresql, Logical::Varchar(n)) => format!("varchar({n})"),
        (SqlDialect::Postgresql, Logical::Memo) => "varchar(2000)".into(),
        (SqlDialect::Postgresql, Logical::Int) => "integer".into(),
        (SqlDialect::Postgresql, Logical::Decimal(p, s)) => format!("numeric({p},{s})"),
        (SqlDialect::Postgresql, Logical::Bool) => "char(1)".into(),
        (SqlDialect::Postgresql, Logical::Date) => "date".into(),
        (SqlDialect::Postgresql, Logical::Time) => "time".into(),
        (SqlDialect::Postgresql, Logical::DateTime) => "timestamp".into(),
        (SqlDialect::Postgresql, Logical::Blob) => "bytea".into(),
        (SqlDialect::Postgresql, Logical::Clob) => "text".into(),

        (SqlDialect::Sqlserver, Logical::Char(n)) => format!("char({n})"),
        (SqlDialect::Sqlserver, Logical::Varchar(n)) => format!("nvarchar({n})"),
        (SqlDialect::Sqlserver, Logical::Memo) => "nvarchar(2000)".into(),
        (SqlDialect::Sqlserver, Logical::Int) => "int".into(),
        (SqlDialect::Sqlserver, Logical::Decimal(p, s)) => format!("decimal({p},{s})"),
        (SqlDialect::Sqlserver, Logical::Bool) => "char(1)".into(),
        (SqlDialect::Sqlserver, Logical::Date) => "date".into(),
        (SqlDialect::Sqlserver, Logical::Time) => "time".into(),
        (SqlDialect::Sqlserver, Logical::DateTime) => "datetime".into(),
        (SqlDialect::Sqlserver, Logical::Blob) => "varbinary(max)".into(),
        (SqlDialect::Sqlserver, Logical::Clob) => "nvarchar(max)".into(),

        (SqlDialect::Db2, Logical::Char(n)) => format!("char({n})"),
        (SqlDialect::Db2, Logical::Varchar(n)) => format!("varchar({n})"),
        (SqlDialect::Db2, Logical::Memo) => "varchar(2000)".into(),
        (SqlDialect::Db2, Logical::Int) => "integer".into(),
        (SqlDialect::Db2, Logical::Decimal(p, s)) => format!("decimal({p},{s})"),
        (SqlDialect::Db2, Logical::Bool) => "char(1)".into(),
        (SqlDialect::Db2, Logical::Date) => "date".into(),
        (SqlDialect::Db2, Logical::Time) => "time".into(),
        (SqlDialect::Db2, Logical::DateTime) => "timestamp".into(),
        (SqlDialect::Db2, Logical::Blob) => "blob".into(),
        (SqlDialect::Db2, Logical::Clob) => "clob".into(),

        (SqlDialect::Informix, Logical::Char(n)) => format!("char({n})"),
        (SqlDialect::Informix, Logical::Varchar(n)) => format!("varchar({n})"),
        (SqlDialect::Informix, Logical::Memo) => "varchar(2000)".into(),
        (SqlDialect::Informix, Logical::Int) => "integer".into(),
        (SqlDialect::Informix, Logical::Decimal(p, s)) => format!("decimal({p},{s})"),
        (SqlDialect::Informix, Logical::Bool) => "char(1)".into(),
        (SqlDialect::Informix, Logical::Date) => "date".into(),
        (SqlDialect::Informix, Logical::Time) => "char(8)".into(),
        (SqlDialect::Informix, Logical::DateTime) => "datetime year to second".into(),
        (SqlDialect::Informix, Logical::Blob) => "blob".into(),
        (SqlDialect::Informix, Logical::Clob) => "clob".into(),

        (SqlDialect::Sybase, Logical::Char(n)) => format!("char({n})"),
        (SqlDialect::Sybase, Logical::Varchar(n)) => format!("varchar({n})"),
        (SqlDialect::Sybase, Logical::Memo) => "varchar(2000)".into(),
        (SqlDialect::Sybase, Logical::Int) => "int".into(),
        (SqlDialect::Sybase, Logical::Decimal(p, s)) => format!("numeric({p},{s})"),
        (SqlDialect::Sybase, Logical::Bool) => "char(1)".into(),
        (SqlDialect::Sybase, Logical::Date) => "date".into(),
        (SqlDialect::Sybase, Logical::Time) => "time".into(),
        (SqlDialect::Sybase, Logical::DateTime) => "datetime".into(),
        (SqlDialect::Sybase, Logical::Blob) => "image".into(),
        (SqlDialect::Sybase, Logical::Clob) => "text".into(),

        (SqlDialect::Gbase, Logical::Char(n)) => format!("char({n})"),
        (SqlDialect::Gbase, Logical::Varchar(n)) => format!("varchar({n})"),
        (SqlDialect::Gbase, Logical::Memo) => "varchar(2000)".into(),
        (SqlDialect::Gbase, Logical::Int) => "int".into(),
        (SqlDialect::Gbase, Logical::Decimal(p, s)) => format!("decimal({p},{s})"),
        (SqlDialect::Gbase, Logical::Bool) => "char(1)".into(),
        (SqlDialect::Gbase, Logical::Date) => "date".into(),
        (SqlDialect::Gbase, Logical::Time) => "time".into(),
        (SqlDialect::Gbase, Logical::DateTime) => "datetime".into(),
        (SqlDialect::Gbase, Logical::Blob) => "longblob".into(),
        (SqlDialect::Gbase, Logical::Clob) => "longtext".into(),
    }
}

fn comments_inline(d: SqlDialect) -> bool {
    d == SqlDialect::Gbase
}

fn escape_sql(s: &str) -> String {
    s.replace('\'', "''").replace(['\r', '\n'], " ")
}

fn sql_literal(s: &str) -> String {
    if s.parse::<f64>().is_ok() {
        s.to_string()
    } else {
        format!("'{}'", escape_sql(s))
    }
}

fn short_name(table: &str) -> String {
    let s: String = table
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect();
    if s.len() > 24 {
        s[s.len() - 24..].to_string()
    } else {
        s
    }
}

fn comment_stmt(d: SqlDialect, table: &str, column: Option<&str>, text: &str) -> String {
    match d {
        SqlDialect::Sqlserver => match column {
            Some(c) => format!(
                "exec sp_addextendedproperty 'MS_Description', N'{t}', 'SCHEMA', dbo, 'TABLE', {table}, 'COLUMN', {c};\n",
                t = escape_sql(text)
            ),
            None => format!(
                "exec sp_addextendedproperty 'MS_Description', N'{t}', 'SCHEMA', dbo, 'TABLE', {table};\n",
                t = escape_sql(text)
            ),
        },
        // Sybase ASE 的扩展属性支持因版本而异；这里只出注释行，不冒充可执行语句。
        SqlDialect::Sybase => match column {
            Some(c) => format!("-- comment on column {table}.{c}: {text}\n"),
            None => format!("-- comment on table {table}: {text}\n"),
        },
        SqlDialect::Gbase => String::new(),
        _ => match column {
            Some(c) => format!("comment on column {table}.{c} is '{}';\n", escape_sql(text)),
            None => format!("comment on table {table} is '{}';\n", escape_sql(text)),
        },
    }
}

/// 建表脚本。`only` 为空 = 所有实体。
pub fn ddl(doc: &BmfDoc, p: &GenProfile, only: &[String], warnings: &mut Vec<String>) -> String {
    let d = p.dialect;
    let mut s = String::new();
    s.push_str(&format!(
        "-- NCForge 生成：{} 建表脚本（预演，**未执行**）\n",
        d.as_str()
    ));
    s.push_str(&format!(
        "-- 组件 {}（{}） 命名空间 {}\n",
        doc.component.display_name, doc.component.name, doc.component.namespace
    ));
    s.push_str("-- 对照 UAP Studio「生成建库 SQL」逐行 diff 后再决定是否执行\n\n");

    if p.options.only_extension_tables {
        warnings.push(
            "「只生成扩展表」需要 BMF 里的扩展表标记；当前模型没有该信息，选项未改变任何表名"
                .to_string(),
        );
    }

    let picked: Vec<&Entity> = doc
        .entities
        .iter()
        .filter(|e| only.is_empty() || only.iter().any(|id| id == &e.id || id == &e.name))
        .collect();

    for e in &picked {
        if e.table.trim().is_empty() {
            warnings.push(format!("实体 {} 没有表名，跳过 DDL", e.name));
            continue;
        }
        let cols: Vec<&Attr> = e
            .attrs
            .iter()
            .filter(|a| a.style != "ARRAY" && !a.field.trim().is_empty())
            .collect();
        if cols.is_empty() {
            warnings.push(format!("实体 {} 没有可落库的列，跳过 DDL", e.name));
            continue;
        }
        s.push_str(&format!("-- {} / {}\n", e.display_name, e.name));
        s.push_str(&format!("create table {} (\n", e.table));
        let mut lines = Vec::new();
        for a in &cols {
            let ty = match logical_type(a) {
                Some(t) => column_type(d, t),
                None => {
                    warnings.push(format!(
                        "{}.{} 类型未识别（{} / {}），DDL 里标成未识别类型",
                        e.table, a.name, a.type_name, a.data_type
                    ));
                    format!("/* 未识别类型：{} */", a.type_name)
                }
            };
            let mut line = format!("  {} {}", a.field, ty);
            let dflt = a.default_value.trim();
            if !dflt.is_empty() && dflt != "~" {
                line.push_str(&format!(" default {}", sql_literal(dflt)));
            }
            if !a.nullable {
                line.push_str(" not null");
            }
            if comments_inline(d) && !a.display_name.is_empty() {
                line.push_str(&format!(" comment '{}'", escape_sql(&a.display_name)));
            }
            lines.push(line);
        }
        let keys: Vec<&str> = e
            .attrs
            .iter()
            .filter(|a| a.is_key && a.style != "ARRAY" && !a.field.trim().is_empty())
            .map(|a| a.field.as_str())
            .collect();
        if keys.is_empty() {
            warnings.push(format!("实体 {} 没有主键列，DDL 无法建主键约束", e.name));
        }
        for k in keys {
            lines.push(format!(
                "  constraint pk_{} primary key ({})",
                short_name(&e.table),
                k
            ));
        }
        s.push_str(&lines.join(",\n"));
        if comments_inline(d) && !e.display_name.is_empty() {
            s.push_str(&format!("\n) comment='{}';\n", escape_sql(&e.display_name)));
        } else {
            s.push_str("\n);\n");
        }
        if !comments_inline(d) {
            if !e.display_name.is_empty() {
                s.push_str(&comment_stmt(d, &e.table, None, &e.display_name));
            }
            for a in &cols {
                if !a.display_name.is_empty() {
                    s.push_str(&comment_stmt(d, &e.table, Some(&a.field), &a.display_name));
                }
            }
        }
        s.push('\n');
    }

    if p.options.with_foreign_keys {
        let mut seen: HashSet<String> = HashSet::new();
        for r in &doc.relations {
            if r.kind != "AggregationRelation" {
                continue;
            }
            // BMF 方向：source = 父（1），target = 子（n），srcAttributeid 是父实体上
            // 指向子表的 ARRAY 属性（targetConstraint=1..n 可佐证）。
            let parent = doc
                .entities
                .iter()
                .find(|e| e.id == r.source || e.name == r.source);
            let child = doc
                .entities
                .iter()
                .find(|e| e.id == r.target || e.name == r.target);
            let (Some(pt), Some(c)) = (parent, child) else { continue };
            let Some(pk) = pt.attrs.iter().find(|a| a.is_key) else {
                warnings.push(format!(
                    "聚合关系 {} → {} 找不到父表主键，外键未生成",
                    pt.name, c.name
                ));
                continue;
            };
            // 子表外键列：优先 targetAttributeid，其次按父主键同名/同列名找。
            let fk_attr = c
                .attrs
                .iter()
                .find(|a| !r.target_attr_id.is_empty() && a.id == r.target_attr_id)
                .or_else(|| {
                    c.attrs
                        .iter()
                        .find(|a| a.style != "ARRAY" && a.name == pk.name)
                })
                .or_else(|| {
                    c.attrs
                        .iter()
                        .find(|a| a.style != "ARRAY" && a.field == pk.field)
                });
            let Some(attr) = fk_attr else {
                warnings.push(format!(
                    "子表 {} 找不到指向 {} 的外键列，外键未生成",
                    c.name, pk.name
                ));
                continue;
            };
            if c.table.trim().is_empty() || pt.table.trim().is_empty() {
                continue;
            }
            let key = format!("{}.{}", c.table, attr.field);
            if !seen.insert(key) {
                continue;
            }
            let fk = format!("fk_{}_{}", short_name(&c.table), short_name(&attr.field));
            s.push_str(&format!(
                "alter table {} add constraint {} foreign key ({}) references {} ({});\n",
                c.table, fk, attr.field, pt.table, pk.field
            ));
            s.push_str(&format!(
                "create index idx_{}_{} on {} ({});\n",
                short_name(&c.table),
                short_name(&attr.field),
                c.table,
                attr.field
            ));
        }
        if !doc.relations.is_empty() {
            s.push('\n');
        }
    } else {
        for r in &doc.relations {
            if r.kind != "AggregationRelation" {
                continue;
            }
            let parent = doc
                .entities
                .iter()
                .find(|e| e.id == r.source || e.name == r.source);
            let child = doc
                .entities
                .iter()
                .find(|e| e.id == r.target || e.name == r.target);
            let (Some(pt), Some(c)) = (parent, child) else { continue };
            if let Some(pk) = pt.attrs.iter().find(|a| a.is_key) {
                s.push_str(&format!(
                    "-- 聚合关系：{}.{} → {}.{}（NC 默认不建外键约束；需要时打开「带外键」）\n",
                    pt.table, pk.field, c.table, pk.field
                ));
            }
        }
    }
    s
}

pub fn ddl_artifact(
    doc: &BmfDoc,
    p: &GenProfile,
    only: &[String],
    warnings: &mut Vec<String>,
) -> Artifact {
    let text = ddl(doc, p, only, warnings);
    let comp = if doc.component.name.is_empty() {
        "component"
    } else {
        doc.component.name.as_str()
    };
    let name = format!("{comp}.{}.sql", p.dialect.file_suffix());
    let mut a = Artifact::new(
        format!("db.ddl.{}", p.dialect.as_str()),
        Family::Db,
        "ddl",
        name.clone(),
        format!("db/{name}"),
        text,
    );
    a.encoding = "GBK".into();
    let mut refs: Vec<String> = doc.entities.iter().map(|e| e.id.clone()).collect();
    refs.extend(doc.relations.iter().map(|r| r.id.clone()));
    a.refs(refs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bmf_model::BmfDoc;
    use std::path::PathBuf;

    fn sample() -> BmfDoc {
        BmfDoc::from_bytes(
            PathBuf::from("sz02.bmf"),
            r#"<component name="sz02" displayName="任务接口配置" namespace="uapbd" mainEntity="e1"><celllist>
<entity id="e1" name="Sz02HVO" displayName="表头" fullClassName="nc.vo.uapbd.sz02.Sz02HVO" tableName="uapbd_sz02_h" isPrimary="true" keyAttributeId="a1">
<attributelist>
<attribute id="a1" name="pk_head" fieldName="pk_head" displayName="主键" typeName="UFID" dataTypeStyle="SINGLE" dbtype="char" length="20" isKey="true" isNullable="false"/>
<attribute id="a2" name="pk_body" fieldName="pk_head" typeName="Sz02BVO" dataTypeStyle="ARRAY"/>
<attribute id="a3" name="vbillcode" fieldName="vbillcode" displayName="单据号" typeName="String" dataTypeStyle="SINGLE" dbtype="varchar" length="40"/>
<attribute id="a5" name="mny" fieldName="mny" displayName="金额" typeName="UFDouble" dataTypeStyle="SINGLE" dbtype="decimal" length="28" precise="8"/>
</attributelist></entity>
<entity id="e2" name="Sz02BVO" displayName="表体" fullClassName="nc.vo.uapbd.sz02.Sz02BVO" tableName="uapbd_sz02_b" keyAttributeId="b1">
<attributelist><attribute id="b1" name="pk_body" fieldName="pk_body" typeName="UFID" dataTypeStyle="SINGLE" dbtype="char" length="20" isKey="true"/><attribute id="b2" name="pk_head" fieldName="pk_head" typeName="UFID" dataTypeStyle="SINGLE" dbtype="char" length="20"/></attributelist></entity>
</celllist><connectlist><AggregationRelation id="r1" source="e1" target="e2" srcAttributeid="a2"/></connectlist></component>"#
                .as_bytes()
                .to_vec(),
        )
        .unwrap()
    }

    #[test]
    fn eight_dialects_render_core_types() {
        let d = sample();
        let expected = [
            (SqlDialect::Oracle, "varchar2(40)", "number(28,8)"),
            (SqlDialect::Postgresql, "varchar(40)", "numeric(28,8)"),
            (SqlDialect::Sqlserver, "nvarchar(40)", "decimal(28,8)"),
            (SqlDialect::Db2, "varchar(40)", "decimal(28,8)"),
            (SqlDialect::Informix, "varchar(40)", "decimal(28,8)"),
            (SqlDialect::Oscar, "varchar(40)", "numeric(28,8)"),
            (SqlDialect::Sybase, "varchar(40)", "numeric(28,8)"),
            (SqlDialect::Gbase, "varchar(40)", "decimal(28,8)"),
        ];
        for (dia, text_ty, num_ty) in expected {
            let p = GenProfile {
                dialect: dia,
                ..GenProfile::default()
            };
            let mut w = Vec::new();
            let sql = ddl(&d, &p, &[], &mut w);
            assert!(sql.contains(text_ty), "{dia:?}: {sql}");
            assert!(sql.contains(num_ty), "{dia:?}: {sql}");
            assert!(sql.contains("create table uapbd_sz02_h"), "{dia:?}");
            assert!(sql.contains("primary key (pk_head)"), "{dia:?}");
            // 父表主键列 + 子表外键列 = 2；若 ARRAY 落成列会变 3。
            assert_eq!(sql.matches("pk_head char(20)").count(), 2, "ARRAY 不落列");
            assert!(w.is_empty(), "{dia:?}: {w:?}");
        }
    }

    #[test]
    fn foreign_keys_only_when_requested() {
        let d = sample();
        let mut p = GenProfile::default();
        let mut w = Vec::new();
        let sql = ddl(&d, &p, &[], &mut w);
        assert!(sql.contains("-- 聚合关系"));
        assert!(!sql.contains("foreign key"));

        p.options.with_foreign_keys = true;
        let mut w = Vec::new();
        let sql = ddl(&d, &p, &[], &mut w);
        assert!(
            sql.contains("foreign key (pk_head) references uapbd_sz02_h (pk_head)"),
            "{sql}"
        );
        assert!(sql.contains("create index idx_"));
        assert!(w.is_empty(), "{w:?}");
    }

    #[test]
    fn unknown_type_is_reported() {
        let d = BmfDoc::from_bytes(
            PathBuf::new(),
            br#"<component name="c" namespace="m" mainEntity="e"><celllist><entity id="e" name="H" tableName="t" fullClassName="nc.vo.m.c.H" isPrimary="true"><attributelist><attribute id="a" name="x" fieldName="x" typeName="Weird" dataTypeStyle="SINGLE"/></attributelist></entity></celllist></component>"#.to_vec(),
        )
        .unwrap();
        let mut w = Vec::new();
        let sql = ddl(&d, &GenProfile::default(), &[], &mut w);
        assert!(sql.contains("未识别类型"));
        assert!(!w.is_empty());
    }
}
