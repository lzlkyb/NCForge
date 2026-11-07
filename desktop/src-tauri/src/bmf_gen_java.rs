//! Java 产物渲染器（纯函数）。
//!
//! 形状依据（只读真实生成物，不复制模板/资产）：
//! - 传统样式 VO：public 字段 + 直返 getter（Sz02HVO 实测形状）。
//! - 标准样式 VO：`getAttributeValue/setAttributeValue` + 字段常量 + `getPKFieldName` /
//!   `getParentPKFieldName` / `getTableName` + `VOMetaFactory`（RtHeadVO 实测形状）。
//! - 传统样式单子表 AggVO：继承 `AggregatedValueObject`，typed 字段 + 四个 override
//!   （VendorMaterAggVO 实测形状）。
//! - 标准样式 AggVO：继承 `AbstractBill`，`@AggVoInfo` + `BillMetaFactory`
//!   （RtTemplateAggVO 实测形状）；多子表也用这条，因为 `AggregatedValueObject`
//!   的 `getChildrenVO()` 只表达一个数组。
//! - 枚举 VO：继承 `MDEnum`，常量由 `MDEnum.valueOf(Class, Integer)` 构造
//!   （BOMSourceEnum / EnableStatusEnum 实测形状）。
//!
//! BeanItf / OPItf / SelVO / 测试桩的官方产物形状未拿到可对照样本，这里按 NC 常规
//! 契约生成，并在产物注释里标明「NCForge 约定」，不冒充逐行一致。

use std::collections::HashSet;

use crate::bmf_gen::pascal;
use crate::bmf_gen_types::{Artifact, CodeStyle, Family, GenProfile};
use crate::bmf_model::{Attr, BmfDoc, Entity, EnumDef};

/// 与 `bmf_gen::split_class` 同义，但这里不依赖它的降级规则。
fn split_full(full: &str) -> (Option<String>, Option<String>) {
    match full.rsplit_once('.') {
        Some((p, c)) => (Some(p.to_string()), Some(c.to_string())),
        None if !full.is_empty() => (None, Some(full.to_string())),
        None => (None, None),
    }
}

pub fn class_of(e: &Entity) -> String {
    if let (_, Some(c)) = split_full(&e.full_class) {
        if !c.is_empty() {
            return c;
        }
    }
    if !e.name.is_empty() {
        return pascal(&e.name);
    }
    "UnnamedVO".into()
}

fn package_of(doc: &BmfDoc, e: &Entity, p: &GenProfile) -> String {
    if !p.base_package.trim().is_empty() {
        let base = p.base_package.trim().trim_end_matches('.');
        if doc.component.name.is_empty() {
            return base.to_string();
        }
        return format!("{base}.{}", doc.component.name);
    }
    if let (Some(pkg), _) = split_full(&e.full_class) {
        if !pkg.is_empty() {
            return pkg;
        }
    }
    if doc.component.namespace.is_empty() {
        "nc.vo".into()
    } else {
        format!("nc.vo.{}", doc.component.namespace)
    }
}

fn path_hint(root: &str, package: &str, class: &str) -> String {
    let dir = package.replace('.', "/");
    format!("{}/{dir}/{class}.java", root.trim_end_matches('/'))
}

fn indent(style: CodeStyle) -> &'static str {
    if style == CodeStyle::Traditional {
        "\t"
    } else {
        "    "
    }
}

fn is_enum_ref(doc: &BmfDoc, a: &Attr) -> bool {
    doc.enums.iter().any(|e| e.name == a.type_name)
        || doc.enums.iter().any(|e| e.name == a.ref_target)
        || a.type_name == "enum"
        || a.type_name.ends_with("Enum")
}

