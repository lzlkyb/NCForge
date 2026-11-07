//! 一次生成：配置 + BMF → 产物图（不落盘）。
//!
//! 性能纪律（对应方案 §12）：
//! - BMF 只解析一次，本模块只读 `BmfDoc`，不再回扫 XML/文件系统。
//! - 产物按依赖顺序一次算完：枚举 → 实体 VO → 聚合 → 接口 → 测试 → DDL → 注册清单。
//! - 计时拆成 graph/render/total 三段，UI 直接展示；门禁按 total 取 P95。
//! - 不做并发：P0 先用真实数字判断是否需要；渲染是纯字符串拼装，通常远低于预算。

use std::time::Instant;

use crate::bmf_gen;
use crate::bmf_gen_java as java;
use crate::bmf_gen_sql;
use crate::bmf_gen_types::{
    input_fingerprint, profile_fingerprint, Artifact, CodeStyle, Family, GenPlan, GenProfile,
    Timings,
};
use crate::bmf_model::{BmfDoc, Entity};

/// 生成全部产物。`only` 为空 = 组件内所有实体；命中 id 或 name 均可。
pub fn plan(doc: &BmfDoc, profile: &GenProfile, only: &[String]) -> GenPlan {
    let t0 = Instant::now();
    let mut warnings = Vec::new();
    let picked: Vec<&Entity> = doc
        .entities
        .iter()
        .filter(|e| only.is_empty() || only.iter().any(|id| id == &e.id || id == &e.name))
        .collect();
    if !only.is_empty() && picked.is_empty() {
        warnings.push(format!("筛选条件没有匹配任何实体：{}", only.join(", ")));
    }
    let main = doc
        .entities
        .iter()
        .find(|e| {
            (!doc.component.main_entity.is_empty()
                && (e.id == doc.component.main_entity || e.name == doc.component.main_entity))
                || e.is_primary
        })
        .or_else(|| picked.first().copied());
    if profile.style == CodeStyle::Custom && profile.base_package.trim().is_empty() {
        warnings.push(
            "自定义样式未指定包根，沿用实体 fullClassName 的包；需要统一包时请设置 basePackage"
                .to_string(),
        );
    }
    let main_children = main.map(|m| java::children_of(doc, m)).unwrap_or_default();
    let t1 = Instant::now();

    let mut artifacts: Vec<Artifact> = Vec::new();

    // 1. 枚举先出：VO 引用枚举类型时，枚举常量类要能被找到。
    if profile.options.generate_enum_vo {
        for en in &doc.enums {
            artifacts.push(java::enum_artifact(doc, profile, en));
        }
    }

    // 2. 实体 VO：字段顺序 = BMF sequence。
    for e in &picked {
        artifacts.push(java::vo_artifact(doc, profile, e));
    }

    // 3. 聚合 VO：只在主实体被选中且确有子实体时生成。
    let mut agg_class: Option<String> = None;
    if profile.options.generate_agg_vo {
        if let Some(m) = main {
            // 只选了子实体时不生成聚合：主实体 VO 不在本次产物里，聚合会引用一个
            // 不存在的类，落盘后编译不过。
            let main_picked = picked.iter().any(|p| p.id == m.id);
            let children: Vec<&Entity> = main_children
                .iter()
                .copied()
                .filter(|c| only.is_empty() || picked.iter().any(|p| p.id == c.id))
                .collect();
            if main_picked && !children.is_empty() {
                if let Some(a) = java::agg_artifact(doc, profile, m, &children) {
                    agg_class = Some(format!("{}AggVO", bmf_gen::pascal(&doc.component.name)));
                    artifacts.push(a);
                }
            }
        }
    }

    // 4. 查询 VO / 接口 / 测试桩（后三者默认关，按配置开）。
    if profile.options.generate_sel_vo {
        if let Some(m) = main {
            artifacts.push(java::sel_artifact(doc, profile, m, &picked, &mut warnings));
        }
    }
    if profile.options.generate_interfaces {
        if let Some(m) = main {
            artifacts.extend(java::itf_artifacts(
                doc,
                profile,
                &picked,
                m,
                agg_class.as_deref(),
            ));
        }
    }
    if profile.options.generate_test {
        for e in &picked {
            artifacts.push(java::test_artifact(doc, profile, e));
        }
    }

    // 5. DDL：按方言出预览脚本。
    if profile.options.generate_ddl {
        artifacts.push(bmf_gen_sql::ddl_artifact(doc, profile, only, &mut warnings));
    }

    // 6. 注册清单：沿用既有六处注册建议，作为 meta family 产物展示。
    let reg = bmf_gen::registry(doc, &picked);
    let reg_text = registry_text(&reg.items, &reg.upm);
    let comp = if doc.component.name.is_empty() {
        "component"
    } else {
        doc.component.name.as_str()
    };
    artifacts.push(
        Artifact::new(
            "meta.registry".to_string(),
            Family::Meta,
            "registry",
            format!("{comp}.registry.json"),
            format!("meta/{comp}.registry.json"),
            reg_text,
        )
        .refs(picked.iter().map(|e| e.id.clone())),
    );

    let t2 = Instant::now();
    warnings.sort();
    warnings.dedup();
    GenPlan {
        artifacts,
        warnings,
        timings: Timings {
            graph_ms: (t1 - t0).as_secs_f64() * 1000.0,
            render_ms: (t2 - t1).as_secs_f64() * 1000.0,
            total_ms: (t2 - t0).as_secs_f64() * 1000.0,
            ..Default::default()
        },
        input_sha256: input_fingerprint(doc, profile),
        profile_sha256: profile_fingerprint(profile),
        profile: profile.clone(),
    }
}

