//! 结构回归门禁（仓内合成 BMF 与本机原始 UAP BMF）。
//!
//! 目的：证明**我们自己不会回归**——解析 → 语义模型 → 校验结论这条链在样本上的输出，
//! 必须与仓库里签入的基线完全一致。任何解析器/规则改动只要改变了语义结果，这里就会红。
//!
//! 边界（必须写清楚，避免把这份门禁当成保真证明）：
//! - 合成样本与本机 NC 1909 原始样本都不是官方 Parser 的 golden 结果；它证明的是「自洽 + 不回归」，
//!   不能证明「与官方 Parser 对任意真实 BMF 的解析结果一致」。
//! - 原始样本的来源与字节 SHA 见 uap-real/provenance.json，另有无损写回集成测试。
//! - 官方 golden 结果到位后，保留同一套规范化与比对逻辑，
//!   再补一条「解析结果 == 官方结果」的断言，即可升级为保真门禁。
//!
//! 基线更新（只在**确认改动是有意为之**后执行）：
//! ```text
//! cd desktop
//! BMF_BASELINE_UPDATE=1 node scripts/rust-gate.mjs test --no-default-features --test bmf_structure_baseline
//! ```
//! 然后逐项 review 基线 diff 再提交——盲目更新基线等于关掉门禁。

use std::fs;
use std::path::{Path, PathBuf};

use nc_forge::bmf_model::BmfDoc;
use nc_forge::bmf_rules;
use serde_json::{json, Value};

const UPDATE_ENV: &str = "BMF_BASELINE_UPDATE";

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("bmf")
}

fn baseline_path() -> PathBuf {
    root().join("structure-baseline.json")
}

fn bmf_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    let mut items: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
    items.sort();
    for p in items {
        if p.is_dir() {
            bmf_files(&p, out);
        } else if p.extension().is_some_and(|e| e.eq_ignore_ascii_case("bmf")) {
            out.push(p);
        }
    }
}

