//! 元数据（BMF）命令层。
//!
//! 读：索引、详情、校验、生成预览、发布探针——全部只读，不碰数据库。
//! 写：仅编辑保存与向导新建两处，都先过工作区白名单，且必须由前端显式调用。
//! 这里不做「打开文件就顺手格式化」之类的隐式写入：BMF 里未知节点的字节要原样活着。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::bmf_export;
use crate::bmf_gen::{self, Generation};
use crate::bmf_index::{self, BmfIndex, RootSpec};
use crate::bmf_model::BmfDoc;
use crate::bmf_publish::{self, Probe};
use crate::bmf_refs;
use crate::bmf_rules::{self, Issue};
use crate::bmf_scaffold::{self, Scaffold, ScaffoldSpec};
use crate::bmf_write::{self, EditOp, WriteResult};
use crate::config::AppConfig;
use crate::eclipse_cp;
use crate::security::path::resolve_safe_path;
use crate::state::AppState;

/// 索引范围：主工作区 + 所有链接工程的根目录。
///
/// NC home 的 `modules` 不扫：那是安装目录，组件以万计，索引一次要几十秒；
/// POC 阶段看的是「自己工程里正在改的那几个 BMF」。
fn roots(primary: &Path, overrides: &[eclipse_cp::LinkedOverride]) -> Vec<RootSpec> {
    let mut out = vec![RootSpec {
        origin: "工作区".to_string(),
        path: primary.to_path_buf(),
    }];
    for p in eclipse_cp::projects(primary, overrides) {
        let Some(root) = p.root else { continue };
        let path = PathBuf::from(root);
        if out.iter().any(|r| r.path == path) {
            continue;
        }
        out.push(RootSpec {
            origin: p.name,
            path,
        });
    }
    out
}

fn primary_root(cfg: &AppConfig) -> Result<PathBuf, String> {
    let raw = cfg
        .workspace_root
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "还没有打开工作区：先在文件页选择一个工程".to_string())?;
    Ok(PathBuf::from(raw))
}

/// 写操作的白名单：工作区 + 链接工程。NC 安装目录不在其中。
fn safe_write_path(cfg: &AppConfig, requested: &str) -> Result<PathBuf, String> {
    let primary = primary_root(cfg)?;
    let overrides = eclipse_cp::active_overrides(&cfg.linked_overrides);
    let allowed: Vec<String> = roots(&primary, &overrides)
        .into_iter()
        .map(|r| r.path.to_string_lossy().into_owned())
        .collect();
    resolve_safe_path(requested, &allowed, &[], true)
}

