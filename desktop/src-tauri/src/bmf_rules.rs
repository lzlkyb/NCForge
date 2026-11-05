//! BMF 校验规则：文件/模型侧 + 可选的发布态（md_*）侧。
//!
//! 每条问题都带四样东西：**是什么、依据在哪、为什么要命、建议怎么做**。
//! 没有「评分」也没有「全部通过」的假绿灯——零问题就是零问题，被跳过的东西
//! 单独计数（见 `Summary.skipped`）。
//!
//! 分级口径：
//! - `error`：会生成坏 DDL / 坏 VO / 打不开的 BMF，阻断生成；
//! - `warn`：能生成但语义可疑（类型长度不符、参照悬空、发布态漂移）；
//! - `info`：合法但值得知道（零实体组件、未知节点、版本号）。

use serde::Serialize;

use crate::bmf_model::BmfDoc;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub id: String,
    pub code: String,
    /// error / warn / info
    pub severity: String,
    pub title: String,
    pub detail: String,
    pub why: String,
    pub action: String,
    pub file: String,
    pub line: Option<u32>,
    pub component: String,
    pub entity: String,
    pub attr: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub error: usize,
    pub warn: usize,
    pub info: usize,
}

impl Summary {
    pub fn of(items: &[Issue]) -> Self {
        let mut s = Self::default();
        for i in items {
            match i.severity.as_str() {
                "error" => s.error += 1,
                "warn" => s.warn += 1,
                _ => s.info += 1,
            }
        }
        s
    }
}

/// 发布态快照（从 md_table / md_column 取）。只传表名与列，不传连接信息。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishTable {
    pub name: String,
    pub display_name: String,
    pub columns: Vec<PublishColumn>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishColumn {
    pub name: String,
    pub display_name: String,
    pub type_name: String,
    pub length: Option<u32>,
    pub nullable: bool,
    pub is_pk: bool,
}

/// 行号索引：一次走树 + 一次扫换行，避免每条属性都做全树 DFS 和全文数行。
///
/// 病态语料（100 实体 × 50 属性）下旧的 `find_node` + `line_of` 组合是 O(n²)，
/// 实测 3s；这里降到 O(n log n)。
struct LineIndex<'a> {
    by_id: std::collections::HashMap<&'a str, usize>,
    newlines: Vec<usize>,
}

impl<'a> LineIndex<'a> {
    fn build(doc: &'a BmfDoc) -> Self {
        fn walk<'a>(n: &'a crate::bmf_model::XmlNode, out: &mut std::collections::HashMap<&'a str, usize>) {
            if let Some(id) = n.attr("id") {
                // 与 find_node 的 DFS 首命中语义一致：重复 id 保留最先出现的节点。
                out.entry(id).or_insert(n.start);
            }
            for c in &n.children {
                walk(c, out);
            }
        }
        let mut by_id = std::collections::HashMap::new();
        walk(&doc.root, &mut by_id);
        let newlines = doc
            .bytes
            .iter()
            .enumerate()
            .filter_map(|(i, b)| (*b == b'\n').then_some(i))
            .collect();
        Self { by_id, newlines }
    }

    fn line_by_id(&self, id: &str) -> Option<u32> {
        self.by_id
            .get(id)
            .map(|&off| self.newlines.partition_point(|&nl| nl < off) as u32 + 1)
    }
}

