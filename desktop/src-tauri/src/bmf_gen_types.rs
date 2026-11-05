//! 生成配置、产物图与统一类型。生成内核的「数据形状」都放这里。
//!
//! 设计纪律：
//! - 渲染器纯函数：只吃 `BmfDoc + GenProfile`，不读盘、不连库、不查 NCLocator。
//! - 产物节点自带 `sourceRefs` / `dependsOn`，图先算完再渲染；改一个字段能反查
//!   受影响的 Java / SQL / 注册项。
//! - 哈希用 sha256，清单与漂移检测共用一套口径；序列化字段与前端 camelCase 对齐。

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::bmf_model::BmfDoc;

/// 官方 BMF 里 `gencodestyle` 的三个取值。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CodeStyle {
    /// `NC传统样式`：实体 VO 直接持有 public 字段；单子表 AggVO 继承 AggregatedValueObject。
    Traditional,
    /// `标准样式`：VO 走 getAttributeValue/setAttributeValue，带字段常量与表名/PK 覆盖；
    /// AggVO 继承 AbstractBill。
    Standard,
    /// `自定义样式`：同标准样式的访问器契约，但包根可覆盖，可关闭 UFBoolean 转换。
    Custom,
}

impl CodeStyle {
    /// 空串按传统样式（1909 本机 3711 个 BMF 里绝大多数显式写 NC传统样式）。
    pub fn parse(s: &str) -> Self {
        match s.trim() {
            "标准样式" => CodeStyle::Standard,
            "自定义样式" => CodeStyle::Custom,
            _ => CodeStyle::Traditional,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            CodeStyle::Traditional => "NC传统样式",
            CodeStyle::Standard => "标准样式",
            CodeStyle::Custom => "自定义样式",
        }
    }
}

/// 建库 SQL 方言。官方 `com.yonyou.studio.mdp.database` 的 8 种，按拼音序便于 UI 排序。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SqlDialect {
    Db2,
    Gbase,
    Informix,
    Oracle,
    Oscar,
    Postgresql,
    Sqlserver,
    Sybase,
}

impl SqlDialect {
    pub fn as_str(self) -> &'static str {
        match self {
            SqlDialect::Db2 => "db2",
            SqlDialect::Gbase => "gbase",
            SqlDialect::Informix => "informix",
            SqlDialect::Oracle => "oracle",
            SqlDialect::Oscar => "oscar",
            SqlDialect::Postgresql => "postgresql",
            SqlDialect::Sqlserver => "sqlserver",
            SqlDialect::Sybase => "sybase",
        }
    }

    /// 文件后缀：同一组件多方言输出时避免互相覆盖。
    pub fn file_suffix(self) -> &'static str {
        self.as_str()
    }

    pub fn all() -> [SqlDialect; 8] {
        [
            SqlDialect::Db2,
            SqlDialect::Gbase,
            SqlDialect::Informix,
            SqlDialect::Oracle,
            SqlDialect::Oscar,
            SqlDialect::Postgresql,
            SqlDialect::Sqlserver,
            SqlDialect::Sybase,
        ]
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenOptions {
    pub generate_agg_vo: bool,
    pub generate_enum_vo: bool,
    pub generate_interfaces: bool,
    pub generate_sel_vo: bool,
    pub generate_test: bool,
    pub generate_ddl: bool,
    /// 官方「导出 SQL 语句（带有外键信息）」。默认关：NC 常因批量同步挡外键。
    pub with_foreign_keys: bool,
    /// 官方「只生成扩展表」。当前 BMF 模型没有扩展表标记，开启时只给提示，不伪造表名。
    pub only_extension_tables: bool,
    /// 自定义/标准样式下是否把 UFBoolean 落成 java.lang.Boolean。
    pub uf_boolean_to_boolean: bool,
    /// 生成多语资源清单（P1 的模板/菜单多语在生成中心里单独出）。
    pub localization: bool,
}

impl Default for GenOptions {
    fn default() -> Self {
        Self {
            generate_agg_vo: true,
            generate_enum_vo: true,
            generate_interfaces: false,
            generate_sel_vo: false,
            generate_test: false,
            generate_ddl: true,
            with_foreign_keys: false,
            only_extension_tables: false,
            uf_boolean_to_boolean: false,
            localization: false,
        }
    }
}

/// 生成配置。`style` 留空时由调用方用 `CodeStyle::parse(doc.component.gen_code_style)` 填。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenProfile {
    pub style: CodeStyle,
    pub dialect: SqlDialect,
    /// 非空时覆盖实体包名：`basePackage + "." + component.name`。
    pub base_package: String,
    pub public_src_root: String,
    pub client_src_root: String,
    pub test_src_root: String,
    pub options: GenOptions,
}

impl Default for GenProfile {
    fn default() -> Self {
        Self {
            style: CodeStyle::Traditional,
            dialect: SqlDialect::Oracle,
            base_package: String::new(),
            public_src_root: "src/public".into(),
            client_src_root: "src/client".into(),
            test_src_root: "src/test".into(),
            options: GenOptions::default(),
        }
    }
}

impl GenProfile {
    /// 用 BMF 自己声明的代码风格覆盖默认值；显式传入的风格不动。
    pub fn from_bmf(doc: &BmfDoc) -> Self {
        Self {
            style: CodeStyle::parse(&doc.component.gen_code_style),
            ..Self::default()
        }
    }
}

/// 产物族。UI 按族分组，CLI 按族过滤。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Family {
    Java,
    Db,
    Bill,
    Format,
    Meta,
}

impl Family {
    pub fn as_str(self) -> &'static str {
        match self {
            Family::Java => "java",
            Family::Db => "db",
            Family::Bill => "bill",
            Family::Format => "format",
            Family::Meta => "meta",
        }
    }
}