/// Java 字段类型 + import。`REF` 一律 String（存的是 pk），枚举落 Integer。
pub fn java_type(doc: &BmfDoc, p: &GenProfile, a: &Attr) -> (String, Option<&'static str>) {
    if a.style == "REF" {
        return ("String".into(), None);
    }
    if is_enum_ref(doc, a) {
        return ("Integer".into(), None);
    }
    match a.type_name.as_str() {
        "UFID" | "String" | "CUSTOM" | "Multilangtext" | "MEMO" | "user" | "group" | "org"
        | "org_v" | "admin" => ("String".into(), None),
        "Integer" => ("Integer".into(), None),
        "UFDouble" | "UFMoney" | "BigDecimal" => {
            ("UFDouble".into(), Some("nc.vo.pub.lang.UFDouble"))
        }
        "UFBoolean" => {
            if p.options.uf_boolean_to_boolean && p.style != CodeStyle::Traditional {
                ("Boolean".into(), None)
            } else {
                ("UFBoolean".into(), Some("nc.vo.pub.lang.UFBoolean"))
            }
        }
        "UFDate" => ("UFDate".into(), Some("nc.vo.pub.lang.UFDate")),
        "UFDateTime" => ("UFDateTime".into(), Some("nc.vo.pub.lang.UFDateTime")),
        "UFLiteralDate" => ("UFLiteralDate".into(), Some("nc.vo.pub.lang.UFLiteralDate")),
        "UFTime" => ("UFTime".into(), Some("nc.vo.pub.lang.UFTime")),
        "IMAGE" | "BLOB" => ("byte[]".into(), None),
        _ => ("String".into(), None),
    }
}

/// Java 标识符清洗：BMF 属性名/表名可能带点、空格、中划线。
pub fn ident(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for (i, c) in s.chars().enumerate() {
        let ok = c.is_ascii_alphanumeric() || c == '_' || c == '$';
        if ok && !(i == 0 && c.is_ascii_digit()) {
            out.push(c);
        } else if c.is_ascii_alphanumeric() {
            out.push('_');
            out.push(c);
        } else {
            // 非法字符一律压成下划线（含首字符数字/符号）。
            out.push('_');
        }
    }
    if out.is_empty() {
        "field".into()
    } else {
        out
    }
}

fn constant_name(field: &str) -> String {
    ident(field).to_ascii_uppercase()
}

fn scalar_attrs(e: &Entity) -> impl Iterator<Item = &Attr> {
    e.attrs
        .iter()
        .filter(|a| a.style != "ARRAY" && !a.name.trim().is_empty())
}

fn key_attr(e: &Entity) -> Option<&Attr> {
    e.attrs
        .iter()
        .find(|a| a.id == e.key_attr_id && a.style != "ARRAY")
        .or_else(|| e.attrs.iter().find(|a| a.is_key && a.style != "ARRAY"))
}

/// 主子关系：relation.source = 父实体，relation.target = 子实体。
pub fn children_of<'a>(doc: &'a BmfDoc, parent: &Entity) -> Vec<&'a Entity> {
    doc.relations
        .iter()
        .filter(|r| r.kind == "AggregationRelation")
        .filter(|r| r.source == parent.id || r.source == parent.name)
        .filter_map(|r| {
            doc.entities
                .iter()
                .find(|e| e.id == r.target || e.name == r.target)
        })
        .collect()
}

fn parent_of<'a>(doc: &'a BmfDoc, child: &Entity) -> Option<&'a Entity> {
    doc.relations
        .iter()
        .filter(|r| r.kind == "AggregationRelation")
        .filter(|r| r.target == child.id || r.target == child.name)
        .find_map(|r| {
            doc.entities
                .iter()
                .find(|e| e.id == r.source || e.name == r.source)
        })
}

fn push_import(imports: &mut Vec<String>, seen: &mut HashSet<String>, ty: &str) {
    if seen.insert(ty.to_string()) {
        imports.push(format!("import {ty};"));
    }
}

/// 元数据键：标准/自定义样式取 `namespace.表名`（RtHeadVO 实测），传统样式取
/// `namespace.类名`（Sz02HVO 实测）。
fn meta_key_for(doc: &BmfDoc, p: &GenProfile, e: &Entity, class: &str) -> String {
    let ns = doc.component.namespace.as_str();
    if p.style != CodeStyle::Traditional && !e.table.is_empty() {
        format!("{ns}.{}", e.table)
    } else {
        format!("{ns}.{class}")
    }
}

/// 单实体 VO。返回产物 id 由调用方决定（这里只出文本/路径）。
pub fn entity_vo(doc: &BmfDoc, p: &GenProfile, e: &Entity) -> String {
    let class = class_of(e);
    let package = package_of(doc, e, p);
    if p.style == CodeStyle::Traditional {
        traditional_vo(doc, p, e, &package, &class)
    } else {
        standard_vo(doc, p, e, &package, &class)
    }
}

