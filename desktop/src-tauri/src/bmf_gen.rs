//! 从 BMF 生成 **预览物**：Oracle DDL、VO 源码、注册清单。
//!
//! M1 只预览，不落盘、不执行。写文件是 M2 的事（`bmf_write` + 显式确认）。
//!
//! 三条不能省的纪律：
//! 1. **未知类型不猜**：映射表里没有的类型进 `warnings`，同时在 DDL 里标成
//!    `/* 未识别类型 */`，让人一眼看见，而不是悄悄生成 varchar(50)。
//! 2. **ARRAY 不落列**：它是聚合关系，落成列就多出一列、发布时对不上。
//! 3. **VO 与现有生成器同形**：字段按 BMF 顺序、`getXxx` 只大写首字母（`getPk_head`）、
//!    固定尾部 `getMetaData()`、GBK+CRLF。Sz02HVO 是实测样本。

use serde::Serialize;

use crate::bmf_model::{Attr, BmfDoc, Entity};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedFile {
    pub kind: String,
    pub name: String,
    pub path_hint: String,
    pub encoding: String,
    pub eol: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryItem {
    pub area: String,
    pub hint: String,
    pub existing: String,
    pub suggested: String,
    pub note: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Registry {
    pub items: Vec<RegistryItem>,
    pub upm: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Generation {
    pub ddl: String,
    pub files: Vec<GeneratedFile>,
    pub registry: Vec<RegistryItem>,
    pub upm: String,
    pub warnings: Vec<String>,
}

const KNOWN: [&str; 18] = [
    "String", "UFID", "Integer", "UFDouble", "UFBoolean", "UFDate", "UFDateTime",
    "UFLiteralDate", "UFTime", "UFMoney", "BigDecimal", "Multilangtext", "MEMO", "IMAGE",
    "BLOB", "CLOB", "CUSTOM", "user",
];

/// 生成整套预览。`only` 为空 = 所有实体。
pub fn generate(doc: &BmfDoc, only: &[String]) -> Generation {
    let mut g = Generation::default();
    let picked: Vec<&Entity> = doc
        .entities
        .iter()
        .filter(|e| only.is_empty() || only.iter().any(|id| id == &e.id || id == &e.name))
        .collect();
    g.ddl = ddl(doc, &picked, &mut g.warnings);
    for e in &picked {
        g.files.push(vo(doc, e, &mut g.warnings));
    }
    let r = registry(doc, &picked);
    g.registry = r.items;
    g.upm = r.upm;
    g
}

/// Oracle 建表脚本（预演，不执行）。
pub fn ddl(doc: &BmfDoc, entities: &[&Entity], warnings: &mut Vec<String>) -> String {
    let mut s = String::new();
    s.push_str("-- NCForge 生成：预演脚本，**未执行**\n");
    s.push_str(&format!(
        "-- 组件 {}（{}） 命名空间 {}\n",
        doc.component.display_name, doc.component.name, doc.component.namespace
    ));
    s.push_str("-- 对照 UAP Studio「生成建库 SQL」逐行 diff 后再决定是否执行\n\n");

    for e in entities {
        if e.table.is_empty() {
            warnings.push(format!("实体 {} 没有表名，跳过 DDL", e.name));
            continue;
        }
        let cols: Vec<&Attr> = e.attrs.iter().filter(|a| a.style != "ARRAY" && !a.field.is_empty()).collect();
        if cols.is_empty() {
            warnings.push(format!("实体 {} 没有可落库的列，跳过 DDL", e.name));
            continue;
        }
        s.push_str(&format!("-- {} / {}\n", e.display_name, e.name));
        s.push_str(&format!("create table {} (\n", e.table));
        let mut lines = Vec::new();
        for a in &cols {
            let ty = match oracle_type(a) {
                Ok(t) => t,
                Err(t) => {
                    warnings.push(format!("{}.{} 类型未识别（{} / {}），DDL 里标成 {}", e.table, a.name, a.type_name, a.data_type, t));
                    format!("{t} /* 未识别类型：{} */", a.type_name)
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
            lines.push(line);
        }
        let keys: Vec<&str> = e
            .attrs
            .iter()
            .filter(|a| a.is_key && a.style != "ARRAY" && !a.field.is_empty())
            .map(|a| a.field.as_str())
            .collect();
        if keys.is_empty() {
            warnings.push(format!("实体 {} 没有主键列，DDL 无法建主键约束", e.name));
        }
        for k in keys {
            lines.push(format!("  constraint pk_{} primary key ({})", short_name(&e.table), k));
        }
        s.push_str(&lines.join(",\n"));
        s.push_str("\n);\n");
        if !e.display_name.is_empty() {
            s.push_str(&format!(
                "comment on table {} is '{}';\n",
                e.table,
                escape_sql(&e.display_name)
            ));
        }
        for a in &cols {
            if !a.display_name.is_empty() {
                s.push_str(&format!(
                    "comment on column {}.{} is '{}';\n",
                    e.table,
                    a.field,
                    escape_sql(&a.display_name)
                ));
            }
        }
        s.push('\n');
    }

    // 聚合关系：NC 通常不在库里建外键约束（会挡住批量同步），所以给的是**提示**，
    // 不是可执行语句。真需要约束的人可以自己打开。
    for r in &doc.relations {
        if r.kind != "AggregationRelation" {
            continue;
        }
        let child = doc.entities.iter().find(|e| e.id == r.source || e.name == r.source);
        let parent = doc.entities.iter().find(|e| e.id == r.target || e.name == r.target);
        let (Some(c), Some(p)) = (child, parent) else { continue };
        let Some(attr) = c.attrs.iter().find(|a| a.id == r.src_attr_id) else { continue };
        if let Some(pk) = p.attrs.iter().find(|a| a.is_key) {
            s.push_str(&format!(
                "-- 聚合关系：{}.{} → {}.{}（NC 默认不建外键约束；需要时人工执行）\n",
                c.table, attr.field, p.table, pk.field
            ));
        }
    }
    s
}

/// 单实体 VO。路径按 `fullClassName` 推导到 `src/public/<包路径>/<类名>.java`。
pub fn vo(doc: &BmfDoc, e: &Entity, warnings: &mut Vec<String>) -> GeneratedFile {
    let (package, class) = split_class(&e.full_class, &doc.component.namespace);
    let mut imports = vec![
        "import nc.vo.pub.IVOMeta;".to_string(),
        "import nc.vo.pub.SuperVO;".to_string(),
    ];
    let mut body = String::new();
    let mut seen = std::collections::HashSet::new();
    let mut used_lang = Vec::new();
    let fields: Vec<&Attr> = e.attrs.iter().filter(|a| a.style != "ARRAY").collect();
    let has_ts = fields.iter().any(|a| a.name == "ts");

    for a in &fields {
        let (ty, lang) = java_type(doc, a);
        if !KNOWN.contains(&a.type_name.as_str())
            && !doc.enums.iter().any(|en| en.name == a.type_name)
            && a.style != "REF"
        {
            warnings.push(format!(
                "{}.{} 的类型 {} 不在映射表里，VO 暂按 {} 生成",
                e.name, a.name, a.type_name, ty
            ));
        }
        if let Some(l) = lang {
            if !seen.contains(l) {
                seen.insert(l);
                used_lang.push(l);
            }
        }
        let comment = if a.display_name.is_empty() {
            String::new()
        } else {
            format!("\t/** {} */\n", a.display_name.replace("*/", "* /"))
        };
        body.push_str(&format!("{comment}\tpublic {ty} {};\n", a.name));
    }
    if !has_ts {
        // UAP Studio 生成器会给所有 VO 补 ts（乐观锁时间戳），Sz02 也没有显式属性
        body.push_str("\t/** 时间戳 */\n\tpublic UFDateTime ts;\n");
        if !seen.contains("nc.vo.pub.lang.UFDateTime") {
            seen.insert("nc.vo.pub.lang.UFDateTime");
            used_lang.push("nc.vo.pub.lang.UFDateTime");
        }
    }

    let mut accessors = String::new();
    let mut all: Vec<(String, String)> = fields
        .iter()
        .map(|a| (a.name.clone(), java_type(doc, a).0))
        .collect();
    if !has_ts {
        all.push(("ts".into(), "UFDateTime".into()));
    }
    for (name, ty) in all {
        let cap = capitalize(&name);
        accessors.push_str(&format!(
            "\tpublic {ty} get{cap}() {{\n\t\treturn this.{name};\n\t}}\n\n\
             \tpublic void set{cap}({ty} {name}) {{\n\t\tthis.{name} = {name};\n\t}}\n\n"
        ));
    }

    for l in used_lang {
        imports.push(format!("import {l};"));
    }
    imports.push("import nc.vo.pubapp.pattern.model.meta.entity.vo.VOMetaFactory;".to_string());

    let mut text = String::new();
    text.push_str(&format!("package {package};\n\n"));
    text.push_str(&imports.join("\n"));
    text.push_str("\n\n");
    text.push_str(&format!(
        "/**\n * {}（{}）\n * 由 NCForge 从 BMF 生成；字段顺序与元数据一致\n */\npublic class {class} extends SuperVO {{\n\n",
        if e.display_name.is_empty() { &e.name } else { &e.display_name },
        e.table
    ));
    text.push_str(&body);
    text.push('\n');
    text.push_str(&accessors);
    text.push_str(&format!(
        "\t@Override\n\tpublic IVOMeta getMetaData() {{\n\t\treturn VOMetaFactory.getInstance().getVOMeta(\"{}.{class}\");\n\t}}\n}}\n",
        doc.component.namespace
    ));

    GeneratedFile {
        kind: "vo".into(),
        name: format!("{class}.java"),
        path_hint: format!("src/public/{}/{class}.java", package.replace('.', "/")),
        encoding: "GBK".into(),
        eol: "CRLF".into(),
        text,
    }
}

/// 注册清单：只列位置与建议，不自动改任何文件。
pub fn registry(doc: &BmfDoc, entities: &[&Entity]) -> Registry {
    let c = &doc.component;
    let mut items = Vec::new();
    let mut push = |area: &str, hint: &str, existing: String, suggested: String, note: &str| {
        items.push(RegistryItem {
            area: area.into(),
            hint: hint.into(),
            existing,
            suggested,
            note: note.into(),
        });
    };
    push(
        "组件声明（.upm）",
        &format!("META-INF/{}.upm", c.name),
        String::new(),
        format!(
            "<component remote=\"true\" singleton=\"true\" tx=\"CMT\">\n  <interface>nc.itf.{ns}.{name}.I{Name}Service</interface>\n  <implementation>nc.bs.{ns}.{name}.impl.{Name}ServiceImpl</implementation>\n</component>",
            ns = c.namespace,
            name = c.name,
            Name = pascal(&c.name)
        ),
        "只有存在服务接口时才需要；纯实体组件可以跳过。UPM 是服务装配，不是 BMF 注册。",
    );
    push(
        "系统类型",
        "功能注册节点 / 单据类型定义",
        c.name.clone(),
        format!("注册组件 {}（{}）到目标模块 {}", c.display_name, c.name, c.own_module),
        "六处注册里最容易被漏掉的一处；漏了菜单里看不到。",
    );
    push(
        "功能节点",
        "功能注册 XML / 菜单配置",
        String::new(),
        format!("新增功能：{} → 主实体 {}", c.display_name, entities.first().map(|e| e.name.as_str()).unwrap_or("")),
        "功能编码通常等于组件名；权限点与它绑定。",
    );
    push(
        "单据类型",
        "bd_billtype（发布后在库中）",
        String::new(),
        format!("为 {} 建单据类型（pk_billtypeid / pk_billtypecode）", c.name),
        "表头带 pk_billtypeid/ctrantypeid 的组件必须有对应单据类型，否则审批流走不通。",
    );
    push(
        "VO 对照",
        &format!("nc.vo.{}.{}", c.namespace, c.name),
        entities.first().map(|e| e.full_class.clone()).unwrap_or_default(),
        entities
            .iter()
            .map(|e| format!("{} → {}", e.name, e.full_class))
            .collect::<Vec<_>>()
            .join("\n"),
        "对照名必须与 fullClassName 完全一致；VOMetaFactory 的键是 namespace.类名。",
    );
    push(
        "动作 / 动作组",
        "MDP 动作注册（按钮与操作映射）",
        String::new(),
        format!("为 {} 注册保存/删除/审批动作", c.name),
        "M1 只给出清单；动作注册依赖界面模型，自动改容易把启动改坏。",
    );

    let upm = format!(
        "<?xml version='1.0' encoding='UTF-8'?>\n<!DOCTYPE module[<!ELEMENT module (public)>\n<!ATTLIST module name CDATA \"\">\n<!ELEMENT public (component+)>\n<!ELEMENT component (interface+,implementation+)>\n<!ATTLIST component singleton CDATA \"true\">\n<!ATTLIST component remote CDATA \"true\">\n<!ATTLIST component tx CDATA \"CMT\">\n<!ELEMENT interface ANY>\n<!ELEMENT implementation ANY>\n]>\n<module name=\"{ns}\">\n\t<public>\n\t\t<component remote=\"true\" singleton=\"true\" tx=\"CMT\">\n\t\t\t<interface>nc.itf.{ns}.{name}.I{Name}Service</interface>\n\t\t\t<implementation>nc.bs.{ns}.{name}.impl.{Name}ServiceImpl</implementation>\n\t\t</component>\n\t</public>\n</module>\n",
        ns = c.namespace,
        name = c.name,
        Name = pascal(&c.name)
    );
    Registry { items, upm }
}

// ─────────────────────────── 映射表 ───────────────────────────

/// Oracle 列类型。`Err` 表示未识别（调用方决定是否降级并报出来）。
pub fn oracle_type(a: &Attr) -> Result<String, String> {
    // 真实 BMF 里 dbtype 常为空串，列类型写在 fieldType（varchar/char/decimal…）。
    // 先读 dbtype、再读 fieldType，两者都空才按 typeName 推导；仍然不认识就报出来，不猜。
    let dt = if a.db_type.trim().is_empty() {
        a.field_type.to_lowercase()
    } else {
        a.db_type.to_lowercase()
    };
    let len = a.length;
    let prec = a.precision;
    let with_len = |base: &str, dflt: u32| match len {
        Some(l) if l > 0 => format!("{base}({l})"),
        _ => format!("{base}({dflt})"),
    };
    match dt.as_str() {
        "" => infer_oracle(a),
        "char" => Ok(with_len("char", 20)),
        "varchar" | "varchar2" | "nvarchar2" => Ok(with_len("varchar2", default_len(&a.type_name))),
        "decimal" | "number" | "numeric" => Ok(match (len, prec) {
            (Some(l), Some(p)) if l > 0 => format!("number({l},{p})"),
            (Some(l), _) if l > 0 => format!("number({l})"),
            _ => "number(28,8)".into(),
        }),
        "int" | "integer" | "smallint" => Ok("number(10)".into()),
        "date" => Ok("date".into()),
        "image" | "blob" | "long raw" => Ok("blob".into()),
        "clob" | "text" => Ok("clob".into()),
        other => Err(other.to_string()),
    }
}

fn infer_oracle(a: &Attr) -> Result<String, String> {
    let ty = a.type_name.as_str();
    Ok(match ty {
        "UFID" => "char(20)".into(),
        "String" | "CUSTOM" | "Multilangtext" | "MEMO" => {
            format!("varchar2({})", a.length.filter(|l| *l > 0).unwrap_or(default_len(ty)))
        }
        "Integer" => "number(10)".into(),
        "UFDouble" | "UFMoney" | "BigDecimal" => format!(
            "number({},{})",
            a.length.unwrap_or(28),
            a.precision.unwrap_or(8)
        ),
        "UFBoolean" => "char(1)".into(),
        "UFDate" | "UFDateTime" => "char(19)".into(),
        "UFLiteralDate" => "char(10)".into(),
        "UFTime" => "char(8)".into(),
        "IMAGE" | "BLOB" => "blob".into(),
        "CLOB" => "clob".into(),
        "user" => "varchar2(20)".into(),
        _ => return Err(ty.to_string()),
    })
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

/// Java 字段类型 + 需要的 import（None = java.lang 或基本类型）。
pub fn java_type(doc: &BmfDoc, a: &Attr) -> (String, Option<&'static str>) {
    if a.style == "REF" {
        return ("String".into(), None);
    }
    if doc.enums.iter().any(|e| e.name == a.type_name)
        || a.type_name == "enum"
        || a.type_name.ends_with("Enum")
    {
        return ("Integer".into(), None);
    }
    match a.type_name.as_str() {
        "UFID" | "String" | "CUSTOM" | "Multilangtext" | "MEMO" | "user" | "group" | "org"
        | "org_v" | "admin" => ("String".into(), None),
        "Integer" => ("Integer".into(), None),
        "UFDouble" => ("UFDouble".into(), Some("nc.vo.pub.lang.UFDouble")),
        "UFMoney" | "BigDecimal" => ("UFDouble".into(), Some("nc.vo.pub.lang.UFDouble")),
        "UFBoolean" => ("UFBoolean".into(), Some("nc.vo.pub.lang.UFBoolean")),
        "UFDate" => ("UFDate".into(), Some("nc.vo.pub.lang.UFDate")),
        "UFDateTime" => ("UFDateTime".into(), Some("nc.vo.pub.lang.UFDateTime")),
        "UFLiteralDate" => ("UFLiteralDate".into(), Some("nc.vo.pub.lang.UFLiteralDate")),
        "UFTime" => ("UFTime".into(), Some("nc.vo.pub.lang.UFTime")),
        "IMAGE" | "BLOB" => ("byte[]".into(), None),
        _ => ("String".into(), None),
    }
}

pub fn split_class(full: &str, namespace: &str) -> (String, String) {
    match full.rfind('.') {
        Some(i) => (full[..i].to_string(), full[i + 1..].to_string()),
        None if !full.is_empty() => (format!("nc.vo.{namespace}"), full.to_string()),
        None => (format!("nc.vo.{namespace}"), String::new()),
    }
}

/// `sz02` → `Sz02`；`my_bill` → `My_bill`（保留下划线风格，与 NC 生成器一致）。
pub fn pascal(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

fn capitalize(s: &str) -> String {
    pascal(s)
}

fn short_name(table: &str) -> String {
    let s: String = table.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
    if s.len() > 24 {
        s[s.len() - 24..].to_string()
    } else {
        s
    }
}

fn escape_sql(s: &str) -> String {
    s.replace('\'', "''").replace(['\r', '\n'], " ")
}

fn sql_literal(s: &str) -> String {
    // 数字/日期/字符串统一加引号会改变语义：'0' 与 0 在 Oracle 里可隐式转换，
    // 但 'sysdate' 不是函数。只有明显的数字原样输出，其余按字符串字面量。
    if s.parse::<f64>().is_ok() {
        s.to_string()
    } else {
        format!("'{}'", escape_sql(s))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bmf_model::BmfDoc;
    use std::path::PathBuf;

    fn sample() -> BmfDoc {
        BmfDoc::from_bytes(
            PathBuf::from("sz02.bmf"),
            r#"<component name="sz02" displayName="任务接口配置" namespace="uapbd" ownModule="uapbd" mainEntity="e1"><celllist>
<entity id="e1" name="Sz02HVO" displayName="表头" fullClassName="nc.vo.uapbd.sz02.Sz02HVO" tableName="uapbd_sz02_h" isPrimary="true" keyAttributeId="a1">
<attributelist>
<attribute id="a1" name="pk_head" fieldName="pk_head" displayName="主键" typeName="UFID" dataType="BS1" dataTypeStyle="SINGLE" dbtype="char" length="20" isKey="true" isNullable="false" sequence="0"/>
<attribute id="a2" name="pk_body" fieldName="pk_head" typeName="Sz02BVO" dataType="e2" dataTypeStyle="ARRAY" sequence="1"/>
<attribute id="a3" name="vbillcode" fieldName="vbillcode" displayName="单据号" typeName="String" dataType="BS2" dataTypeStyle="SINGLE" dbtype="varchar" length="40" isNullable="true" sequence="2"/>
<attribute id="a4" name="fstatusflag" fieldName="fstatusflag" typeName="BillstatusEnum" dataType="n1" dataTypeStyle="SINGLE" dbtype="int" isNullable="true" sequence="3"/>
<attribute id="a5" name="mny" fieldName="mny" typeName="UFDouble" dataType="BS3" dataTypeStyle="SINGLE" dbtype="decimal" length="28" precise="8" isNullable="true" sequence="4"/>
</attributelist></entity>
<entity id="e2" name="Sz02BVO" displayName="表体" fullClassName="nc.vo.uapbd.sz02.Sz02BVO" tableName="uapbd_sz02_b" keyAttributeId="b1">
<attributelist><attribute id="b1" name="pk_body" fieldName="pk_body" typeName="UFID" dataType="BS1" dataTypeStyle="SINGLE" dbtype="char" length="20" isKey="true" isNullable="false"/></attributelist></entity>
</celllist><connectlist><AggregationRelation id="r1" source="e1" target="e2" srcAttributeid="a2"/></connectlist></component>"#.as_bytes().to_vec(),
        )
        .unwrap()
    }

    #[test]
    fn ddl_has_pk_not_null_and_skips_array_column() {
        let d = sample();
        let mut w = Vec::new();
        let sql = ddl(&d, &d.entities.iter().collect::<Vec<_>>(), &mut w);
        assert!(sql.contains("create table uapbd_sz02_h"));
        assert!(sql.contains("pk_head char(20) not null"));
        assert!(
            sql.contains("constraint pk_uapbd_sz02_h primary key (pk_head)"),
            "{sql}"
        );
        assert_eq!(sql.matches("pk_head char(20)").count(), 1, "ARRAY 不能落成列");
        assert!(sql.contains("number(28,8)"));
        assert!(sql.contains("comment on table"));
        assert!(sql.contains("聚合关系"), "子表外键以提示形式出现");
        assert!(w.is_empty(), "{w:?}");
    }

    #[test]
    fn unknown_type_is_reported_not_silently_varchar() {
        let d = BmfDoc::from_bytes(
            PathBuf::new(),
            br#"<component name="c" namespace="m" mainEntity="e"><celllist><entity id="e" name="H" tableName="t" fullClassName="nc.vo.m.c.H" isPrimary="true"><attributelist><attribute id="a" name="x" fieldName="x" typeName="WeirdType" dataTypeStyle="SINGLE"/></attributelist></entity></celllist></component>"#.to_vec(),
        )
        .unwrap();
        let mut w = Vec::new();
        let sql = ddl(&d, &d.entities.iter().collect::<Vec<_>>(), &mut w);
        assert!(sql.contains("未识别类型"));
        assert!(!w.is_empty());
    }

    /// 真实 sz02.bmf 里 `dbtype=""`、类型只在 `fieldType` 上；不读它会把
    /// `pk_group` 这类引用列落成 `group`，脚本根本跑不起来。
    #[test]
    fn oracle_type_falls_back_to_field_type_when_dbtype_empty() {
        let mut a = Attr {
            type_name: "group".into(),
            field_type: "varchar".into(),
            length: Some(20),
            ..Attr::default()
        };
        assert_eq!(oracle_type(&a).as_deref(), Ok("varchar2(20)"));
        // dbtype 写着就优先它，fieldType 不覆盖
        a.db_type = "char".into();
        assert_eq!(oracle_type(&a).as_deref(), Ok("char(20)"));
    }

    #[test]
    fn vo_matches_existing_generator_shape() {
        let d = sample();
        let mut w = Vec::new();
        let f = vo(&d, &d.entities[0], &mut w);
        assert_eq!(f.encoding, "GBK");
        assert!(f.text.starts_with("package nc.vo.uapbd.sz02;"));
        assert!(f.text.contains("public class Sz02HVO extends SuperVO"));
        assert!(f.text.contains("public String pk_head;"));
        assert!(f.text.contains("public Integer fstatusflag;"), "枚举落 Integer");
        assert!(f.text.contains("public UFDouble mny;"));
        assert!(!f.text.contains("public Sz02BVO"), "ARRAY 不进 VO 字段");
        assert!(f.text.contains("public String getPk_head()"));
        assert!(f.text.contains("public void setPk_head(String pk_head)"));
        assert!(f.text.contains("getVOMeta(\"uapbd.Sz02HVO\")"));
        assert!(f.text.contains("public UFDateTime ts;"));
        assert!(f.text.contains("import nc.vo.pub.lang.UFDouble;"));
        assert!(f.text.contains("import nc.vo.pub.lang.UFDateTime;"));
        assert_eq!(f.eol, "CRLF");
        assert!(f.path_hint.ends_with("src/public/nc/vo/uapbd/sz02/Sz02HVO.java"));
    }

    #[test]
    fn registry_covers_six_places_and_never_claims_to_write() {
        let d = sample();
        let ents: Vec<&Entity> = d.entities.iter().collect();
        let r = registry(&d, &ents);
        assert_eq!(r.items.len(), 6);
        assert!(r.items.iter().any(|i| i.area.contains("VO")));
        assert!(r.upm.contains("<module name=\"uapbd\">"));
        assert!(r.items.iter().all(|i| !i.suggested.starts_with("apply")));
    }
}