/// 新建文件的目标必须符合索引口径：`<...>/METADATA/<code>.bmf`。
///
/// 后端兜底而不是只靠界面禁用：写在别处的文件索引扫不到，用户会以为创建失败；
/// 文件名与组件编码不一致时，索引里显示的名字和 component/@name 也会对不上。
fn check_scaffold_target(target: &Path, code: &str) -> Result<(), String> {
    let file = target
        .file_name()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let Some(stem) = file.strip_suffix(".bmf") else {
        return Err("目标文件必须以 .bmf 结尾".to_string());
    };
    if stem != code.to_lowercase() {
        return Err(format!("目标文件名应与组件编码一致：{code}.bmf"));
    }
    let parent = target
        .parent()
        .and_then(|p| p.file_name())
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if parent != "metadata" {
        return Err("目标必须放在 METADATA 目录下（否则索引扫不到）".to_string());
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BmfDetail {
    pub path: String,
    pub encoding: String,
    pub eol: String,
    pub bom: bool,
    pub size: usize,
    pub sha256: String,
    pub mtime_ms: u64,
    pub component: crate::bmf_model::BmfComponent,
    pub entities: Vec<crate::bmf_model::Entity>,
    pub enums: Vec<crate::bmf_model::EnumDef>,
    pub relations: Vec<crate::bmf_model::Relation>,
    pub unknown_tags: Vec<String>,
}

/// 扫索引。`force` = 忽略 size+mtime 缓存重扫一遍（文件被外部工具改过时用）。
#[tauri::command]
pub async fn bmf_index_scan(
    state: State<'_, Arc<AppState>>,
    force: Option<bool>,
) -> Result<BmfIndex, String> {
    let (cfg, cache_dir) = {
        let cfg = state.config.read().await.clone();
        (cfg, state.config_dir.clone())
    };
    let primary = primary_root(&cfg)?;
    let overrides = eclipse_cp::active_overrides(&cfg.linked_overrides);
    let list = roots(&primary, &overrides);
    let force = force.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || bmf_index::scan(&list, Some(&cache_dir), force))
    .await
    .map_err(|e| format!("索引任务失败：{e}"))
}

/// 解析一份 BMF 并返回语义模型。只读；解析失败时把「哪一行、什么错」原样带回去。
#[tauri::command]
pub fn bmf_doc_detail(path: String) -> Result<BmfDetail, String> {
    let p = PathBuf::from(&path);
    let doc = BmfDoc::open(&p)?;
    let meta = std::fs::metadata(&p).map_err(|e| format!("读取文件信息失败：{e}"))?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(BmfDetail {
        path,
        encoding: serde_json::to_value(doc.encoding)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_else(|| "UTF-8".to_string()),
        eol: serde_json::to_value(doc.eol)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_else(|| "UNKNOWN".to_string()),
        bom: doc.has_bom,
        size: doc.bytes.len(),
        sha256: bmf_write::sha256(&doc.bytes),
        mtime_ms,
        component: doc.component.clone(),
        entities: doc.entities.clone(),
        enums: doc.enums.clone(),
        relations: doc.relations.clone(),
        unknown_tags: doc.unknown_tags.clone(),
    })
}

/// 结构校验（只读）。不连库：「已发布库结构」的漂移检查要等用户在数据库页连上测试库再做，
/// 这里不替用户猜。
#[tauri::command]
pub fn bmf_validate(path: String) -> Result<Vec<Issue>, String> {
    let doc = BmfDoc::open(Path::new(&path))?;
    Ok(bmf_rules::check_doc(&doc, &path))
}

/// 生成 DDL / VO / 注册清单预览（纯内存，不写盘、不执行 SQL）。
#[tauri::command]
pub fn bmf_generate(path: String, entities: Option<Vec<String>>) -> Result<Generation, String> {
    let doc = BmfDoc::open(Path::new(&path))?;
    Ok(bmf_gen::generate(&doc, entities.as_deref().unwrap_or(&[])))
}

/// 新建向导：只预览，不落盘。返回骨架、字段表与自校验结果。
#[tauri::command]
pub fn bmf_scaffold_preview(spec: ScaffoldSpec) -> Result<Scaffold, String> {
    bmf_scaffold::build(&spec)
}

/// 新建向导落盘：目标已存在 → 拒绝；父目录不存在 → 建出来。
/// 这是 M1 唯一的「新增文件」入口，不会改任何已有文件。
#[tauri::command]
pub async fn bmf_scaffold_write(
    state: State<'_, Arc<AppState>>,
    spec: ScaffoldSpec,
    path: String,
) -> Result<String, String> {
    let target = {
        let cfg = state.config.read().await;
        safe_write_path(&cfg, &path)?
    };
    let code = bmf_scaffold::normalize_ident(&spec.code, "组件编码")?;
    check_scaffold_target(&target, &code)?;
    // resolve_safe_path 会返回 Windows verbatim 路径（`\\?\D:\...`）；回传给前端后
    // 与索引里的普通路径比较会失败，自动选中就永远不生效。
    let written = crate::nc_home::strip_verbatim(&target)
        .to_string_lossy()
        .into_owned();
    let scaffold = bmf_scaffold::build(&spec)?;
    let bytes = scaffold.text.into_bytes();
    tauri::async_runtime::spawn_blocking(move || bmf_write::write_new(&target, &bytes))
        .await
        .map_err(|e| format!("写入任务失败：{e}"))??;
    Ok(written)
}

/// 编辑预览：应用编辑到内存并给出 unified diff，不写盘。
#[tauri::command]
pub fn bmf_edit_preview(path: String, ops: Vec<EditOp>) -> Result<String, String> {
    let doc = BmfDoc::open(Path::new(&path))?;
    let (_, diff) = bmf_write::preview(&doc, &ops)?;
    Ok(diff)
}

/// 编辑保存：确认后的写回。哈希冲突直接拒绝（提示重载），备份失败不写。
///
/// `expected_sha` 是前端打开组件时拿到的 SHA-256。必须在这里比对：`save()` 内部
/// 自己读盘再比，永远「一致」，挡不住「打开后别人改了文件」。
#[tauri::command]
pub async fn bmf_edit_save(
    state: State<'_, Arc<AppState>>,
    path: String,
    ops: Vec<EditOp>,
    expected_sha: Option<String>,
) -> Result<WriteResult, String> {
    let (target, backup_dir) = {
        let cfg = state.config.read().await;
        (safe_write_path(&cfg, &path)?, state.config_dir.join("bmf_backup"))
    };
    tauri::async_runtime::spawn_blocking(move || {
        let current = std::fs::read(&target).map_err(|e| format!("读取 BMF 失败：{e}"))?;
        if let Some(expected) = expected_sha {
            if bmf_write::sha256(&current) != expected {
                return Err("文件已被外部修改（SHA-256 不一致），请重新加载组件后再保存".to_string());
            }
        }
        let doc = BmfDoc::from_bytes(target.clone(), current)?;
        bmf_write::save(&doc, &ops, &backup_dir)
    })
    .await
    .map_err(|e| format!("保存任务失败：{e}"))?
}

/// 生成物落盘（M5）：DDL / VO / UPM / 注册清单写到用户指定目录。
///
/// 目标目录必须在工作区或链接工程内；已有文件默认跳过，`overwrite` 时才备份后重写。
/// 不执行 SQL、不改 NC 安装目录。
#[tauri::command]
pub async fn bmf_gen_export(
    state: State<'_, Arc<AppState>>,
    path: String,
    target_dir: String,
    entities: Option<Vec<String>>,
    overwrite: bool,
) -> Result<bmf_export::ExportResult, String> {
    let (target, backup_dir) = {
        let cfg = state.config.read().await;
        (
            safe_write_path(&cfg, &target_dir)?,
            state.config_dir.join("bmf_backup").join("gen"),
        )
    };
    let doc = BmfDoc::open(Path::new(&path))?;
    let gen = bmf_gen::generate(&doc, entities.as_deref().unwrap_or(&[]));
    let files = bmf_export::plan(&gen, &doc.component.name, &doc.component.namespace);
    let target = crate::nc_home::strip_verbatim(&target).to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        bmf_export::write_all(&target, &files, overwrite, &backup_dir)
    })
    .await
    .map_err(|e| format!("写入任务失败：{e}"))?
}