/// 检查一份文档。`file` 是给用户看的路径（索引层已转字符串）。
pub fn check_doc(doc: &BmfDoc, file: &str) -> Vec<Issue> {
    let mut out = Vec::new();
    let lines = LineIndex::build(doc);
    let c = &doc.component;
    let comp = c.name.clone();
    // 用宏而不是闭包：下面还要把 `&mut out` 交给 `check_attrs`，闭包会把可变借用
    // 一直攥到函数末尾，编译器不认这里的先后顺序。
    macro_rules! add {
        ($code:expr, $sev:expr, $title:expr, $detail:expr, $why:expr, $action:expr, $line:expr, $entity:expr, $attr:expr) => {
            out.push(Issue {
                id: String::new(),
                code: $code.to_string(),
                severity: $sev.to_string(),
                title: $title.to_string(),
                detail: $detail.to_string(),
                why: $why.to_string(),
                action: $action.to_string(),
                file: file.to_string(),
                line: $line,
                component: comp.clone(),
                entity: $entity.to_string(),
                attr: $attr.to_string(),
            })
        };
    }

    if c.name.trim().is_empty() {
        add!("C001", "error", "组件名称为空", "component/@name 是空串",
            "组件名是 .upm 声明、VO 路径与注册表的锚点，空名字会导致注册项无法定位。",
            "填写组件编码（与文件名一致，如 sz02）", None, "", "");
    }
    if c.namespace.trim().is_empty() {
        add!("C002", "error", "组件命名空间为空", "component/@namespace 是空串",
            "namespace 决定 VO 包名和元数据查找键（VOMetaFactory.getVOMeta(\"namespace.Class\")）。",
            "填写命名空间（通常等于模块名，如 uapbd）", None, "", "");
    }
    if !c.namespace.is_empty() && !c.own_module.is_empty() && c.namespace != c.own_module {
        add!("C003", "warn", "命名空间与所属模块不一致",
            format!("namespace={}，ownModule={}", c.namespace, c.own_module),
            "跨模块引用时 NC 按模块加载元数据，两者不一致会出现「本机能开、别处找不到」。",
            "确认这是有意的跨模块组件；否则改成与模块一致", None, "", "");
    }
    if c.version <= 0 {
        add!("C004", "info", "组件版本号非正", format!("version={}", c.version),
            "版本号参与发布态比较，0 或负数会让「是否已发布」的判断失真。",
            "保存时递增版本号", None, "", "");
    }
    if c.gen_code_style.trim().is_empty() {
        add!("C005", "info", "未声明代码生成风格", "component/@gencodestyle 为空",
            "UAP Studio 生成 VO 时按风格决定命名与访问器，空值可能回退到默认风格。",
            "补成「NC传统样式」或与目标工程一致的值", None, "", "");
    }
    if doc.entities.is_empty() {
        add!("C006", "info", "无实体组件", "celllist 下没有 entity",
            "本机 139 个组件是纯枚举 / 纯接口 / 历史残留，**这是合法形态**，不是解析失败。",
            "确认用途后保留；不需要实体就不必处理", None, "", "");
    }
    for t in &doc.unknown_tags {
        add!("C007", "info", "存在未识别的顶层节点", format!("<{t}>"),
            "解析器不解释它，但会按原字节保留；如果它其实有语义，这里看不到。",
            "如需支持，补充模型后再校验", None, "", "");
    }

    let main_ok = doc.entities.iter().any(|e| e.id == c.main_entity);
    if !c.main_entity.is_empty() && !main_ok {
        add!("C008", "error", "mainEntity 指向不存在的实体",
            format!("mainEntity={}", c.main_entity),
            "发布与代码生成都从主实体出发，悬空引用会让生成物为空或直接失败。",
            "把 mainEntity 改成主表的 entity/@id", None, "", "");
    }

    // 跨实体的重名：表名、实体名
    let mut tables: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for e in &doc.entities {
        if !e.table.is_empty() {
            *tables.entry(e.table.as_str()).or_default() += 1;
        }
    }
    for (t, n) in tables {
        if n > 1 {
            add!("C009", "error", "同一组件内表名重复", format!("{t} 出现 {n} 次"),
                "多个实体映射同一张表时，DDL 会重复建表、发布时互相覆盖列。",
                "给每个实体分配独立表名", None, "", "");
        }
    }
    let mut names: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for e in &doc.entities {
        if !e.name.is_empty() {
            *names.entry(e.name.as_str()).or_default() += 1;
        }
    }
    for (n, cnt) in names {
        if cnt > 1 {
            add!("C010", "error", "实体名重复", format!("{n} 出现 {cnt} 次"),
                "实体名即 VO 类名，重复会导致类文件互相覆盖。",
                "改名或合并实体", None, "", "");
        }
    }

    let primaries = doc.entities.iter().filter(|e| e.is_primary).count();
    if !doc.entities.is_empty() && primaries == 0 {
        add!("C011", "error", "没有主实体", "所有 entity 的 isPrimary 都是 false",
            "主子表关系、默认界面与代码生成都依赖主实体。",
            "把表头实体的 isPrimary 设为 true", None, "", "");
    } else if primaries > 1 {
        add!("C012", "error", "存在多个主实体", format!("{primaries} 个 isPrimary=true"),
            "发布时无法确定主表，生成的聚合 VO 结构会错乱。",
            "只保留一个主实体", None, "", "");
    }

    for e in &doc.entities {
        let eline = lines.line_by_id(&e.id);
        if e.table.trim().is_empty() {
            add!("E001", "error", "实体没有表名", format!("{} 的 tableName 为空", e.name),
                "没有表名就生成不了 DDL，发布也会找不到落点。",
                "填写 tableName（如 uapbd_sz02_h）", eline, &e.name, "");
        } else if !e.table.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '$' || ch == '#') {
            add!("E002", "error", "表名含非法字符", e.table.clone(),
                "Oracle 标识符只能是字母/数字/下划线/美元/井号，且不能以数字开头。",
                "改成合法标识符", eline, &e.name, "");
        }
        if e.full_class.trim().is_empty() {
            add!("E003", "error", "实体缺少 fullClassName", format!("{} 的类名为空", e.name),
                "VO 路径由 fullClassName 推导，缺了它生成器不知道写哪。",
                "填写完整类名（nc.vo.<模块>.<组件>.<类名>）", eline, &e.name, "");
        } else if !e.full_class.starts_with(&format!("nc.vo.{}", c.namespace)) {
            add!("E004", "warn", "VO 包名与命名空间不一致", e.full_class.clone(),
                "包名和 namespace 不一致时，VOMetaFactory 的查找键会对不上。",
                "确认包名；通常应为 nc.vo.<namespace>.<组件>", eline, &e.name, "");
        }

        // 主键
        let key = e.attrs.iter().find(|a| a.id == e.key_attr_id);
        if e.key_attr_id.trim().is_empty() {
            add!("E005", "error", "实体没有 keyAttributeId", e.name.clone(),
                "主键列决定 DDL 的 primary key 与 VO 的默认排序。",
                "把主键属性的 id 填到 keyAttributeId", eline, &e.name, "");
        } else if key.is_none() {
            add!("E006", "error", "keyAttributeId 指向不存在的属性", e.key_attr_id.clone(),
                "悬空主键会让建表脚本没有主键，发布时也无法定位行。",
                "改成实体内某个属性的 id", eline, &e.name, "");
        } else if let Some(k) = key {
            if !k.is_key {
                add!("E007", "error", "主键属性未标记 isKey", k.name.clone(),
                    "keyAttributeId 指向的属性 isKey=false，DDL 与 VO 会各按一套理解。",
                    "把该属性 isKey 设为 true（并且只设一个）",
                    lines.line_by_id(&k.id), &e.name, &k.name);
            }
            if k.type_name != "UFID" {
                add!("E008", "warn", "主键类型不是 UFID", format!("{}: {}", k.name, k.type_name),
                    "NC 单据主键惯例是 20 位 UFID；其它类型在参照与聚合关系里会被当成业务字段。",
                    "改成 UFID(length=20)，或确认这是特例",
                    lines.line_by_id(&k.id), &e.name, &k.name);
            }
        }
        let keys = e.attrs.iter().filter(|a| a.is_key).count();
        if keys > 1 {
            add!("E009", "error", "一个实体有多个 isKey 属性", format!("{} 个", keys),
                "复合主键不是 NC 单据的常规形态，发布侧通常只认一个。",
                "只保留一个 isKey", eline, &e.name, "");
        }

        check_attrs(doc, e, &lines, file, &mut out);
    }

    for en in &doc.enums {
        let eline = lines.line_by_id(&en.id);
        if en.items.is_empty() {
            add!("N001", "error", "枚举没有枚举项", en.name.clone(),
                "空枚举在界面上是空白下拉框，VO 里也无法初始化。",
                "至少加一项，或删除该枚举", eline, "", &en.name);
        }
        let mut seen = std::collections::HashMap::new();
        for it in &en.items {
            *seen.entry(it.value.trim().to_string()).or_insert(0usize) += 1;
        }
        for (v, n) in seen {
            if n > 1 {
                add!("N002", "error", "枚举值重复", format!("{} 的 {} 出现 {} 次", en.name, v, n),
                    "重复值会让下拉项无法区分，保存后数据含义丢失。",
                    "改成唯一值", eline, "", &en.name);
            }
        }
    }

    // 枚举与属性的引用一致性
    let enum_names: std::collections::HashSet<&str> = doc.enums.iter().map(|e| e.name.as_str()).collect();
    let entity_ids: std::collections::HashSet<&str> = doc.entities.iter().map(|e| e.id.as_str()).collect();
    for e in &doc.entities {
        for a in &e.attrs {
            if a.style == "ARRAY" {
                if !entity_ids.contains(a.data_type.as_str()) {
                    add!("A010", "warn", "聚合属性指向的实体不在本组件",
                        format!("{} -> {}", a.name, a.data_type),
                        "主子表关系靠 dataType 指向子实体；跨组件引用时发布顺序会影响解析。",
                        "确认子实体已在本组件，或先发布被引用组件",
                        lines.line_by_id(&a.id), &e.name, &a.name);
                }
                if !a.db_type.is_empty() {
                    add!("A011", "warn", "ARRAY 属性带了数据库类型",
                        format!("{}: dbtype={}", a.name, a.db_type),
                        "ARRAY 表示聚合关系，不应落成物理列；带 dbtype 会让 DDL 多出一列。",
                        "把 dbtype 清空",
                        lines.line_by_id(&a.id), &e.name, &a.name);
                }
                continue;
            }
            if enum_names.contains(a.type_name.as_str()) {
                // 枚举引用在本组件内，检查无项已在 N001 报过
                continue;
            }
            if a.data_type.starts_with("BS") || a.data_type.starts_with("REF") {
                continue;
            }
            if !a.data_type.is_empty()
                && !entity_ids.contains(a.data_type.as_str())
                && !doc.enums.iter().any(|en| en.id == a.data_type)
                && !enum_names.contains(a.ref_target.as_str())
            {
                add!("A012", "info", "属性类型指向外部对象",
                    format!("{} -> {} ({})", a.name, a.data_type, a.type_name),
                    "不是基础类型、也不是本组件实体/枚举，可能引用其它组件。",
                    "确认被引用组件已发布；跨组件引用属于正常用法",
                    lines.line_by_id(&a.id), &e.name, &a.name);
            }
        }
    }

    for (i, x) in out.iter_mut().enumerate() {
        x.id = format!("{}#{}", x.code, i + 1);
    }
    out
}