fn vo_imports_and_fields(
    doc: &BmfDoc,
    p: &GenProfile,
    e: &Entity,
    imports: &mut Vec<String>,
    seen: &mut HashSet<String>,
    constants: bool,
    ind: &str,
) -> (String, Vec<(String, String, String)>, bool) {
    let mut body = String::new();
    let mut accessors = Vec::new();
    let mut has_ts = false;
    for a in scalar_attrs(e) {
        let name = ident(&a.name);
        if name == "ts" {
            has_ts = true;
        }
        let (ty, lang) = java_type(doc, p, a);
        if let Some(l) = lang {
            push_import(imports, seen, l);
        }
        let comment = if a.display_name.is_empty() {
            String::new()
        } else {
            format!("{ind}/** {} */\n", a.display_name.replace("*/", "* /"))
        };
        if constants {
            let field = if a.field.trim().is_empty() {
                &name
            } else {
                &a.field
            };
            body.push_str(&format!(
                "{ind}public static final String {} = \"{}\";\n\n",
                constant_name(field),
                field.replace('"', "\\\"")
            ));
        }
        body.push_str(&comment);
        body.push_str(&format!("{ind}public {ty} {name};\n"));
        accessors.push((name, a.name.clone(), ty));
    }
    (body, accessors, has_ts)
}

fn traditional_vo(doc: &BmfDoc, p: &GenProfile, e: &Entity, package: &str, class: &str) -> String {
    let mut imports = vec![
        "import nc.vo.pub.IVOMeta;".to_string(),
        "import nc.vo.pub.SuperVO;".to_string(),
    ];
    let mut seen: HashSet<String> = HashSet::new();
    let (mut body, mut accessors, has_ts) =
        vo_imports_and_fields(doc, p, e, &mut imports, &mut seen, false, "\t");
    if !has_ts {
        body.push_str("\t/** 时间戳 */\n\tpublic UFDateTime ts;\n");
        if seen.insert("nc.vo.pub.lang.UFDateTime".into()) {
            imports.push("import nc.vo.pub.lang.UFDateTime;".into());
        }
        accessors.push(("ts".into(), "ts".into(), "UFDateTime".into()));
    }
    let mut accessor_text = String::new();
    for (name, _, ty) in &accessors {
        let cap = pascal(name);
        accessor_text.push_str(&format!(
            "\tpublic {ty} get{cap}() {{\n\t\treturn this.{name};\n\t}}\n\n\
             \tpublic void set{cap}({ty} {name}) {{\n\t\tthis.{name} = {name};\n\t}}\n\n"
        ));
    }
    imports.push("import nc.vo.pubapp.pattern.model.meta.entity.vo.VOMetaFactory;".into());
    let meta = meta_key_for(doc, p, e, class);

    let display = if e.display_name.is_empty() {
        &e.name
    } else {
        &e.display_name
    };
    let mut text = String::new();
    text.push_str(&format!("package {package};\n\n"));
    text.push_str(&imports.join("\n"));
    text.push_str("\n\n");
    text.push_str(&format!(
        "/**\n * {display}（{table}）\n * 由 NCForge 从 BMF 生成；字段顺序与元数据一致\n */\n\
         public class {class} extends SuperVO {{\n\n",
        table = e.table
    ));
    text.push_str(&body);
    text.push('\n');
    text.push_str(&accessor_text);
    text.push_str(&format!(
        "\t@Override\n\tpublic IVOMeta getMetaData() {{\n\t\treturn VOMetaFactory.getInstance().getVOMeta(\"{meta}\");\n\t}}\n}}\n"
    ));
    text
}

