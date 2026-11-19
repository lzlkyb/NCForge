//! 编译命令：按文件所在模块调用 ecj，产物写到 `<模块>/classes`（与 Eclipse 一致）。
//!
//! 真正的算法在 `compile.rs` / `nc_index.rs`（纯逻辑，可单测），这里只管：
//! 找 NC home 与 ecj、懒建类索引（带磁盘缓存）、把进度推给前端、把阻塞工作放进后台线程。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::compile::{self, CompileResult};
use crate::security::path::{display_path, resolve_safe_path_async};
use crate::state::AppState;

// 类索引缓存与编译闸在 compile_index（体量门禁拆分）；对外路径保持不变。
pub(crate) use super::compile_index::invalidate_index;
pub use super::compile_index::spawn_prewarm;
pub(super) use super::compile_index::{
    cache_seed, cached_index, index_ready, lookup_index, warm_index, CompileSlot,
};

/// ecj 候选顺序：外部资源包（按需下载安装）→ 安装包资源目录（v0.1.0 及以前的
/// 旧安装兜底）→ 源码树资源（开发模式）。
pub(super) fn find_ecj(config_dir: &Path) -> Result<PathBuf, String> {
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
        "找不到 Java 编译器组件（ecj）。请点击下载按钮，或到设置 → 维护 → 组件与更新下载，然后重新编译"
            .to_string()
    })
}

/// 常驻 ecj 桥 jar（可选）：安装包资源目录 → 源码树（开发模式）。
/// 找不到不算错误——编译会退回一次一进程，只是每次多花 0.6~0.9 秒。
pub(super) fn find_ecj_bridge(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    let mut dirs = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        dirs.push(dir.join("ecj-bridge"));
    }
    dirs.push(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("ecj-bridge"),
    );
    crate::ecj_worker::find_jar(&dirs)
}

/// 工作区根的两个写法：`raw` 是配置里的原值（`resolve_safe_path` 的白名单要它），
/// `canon` 是 canonicalize + 去掉 `\\?\` 前缀的版本（`strip_prefix` 用它）。
///
/// 单独抽出来是因为批量编译要解析几十个文件——每次都 canonicalize 一遍根目录等于白算
/// （网络盘上尤其明显），而一次保存里根不会变。
pub(super) async fn workspace_roots(state: &AppState) -> Result<(String, PathBuf), String> {
    let raw = state
        .config
        .read()
        .await
        .workspace_root
        .clone()
        .ok_or_else(|| "尚未选择工作区目录".to_string())?;
    // canonicalize 是同步磁盘操作，不能跑在 async 体里（审查报告 D2）
    let for_canon = raw.clone();
    let canon = tauri::async_runtime::spawn_blocking(move || {
        std::fs::canonicalize(&for_canon).map_err(|e| format!("工作区目录不可用: {e}"))
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))??;
    Ok((raw, PathBuf::from(display_path(&canon))))
}

/// 在已知工作区根的前提下解析一个路径（`compile_file` 批量用：根只算一次）。
///
/// 返回 `Ok(None)` = 在工作区内、但不在任何模块目录下。
async fn resolve_in_root(
    root_raw: &str,
    root: &Path,
    path: &str,
) -> Result<Option<(PathBuf, String, PathBuf)>, String> {
    // async 命令链上做路径校验：canonicalize 是同步磁盘操作，走 spawn_blocking，
    // 否则网络盘上几个校验就能把 IPC 层堵住（审查报告 D2）
    let target = resolve_safe_path_async(
        path.to_string(),
        vec![root_raw.to_string()],
        Vec::new(),
        true,
    )
    .await?;
    // resolve_safe_path 返回的是 canonicalize 后带 `\?\` 前缀的路径，工作区根是去掉前缀的，
    // 两边都规整成同一种写法，否则 strip_prefix 永远匹配不上。
    let target = PathBuf::from(display_path(&target));
    Ok(compile::module_of(root, &target).map(|module| (root.to_path_buf(), module, target)))
}

