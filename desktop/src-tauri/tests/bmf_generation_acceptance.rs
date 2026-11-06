//! 使用仓库 BMF 夹具核对真实编码、文件与清单；性能采样通过环境变量显式启用。
use nc_forge::bmf_gen_manifest::{self, disk_sha};
use nc_forge::bmf_gen_plan;
use nc_forge::bmf_gen_snapshot::{describe, file_sha, inspect};
use nc_forge::bmf_gen_types::{GenPlan, GenProfile};
use nc_forge::bmf_gen_write::{apply, record};
use nc_forge::bmf_model::BmfDoc;
use std::path::{Path, PathBuf};

fn fixture(relative: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/bmf")
        .join(relative)
}

#[test]
fn current_bmf_preview_write_backup_and_manifest_round_trip() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("structureorg.bmf");
    // 最小解析夹具刻意缺少生成必填项；完整流程使用原始 UAP 业务组件。
    std::fs::copy(fixture("uap-real/structureorg.bmf"), &source).unwrap();
    let mut doc = BmfDoc::open(&source).unwrap();
    nc_forge::bmf_resolve::enrich(&mut doc, &[]);
    let issues = nc_forge::bmf_rules::check_doc(&doc, &source.to_string_lossy());
    assert!(
        !issues.iter().any(|i| i.severity == "error"),
        "{}",
        serde_json::to_string(&issues).unwrap()
    );
    let profile = GenProfile::from_bmf(&doc);
    let plan = bmf_gen_plan::plan(&doc, &profile, &[]);
    assert!(plan.artifacts.iter().any(|a| a.family == "java"));
    assert!(plan.artifacts.iter().any(|a| a.kind == "ddl"));
    let source_text = source.to_string_lossy();
    let root = temp.path().join("gen");
    let selected: Vec<_> = plan
        .artifacts
        .iter()
        .filter(|a| a.kind != "registry")
        .map(|a| a.id.clone())
        .collect();
    let checked = inspect(
        describe(&plan, &doc.component.name, &source_text).unwrap(),
        &root,
        None,
        |p| Ok(p.to_path_buf()),
    )
    .unwrap();
    let result = apply(
        &plan,
        None,
        &root,
        &selected,
        &[],
        &checked.snapshot.unwrap(),
        &temp.path().join("backup"),
        |p| Ok(p.to_path_buf()),
    )
    .unwrap();
    assert_eq!((result.written, result.failed), (selected.len(), 0));
    for a in plan.artifacts.iter().filter(|a| selected.contains(&a.id)) {
        assert_eq!(
            file_sha(&root.join(&a.path_hint)).unwrap(),
            Some(disk_sha(a).unwrap())
        );
    }
    let manifest = record(
        &plan,
        None,
        &result,
        &source,
        &root.to_string_lossy(),
        &nc_forge::bmf_write::sha256(&doc.bytes),
        doc.component.version,
    )
    .unwrap();
    bmf_gen_manifest::save(temp.path(), &doc.component.name, &manifest).unwrap();
    let restored = bmf_gen_manifest::load(temp.path(), &doc.component.name).unwrap();
    assert_eq!(restored.artifacts.len(), selected.len());
    let java = plan.artifacts.iter().find(|a| a.family == "java").unwrap();
    std::fs::write(root.join(&java.path_hint), b"handwritten").unwrap();
    let next = inspect(
        describe(&plan, &doc.component.name, &source_text).unwrap(),
        &root,
        Some(&restored),
        |p| Ok(p.to_path_buf()),
    )
    .unwrap();
    assert_eq!(
        next.items.iter().find(|a| a.id == java.id).unwrap().status,
        "modified"
    );
    let snapshot = next.snapshot.unwrap();
    let preserved = apply(
        &plan,
        Some(&restored),
        &root,
        &selected,
        &[],
        &snapshot,
        &temp.path().join("backup"),
        |p| Ok(p.to_path_buf()),
    )
    .unwrap();
    assert_eq!(preserved.written, 0);
    assert_eq!(
        std::fs::read(root.join(&java.path_hint)).unwrap(),
        b"handwritten"
    );
    let overwritten = apply(
        &plan,
        Some(&restored),
        &root,
        std::slice::from_ref(&java.id),
        std::slice::from_ref(&java.id),
        &snapshot,
        &temp.path().join("backup"),
        |p| Ok(p.to_path_buf()),
    )
    .unwrap();
    assert_eq!((overwritten.written, overwritten.failed), (1, 0));
    assert_eq!(overwritten.items[0].status, "replaced");
    assert_eq!(
        std::fs::read(&overwritten.backups[&java.path_hint]).unwrap(),
        b"handwritten"
    );
    assert_eq!(std::fs::read(source).unwrap(), doc.bytes);
}