fn standard_vo(doc: &BmfDoc, p: &GenProfile, e: &Entity, package: &str, class: &str) -> String {
    let mut imports = vec![
        "import nc.vo.pub.IVOMeta;".to_string(),
        "import nc.vo.pub.SuperVO;".to_string(),
    ];
    let mut seen: HashSet<String> = HashSet::new();
    let (mut body, mut accessors, has_ts) =
        vo_imports_and_fields(doc, p, e, &mut imports, &mut seen, true, "    ");
    if !has_ts {
        body.push_str("    public static final String TS = \"ts\";\n\n");
        body.push_str("    /** 时间戳 */\n    public UFDateTime ts;\n");
        if seen.insert("nc.vo.pub.lang.UFDateTime".into()) {
            imports.push("import nc.vo.pub.lang.UFDateTime;".into());
        }
        accessors.push(("ts".into(), "ts".into(), "UFDateTime".into()));
    }
    imports.push("import nc.vo.pubapp.pattern.model.meta.entity.vo.VOMetaFactory;".into());
    let meta = meta_key_for(doc, p, e, class);

    let key = key_attr(e)
        .map(|a| {
            if a.field.trim().is_empty() {
                ident(&a.name)
            } else {
                ident(&a.field)
            }
        })
        .unwrap_or_default();
    let parent_pk = parent_of(doc, e).and_then(key_attr).map(|a| {
        if a.field.trim().is_empty() {
            ident(&a.name)
        } else {
            ident(&a.field)
        }
    });

    let mut accessor_text = String::new();
    for (name, _, ty) in &accessors {
        let cap = pascal(name);
        let cast = if ty == "byte[]" {
            "(byte[])".to_string()
        } else {
            format!("({ty})")
        };
        accessor_text.push_str(&format!(
            "    public {ty} get{cap}() {{\n        return {cast} this.getAttributeValue(\"{name}\");\n    }}\n\n\
             \tpublic void set{cap}({ty} new{cap}) {{\n        this.setAttributeValue(\"{name}\", new{cap});\n    }}\n\n"
        ));
    }
    // 上一段里 set 用了 tab，统一成 4 空格，避免同一个文件混排。
    accessor_text = accessor_text.replace('\t', "    ");

    let display = if e.display_name.is_empty() {
        &e.name
    } else {
        &e.display_name
    };
    let mut text = String::new();
    text.push_str(&format!("package {package};\n\n"));
    text.push_str(&imports.join("\n"));
    text.push_str("\n\n");
    text.push_str(&format!(
        "/**\n * {display}（{table}）\n * 由 NCForge 从 BMF 生成；标准/自定义样式走属性访问器\n */\n\
         @SuppressWarnings(\"serial\")\npublic class {class} extends SuperVO {{\n\n\
         \tprivate static final long serialVersionUID = 1L;\n\n",
        table = e.table
    ));
    text.push_str(&body);
    text.push('\n');
    text.push_str(&format!(
        "    public {class}() {{\n        super();\n    }}\n\n"
    ));
    text.push_str(&accessor_text);
    text.push_str(&format!(
        "    @Override\n    public String getPKFieldName() {{\n        return {key};\n    }}\n\n\
         \t@Override\n    public String getParentPKFieldName() {{\n        return {parent};\n    }}\n\n\
         \t@Override\n    public String getTableName() {{\n        return \"{table}\";\n    }}\n\n\
         \t@Override\n    public IVOMeta getMetaData() {{\n        return VOMetaFactory.getInstance().getVOMeta(\"{meta}\");\n    }}\n}}\n",
        key = if key.is_empty() { "null".to_string() } else { format!("\"{key}\"") },
        parent = parent_pk
            .map(|s| format!("\"{s}\""))
            .unwrap_or_else(|| "null".into()),
        table = e.table,
    ));
    text.replace('\t', "    ")
}

