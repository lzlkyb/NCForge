use super::*;
use crate::bmf_gen_manifest::{disk_sha, ManifestEntry};
use crate::bmf_gen_snapshot::{describe, inspect, same_preview, target_text};
use crate::bmf_gen_types::{Artifact, Family};

fn plan(text: &str) -> GenPlan {
    GenPlan {
        artifacts: vec![Artifact::new(
            "a",
            Family::Java,
            "vo",
            "A.java",
            "src/A.java",
            text,
        )],
        ..Default::default()
    }
}
fn checked(plan: &GenPlan, root: &Path, old: Option<&Manifest>) -> Snapshot {
    inspect(
        describe(plan, "demo", "demo.bmf").unwrap(),
        root,
        old,
        |p| Ok(p.to_path_buf()),
    )
    .unwrap()
    .snapshot
    .unwrap()
}
fn baseline(plan: &GenPlan, root: &Path) -> Manifest {
    bmf_gen_manifest::build_manifest(
        Path::new("demo.bmf"),
        &root.to_string_lossy(),
        "source",
        1,
        "profile",
        plan,
    )
    .unwrap()
}

#[test]
fn empty_selection_has_no_files_or_backups() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("not-created");
    let p = plan("new");
    let r =
        bmf_gen_manifest::apply(&p, None, &root, &[], true, &temp.path().join("backup")).unwrap();
    assert_eq!(r.written, 0);
    assert!(!root.exists());
    assert!(!temp.path().join("backup").exists());
}

#[test]
fn generated_outdated_file_updates_without_hand_edit_override() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("root");
    let old_plan = plan("old\n中文");
    let old = baseline(&old_plan, &root);
    let initial = checked(&old_plan, &root, None);
    apply(
        &old_plan,
        None,
        &root,
        &["a".into()],
        &[],
        &initial,
        &temp.path().join("backup"),
        |p| Ok(p.to_path_buf()),
    )
    .unwrap();
    let next = plan("new\n中文");
    let check = inspect(
        describe(&next, "demo", "demo.bmf").unwrap(),
        &root,
        Some(&old),
        |p| Ok(p.to_path_buf()),
    )
    .unwrap();
    assert_eq!(check.items[0].status, "outdated");
    let r = apply(
        &next,
        Some(&old),
        &root,
        &["a".into()],
        &[],
        &check.snapshot.unwrap(),
        &temp.path().join("backup"),
        |p| Ok(p.to_path_buf()),
    )
    .unwrap();
    assert_eq!(r.written, 1);
    assert_eq!(r.items[0].status, "replaced");
    assert_eq!(
        file_sha(&root.join("src/A.java")).unwrap().unwrap(),
        disk_sha(&next.artifacts[0]).unwrap()
    );
    assert!(Path::new(&r.backups["src/A.java"]).exists());
}

#[test]
fn selection_does_not_authorize_other_handwritten_files() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("root");
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::write(root.join("src/A.java"), b"hand A").unwrap();
    std::fs::write(root.join("src/B.java"), b"hand B").unwrap();
    let mut p = plan("generated A");
    p.artifacts.push(Artifact::new(
        "b",
        Family::Java,
        "vo",
        "B.java",
        "src/B.java",
        "generated B",
    ));
    let r = apply(
        &p,
        None,
        &root,
        &["a".into(), "b".into()],
        &["a".into()],
        &checked(&p, &root, None),
        &temp.path().join("backup"),
        |p| Ok(p.to_path_buf()),
    )
    .unwrap();
    assert_eq!(r.written, 1);
    assert_eq!(r.skipped, 1);
    assert_eq!(std::fs::read(root.join("src/B.java")).unwrap(), b"hand B");
}

#[test]
fn stale_target_rejects_entire_batch_before_first_write() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("root");
    let p = plan("new");
    let check = checked(&p, &root, None);
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::write(root.join("src/A.java"), b"external").unwrap();
    let r = apply(
        &p,
        None,
        &root,
        &["a".into()],
        &["a".into()],
        &check,
        &temp.path().join("backup"),
        |p| Ok(p.to_path_buf()),
    );
    assert!(r.unwrap_err().contains("已变化"));
    assert_eq!(std::fs::read(root.join("src/A.java")).unwrap(), b"external");
    assert!(!temp.path().join("backup").exists());
}

