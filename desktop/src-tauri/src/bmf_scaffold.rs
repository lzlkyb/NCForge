//! 新建组件的骨架生成（M1，只创建新文件）。
//!
//! 学的不是「UAP助手」的模板文件，而是它的**做法**：输入编码/名称/模块，推导出
//! 类名、包名、表名、字段清单，然后生成一份可被 UAP Studio 打开、无重复 ID、
//! 无悬空引用的 BMF。模板资产（第三方 BMF）一个字节都不引入。
//!
//! 五种骨架：
//! - `treeCard`：单表 + `pk_parent`（树卡）
//! - `singleHead`：单主表
//! - `singleBody`：单子表
//! - `headBody`：主子表（表头 ARRAY 指向表体 + AggregationRelation）
//! - `free`：空组件（纯枚举/接口用，零实体是合法形态）
//!
//! 字段口径与 `sz02.bmf` 实测一致：表头 22 个管理字段（有表体时含 ARRAY pk_body）、
//! 表体 6 个 + 来源单据三件套；`def1..def20` / `bdef1..bdef20` 可调。

use serde::{Deserialize, Serialize};

use crate::bmf_model::BmfDoc;
use crate::bmf_write::uuid_like;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Skeleton {
    TreeCard,
    SingleHead,
    SingleBody,
    HeadBody,
    Free,
}

