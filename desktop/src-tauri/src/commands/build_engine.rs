//! 构建引擎：把「算布局 / 读清单 / 决定增量 / 跑 ecj / 写回账本 / 清旧产物」
//! 收在一处，命令层只做参数解析、锁与事件。
//!
//! 为什么不让每个命令各写一遍：`compile_module`、`compile_all`、`rebuild`、
//! 保存后的增量都会走这条链；任何一处漏写清单或漏清旧 class，表现都是
//! 「这次编过了，下次又冒出幽灵类」，而且极难复现。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::Emitter;

use crate::build_layout::ModuleLayout;
use crate::build_state::{self, CleanReport, Decision, Manifest};
use crate::compile::{self, CompileEnv, CompileJob, CompileResult, ModuleBuildResult};
use crate::nc_home;
use crate::nc_index::ClassIndex;
use crate::state::AppState;

use super::compile_cmds::{cached_index, deploy_after_compile, find_ecj, CompileSlot};

/// 一次构建的上下文：路径、覆盖表、配置目录都在里面，避免每个函数再解一遍。
pub(super) struct Ctx {
    pub app: tauri::AppHandle,
    pub st: Arc<AppState>,
    pub root: PathBuf,
    pub nc_home: PathBuf,
    pub java: PathBuf,
    pub ecj: PathBuf,
    /// 常驻 ecj 桥 jar；`None` = 回退一次一进程。
    pub ecj_bridge: Option<PathBuf>,
    pub cache_path: PathBuf,
    pub work_dir: PathBuf,
    pub config_dir: PathBuf,
    pub overrides: Vec<crate::eclipse_cp::LinkedOverride>,
    pub deploy_on_start: bool,
    /// 独立模块并行的上限（1 = 串行）。
    pub parallel: usize,
    /// 热替换开关（`hotswap_enabled` / `hotswap_auto`），取自本轮开始时的配置。
    pub hotswap_enabled: bool,
    pub hotswap_auto: bool,
}

impl Ctx {
    pub fn log(&self, s: &str) {
        let _ = self.app.emit("compile-log", s.to_string());
    }

    fn log_module(&self, module: &str, s: &str) {
        self.log(&format!("[{module}] {s}"));
    }

    fn progress(
        &self,
        phase: &str,
        done: usize,
        total: usize,
        module: Option<&str>,
        elapsed_ms: u64,
    ) {
        let _ = self.app.emit(
            "build-progress",
            serde_json::json!({
                "phase": phase,
                "done": done,
                "total": total,
                "module": module,
                "elapsedMs": elapsed_ms,
            }),
        );
    }

    pub fn manifest(&self, module: &str) -> Option<Manifest> {
        build_state::read_manifest(
            &build_state::manifest_path(&self.config_dir, &self.root, module),
            &self.root,
            module,
        )
    }

    pub fn manifest_file(&self, module: &str) -> PathBuf {
        build_state::manifest_path(&self.config_dir, &self.root, module)
    }

    fn index(&self, module: &str) -> Result<(Arc<ClassIndex>, Vec<u32>), String> {
        let (index, seed) =
            cached_index(&self.nc_home, &self.cache_path, module, &|s| self.log(s))?;
        Ok((index, seed))
    }

    fn env<'a>(&'a self, index: &'a ClassIndex) -> CompileEnv<'a> {
        CompileEnv {
            nc_home: &self.nc_home,
            java_exe: &self.java,
            ecj_jar: &self.ecj,
            worker_jar: self.ecj_bridge.as_deref(),
            project_root: &self.root,
            index,
            work_dir: &self.work_dir,
            cancel: Some(&self.st.compile_cancel),
            overrides: &self.overrides,
        }
    }

    fn deploy(&self) {
        deploy_after_compile(
            self.deploy_on_start,
            &self.config_dir,
            &self.root,
            &self.nc_home,
            &self.overrides,
            &|s| self.log(s),
        );
    }
}