#[test]
fn path_configuration_and_input_are_part_of_preview_version() {
    let root = Path::new("root");
    let original = plan("one");
    let expected = checked(&original, root, None);
    let mut actual = describe(&original, "demo", "demo.bmf").unwrap();
    actual.root = expected.root.clone();
    assert!(same_preview(&actual, &expected));
    let mut changed = actual.clone();
    changed.input_sha256 = "changed-source".into();
    assert!(!same_preview(&changed, &expected));
    let mut changed_plan = original.clone();
    changed_plan.profile.public_src_root = "other".into();
    let mut changed = describe(&changed_plan, "demo", "demo.bmf").unwrap();
    changed.root = expected.root.clone();
    assert!(!same_preview(&changed, &expected));
    actual.root.push_str("-elsewhere");
    assert!(!same_preview(&actual, &expected));
}

#[test]
fn partial_failure_preserves_success_and_previous_baselines() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("root");
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::write(root.join("src/B.java"), b"old B").unwrap();
    let mut p = plan("new A");
    p.artifacts.push(Artifact::new(
        "b",
        Family::Java,
        "vo",
        "B.java",
        "src/B.java",
        "new B",
    ));
    let old = Manifest {
        artifacts: vec![
            ManifestEntry {
                path: "src/B.java".into(),
                family: "java".into(),
                sha256: sha256_hex(b"old B"),
            },
            ManifestEntry {
                path: "src/C.java".into(),
                family: "java".into(),
                sha256: "retained".into(),
            },
        ],
        ..Default::default()
    };
    let backup = temp.path().join("blocked-backup");
    std::fs::write(&backup, b"file").unwrap();
    let r = apply(
        &p,
        Some(&old),
        &root,
        &["a".into(), "b".into()],
        &[],
        &checked(&p, &root, Some(&old)),
        &backup,
        |p| Ok(p.to_path_buf()),
    )
    .unwrap();
    assert_eq!((r.written, r.failed), (1, 1));
    assert_eq!(r.items[0].status, "written");
    assert_eq!(r.items[1].status, "failed");
    let m = record(
        &p,
        Some(&old),
        &r,
        Path::new("demo.bmf"),
        &root.to_string_lossy(),
        "source",
        1,
    )
    .unwrap();
    assert_eq!(m.artifacts.len(), 3);
    assert_eq!(
        m.artifacts
            .iter()
            .find(|a| a.path == "src/B.java")
            .unwrap()
            .sha256,
        sha256_hex(b"old B")
    );
    assert_eq!(
        m.artifacts
            .iter()
            .find(|a| a.path == "src/C.java")
            .unwrap()
            .sha256,
        "retained"
    );
}

#[test]
fn invalid_selection_and_unsafe_paths_write_nothing() {
    let temp = tempfile::tempdir().unwrap();
    let p = plan("one");
    let snapshot = checked(&p, temp.path(), None);
    assert!(apply(
        &p,
        None,
        temp.path(),
        &["invalid".into()],
        &[],
        &snapshot,
        temp.path(),
        |p| Ok(p.to_path_buf())
    )
    .is_err());
    assert!(apply(
        &p,
        None,
        temp.path(),
        &["a".into(), "a".into()],
        &[],
        &snapshot,
        temp.path(),
        |p| Ok(p.to_path_buf())
    )
    .is_err());
    let mut unsafe_plan = p.clone();
    unsafe_plan.artifacts[0].path_hint = "../escape.java".into();
    assert!(inspect(
        describe(&unsafe_plan, "demo", "demo.bmf").unwrap(),
        temp.path(),
        None,
        |p| Ok(p.to_path_buf())
    )
    .is_err());
}