/// 聚合 VO。`main` 是主实体，`children` 是子实体（可为空，为空则不生成）。
pub fn agg_vo(doc: &BmfDoc, p: &GenProfile, main: &Entity, children: &[&Entity]) -> Option<String> {
    if children.is_empty() {
        return None;
    }
    let package = package_of(doc, main, p);
    let main_class = class_of(main);
    let agg_class = format!("{}AggVO", pascal(&doc.component.name));
    let ind = indent(p.style);
    let mut text = String::new();
    text.push_str(&format!("package {package};\n\n"));

    if p.style == CodeStyle::Traditional && children.len() == 1 {
        let child = children[0];
        let child_class = class_of(child);
        let head_field = "headvo";
        let body_field = "bodyvos";
        let imports = [
            "import nc.vo.pub.AggregatedValueObject;",
            "import nc.vo.pub.CircularlyAccessibleValueObject;",
        ];
        text.push_str(&imports.join("\n"));
        text.push_str("\n\n");
        text.push_str(&format!(
            "/**\n * {display} 主子表聚合 VO（NC传统样式）\n * 由 NCForge 从 BMF 生成\n */\n\
             @SuppressWarnings(\"serial\")\npublic class {agg_class} extends AggregatedValueObject {{\n\n\
             {ind}private static final long serialVersionUID = 1L;\n\n\
             {ind}private {main_class} {head_field};\n\n\
             {ind}private {child_class}[] {body_field};\n\n\
             {ind}@Override\n{ind}public CircularlyAccessibleValueObject getParentVO() {{\n\
             {ind}{ind}return this.{head_field};\n{ind}}}\n\n\
             {ind}@Override\n{ind}public void setParentVO(CircularlyAccessibleValueObject parent) {{\n\
             {ind}{ind}this.{head_field} = ({main_class}) parent;\n{ind}}}\n\n\
             {ind}@Override\n{ind}public CircularlyAccessibleValueObject[] getChildrenVO() {{\n\
             {ind}{ind}return this.{body_field};\n{ind}}}\n\n\
             {ind}@Override\n{ind}public void setChildrenVO(CircularlyAccessibleValueObject[] children) {{\n\
             {ind}{ind}this.{body_field} = ({child_class}[]) children;\n{ind}}}\n\n\
             {ind}public {main_class} getHeadVO() {{\n{ind}{ind}return this.{head_field};\n{ind}}}\n\n\
             {ind}public {child_class}[] getBodyVO() {{\n{ind}{ind}return this.{body_field};\n{ind}}}\n}}\n",
            display = if doc.component.display_name.is_empty() {
                doc.component.name.clone()
            } else {
                doc.component.display_name.clone()
            }
        ));
        return Some(text);
    }

    // 标准/自定义样式，以及传统样式的多子表：AbstractBill 才能表达多组 children。
    let main_meta = meta_key_for(doc, p, main, &main_class);
    let main_pkg = package_of(doc, main, p);
    text.push_str("import nc.vo.pubapp.pattern.model.entity.bill.AbstractBill;\n");
    text.push_str("import nc.vo.pubapp.pattern.model.meta.entity.bill.BillMetaFactory;\n");
    text.push_str("import nc.vo.pubapp.pattern.model.meta.entity.bill.IBillMeta;\n\n");
    text.push_str(&format!(
        "@SuppressWarnings(\"serial\")\n@nc.vo.annotation.AggVoInfo(parentVO = \"{main_pkg}.{main_class}\")\n\
         public class {agg_class} extends AbstractBill {{\n\n\
         {ind}private static final long serialVersionUID = 1L;\n\n\
         {ind}@Override\n{ind}public IBillMeta getMetaData() {{\n\
         {ind}{ind}return BillMetaFactory.getInstance().getBillMeta(\"{main_meta}\");\n{ind}}}\n\n\
         {ind}public {main_class} getHeadVO() {{\n{ind}{ind}return ({main_class}) this.getParent();\n{ind}}}\n\n"
    ));
    for c in children {
        let cls = class_of(c);
        let getter = format!("get{}VO", pascal(c.name.trim_end_matches("VO")));
        text.push_str(&format!(
            "{ind}public {cls}[] {getter}() {{\n{ind}{ind}return ({cls}[]) this.getChildren({cls}.class);\n{ind}}}\n\n"
        ));
    }
    text.push_str("}\n");
    Some(text)
}

/// 枚举 VO。包与主实体同包下的 `enumeration` 子包。
pub fn enum_vo(doc: &BmfDoc, p: &GenProfile, en: &EnumDef) -> String {
    let (package, class) = if let (Some(pkg), Some(cls)) = split_full(&en.full_class) {
        (pkg, cls)
    } else {
        let base = if !p.base_package.trim().is_empty() {
            let b = p.base_package.trim().trim_end_matches('.');
            if doc.component.name.is_empty() {
                b.to_string()
            } else {
                format!("{b}.{}", doc.component.name)
            }
        } else if doc.component.namespace.is_empty() {
            "nc.vo".to_string()
        } else {
            format!("nc.vo.{}", doc.component.namespace)
        };
        let mut cls = pascal(&en.name);
        if cls.is_empty() {
            cls = "UnnamedEnumVO".into();
        }
        if !cls.ends_with("EnumVO") {
            if cls.ends_with("Enum") {
                cls.push_str("VO");
            } else {
                cls.push_str("EnumVO");
            }
        }
        (format!("{base}.enumeration"), cls)
    };
    let mut text = String::new();
    text.push_str(&format!("package {package};\n\n"));
    text.push_str("import nc.md.model.IEnumValue;\nimport nc.md.model.impl.MDEnum;\n\n");
    text.push_str(&format!(
        "/**\n * {display}\n * 由 NCForge 从 BMF 枚举生成\n */\n\
         @SuppressWarnings(\"serial\")\npublic class {class} extends MDEnum {{\n\n\
         \tprivate static final long serialVersionUID = 1L;\n\n\
         \tpublic {class}(IEnumValue enumvalue) {{\n\t\tsuper(enumvalue);\n\t}}\n\n",
        display = if en.display_name.is_empty() {
            &en.name
        } else {
            &en.display_name
        }
    ));
    let mut used: HashSet<String> = HashSet::new();
    for item in &en.items {
        if item.hidden {
            continue;
        }
        let mut name = constant_name(&item.display);
        if name.chars().all(|c| c == '_')
            || !item
                .display
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == ' ')
        {
            name = format!("VALUE_{}", item.value);
        }
        if !used.insert(name.clone()) {
            name = format!("{name}_{}", item.value);
            used.insert(name.clone());
        }
        let value = if item.value.trim().parse::<i64>().is_ok() {
            format!("Integer.valueOf({})", item.value.trim())
        } else {
            format!("\"{}\"", item.value.replace('"', "\\\""))
        };
        let comment = if item.display.is_empty() {
            String::new()
        } else {
            format!("\t/** {} */\n", item.display.replace("*/", "* /"))
        };
        text.push_str(&format!(
            "{comment}\tpublic static final {class} {name} = MDEnum.valueOf({class}.class, {value});\n\n"
        ));
    }
    text.push_str("}\n");
    text
}

