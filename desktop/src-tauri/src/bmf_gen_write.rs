//! 逐文件版本核对、备份与写入。批次可部分成功，清单只推进成功项的基线。
use crate::bmf_export::{self, ExportItem};
use crate::bmf_gen_manifest::{self, ApplyResult, Manifest};
use crate::bmf_gen_snapshot::{file_sha, Snapshot};
use crate::bmf_gen_types::{sha256_hex, GenPlan, Timings};
use crate::workspace::TextEncoding;

// 在阻塞池内串行记账，避免不同选择各自覆盖同一清单的成功项。
pub(crate) static GENERATION_WRITE: std::sync::Mutex<()> = std::sync::Mutex::new(());
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};

// 计划、选择、快照和安全解析器显式传入，让写入核对不依赖隐藏的事务状态。
#[allow(clippy::too_many_arguments)]
pub fn apply(
    plan: &GenPlan,
    previous: Option<&Manifest>,
    root: &Path,
    selected: &[String],
    overrides: &[String],
    expected: &Snapshot,
    backup_dir: &Path,
    verify: impl Fn(&Path) -> Result<PathBuf, String>,
) -> Result<ApplyResult, String> {
    let start = std::time::Instant::now();
    let mut chosen = HashSet::new();
    for id in selected {
        if !chosen.insert(id.as_str()) || !plan.artifacts.iter().any(|a| &a.id == id) {
            return Err(format!("产物选择无效或重复：{id}"));
        }
    }
    if overrides.iter().any(|id| !chosen.contains(id.as_str())) {
        return Err("覆盖决策必须属于本次选中的产物".into());
    }
    // 先核对整批选择，避免第一个写完才发现另一个确认已经过期。
    for a in plan
        .artifacts
        .iter()
        .filter(|a| chosen.contains(a.id.as_str()))
    {
        let target = expected
            .targets
            .iter()
            .find(|t| t.id == a.id)
            .ok_or("缺少目标版本，请重新检查")?;
        let path = verify(&bmf_export::safe_join(root, &a.path_hint)?)?;
        if crate::nc_home::strip_verbatim(&path).to_string_lossy() != target.resolved_path {
            return Err(format!("目标真实路径已变化，请重新检查：{}", a.path_hint));
        }
        if file_sha(&path)? != target.target_sha256 {
            return Err(format!("目标文件已变化，请重新检查：{}", a.path_hint));
        }
    }
    let old: HashMap<_, _> = previous
        .into_iter()
        .flat_map(|m| &m.artifacts)
        .map(|a| (a.path.as_str(), a.sha256.as_str()))
        .collect();
    let mut items = Vec::new();
    let mut backups = HashMap::new();
    for a in plan
        .artifacts
        .iter()
        .filter(|a| chosen.contains(a.id.as_str()))
    {
        let target = expected
            .targets
            .iter()
            .find(|t| t.id == a.id)
            .ok_or("缺少目标版本")?;
        let existing = target.target_sha256.as_deref();
        let generated = &target.generated_sha256;
        let changed =
            existing.is_some_and(|h| old.get(a.path_hint.as_str()).is_none_or(|old| *old != h));
        let (status, detail) = if existing == Some(generated.as_str()) {
            ("skipped", "与生成内容一致".to_string())
        } else if changed && !overrides.contains(&a.id) {
            ("skipped", "已保留手改或无基线文件".to_string())
        } else {
            let result = (|| -> Result<(), String> {
                let logical = bmf_export::safe_join(root, &a.path_hint)?;
                let path = verify(&logical)?;
                // 核对实际用于 I/O 的路径，防止解析结果先变更再恢复而通过后续复核。
                if crate::nc_home::strip_verbatim(&path).to_string_lossy() != target.resolved_path {
                    return Err("目标真实路径已变化，未写入".into());
                }
                let bytes = bmf_export::encode(
                    &a.text,
                    if a.encoding.eq_ignore_ascii_case("GBK") {
                        TextEncoding::Gbk
                    } else {
                        TextEncoding::Utf8
                    },
                    a.eol.eq_ignore_ascii_case("CRLF"),
                )?;
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
                }
                if crate::nc_home::strip_verbatim(&verify(&logical)?).to_string_lossy()
                    != target.resolved_path
                {
                    return Err("目标真实路径已变化，未写入".into());
                }
                let mut temp = crate::atomic_file::AtomicTarget::create(&path)?;
                temp.as_file_mut()
                    .write_all(&bytes)
                    .map_err(|e| format!("写临时文件失败：{e}"))?;
                if file_sha(&path)? != target.target_sha256 {
                    return Err("目标文件已变化，未写入".into());
                }
                if existing.is_some() {
                    let path_group =
                        sha256_hex(format!("{}\0{}", expected.root, a.path_hint).as_bytes());
                    let group = backup_dir.join(&path_group[..16]);
                    std::fs::create_dir_all(&group)
                        .map_err(|e| format!("创建备份目录失败：{e}"))?;
                    let unique = tempfile::Builder::new()
                        .prefix("write-")
                        .tempdir_in(&group)
                        .map_err(|e| format!("创建备份目录失败：{e}"))?;
                    let backup = crate::bmf_write::backup(&path, unique.path())?;
                    let _ = unique.keep();
                    if file_sha(Path::new(&backup))? != target.target_sha256 {
                        return Err("备份内容已变化，未覆盖原文件".into());
                    }
                    backups.insert(a.path_hint.clone(), backup);
                    if crate::nc_home::strip_verbatim(&verify(&logical)?).to_string_lossy()
                        != target.resolved_path
                    {
                        return Err("目标真实路径已变化，未写入".into());
                    }
                    if file_sha(&path)? != target.target_sha256 {
                        return Err("备份期间目标文件已变化，未写入".into());
                    }
                    temp.commit()
                } else {
                    temp.commit_new()
                }
            })();
            match result {
                Ok(()) => (
                    if existing.is_some() {
                        "replaced"
                    } else {
                        "written"
                    },
                    a.path_hint.clone(),
                ),
                Err(e) => ("failed", e),
            }
        };
        items.push(ExportItem {
            rel_path: a.path_hint.clone(),
            kind: a.kind.clone(),
            status: status.into(),
            detail,
        });
    }
    Ok(ApplyResult {
        root: expected.root.clone(),
        paths: expected
            .targets
            .iter()
            .filter(|t| chosen.contains(t.id.as_str()))
            .map(|t| (t.path.clone(), t.resolved_path.clone()))
            .collect(),
        written: items
            .iter()
            .filter(|i| i.status == "written" || i.status == "replaced")
            .count(),
        skipped: items.iter().filter(|i| i.status == "skipped").count(),
        failed: items.iter().filter(|i| i.status == "failed").count(),
        items,
        backups,
        manifest: String::new(),
        manifest_error: None,
        timings: Timings {
            write_ms: start.elapsed().as_secs_f64() * 1000.0,
            total_ms: start.elapsed().as_secs_f64() * 1000.0,
            ..Default::default()
        },
    })
}

pub fn record(
    plan: &GenPlan,
    previous: Option<&Manifest>,
    result: &ApplyResult,
    source: &Path,
    root: &str,
    source_sha: &str,
    version: i32,
) -> Result<Manifest, String> {
    let written: HashSet<_> = result
        .items
        .iter()
        .filter(|i| i.status == "written" || i.status == "replaced")
        .map(|i| i.rel_path.as_str())
        .collect();
    let successful = GenPlan {
        artifacts: plan
            .artifacts
            .iter()
            .filter(|a| written.contains(a.path_hint.as_str()))
            .cloned()
            .collect(),
        ..Default::default()
    };
    let mut m = bmf_gen_manifest::build_manifest(
        source,
        root,
        source_sha,
        version,
        &plan.profile_sha256,
        &successful,
    )?;
    let known: HashSet<_> = m.artifacts.iter().map(|a| a.path.clone()).collect();
    if let Some(previous) = previous {
        m.artifacts.extend(
            previous
                .artifacts
                .iter()
                .filter(|a| !known.contains(&a.path))
                .cloned(),
        );
    }
    Ok(m)
}

#[cfg(test)]
#[path = "bmf_gen_write_tests.rs"]
mod tests;