fn key_of(path: &Path) -> String {
    path.strip_prefix(root())
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

/// 语义快照：只收「有语义的字段」，不收原始字节、注释、未知节点与内部 id。
///
/// 不含 id 是刻意的：id 只是同一份文档内的引用键，真实 id 由官方工具生成，
/// 进基线会让「换一份等价样本」也变红，失去回归门禁的意义。
fn normalize_doc(doc: &BmfDoc) -> Value {
    let component = &doc.component;
    json!({
        "component": {
            "name": component.name,
            "displayName": component.display_name,
            "namespace": component.namespace,
            "ownModule": component.own_module,
            "genCodeStyle": component.gen_code_style,
            "version": component.version,
            "mainEntity": component.main_entity,
            "industry": component.industry,
            "metaType": component.meta_type,
        },
        "entities": doc.entities.iter().map(|e| json!({
            "name": e.name,
            "displayName": e.display_name,
            "table": e.table,
            "fullClass": e.full_class,
            "accessor": e.accessor,
            "isPrimary": e.is_primary,
            // 主键按「字段名」记，而不是 id：id 是内部引用。
            "keyAttr": e.attrs.iter().find(|a| a.id == e.key_attr_id).map(|a| a.name.clone()),
            "attrs": e.attrs.iter().map(|a| json!({
                "name": a.name,
                "field": a.field,
                "displayName": a.display_name,
                "typeName": a.type_name,
                "typeDisplayName": a.type_display_name,
                "dataType": a.data_type,
                "style": a.style,
                "dbType": a.db_type,
                "fieldType": a.field_type,
                "length": a.length,
                "precision": a.precision,
                "isKey": a.is_key,
                "nullable": a.nullable,
                "defaultValue": a.default_value,
                "refModel": a.ref_model,
                "sequence": a.sequence,
                "refTarget": a.ref_target,
            })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "enums": doc.enums.iter().map(|e| json!({
            "name": e.name,
            "displayName": e.display_name,
            "typeName": e.type_name,
            "dataType": e.data_type,
            "fullClass": e.full_class,
            "items": e.items.iter().map(|i| json!({
                "value": i.value,
                "display": i.display,
                "hidden": i.hidden,
            })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "relations": doc.relations.iter().map(|r| json!({
            "kind": r.kind,
            "name": r.name,
            "source": r.source,
            "target": r.target,
        })).collect::<Vec<_>>(),
    })
}

/// 校验快照：只留稳定的判据（规则码 / 级别 / 归属），不记文案与行号。
/// 文案会随体验改进调整，把它塞进基线只会制造噪声。
fn normalize_issues(issues: &[bmf_rules::Issue]) -> Value {
    let mut rows: Vec<(String, String, String, String)> = issues
        .iter()
        .map(|i| {
            (
                i.code.clone(),
                i.severity.clone(),
                i.entity.clone(),
                i.attr.clone(),
            )
        })
        .collect();
    rows.sort();
    rows.dedup();
    Value::Array(
        rows.into_iter()
            .map(|(code, severity, entity, attr)| {
                json!({ "code": code, "severity": severity, "entity": entity, "attr": attr })
            })
            .collect(),
    )
}

fn snapshot_for(path: &Path) -> Value {
    match BmfDoc::open(path) {
        Ok(doc) => {
            let issues = bmf_rules::check_doc(&doc, &path.to_string_lossy());
            json!({
                "parse": "ok",
                "doc": normalize_doc(&doc),
                "issues": normalize_issues(&issues),
            })
        }
        Err(err) => json!({
            "parse": "error",
            // 只记「解析失败」：错误文案与位置属于可读性改进，不作为结构契约。
            "error": !err.trim().is_empty(),
        }),
    }
}

fn build_snapshot() -> Value {
    let mut files = Vec::new();
    bmf_files(&root(), &mut files);
    assert!(
        files.len() >= 3,
        "合成样本不足：{} 个文件；至少要有正常/简单/损坏三类",
        files.len()
    );
    let mut map = serde_json::Map::new();
    for f in &files {
        map.insert(key_of(f), snapshot_for(f));
    }
    json!({ "version": 1, "fixtures": Value::Object(map) })
}

fn write_baseline(snapshot: &Value) {
    let text = serde_json::to_string_pretty(snapshot).expect("基线序列化失败") + "\n";
    fs::write(baseline_path(), text).expect("写基线失败");
}

#[test]
fn synthetic_bmf_structure_matches_baseline() {
    let actual = build_snapshot();

    if std::env::var(UPDATE_ENV).ok().as_deref() == Some("1") {
        write_baseline(&actual);
        println!(
            "已更新基线：{}（请 review diff 后再提交）",
            baseline_path().display()
        );
        return;
    }

    let raw = fs::read_to_string(baseline_path()).unwrap_or_else(|e| {
        panic!(
            "读不到基线 {}：{e}\n首次建立请运行 BMF_BASELINE_UPDATE=1 cargo test --test bmf_structure_baseline",
            baseline_path().display()
        )
    });
    let expected: Value = serde_json::from_str(&raw).expect("基线不是合法 JSON");

    if actual != expected {
        panic!(
            "结构回归：BMF 的语义快照与基线不一致。\n\
             \n=== 期望（基线）===\n{}\n\n=== 实际 ===\n{}\n\n\
             如果这次变化是有意为之，先 review 差异，再运行 \
             BMF_BASELINE_UPDATE=1 cargo test --test bmf_structure_baseline 更新基线。",
            serde_json::to_string_pretty(&expected).unwrap_or_default(),
            serde_json::to_string_pretty(&actual).unwrap_or_default(),
        );
    }
}

/// 反例：基线比较必须能分辨语义差异，否则这条门禁只是「永远绿」。
#[test]
fn normalization_distinguishes_semantic_changes() {
    let mut files = Vec::new();
    bmf_files(&root(), &mut files);
    let simple = files
        .iter()
        .find(|p| p.file_name().is_some_and(|n| n == "demo_simple.bmf"))
        .expect("缺少 demo_simple.bmf 样本");

    let original = BmfDoc::open(simple).unwrap();
    let text = String::from_utf8(original.bytes.clone()).unwrap();
    let mutated_text = text.replace("length=\"200\"", "length=\"100\"");
    assert_ne!(
        text, mutated_text,
        "反例注入没有生效：样本里找不到 length=200"
    );

    let mutated = BmfDoc::from_bytes(simple.clone(), mutated_text.into_bytes()).unwrap();
    assert_ne!(
        normalize_doc(&original),
        normalize_doc(&mutated),
        "字段长度变了，语义快照必须变化"
    );

    // 注释/未知节点的变化不应影响语义快照：它们不是结构。
    let noisy_text = text.replace("<celllist>", "<celllist><!-- 注释不影响结构 -->");
    let noisy = BmfDoc::from_bytes(simple.clone(), noisy_text.into_bytes()).unwrap();
    assert_eq!(
        normalize_doc(&original),
        normalize_doc(&noisy),
        "注释不应影响语义快照"
    );
}

/// 反例：损坏样本必须解析失败。解析器「变宽容」到把残缺 XML 当成功，
/// 会让索引与编辑层在不完整树上工作，这条必须红。
#[test]
fn broken_fixture_still_fails_to_parse() {
    let broken = root().join("baseapp").join("broken.bmf");
    assert!(BmfDoc::open(&broken).is_err(), "损坏样本不应解析成功");
}