/// `resolve_module` 的「可能不属于任何模块」版本：返回 `Ok(None)` 表示这个路径
/// 在工作区内、但不在任何模块目录下（工作区根下散放的 `.java` 就是这种情况）。
///
/// 调用方必须能区分「不在模块里」与「路径非法」：保存触发的自动编译对前者应当
/// **静默跳过**，对后者才该报错——否则工作区根下放一个 `.java`，每按一次 Ctrl+S
/// 就弹一次红。
pub(super) async fn resolve_module_opt(
    state: &AppState,
    path: &str,
) -> Result<Option<(PathBuf, String, PathBuf)>, String> {
    let (root_raw, root) = workspace_roots(state).await?;
    resolve_in_root(&root_raw, &root, path).await
}

/// 解析 `path` 所属的工作区根与模块名。`path` 可以是模块目录，也可以是模块内任一文件。
///
/// 第三个返回值是**规整后的目标路径**（`\\?\` 前缀已去掉）：编译单个文件时直接拿它当
/// 源文件用，不用在外面再拼一遍——拼接一旦和 `strip_prefix` 的写法漂移，就会编错文件。
pub(super) async fn resolve_module(
    state: &AppState,
    path: &str,
) -> Result<(PathBuf, String, PathBuf), String> {
    resolve_module_opt(state, path).await?.ok_or_else(|| {
        "所选路径不在工作区的某个模块里（工作区根应是 newar 这类包含各模块的目录）".to_string()
    })
}

/// 编译成功后投送工程元数据（META-INF → NCHOME）。失败只写一行编译日志，
/// 不影响本次编译结果——投送是「让下次启动读到新 upm」，不是编译的前置条件。
pub(super) fn deploy_after_compile(
    enabled: bool,
    config_dir: &Path,
    root: &Path,
    nc_home: &Path,
    overrides: &[crate::eclipse_cp::LinkedOverride],
    log: &dyn Fn(&str),
) {
    if !enabled {
        return;
    }
    match crate::nchome_deploy::deploy_for_workspace(config_dir, root, nc_home, overrides, true) {
        Ok(r) => {
            for line in crate::nchome_deploy::summary_lines(&r) {
                log(&line);
            }
        }
        Err(e) => log(&format!("元数据投送失败（不影响编译结果）：{e}")),
    }
}

