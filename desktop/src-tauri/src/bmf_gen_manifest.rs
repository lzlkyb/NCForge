//! 生成清单与漂移检测。
//!
//! 清单落在 `{config_dir}/generation/<组件>.json`，记录 BMF/配置/产物三组哈希：
//! - BMF 变了但产物没重生成 → 目标文件哈希仍等于清单值，状态 `outdated`。
//! - 产物被手改 → 文件哈希 != 清单值，状态 `modified-since-generation`。
//! - 清单里有、本次产物图里没有 → `orphan`。
//!
//! 落盘复用 `bmf_export::write_all`（原子写 + 备份 + 默认不覆盖），这里只负责
//! 「该不该写」的判定，不另开一套写文件逻辑。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::bmf_export;
use crate::bmf_gen_types::{sha256_hex, Artifact, GenPlan, Timings};
use crate::workspace::TextEncoding;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub bmf_path: String,
    /// 上次落盘根目录。换根（另一个工程）时旧清单不能拿来判「被手改」。
    pub root: String,
    pub bmf_sha256: String,
    pub bmf_version: i32,
    pub tool_version: String,
    pub profile_sha256: String,
    pub generated_at: u64,
    pub artifacts: Vec<ManifestEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestEntry {
    pub path: String,
    pub family: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactStatus {
    pub id: String,
    pub path: String,
    pub family: String,
    /// new | unchanged | outdated | modified | conflict | orphan
    pub status: String,
    pub detail: String,
}

impl ArtifactStatus {
    pub fn can_write(&self, force: bool) -> bool {
        match self.status.as_str() {
            "new" | "outdated" => true,
            "unchanged" => false,
            "modified" | "conflict" => force,
            _ => false,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffResult {
    pub items: Vec<ArtifactStatus>,
    pub manifest: Option<String>,
    pub timings: Timings,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub root: String,
    pub written: usize,
    pub skipped: usize,
    pub failed: usize,
    pub items: Vec<bmf_export::ExportItem>,
    pub backups: HashMap<String, String>,
    pub paths: HashMap<String, String>,
    pub manifest_error: Option<String>,
    /// 命令层写完清单后回填，供前端显示落点。
    pub manifest: String,
    pub timings: Timings,
}

pub fn manifest_path(config_dir: &Path, component: &str) -> PathBuf {
    config_dir
        .join("generation")
        .join(format!("{}.json", safe_name(component)))
}

fn safe_name(s: &str) -> String {
    let out: String = s
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if out.is_empty() {
        "component".into()
    } else {
        out
    }
}

pub fn load(config_dir: &Path, component: &str) -> Option<Manifest> {
    let p = manifest_path(config_dir, component);
    let bytes = std::fs::read(p).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub fn save(config_dir: &Path, component: &str, m: &Manifest) -> Result<PathBuf, String> {
    let p = manifest_path(config_dir, component);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建清单目录失败：{e}"))?;
    }
    let bytes = serde_json::to_vec_pretty(m).map_err(|e| format!("序列化清单失败：{e}"))?;
    crate::atomic_file::write_atomic(&p, &bytes)?;
    Ok(p)
}

pub fn build_manifest(
    bmf_path: &Path,
    root: &str,
    bmf_sha256: &str,
    bmf_version: i32,
    profile_sha256: &str,
    plan: &GenPlan,
) -> Result<Manifest, String> {
    let mut entries = Vec::new();
    for a in &plan.artifacts {
        entries.push(ManifestEntry {
            path: a.path_hint.clone(),
            family: a.family.clone(),
            sha256: disk_sha(a)?,
        });
    }
    Ok(Manifest {
        bmf_path: bmf_path.to_string_lossy().into_owned(),
        root: root.to_string(),
        bmf_sha256: bmf_sha256.to_string(),
        bmf_version,
        tool_version: env!("CARGO_PKG_VERSION").to_string(),
        profile_sha256: profile_sha256.to_string(),
        generated_at: now_ms(),
        artifacts: entries,
    })
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn encoding_of(a: &Artifact) -> TextEncoding {
    if a.encoding.eq_ignore_ascii_case("GBK") {
        TextEncoding::Gbk
    } else {
        TextEncoding::Utf8
    }
}

/// 产物按目标编码/换行编码后的字节哈希。清单与磁盘比较必须用这个口径；
/// 用 `Artifact::sha256`（UTF-8/LF 文本）比会把所有 GBK/CRLF 文件误判成「被手改」。
pub fn disk_sha(a: &Artifact) -> Result<String, String> {
    let bytes = bmf_export::encode(&a.text, encoding_of(a), a.eol.eq_ignore_ascii_case("CRLF"))?;
    Ok(sha256_hex(&bytes))
}

/// 对比「计划产物」与「清单 + 磁盘」。`root` 为空时只看清单（不读盘）。
pub fn diff(
    plan: &GenPlan,
    manifest: Option<&Manifest>,
    root: Option<&Path>,
) -> Vec<ArtifactStatus> {
    let by_path: HashMap<&str, &ManifestEntry> = manifest
        .map(|m| m.artifacts.iter().map(|e| (e.path.as_str(), e)).collect())
        .unwrap_or_default();
    let mut out = Vec::new();
    let mut planned: HashMap<&str, ()> = HashMap::new();
    for a in &plan.artifacts {
        planned.insert(a.path_hint.as_str(), ());
        let expected = disk_sha(a).unwrap_or_else(|_| a.sha256.clone());
        let entry = by_path.get(a.path_hint.as_str()).copied();
        let disk = root
            .and_then(|r| std::fs::read(r.join(&a.path_hint)).ok())
            .map(|b| sha256_hex(&b));
        let (status, detail) = match disk {
            None if root.is_some() => ("new".to_string(), "文件不存在".to_string()),
            None => (
                "new".to_string(),
                "未指定落盘根目录，未检查磁盘".to_string(),
            ),
            Some(h) if h == expected => ("unchanged".to_string(), "与计划一致".to_string()),
            Some(h) => match entry {
                None => (
                    "conflict".to_string(),
                    "文件已存在且无生成清单，覆盖前需显式确认".to_string(),
                ),
                Some(e) if e.sha256 == h && e.sha256 != expected => (
                    "outdated".to_string(),
                    "清单一致但计划已变化，可安全重写".to_string(),
                ),
                Some(e) if e.sha256 != h => (
                    "modified".to_string(),
                    "生成后文件被手改，覆盖会丢改动".to_string(),
                ),
                Some(_) => (
                    "outdated".to_string(),
                    "文件与清单不一致但计划相同，按计划重写".to_string(),
                ),
            },
        };
        out.push(ArtifactStatus {
            id: a.id.clone(),
            path: a.path_hint.clone(),
            family: a.family.clone(),
            status,
            detail,
        });
    }
    if let Some(m) = manifest {
        for e in &m.artifacts {
            if !planned.contains_key(e.path.as_str()) {
                out.push(ArtifactStatus {
                    id: format!("orphan:{}", e.path),
                    path: e.path.clone(),
                    family: e.family.clone(),
                    status: "orphan".into(),
                    detail: "清单里有、当前 BMF 已不再生成".into(),
                });
            }
        }
    }
    out
}

/// 落盘选中的产物。`force=false` 时不覆盖 modified/conflict；`outdated` 可以重写。
///
/// 不在这里写清单：清单要带 BMF 指纹，由命令层在写完后用 `build_manifest` + `save`
/// 落一份新的，避免本函数同时承担「判定」和「记账」两件事。
pub fn apply(
    plan: &GenPlan,
    manifest: Option<&Manifest>,
    root: &Path,
    selected: &[String],
    force: bool,
    backup_dir: &Path,
) -> Result<ApplyResult, String> {
    if selected.is_empty() {
        return Ok(ApplyResult::default());
    }
    let snapshot = crate::bmf_gen_snapshot::describe(plan, "", "")?;
    let expected =
        crate::bmf_gen_snapshot::inspect(snapshot, root, manifest, |p| Ok(p.to_path_buf()))?
            .snapshot
            .ok_or("目录检查未完成")?;
    let overrides = if force { selected.to_vec() } else { Vec::new() };
    crate::bmf_gen_write::apply(
        plan,
        manifest,
        root,
        selected,
        &overrides,
        &expected,
        backup_dir,
        |p| Ok(p.to_path_buf()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bmf_gen_types::{Artifact, Family};

    fn art(id: &str, path: &str, text: &str) -> Artifact {
        Artifact::new(id, Family::Java, "vo", "A.java", path, text)
    }

    fn plan_of(items: Vec<Artifact>) -> GenPlan {
        GenPlan {
            artifacts: items,
            ..Default::default()
        }
    }

    #[test]
    fn disk_hash_uses_target_encoding_not_text() {
        let a = art("a", "src/A.java", "class A {}\n中文\n");
        let text_sha = a.sha256.clone();
        let disk = disk_sha(&a).unwrap();
        assert_ne!(text_sha, disk, "GBK/CRLF 后哈希必须变化");
        assert_eq!(disk.len(), 64);
    }

    #[test]
    fn diff_detects_new_unchanged_modified_conflict_orphan() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        std::fs::create_dir_all(root.join("src")).unwrap();

        let a = art("a", "src/A.java", "A\n");
        let b = art("b", "src/B.java", "B\n");
        let plan = plan_of(vec![a.clone(), b.clone()]);

        let statuses = diff(&plan, None, Some(&root));
        assert!(statuses.iter().all(|s| s.status == "new"));

        // a 按计划写盘 → unchanged；b 手写成别的内容 → conflict（无清单）
        std::fs::write(
            root.join("src/A.java"),
            bmf_export::encode(&a.text, TextEncoding::Gbk, true).unwrap(),
        )
        .unwrap();
        std::fs::write(root.join("src/B.java"), b"handwritten").unwrap();
        let statuses = diff(&plan, None, Some(&root));
        assert_eq!(
            statuses.iter().find(|s| s.id == "a").unwrap().status,
            "unchanged"
        );
        assert_eq!(
            statuses.iter().find(|s| s.id == "b").unwrap().status,
            "conflict"
        );

        // 清单记录 b 的「旧内容」→ b 变成 modified
        let mut m = Manifest::default();
        m.artifacts.push(ManifestEntry {
            path: "src/B.java".into(),
            family: "java".into(),
            sha256: sha256_hex(b"old"),
        });
        m.artifacts.push(ManifestEntry {
            path: "src/Gone.java".into(),
            family: "java".into(),
            sha256: sha256_hex(b"gone"),
        });
        let statuses = diff(&plan, Some(&m), Some(&root));
        assert_eq!(
            statuses.iter().find(|s| s.id == "b").unwrap().status,
            "modified"
        );
        assert!(statuses.iter().any(|s| s.status == "orphan"));
    }

    #[test]
    fn apply_refuses_modified_without_force() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        std::fs::create_dir_all(root.join("src")).unwrap();
        let a = art("a", "src/A.java", "A\n");
        let plan = plan_of(vec![a.clone()]);
        std::fs::write(root.join("src/A.java"), b"handwritten").unwrap();

        let r = apply(
            &plan,
            None,
            &root,
            &["a".into()],
            false,
            &dir.path().join("bak"),
        )
        .unwrap();
        assert_eq!(r.written, 0);
        assert_eq!(
            std::fs::read(root.join("src/A.java")).unwrap(),
            b"handwritten"
        );

        let r = apply(
            &plan,
            None,
            &root,
            &["a".into()],
            true,
            &dir.path().join("bak"),
        )
        .unwrap();
        assert_eq!(r.written, 1);
        // 覆盖后应是计划内容（GBK + CRLF），不是手写的那份。
        assert_ne!(
            std::fs::read(root.join("src/A.java")).unwrap(),
            b"handwritten"
        );
    }
}
