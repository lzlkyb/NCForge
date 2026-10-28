//! 编译命令：按文件所在模块调用 ecj，产物写到 `<模块>/classes`（与 Eclipse 一致）。
//!
//! 真正的算法在 `compile.rs` / `nc_index.rs`（纯逻辑，可单测），这里只管：
//! 找 NC home 与 ecj、懒建类索引（带磁盘缓存）、把进度推给前端、把阻塞工作放进后台线程。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tauri::{Emitter, Manager};

use crate::compile::{self, CompileEnv, CompileJob, CompileResult};
use crate::nc_home;
use crate::nc_index::{classpath_jars, ClassIndex};
use crate::security::path::{display_path, resolve_safe_path};
use crate::state::AppState;

/// 内存里的类索引与各模块上次用到的 jar，进程内复用，避免每次编译重扫 7000 个 jar。
struct Cached {
    nc_home: PathBuf,
    index: Arc<ClassIndex>,
    seeds: std::collections::HashMap<String, Vec<u32>>,
}

static CACHE: Mutex<Option<Cached>> = Mutex::new(None);

/// ecj 先找安装包资源目录，找不到（开发模式）再退回源码树里的资源。
fn find_ecj(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let mut cands = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        cands.push(dir.join("ecj").join("ecj-3.17.jar"));
    }
    cands.push(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("ecj")
            .join("ecj-3.17.jar"),
    );
    cands
        .into_iter()
        .find(|p| p.is_file())
        .ok_or_else(|| "找不到内置的 ecj 编译器（ecj-3.17.jar）".to_string())
}

/// 编译 `path` 所在的模块。`path` 可以是模块目录，也可以是模块内任一文件；
/// 进度以 `compile-log` 事件逐行推给前端，返回值是完整结果（含问题列表）。
#[tauri::command]
pub async fn compile_module(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
) -> Result<CompileResult, String> {
    let root = state
        .config
        .read()
        .await
        .workspace_root
        .clone()
        .ok_or_else(|| "尚未选择工作区目录".to_string())?;
    let target = resolve_safe_path(&path, std::slice::from_ref(&root), &[], true)?;
    // resolve_safe_path 返回的是 canonicalize 后带 `\?\` 前缀的路径，工作区根是去掉前缀的，
    // 两边都规整成同一种写法，否则 strip_prefix 永远匹配不上
    let target = PathBuf::from(display_path(&target));
    let root = PathBuf::from(display_path(
        &std::fs::canonicalize(&root).map_err(|e| format!("工作区目录不可用: {e}"))?,
    ));
    let module = compile::module_of(&root, &target).ok_or_else(|| {
        "所选路径不在工作区的某个模块里（工作区根应是 newar 这类包含各模块的目录）".to_string()
    })?;
    // NC home 由配置决定（见 nc_home::resolve），编译与启动服务共用同一份解析结果
    let home = nc_home::resolve(state.config.read().await.nc_home.as_deref())?;
    let nc_home = PathBuf::from(&home.root);
    let java = PathBuf::from(&home.java);
    let ecj = find_ecj(&app)?;
    let cache_path = state.config_dir.join("class-index.bin");
    let work_dir = state.config_dir.join("tmp");

    tauri::async_runtime::spawn_blocking(move || {
        let log = |s: &str| {
            let _ = app.emit("compile-log", s.to_string());
        };
        // 取（或首次构建）类索引；首次冷扫约 10~100 秒，之后读磁盘缓存不到 1 秒
        let (index, seed) = {
            let mut guard = CACHE.lock().map_err(|_| "内部状态异常".to_string())?;
            if guard.as_ref().map(|c| c.nc_home != nc_home).unwrap_or(true) {
                log("正在建立 NC 类索引（首次较慢，之后会缓存）…");
                let progress = |done: usize, total: usize| {
                    if total > 0 && (done.is_multiple_of(500) || done == total) {
                        let _ = app.emit("compile-log", format!("扫描 jar {done}/{total}"));
                    }
                };
                let index = ClassIndex::load_or_build(
                    classpath_jars(&nc_home),
                    Some(&cache_path),
                    Some(&progress),
                );
                *guard = Some(Cached {
                    nc_home: nc_home.clone(),
                    index: Arc::new(index),
                    seeds: Default::default(),
                });
            }
            let c = guard.as_ref().ok_or("内部状态异常")?;
            (
                c.index.clone(),
                c.seeds.get(&module).cloned().unwrap_or_default(),
            )
        };
        let env = CompileEnv {
            nc_home: &nc_home,
            java_exe: &java,
            ecj_jar: &ecj,
            project_root: &root,
            index: &index,
            work_dir: &work_dir,
        };
        let job = CompileJob {
            out_dir: root.join(&module).join("classes"),
            module: module.clone(),
            files: None,
            seed_jars: seed,
        };
        let result = compile::compile(&env, &job, &log)?;
        if let Ok(mut guard) = CACHE.lock() {
            if let Some(c) = guard.as_mut() {
                c.seeds.insert(module, result.resolved_jars.clone());
            }
        }
        Ok(result)
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}