/// 业务接口：按实体出 CRUD 契约。官方 BeanItf 的逐行形状未取证，这里标注为 NCForge 约定。
pub fn bean_itf(doc: &BmfDoc, p: &GenProfile, e: &Entity) -> String {
    let class = class_of(e);
    let package = package_of(doc, e, p);
    let itf = format!("I{class}BeanItf");
    let mut text = String::new();
    text.push_str(&format!("package {package};\n\n"));
    text.push_str("import nc.vo.pub.BusinessException;\n\n");
    text.push_str(&format!(
        "/**\n * {display} 业务接口（NCForge 约定形状）\n */\npublic interface {itf} {{\n\n\
         \tvoid insert({class} vo) throws BusinessException;\n\n\
         \tvoid update({class} vo) throws BusinessException;\n\n\
         \tvoid delete({class} vo) throws BusinessException;\n}}\n",
        display = if e.display_name.is_empty() {
            &e.name
        } else {
            &e.display_name
        }
    ));
    text
}

/// 操作接口：组件级保存/删除，主子表时入参用 AggVO。
pub fn op_itf(doc: &BmfDoc, p: &GenProfile, main: &Entity, agg_class: Option<&str>) -> String {
    let package = package_of(doc, main, p);
    let itf = format!("I{}OPItf", pascal(&doc.component.name));
    let class = class_of(main);
    let param = agg_class.unwrap_or(class.as_str()).to_string();
    let mut text = String::new();
    text.push_str(&format!("package {package};\n\n"));
    text.push_str("import nc.vo.pub.BusinessException;\n\n");
    text.push_str(&format!(
        "/**\n * {display} 操作接口（NCForge 约定形状）\n */\npublic interface {itf} {{\n\n\
         \tvoid save({param} vo) throws BusinessException;\n\n\
         \tvoid delete(String pk) throws BusinessException;\n}}\n",
        display = if doc.component.display_name.is_empty() {
            doc.component.name.clone()
        } else {
            doc.component.display_name.clone()
        }
    ));
    text
}