/// F1 跨工程引用扫描：只读，按类全名找 `typeName` / `refModelName`。
/// 扫描范围与左栏索引同一批文件；坏 XML 计入 skipped，不会让整次扫描失败。
#[tauri::command]
pub async fn bmf_references(
    state: State<'_, Arc<AppState>>,
    path: String,
) -> Result<bmf_refs::RefScan, String> {
    let root_paths: Vec<PathBuf> = {
        let cfg = state.config.read().await;
        let primary = primary_root(&cfg)?;
        let overrides = eclipse_cp::active_overrides(&cfg.linked_overrides);
        roots(&primary, &overrides).into_iter().map(|r| r.path).collect()
    };
    let target = PathBuf::from(path);
    tauri::async_runtime::spawn_blocking(move || {
        let mut files = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for root in root_paths {
            for f in bmf_index::list_bmfs(&root) {
                let norm = f.canonicalize().unwrap_or_else(|_| f.clone());
                if seen.insert(norm) {
                    files.push(f);
                }
            }
        }
        bmf_refs::scan_files(&target, &files)
    })
    .await
    .map_err(|e| format!("扫描任务失败：{e}"))?
}

/// M3 发布探针：只读检查前置条件并生成操作手册，不连库、不发布。
#[tauri::command]
pub async fn bmf_publish_probe(
    state: State<'_, Arc<AppState>>,
    component: String,
    module: String,
    bmf_path: Option<String>,
) -> Result<Probe, String> {
    let home = state.config.read().await.nc_home.clone();
    Ok(bmf_publish::probe(
        home.as_deref(),
        &component,
        &module,
        bmf_path.as_deref(),
    ))
}

#[cfg(test)]
mod tests {
    use super::check_scaffold_target;
    use std::path::Path;

    #[test]
    fn scaffold_target_must_be_metadata_dir_and_match_code() {
        assert!(check_scaffold_target(Path::new("D:/w/uapbd/METADATA/demo.bmf"), "demo").is_ok());
        // 索引目录名与扩展名按 Windows 口径大小写不敏感
        assert!(check_scaffold_target(Path::new("D:/w/uapbd/metadata/DEMO.BMF"), "demo").is_ok());
        assert!(check_scaffold_target(Path::new("D:/w/uapbd/demo.bmf"), "demo")
            .unwrap_err()
            .contains("METADATA"));
        assert!(check_scaffold_target(Path::new("D:/w/uapbd/METADATA/demo.xml"), "demo")
            .unwrap_err()
            .contains(".bmf"));
        assert!(check_scaffold_target(Path::new("D:/w/uapbd/METADATA/other.bmf"), "demo")
            .unwrap_err()
            .contains("组件编码"));
    }
}