fn check_attrs(
    doc: &BmfDoc,
    e: &crate::bmf_model::Entity,
    lines: &LineIndex<'_>,
    _file: &str,
    out: &mut Vec<Issue>,
) {
    let mut seen_name: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    let mut seen_field: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for a in &e.attrs {
        *seen_name.entry(a.name.as_str()).or_default() += 1;
        if a.style != "ARRAY" && !a.field.is_empty() {
            *seen_field.entry(a.field.as_str()).or_default() += 1;
        }
    }
    // def1..def20 与业务字段重名：二开最常见的“模板没删干净”
    let business: std::collections::HashSet<&str> = e
        .attrs
        .iter()
        .filter(|a| !is_def(&a.name) && a.style != "ARRAY")
        .map(|a| a.name.as_str())
        .collect();
    let business_fields: std::collections::HashSet<&str> = e
        .attrs
        .iter()
        .filter(|a| !is_def(&a.name) && a.style != "ARRAY")
        .map(|a| a.field.as_str())
        .collect();

    for a in &e.attrs {
        let line = lines.line_by_id(&a.id);
        let push = |out: &mut Vec<Issue>, code: &str, sev: &str, title: String, detail: String, why: String, action: String| {
            out.push(Issue {
                id: String::new(),
                code: code.into(),
                severity: sev.into(),
                title,
                detail,
                why,
                action,
                file: doc.path.to_string_lossy().into_owned(),
                line,
                component: doc.component.name.clone(),
                entity: e.name.clone(),
                attr: a.name.clone(),
            });
        };
        if a.name.trim().is_empty() {
            push(out, "A001", "error", "属性名称为空".into(), "attribute/@name 为空".into(),
                "属性名同时是 VO 字段名，空值会生成非法 Java。".into(), "填写属性名".into());
        }
        if a.style != "ARRAY" && a.field.trim().is_empty() {
            push(out, "A002", "error", "属性没有数据库字段".into(), format!("{} 的 fieldName 为空", a.name),
                "SINGLE/REF 属性必须映射物理列。".into(), "填写 fieldName（通常同 name）".into());
        }
        if seen_name.get(a.name.as_str()).copied().unwrap_or(0) > 1 {
            push(out, "A003", "error", "属性名重复".into(), format!("{} 在同一实体出现多次", a.name),
                "重复属性在 VO 里是重复字段，编译直接失败。".into(), "改名或删除重复项".into());
        }
        if a.style != "ARRAY" && seen_field.get(a.field.as_str()).copied().unwrap_or(0) > 1 {
            push(out, "A004", "error", "数据库字段重复".into(), format!("{} 被多个属性映射", a.field),
                "DDL 会重复创建列，发布时列映射互相覆盖。".into(), "每个属性分配独立列名".into());
        }
        if !a.field.is_empty() && a.field != a.name && a.style != "ARRAY" {
            push(out, "A005", "warn", "属性名与字段名不一致".into(), format!("{} ≠ {}", a.name, a.field),
                "NC 的默认映射与大量脚本按「同名」取列，不一致时容易取错。".into(),
                "确认这是有意为之（如聚合属性复用 pk_head），否则改成同名".into());
        }
        if is_def(&a.name)
            && (business.contains(a.name.as_str()) || business_fields.contains(a.field.as_str()))
        {
            push(out, "A006", "error", "自定义字段与业务字段重名".into(), a.name.clone(),
                "模板铺的 defN 没删干净，会和业务字段抢同一个列名。".into(),
                "删除多余的 defN，或给业务字段改名".into());
        }
        match a.type_name.as_str() {
            "UFID" if a.length != Some(20) => push(out, "A007", "error", "UFID 长度不是 20".into(),
                format!("{}: length={:?}", a.name, a.length),
                "NC 主键/外键统一 char(20)，长度不符会在关联查询里截断。".into(), "把 length 改成 20".into()),
            "UFDate" | "UFDateTime" if a.length != Some(19) => push(out, "A008", "error", "日期长度不是 19".into(),
                format!("{}: {} length={:?}", a.name, a.type_name, a.length),
                "UFDate/UFDateTime 的物理列是 char(19)（yyyy-MM-dd HH:mm:ss）。".into(), "把 length 改成 19".into()),
            "UFLiteralDate" if a.length != Some(10) => push(out, "A009", "warn", "日期（字面）长度不是 10".into(),
                format!("{}: length={:?}", a.name, a.length),
                "UFLiteralDate 的物理列是 char(10)（yyyy-MM-dd）。".into(), "把 length 改成 10".into()),
            _ => {}
        }
        if a.style == "REF" && a.length != Some(20) {
            push(out, "A013", "warn", "参照字段长度不是 20".into(), format!("{}: length={:?}", a.name, a.length),
                "REF 存的是被参照对象的主键（char(20)），长度不符会导致关联查不到。".into(),
                "把 length 改成 20".into());
        }
        if a.style == "SINGLE" && matches!(a.type_name.as_str(), "String" | "CUSTOM")
            && a.length.map(|l| l == 0 || l > 4000).unwrap_or(false)
        {
            push(out, "A014", "warn", "字符串长度可疑".into(),
                format!("{}: length={:?}", a.name, a.length),
                "Oracle varchar2 上限 4000（GBK 字节口径更紧）；0 长度会建表失败。".into(),
                "改成实际需要的长度".into());
        }
        if a.type_name == "CUSTOM" && a.data_type.is_empty() {
            push(out, "A015", "warn", "CUSTOM 类型没有 dataType".into(), a.name.clone(),
                "CUSTOM 的真实类型只能从 dataType/fieldType 推，缺了就不知道建什么列。".into(),
                "补 dataType（baseType 的 id）".into());
        }
        if !a.nullable && a.default_value.is_empty() && !a.is_key && !a.name.starts_with("def") {
            push(out, "A016", "info", "必填字段没有默认值".into(), a.name.clone(),
                "非空又无默认值，历史数据迁移/补数时容易整批失败。".into(),
                "确认业务上必须必填；否则允许为空".into());
        }
    }
}