/// 查询 VO：把所有实体的标量字段摊平，重名字段保留先出现的那个。
pub fn sel_vo(
    doc: &BmfDoc,
    p: &GenProfile,
    main: &Entity,
    entities: &[&Entity],
    warnings: &mut Vec<String>,
) -> String {
    let package = format!("{}.sel", package_of(doc, main, p));
    let class = format!("{}SelVO", pascal(&doc.component.name));
    let mut used: HashSet<String> = HashSet::new();
    let mut fields = String::new();
    let mut accessors = String::new();
    let mut imports = vec![
        "import nc.vo.pub.IVOMeta;".to_string(),
        "import nc.vo.pub.SuperVO;".to_string(),
    ];
    let mut import_seen: HashSet<String> = HashSet::new();
    for e in entities {
        for a in scalar_attrs(e) {
            let name = ident(&a.name);
            if name == "ts" {
                continue;
            }
            if !used.insert(name.clone()) {
                warnings.push(format!(
                    "SelVO 字段 {} 在多个实体中重名，保留第一个（{}）",
                    name, e.name
                ));
                continue;
            }
            let (ty, lang) = java_type(doc, p, a);
            if let Some(l) = lang {
                if import_seen.insert(l.to_string()) {
                    imports.push(format!("import {l};"));
                }
            }
            fields.push_str(&format!(
                "\t/** {} */\n\tpublic {ty} {name};\n",
                if a.display_name.is_empty() {
                    &a.name
                } else {
                    &a.display_name
                }
            ));
            let cap = pascal(&name);
            accessors.push_str(&format!(
                "\tpublic {ty} get{cap}() {{\n\t\treturn this.{name};\n\t}}\n\n\
                 \tpublic void set{cap}({ty} {name}) {{\n\t\tthis.{name} = {name};\n\t}}\n\n"
            ));
        }
    }
    imports.push("import nc.vo.pubapp.pattern.model.meta.entity.vo.VOMetaFactory;".into());
    let mut text = String::new();
    text.push_str(&format!("package {package};\n\n"));
    text.push_str(&imports.join("\n"));
    text.push_str("\n\n");
    text.push_str(&format!(
        "/**\n * {display} 查询/选择 VO（NCForge 约定形状）\n * 字段来自组件内所有实体的标量属性\n */\n\
         public class {class} extends SuperVO {{\n\n",
        display = if doc.component.display_name.is_empty() {
            doc.component.name.clone()
        } else {
            doc.component.display_name.clone()
        }
    ));
    text.push_str(&fields);
    text.push('\n');
    text.push_str(&accessors);
    text.push_str(&format!(
        "\t@Override\n\tpublic IVOMeta getMetaData() {{\n\t\treturn VOMetaFactory.getInstance().getVOMeta(\"{}.{class}\");\n\t}}\n}}\n",
        doc.component.namespace
    ));
    text
}

/// JUnit4 测试桩：验证类可实例化、主键字段常量拼写（标准样式）。
pub fn test_stub(doc: &BmfDoc, p: &GenProfile, e: &Entity) -> String {
    let class = class_of(e);
    let package = package_of(doc, e, p);
    let key = key_attr(e).map(|a| {
        if a.field.trim().is_empty() {
            ident(&a.name)
        } else {
            ident(&a.field)
        }
    });
    let mut text = String::new();
    text.push_str(&format!("package {package};\n\n"));
    text.push_str("import org.junit.Assert;\nimport org.junit.Test;\n\n");
    text.push_str(&format!(
        "/**\n * {class} 结构冒烟测试\n * 由 NCForge 从 BMF 生成\n */\npublic class {class}Test {{\n\n\
         \t@Test\n\tpublic void shouldInstantiate() {{\n\t\tAssert.assertNotNull(new {class}());\n\t}}\n\n"
    ));
    if let Some(k) = key {
        if p.style != CodeStyle::Traditional {
            text.push_str(&format!(
                "\t@Test\n\tpublic void shouldExposeKeyField() {{\n\t\tAssert.assertEquals(\"{k}\", {class}.{});\n\t}}\n\n",
                constant_name(&k)
            ));
        }
    }
    text.push_str("}\n");
    text
}

/// 产物包装：统一 id/路径/来源。
pub fn vo_artifact(doc: &BmfDoc, p: &GenProfile, e: &Entity) -> Artifact {
    let class = class_of(e);
    let package = package_of(doc, e, p);
    let text = entity_vo(doc, p, e);
    let id = format!("java.vo.{}", e.id);
    let mut refs = vec![e.id.clone()];
    refs.extend(e.attrs.iter().map(|a| a.id.clone()));
    Artifact::new(
        id,
        Family::Java,
        "vo",
        format!("{class}.java"),
        path_hint(&p.public_src_root, &package, &class),
        text,
    )
    .refs(refs)
}

