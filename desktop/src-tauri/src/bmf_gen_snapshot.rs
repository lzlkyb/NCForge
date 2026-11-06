//! 生成预览的源、配置、路径和目标字节版本。检查目录复用描述，不重复解析 BMF。
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::bmf_export::safe_join;
use crate::bmf_gen_manifest::{self, ArtifactStatus, Manifest};
use crate::bmf_gen_types::{sha256_hex, GenPlan, Timings};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TargetVersion {
    pub id: String,
    pub path: String,
    pub family: String,
    pub encoding: String,
    pub generated_sha256: String,
    pub target_sha256: Option<String>,
    #[serde(default)]
    pub resolved_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub component: String,
    pub source_path: String,
    pub input_sha256: String,
    pub profile_sha256: String,
    pub root: String,
    pub targets: Vec<TargetVersion>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub snapshot: Option<Snapshot>,
    pub items: Vec<ArtifactStatus>,
    pub error: Option<String>,
    pub manifest: Option<String>,
    pub timings: Timings,
}

pub fn describe(plan: &GenPlan, component: &str, source: &str) -> Result<Snapshot, String> {
    let targets = plan
        .artifacts
        .iter()
        .map(|a| {
            Ok(TargetVersion {
                id: a.id.clone(),
                path: a.path_hint.clone(),
                family: a.family.clone(),
                encoding: a.encoding.clone(),
                generated_sha256: bmf_gen_manifest::disk_sha(a)?,
                target_sha256: None,
                resolved_path: String::new(),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(Snapshot {
        component: component.into(),
        source_path: source.into(),
        input_sha256: plan.input_sha256.clone(),
        // 内容缓存指纹忽略源码根；写入版本必须覆盖完整配置与路径。
        profile_sha256: sha256_hex(&serde_json::to_vec(&plan.profile).map_err(|e| e.to_string())?),
        root: String::new(),
        targets,
    })
}

pub fn file_sha(path: &Path) -> Result<Option<String>, String> {
    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("读取目标失败：{}：{e}", path.display())),
    };
    let mut hash = Sha256::new();
    let mut buf = [0_u8; 65536];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("读取目标失败：{}：{e}", path.display()))?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
    }
    Ok(Some(format!("{:x}", hash.finalize())))
}

pub fn inspect(
    mut snapshot: Snapshot,
    root: &Path,
    manifest: Option<&Manifest>,
    verify: impl Fn(&Path) -> Result<PathBuf, String>,
) -> Result<Check, String> {
    let started = std::time::Instant::now();
    snapshot.root = crate::nc_home::strip_verbatim(root)
        .to_string_lossy()
        .into_owned();
    let old: HashMap<_, _> = manifest
        .into_iter()
        .flat_map(|m| &m.artifacts)
        .map(|a| (a.path.as_str(), a))
        .collect();
    let mut paths = std::collections::HashSet::new();
    let mut items = Vec::new();
    for target in &mut snapshot.targets {
        if !paths.insert(target.path.to_ascii_lowercase()) {
            return Err(format!("产物目标路径重复：{}", target.path));
        }
        let path = verify(&safe_join(root, &target.path)?)?;
        target.resolved_path = crate::nc_home::strip_verbatim(&path)
            .to_string_lossy()
            .into_owned();
        target.target_sha256 = file_sha(&path)?;
        let (status, detail) = match target.target_sha256.as_deref() {
            None => ("new", "文件不存在"),
            Some(h) if h == target.generated_sha256 => ("unchanged", "与生成内容一致"),
            Some(h) => match old.get(target.path.as_str()) {
                Some(entry) if h == entry.sha256 => ("outdated", "原文件与生成基线一致，可更新"),
                Some(_) => ("modified", "生成后被手改，默认保留原文件"),
                None => ("conflict", "文件已存在且无可信生成基线，默认保留"),
            },
        };
        items.push(ArtifactStatus {
            id: target.id.clone(),
            path: target.path.clone(),
            family: target.family.clone(),
            status: status.into(),
            detail: detail.into(),
        });
    }
    if let Some(old) = manifest {
        for a in &old.artifacts {
            if paths.contains(&a.path.to_ascii_lowercase()) {
                continue;
            }
            let path = safe_join(root, &a.path)?;
            verify(&path)?;
            items.push(ArtifactStatus {
                id: format!("orphan:{}", a.path),
                path: a.path.clone(),
                family: a.family.clone(),
                status: "orphan".into(),
                detail: "旧清单产物，保留文件".into(),
            });
        }
    }
    Ok(Check {
        snapshot: Some(snapshot),
        items,
        error: None,
        manifest: manifest.and_then(|m| serde_json::to_string_pretty(m).ok()),
        timings: Timings {
            diff_ms: started.elapsed().as_secs_f64() * 1000.0,
            ..Default::default()
        },
    })
}

pub fn same_preview(actual: &Snapshot, expected: &Snapshot) -> bool {
    actual.component == expected.component
        && actual.source_path == expected.source_path
        && actual.input_sha256 == expected.input_sha256
        && actual.profile_sha256 == expected.profile_sha256
        && actual.root == expected.root
        && actual.targets.len() == expected.targets.len()
        && actual.targets.iter().zip(&expected.targets).all(|(a, b)| {
            let mut before = b.clone();
            before.target_sha256 = None;
            before.resolved_path.clear();
            a == &before
        })
}

pub fn target_text(
    snapshot: &Snapshot,
    id: &str,
    verify: impl Fn(&Path) -> Result<PathBuf, String>,
) -> Result<String, String> {
    let target = snapshot
        .targets
        .iter()
        .find(|a| a.id == id)
        .ok_or("产物已变化，请更新预览")?;
    let path = verify(&safe_join(Path::new(&snapshot.root), &target.path)?)?;
    if crate::nc_home::strip_verbatim(&path).to_string_lossy() != target.resolved_path {
        return Err("目标真实路径已变化，请重新检查目录".into());
    }
    if file_sha(&path)? != target.target_sha256 {
        return Err("目标文件已变化，请重新检查目录".into());
    }
    if target.target_sha256.is_none() {
        return Ok(String::new());
    }
    let size = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
    if size > 4 * 1024 * 1024 {
        return Err("目标文件超过 4MB，请在文件编辑器中查看；原文件默认保留".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    if Some(sha256_hex(&bytes)) != target.target_sha256 {
        return Err("目标文件已变化，请重新检查目录".into());
    }
    if let Some(bytes) = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]) {
        return String::from_utf8(bytes.to_vec()).map_err(|_| "UTF-8 BOM 与内容编码不一致".into());
    }
    if target.encoding.eq_ignore_ascii_case("GBK") {
        let (text, bad) = encoding_rs::GBK.decode_without_bom_handling(&bytes);
        if !bad {
            return Ok(text.into_owned());
        }
    } else if let Ok(text) = std::str::from_utf8(&bytes) {
        return Ok(text.into());
    }
    Err("目标编码无法可靠读取，请在文件编辑器中核对；原文件默认保留".into())
}