/// 取上下文。`root` 取配置里的工作区；NC home / ecj / java 与单模块编译同一套解析。
pub(super) async fn context(app: tauri::AppHandle, state: &Arc<AppState>) -> Result<Ctx, String> {
    let (_root_raw, root) = super::compile_cmds::workspace_roots(state).await?;
    let (nc_home_cfg, overrides, deploy_on_start, parallel, persistent, hotswap) = {
        let cfg = state.config.read().await;
        (
            cfg.nc_home.clone(),
            crate::eclipse_cp::active_overrides(&cfg.linked_overrides),
            cfg.deploy_on_start,
            (cfg.build_parallel as usize).clamp(1, 4),
            cfg.persistent_worker,
            (cfg.hotswap_enabled, cfg.hotswap_auto),
        )
    };
    let home = nc_home::resolve(nc_home_cfg.as_deref())?;
    let nc_home = PathBuf::from(&home.root);
    let java = PathBuf::from(&home.java);
    let ecj = find_ecj(&state.config_dir)?;
    // 关掉常驻开关时不把桥 jar 交给编译层：`run_ecj` 会走一次一进程，行为与加常驻之前一致
    let ecj_bridge = if persistent {
        super::compile_cmds::find_ecj_bridge(&app)
    } else {
        None
    };
    let cache_path = index_cache_path(&state.config_dir, &nc_home);
    let work_dir = state.config_dir.join("tmp");
    Ok(Ctx {
        app,
        st: state.clone(),
        root,
        nc_home,
        java,
        ecj,
        ecj_bridge,
        cache_path,
        work_dir,
        config_dir: state.config_dir.clone(),
        overrides,
        deploy_on_start,
        parallel,
        hotswap_enabled: hotswap.0,
        hotswap_auto: hotswap.1,
    })
}