fn registry_text(items: &[bmf_gen::RegistryItem], upm: &str) -> String {
    let mut s = String::new();
    s.push_str("{\n  \"items\": [\n");
    for (i, it) in items.iter().enumerate() {
        let comma = if i + 1 == items.len() { "" } else { "," };
        s.push_str(&format!(
            "    {{\"area\": {}, \"hint\": {}, \"existing\": {}, \"suggested\": {}, \"note\": {}}}{}\n",
            json_str(&it.area),
            json_str(&it.hint),
            json_str(&it.existing),
            json_str(&it.suggested),
            json_str(&it.note),
            comma
        ));
    }
    s.push_str("  ],\n  \"upm\": ");
    s.push_str(&json_str(upm));
    s.push_str("\n}\n");
    s
}

fn json_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bmf_model::BmfDoc;
    use std::path::PathBuf;

    fn sample() -> BmfDoc {
        BmfDoc::from_bytes(
            PathBuf::from("sz02.bmf"),
            r#"<component name="sz02" displayName="任务接口配置" namespace="uapbd" genCodeStyle="NC传统样式" mainEntity="e1"><celllist>
<entity id="e1" name="Sz02HVO" displayName="表头" fullClassName="nc.vo.uapbd.sz02.Sz02HVO" tableName="uapbd_sz02_h" isPrimary="true" keyAttributeId="a1"><attributelist>
<attribute id="a1" name="pk_head" fieldName="pk_head" typeName="UFID" dataTypeStyle="SINGLE" dbtype="char" length="20" isKey="true" isNullable="false"/>
<attribute id="a2" name="pk_body" fieldName="pk_head" typeName="Sz02BVO" dataTypeStyle="ARRAY"/>
<attribute id="a3" name="vbillcode" fieldName="vbillcode" displayName="单据号" typeName="String" dataTypeStyle="SINGLE" dbtype="varchar" length="40"/>
</attributelist></entity>
<entity id="e2" name="Sz02BVO" displayName="表体" fullClassName="nc.vo.uapbd.sz02.Sz02BVO" tableName="uapbd_sz02_b" keyAttributeId="b1"><attributelist>
<attribute id="b1" name="pk_body" fieldName="pk_body" typeName="UFID" dataTypeStyle="SINGLE" dbtype="char" length="20" isKey="true"/>
<attribute id="b2" name="pk_head" fieldName="pk_head" typeName="UFID" dataTypeStyle="SINGLE" dbtype="char" length="20"/>
</attributelist></entity>
<Enumerate id="en1" name="BillstatusEnum" displayName="单据状态" typeName="Integer"><enumitemlist>
<enumitem id="i1" enumValue="0" enumDisplay="启用"/><enumitem id="i2" enumValue="1" enumDisplay="停用"/>
</enumitemlist></Enumerate>
</celllist><connectlist><AggregationRelation id="r1" source="e1" target="e2" srcAttributeid="a2" targetConstraint="1..n"/></connectlist></component>"#
                .as_bytes()
                .to_vec(),
        )
        .unwrap()
    }

    #[test]
    fn default_plan_has_vo_agg_enum_ddl_registry() {
        let d = sample();
        let p = GenProfile::from_bmf(&d);
        assert_eq!(p.style, CodeStyle::Traditional);
        let g = plan(&d, &p, &[]);
        let kinds: Vec<&str> = g.artifacts.iter().map(|a| a.kind.as_str()).collect();
        assert_eq!(kinds.iter().filter(|k| **k == "vo").count(), 2);
        assert!(kinds.contains(&"aggvo"), "{kinds:?}");
        assert!(kinds.contains(&"enum"), "{kinds:?}");
        assert!(kinds.contains(&"ddl"), "{kinds:?}");
        assert!(kinds.contains(&"registry"), "{kinds:?}");
        assert!(g.warnings.is_empty(), "{:?}", g.warnings);
        // 产物 id 唯一 + 依赖都能落到图里
        let ids: std::collections::HashSet<&str> =
            g.artifacts.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ids.len(), g.artifacts.len());
        for a in &g.artifacts {
            for dep in &a.depends_on {
                assert!(
                    ids.contains(dep.as_str()),
                    "{} 依赖了不存在的 {}",
                    a.id,
                    dep
                );
            }
            assert_eq!(a.sha256.len(), 64);
        }
    }

    #[test]
    fn traditional_agg_uses_aggregated_value_object() {
        let d = sample();
        let p = GenProfile::from_bmf(&d);
        let g = plan(&d, &p, &[]);
        let agg = g.artifacts.iter().find(|a| a.kind == "aggvo").unwrap();
        assert!(
            agg.text.contains("extends AggregatedValueObject"),
            "{}",
            agg.text
        );
        assert!(agg.text.contains("getChildrenVO"));
        assert!(agg.text.contains("Sz02HVO"), "{}", agg.text);
    }

    #[test]
    fn standard_style_changes_vo_and_agg_shapes() {
        let d = sample();
        let mut p = GenProfile::from_bmf(&d);
        p.style = CodeStyle::Standard;
        let g = plan(&d, &p, &[]);
        let vo = g
            .artifacts
            .iter()
            .find(|a| a.kind == "vo" && a.name.starts_with("Sz02HVO"))
            .unwrap();
        assert!(
            vo.text.contains("getAttributeValue(\"pk_head\")"),
            "{}",
            vo.text
        );
        assert!(vo
            .text
            .contains("public static final String PK_HEAD = \"pk_head\""));
        assert!(vo.text.contains("public String getPKFieldName()"));
        assert!(vo.text.contains("getTableName()"));
        assert!(
            vo.text.contains("getVOMeta(\"uapbd.uapbd_sz02_h\")"),
            "{}",
            vo.text
        );
        let agg = g.artifacts.iter().find(|a| a.kind == "aggvo").unwrap();
        assert!(agg.text.contains("extends AbstractBill"), "{}", agg.text);
        assert!(agg.text.contains("@nc.vo.annotation.AggVoInfo"));
    }

    #[test]
    fn only_filter_keeps_selected_entities() {
        let d = sample();
        let p = GenProfile::from_bmf(&d);
        let g = plan(&d, &p, &["e2".to_string()]);
        let vos: Vec<&Artifact> = g.artifacts.iter().filter(|a| a.kind == "vo").collect();
        assert_eq!(
            vos.len(),
            1,
            "{:?}",
            g.artifacts.iter().map(|a| &a.name).collect::<Vec<_>>()
        );
        assert!(vos[0].text.contains("class Sz02BVO"));
        assert!(g.artifacts.iter().all(|a| a.kind != "aggvo"));
    }

    #[test]
    fn custom_style_without_package_warns() {
        let d = sample();
        let mut p = GenProfile::from_bmf(&d);
        p.style = CodeStyle::Custom;
        let g = plan(&d, &p, &[]);
        assert!(g
            .warnings
            .iter()
            .any(|w| w.contains("自定义样式未指定包根")));
    }
}