#[test]
fn target_preview_checks_raw_byte_version_and_decodes_gbk() {
    let temp = tempfile::tempdir().unwrap();
    let p = plan("中文\n");
    let snapshot = checked(&p, temp.path(), None);
    let r = apply(
        &p,
        None,
        temp.path(),
        &["a".into()],
        &[],
        &snapshot,
        temp.path(),
        |p| Ok(p.to_path_buf()),
    )
    .unwrap();
    assert_eq!(r.items[0].status, "written");
    let next = checked(&p, temp.path(), None);
    assert_eq!(
        target_text(&next, "a", |p| Ok(p.to_path_buf())).unwrap(),
        "中文\r\n"
    );
    std::fs::write(temp.path().join("src/A.java"), b"changed").unwrap();
    assert!(target_text(&next, "a", |p| Ok(p.to_path_buf()))
        .unwrap_err()
        .contains("已变化"));
}

#[test]
fn gbk_bytes_also_valid_as_utf8_use_declared_encoding() {
    let temp = tempfile::tempdir().unwrap();
    let p = plan("隆");
    std::fs::create_dir_all(temp.path().join("src")).unwrap();
    std::fs::write(temp.path().join("src/A.java"), [0xc2, 0xa1]).unwrap();
    let snapshot = checked(&p, temp.path(), None);
    assert_eq!(
        target_text(&snapshot, "a", |p| Ok(p.to_path_buf())).unwrap(),
        "隆"
    );
}

#[test]
fn resolved_target_change_rejects_identical_bytes() {
    let temp = tempfile::tempdir().unwrap();
    let p = plan("new");
    let snapshot = checked(&p, temp.path(), None);
    let changed = temp.path().join("other/A.java");
    let result = apply(
        &p,
        None,
        temp.path(),
        &["a".into()],
        &[],
        &snapshot,
        temp.path(),
        |_| Ok(changed.clone()),
    );
    assert!(result.unwrap_err().contains("真实路径已变化"));
    assert!(!temp.path().join("src").exists());
}

#[test]
fn transient_resolved_target_change_has_no_directory_or_file_side_effects() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("root");
    let p = plan("new");
    let snapshot = checked(&p, &root, None);
    let redirected = temp.path().join("redirected/A.java");
    let calls = std::cell::Cell::new(0);
    let result = apply(
        &p,
        None,
        &root,
        &["a".into()],
        &[],
        &snapshot,
        &temp.path().join("backup"),
        |logical| {
            calls.set(calls.get() + 1);
            Ok(if calls.get() == 2 {
                redirected.clone()
            } else {
                logical.to_path_buf()
            })
        },
    )
    .unwrap();
    assert_eq!((result.written, result.failed), (0, 1));
    assert!(result.items[0].detail.contains("真实路径已变化"));
    assert!(!temp.path().join("redirected").exists());
    assert!(!root.exists());
    assert!(!temp.path().join("backup").exists());
}

#[test]
fn concurrent_disjoint_selection_keeps_both_ledger_entries() {
    let temp = tempfile::tempdir().unwrap();
    let mut p = plan("A");
    p.artifacts.push(Artifact::new(
        "b",
        Family::Java,
        "vo",
        "B.java",
        "src/B.java",
        "B",
    ));
    let snapshot = checked(&p, temp.path(), None);
    let jobs: Vec<_> = ["a", "b"]
        .into_iter()
        .map(|id| {
            let p = p.clone();
            let snapshot = snapshot.clone();
            let root = temp.path().to_path_buf();
            std::thread::spawn(move || {
                let _guard = GENERATION_WRITE.lock().unwrap();
                let previous = bmf_gen_manifest::load(&root, "demo");
                let result = apply(
                    &p,
                    previous.as_ref(),
                    &root,
                    &[id.into()],
                    &[],
                    &snapshot,
                    &root.join("backup"),
                    |p| Ok(p.to_path_buf()),
                )
                .unwrap();
                let m = record(
                    &p,
                    previous.as_ref(),
                    &result,
                    Path::new("demo.bmf"),
                    &root.to_string_lossy(),
                    "source",
                    1,
                )
                .unwrap();
                bmf_gen_manifest::save(&root, "demo", &m).unwrap();
            })
        })
        .collect();
    for job in jobs {
        job.join().unwrap();
    }
    let ledger = bmf_gen_manifest::load(temp.path(), "demo").unwrap();
    assert_eq!(ledger.artifacts.len(), 2);
    assert!(temp.path().join("src/A.java").exists());
    assert!(temp.path().join("src/B.java").exists());
}