/// 编译 `path` 所在的模块（make 语义）。`path` 可以是模块目录，也可以是模块内任一文件；
/// 进度以 `compile-log` 事件逐行推给前端，返回值是完整结果（含问题列表与模块账本）。
///
/// 先按依赖闭包把被依赖的模块带到最新（Auto：没变就跳），再编目标模块；
/// 依赖编不过 → 目标标 blocked，不起 JVM。强制全量是另一个命令
/// （`build_rebuild_module`「重新编译本模块」），两个入口语义不再混用。
#[tauri::command]
pub async fn compile_module(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
) -> Result<CompileResult, String> {
    let (_, module, _target) = resolve_module(&state, &path).await?;
    let ctx = super::build_engine::context(app, state.inner()).await?;
    tauri::async_runtime::spawn_blocking(move || {
        // 同进程只允许一轮编译（前端标志挡不住切页/双击/命令重入）
        let _slot = CompileSlot::acquire()
            .ok_or_else(|| "已有一次编译在进行，等它完成再试（或点「取消」）".to_string())?;
        // 清取消标志必须在**拿到槽之后**：在命令入口清的话，第二个请求（双击/重入）
        // 会把用户刚点给正在跑的那一轮的「取消」悄悄吞掉。
        ctx.st
            .compile_cancel
            .store(false, std::sync::atomic::Ordering::SeqCst);
        let closure = super::build_engine::make_closure(&ctx, &module);
        if closure.len() > 1 {
            ctx.log(&format!("make：{}", closure.join(" → ")));
        }
        let mut results: Vec<CompileResult> = Vec::new();
        let mut extra_ledgers: Vec<compile::ModuleBuildResult> = Vec::new();
        let mut files = 0usize;
        let mut dep_failed = false;
        for m in &closure {
            let is_target = m.eq_ignore_ascii_case(&module);
            if dep_failed {
                let reason = "依赖的模块编不过，已阻断（先修依赖再编）";
                ctx.log(&format!("[{m}] {reason}"));
                extra_ledgers.push(compile::ModuleBuildResult {
                    module: m.clone(),
                    status: "blocked".to_string(),
                    error_count: 0,
                    warning_count: 0,
                    duration_ms: 0,
                    source_count: 0,
                    out_dir: String::new(),
                    cleaned: 0,
                    reason: Some(reason.to_string()),
                });
                continue;
            }
            // 依赖不投送元数据（它们的 upm 没变）；目标按用户配置投送
            match super::build_engine::build_one(
                &ctx,
                m,
                super::build_engine::Mode::Auto,
                is_target,
                0,
            ) {
                Ok(b) => {
                    if b.result.error_count > 0 {
                        dep_failed = true;
                    }
                    files += b.result.source_count;
                    results.push(b.result);
                }
                Err(e) if e.starts_with("CANCELLED:") => return Err(e),
                Err(e) => {
                    dep_failed = true;
                    ctx.log(&format!("[{m}] 失败：{e}"));
                    extra_ledgers.push(compile::ModuleBuildResult {
                        module: m.clone(),
                        status: "failed".to_string(),
                        error_count: 0,
                        warning_count: 0,
                        duration_ms: 0,
                        source_count: 0,
                        out_dir: String::new(),
                        cleaned: 0,
                        reason: Some(e),
                    });
                }
            }
        }
        let mut merged = super::build_engine::merge_compile_results(results, files);
        merged.modules.extend(extra_ledgers);
        merged.ok = merged.error_count == 0
            && !merged
                .modules
                .iter()
                .any(|l| l.status == "failed" || l.status == "blocked");
        // make 的每个模块结果也进历史：「为什么这次慢」要能按模块回答
        super::build_engine::append_history(&ctx, &merged);
        Ok(merged)
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// `compile_file` 的结果。
///
/// 为什么不是 `Option<CompileResult>`：跳过有四种完全不同的原因，调用方要分别处理——
/// 「索引还没建好」该提示一次、「有编译在跑」该等一下重排、「不是 .java / 不在模块里」
/// 该彻底静默。用一个 `null` 表达全部，前端只能靠猜，于是把「跳过」说成
/// 「已有一次编译在进行」这种误导文案。
#[derive(Debug, serde::Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum CompileFileOutcome {
    Done { result: CompileResult },
    Skipped { code: &'static str, message: String },
}

/// 编译**一批文件**（编辑器保存后自动编译走这条；手动「编译当前文件」传一个）。
///
/// 一批里可能跨模块，按模块分组后**每组一轮 JVM**：ecj 启动约 0.9 s，一个文件一轮
/// 的话「连续保存 5 个文件」就是 5 秒纯等待。同模块的多个文件丢进同一份参数文件，
/// 与在 Eclipse 里连续保存的效果一致。
///
/// 代价见 `docs/NCForge-自动编译-调研与方案-20261104.md` §4.1：**发现不了跨文件的
/// 签名变更**——改了方法参数只重编当前文件，引用方仍是旧字节码，运行期才炸。
/// 所以它只是第一道网，签名传播由随后的 `compile_incremental` 补（含跨模块引用方）。
///
/// **不看 `auto_compile` 开关**：那个开关是「保存后要不要自动编」的前端偏好，
/// 由 `autoCompileQueue` 在入队前判；命令本身必须无条件可用，否则手动
/// 「编译当前文件」在关掉自动编译后就永远失败了。
#[tauri::command]
pub async fn compile_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    paths: Vec<String>,
) -> Result<CompileFileOutcome, String> {
    // 先把能编的挑出来：非 `.java`、不在任何模块里的路径都是「没什么可编的」，
    // 不是错误——保存 xml/properties，或工作区根下散放的 .java 都会走到这里。
    // 根只规整一次：一批可能有二三十个文件，每个都 canonicalize 一遍根目录是白算。
    let (root_raw, root) = workspace_roots(&state).await?;
    let mut groups: Vec<(String, Vec<PathBuf>)> = Vec::new();
    let mut skip_message: Option<String> = None;
    for p in paths {
        if !p.to_ascii_lowercase().ends_with(".java") {
            skip_message.get_or_insert_with(|| format!("{p} 不是 .java 文件，没有可编译的内容"));
            continue;
        }
        let Some((_, module, file)) = resolve_in_root(&root_raw, &root, &p).await? else {
            skip_message.get_or_insert_with(|| {
                "这些文件不在工作区的任何模块里（工作区根应是 newar 这类包含各模块的目录）"
                    .to_string()
            });
            continue;
        };
        match groups.iter_mut().find(|(m, _)| *m == module) {
            Some((_, files)) => {
                if !files.contains(&file) {
                    files.push(file);
                }
            }
            None => groups.push((module, vec![file])),
        }
    }
    if groups.is_empty() {
        return Ok(CompileFileOutcome::Skipped {
            code: "no-module",
            message: skip_message.unwrap_or_else(|| "没有可编译的 .java 文件".to_string()),
        });
    }
    let ctx = super::build_engine::context(app, state.inner()).await?;

    tauri::async_runtime::spawn_blocking(move || {
        // 索引还没建好就先跳过：首次冷扫 10~100 秒，把它挂在「保存」上会一直亮着
        // 「编译中」（期间命令面板里的编译项全灰），而自动编译这条链路又刻意不写
        // 编译日志，用户只会看到编辑器卡住。顺手在后台起一次建索引，下次保存就能编上。
        if !index_ready(&ctx.nc_home) {
            warm_index(ctx.nc_home.clone(), ctx.cache_path.clone());
            return Ok(CompileFileOutcome::Skipped {
                code: "index-cold",
                message:
                    "NC 类索引还在建立（首次约 10~100 秒），这次保存先不编译；建好后下一次保存会自动编上"
                        .to_string(),
            });
        }
        // 拿不到闸说明另一次编译正在跑：跳过并让前端重排（不是失败，也不是「编过了」）
        let Some(_slot) = CompileSlot::acquire() else {
            return Ok(CompileFileOutcome::Skipped {
                code: "busy",
                message: "已有一次编译在进行，等它完成再试".to_string(),
            });
        };
        // 能拿到闸说明此刻没有别的编译，上一轮的取消标志已经过期，必须清掉，
        // 否则用户上次点过「取消」，从此每次保存都立刻 CANCELLED
        ctx.st
            .compile_cancel
            .store(false, std::sync::atomic::Ordering::SeqCst);
        // 自动编译不写 compile-log（那是手动编译的输出面板）；fast=true 让 JVM 参数
        // 偏向「起得快」。也**不投送元数据**：单个 class 与 upm 无关。
        let (result, _) = super::build_engine::compile_files(&ctx, groups, true, true)?;
        Ok(CompileFileOutcome::Done { result })
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 对一批文件所在的模块跑一次**模块级增量**（空闲补齐 / 外部改动）。
///
/// 与 `compile_file` 的分工：`compile_file` 是保存后的快速反馈，只编改动文件；
/// 本命令按清单判断 class 结构是否变了（桥 struct 指纹，Eclipse
/// `hasStructuralChanges` 同口径）、哪些引用方要跟着编。两者串起来才是
/// 「保存先出 class，空闲再修复结构传播」。
///
/// 清单里保留了单文件编译前的结构指纹并标 pending（见 `build_engine::compile_files`），
/// 所以这里能看见「结构变了」；如果单文件编译把新指纹也写进去，这一步会永远 Skip。
/// 结构变化还会按源码引用传播到其它模块（`build_engine::propagate_structural`），
/// drain 到稳定。空闲路径尽力而为：不收敛 / 解析不出时记警告，保底全量是
/// 「编译全部模块」的职责，不在后台静默拉起整库。
#[tauri::command]
pub async fn compile_incremental(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    paths: Vec<String>,
) -> Result<CompileResult, String> {
    let (root_raw, root) = workspace_roots(&state).await?;
    let mut modules: Vec<String> = Vec::new();
    let mut java_paths: Vec<PathBuf> = Vec::new();
    for p in paths {
        if !p.to_ascii_lowercase().ends_with(".java") {
            continue;
        }
        if let Some((_, module, _)) = resolve_in_root(&root_raw, &root, &p).await? {
            if !modules.iter().any(|m| m.eq_ignore_ascii_case(&module)) {
                modules.push(module);
            }
            java_paths.push(PathBuf::from(p));
        }
    }
    if modules.is_empty() {
        return Err("这些文件不在工作区的任何模块里，没有可增量编译的内容".to_string());
    }
    let ctx = super::build_engine::context(app, state.inner()).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let _slot = CompileSlot::acquire()
            .ok_or_else(|| "已有一次编译在进行，跳过这次空闲增量".to_string())?;
        // 前端已知保存了这些文件：主动注入脏集，不依赖 watcher 事件时序
        // （监听事件可能晚于 2.5s 空闲窗，光等 watcher 会漏掉本次保存）。
        if ctx.incremental_stat {
            crate::compile_dirty::mark(&ctx.root, &java_paths, false, false);
        }
        ctx.st
            .compile_cancel
            .store(false, std::sync::atomic::Ordering::SeqCst);
        // 整轮增量的墙钟（含决策 / 传播 / 清单，不只是 ecj 那段）。底层
        // `compile::compile` 的 duration_ms 只覆盖编译本身，命令层这一条才是
        // 「保存后空闲增量到底花多久」的完整口径，供速度基线取数。
        let started = std::time::Instant::now();
        let module_count = modules.len();
        let mut results = Vec::with_capacity(modules.len());
        let mut files = 0usize;
        // 结构变了的源文件 / 删除的源文件（只有编成功才算数：失败时旧产物仍在使用）
        let mut changed_files: Vec<PathBuf> = Vec::new();
        let mut removed_all: Vec<crate::build_state::RemovedSource> = Vec::new();
        for module in modules {
            let built = super::build_engine::build_one(
                &ctx,
                &module,
                super::build_engine::Mode::Auto,
                false,
                0,
            )?;
            if built.struct_changed && built.result.error_count == 0 {
                for p in &built.changed_files {
                    if !changed_files.contains(p) {
                        changed_files.push(p.clone());
                    }
                }
                removed_all.extend(built.removed.iter().cloned());
            }
            files += built.result.source_count;
            results.push(built.result);
        }
        // 保存后的快速编译发现不了跨模块结构变化，这里补上引用方，drain 到稳定。
        // 种子分两类：intra（build_one 产出，模块内引用方已在归属模块编过）只对
        // 其它模块传播；fresh（传播新产出）连归属模块的模块内引用方也要补编。
        // 不能按「做过结构传播的模块」整体跳过——同轮一起改的两个源模块互相引用时
        // （如常量内联），先编的那个用的是对方的旧产物，必须再编一次。
        let mut pending_fresh: Vec<PathBuf> = Vec::new();
        let mut pending_intra = changed_files;
        let mut pending_removed = removed_all;
        let mut rounds = 0u32;
        let no_skip: std::collections::HashSet<String> = std::collections::HashSet::new();
        while !pending_fresh.is_empty()
            || !pending_intra.is_empty()
            || !pending_removed.is_empty()
        {
            if rounds >= super::build_engine::MAX_STRUCT_ROUNDS {
                log::warn!("空闲增量：跨模块结构传播超 {rounds} 轮未收敛，留给「编译全部模块」保底");
                break;
            }
            let mut unparsed: std::collections::HashSet<String> =
                std::collections::HashSet::new();
            match super::build_engine::propagate_structural(
                &ctx,
                &pending_fresh,
                &pending_intra,
                &pending_removed,
                &no_skip,
                &mut unparsed,
            )? {
                None => {
                    if unparsed.contains("*") {
                        log::warn!("空闲增量：改动源码解析不出类型名，跨模块传播跳过，留给「编译全部模块」保底");
                    }
                    break;
                }
                Some(p) => {
                    files += p.result.source_count;
                    results.push(p.result);
                    pending_fresh = p.next;
                    pending_intra = Vec::new();
                    pending_removed = Vec::new();
                    rounds += 1;
                }
            }
        }
        let mut merged = super::build_engine::merge_compile_results(results, files);
        // 同一模块可能出现两条账本（make + 传播补编），按名合并
        super::build_engine::dedup_ledgers(&mut merged.modules);
        super::build_engine::append_history(&ctx, &merged);
        log::info!(
            "增量编译：{module_count} 个模块 · {files} 个文件 · {} ms · {} 错误",
            started.elapsed().as_millis(),
            merged.error_count
        );
        Ok(merged)
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
    force_full: Option<bool>,
    skip_deploy: Option<bool>,
) -> Result<CompileResult, String> {
    let mut ctx = super::build_engine::context(app, state.inner()).await?;
    // 组合开发流程显式投送一次；这里只覆盖本次上下文，不改变用户的自动投送配置。
    if skip_deploy.unwrap_or(false) {
        ctx.deploy_on_start = false;
    }
    tauri::async_runtime::spawn_blocking(move || {
        super::build_engine::build_all(&ctx, force_full.unwrap_or(false))
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result(errors: usize, jars: usize, jars_in: Vec<u32>) -> CompileResult {
        CompileResult {
            ok: errors == 0,
            duration_ms: 100,
            source_count: 1,
            error_count: errors,
            warning_count: 0,
            problems: (0..errors)
                .map(|i| compile::Problem {
                    severity: "error".to_string(),
                    file: format!("C:/w/m/A{i}.java"),
                    line: 1,
                    message: "x".to_string(),
                })
                .collect(),
            jar_count: jars,
            rounds: 1,
            out_dir: "C:/w/m/classes".to_string(),
            diagnostics: Vec::new(),
            resolved_jars: jars_in,
            modules: Vec::new(),
        }
    }

    #[test]
    fn 多模块结果按字段合并而不是相加_jar_数() {
        let merged = super::super::build_engine::merge_compile_results(
            vec![result(0, 16, vec![1, 2]), result(2, 40, vec![3])],
            3,
        );
        assert_eq!(merged.source_count, 2);
        assert_eq!(merged.error_count, 2);
        assert_eq!(merged.problems.len(), 2);
        // jar 数是「这一轮挂了多少」，取峰值；相加会得到 56 这种没有意义的数
        assert_eq!(merged.jar_count, 40);
        assert_eq!(merged.rounds, 2);
        assert_eq!(merged.duration_ms, 200);
        // 单文件结果里的 resolved_jars 是整模块 seed 的子集，不该被当成新 seed 用
        assert!(merged.resolved_jars.is_empty());
        assert!(!merged.ok);
        // 跨模块时不能只报第一个模块的产物目录
        assert_eq!(merged.out_dir, "2 个模块 · 3 个文件");
    }

    #[test]
    fn 单模块时保留真实产物目录() {
        let merged =
            super::super::build_engine::merge_compile_results(vec![result(0, 16, vec![])], 1);
        assert_eq!(merged.out_dir, "C:/w/m/classes");
    }

    #[test]
    fn 全部无错才算_ok() {
        let merged = super::super::build_engine::merge_compile_results(
            vec![result(0, 1, vec![]), result(0, 1, vec![])],
            2,
        );
        assert!(merged.ok);
        assert_eq!(merged.error_count, 0);
    }
}
