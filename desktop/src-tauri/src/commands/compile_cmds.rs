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
use crate::security::path::{display_path, resolve_safe_path_async};
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
    // async 命令链上做路径校验：canonicalize 是同步磁盘操作，走 spawn_blocking，
    // 否则网络盘上几个校验就能把 IPC 层堵住（审查报告 D2）
    let target =
        resolve_safe_path_async(path.to_string(), vec![root.clone()], Vec::new(), true).await?;
    // resolve_safe_path 返回的是 canonicalize 后带 `\?\` 前缀的路径，工作区根是去掉前缀的，
    // 两边都规整成同一种写法，否则 strip_prefix 永远匹配不上。
    // 根的 canonicalize 同样不能在 async 体里同步做，与上面一并丢进阻塞线程。
    let target = PathBuf::from(display_path(&target));
    let root_raw = root.clone();
    let root_canon = tauri::async_runtime::spawn_blocking(move || {
        std::fs::canonicalize(&root_raw).map_err(|e| format!("工作区目录不可用: {e}"))
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))??;
    let root = PathBuf::from(display_path(&root_canon));
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
    // 覆盖表在这里取（async 上下文里读配置），进 spawn_blocking 后只管用
    let overrides =
        crate::eclipse_cp::active_overrides(&state.config.read().await.linked_overrides);

    tauri::async_runtime::spawn_blocking(move || {
        // 同进程只允许一轮编译（前端标志挡不住切页/双击/命令重入）
        let _slot = CompileSlot::acquire()
            .ok_or_else(|| "已有一次编译在进行，等它完成再试（或点「取消」）".to_string())?;
        // 清取消标志必须在**拿到槽之后**：在命令入口清的话，第二个请求（双击/重入）
        // 会把用户刚点给正在跑的那一轮的「取消」悄悄吞掉。
        st.compile_cancel
            .store(false, std::sync::atomic::Ordering::SeqCst);
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
            overrides: &overrides,
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

/// 按依赖顺序编译工作区里的全部模块。
///
/// 与 `compile_module` 的差别只有两点：编哪些、按什么顺序。代价在于**失败即停**——
/// 被依赖的模块编不过时，后面的模块只会报一堆「找不到符号」的连带错误，
/// 那种刷屏比停下来更难定位。
#[tauri::command]
pub async fn compile_all_modules(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<CompileResult, String> {
    let (root, nc_home_cfg, overrides) = {
        let cfg = state.config.read().await;
        let root = cfg
            .workspace_root
            .clone()
            .ok_or_else(|| "尚未选择工作区目录".to_string())?;
        (
            root,
            cfg.nc_home.clone(),
            crate::eclipse_cp::active_overrides(&cfg.linked_overrides),
        )
    };
    // 与 compile_module 同一套规整：工作区根是去掉 `\\?\` 前缀的写法。
    // canonicalize 是同步磁盘操作，丢进 spawn_blocking（审查报告 D2）。
    let root_canon = tauri::async_runtime::spawn_blocking(move || {
        std::fs::canonicalize(&root).map_err(|e| format!("工作区目录不可用: {e}"))
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))??;
    let root = PathBuf::from(display_path(&root_canon));
    let home = nc_home::resolve(nc_home_cfg.as_deref())?;
    let nc_home = PathBuf::from(&home.root);
    let java = PathBuf::from(&home.java);
    let ecj = find_ecj(&state.config_dir)?;
    let cache_path = state.config_dir.join("class-index.bin");
    let work_dir = state.config_dir.join("tmp");
    let st = state.inner().clone();

    tauri::async_runtime::spawn_blocking(move || {
        let _slot = CompileSlot::acquire()
            .ok_or_else(|| "已有一次编译在进行，等它完成再试（或点「取消」）".to_string())?;
        st.compile_cancel
            .store(false, std::sync::atomic::Ordering::SeqCst);
        let log = |s: &str| {
            let _ = app.emit("compile-log", s.to_string());
        };

        // 顺序来自类路径：类路径是「主工程 → 直接依赖 → 传递依赖」，反过来就是「底层先编」
        let dirs = crate::eclipse_cp::class_roots_with(&root, &nc_home, &overrides);
        let mut modules = crate::eclipse_cp::compile_order(&dirs, &root);
        if modules.is_empty() {
            modules = crate::eclipse_cp::module_dirs_of(&root);
        }
        if modules.is_empty() {
            return Err(
                "工作区里没有找到可编译的模块（子目录里应有 src 或 .classpath）".to_string(),
            );
        }
        log(&format!(
            "按依赖顺序编译 {} 个模块：{}",
            modules.len(),
            modules.join(" → ")
        ));

        let mut total = CompileResult {
            ok: true,
            duration_ms: 0,
            source_count: 0,
            error_count: 0,
            warning_count: 0,
            problems: Vec::new(),
            jar_count: 0,
            rounds: 0,
            out_dir: format!("{} 个模块", modules.len()),
            diagnostics: Vec::new(),
            resolved_jars: Vec::new(),
        };
        let mut seeds: Vec<u32> = Vec::new();
        let mut failed: Option<String> = None;

        for (i, module) in modules.iter().enumerate() {
            if st.compile_cancel.load(std::sync::atomic::Ordering::SeqCst) {
                return Err("CANCELLED: 编译已取消".to_string());
            }
            log(&format!("=== {}/{} {} ===", i + 1, modules.len(), module));
            let (index, cached_seed) = cached_index(&nc_home, &cache_path, module, &log)?;
            let seed = if cached_seed.is_empty() {
                seeds.clone()
            } else {
                cached_seed
            };
            let env = CompileEnv {
                nc_home: &nc_home,
                java_exe: &java,
                ecj_jar: &ecj,
                project_root: &root,
                index: &index,
                work_dir: &work_dir,
                cancel: Some(&st.compile_cancel),
                overrides: &overrides,
            };
            let job = CompileJob {
                out_dir: root.join(module).join("classes"),
                module: module.clone(),
                files: None,
                seed_jars: seed,
            };
            let r = compile::compile(&env, &job, &log)?;
            seeds = r.resolved_jars.clone();
            if let Ok(mut guard) = CACHE.lock() {
                if let Some(c) = guard.as_mut() {
                    c.seeds.insert(module.clone(), r.resolved_jars.clone());
                }
            }
            total.duration_ms += r.duration_ms;
            total.source_count += r.source_count;
            total.error_count += r.error_count;
            total.warning_count += r.warning_count;
            total.jar_count = total.jar_count.max(r.jar_count);
            total.rounds += r.rounds;
            total.problems.extend(r.problems);
            total.diagnostics.extend(r.diagnostics);
            log(&format!(
                "{}：{} 个源文件，{} 个错误，{:.1}s",
                module,
                r.source_count,
                r.error_count,
                r.duration_ms as f64 / 1000.0
            ));
            if r.error_count > 0 {
                failed = Some(module.clone());
                break;
            }
        }

        total.ok = total.error_count == 0;
        match failed {
            Some(m) => log(&format!(
                "{m} 编不过，后续模块依赖它的产物，已停止（修完再点一次「编译全部」）"
            )),
            None => log("全部模块编译完成"),
        }
        Ok(total)
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}
