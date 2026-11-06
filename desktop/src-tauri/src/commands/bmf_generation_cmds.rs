//! 当前 BMF 生成工作台：一次预览、可复用目录检查、版本绑定的逐文件写入。
use super::bmf_cmds::{safe_write_path, semantic_roots};
use crate::bmf_gen_manifest::{self, ApplyResult, Manifest};
use crate::bmf_gen_snapshot::{self, Check, Snapshot};
use crate::bmf_gen_types::{GenPlan, GenProfile, Timings};
use crate::bmf_model::BmfDoc;
use crate::bmf_rules::{self, Issue};
use crate::config::AppConfig;
use crate::state::AppState;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;
use tauri::State;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub plan: GenPlan,
    pub issues: Vec<Issue>,
    pub description: Snapshot,
    pub check: Check,
}

fn root_path(cfg: &AppConfig, root: &str) -> Result<PathBuf, String> {
    if root.trim().is_empty() {
        return Err("请选择输出目录".into());
    }
    safe_write_path(cfg, root.trim())
}

fn ledger_key(snapshot: &Snapshot) -> String {
    let key = crate::bmf_gen_types::sha256_hex(
        format!("{}\0{}", snapshot.source_path, snapshot.root).as_bytes(),
    );
    format!("{}-{}", snapshot.component, &key[..16])
}

fn previous(config_dir: &Path, snapshot: &Snapshot) -> Option<Manifest> {
    bmf_gen_manifest::load(config_dir, &ledger_key(snapshot))
        .or_else(|| bmf_gen_manifest::load(config_dir, &snapshot.component))
        .filter(|m| m.bmf_path == snapshot.source_path && m.root == snapshot.root)
}

fn check(cfg: &AppConfig, config_dir: &Path, mut description: Snapshot, raw_root: &str) -> Check {
    let inspected = (|| {
        let root = root_path(cfg, raw_root)?;
        description.root = crate::nc_home::strip_verbatim(&root)
            .to_string_lossy()
            .into_owned();
        let previous = previous(config_dir, &description);
        bmf_gen_snapshot::inspect(description, &root, previous.as_ref(), |p| {
            safe_write_path(cfg, &p.to_string_lossy())
        })
    })();
    inspected.unwrap_or_else(|error| Check {
        snapshot: None,
        items: Vec::new(),
        error: Some(error),
        manifest: None,
        timings: Timings::default(),
    })
}

#[tauri::command]
pub async fn bmf_gen_preview(
    state: State<'_, Arc<AppState>>,
    path: String,
    profile: Option<GenProfile>,
    entities: Option<Vec<String>>,
    root: String,
) -> Result<Preview, String> {
    let cfg = state.config.read().await.clone();
    let config_dir = state.config_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let start = Instant::now();
        let source = safe_write_path(&cfg, &path)?;
        let mut doc = BmfDoc::open(&source)?;
        let parse_ms = start.elapsed().as_secs_f64() * 1000.0;
        crate::bmf_resolve::enrich(&mut doc, &semantic_roots(&cfg));
        let validated = Instant::now();
        let issues = bmf_rules::check_doc(&doc, &path);
        let validate_ms = validated.elapsed().as_secs_f64() * 1000.0;
        let profile = profile.unwrap_or_else(|| GenProfile::from_bmf(&doc));
        let mut plan =
            crate::bmf_gen_plan::plan(&doc, &profile, entities.as_deref().unwrap_or(&[]));
        let description = bmf_gen_snapshot::describe(&plan, &doc.component.name, &path)?;
        let check = check(&cfg, &config_dir, description.clone(), &root);
        plan.timings.parse_ms = parse_ms;
        plan.timings.validate_ms = validate_ms;
        plan.timings.diff_ms = check.timings.diff_ms;
        plan.timings.total_ms = start.elapsed().as_secs_f64() * 1000.0;
        Ok(Preview {
            plan,
            issues,
            description,
            check,
        })
    })
    .await
    .map_err(|e| format!("生成预览失败：{e}"))?
}

#[tauri::command]
pub async fn bmf_gen_check(
    state: State<'_, Arc<AppState>>,
    description: Snapshot,
    root: String,
) -> Result<Check, String> {
    let cfg = state.config.read().await.clone();
    let config_dir = state.config_dir.clone();
    tauri::async_runtime::spawn_blocking(move || check(&cfg, &config_dir, description, &root))
        .await
        .map_err(|e| format!("目录检查失败：{e}"))
}

#[tauri::command]
pub async fn bmf_gen_target(
    state: State<'_, Arc<AppState>>,
    snapshot: Snapshot,
    id: String,
) -> Result<String, String> {
    let cfg = state.config.read().await.clone();
    tauri::async_runtime::spawn_blocking(move || {
        bmf_gen_snapshot::target_text(&snapshot, &id, |p| {
            safe_write_path(&cfg, &p.to_string_lossy())
        })
    })
    .await
    .map_err(|e| format!("读取原文件失败：{e}"))?
}