/// 类索引按 NC home 分文件：换 home 不会拿另一套 jar 的索引冒充。
pub(super) fn index_cache_path(config_dir: &Path, nc_home: &Path) -> PathBuf {
    config_dir.join(format!(
        "class-index-{}.bin",
        build_state::workspace_key(nc_home)
    ))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Mode {
    /// 手动编译：始终全量（用户点「编译」就是要确保产物是新的）
    Full,
    /// 自动/全部：先按清单判增量，能跳就跳
    Auto,
}

/// 单个模块的一轮构建结果。
pub(super) struct Built {
    pub result: CompileResult,
    /// 本次真正被改动的文件（用于跨模块 ABI 传播）
    pub changed_files: Vec<PathBuf>,
    /// 这些文件里有源码级 ABI 变化
    pub abi_changed: bool,
}

/// 编译一个模块（调用方必须已持有 `CompileSlot`，并已清取消标志）。
pub(super) fn build_one(
    ctx: &Ctx,
    module: &str,
    mode: Mode,
    deploy: bool,
    cleaned: usize,
) -> Result<Built, String> {
    let layout = ModuleLayout::resolve(&ctx.root, module);
    let (cp_fp, cc_fp) = build_state::config_fingerprints(
        &layout,
        &ctx.root,
        &ctx.nc_home,
        &ctx.overrides,
        &ctx.ecj,
        &ctx.java,
    );
    let previous = ctx.manifest(module);
    let decision = build_state::decide(
        &layout,
        previous.as_ref(),
        &cp_fp,
        &cc_fp,
        mode == Mode::Full,
    );
    if let Decision::Skip = decision {
        ctx.log_module(module, "输入未变化，跳过（点「编译本模块」可强制全量）");
        let mut r = empty_result(module, "0 个文件（未变化，已跳过）");
        r.modules.push(ModuleBuildResult {
            module: module.to_string(),
            status: "skipped".to_string(),
            error_count: 0,
            warning_count: 0,
            duration_ms: 0,
            source_count: 0,
            out_dir: layout
                .outputs
                .first()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default(),
            cleaned,
            reason: Some("输入未变化".to_string()),
        });
        return Ok(Built {
            result: r,
            changed_files: Vec::new(),
            abi_changed: false,
        });
    }

    let (files, full, reason, changed, abi_changed) = match &decision {
        Decision::Full { reason } => {
            let files = layout.collect_sources();
            // 全量也要知道签名有没有变：跨模块传播只看 changed / abi_changed
            let (changed, abi_changed) =
                build_state::changed_against_manifest(&layout, previous.as_ref(), &files);
            (files, true, reason.clone(), changed, abi_changed)
        }
        Decision::Incremental {
            files,
            reason,
            changed,
            abi_changed,
        } => (
            files.clone(),
            false,
            reason.clone(),
            changed.clone(),
            *abi_changed,
        ),
        Decision::Skip => unreachable!(),
    };
    if files.is_empty() {
        return Err(format!(
            "模块 {module} 下没有找到 .java 源文件（源码根：{}）",
            layout
                .source_roots
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("、")
        ));
    }
    ctx.log_module(module, &format!("{reason}（{} 个文件）", files.len()));

    let (index, cached_seed) = ctx.index(module)?;
    let seed = if cached_seed.is_empty() {
        previous
            .as_ref()
            .map(|m| m.seed_jars.clone())
            .unwrap_or_default()
    } else {
        cached_seed
    };
    let out_dir = layout
        .outputs
        .first()
        .cloned()
        .unwrap_or_else(|| ctx.root.join(module).join("classes"));
    let job = CompileJob {
        module: module.to_string(),
        files: Some(files.clone()),
        out_dir,
        source_roots: Some(layout.source_roots.clone()),
        output_map: layout
            .groups
            .iter()
            .flat_map(|g| {
                g.source_roots
                    .iter()
                    .map(|r| (r.clone(), g.out_dir.clone()))
            })
            .collect(),
        seed_jars: seed,
        fast: false,
    };
    let env = ctx.env(&index);
    let mut result = compile::compile(&env, &job, &|s| ctx.log(s))?;
    result.modules.push(ModuleBuildResult {
        module: module.to_string(),
        status: if result.error_count == 0 {
            "ok"
        } else {
            "failed"
        }
        .to_string(),
        error_count: result.error_count,
        warning_count: result.warning_count,
        duration_ms: result.duration_ms,
        source_count: result.source_count,
        out_dir: result.out_dir.clone(),
        cleaned,
        reason: Some(reason.clone()),
    });
    super::compile_cmds::cache_seed(module, result.resolved_jars.clone());

    if result.error_count == 0 {
        let next = build_state::updated_manifest(
            &layout,
            previous.as_ref(),
            &files,
            &cp_fp,
            &cc_fp,
            result.resolved_jars.clone(),
            full,
        );
        if let Some(prev) = previous.as_ref() {
            let stale = build_state::stale_classes(&layout, prev, &next);
            let removed = delete_stale(&stale, &layout.module_dir);
            if removed > 0 {
                ctx.log_module(
                    module,
                    &format!("清理 {removed} 个上次有、这次没有的 class"),
                );
            }
        }
        if let Err(e) = build_state::write_manifest(&ctx.manifest_file(module), &next) {
            ctx.log_module(module, &format!("构建清单写入失败（不影响本次编译）：{e}"));
        }
        if deploy {
            ctx.deploy();
        }
    } else if let Some(mut prev) = previous {
        prev.last_attempt = Some(build_state::LastAttempt {
            ok: false,
            error_count: result.error_count,
            warning_count: result.warning_count,
            duration_ms: result.duration_ms,
            at_ms: build_state::now_ms(),
            reason: "编译有错误；旧产物与旧清单保留".to_string(),
        });
        let _ = build_state::write_manifest(&ctx.manifest_file(module), &prev);
    }
    ctx.log_module(
        module,
        &format!(
            "完成：{} 个源文件，{} 个错误，{:.1}s",
            result.source_count,
            result.error_count,
            result.duration_ms as f64 / 1000.0
        ),
    );
    Ok(Built {
        result,
        changed_files: changed,
        abi_changed,
    })
}

/// 清单里的旧 class：只在声明过的输出目录内、且不是重解析点时才删。
///
/// 重解析点检查以 `module_dir` 为界：越过它（`/var`、`/tmp` 这类系统符号链接）
/// 不属于逃逸，越界检查会让 macOS 上的删除整体失效（见
/// `build_layout::has_reparse_component_under`）。
fn delete_stale(files: &[PathBuf], module_dir: &Path) -> usize {
    let mut n = 0;
    for p in files {
        if crate::build_layout::has_reparse_component_under(p, module_dir) {
            continue;
        }
        if std::fs::remove_file(p).is_ok() {
            n += 1;
        }
    }
    n
}

fn empty_result(module: &str, out_dir: &str) -> CompileResult {
    CompileResult {
        ok: true,
        duration_ms: 0,
        source_count: 0,
        error_count: 0,
        warning_count: 0,
        problems: Vec::new(),
        jar_count: 0,
        rounds: 0,
        out_dir: format!("{module} · {out_dir}"),
        diagnostics: Vec::new(),
        resolved_jars: Vec::new(),
        modules: Vec::new(),
    }
}

/// 模块依赖：`module -> 它 .classpath 里引用的工作区模块`（只认工作区内部）。
pub(super) fn module_deps(root: &Path, modules: &[String]) -> HashMap<String, Vec<String>> {
    let lower: HashMap<String, String> = modules
        .iter()
        .map(|m| (m.to_ascii_lowercase(), m.clone()))
        .collect();
    let mut out = HashMap::new();
    for m in modules {
        let mut deps: Vec<String> = Vec::new();
        if let Some(cp) = crate::eclipse_cp::ProjectCp::load(&root.join(m)) {
            for r in &cp.refs {
                if let Some(target) = lower.get(&r.name.to_ascii_lowercase()) {
                    if !target.eq_ignore_ascii_case(m)
                        && !deps.iter().any(|d| d.eq_ignore_ascii_case(target))
                    {
                        deps.push(target.clone());
                    }
                }
            }
        }
        out.insert(m.clone(), deps);
    }
    out
}

/// 拓扑分层：同层模块互不依赖，可以并行。环里的剩余模块按原顺序放最后一层。
pub(super) fn topo_levels(
    modules: &[String],
    deps: &HashMap<String, Vec<String>>,
) -> Vec<Vec<String>> {
    let set: HashSet<String> = modules.iter().map(|m| m.to_ascii_lowercase()).collect();
    let normalized: HashMap<String, HashSet<String>> = modules
        .iter()
        .map(|m| {
            let d = deps
                .get(m)
                .map(|v| {
                    v.iter()
                        .filter(|x| set.contains(&x.to_ascii_lowercase()))
                        .map(|x| x.to_ascii_lowercase())
                        .collect()
                })
                .unwrap_or_default();
            (m.to_ascii_lowercase(), d)
        })
        .collect();
    let mut done: HashSet<String> = HashSet::new();
    let mut levels = Vec::new();
    loop {
        let level: Vec<String> = modules
            .iter()
            .filter(|m| !done.contains(&m.to_ascii_lowercase()))
            .filter(|m| {
                normalized
                    .get(&m.to_ascii_lowercase())
                    .map(|d| d.iter().all(|x| done.contains(x)))
                    .unwrap_or(true)
            })
            .cloned()
            .collect();
        if level.is_empty() {
            break;
        }
        for m in &level {
            done.insert(m.to_ascii_lowercase());
        }
        levels.push(level);
        if done.len() == modules.len() {
            break;
        }
    }
    let rest: Vec<String> = modules
        .iter()
        .filter(|m| !done.contains(&m.to_ascii_lowercase()))
        .cloned()
        .collect();
    if !rest.is_empty() {
        levels.push(rest);
    }
    levels
}

/// 编译全部模块：独立分支继续，依赖失败模块的标 blocked。
pub(super) fn build_all(ctx: &Ctx, force_full: bool) -> Result<CompileResult, String> {
    build_all_impl(ctx, force_full, false)
}

/// `clean_first=true` = 清理并重编全部（清理与编译共用同一把编译闸，中间插不进别的编译）。
pub(super) fn build_all_impl(
    ctx: &Ctx,
    force_full: bool,
    clean_first: bool,
) -> Result<CompileResult, String> {
    let started = std::time::Instant::now();
    let _slot = CompileSlot::acquire()
        .ok_or_else(|| "已有一次编译在进行，等它完成再试（或点「取消」）".to_string())?;
    ctx.st
        .compile_cancel
        .store(false, std::sync::atomic::Ordering::SeqCst);

    let dirs = crate::eclipse_cp::class_roots_with(&ctx.root, &ctx.nc_home, &ctx.overrides);
    let mut modules = crate::eclipse_cp::compile_order(&dirs, &ctx.root);
    if modules.is_empty() {
        modules = crate::eclipse_cp::module_dirs_of(&ctx.root);
    }
    if modules.is_empty() {
        return Err("工作区里没有找到可编译的模块（子目录里应有 src 或 .classpath）".to_string());
    }
    // 清理并重编：先删清单里记录过的 class，再全量。和编译共用一把闸，
    // 中间插不进另一轮编译；输出根保留，依赖顺序不受影响。
    let mut cleaned: HashMap<String, usize> = HashMap::new();
    if clean_first {
        ctx.log(&format!("先清理 {} 个模块的编译产物…", modules.len()));
        for m in &modules {
            let r = clean_one(ctx, m, false);
            cleaned.insert(m.to_ascii_lowercase(), r.removed);
            ctx.log_module(
                m,
                &format!(
                    "已清理 {} 个 class{}",
                    r.removed,
                    if r.failed.is_empty() {
                        ""
                    } else {
                        "（有文件删不掉，见清理报告）"
                    }
                ),
            );
        }
    }
    ctx.log(&format!(
        "按依赖顺序编译 {} 个模块：{}",
        modules.len(),
        modules.join(" → ")
    ));
    let deps = module_deps(&ctx.root, &modules);
    let levels = topo_levels(&modules, &deps);
    let total = modules.len();
    let mut done = 0usize;
    ctx.progress("start", 0, total, None, 0);

    let mut results: Vec<CompileResult> = Vec::new();
    let mut ledgers: Vec<ModuleBuildResult> = Vec::new();
    let mut failed: HashSet<String> = HashSet::new();
    let mut blocked: HashSet<String> = HashSet::new();
    let mode = if force_full { Mode::Full } else { Mode::Auto };

    for level in levels {
        if ctx
            .st
            .compile_cancel
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            return Err(compile::CANCELLED.to_string());
        }
        // 先把依赖已失败 / 被阻断的模块标成 blocked，不启动 JVM
        let mut runnable: Vec<String> = Vec::new();
        for m in level {
            let dep_failed = deps
                .get(&m)
                .map(|ds| {
                    ds.iter().any(|d| {
                        failed.contains(&d.to_ascii_lowercase())
                            || blocked.contains(&d.to_ascii_lowercase())
                    })
                })
                .unwrap_or(false);
            if dep_failed {
                blocked.insert(m.to_ascii_lowercase());
                let reason = "依赖的模块编不过，已阻断（先修依赖再编）";
                ctx.log_module(&m, reason);
                ledgers.push(ModuleBuildResult {
                    module: m.clone(),
                    status: "blocked".to_string(),
                    error_count: 0,
                    warning_count: 0,
                    duration_ms: 0,
                    source_count: 0,
                    out_dir: String::new(),
                    cleaned: cleaned.get(&m.to_ascii_lowercase()).copied().unwrap_or(0),
                    reason: Some(reason.to_string()),
                });
                done += 1;
            } else {
                runnable.push(m);
            }
        }
        for chunk in runnable.chunks(ctx.parallel.max(1)) {
            // 并行块里每个线程只碰自己的结果；汇总留给主线程，
            // 避免「拿着一个结果锁再回头加锁」这种自锁。
            let mut batch: Vec<(String, Result<Built, String>)> = Vec::new();
            let clean_counts = &cleaned;
            std::thread::scope(|s| {
                let handles: Vec<_> = chunk
                    .iter()
                    .map(|m| {
                        let m = m.clone();
                        s.spawn(move || {
                            ctx.log_module(&m, "开始编译");
                            let already = clean_counts
                                .get(&m.to_ascii_lowercase())
                                .copied()
                                .unwrap_or(0);
                            let outcome = build_one(ctx, &m, mode, false, already);
                            (m, outcome)
                        })
                    })
                    .collect();
                for (m, h) in chunk.iter().zip(handles) {
                    match h.join() {
                        Ok(v) => batch.push(v),
                        // 编译线程 panic：记成失败并阻断它的依赖方，不能让整轮静默少一个模块
                        Err(_) => batch.push((m.clone(), Err("编译线程异常退出".to_string()))),
                    }
                }
            });
            for (module, outcome) in batch {
                match outcome {
                    Ok(b) => {
                        let led = b
                            .result
                            .modules
                            .last()
                            .cloned()
                            .unwrap_or_else(|| ModuleBuildResult::ok(&module, &b.result));
                        if led.status == "failed" {
                            failed.insert(module.to_ascii_lowercase());
                        }
                        ledgers.push(led);
                        results.push(b.result);
                    }
                    Err(e) => {
                        let reason = if e.starts_with("CANCELLED:") {
                            "已取消".to_string()
                        } else {
                            e
                        };
                        ctx.log_module(&module, &format!("失败：{reason}"));
                        failed.insert(module.to_ascii_lowercase());
                        ledgers.push(ModuleBuildResult {
                            module: module.clone(),
                            status: "failed".to_string(),
                            error_count: 0,
                            warning_count: 0,
                            duration_ms: 0,
                            source_count: 0,
                            out_dir: String::new(),
                            cleaned: cleaned
                                .get(&module.to_ascii_lowercase())
                                .copied()
                                .unwrap_or(0),
                            reason: Some(reason),
                        });
                        results.push(empty_result(&module, "未产出"));
                    }
                }
                done += 1;
                ctx.progress(
                    "module",
                    done,
                    total,
                    Some(&module),
                    started.elapsed().as_millis() as u64,
                );
            }
        }
        // 这一层结束后把失败模块的传递依赖方也标成 blocked（下一层会看到）
        propagate_blocked(&deps, &mut failed, &mut blocked);
    }

    // 汇总
    let all = std::mem::take(&mut results);
    let mut total_result = CompileResult {
        ok: true,
        duration_ms: started.elapsed().as_millis() as u64,
        source_count: 0,
        error_count: 0,
        warning_count: 0,
        problems: Vec::new(),
        jar_count: 0,
        rounds: 0,
        out_dir: format!("{} 个模块", modules.len()),
        diagnostics: Vec::new(),
        resolved_jars: Vec::new(),
        modules: Vec::new(),
    };
    for r in all {
        total_result.source_count += r.source_count;
        total_result.error_count += r.error_count;
        total_result.warning_count += r.warning_count;
        total_result.jar_count = total_result.jar_count.max(r.jar_count);
        total_result.rounds += r.rounds;
        total_result.problems.extend(r.problems);
        total_result.diagnostics.extend(r.diagnostics);
    }
    let mut led = std::mem::take(&mut ledgers);
    // 同一模块只会有一条（失败路径与成功路径互斥），按模块名排序即可稳定显示
    led.sort_by(|a, b| a.module.cmp(&b.module));
    let has_bad = led
        .iter()
        .any(|l| l.status == "failed" || l.status == "blocked");
    total_result.ok = total_result.error_count == 0 && !has_bad;
    total_result.modules = led;
    ctx.progress(
        "done",
        total,
        total,
        None,
        started.elapsed().as_millis() as u64,
    );

    if total_result.ok {
        ctx.log("全部模块编译完成");
        ctx.deploy();
    } else {
        ctx.log("有模块失败或被阻断；独立分支已尽量编完，见上面的模块结果");
    }
    append_history(ctx, &total_result);
    Ok(total_result)
}