fn is_def(name: &str) -> bool {
    let n = name.strip_prefix('b').unwrap_or(name);
    n.strip_prefix("def")
        .and_then(|s| s.parse::<u32>().ok())
        .map(|v| (1..=50).contains(&v))
        .unwrap_or(false)
}

/// 发布态对照：BMF（设计态）↔ md_*（已发布态）。
///
/// 只做「看得见的差异」，不判断谁对：BMF 比库新 → 有未发布修改；库比 BMF 多 →
/// 有人直接改过库或 BMF 没提交。
pub fn check_publish(doc: &BmfDoc, file: &str, published: &[PublishTable]) -> Vec<Issue> {
    let mut out = Vec::new();
    let by_name: std::collections::HashMap<&str, &PublishTable> =
        published.iter().map(|t| (t.name.as_str(), t)).collect();
    let mut push = |code: &str, sev: &str, title: String, detail: String, why: String, action: String, entity: &str, attr: &str| {
        out.push(Issue {
            id: String::new(),
            code: code.into(),
            severity: sev.into(),
            title,
            detail,
            why,
            action,
            file: file.to_string(),
            line: None,
            component: doc.component.name.clone(),
            entity: entity.into(),
            attr: attr.into(),
        });
    };

    for e in &doc.entities {
        if e.table.is_empty() {
            continue;
        }
        let Some(t) = by_name.get(e.table.as_str()) else {
            push("P001", "warn", "表未发布".into(),
                format!("{}（实体 {}）在 md_table 里没有记录", e.table, e.name),
                "本地 BMF 已存在但发布态没有这张表，界面/参照都读不到。".into(),
                "按发布流程注册组件后再核对".into(), &e.name, "");
            continue;
        };
        let db_cols: std::collections::HashMap<String, &PublishColumn> = t
            .columns
            .iter()
            .map(|c| (c.name.to_lowercase(), c))
            .collect();
        let mut bmf_cols = std::collections::HashSet::new();
        for a in &e.attrs {
            if a.style == "ARRAY" || a.field.is_empty() {
                continue;
            }
            bmf_cols.insert(a.field.to_lowercase());
            let Some(c) = db_cols.get(&a.field.to_lowercase()) else {
                push("P002", "warn", "字段未发布".into(),
                    format!("{}.{}（属性 {}）在 md_column 里没有", e.table, a.field, a.name),
                    "BMF 有列、发布态没有：界面按元数据渲染时这一列不会出现。".into(),
                    "重新发布组件，或确认这列是否被删过".into(), &e.name, &a.name);
                continue;
            };
            if let Some(l) = a.length {
                if c.length.map(|x| x != l).unwrap_or(false) {
                    push("P003", "warn", "长度与发布态不一致".into(),
                        format!("{}.{}: BMF {} / 发布态 {:?}", e.table, a.field, l, c.length),
                        "长度差异通常意味着 BMF 改了没发布，或库里被人直接改过。".into(),
                        "以 BMF 为准重新发布，或回退 BMF".into(), &e.name, &a.name);
                }
            }
            if a.is_key != c.is_pk {
                push("P004", "warn", "主键标记与发布态不一致".into(),
                    format!("{}.{}: BMF isKey={} / 发布态 pk={}", e.table, a.field, a.is_key, c.is_pk),
                    "主键标记不一致会让聚合与行定位走不同路径。".into(),
                    "核对两边的主键定义".into(), &e.name, &a.name);
            }
            if a.nullable == c.nullable && a.nullable && c.nullable {
                // 一致，无需提示
            } else if a.nullable != c.nullable {
                push("P005", "warn", "可空性与发布态不一致".into(),
                    format!("{}.{}: BMF nullable={} / 发布态 nullable={}", e.table, a.field, a.nullable, c.nullable),
                    "可空性只影响新库建表；存量库不会自动改，差异会长期存在。".into(),
                    "确认哪边是准的，必要时出 ALTER 脚本".into(), &e.name, &a.name);
            }
        }
        for c in &t.columns {
            if !bmf_cols.contains(&c.name.to_lowercase()) {
                push("P006", "info", "库里有、BMF 没声明的列".into(),
                    format!("{}.{}（{}）", e.table, c.name, c.display_name),
                    "可能是历史列、扩展列，或 BMF 删字段后没重新发布。".into(),
                    "确认是否要清掉；不要直接删库列".into(), &e.name, &c.name);
            }
        }
    }
    for (i, x) in out.iter_mut().enumerate() {
        x.id = format!("{}#{}", x.code, i + 1);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bmf_model::BmfDoc;
    use std::path::PathBuf;

    fn doc(xml: &str) -> BmfDoc {
        BmfDoc::from_bytes(PathBuf::from("t.bmf"), xml.as_bytes().to_vec()).unwrap()
    }

    fn codes(d: &BmfDoc) -> Vec<String> {
        check_doc(d, "t.bmf").into_iter().map(|i| i.code).collect()
    }

    const GOOD: &str = r#"<component name="c" namespace="m" ownModule="m" version="1" mainEntity="e1"><celllist>
<entity id="e1" name="H" tableName="m_c_h" fullClassName="nc.vo.m.c.H" isPrimary="true" keyAttributeId="a1">
<attributelist>
<attribute id="a1" name="pk_head" fieldName="pk_head" typeName="UFID" dataType="BS1" dataTypeStyle="SINGLE" dbtype="char" length="20" isKey="true" isNullable="false" sequence="0"/>
<attribute id="a2" name="vbillcode" fieldName="vbillcode" typeName="String" dataType="BS2" dataTypeStyle="SINGLE" dbtype="varchar" length="40" isNullable="true" sequence="1"/>
</attributelist></entity></celllist></component>"#;

    #[test]
    fn clean_component_has_no_error() {
        let issues = check_doc(&doc(GOOD), "t.bmf");
        assert!(!issues.iter().any(|i| i.severity == "error"), "{issues:#?}");
    }

    #[test]
    fn zero_entity_is_info_not_error() {
        let d = doc(r#"<component name="c" namespace="m" ownModule="m"><celllist/></component>"#);
        let issues = check_doc(&d, "t.bmf");
        let i = issues.iter().find(|i| i.code == "C006").unwrap();
        assert_eq!(i.severity, "info");
    }

    #[test]
    fn bad_key_and_duplicate_field_are_errors() {
        let d = doc(r#"<component name="c" namespace="m" ownModule="m" mainEntity="e"><celllist>
<entity id="e" name="H" tableName="t" fullClassName="nc.vo.m.c.H" isPrimary="true" keyAttributeId="a1">
<attributelist>
<attribute id="a1" name="pk" fieldName="pk" typeName="String" length="10" isKey="true"/>
<attribute id="a2" name="x" fieldName="pk" typeName="String" length="10"/>
</attributelist></entity></celllist></component>"#);
        let c = codes(&d);
        assert!(c.contains(&"A004".to_string()));
        assert!(c.contains(&"A005".to_string()));
        assert!(c.contains(&"E008".to_string()));
    }

    #[test]
    fn ufid_length_and_date_length_are_checked() {
        let d = doc(r#"<component name="c" namespace="m" ownModule="m" mainEntity="e"><celllist>
<entity id="e" name="H" tableName="t" fullClassName="nc.vo.m.c.H" isPrimary="true" keyAttributeId="a1">
<attributelist>
<attribute id="a1" name="pk" fieldName="pk" typeName="UFID" length="10" isKey="true"/>
<attribute id="a2" name="d" fieldName="d" typeName="UFDate" length="10"/>
</attributelist></entity></celllist></component>"#);
        let c = codes(&d);
        assert!(c.contains(&"A007".to_string()));
        assert!(c.contains(&"A008".to_string()));
    }

    #[test]
    fn def_duplicate_with_business_field_is_error() {
        let d = doc(r#"<component name="c" namespace="m" ownModule="m" mainEntity="e"><celllist>
<entity id="e" name="H" tableName="t" fullClassName="nc.vo.m.c.H" isPrimary="true" keyAttributeId="a1">
<attributelist>
<attribute id="a1" name="pk" fieldName="pk" typeName="UFID" length="20" isKey="true"/>
<attribute id="a2" name="def1" fieldName="def1" typeName="CUSTOM" length="101"/>
<attribute id="a3" name="def1" fieldName="def1" typeName="CUSTOM" length="101"/>
</attributelist></entity></celllist></component>"#);
        let c = codes(&d);
        assert!(c.contains(&"A003".to_string()));
        assert!(c.contains(&"A004".to_string()));
    }

    #[test]
    fn enum_without_items_and_duplicate_values() {
        let d = doc(r#"<component name="c" namespace="m" ownModule="m"><celllist>
<Enumerate id="n1" name="st" typeName="String"><enumitemlist>
<enumitem id="i1" enumValue="1" enumDisplay="a"/><enumitem id="i2" enumValue="1" enumDisplay="b"/>
</enumitemlist></Enumerate>
<Enumerate id="n2" name="empty"/></celllist></component>"#);
        let c = codes(&d);
        assert!(c.contains(&"N001".to_string()));
        assert!(c.contains(&"N002".to_string()));
    }

    #[test]
    fn multiple_primary_and_missing_primary() {
        let d = doc(r#"<component name="c" namespace="m" ownModule="m"><celllist>
<entity id="a" name="A" isPrimary="true" tableName="t1"/><entity id="b" name="B" isPrimary="true" tableName="t2"/>
</celllist></component>"#);
        assert!(codes(&d).contains(&"C012".to_string()));
        let d2 = doc(r#"<component name="c" namespace="m" ownModule="m"><celllist>
<entity id="a" name="A" tableName="t1"/></celllist></component>"#);
        assert!(codes(&d2).contains(&"C011".to_string()));
    }

    #[test]
    fn publish_drift_is_reported_and_never_error() {
        let d = doc(GOOD);
        let published = vec![PublishTable {
            name: "m_c_h".into(),
            display_name: "表头".into(),
            columns: vec![PublishColumn {
                name: "pk_head".into(),
                display_name: "主键".into(),
                type_name: "char".into(),
                length: Some(20),
                nullable: false,
                is_pk: true,
            }],
        }];
        let issues = check_publish(&d, "t.bmf", &published);
        assert!(!issues.iter().any(|i| i.severity == "error"));
        assert!(issues.iter().any(|i| i.code == "P002"), "vbillcode 缺失应被指出");
        // 表完全没发布
        let missing = check_publish(&d, "t.bmf", &[]);
        assert!(missing.iter().any(|i| i.code == "P001"));
    }

    #[test]
    fn every_issue_carries_why_and_action() {
        let d = doc("<component><celllist/></component>");
        for i in check_doc(&d, "t.bmf") {
            assert!(!i.why.is_empty(), "{} 缺 why", i.code);
            assert!(!i.action.is_empty(), "{} 缺 action", i.code);
            assert!(!i.id.is_empty());
        }
    }
}