fn measured(path: &Path, root: &Path, legacy: bool) -> (f64, GenPlan) {
    let start = std::time::Instant::now();
    if legacy {
        let doc = BmfDoc::open(path).unwrap();
        std::hint::black_box(bmf_gen_plan::plan(&doc, &GenProfile::from_bmf(&doc), &[]));
        let mut validated = BmfDoc::open(path).unwrap();
        nc_forge::bmf_resolve::enrich(&mut validated, &[]);
        std::hint::black_box(nc_forge::bmf_rules::check_doc(
            &validated,
            &path.to_string_lossy(),
        ));
    }
    let mut doc = BmfDoc::open(path).unwrap();
    if !legacy {
        nc_forge::bmf_resolve::enrich(&mut doc, &[]);
        std::hint::black_box(nc_forge::bmf_rules::check_doc(
            &doc,
            &path.to_string_lossy(),
        ));
    }
    let plan = bmf_gen_plan::plan(&doc, &GenProfile::from_bmf(&doc), &[]);
    if legacy {
        std::hint::black_box(bmf_gen_manifest::diff(&plan, None, Some(root)));
    } else {
        inspect(
            describe(&plan, &doc.component.name, &path.to_string_lossy()).unwrap(),
            root,
            None,
            |p| Ok(p.to_path_buf()),
        )
        .unwrap();
    }
    (start.elapsed().as_secs_f64() * 1000.0, plan)
}

fn percentile(values: &[f64], quantile: f64) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    sorted[(sorted.len() as f64 * quantile).ceil() as usize - 1]
}

#[test]
fn saved_bmf_preview_offline_performance_samples() {
    let Ok(report) = std::env::var("NCFORGE_GEN_BENCH_REPORT") else {
        return;
    };
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("gen");
    let mut cases = Vec::new();
    for name in [
        "uapbd/demo_simple.bmf",
        "uap-real/exsystem.bmf",
        "uap-real/structureorg.bmf",
        "uap-real/matters.bmf",
    ] {
        let path = fixture(name);
        let doc = BmfDoc::open(&path).unwrap();
        measured(&path, &root, true);
        let (_, plan) = measured(&path, &root, false);
        let mut legacy_ms = Vec::new();
        let mut current_ms = Vec::new();
        for _ in 0..12 {
            legacy_ms.push(measured(&path, &root, true).0);
            current_ms.push(measured(&path, &root, false).0);
        }
        cases.push(serde_json::json!({
            "fixture": name, "bytes": doc.bytes.len(), "entities": doc.entities.len(),
            "attributes": doc.entities.iter().map(|e| e.attrs.len()).sum::<usize>(),
            "artifacts": plan.artifacts.len(), "samples": 12,
            "legacyP50Ms": percentile(&legacy_ms, 0.5), "legacyP95Ms": percentile(&legacy_ms, 0.95),
            "currentP50Ms": percentile(&current_ms, 0.5), "currentP95Ms": percentile(&current_ms, 0.95),
            "legacyMs": legacy_ms, "currentMs": current_ms
        }));
    }
    let evidence = serde_json::json!({
        "scope": "warm filesystem, debug profile, offline core; excludes IPC, full workspace semantic roots and browser rendering",
        "legacy": {"bmfReads": 3, "plans": 2}, "current": {"bmfReads": 1, "plans": 1},
        "cases": cases
    });
    let output = Path::new(&report);
    std::fs::create_dir_all(output.parent().unwrap()).unwrap();
    std::fs::write(output, serde_json::to_vec_pretty(&evidence).unwrap()).unwrap();
    println!("GEN_BMF_BENCH={evidence}");
}