impl Skeleton {
    pub fn label(self) -> &'static str {
        match self {
            Self::TreeCard => "树卡",
            Self::SingleHead => "单主表",
            Self::SingleBody => "单子表",
            Self::HeadBody => "主子表",
            Self::Free => "自由组件",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScaffoldSpec {
    /// 组件编码 = 文件名 = component/@name，如 sz02。
    pub code: String,
    /// 中文名（displayName）。
    pub name: String,
    /// 所属模块 = namespace = ownModule，如 uapbd。
    pub module: String,
    pub skeleton: Skeleton,
    /// 默认 20；允许 0..=50。
    #[serde(default)]
    pub defs: Option<u32>,
    /// 覆盖命名空间（默认 = module）。
    #[serde(default)]
    pub namespace: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldPreview {
    pub entity: String,
    pub name: String,
    pub display_name: String,
    pub type_name: String,
    pub db_type: String,
    pub length: Option<u32>,
    pub nullable: bool,
    pub is_key: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Scaffold {
    pub text: String,
    pub path_hint: String,
    pub component: String,
    pub namespace: String,
    pub module: String,
    pub skeleton: String,
    pub entities: Vec<EntityPreview>,
    pub fields: Vec<FieldPreview>,
    pub tables: Vec<String>,
    pub vo_files: Vec<String>,
    pub defs: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityPreview {
    pub name: String,
    pub display_name: String,
    pub table: String,
    pub full_class: String,
    pub primary: bool,
    pub attr_count: usize,
}

struct Field {
    name: String,
    display: String,
    type_name: String,
    data_type: String,
    style: &'static str,
    db_type: &'static str,
    length: Option<u32>,
    precision: Option<u32>,
    nullable: bool,
    is_key: bool,
    accessor: &'static str,
}

const UFID: (&str, &str) = ("UFID", "BS000010000100001051");
const STRING: (&str, &str) = ("String", "BS000010000100001001");
const INTEGER: (&str, &str) = ("Integer", "BS000010000100001004");
const DATE: (&str, &str) = ("UFDate", "BS000010000100001033");
const DATETIME: (&str, &str) = ("UFDateTime", "BS000010000100001034");
const CUSTOM: (&str, &str) = ("CUSTOM", "BS000010000100001056");

// 脚手架是照 NC 模板「一行一个字段」铺出来的；拆成结构体反而看不清列的形状，
// 参数多是有意为之（和 UAP Studio 的字段清单一一对应）。
#[allow(clippy::too_many_arguments)]
fn fld(
    name: &str,
    display: &str,
    ty: (&'static str, &'static str),
    style: &'static str,
    db: &'static str,
    len: Option<u32>,
    key: bool,
    nullable: bool,
) -> Field {
    Field {
        name: name.to_string(),
        display: display.to_string(),
        type_name: ty.0.to_string(),
        data_type: ty.1.to_string(),
        style,
        db_type: db,
        length: len,
        precision: None,
        nullable,
        is_key: key,
        accessor: "",
    }
}

fn head_fields(body_class: &str, body_id: &str, with_body: bool, tree: bool) -> Vec<Field> {
    let mut v = vec![
        fld("pk_head", "主键", UFID, "SINGLE", "char", Some(20), true, false),
    ];
    if with_body {
        v.push(Field {
            name: "pk_body".into(),
            display: "表体".into(),
            type_name: body_class.to_string(),
            data_type: body_id.to_string(),
            style: "ARRAY",
            db_type: "",
            length: None,
            precision: None,
            nullable: true,
            is_key: false,
            accessor: "nc.md.model.access.BodyOfAggVOAccessor",
        });
    }
    if tree {
        v.push(fld("pk_parent", "上级", UFID, "REF", "char", Some(20), false, true));
    }
    v.extend([
        fld("pk_group", "集团", ("group", ""), "REF", "varchar", Some(20), false, true),
        fld("pk_org_v", "组织版本", ("org_v", ""), "REF", "varchar", Some(20), false, true),
        fld("pk_org", "组织", ("org", ""), "REF", "varchar", Some(20), false, true),
        fld("vbillcode", "单据号", STRING, "SINGLE", "varchar", Some(40), false, true),
        fld("busitype", "业务类型", ("BusitypeVO", ""), "REF", "varchar", Some(20), false, true),
        fld("pk_billtypecode", "单据类型编码", STRING, "SINGLE", "varchar", Some(50), false, true),
        fld("pk_billtypeid", "单据类型", ("BilltypeVO", ""), "REF", "varchar", Some(20), false, true),
        fld("vtrantypecode", "交易类型编码", STRING, "SINGLE", "varchar", Some(50), false, true),
        fld("ctrantypeid", "交易类型", ("BilltypeVO", ""), "REF", "varchar", Some(20), false, true),
        fld("dbilldate", "单据日期", DATE, "SINGLE", "char", Some(19), false, true),
        fld("fstatusflag", "单据状态", ("BillstatusEnum", ""), "SINGLE", "int", None, false, true),
        fld("creator", "制单人", ("user", ""), "REF", "varchar", Some(20), false, true),
        fld("creationtime", "制单时间", DATETIME, "SINGLE", "char", Some(19), false, true),
        fld("modifier", "修改人", ("user", ""), "REF", "varchar", Some(20), false, true),
        fld("modifiedtime", "修改时间", DATETIME, "SINGLE", "char", Some(19), false, true),
        fld("approver", "审批人", ("user", ""), "REF", "varchar", Some(20), false, true),
        fld("taudittime", "审批时间", DATETIME, "SINGLE", "char", Some(19), false, true),
        fld("vapprovenote", "审批意见", STRING, "SINGLE", "varchar", Some(181), false, true),
        fld("enablestate", "启用状态", ("enablestate", ""), "SINGLE", "int", None, false, true),
        fld("vnote", "备注", STRING, "SINGLE", "varchar", Some(181), false, true),
    ]);
    v
}

fn body_fields() -> Vec<Field> {
    vec![
        fld("pk_body", "主键", UFID, "SINGLE", "char", Some(20), true, false),
        fld("pk_group", "集团", ("group", ""), "REF", "varchar", Some(20), false, true),
        fld("pk_org_v", "组织版本", ("org_v", ""), "REF", "varchar", Some(20), false, true),
        fld("pk_org", "组织", ("org", ""), "REF", "varchar", Some(20), false, true),
        fld("crowno", "行号", STRING, "SINGLE", "varchar", Some(20), false, true),
        fld("vbnote", "行备注", STRING, "SINGLE", "varchar", Some(181), false, true),
    ]
}

fn def_fields(prefix: &str, n: u32) -> Vec<Field> {
    (1..=n)
        .map(|i| Field {
            name: format!("{prefix}{i}"),
            display: format!("自定义项{i}"),
            type_name: CUSTOM.0.to_string(),
            data_type: CUSTOM.1.to_string(),
            style: "SINGLE",
            db_type: "varchar",
            length: Some(101),
            precision: None,
            nullable: true,
            is_key: false,
            accessor: "",
        })
        .collect()
}

fn tail_fields() -> Vec<Field> {
    vec![
        fld("code", "编码", STRING, "SINGLE", "varchar", Some(40), false, true),
        fld("name", "名称", STRING, "SINGLE", "varchar", Some(200), false, true),
        fld("dr", "删除标志", INTEGER, "SINGLE", "int", None, false, true),
        fld("ts", "时间戳", DATETIME, "SINGLE", "char", Some(19), false, true),
    ]
}

fn source_fields() -> Vec<Field> {
    vec![
        fld("csrcid", "来源单据主键", UFID, "SINGLE", "char", Some(20), false, true),
        fld("csrcbid", "来源单据表体主键", UFID, "SINGLE", "char", Some(20), false, true),
        fld("csrctype", "来源单据类型", STRING, "SINGLE", "varchar", Some(50), false, true),
    ]
}

/// 生成骨架。纯内存，不碰磁盘；写入由命令层调用 `bmf_write::write_new`。
pub fn build(spec: &ScaffoldSpec) -> Result<Scaffold, String> {
    let code = normalize_ident(&spec.code, "组件编码")?;
    let module = normalize_ident(&spec.module, "模块编码")?;
    let ns = match spec.namespace.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(n) => normalize_ident(n, "命名空间")?,
        None => module.clone(),
    };
    if spec.name.trim().is_empty() {
        return Err("组件名称不能为空".to_string());
    }
    let defs = spec.defs.unwrap_or(20).min(50);
    let vo = vo_name(&code);
    let head_class = format!("{vo}HVO");
    let body_class = format!("{vo}BVO");
    let head_id = uuid_like();
    let body_id = uuid_like();
    let component_id = uuid_like();
    let stamp = now_stamp();
    let with_head = matches!(
        spec.skeleton,
        Skeleton::TreeCard | Skeleton::SingleHead | Skeleton::HeadBody
    );
    let with_body = matches!(spec.skeleton, Skeleton::SingleBody | Skeleton::HeadBody);

    let mut entities = Vec::new();
    let mut preview_fields = Vec::new();
    let mut cell_xml = String::new();

    if with_head {
        let mut fields = head_fields(
            &body_class,
            &body_id,
            spec.skeleton == Skeleton::HeadBody,
            spec.skeleton == Skeleton::TreeCard,
        );
        fields.extend(def_fields("def", defs));
        fields.extend(tail_fields());
        let table = format!("{module}_{code}_h");
        let full = format!("nc.vo.{ns}.{code}.{head_class}");
        preview_fields.extend(collect_preview(&head_class, &fields));
        entities.push(EntityPreview {
            name: head_class.clone(),
            display_name: format!("{}表头", spec.name.trim()),
            table: table.clone(),
            full_class: full.clone(),
            primary: true,
            attr_count: fields.len(),
        });
        cell_xml.push_str(&entity_xml(
            &component_id,
            &head_id,
            &head_class,
            &format!("{}表头", spec.name.trim()),
            &full,
            &table,
            true,
            if spec.skeleton == Skeleton::HeadBody {
                "nc.md.model.access.javamap.AggVOStyle"
            } else {
                "nc.md.model.access.javamap.NCBeanStyle"
            },
            &fields,
            &stamp,
        ));
    }
    if with_body {
        let mut fields = body_fields();
        fields.extend(def_fields("bdef", defs));
        fields.extend(source_fields());
        let table = format!("{module}_{code}_b");
        let full = format!("nc.vo.{ns}.{code}.{body_class}");
        preview_fields.extend(collect_preview(&body_class, &fields));
        entities.push(EntityPreview {
            name: body_class.clone(),
            display_name: format!("{}表体", spec.name.trim()),
            table: table.clone(),
            full_class: full.clone(),
            primary: !with_head,
            attr_count: fields.len(),
        });
        cell_xml.push_str(&entity_xml(
            &component_id,
            &body_id,
            &body_class,
            &format!("{}表体", spec.name.trim()),
            &full,
            &table,
            !with_head,
            "nc.md.model.access.javamap.NCBeanStyle",
            &fields,
            &stamp,
        ));
    }

    let connect = if spec.skeleton == Skeleton::HeadBody {
        let rel_id = uuid_like();
        format!(
            "    <connectlist>\r\n        <AggregationRelation componentID=\"{component_id}\" createIndustry=\"0\" createTime=\"{stamp}\" creator=\"\" description=\"\" displayName=\"\" help=\"\" id=\"{rel_id}\" industryChanged=\"false\" isSource=\"false\" modifier=\"\" modifyIndustry=\"0\" modifyTime=\"{stamp}\" name=\"Aggregation Relation\" realsource=\"{head_id}\" realtarget=\"{body_id}\" source=\"{head_id}\" sourceConstraint=\"1\" srcAttributeid=\"{attr_id}\" target=\"{body_id}\" targetConstraint=\"1\" targetAttributeid=\"{body_key}\" versionType=\"0\">\r\n            <points/>\r\n        </AggregationRelation>\r\n    </connectlist>\r\n",
            attr_id = array_attr_id(&head_id),
            body_key = body_key_id(&body_id),
        )
    } else {
        "    <connectlist/>\r\n".to_string()
    };

    let main_entity = if with_head { head_id.clone() } else if with_body { body_id.clone() } else { String::new() };
    let text = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\r\n<component conRouterType=\"手动\" createIndustry=\"0\" createTime=\"{stamp}\" creator=\"\" description=\"\" displayName=\"{name}\" fromSourceBmf=\"true\" gencodestyle=\"NC传统样式\" help=\"\" id=\"{component_id}\" industry=\"0\" industryChanged=\"false\" industryIncrease=\"false\" industryName=\"综合控股集团\" isSource=\"false\" isbizmodel=\"false\" mainEntity=\"{main_entity}\" metaType=\".bmf\" modifier=\"\" modifyIndustry=\"0\" modifyTime=\"{stamp}\" name=\"{code}\" namespace=\"{ns}\" ownModule=\"{module}\" preLoad=\"false\" programcode=\"0\" resModuleName=\"{module}\" resid=\"\" version=\"1\" versionType=\"0\">\r\n    <celllist>\r\n{cell_xml}    </celllist>\r\n{connect}    <refdepends/>\r\n    <refdependLoseIDs/>\r\n    <cellRemoveLog/>\r\n    <rulers>\r\n        <ruler isHorizontal=\"true\" unit=\"0\">\r\n            <guideList/>\r\n        </ruler>\r\n        <ruler isHorizontal=\"false\" unit=\"0\">\r\n            <guideList/>\r\n        </ruler>\r\n    </rulers>\r\n</component>\r\n",
        name = xml(spec.name.trim()),
        code = code,
        ns = ns,
        module = module,
    );

    // 生成后立刻按自己的解析器过一遍：结构与 ID 引用图在这里就验证，不把坏文件交给用户。
    let doc = BmfDoc::from_bytes(std::path::PathBuf::from(format!("{code}.bmf")), text.clone().into_bytes())
        .map_err(|e| format!("生成的骨架解析失败（这是程序缺陷，请反馈）：{e}"))?;
    check_refs(&doc)?;

    let tables = entities.iter().map(|e| e.table.clone()).collect();
    let vo_files = entities
        .iter()
        .map(|e| format!("src/public/{}/{}.java", e.full_class.rsplit_once('.').map(|(p, _)| p).unwrap_or("").replace('.', "/"), e.name))
        .collect();

    Ok(Scaffold {
        text,
        path_hint: format!("{module}/METADATA/{code}.bmf"),
        component: code,
        namespace: ns,
        module,
        skeleton: skeleton_key(spec.skeleton).to_string(),
        entities,
        fields: preview_fields,
        tables,
        vo_files,
        defs,
    })
}

fn collect_preview(entity: &str, fields: &[Field]) -> Vec<FieldPreview> {
    fields
        .iter()
        .map(|f| FieldPreview {
            entity: entity.to_string(),
            name: f.name.clone(),
            display_name: f.display.clone(),
            type_name: f.type_name.clone(),
            db_type: f.db_type.to_string(),
            length: f.length,
            nullable: f.nullable,
            is_key: f.is_key,
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn entity_xml(
    component_id: &str,
    entity_id: &str,
    class: &str,
    display: &str,
    full: &str,
    table: &str,
    primary: bool,
    accessor: &str,
    fields: &[Field],
    stamp: &str,
) -> String {
    let mut attrs = String::new();
    for (i, f) in fields.iter().enumerate() {
        // 主键与聚合属性的 id 必须可推导：keyAttributeId / AggregationRelation 要引用它。
        // 其余属性随机即可（同一文件内唯一由 uuid_like 的计数器保证）。
        let attr_id = if f.is_key || f.style == "ARRAY" {
            key_attr_id(entity_id, &f.name)
        } else {
            uuid_like()
        };
        attrs.push_str(&format!(
            "                <attribute accessStrategy=\"{acc}\" accesspower=\"false\" accesspowergroup=\"\" calculation=\"false\" classID=\"{eid}\" createIndustry=\"0\" dataType=\"{data_type}\" dataTypeStyle=\"{style}\" dbtype=\"{db}\" defaultValue=\"\" description=\"\" displayName=\"{disp}\" dynamic=\"false\" dynamicTable=\"\" fieldName=\"{name}\" fieldType=\"{field_type}\" fixedLength=\"false\" forLocale=\"false\" help=\"\" id=\"{id}\" industryChanged=\"false\" isActive=\"true\" isAuthorization=\"true\" isDefaultDimensionAttribute=\"false\" isDefaultMeasureAttribute=\"false\" isFeature=\"false\" isGlobalization=\"false\" isHide=\"false\" isKey=\"{key}\" isNullable=\"{nullable}\" isReadOnly=\"false\" isShare=\"false\" isSource=\"true\" length=\"{len}\" maxValue=\"\" minValue=\"\" modifyIndustry=\"0\" name=\"{name}\" notSerialize=\"false\" precise=\"{prec}\" refModelName=\"\" resid=\"\" sequence=\"{seq}\" typeDisplayName=\"{type_display}\" typeName=\"{type_name}\" versionType=\"0\" visibility=\"public\"/>\r\n",
            acc = f.accessor,
            eid = xml(entity_id),
            data_type = xml(&f.data_type),
            style = f.style,
            db = f.db_type,
            disp = xml(&f.display),
            name = f.name,
            field_type = f.db_type,
            id = attr_id,
            key = f.is_key,
            nullable = f.nullable,
            len = f.length.map(|l| l.to_string()).unwrap_or_default(),
            prec = f.precision.map(|p| p.to_string()).unwrap_or_default(),
            seq = i,
            type_display = xml(&f.type_name),
            type_name = xml(&f.type_name),
        ));
    }
    format!(
        "        <entity accessorClassName=\"{accessor}\" bizItfImpClassName=\"\" componentID=\"{component_id}\" createIndustry=\"0\" createTime=\"{stamp}\" creator=\"\" czlist=\"\" description=\"\" displayName=\"{display}\" fullClassName=\"{full}\" height=\"313\" help=\"\" id=\"{entity_id}\" industryChanged=\"false\" isAuthen=\"true\" isCreateSQL=\"true\" isExtendBean=\"false\" isPrimary=\"{primary}\" isSource=\"false\" keyAttributeId=\"{key_id}\" modInfoClassName=\"\" modifier=\"\" modifyIndustry=\"0\" modifyTime=\"{stamp}\" name=\"{class}\" resid=\"\" stereoType=\"\" tableName=\"{table}\" userDefClassName=\"\" versionType=\"0\" visibility=\"public\" width=\"173\" x=\"288\" y=\"59\">\r\n            <attributelist>\r\n{attrs}            </attributelist>\r\n        </entity>\r\n",
        display = xml(display),
        full = xml(full),
        key_id = first_key_id(fields, entity_id),
        class = xml(class),
        table = xml(table),
    )
}

/// 主键属性 id，与 `entity_xml` 里生成 attribute 时使用同一个推导函数。
fn first_key_id(fields: &[Field], entity_id: &str) -> String {
    fields
        .iter()
        .find(|f| f.is_key)
        .map(|f| key_attr_id(entity_id, &f.name))
        .unwrap_or_default()
}

/// 可推导的属性 id：同一个 entity+字段名永远得到同一个 UUID。
/// 主键被 keyAttributeId 引用、聚合属性的外键被 connectlist 引用，两处不能各生成各的。
fn key_attr_id(entity_id: &str, field: &str) -> String {
    crate::bmf_write::uuid_from_seed(&format!("{entity_id}:{field}"))
}

fn array_attr_id(entity_id: &str) -> String {
    key_attr_id(entity_id, "pk_body")
}

fn body_key_id(entity_id: &str) -> String {
    key_attr_id(entity_id, "pk_body")
}

fn skeleton_key(s: Skeleton) -> &'static str {
    match s {
        Skeleton::TreeCard => "treeCard",
        Skeleton::SingleHead => "singleHead",
        Skeleton::SingleBody => "singleBody",
        Skeleton::HeadBody => "headBody",
        Skeleton::Free => "free",
    }
}

/// ID 引用图自检：mainEntity / keyAttributeId / ARRAY dataType / 聚合关系两端。
fn check_refs(doc: &BmfDoc) -> Result<(), String> {
    let ids: std::collections::HashSet<&str> = doc.entities.iter().map(|e| e.id.as_str()).collect();
    if !doc.component.main_entity.is_empty() && !ids.contains(doc.component.main_entity.as_str()) {
        return Err("mainEntity 悬空".to_string());
    }
    for e in &doc.entities {
        if !e.key_attr_id.is_empty() && !e.attrs.iter().any(|a| a.id == e.key_attr_id) {
            return Err(format!("{} 的 keyAttributeId 悬空", e.name));
        }
        for a in &e.attrs {
            if a.style == "ARRAY" && !ids.contains(a.data_type.as_str()) {
                return Err(format!("{}.{} 指向的实体不存在", e.name, a.name));
            }
        }
    }
    for r in &doc.relations {
        if r.kind == "AggregationRelation"
            && (!ids.contains(r.source.as_str()) || !ids.contains(r.target.as_str()))
        {
            return Err("聚合关系两端必须有实体".to_string());
        }
    }
    Ok(())
}

/// 组件/模块编码：小写 ASCII，字母开头，只允许小写字母/数字/下划线。
pub fn normalize_ident(s: &str, what: &str) -> Result<String, String> {
    let t = s.trim().to_lowercase();
    if t.is_empty() {
        return Err(format!("{what}不能为空"));
    }
    if !t.as_bytes()[0].is_ascii_alphabetic() {
        return Err(format!("{what}必须以字母开头：{t}"));
    }
    if !t.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_') {
        return Err(format!("{what}只能包含小写字母、数字、下划线：{t}"));
    }
    Ok(t)
}

/// `${djbmvo}` 的等价规则：首字母大写、其余小写，下划线原样保留（`my_bill` → `My_bill`）。
/// 与 UAP助手一致；不把下划线转驼峰，避免和既有工程的类名对不上。
pub fn vo_name(code: &str) -> String {
    let mut c = code.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

fn xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// 本地时间戳 `yyyy-MM-dd HH:mm:ss`（UTC；BMF 的 createTime 只用于展示，不影响语义）。
fn now_stamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Howard Hinnant 的 days→civil 算法（避免引入 chrono）。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    ((if m <= 2 { y + 1 } else { y }), m as u32, d as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(skeleton: Skeleton) -> ScaffoldSpec {
        ScaffoldSpec {
            code: "demo".into(),
            name: "演示单据".into(),
            module: "uapbd".into(),
            skeleton,
            defs: Some(20),
            namespace: None,
        }
    }

    #[test]
    fn all_five_skeletons_parse_and_have_no_dangling_refs() {
        for sk in [
            Skeleton::TreeCard,
            Skeleton::SingleHead,
            Skeleton::SingleBody,
            Skeleton::HeadBody,
            Skeleton::Free,
        ] {
            let s = build(&spec(sk)).unwrap();
            let d = BmfDoc::from_bytes(std::path::PathBuf::from("x.bmf"), s.text.clone().into_bytes()).unwrap();
            assert_eq!(d.component.name, "demo");
            assert_eq!(d.component.version, 1);
            // ID 全文件唯一
            let mut ids = std::collections::HashSet::new();
            fn walk(n: &crate::bmf_model::XmlNode, ids: &mut std::collections::HashSet<String>) {
                if let Some(id) = n.attr("id") {
                    assert!(ids.insert(id.to_string()), "重复 id {id}");
                }
                for c in &n.children {
                    walk(c, ids);
                }
            }
            walk(&d.root, &mut ids);
            assert!(ids.len() > 10 || sk == Skeleton::Free);
        }
    }

    #[test]
    fn head_body_links_array_and_relation() {
        let s = build(&spec(Skeleton::HeadBody)).unwrap();
        let d = BmfDoc::from_bytes(std::path::PathBuf::new(), s.text.into_bytes()).unwrap();
        assert_eq!(d.entities.len(), 2);
        let head = &d.entities[0];
        let body = &d.entities[1];
        let arr = head.attrs.iter().find(|a| a.name == "pk_body").unwrap();
        assert_eq!(arr.style, "ARRAY");
        assert_eq!(arr.data_type, body.id);
        let want_head = crate::bmf_write::uuid_from_seed(&format!("{}:{}", head.id, "pk_head"));
        let want_body = crate::bmf_write::uuid_from_seed(&format!("{}:{}", body.id, "pk_body"));
        assert_eq!(head.key_attr_id, want_head);
        assert_eq!(body.key_attr_id, want_body);
        assert!(head.attrs.iter().any(|a| a.id == head.key_attr_id));
        assert!(body.attrs.iter().any(|a| a.id == body.key_attr_id));
        assert_eq!(d.relations[0].src_attr_id, arr.id);
        assert_eq!(d.relations[0].target_attr_id, body.key_attr_id);
        assert_eq!(d.relations.len(), 1);
        assert_eq!(d.relations[0].source, head.id);
        assert_eq!(d.relations[0].target, body.id);
        // 22 管理字段（含 pk_body 聚合属性）+ 20 def + 4 尾部
        assert_eq!(head.attrs.len(), 22 + 20 + 4);
        assert_eq!(body.attrs.len(), 6 + 20 + 3);
        assert_eq!(s.tables, vec!["uapbd_demo_h", "uapbd_demo_b"]);
        assert_eq!(s.vo_files[0], "src/public/nc/vo/uapbd/demo/DemoHVO.java");
    }

    #[test]
    fn single_head_has_no_array_and_no_body() {
        let s = build(&spec(Skeleton::SingleHead)).unwrap();
        let d = BmfDoc::from_bytes(std::path::PathBuf::new(), s.text.into_bytes()).unwrap();
        assert_eq!(d.entities.len(), 1);
        assert!(!d.entities[0].attrs.iter().any(|a| a.style == "ARRAY"));
        assert_eq!(d.component.main_entity, d.entities[0].id);
        assert!(d.relations.is_empty());
    }

    #[test]
    fn body_only_component_marks_body_primary() {
        let s = build(&spec(Skeleton::SingleBody)).unwrap();
        let d = BmfDoc::from_bytes(std::path::PathBuf::new(), s.text.into_bytes()).unwrap();
        assert_eq!(d.entities.len(), 1);
        assert!(d.entities[0].is_primary);
        assert_eq!(
            d.entities[0].key_attr_id,
            crate::bmf_write::uuid_from_seed(&format!("{}:{}", d.entities[0].id, "pk_body"))
        );
    }

    #[test]
    fn tree_card_adds_pk_parent() {
        let s = build(&spec(Skeleton::TreeCard)).unwrap();
        let d = BmfDoc::from_bytes(std::path::PathBuf::new(), s.text.into_bytes()).unwrap();
        assert!(d.entities[0].attrs.iter().any(|a| a.name == "pk_parent"));
    }

    #[test]
    fn free_component_has_zero_entities_and_empty_main_entity() {
        let s = build(&spec(Skeleton::Free)).unwrap();
        let d = BmfDoc::from_bytes(std::path::PathBuf::new(), s.text.into_bytes()).unwrap();
        assert!(d.entities.is_empty());
        assert!(d.component.main_entity.is_empty());
        assert!(s.fields.is_empty());
    }

    #[test]
    fn defs_are_adjustable_and_capped() {
        let mut sp = spec(Skeleton::SingleHead);
        sp.defs = Some(5);
        let s = build(&sp).unwrap();
        let d = BmfDoc::from_bytes(std::path::PathBuf::new(), s.text.into_bytes()).unwrap();
        assert_eq!(d.entities[0].attrs.iter().filter(|a| a.name.starts_with("def")).count(), 5);
        sp.defs = Some(999);
        assert_eq!(build(&sp).unwrap().defs, 50);
    }

    #[test]
    fn invalid_identifiers_are_rejected_before_generating() {
        let mut sp = spec(Skeleton::SingleHead);
        sp.code = "中文".into();
        assert!(build(&sp).unwrap_err().contains("字母开头"));
        sp.code = "a-b".into();
        assert!(build(&sp).unwrap_err().contains("下划线"));
        sp.code = "ok".into();
        sp.module = String::new();
        assert!(build(&sp).unwrap_err().contains("不能为空"));
        sp.module = "uapbd".into();
        sp.name = "  ".into();
        assert!(build(&sp).unwrap_err().contains("名称"));
    }

    #[test]
    fn vo_name_keeps_underscores() {
        assert_eq!(vo_name("sz02"), "Sz02");
        assert_eq!(vo_name("my_bill"), "My_bill");
    }

    #[test]
    fn date_conversion_matches_known_days() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(20_000), (2024, 10, 4));
    }

    #[test]
    fn output_is_crlf_and_utf8_declared() {
        let s = build(&spec(Skeleton::HeadBody)).unwrap();
        assert!(s.text.contains("\r\n"));
        assert!(s.text.starts_with("<?xml version=\"1.0\" encoding=\"UTF-8\"?>"));
        assert!(!s.text.contains("\n\n"));
        assert!(s.text.ends_with("</component>\r\n"));
    }
}
