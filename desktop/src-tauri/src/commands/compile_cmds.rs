//! 编译命令：按文件所在模块调用 ecj，产物写到 `<模块>/classes`（与 Eclipse 一致）。
//!
//! 真正的算法在 `compile.rs` / `nc_index.rs`（纯逻辑，可单测），这里只管：
//! 找 NC home 与 ecj、懒建类索引（带磁盘缓存）、把进度推给前端、把阻塞工作放进后台线程。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tauri::Emitter;

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

/// ecj 候选顺序：外部资源包（按需下载安装）→ 安装包资源目录（v0.1.0 及以前的
/// 旧安装兜底）→ 源码树资源（开发模式）。
fn find_ecj(config_dir: &Path) -> Result<PathBuf, String> {
    let mut cands = Vec::new();
    if let Some(dir) = crate::resource_pack::active_dir(config_dir, crate::resource_pack::PACK_ECJ)
    {
        cands.push(dir.join("ecj-3.17.jar"));
    }
    cands.push(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("ecj")
            .join("ecj-3.17.jar"),
    );
    cands.into_iter().find(|p| p.is_file()).ok_or_else(|| {
        "找不到 Java 编译器组件（ecj）。若刚安装/更新过，请到设置 → 组件里下载；否则检查网络后重试"
            .to_string()
    })
}

/// 首建索引的串行化闸门。
///
/// 不能靠 `CACHE` 锁本身串行：首次冷扫 10~100 秒，持着 CACHE 锁扫盘会让状态轮询、
/// 语言服务、任何读缓存的命令一起干等；更糟的是后到的编译**完全没有反馈**
/// （自己的 log 回调一次都不触发），用户看到的就是「点了编译什么都没发生」。
/// 现在构建期间 CACHE 锁是空着的，等待者排在这把独立的闸门上，并且先收到一行提示。
static INDEX_GATE: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 编译互斥闸：同进程只允许一轮编译。
///
/// 前端有个 `compiling` 标志，但那是前端——切页、双击、命令层面重入都绕得过去。
/// 两轮并发编译会同时往同一个 `<模块>/classes` 写产物，还会抢同一个参数文件。
static COMPILING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 编译闸的 RAII 凭据（drop 即释放，异常路径也不会漏）。
struct CompileSlot;

impl CompileSlot {
    fn acquire() -> Option<Self> {
        COMPILING
            .compare_exchange(
                false,
                true,
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
            )
            .ok()
            .map(|_| CompileSlot)
    }
}

