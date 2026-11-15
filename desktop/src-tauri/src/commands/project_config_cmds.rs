use crate::security::path::{display_path, resolve_safe_path};
use crate::state::AppState;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectEdge {
    from: String,
    to: String,
    exported: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectToolsContext {
    root: String,
    maven: bool,
    gradle: bool,
    projects: Vec<crate::eclipse_cp::LinkedProject>,
    edges: Vec<ProjectEdge>,
}
#[tauri::command]
pub async fn project_tools_context(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<ProjectToolsContext, String> {
    let cfg = state.config.read().await.clone();
    let root = cfg.workspace_root.clone().ok_or("尚未打开工程")?;
    tauri::async_runtime::spawn_blocking(move || {
        let primary = PathBuf::from(&root);
        let overrides = crate::eclipse_cp::active_overrides(&cfg.linked_overrides);
        let projects = crate::eclipse_cp::projects(&primary, &overrides);
        let mut edges = Vec::new();
        for p in &projects {
            if let Some(cp) = p
                .root
                .as_deref()
                .and_then(|r| crate::eclipse_cp::ProjectCp::load(Path::new(r)))
            {
                for reference in cp.refs {
                    edges.push(ProjectEdge {
                        from: p.name.clone(),
                        to: reference.name,
                        exported: reference.exported,
                    });
                }
            }
        }
        Ok(ProjectToolsContext {
            root,
            maven: primary.join("pom.xml").is_file(),
            gradle: primary.join("build.gradle").is_file()
                || primary.join("build.gradle.kts").is_file(),
            projects,
            edges,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentPlan {
    path: String,
    before_text: String,
    expected_text: String,
    expected_mtime_ms: Option<u64>,
    text: String,
    delete: bool,
    encoding: crate::workspace::TextEncoding,
    has_bom: bool,
    eol: crate::workspace::Eol,
}
#[tauri::command]
pub async fn project_plan_attachment(
    state: tauri::State<'_, Arc<AppState>>,
    jar: String,
    source: String,
    javadoc: String,
) -> Result<AttachmentPlan, String> {
    let cfg = state.config.read().await.clone();
    let configured = cfg.workspace_root.clone().ok_or("尚未打开工程")?;
    tauri::async_runtime::spawn_blocking(move || {
        let root = resolve_safe_path(&configured, std::slice::from_ref(&configured), &[], true)?;
        let mut allowed = vec![configured.clone()];
        if let Ok(home) = crate::nc_home::resolve(cfg.nc_home.as_deref()) {
            allowed.push(home.root);
        }
        let overrides = crate::eclipse_cp::active_overrides(&cfg.linked_overrides);
        for p in crate::eclipse_cp::projects(&root, &overrides) {
            if let Some(r) = p.root {
                if !allowed.contains(&r) {
                    allowed.push(r);
                }
            }
        }
        let jar = resolve_safe_path(&jar, &allowed, &[], true)?;
        if !jar.is_file()
            || jar
                .extension()
                .is_none_or(|e| !e.eq_ignore_ascii_case("jar"))
        {
            return Err("请选择工程或 NC 目录中的有效 JAR".into());
        }
        let source = if source.trim().is_empty() {
            None
        } else {
            let path = resolve_safe_path(&source, &allowed, &[], true)?;
            if !path.is_file()
                || path.extension().is_none_or(|e| {
                    !e.eq_ignore_ascii_case("jar") && !e.eq_ignore_ascii_case("zip")
                })
            {
                return Err("源码附件必须是工程或 NC 目录中的 JAR / ZIP".into());
            }
            let file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
            zip::ZipArchive::new(file).map_err(|e| format!("源码附件不是有效归档：{e}"))?;
            Some(path)
        };
        if !javadoc.is_empty()
            && !javadoc.starts_with("https://")
            && !javadoc.starts_with("http://")
            && !javadoc.starts_with("file://")
        {
            return Err("Javadoc 地址须使用 https://、http:// 或 file://".into());
        }
        if javadoc.len() > 2048 {
            return Err("Javadoc 地址过长".into());
        }
        let path = resolve_safe_path(
            &root.join(".classpath").to_string_lossy(),
            std::slice::from_ref(&configured),
            &[],
            true,
        )?;
        let content = crate::workspace::read_text_file(&path)
            .map_err(|_| "项目缺少可读取的 .classpath；请先创建 Eclipse 工程配置")?;
        if !content.lossless || content.eol == crate::workspace::Eol::Mixed {
            return Err(".classpath 的编码或换行不能无损改写".into());
        }
        let text = crate::classpath_sources::plan(
            &root,
            &content.text,
            &jar,
            source.as_deref(),
            &javadoc,
        )?;
        Ok(AttachmentPlan {
            path: display_path(&path),
            before_text: content.text.clone(),
            expected_text: content.text,
            expected_mtime_ms: Some(content.mtime_ms),
            text,
            delete: false,
            encoding: content.encoding,
            has_bom: content.has_bom,
            eol: content.eol,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