fn propagate_blocked(
    deps: &HashMap<String, Vec<String>>,
    failed: &mut HashSet<String>,
    blocked: &mut HashSet<String>,
) {
    loop {
        let mut changed = false;
        for (m, ds) in deps {
            if blocked.contains(&m.to_ascii_lowercase()) {
                continue;
            }
            if ds.iter().any(|d| {
                failed.contains(&d.to_ascii_lowercase())
                    || blocked.contains(&d.to_ascii_lowercase())
            }) {
                blocked.insert(m.to_ascii_lowercase());
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
}

fn append_history(ctx: &Ctx, r: &CompileResult) {
    let entries = r
        .modules
        .iter()
        .map(|m| build_state::HistoryEntry {
            at_ms: build_state::now_ms(),
            module: m.module.clone(),
            status: m.status.clone(),
            error_count: m.error_count,
            warning_count: m.warning_count,
            duration_ms: m.duration_ms,
            reason: m.reason.clone().unwrap_or_default(),
        })
        .collect();
    build_state::append_history(&ctx.config_dir, &ctx.root, entries);
}

/// 编译一批文件（保存后自动编译 / 手动单文件 / 跨模块补编引用方）。
///
/// `preserve_abi=false` 用于「文件内容没变、只是依赖模块签名变了」的补编：
/// 这时文件自己的 ABI 就是真值，不需要留给下一轮空闲增量去重新发现。
/// 调用方需先确认索引已就绪；不拿编译闸（调用方持有）。
pub(super) fn compile_files(
    ctx: &Ctx,
    groups: Vec<(String, Vec<PathBuf>)>,
    fast: bool,
    preserve_abi: bool,
) -> Result<CompileResult, String> {
    let total_files: usize = groups.iter().map(|(_, f)| f.len()).sum();
    let mut results = Vec::with_capacity(groups.len());
    // 热替换：只收集零错误模块的产物。有错时 ecj 可能写出带「编译错误桩」的 class，
    // 推进运行中的 NC 会把能跑的代码换成会抛异常的代码。
    let mut hotswap_batch = crate::hotswap::Batch::default();
    for (module, files) in groups {
        let layout = ModuleLayout::resolve(&ctx.root, &module);
        let previous = ctx.manifest(&module);
        let (index, cached_seed) = ctx.index(&module)?;
        let seed = if cached_seed.is_empty() {
            previous
                .as_ref()
                .map(|m| m.seed_jars.clone())
                .unwrap_or_default()
        } else {
            cached_seed
        };
        let out_dir = layout
            .outputs
            .first()
            .cloned()
            .unwrap_or_else(|| ctx.root.join(&module).join("classes"));
        let job = CompileJob {
            module: module.clone(),
            files: Some(files.clone()),
            out_dir,
            source_roots: Some(layout.source_roots.clone()),
            output_map: layout
                .groups
                .iter()
                .flat_map(|g| {
                    g.source_roots
                        .iter()
                        .map(|r| (r.clone(), g.out_dir.clone()))
                })
                .collect(),
            seed_jars: seed,
            fast,
        };
        let env = ctx.env(&index);
        let mut r = compile::compile(&env, &job, &|_| {})?;
        r.modules.push(ModuleBuildResult {
            module: module.clone(),
            status: if r.error_count == 0 { "ok" } else { "failed" }.to_string(),
            error_count: r.error_count,
            warning_count: r.warning_count,
            duration_ms: r.duration_ms,
            source_count: r.source_count,
            out_dir: r.out_dir.clone(),
            cleaned: 0,
            reason: None,
        });
        // 单文件编译只更新这部分清单；没有旧清单就不写（否则会把模块写成“只有这几个文件”，
        // 下次 decide 会误判为新增了一堆源文件）。
        if r.error_count == 0 {
            if let Some(prev) = previous.as_ref() {
                let (cp_fp, cc_fp) = build_state::config_fingerprints(
                    &layout,
                    &ctx.root,
                    &ctx.nc_home,
                    &ctx.overrides,
                    &ctx.ecj,
                    &ctx.java,
                );
                let mut next = build_state::updated_manifest(
                    &layout,
                    Some(prev),
                    &files,
                    &cp_fp,
                    &cc_fp,
                    r.resolved_jars.clone(),
                    false,
                );
                // **ABI 保留旧值**：单文件编译发现不了签名变更，如果把新 ABI 也写进清单，
                // 紧接着的空闲增量会认为「什么都没变」直接 Skip，引用方永远等不到重编。
                // stat 写新值、ABI 留旧值，空闲增量才能看见「签名变了」并做传播。
                if preserve_abi {
                    let old = prev.sources_by_key();
                    for s in &mut next.sources {
                        if let Some(p) = old.get(&s.key()) {
                            s.abi = p.abi.clone();
                            s.abi_stale = true;
                        }
                    }
                }
                let _ = build_state::write_manifest(&ctx.manifest_file(&module), &next);
            }
            if ctx.hotswap_enabled {
                collect_hotswap(&mut hotswap_batch, &layout, &job.out_dir, &files);
            }
        }
        results.push(r);
    }
    super::hotswap_cmds::after_compile(
        &ctx.app,
        &ctx.st,
        &ctx.config_dir,
        ctx.hotswap_enabled,
        ctx.hotswap_auto,
        hotswap_batch,
    );
    Ok(merge_compile_results(results, total_files))
}

/// 把本模块编过的源文件映射成待替换的类。
///
/// 产物目录按源根取（一个模块可能有多个 output），取不到时回落本轮的默认产物目录，
/// 与 `compile::compile` 写 class 的口径一致。包名从源码里读：GBK 文件按有损解码也不影响
/// `package` 那一行（纯 ASCII）。
fn collect_hotswap(
    batch: &mut crate::hotswap::Batch,
    layout: &ModuleLayout,
    default_out: &Path,
    files: &[PathBuf],
) {
    for f in files {
        let Ok(bytes) = std::fs::read(f) else {
            continue;
        };
        let package =
            compile::extract_package(&String::from_utf8_lossy(&bytes)).unwrap_or_default();
        let out = layout
            .output_for(f)
            .unwrap_or_else(|| default_out.to_path_buf());
        batch.add_source(&out, &package, f);
    }
}

/// 合并多模块结果；与旧 `merge_results` 同一口径（jar 取峰值）。
pub(super) fn merge_compile_results(results: Vec<CompileResult>, files: usize) -> CompileResult {
    let modules = results.len();
    let out_dir = match results.first() {
        Some(r) if modules == 1 => r.out_dir.clone(),
        _ => format!("{modules} 个模块 · {files} 个文件"),
    };
    let mut total = CompileResult {
        ok: true,
        duration_ms: 0,
        source_count: 0,
        error_count: 0,
        warning_count: 0,
        problems: Vec::new(),
        jar_count: 0,
        rounds: 0,
        out_dir,
        diagnostics: Vec::new(),
        resolved_jars: Vec::new(),
        modules: Vec::new(),
    };
    for r in results {
        total.duration_ms += r.duration_ms;
        total.source_count += r.source_count;
        total.error_count += r.error_count;
        total.warning_count += r.warning_count;
        total.jar_count = total.jar_count.max(r.jar_count);
        total.rounds += r.rounds;
        total.problems.extend(r.problems);
        total.diagnostics.extend(r.diagnostics);
        total.modules.extend(r.modules);
    }
    total.ok = total.error_count == 0;
    total
}

/// 跨模块 ABI 传播：模块 A 的签名变了，其它模块里引用这些类型的源文件也得重编，
/// 否则它们的字节码里还留着旧签名（编译不报错，运行期才炸）。
///
/// 调用方需已持有编译闸、且确认索引可用。
pub(super) fn propagate_abi(
    ctx: &Ctx,
    changed: &[PathBuf],
    skip: &HashSet<String>,
) -> Result<Option<CompileResult>, String> {
    if changed.is_empty() {
        return Ok(None);
    }
    let groups = cross_module_groups(&ctx.root, &all_modules(ctx), changed, skip);
    if groups.is_empty() {
        return Ok(None);
    }
    ctx.log(&format!(
        "跨模块签名传播：{} 个改动影响到 {} 个模块（{}）",
        changed.len(),
        groups.len(),
        groups
            .iter()
            .map(|(m, f)| format!("{m} {} 个", f.len()))
            .collect::<Vec<_>>()
            .join("、")
    ));
    // preserve_abi=false：引用方自己的源码没变，ABI 就是真值，不必留给下一轮再发现
    Ok(Some(compile_files(ctx, groups, true, false)?))
}

/// `propagate_abi` 的纯文件系统部分：找出引用 `changed` 的其它模块源文件。
///
/// 不看 `module_deps`：单根 `.classpath` 的工作区（真实 NC 工程）所有模块共用一份
/// 类路径，依赖关系推导出来是空的；只能按 import / 同包 / 通配找引用方。
/// 解析不出目标类型名的模块直接跳过：空闲增量宁可漏编，也不能把全部模块拉起来。
pub(super) fn cross_module_groups(
    root: &Path,
    modules: &[String],
    changed: &[PathBuf],
    skip: &HashSet<String>,
) -> Vec<(String, Vec<PathBuf>)> {
    let mut groups = Vec::new();
    for module in modules {
        if skip.contains(&module.to_ascii_lowercase()) {
            continue;
        }
        let layout = ModuleLayout::resolve(root, module);
        let sources = layout.collect_sources();
        if sources.is_empty() {
            continue;
        }
        let Some(refs) = build_state::referrers(changed, &sources) else {
            continue;
        };
        if refs.is_empty() {
            continue;
        }
        // 与模块内增量同一口径：引用方超过 30% 就别点数了，整模块跑一轮
        let files = if refs.len() * 100 > sources.len().saturating_mul(30) {
            sources
        } else {
            refs
        };
        groups.push((module.clone(), files));
    }
    groups
}

/// 清理一个模块（dry-run 由参数决定）。
pub(super) fn clean_one(ctx: &Ctx, module: &str, dry_run: bool) -> CleanReport {
    let layout = ModuleLayout::resolve(&ctx.root, module);
    let path = ctx.manifest_file(module);
    let manifest = ctx.manifest(module);
    let mut report = build_state::clean_module(&layout, manifest.as_ref(), Some(&path), dry_run);
    // 不自动停服务：清理与停服务是两个决定，混在一起会让「只想删旧 class」变成
    // 把正在跑的业务停掉。只把风险说清楚。
    let running = ctx
        .st
        .server
        .lock()
        .map(|mut g| g.is_alive())
        .unwrap_or(false);
    if running {
        report.notes.push(
            "NC 服务正在运行：本次只清理，不会停止服务；运行中的进程可能仍在使用已删的 class"
                .to_string(),
        );
    }
    report
}

/// 工作区里所有可编译模块（清单里的 + 类路径推导的 + 兜底目录）。
pub(super) fn all_modules(ctx: &Ctx) -> Vec<String> {
    let dirs = crate::eclipse_cp::class_roots_with(&ctx.root, &ctx.nc_home, &ctx.overrides);
    let mut modules = crate::eclipse_cp::compile_order(&dirs, &ctx.root);
    for m in crate::eclipse_cp::module_dirs_of(&ctx.root) {
        if !modules.iter().any(|x| x.eq_ignore_ascii_case(&m)) {
            modules.push(m);
        }
    }
    for m in build_state::list_manifests(&build_state::build_dir(&ctx.config_dir, &ctx.root)) {
        if !modules.iter().any(|x| x.eq_ignore_ascii_case(&m.module)) {
            modules.push(m.module);
        }
    }
    modules
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ncwb-engine-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn write(p: &Path, s: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, s).unwrap();
    }

    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn cross_module_groups_finds_only_referrers() {
        let root = tmp("xmod");
        write(
            &root.join("a/src/public/p/A.java"),
            "package p; public class A { public int x; }",
        );
        write(
            &root.join("b/src/public/q/B.java"),
            "package q; import p.A; public class B { A a; }",
        );
        // 多放几个无关文件，占比低于 30%，不应被整模块带上
        for i in 0..5 {
            write(
                &root.join(format!("b/src/public/q/N{i}.java")),
                &format!("package q; public class N{i} {{}}"),
            );
        }
        write(
            &root.join("c/src/public/r/C.java"),
            "package r; public class C {}",
        );
        let changed = vec![root.join("a/src/public/p/A.java")];
        let skip: HashSet<String> = ["a".to_string()].into_iter().collect();
        let groups = cross_module_groups(&root, &names(&["a", "b", "c"]), &changed, &skip);
        assert_eq!(groups.len(), 1, "只应命中 b：{groups:?}");
        assert_eq!(groups[0].0, "b");
        assert_eq!(
            groups[0].1.len(),
            1,
            "只应带引用方 B.java：{:?}",
            groups[0].1
        );
        assert!(groups[0].1[0].ends_with("B.java"));
    }

    #[test]
    fn cross_module_groups_expands_whole_module_over_threshold() {
        let root = tmp("xmod-th");
        write(
            &root.join("a/src/public/p/A.java"),
            "package p; public class A {}",
        );
        write(
            &root.join("b/src/public/q/B.java"),
            "package q; import p.A; public class B { A a; }",
        );
        write(
            &root.join("b/src/public/q/C.java"),
            "package q; public class C {}",
        );
        let changed = vec![root.join("a/src/public/p/A.java")];
        let skip: HashSet<String> = ["a".to_string()].into_iter().collect();
        // 2 个源文件里 1 个引用 = 50% > 30%，与模块内增量一样整模块跑
        let groups = cross_module_groups(&root, &names(&["a", "b"]), &changed, &skip);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].1.len(), 2, "应扩展为整模块：{:?}", groups[0].1);
    }
}