impl Drop for CompileSlot {
    fn drop(&mut self) {
        COMPILING.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// `lookup_index` 的命中结果：类索引 + 该模块上次用到的 jar 序号。
type IndexHit = (Arc<ClassIndex>, Vec<u32>);

/// 已有这个 home 的索引就取出来（短锁），没有则 `None`。
fn lookup_index(nc_home: &Path, module: &str) -> Result<Option<IndexHit>, String> {
    let guard = CACHE.lock().map_err(|_| "内部状态异常".to_string())?;
    let Some(c) = guard.as_ref() else {
        return Ok(None);
    };
    if c.nc_home != nc_home {
        return Ok(None);
    }
    Ok(Some((
        c.index.clone(),
        c.seeds.get(module).cloned().unwrap_or_default(),
    )))
}

/// 取（或首次构建）类索引，并带出该模块上次编译用到的 jar；进程内复用。
/// 首次冷扫约 10~100 秒，之后读磁盘缓存不到 1 秒。编译与语言服务共用这一份。
pub(super) fn cached_index(
    nc_home: &Path,
    cache_path: &Path,
    module: &str,
    log: &(dyn Fn(&str) + Sync),
) -> Result<(Arc<ClassIndex>, Vec<u32>), String> {
    if let Some(hit) = lookup_index(nc_home, module)? {
        return Ok(hit);
    }
    // 先给一行反馈再排队：后到的调用者以前是彻底静默的
    log("类索引还没就绪，正在等待（首次建索引要 10~100 秒）…");
    let _gate = INDEX_GATE.lock().map_err(|_| "内部状态异常".to_string())?;
    // 双重检查：排队期间别人可能刚建完
    if let Some(hit) = lookup_index(nc_home, module)? {
        return Ok(hit);
    }
    log("正在建立 NC 类索引（首次较慢，之后会缓存）…");
    let progress = |done: usize, total: usize| {
        if total > 0 && (done.is_multiple_of(500) || done == total) {
            log(&format!("扫描 jar {done}/{total}"));
        }
    };
    let index =
        ClassIndex::load_or_build(classpath_jars(nc_home), Some(cache_path), Some(&progress));
    let mut guard = CACHE.lock().map_err(|_| "内部状态异常".to_string())?;
    *guard = Some(Cached {
        nc_home: nc_home.to_path_buf(),
        index: Arc::new(index),
        seeds: Default::default(),
    });
    let c = guard.as_ref().ok_or("内部状态异常")?;
    Ok((
        c.index.clone(),
        c.seeds.get(module).cloned().unwrap_or_default(),
    ))
}

/// 解析 `path` 所属的工作区根与模块名。`path` 可以是模块目录，也可以是模块内任一文件。
pub(super) async fn resolve_module(
    state: &AppState,
    path: &str,
) -> Result<(PathBuf, String), String> {
    let root = state
        .config
        .read()
        .await
        .workspace_root
        .clone()
        .ok_or_else(|| "尚未选择工作区目录".to_string())?;
    let target = resolve_safe_path(path, std::slice::from_ref(&root), &[], true)?;
    // resolve_safe_path 返回的是 canonicalize 后带 `\?\` 前缀的路径，工作区根是去掉前缀的，
    // 两边都规整成同一种写法，否则 strip_prefix 永远匹配不上
    let target = PathBuf::from(display_path(&target));
    let root = PathBuf::from(display_path(
        &std::fs::canonicalize(&root).map_err(|e| format!("工作区目录不可用: {e}"))?,
    ));
    let module = compile::module_of(&root, &target).ok_or_else(|| {
        "所选路径不在工作区的某个模块里（工作区根应是 newar 这类包含各模块的目录）".to_string()
    })?;
    Ok((root, module))
}

/// 编译 `path` 所在的模块。`path` 可以是模块目录，也可以是模块内任一文件；
/// 进度以 `compile-log` 事件逐行推给前端，返回值是完整结果（含问题列表）。
#[tauri::command]
pub async fn compile_module(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
) -> Result<CompileResult, String> {
    let (root, module) = resolve_module(&state, &path).await?;
    // NC home 由配置决定（见 nc_home::resolve），编译与启动服务共用同一份解析结果
    let home = nc_home::resolve(state.config.read().await.nc_home.as_deref())?;
    let nc_home = PathBuf::from(&home.root);
    let java = PathBuf::from(&home.java);
    let ecj = find_ecj(&state.config_dir)?;
    let cache_path = state.config_dir.join("class-index.bin");
    let work_dir = state.config_dir.join("tmp");
    let st = state.inner().clone();
    // 新一轮编译：先清掉上一次可能残留的取消标志
    st.compile_cancel
        .store(false, std::sync::atomic::Ordering::SeqCst);

    tauri::async_runtime::spawn_blocking(move || {
        // 同进程只允许一轮编译（前端标志挡不住切页/双击/命令重入）
        let _slot = CompileSlot::acquire()
            .ok_or_else(|| "已有一次编译在进行，等它完成再试（或点「取消」）".to_string())?;
        let log = |s: &str| {
            let _ = app.emit("compile-log", s.to_string());
        };
        let (index, seed) = cached_index(&nc_home, &cache_path, &module, &log)?;
        let env = CompileEnv {
            nc_home: &nc_home,
            java_exe: &java,
            ecj_jar: &ecj,
            project_root: &root,
            index: &index,
            work_dir: &work_dir,
            cancel: Some(&st.compile_cancel),
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

/// 取消当前编译。
///
/// 只置一个标志：ecj 子进程在 40ms 一次的等待循环里被看到就杀掉，轮与轮之间也会检查，
/// 所以最坏 40ms 生效。不做「杀进程表」之类的花活——同一时刻本来就只有一轮编译。
#[tauri::command]
pub fn compile_cancel(state: tauri::State<'_, Arc<AppState>>) {
    state
        .compile_cancel
        .store(true, std::sync::atomic::Ordering::SeqCst);
}