pub fn enum_artifact(doc: &BmfDoc, p: &GenProfile, en: &EnumDef) -> Artifact {
    let text = enum_vo(doc, p, en);
    let (package, class) = {
        // enum_vo 里已经算过一次，这里按同样规则取包/类用于路径。
        let full = en.full_class.as_str();
        if let (Some(pkg), Some(cls)) = split_full(full) {
            (pkg, cls)
        } else {
            let mut cls = pascal(&en.name);
            if cls.is_empty() {
                cls = "UnnamedEnumVO".into();
            }
            if !cls.ends_with("EnumVO") {
                if cls.ends_with("Enum") {
                    cls.push_str("VO");
                } else {
                    cls.push_str("EnumVO");
                }
            }
            let base = if !p.base_package.trim().is_empty() {
                let b = p.base_package.trim().trim_end_matches('.');
                if doc.component.name.is_empty() {
                    b.to_string()
                } else {
                    format!("{b}.{}", doc.component.name)
                }
            } else if doc.component.namespace.is_empty() {
                "nc.vo".to_string()
            } else {
                format!("nc.vo.{}", doc.component.namespace)
            };
            (format!("{base}.enumeration"), cls)
        }
    };
    Artifact::new(
        format!("java.enum.{}", en.id),
        Family::Java,
        "enum",
        format!("{class}.java"),
        path_hint(&p.public_src_root, &package, &class),
        text,
    )
    .refs([en.id.clone()])
}

pub fn agg_artifact(
    doc: &BmfDoc,
    p: &GenProfile,
    main: &Entity,
    children: &[&Entity],
) -> Option<Artifact> {
    let text = agg_vo(doc, p, main, children)?;
    let package = package_of(doc, main, p);
    let class = format!("{}AggVO", pascal(&doc.component.name));
    let mut refs = vec![main.id.clone()];
    refs.extend(children.iter().map(|c| c.id.clone()));
    Some(
        Artifact::new(
            format!("java.agg.{}", main.id),
            Family::Java,
            "aggvo",
            format!("{class}.java"),
            path_hint(&p.public_src_root, &package, &class),
            text,
        )
        .refs(refs)
        .after(
            std::iter::once(format!("java.vo.{}", main.id))
                .chain(children.iter().map(|c| format!("java.vo.{}", c.id))),
        ),
    )
}

pub fn sel_artifact(
    doc: &BmfDoc,
    p: &GenProfile,
    main: &Entity,
    entities: &[&Entity],
    warnings: &mut Vec<String>,
) -> Artifact {
    let text = sel_vo(doc, p, main, entities, warnings);
    let package = format!("{}.sel", package_of(doc, main, p));
    let class = format!("{}SelVO", pascal(&doc.component.name));
    let mut refs: Vec<String> = Vec::new();
    for e in entities {
        refs.push(e.id.clone());
        refs.extend(e.attrs.iter().map(|a| a.id.clone()));
    }
    Artifact::new(
        "java.sel".to_string(),
        Family::Java,
        "selvo",
        format!("{class}.java"),
        path_hint(&p.public_src_root, &package, &class),
        text,
    )
    .refs(refs)
}

pub fn itf_artifacts(
    doc: &BmfDoc,
    p: &GenProfile,
    entities: &[&Entity],
    main: &Entity,
    agg_class: Option<&str>,
) -> Vec<Artifact> {
    let mut out = Vec::new();
    for e in entities {
        let class = class_of(e);
        let itf = format!("I{class}BeanItf");
        let package = package_of(doc, e, p);
        let mut refs = vec![e.id.clone()];
        refs.extend(e.attrs.iter().map(|a| a.id.clone()));
        out.push(
            Artifact::new(
                format!("java.itf.{}", e.id),
                Family::Java,
                "beanItf",
                format!("{itf}.java"),
                path_hint(&p.public_src_root, &package, &itf),
                bean_itf(doc, p, e),
            )
            .refs(refs),
        );
    }
    let package = package_of(doc, main, p);
    let op = format!("I{}OPItf", pascal(&doc.component.name));
    out.push(
        Artifact::new(
            "java.opitf".to_string(),
            Family::Java,
            "opItf",
            format!("{op}.java"),
            path_hint(&p.public_src_root, &package, &op),
            op_itf(doc, p, main, agg_class),
        )
        .refs([main.id.clone()]),
    );
    out
}

pub fn test_artifact(doc: &BmfDoc, p: &GenProfile, e: &Entity) -> Artifact {
    let class = class_of(e);
    let package = package_of(doc, e, p);
    let test = format!("{class}Test");
    Artifact::new(
        format!("java.test.{}", e.id),
        Family::Java,
        "test",
        format!("{test}.java"),
        path_hint(&p.test_src_root, &package, &test),
        test_stub(doc, p, e),
    )
    .refs([e.id.clone()])
    .after([format!("java.vo.{}", e.id)])
}