/// 打开生成物所在目录；范围为工作区与应用自己的生成清单/备份。
#[tauri::command]
pub async fn bmf_gen_reveal(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    path: String,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let cfg = state.config.read().await;
    let allowed = [
        state.config_dir.join("generation"),
        state.config_dir.join("bmf_backup/gen"),
    ];
    let resolved = safe_write_path(&cfg, &path).or_else(|_| {
        crate::security::path::resolve_safe_path(
            &path,
            &allowed
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect::<Vec<_>>(),
            &[],
            true,
        )
    })?;
    let canonical = resolved
        .canonicalize()
        .map_err(|e| format!("文件或目录不可用：{e}"))?;
    if canonical.is_dir() {
        app.opener()
            .open_path(canonical.to_string_lossy(), None::<&str>)
            .map_err(|e| e.to_string())
    } else {
        app.opener()
            .reveal_item_in_dir(canonical)
            .map_err(|e| e.to_string())
    }
}

// 保留旧生成入口的平铺参数，同时独立传递预览版本与逐文件覆盖授权。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn bmf_gen_apply(
    state: State<'_, Arc<AppState>>,
    path: String,
    profile: Option<GenProfile>,
    entities: Option<Vec<String>>,
    root: String,
    selected: Option<Vec<String>>,
    force: Option<bool>,
    expected: Option<Snapshot>,
    overrides: Option<Vec<String>>,
) -> Result<ApplyResult, String> {
    // 显式空选择零副作用；省略选择仍兼容历史「全部」，但所有写入都需要检查版本。
    if selected.as_ref().is_some_and(Vec::is_empty) {
        return Ok(ApplyResult::default());
    }
    let expected = expected.ok_or("请先更新产物并检查输出目录，再确认写入")?;
    let cfg = state.config.read().await.clone();
    let config_dir = state.config_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = crate::bmf_gen_write::GENERATION_WRITE
            .lock()
            .map_err(|_| "生成写入锁不可用")?;
        let start = Instant::now();
        let source = safe_write_path(&cfg, &path)?;
        let mut doc = BmfDoc::open(&source)?;
        crate::bmf_resolve::enrich(&mut doc, &semantic_roots(&cfg));
        if bmf_rules::check_doc(&doc, &path)
            .iter()
            .any(|i| i.severity == "error")
        {
            return Err("存在校验错误，请返回元数据修复后重新预览".into());
        }
        let profile = profile.unwrap_or_else(|| GenProfile::from_bmf(&doc));
        let plan = crate::bmf_gen_plan::plan(&doc, &profile, entities.as_deref().unwrap_or(&[]));
        let root = root_path(&cfg, &root)?;
        let root_text = crate::nc_home::strip_verbatim(&root)
            .to_string_lossy()
            .into_owned();
        let mut actual = bmf_gen_snapshot::describe(&plan, &doc.component.name, &path)?;
        actual.root = root_text.clone();
        if !bmf_gen_snapshot::same_preview(&actual, &expected) {
            return Err("源文件、配置或输出路径已变化，请更新产物并重新确认".into());
        }
        let selected =
            selected.unwrap_or_else(|| plan.artifacts.iter().map(|a| a.id.clone()).collect());
        let overrides = overrides.unwrap_or_else(|| {
            if force.unwrap_or(false) {
                selected.clone()
            } else {
                Vec::new()
            }
        });
        if bmf_gen_snapshot::file_sha(&source)? != Some(crate::bmf_write::sha256(&doc.bytes)) {
            return Err("源文件在生成期间已变化，请重新预览".into());
        }
        let previous = previous(&config_dir, &actual);
        let mut result = crate::bmf_gen_write::apply(
            &plan,
            previous.as_ref(),
            &root,
            &selected,
            &overrides,
            &expected,
            &config_dir.join("bmf_backup/gen"),
            |p| safe_write_path(&cfg, &p.to_string_lossy()),
        )?;
        if result.written > 0 {
            let saved = crate::bmf_gen_write::record(
                &plan,
                previous.as_ref(),
                &result,
                Path::new(&path),
                &root_text,
                &crate::bmf_write::sha256(&doc.bytes),
                doc.component.version,
            )
            .and_then(|m| bmf_gen_manifest::save(&config_dir, &ledger_key(&actual), &m));
            match saved {
                Ok(p) => result.manifest = p.to_string_lossy().into_owned(),
                Err(e) => result.manifest_error = Some(e),
            }
        }
        result.timings.total_ms = start.elapsed().as_secs_f64() * 1000.0;
        Ok(result)
    })
    .await
    .map_err(|e| format!("写入任务失败：{e}"))?
}