/// 一个待生成产物。`text` 已渲染；大文件按需渲染是 P0-4 的懒加载层，图这里先算全量。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub id: String,
    pub family: String,
    pub kind: String,
    pub name: String,
    pub path_hint: String,
    pub encoding: String,
    pub eol: String,
    pub text: String,
    pub sha256: String,
    /// 来源：entity/attr/enum/relation 的 id，用于影响面与「点击字段回溯」。
    pub source_refs: Vec<String>,
    /// 依赖的产物 id。渲染顺序 = 拓扑序；UI 里也用来展示「为什么先有它」。
    pub depends_on: Vec<String>,
}

impl Artifact {
    pub fn new(
        id: impl Into<String>,
        family: Family,
        kind: impl Into<String>,
        name: impl Into<String>,
        path_hint: impl Into<String>,
        text: impl Into<String>,
    ) -> Self {
        let text = text.into();
        Self {
            id: id.into(),
            family: family.as_str().to_string(),
            kind: kind.into(),
            name: name.into(),
            path_hint: path_hint.into(),
            encoding: "GBK".into(),
            eol: "CRLF".into(),
            sha256: sha256_hex(text.as_bytes()),
            text,
            source_refs: Vec::new(),
            depends_on: Vec::new(),
        }
    }

    pub fn refs(mut self, refs: impl IntoIterator<Item = String>) -> Self {
        self.source_refs = refs.into_iter().filter(|s| !s.is_empty()).collect();
        self.source_refs.sort();
        self.source_refs.dedup();
        self
    }

    pub fn after(mut self, deps: impl IntoIterator<Item = String>) -> Self {
        self.depends_on = deps.into_iter().filter(|s| !s.is_empty()).collect();
        self.depends_on.sort();
        self.depends_on.dedup();
        self
    }
}

/// 阶段耗时。单位毫秒，前端直接展示；性能门禁按 `totalMs`（端到端）取 P95。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Timings {
    pub parse_ms: f64,
    pub validate_ms: f64,
    pub graph_ms: f64,
    pub render_ms: f64,
    pub diff_ms: f64,
    pub write_ms: f64,
    pub total_ms: f64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenPlan {
    pub artifacts: Vec<Artifact>,
    pub warnings: Vec<String>,
    pub timings: Timings,
    /// 输入指纹：组件名 + BMF 字节 + 配置。增量快路径先比它。
    pub input_sha256: String,
    pub profile_sha256: String,
    /// 本次实际生效的配置（调用方没传时由 BMF 推导），前端据此初始化配置面板。
    pub profile: GenProfile,
}

impl GenPlan {
    pub fn artifact(&self, id: &str) -> Option<&Artifact> {
        self.artifacts.iter().find(|a| a.id == id)
    }

    pub fn by_family(&self, family: Family) -> impl Iterator<Item = &Artifact> {
        let f = family.as_str();
        self.artifacts.iter().filter(move |a| a.family == f)
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    let out = h.finalize();
    let mut s = String::with_capacity(64);
    for b in out {
        use std::fmt::Write;
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// 配置指纹只覆盖影响产物的字段；`publicSrcRoot` 之类路径不参与，避免换目录就全量重刷。
pub fn profile_fingerprint(p: &GenProfile) -> String {
    let mut s = String::new();
    s.push_str(p.style.as_str());
    s.push('\u{1}');
    s.push_str(p.dialect.as_str());
    s.push('\u{1}');
    s.push_str(&p.base_package);
    let o = &p.options;
    s.push_str(&format!(
        "\u{1}{}{}{}{}{}{}{}{}{}",
        o.generate_agg_vo as u8,
        o.generate_enum_vo as u8,
        o.generate_interfaces as u8,
        o.generate_sel_vo as u8,
        o.generate_test as u8,
        o.generate_ddl as u8,
        o.with_foreign_keys as u8,
        o.only_extension_tables as u8,
        o.uf_boolean_to_boolean as u8,
    ));
    sha256_hex(s.as_bytes())
}

pub fn input_fingerprint(doc: &BmfDoc, p: &GenProfile) -> String {
    let mut s = Vec::with_capacity(doc.bytes.len() + 128);
    s.extend_from_slice(doc.component.namespace.as_bytes());
    s.push(0);
    s.extend_from_slice(doc.component.name.as_bytes());
    s.push(0);
    s.extend_from_slice(&doc.bytes);
    s.push(0);
    s.extend_from_slice(profile_fingerprint(p).as_bytes());
    sha256_hex(&s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn style_values_match_bmf() {
        assert_eq!(CodeStyle::parse("NC传统样式"), CodeStyle::Traditional);
        assert_eq!(CodeStyle::parse("标准样式"), CodeStyle::Standard);
        assert_eq!(CodeStyle::parse("自定义样式"), CodeStyle::Custom);
        // 空值/未知值不能崩，按传统处理（1909 绝大多数组件是传统样式）
        assert_eq!(CodeStyle::parse(""), CodeStyle::Traditional);
    }

    #[test]
    fn fingerprint_ignores_output_paths_but_not_style() {
        let mut a = GenProfile::default();
        let mut b = a.clone();
        b.public_src_root = "elsewhere/public".into();
        assert_eq!(profile_fingerprint(&a), profile_fingerprint(&b));
        a.style = CodeStyle::Standard;
        assert_ne!(profile_fingerprint(&a), profile_fingerprint(&b));
    }

    #[test]
    fn artifact_hash_changes_with_text() {
        let a = Artifact::new("x", Family::Java, "vo", "A.java", "src/A.java", "a");
        let b = Artifact::new("x", Family::Java, "vo", "A.java", "src/A.java", "b");
        assert_ne!(a.sha256, b.sha256);
        assert_eq!(a.sha256.len(), 64);
    }
}
