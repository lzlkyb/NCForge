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

use crate::build_layout::{self, ModuleLayout};
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
    /// decide 用监听脏集增量 stat（`incremental_stat`），关掉则每次全扫。
    pub incremental_stat: bool,
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
    let (nc_home_cfg, overrides, deploy_on_start, parallel, persistent, hotswap, incremental_stat) = {
        let cfg = state.config.read().await;
        (
            cfg.nc_home.clone(),
            crate::eclipse_cp::active_overrides(&cfg.linked_overrides),
            cfg.deploy_on_start,
            (cfg.build_parallel as usize).clamp(1, 4),
            cfg.persistent_worker,
            (cfg.hotswap_enabled, cfg.hotswap_auto),
            cfg.incremental_stat,
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
        incremental_stat,
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
    /// 强制全量：rebuild / 传播保底 / 配置失效兜底
    Full,
    /// make：先按清单判增量，能跳就跳（手动「编译本模块」与自动/全部同语义）
    Auto,
}

/// 单个模块的一轮构建结果。
pub(super) struct Built {
    pub result: CompileResult,
    /// 跨模块结构传播的种子：源码改动 / 新增的文件 ∪ class 结构变了的文件
    /// （含模块内传播里源码没变、但内联常量被连带更新的引用方）
    pub changed_files: Vec<PathBuf>,
    /// 这些文件里有 class 结构变化（桥 struct 指纹判定，取代旧源码 ABI）
    pub struct_changed: bool,
    /// 本次删除的源文件（旧清单里的包名 + 类型名）：跨模块删除传播用。
    /// 只在编译成功时有值——失败时旧产物仍在使用，删除还没生效。
    pub removed: Vec<build_state::RemovedSource>,
}

/// 结构传播轮数上限：引用方自己结构再变 → 继续传播（Eclipse 队列 / JPS 多轮
/// differentiate 的等价物）。超上限 → 整模块全量兜底，绝不静默停在不稳定态。
pub(super) const MAX_STRUCT_ROUNDS: u32 = 4;

fn make_job(layout: &ModuleLayout, module: &str, files: &[PathBuf], seed: &[u32]) -> CompileJob {
    CompileJob {
        module: module.to_string(),
        files: Some(files.to_vec()),
        out_dir: layout
            .outputs
            .first()
            .cloned()
            .unwrap_or_else(|| layout.module_dir.join("classes")),
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
        seed_jars: seed.to_vec(),
        fast: false,
    }
}

/// 把一轮编译结果并进累计结果（jar 取峰值、resolved_jars 取并集当 seed）。
fn merge_into(total: &mut CompileResult, r: &CompileResult) {
    total.duration_ms += r.duration_ms;
    total.source_count += r.source_count;
    total.error_count += r.error_count;
    total.warning_count += r.warning_count;
    total.jar_count = total.jar_count.max(r.jar_count);
    total.rounds += r.rounds;
    total.problems.extend(r.problems.iter().cloned());
    total.diagnostics.extend(r.diagnostics.iter().cloned());
    for j in &r.resolved_jars {
        if !total.resolved_jars.contains(j) {
            total.resolved_jars.push(*j);
        }
    }
    total.ok = total.error_count == 0;
}

/// 编译后取一批源文件的 class 结构指纹（桥 struct 命令，一次批量）。
/// 返回 源文件 key → `Option<指纹>`；桥不可用 / 失败 → `None`（调用方按
/// 「结构可能变了」保守处理）。取消 → `Err(CANCELLED)` 上抛。
fn struct_fps_for(
    ctx: &Ctx,
    layout: &ModuleLayout,
    sources: &[PathBuf],
    previous: Option<&Manifest>,
) -> Result<HashMap<String, Option<String>>, String> {
    let mut out = HashMap::new();
    if sources.is_empty() {
        return Ok(out);
    }
    let prev = previous.map(|m| m.sources_by_key()).unwrap_or_default();
    let mut classes = Vec::new();
    let mut per_source: Vec<(String, Vec<PathBuf>)> = Vec::new();
    for p in sources {
        let Some(stamp) = build_state::source_stamp(layout, p, true) else {
            continue;
        };
        let package = if stamp.package.is_empty() {
            prev.get(&stamp.key())
                .map(|s| s.package.clone())
                .unwrap_or_default()
        } else {
            stamp.package.clone()
        };
        let out_dir = layout.output_for(p).unwrap_or_else(|| {
            layout
                .outputs
                .first()
                .cloned()
                .unwrap_or_else(|| layout.module_dir.join("classes"))
        });
        let abs: Vec<PathBuf> = build_state::classes_for_source(&out_dir, &package, p)
            .iter()
            .filter_map(|r| build_layout::safe_join(&out_dir, r))
            .collect();
        classes.extend(abs.iter().cloned());
        per_source.push((stamp.key(), abs));
    }
    let fps = match ctx.ecj_bridge.as_deref() {
        Some(bridge) => crate::ecj_worker::struct_fps(
            &ctx.java,
            &ctx.ecj,
            bridge,
            &classes,
            &ctx.work_dir,
            Some(&ctx.st.compile_cancel),
        )?,
        None => None,
    };
    for (key, abs) in per_source {
        let combined = fps.as_ref().and_then(|map| {
            crate::class_fp::combine(
                &abs.iter()
                    .map(|c| map.get(&crate::class_fp::key(c)).cloned())
                    .collect::<Vec<_>>(),
            )
        });
        out.insert(key, combined);
    }
    Ok(out)
}

/// 相对旧清单基线有结构变化的文件。基线 = 清单里的 struct_fp（保存快速编译
/// 保留旧值 + pending，所以这里不需要预读磁盘旧 class——它可能已被覆盖）。
/// 新增文件 / 任一侧指纹未知 → 一律算结构变化（宁可多编）。
fn structural_files(
    layout: &ModuleLayout,
    files: &[PathBuf],
    previous: Option<&Manifest>,
    post: &HashMap<String, Option<String>>,
) -> Vec<PathBuf> {
    let prev = previous.map(|m| m.sources_by_key()).unwrap_or_default();
    let mut out = Vec::new();
    for p in files {
        let Some(stamp) = build_state::source_stamp(layout, p, false) else {
            continue;
        };
        let old = prev.get(&stamp.key());
        let old_fp = old.and_then(|s| s.struct_fp.clone());
        let new_fp = post.get(&stamp.key()).cloned().flatten();
        if old.is_none() || old_fp.is_none() || new_fp.is_none() || old_fp != new_fp {
            out.push(p.clone());
        }
    }
    out
}

/// 删除源文件的引用方：源码已不在，用旧清单的包名 + 类型名找。
fn removed_referrers(removed: &[build_state::RemovedSource], all: &[PathBuf]) -> Vec<PathBuf> {
    let mut fq = HashSet::new();
    let mut pkgs = HashSet::new();
    let mut simple = HashSet::new();
    let mut exclude = HashSet::new();
    for r in removed {
        pkgs.insert(r.package.to_ascii_lowercase());
        for t in &r.types {
            let f = if r.package.is_empty() {
                t.clone()
            } else {
                format!("{}.{}", r.package, t)
            };
            fq.insert(f.to_ascii_lowercase());
            simple.insert(t.clone());
        }
        exclude.insert(build_layout::slash(&r.path).to_ascii_lowercase());
    }
    if fq.is_empty() && pkgs.is_empty() {
        return Vec::new();
    }
    build_state::referrers_of_names(&fq, &pkgs, &simple, &exclude, all)
}

/// 编译一个模块（调用方必须已持有 `CompileSlot`，并已清取消标志）。
///
/// 两轮模型：第一轮只编决策挑出的变更 / 新增文件；编译后用桥 struct 指纹与
/// 旧清单基线比对，有结构变化才把引用方拉进第二轮，多轮直到稳定（上限
/// `MAX_STRUCT_ROUNDS`，超了 / 解析不出 / 影响面超 30% → 整模块全量兜底）。
/// 只改方法体 → 指纹不变 → 第一轮就结束，不传播。
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
    // 脏集增量 stat：开关开时取本模块脏集提示喂 decide；不可靠 / 关掉 → decide 全扫。
    let hint = if ctx.incremental_stat {
        Some(crate::compile_dirty::hint(
            &ctx.root,
            module,
            &layout.source_roots,
        ))
    } else {
        None
    };
    let used_reliable_hint =
        hint.as_ref().map(|h| h.reliable).unwrap_or(false) && mode != Mode::Full;
    let decision = build_state::decide_with_hint(
        &layout,
        previous.as_ref(),
        &cp_fp,
        &cc_fp,
        mode == Mode::Full,
        hint.as_ref(),
    );
    // 本轮是否真做了全扫（Full 判定，或 hint 不可靠 / 关掉回落全扫）：全扫成功要建基线。
    let full_scanned = !used_reliable_hint || matches!(decision, Decision::Full { .. });
    if let Decision::Skip = decision {
        // touch 场景（SVN 更新）：stat 变了内容没变，把新 stat 刷回清单，
        // 下次 decide 不再重复读文件。
        if let Some(prev) = previous.as_ref() {
            if let Some(refreshed) = build_state::touch_refresh(&layout, prev) {
                let _ = build_state::write_manifest(&ctx.manifest_file(module), &refreshed);
            }
        }
        // 全扫得出的 Skip（首轮 / 溢出回落）：建立基线，之后无变更才能可靠地直接跳。
        if ctx.incremental_stat && full_scanned {
            crate::compile_dirty::baseline(&ctx.root, module, &layout.source_roots);
        }
        ctx.log_module(module, "输入未变化，跳过（点「重新编译本模块」可强制全量）");
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
            struct_changed: false,
            removed: Vec::new(),
        });
    }

    let (files, full, reason, changed, removed) = match &decision {
        Decision::Full { reason } => {
            let files = layout.collect_sources();
            // 全量也要知道哪些文件相对旧清单变了：跨模块传播只看 changed / struct_changed
            let changed = build_state::changed_against_manifest(&layout, previous.as_ref(), &files);
            // 全量分支同样要报告删除：配置变更 + 删文件同时发生时，
            // 其它模块里引用被删类型的源文件也得跟着重编。
            let mut removed = Vec::new();
            if let Some(prev) = previous.as_ref() {
                for s in &prev.sources {
                    let abs = build_layout::safe_join(
                        &layout.module_dir,
                        &format!("{}/{}", s.root, s.rel),
                    );
                    if let Some(p) = abs {
                        if !p.exists() {
                            removed.push(build_state::RemovedSource {
                                path: p,
                                package: s.package.clone(),
                                types: s.types.clone(),
                            });
                        }
                    }
                }
            }
            (files, true, reason.clone(), changed, removed)
        }
        Decision::Incremental {
            files,
            reason,
            changed,
            removed,
        } => (
            files.clone(),
            false,
            reason.clone(),
            changed.clone(),
            removed.clone(),
        ),
        Decision::Skip => unreachable!(),
    };
    if files.is_empty() && removed.is_empty() {
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
    let env = ctx.env(&index);
    let mut result = if files.is_empty() {
        empty_result(module, "0 个文件（仅删除）")
    } else {
        compile::compile(&env, &make_job(&layout, module, &files, &seed), &|s| {
            ctx.log(s)
        })?
    };
    let mut compiled_all = files.clone();
    let mut fps_map: HashMap<String, Option<String>> = HashMap::new();
    let mut struct_changed = false;
    let mut fell_back_full = false;
    // 结构变了的文件（含模块内传播里「源码没变但内联常量变了」的引用方）：
    // 跨模块传播的种子必须是它们，不能只报最初源码变的那几个——S→R→T 链里
    // R 的常量变了，只报 S 会让别的模块里引用 R 的 T 漏编。
    let mut struct_seeds: Vec<PathBuf> = Vec::new();

    if result.error_count == 0 {
        let post = struct_fps_for(ctx, &layout, &files, previous.as_ref())?;
        let structural = structural_files(&layout, &files, previous.as_ref(), &post);
        fps_map.extend(post);
        struct_changed = !structural.is_empty() || !removed.is_empty();
        struct_seeds.extend(structural.iter().cloned());

        // 模块内结构传播（全量分支已覆盖整模块，不需要）
        if !full && struct_changed {
            let all = layout.collect_sources();
            let mut exclude: HashSet<String> = compiled_all
                .iter()
                .map(|p| build_layout::slash(p).to_ascii_lowercase())
                .collect();
            let mut queue = structural;
            let mut removed_pending = removed.clone();
            // 旧清单没记类型名（防御：schema 迁移期）→ 删除传播无从找引用方，全量兜底
            if removed_pending.iter().any(|r| r.types.is_empty()) {
                fell_back_full = true;
            }
            let mut prop_rounds = 0u32;
            while !fell_back_full && result.error_count == 0 {
                let mut refs: Vec<PathBuf> = Vec::new();
                if !queue.is_empty() {
                    match build_state::referrers(&queue, &all) {
                        Some(r) => refs.extend(r),
                        None => {
                            fell_back_full = true;
                            break;
                        }
                    }
                }
                if !removed_pending.is_empty() {
                    refs.extend(removed_referrers(&removed_pending, &all));
                    removed_pending.clear();
                }
                refs.retain(|p| !exclude.contains(&build_layout::slash(p).to_ascii_lowercase()));
                refs.sort();
                refs.dedup();
                if refs.is_empty() {
                    break;
                }
                if refs.len() * 100 > all.len().saturating_mul(30) {
                    ctx.log_module(
                        module,
                        &format!(
                            "结构变化影响 {} / {} 个源文件（超过 30%），改跑全量",
                            refs.len(),
                            all.len()
                        ),
                    );
                    fell_back_full = true;
                    break;
                }
                prop_rounds += 1;
                if prop_rounds > MAX_STRUCT_ROUNDS {
                    ctx.log_module(module, "结构传播轮数超上限，改跑全量");
                    fell_back_full = true;
                    break;
                }
                ctx.log_module(
                    module,
                    &format!("结构传播第 {prop_rounds} 轮：{} 个引用方", refs.len()),
                );
                let r2 = compile::compile(&env, &make_job(&layout, module, &refs, &seed), &|s| {
                    ctx.log(s)
                })?;
                merge_into(&mut result, &r2);
                if r2.error_count > 0 {
                    break;
                }
                let post2 = struct_fps_for(ctx, &layout, &refs, previous.as_ref())?;
                queue = structural_files(&layout, &refs, previous.as_ref(), &post2);
                struct_seeds.extend(queue.iter().cloned());
                fps_map.extend(post2);
                for p in &refs {
                    exclude.insert(build_layout::slash(p).to_ascii_lowercase());
                }
                compiled_all.extend(refs.iter().cloned());
                if queue.is_empty() {
                    break;
                }
            }
            if fell_back_full && result.error_count == 0 {
                let all_files = layout.collect_sources();
                let rf =
                    compile::compile(&env, &make_job(&layout, module, &all_files, &seed), &|s| {
                        ctx.log(s)
                    })?;
                merge_into(&mut result, &rf);
                if rf.error_count == 0 {
                    let postf = struct_fps_for(ctx, &layout, &all_files, previous.as_ref())?;
                    struct_seeds.extend(structural_files(
                        &layout,
                        &all_files,
                        previous.as_ref(),
                        &postf,
                    ));
                    fps_map.extend(postf);
                    compiled_all = all_files;
                }
            }
        }
    }

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
        reason: Some(if fell_back_full {
            format!("{reason}；结构传播保底全量")
        } else {
            reason.clone()
        }),
    });
    super::compile_cmds::cache_seed(module, result.resolved_jars.clone());

    if result.error_count == 0 {
        // 删除的源文件不能留在新清单里（否则 stale_classes 看不见它们的旧 class）。
        // 但 stale 比对要用**原始**旧清单：被删文件的 class 正是靠它找出来的。
        let prev_for_update = previous.as_ref().map(|m| {
            if removed.is_empty() {
                m.clone()
            } else {
                let rm: HashSet<String> = removed
                    .iter()
                    .map(|r| build_layout::slash(&r.path).to_ascii_lowercase())
                    .collect();
                let mut c = m.clone();
                c.sources.retain(|s| {
                    let abs = build_layout::safe_join(
                        &layout.module_dir,
                        &format!("{}/{}", s.root, s.rel),
                    );
                    !rm.contains(
                        &abs.as_deref()
                            .map(build_layout::slash)
                            .unwrap_or_default()
                            .to_ascii_lowercase(),
                    )
                });
                c
            }
        });
        let next = build_state::updated_manifest(
            &layout,
            prev_for_update.as_ref(),
            &compiled_all,
            &cp_fp,
            &cc_fp,
            result.resolved_jars.clone(),
            full || fell_back_full,
            &fps_map,
            false,
        );
        if let Some(prev) = previous.as_ref() {
            let stale = build_state::stale_classes(&layout, prev, &next);
            let removed_n = delete_stale(&stale, &layout.module_dir);
            if removed_n > 0 {
                ctx.log_module(
                    module,
                    &format!("清理 {removed_n} 个上次有、这次没有的 class"),
                );
            }
        }
        if let Err(e) = build_state::write_manifest(&ctx.manifest_file(module), &next) {
            ctx.log_module(module, &format!("构建清单写入失败（不影响本次编译）：{e}"));
        }
        // 脏集记账：全扫成功 → 建基线（清本模块脏集）；可靠增量成功 → 只消费本轮脏路径。
        // 失败分支不记账：脏路径留着下一轮重试（旧清单未更新，改动相对旧清单仍是变化）。
        if ctx.incremental_stat {
            if full_scanned {
                crate::compile_dirty::baseline(&ctx.root, module, &layout.source_roots);
            } else if let Some(h) = &hint {
                if matches!(decision, Decision::Incremental { .. }) {
                    crate::compile_dirty::consume(&ctx.root, &h.paths);
                }
            }
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
    let ok = result.error_count == 0;
    // 跨模块传播种子 = 源码变的 ∪ 结构变的（含传播里常量被连带更新的引用方）
    let mut seeds_out = changed;
    if ok {
        for p in struct_seeds {
            if !seeds_out.contains(&p) {
                seeds_out.push(p);
            }
        }
    }
    Ok(Built {
        result,
        changed_files: seeds_out,
        struct_changed,
        removed: if ok { removed } else { Vec::new() },
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

/// 工作区模块依赖图 = `.classpath` 显式边 ∪ 派生边（清单 ext × 工作区类型索引）。
///
/// NC 单根工作区的 `.classpath` 推不出模块间依赖（`module_deps` 为空），真实分层
/// 只能靠派生图。没有清单的模块按需扫一遍源码取 ext（`module_ext_refs`）——
/// 首次构建前也要能分层。**图是优化不是正确性前提**：类型索引没建好 → 只有
/// classpath 边，传播另有文本边与保底档兜底。
fn workspace_deps(ctx: &Ctx, modules: &[String]) -> HashMap<String, Vec<String>> {
    let mut deps = module_deps(&ctx.root, modules);
    let Some(types) = crate::workspace_types::shared_opt(&ctx.root, &ctx.config_dir) else {
        return deps;
    };
    let maps = crate::module_graph::type_maps(&types);
    let known: HashSet<String> = modules.iter().map(|m| m.to_ascii_lowercase()).collect();
    let mut derived_edges = 0usize;
    for m in modules {
        let ext = match ctx.manifest(m) {
            Some(man) => man.ext,
            None => build_state::module_ext_refs(&ModuleLayout::resolve(&ctx.root, m)),
        };
        let entry = deps.entry(m.clone()).or_default();
        for d in crate::module_graph::join_ext(&ext, &maps) {
            if d.eq_ignore_ascii_case(m) || !known.contains(&d.to_ascii_lowercase()) {
                continue;
            }
            if entry.iter().any(|x| x.eq_ignore_ascii_case(&d)) {
                continue;
            }
            // 类型索引里的模块名大小写可能与目录名不一致，归一到目录名
            let canon = modules
                .iter()
                .find(|x| x.eq_ignore_ascii_case(&d))
                .cloned()
                .unwrap_or(d);
            entry.push(canon);
            derived_edges += 1;
        }
    }
    if derived_edges > 0 {
        ctx.log(&format!(
            "派生模块依赖：{derived_edges} 条边（源码引用 × 类型索引）"
        ));
    }
    deps
}

/// make 闭包：目标模块 + 传递依赖，按拓扑序输出（被依赖的先编）。
///
/// 手动「编译本模块」与「编译全部」同一语义：依赖没编过 / 编不过，目标就不该编。
/// 环里的模块按 `topo_levels` 的兜底顺序放最后（与 build_all 一致）。
pub(super) fn make_closure(ctx: &Ctx, target: &str) -> Vec<String> {
    let modules = all_modules(ctx);
    let Some(canon) = modules.iter().find(|m| m.eq_ignore_ascii_case(target)) else {
        return vec![target.to_string()];
    };
    let deps = workspace_deps(ctx, &modules);
    let mut seen: HashSet<String> = HashSet::new();
    let mut closure: Vec<String> = Vec::new();
    let mut queue: Vec<String> = vec![canon.clone()];
    seen.insert(canon.to_ascii_lowercase());
    while let Some(m) = queue.pop() {
        closure.push(m.clone());
        if let Some(ds) = deps.get(&m) {
            for d in ds {
                if seen.insert(d.to_ascii_lowercase()) {
                    let name = modules
                        .iter()
                        .find(|x| x.eq_ignore_ascii_case(d))
                        .cloned()
                        .unwrap_or_else(|| d.clone());
                    queue.push(name);
                }
            }
        }
    }
    topo_levels(&closure, &deps).into_iter().flatten().collect()
}

/// 账本状态严重度：同一模块多条记录合并时取更差的那个。
fn status_rank(s: &str) -> u8 {
    match s {
        "failed" => 3,
        "blocked" => 2,
        "ok" => 1,
        _ => 0,
    }
}

/// 同一模块的两条账本合并：计数相加（传播补编 + 本模块 make 都是真实工作量），
/// 状态取更差的，原因拼接。传播补编过的模块随后 make 判 Skip 时，不能把
/// 「补编了 N 个文件」的事实覆盖成一句「输入未变化」。
fn merge_ledger(old: &ModuleBuildResult, new: &ModuleBuildResult) -> ModuleBuildResult {
    let status = if status_rank(&new.status) >= status_rank(&old.status) {
        new.status.clone()
    } else {
        old.status.clone()
    };
    let reason = match (old.reason.as_deref(), new.reason.as_deref()) {
        (Some(a), Some(b)) if a != b => Some(format!("{a}；{b}")),
        (Some(a), _) => Some(a.to_string()),
        (_, Some(b)) => Some(b.to_string()),
        _ => None,
    };
    ModuleBuildResult {
        module: new.module.clone(),
        status,
        error_count: old.error_count + new.error_count,
        warning_count: old.warning_count + new.warning_count,
        duration_ms: old.duration_ms + new.duration_ms,
        source_count: old.source_count + new.source_count,
        out_dir: if new.out_dir.is_empty() {
            old.out_dir.clone()
        } else {
            new.out_dir.clone()
        },
        cleaned: old.cleaned.max(new.cleaned),
        reason,
    }
}

/// 按模块名去重地追加账本（同名合并，见 `merge_ledger`）。
fn push_ledger(ledgers: &mut Vec<ModuleBuildResult>, led: ModuleBuildResult) {
    if let Some(old) = ledgers
        .iter_mut()
        .find(|l| l.module.eq_ignore_ascii_case(&led.module))
    {
        *old = merge_ledger(old, &led);
    } else {
        ledgers.push(led);
    }
}

/// 合并结果里的模块账本按名去重（同一模块可能既有 make 记录又有传播补编记录）。
pub(super) fn dedup_ledgers(ledgers: &mut Vec<ModuleBuildResult>) {
    let mut out: Vec<ModuleBuildResult> = Vec::new();
    for led in std::mem::take(ledgers) {
        push_ledger(&mut out, led);
    }
    *ledgers = out;
}

/// 传播保底：对一个模块强制全量。已编过的立即重编；还没轮到的记下标记，
/// 拓扑序轮到它时跑 Full（依赖必须先新）。失败 / 已阻断的模块不碰。
#[allow(clippy::too_many_arguments)]
fn fallback_full(
    ctx: &Ctx,
    module: &str,
    cleaned: &HashMap<String, usize>,
    ledgers: &mut Vec<ModuleBuildResult>,
    results: &mut Vec<CompileResult>,
    failed: &mut HashSet<String>,
    blocked: &HashSet<String>,
    built: &HashSet<String>,
    force_full_set: &mut HashSet<String>,
) {
    let key = module.to_ascii_lowercase();
    if failed.contains(&key) || blocked.contains(&key) {
        return;
    }
    if !built.contains(&key) {
        force_full_set.insert(key);
        return;
    }
    ctx.log_module(module, "传播保底：全量重编");
    let already = cleaned.get(&key).copied().unwrap_or(0);
    match build_one(ctx, module, Mode::Full, false, already) {
        Ok(b) => {
            let mut led = b
                .result
                .modules
                .last()
                .cloned()
                .unwrap_or_else(|| ModuleBuildResult::ok(module, &b.result));
            // decide 对 Mode::Full 一律报「手动要求全量」；保底触发的要如实归类，
            // 否则 cache_info 的「全量原因」统计会把保底算到用户头上
            led.reason = Some("传播保底全量".to_string());
            if led.status == "failed" {
                failed.insert(key);
            }
            push_ledger(ledgers, led);
            results.push(b.result);
        }
        Err(e) => {
            failed.insert(key);
            push_ledger(
                ledgers,
                ModuleBuildResult {
                    module: module.to_string(),
                    status: "failed".to_string(),
                    error_count: 0,
                    warning_count: 0,
                    duration_ms: 0,
                    source_count: 0,
                    out_dir: String::new(),
                    cleaned: already,
                    reason: Some(e),
                },
            );
        }
    }
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
    let deps = workspace_deps(ctx, &modules);
    let levels = topo_levels(&modules, &deps);
    let total = modules.len();
    let mut done = 0usize;
    ctx.progress("start", 0, total, None, 0);

    let mut results: Vec<CompileResult> = Vec::new();
    let mut ledgers: Vec<ModuleBuildResult> = Vec::new();
    let mut failed: HashSet<String> = HashSet::new();
    let mut blocked: HashSet<String> = HashSet::new();
    // 已处理过的模块（含传播中失败的）：保底全量据此区分「立即重编」与「轮到时全量」
    let mut built: HashSet<String> = HashSet::new();
    let mut force_full_set: HashSet<String> = HashSet::new();
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
            let key = m.to_ascii_lowercase();
            // 传播阶段已经编失败的模块：账本已记，不再起一轮 JVM
            if failed.contains(&key) {
                built.insert(key);
                done += 1;
                continue;
            }
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
                blocked.insert(key.clone());
                let reason = "依赖的模块编不过，已阻断（先修依赖再编）";
                ctx.log_module(&m, reason);
                push_ledger(
                    &mut ledgers,
                    ModuleBuildResult {
                        module: m.clone(),
                        status: "blocked".to_string(),
                        error_count: 0,
                        warning_count: 0,
                        duration_ms: 0,
                        source_count: 0,
                        out_dir: String::new(),
                        cleaned: cleaned.get(&key).copied().unwrap_or(0),
                        reason: Some(reason.to_string()),
                    },
                );
                built.insert(key);
                done += 1;
            } else {
                runnable.push(m);
            }
        }
        // 本层的结构传播种子：编成功且 class 结构变了的改动文件 + 删除的源文件
        let mut level_changed: Vec<PathBuf> = Vec::new();
        let mut level_removed: Vec<build_state::RemovedSource> = Vec::new();
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
                        let m_mode = if force_full_set.contains(&m.to_ascii_lowercase()) {
                            Mode::Full
                        } else {
                            mode
                        };
                        s.spawn(move || {
                            ctx.log_module(&m, "开始编译");
                            let already = clean_counts
                                .get(&m.to_ascii_lowercase())
                                .copied()
                                .unwrap_or(0);
                            let outcome = build_one(ctx, &m, m_mode, false, already);
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
                built.insert(module.to_ascii_lowercase());
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
                        if b.struct_changed && b.result.error_count == 0 {
                            for p in &b.changed_files {
                                if !level_changed.contains(p) {
                                    level_changed.push(p.clone());
                                }
                            }
                            level_removed.extend(b.removed.iter().cloned());
                        }
                        push_ledger(&mut ledgers, led);
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
                        push_ledger(
                            &mut ledgers,
                            ModuleBuildResult {
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
                            },
                        );
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

        // 跨模块结构传播：drain 到稳定。指纹收敛保证终止（引用方源码没变，
        // 重编一轮后指纹不再变）；轮数上限只是防异常环的保险。
        // 目标 = 除 failed/blocked 外**所有有清单的模块**，含本层已编过的：
        // 依赖图退化（类型索引没建好）时同层模块可能互相引用，不能只传下游。
        let mut pending_fresh: Vec<PathBuf> = Vec::new();
        let mut pending_intra = level_changed;
        let mut pending_removed = level_removed;
        let mut rounds = 0u32;
        while !pending_fresh.is_empty() || !pending_intra.is_empty() || !pending_removed.is_empty()
        {
            if ctx
                .st
                .compile_cancel
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                return Err(compile::CANCELLED.to_string());
            }
            let skip: HashSet<String> = failed.union(&blocked).cloned().collect();
            let mut unparsed: HashSet<String> = HashSet::new();
            if rounds >= MAX_STRUCT_ROUNDS {
                ctx.log("跨模块结构传播轮数超上限，受影响模块保底全量");
                let groups = cross_module_groups(
                    &ctx.root,
                    &ctx.config_dir,
                    &modules,
                    &pending_fresh,
                    &pending_intra,
                    &pending_removed,
                    &skip,
                    &mut unparsed,
                );
                for (m, _) in groups {
                    fallback_full(
                        ctx,
                        &m,
                        &cleaned,
                        &mut ledgers,
                        &mut results,
                        &mut failed,
                        &blocked,
                        &built,
                        &mut force_full_set,
                    );
                }
                if unparsed.contains("*") {
                    for m in &modules {
                        fallback_full(
                            ctx,
                            m,
                            &cleaned,
                            &mut ledgers,
                            &mut results,
                            &mut failed,
                            &blocked,
                            &built,
                            &mut force_full_set,
                        );
                    }
                }
                propagate_blocked(&deps, &mut failed, &mut blocked);
                break;
            }
            match propagate_structural(
                ctx,
                &pending_fresh,
                &pending_intra,
                &pending_removed,
                &skip,
                &mut unparsed,
            )? {
                None => {
                    if unparsed.contains("*") {
                        ctx.log("改动源码解析不出类型名，剩余模块保底全量（宁可多编不漏编）");
                        for m in &modules {
                            fallback_full(
                                ctx,
                                m,
                                &cleaned,
                                &mut ledgers,
                                &mut results,
                                &mut failed,
                                &blocked,
                                &built,
                                &mut force_full_set,
                            );
                        }
                        propagate_blocked(&deps, &mut failed, &mut blocked);
                    }
                    break;
                }
                Some(p) => {
                    for led in &p.result.modules {
                        if led.status == "failed" {
                            failed.insert(led.module.to_ascii_lowercase());
                        }
                        push_ledger(&mut ledgers, led.clone());
                    }
                    propagate_blocked(&deps, &mut failed, &mut blocked);
                    results.push(p.result);
                    // 传播新产出的种子是 fresh：它所在模块的模块内引用方还没编
                    pending_fresh = p.next;
                    pending_intra = Vec::new();
                    pending_removed = Vec::new();
                    rounds += 1;
                }
            }
        }
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
    // push_ledger 已按模块去重合并（传播补编 + make 两条账本合成一条），按名排序稳定显示
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

pub(super) fn append_history(ctx: &Ctx, r: &CompileResult) {
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
/// `preserve_struct=true`（保存快速反馈）：清单沿用旧结构指纹并标 pending，
/// 结构判定留给下一轮空闲增量；`false`（传播补编）：本轮就做结构判定并写新指纹。
/// 返回 `(合并结果, 结构变了的源文件)`：第二项只在 `preserve_struct=false` 时非空，
/// 供调用方继续下一轮传播（Eclipse 队列 / JPS 多轮 differentiate 的等价物）。
/// 调用方需先确认索引已就绪；不拿编译闸（调用方持有）。
pub(super) fn compile_files(
    ctx: &Ctx,
    groups: Vec<(String, Vec<PathBuf>)>,
    fast: bool,
    preserve_struct: bool,
) -> Result<(CompileResult, Vec<PathBuf>), String> {
    let total_files: usize = groups.iter().map(|(_, f)| f.len()).sum();
    let mut results = Vec::with_capacity(groups.len());
    let mut structural: Vec<PathBuf> = Vec::new();
    // 热替换：只收集零错误模块的产物。有错时 ecj 可能写出带「编译错误桩」的 class，
    // 推进运行中的 NC 会把能跑的代码换成会抛异常的代码。
    // 中间件和客户端是两个 JVM，一个源文件推给谁由它所在的源码目录决定
    let mut hotswap_server = crate::hotswap::Batch::default();
    let mut hotswap_client = crate::hotswap::Batch::default();
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
                // preserve_struct=true：updated_manifest 内部沿用旧指纹 + 标 pending，
                // 空闲增量才能看见「结构变了」并做传播；false：本轮取新指纹写真值。
                let fps = if preserve_struct {
                    HashMap::new()
                } else {
                    let fps = struct_fps_for(ctx, &layout, &files, Some(prev))?;
                    structural.extend(structural_files(&layout, &files, Some(prev), &fps));
                    fps
                };
                let next = build_state::updated_manifest(
                    &layout,
                    Some(prev),
                    &files,
                    &cp_fp,
                    &cc_fp,
                    r.resolved_jars.clone(),
                    false,
                    &fps,
                    preserve_struct,
                );
                let _ = build_state::write_manifest(&ctx.manifest_file(&module), &next);
            }
            if ctx.hotswap_enabled {
                collect_hotswap(
                    &mut hotswap_server,
                    &mut hotswap_client,
                    &layout,
                    &job.out_dir,
                    &files,
                );
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
        hotswap_server,
        hotswap_client,
    );
    Ok((merge_compile_results(results, total_files), structural))
}

/// 把本模块编过的源文件映射成待替换的类。
///
/// 产物目录按源根取（一个模块可能有多个 output），取不到时回落本轮的默认产物目录，
/// 与 `compile::compile` 写 class 的口径一致。包名从源码里读：GBK 文件按有损解码也不影响
/// `package` 那一行（纯 ASCII）。
///
/// `private` 只进中间件批，`client` 只进客户端批，`public` 两边都进（见 `hotswap::targets_for_source`）。
fn collect_hotswap(
    server: &mut crate::hotswap::Batch,
    client: &mut crate::hotswap::Batch,
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
        let (to_server, to_client) = crate::hotswap::targets_for_source(f);
        if to_server {
            server.add_source(&out, &package, f);
        }
        if to_client {
            client.add_source(&out, &package, f);
        }
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

/// 一轮跨模块传播的结果：合并结果 + 结构又变了的引用方（下一轮的种子）。
pub(super) struct Propagation {
    pub result: CompileResult,
    pub next: Vec<PathBuf>,
}

/// 跨模块结构传播：模块 A 的 class 结构变了（或删了源文件），其它模块里引用
/// 这些类型的源文件也得重编，否则它们的字节码里还留着旧签名（编译不报错，运行期才炸）。
///
/// 种子分两类，**按归属模块过滤**而不是整模块 skip：
/// - `intra`：`build_one` 产出的种子，产出模块的**模块内**引用方已经编过——
///   目标模块只排除「自己产出的 intra 种子」，别的模块传进来的边照常编。
///   整模块 skip 会漏掉「两个互引模块同批都改结构」的交叉边（审查抓到的真 bug）。
/// - `fresh`：传播轮里 `compile_files` 新产出的种子，它所在模块的模块内引用方
///   **还没编**（compile_files 不做模块内传播），任何目标模块都不能排除。
/// - `removed`：删除种子，模块内引用方已由 build_one 处理，按 intra 同口径过滤。
///
/// `unparsed`：种子解析不出类型名时收进 `"*"`——边找不出来，调用方据此对
/// 剩余模块强制全量（保底档）。空闲增量可以宁可漏编，`build_all` 不行。
/// 调用方需已持有编译闸、且确认索引可用。
pub(super) fn propagate_structural(
    ctx: &Ctx,
    fresh: &[PathBuf],
    intra: &[PathBuf],
    removed: &[build_state::RemovedSource],
    skip: &HashSet<String>,
    unparsed: &mut HashSet<String>,
) -> Result<Option<Propagation>, String> {
    if fresh.is_empty() && intra.is_empty() && removed.is_empty() {
        return Ok(None);
    }
    let groups = cross_module_groups(
        &ctx.root,
        &ctx.config_dir,
        &all_modules(ctx),
        fresh,
        intra,
        removed,
        skip,
        unparsed,
    );
    if groups.is_empty() {
        return Ok(None);
    }
    ctx.log(&format!(
        "跨模块结构传播：{} 个改动 / {} 个删除影响到 {} 个模块（{}）",
        fresh.len() + intra.len(),
        removed.len(),
        groups.len(),
        groups
            .iter()
            .map(|(m, f)| format!("{m} {} 个", f.len()))
            .collect::<Vec<_>>()
            .join("、")
    ));
    // preserve_struct=false：引用方自己的源码没变，结构指纹就是真值，不必留给下一轮再发现
    let (result, next) = compile_files(ctx, groups, true, false)?;
    // 有模块编失败：失败模块的旧产物仍在使用，从它继续传播没有意义；
    // 调用方按账本里的 failed 决定阻断。
    let next = if result.error_count == 0 {
        next
    } else {
        Vec::new()
    };
    Ok(Some(Propagation { result, next }))
}

/// `propagate_structural` 的纯文件系统部分：找出引用种子的其它模块源文件。
///
/// 不看 `module_deps`：单根 `.classpath` 的工作区（真实 NC 工程）所有模块共用一份
/// 类路径，依赖关系推导出来是空的；只能按 import / 同包 / 通配找引用方。
/// 没有清单的模块跳过：从未编译过就没有旧字节码，轮到它时自然全量。
/// 种子解析不出类型名 → `unparsed` 收 `"*"`，调用方保底全量。
#[allow(clippy::too_many_arguments)]
pub(super) fn cross_module_groups(
    root: &Path,
    config_dir: &Path,
    modules: &[String],
    fresh: &[PathBuf],
    intra: &[PathBuf],
    removed: &[build_state::RemovedSource],
    skip: &HashSet<String>,
    unparsed: &mut HashSet<String>,
) -> Vec<(String, Vec<PathBuf>)> {
    // 种子的类型名解析不出（含已删除 / 读不出的改动文件）：这是种子的问题，
    // 不是某个目标模块的问题——任何模块都可能引用它，只能整体保底。
    let all_seeds: Vec<PathBuf> = fresh.iter().chain(intra.iter()).cloned().collect();
    if !all_seeds.is_empty() && build_state::referrers(&all_seeds, &[]).is_none() {
        unparsed.insert("*".to_string());
        return Vec::new();
    }
    if removed.iter().any(|r| r.types.is_empty()) {
        unparsed.insert("*".to_string());
        return Vec::new();
    }
    let owner = |p: &Path| compile::module_of(root, p).unwrap_or_default();
    let mut groups = Vec::new();
    for module in modules {
        if skip.contains(&module.to_ascii_lowercase()) {
            continue;
        }
        if !build_state::manifest_path(config_dir, root, module).is_file() {
            continue;
        }
        let layout = ModuleLayout::resolve(root, module);
        let sources = layout.collect_sources();
        if sources.is_empty() {
            continue;
        }
        // 本模块产出的 intra 种子：模块内引用方 build_one 已编，排除；
        // 别的模块的 intra 种子 + 全部 fresh 种子：照常找引用方。
        let mut seeds: Vec<PathBuf> = fresh.to_vec();
        seeds.extend(
            intra
                .iter()
                .filter(|p| !owner(p).eq_ignore_ascii_case(module))
                .cloned(),
        );
        let rm: Vec<build_state::RemovedSource> = removed
            .iter()
            .filter(|r| !owner(&r.path).eq_ignore_ascii_case(module))
            .cloned()
            .collect();
        if seeds.is_empty() && rm.is_empty() {
            continue;
        }
        let mut refs = Vec::new();
        if !seeds.is_empty() {
            // 种子可解析性已在上面验证，这里必然是 Some
            refs.extend(build_state::referrers(&seeds, &sources).unwrap_or_default());
        }
        if !rm.is_empty() {
            refs.extend(removed_referrers(&rm, &sources));
        }
        refs.sort();
        refs.dedup();
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

    /// struct_fps_for 的无 Ctx 等价物（真机测试用）：同一套
    /// classes_for_source + class_fp::combine 口径，桥失败 → 全 None。
    fn live_fps(
        java: &Path,
        ecj: &Path,
        bridge: &Path,
        work: &Path,
        cancel: &std::sync::atomic::AtomicBool,
        layout: &ModuleLayout,
        sources: &[PathBuf],
    ) -> HashMap<String, Option<String>> {
        let mut classes = Vec::new();
        let mut per: Vec<(String, Vec<PathBuf>)> = Vec::new();
        for p in sources {
            let Some(stamp) = build_state::source_stamp(layout, p, true) else {
                continue;
            };
            let out = layout
                .output_for(p)
                .unwrap_or_else(|| layout.outputs[0].clone());
            let abs: Vec<PathBuf> = build_state::classes_for_source(&out, &stamp.package, p)
                .iter()
                .filter_map(|r| build_layout::safe_join(&out, r))
                .collect();
            classes.extend(abs.iter().cloned());
            per.push((stamp.key(), abs));
        }
        let fps =
            crate::ecj_worker::struct_fps(java, ecj, bridge, &classes, work, Some(cancel)).unwrap();
        let mut out = HashMap::new();
        for (key, abs) in per {
            out.insert(
                key,
                fps.as_ref().and_then(|m| {
                    crate::class_fp::combine(
                        &abs.iter()
                            .map(|c| m.get(&crate::class_fp::key(c)).cloned())
                            .collect::<Vec<_>>(),
                    )
                }),
            );
        }
        out
    }

    #[test]
    fn cross_module_groups_finds_only_referrers() {
        let root = tmp("xmod");
        let cfg = tmp("xmod-cfg");
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
        // 传播只针对编过的模块：给 b / c 落一份清单文件（存在性即可）
        for m in ["b", "c"] {
            let p = build_state::manifest_path(&cfg, &root, m);
            write(&p, "stub");
        }
        let changed = vec![root.join("a/src/public/p/A.java")];
        let skip: HashSet<String> = ["a".to_string()].into_iter().collect();
        let mut unparsed = HashSet::new();
        let groups = cross_module_groups(
            &root,
            &cfg,
            &names(&["a", "b", "c"]),
            &[],
            &changed,
            &[],
            &skip,
            &mut unparsed,
        );
        assert!(unparsed.is_empty());
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
        let cfg = tmp("xmod-th-cfg");
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
        let p = build_state::manifest_path(&cfg, &root, "b");
        write(&p, "stub");
        let changed = vec![root.join("a/src/public/p/A.java")];
        let skip: HashSet<String> = ["a".to_string()].into_iter().collect();
        let mut unparsed = HashSet::new();
        // 2 个源文件里 1 个引用 = 50% > 30%，与模块内增量一样整模块跑
        let groups = cross_module_groups(
            &root,
            &cfg,
            &names(&["a", "b"]),
            &[],
            &changed,
            &[],
            &skip,
            &mut unparsed,
        );
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].1.len(), 2, "应扩展为整模块：{:?}", groups[0].1);
    }

    #[test]
    fn 没有清单的模块不参与传播() {
        let root = tmp("xmod-noman");
        let cfg = tmp("xmod-noman-cfg");
        write(
            &root.join("a/src/public/p/A.java"),
            "package p; public class A {}",
        );
        write(
            &root.join("b/src/public/q/B.java"),
            "package q; import p.A; public class B { A a; }",
        );
        // b 从未编过（无清单）：没有旧字节码可修，轮到它时自然全量
        let changed = vec![root.join("a/src/public/p/A.java")];
        let mut unparsed = HashSet::new();
        let groups = cross_module_groups(
            &root,
            &cfg,
            &names(&["a", "b"]),
            &[],
            &changed,
            &[],
            &HashSet::new(),
            &mut unparsed,
        );
        assert!(groups.is_empty(), "无清单模块不该被补编：{groups:?}");
        assert!(unparsed.is_empty());
    }

    #[test]
    fn 种子解析不出类型名时整体保底() {
        let root = tmp("xmod-unparsed");
        let cfg = tmp("xmod-unparsed-cfg");
        // 只有包声明、没有任何类型：referrers 解析不出种子类型名
        write(&root.join("a/src/public/p/package-info.java"), "package p;");
        write(
            &root.join("b/src/public/q/B.java"),
            "package q; public class B {}",
        );
        let p = build_state::manifest_path(&cfg, &root, "b");
        write(&p, "stub");
        let changed = vec![root.join("a/src/public/p/package-info.java")];
        let mut unparsed = HashSet::new();
        let groups = cross_module_groups(
            &root,
            &cfg,
            &names(&["a", "b"]),
            &[],
            &changed,
            &[],
            &HashSet::new(),
            &mut unparsed,
        );
        assert!(groups.is_empty());
        assert!(unparsed.contains("*"), "应标记整体保底：{unparsed:?}");
    }

    #[test]
    fn 删除的源文件按旧清单类型名找跨模块引用方() {
        let root = tmp("xmod-removed");
        let cfg = tmp("xmod-removed-cfg");
        write(
            &root.join("b/src/public/q/B.java"),
            "package q; import p.A; public class B { A a; }",
        );
        let p = build_state::manifest_path(&cfg, &root, "b");
        write(&p, "stub");
        // A.java 已不在磁盘上，只有旧清单里的包名 + 类型名
        let removed = vec![build_state::RemovedSource {
            path: root.join("a/src/public/p/A.java"),
            package: "p".to_string(),
            types: vec!["A".to_string()],
        }];
        let mut unparsed = HashSet::new();
        let groups = cross_module_groups(
            &root,
            &cfg,
            &names(&["a", "b"]),
            &[],
            &[],
            &removed,
            &HashSet::new(),
            &mut unparsed,
        );
        assert!(unparsed.is_empty());
        assert_eq!(groups.len(), 1, "删除也应命中引用方：{groups:?}");
        assert_eq!(groups[0].0, "b");
        assert!(groups[0].1[0].ends_with("B.java"));
        // 反例：旧清单没记类型名（schema 迁移期）→ 找不出边，整体保底
        let bad = vec![build_state::RemovedSource {
            path: root.join("a/src/public/p/A.java"),
            package: "p".to_string(),
            types: Vec::new(),
        }];
        let mut unparsed2 = HashSet::new();
        let groups2 = cross_module_groups(
            &root,
            &cfg,
            &names(&["a", "b"]),
            &[],
            &[],
            &bad,
            &HashSet::new(),
            &mut unparsed2,
        );
        assert!(groups2.is_empty());
        assert!(unparsed2.contains("*"));
    }

    #[test]
    fn intra种子不回归属模块_fresh种子会() {
        // 反例场景：两个源模块同轮一起改、互相引用。a 的 A.java 是 build_one
        // 产出（intra）：a 内引用方 A2 已随 build_one 编过，不能再整模块跳过 a
        // 也不能把 A2 再算一遍；而传播新产出（fresh）的归属模块内引用方还没编，
        // 必须补上。旧实现按「做过结构传播的模块」整体 skip，两条都错。
        let root = tmp("xmod-own");
        let cfg = tmp("xmod-own-cfg");
        write(
            &root.join("a/src/public/p/A.java"),
            "package p; public class A { public int x; }",
        );
        write(
            &root.join("a/src/public/p/A2.java"),
            "package p; public class A2 { A a; }",
        );
        // 垫 3 个无关文件：1/5 = 20% < 30%，不触发整模块扩展
        for i in 0..3 {
            write(
                &root.join(format!("a/src/public/p/N{i}.java")),
                &format!("package p; public class N{i} {{}}"),
            );
        }
        write(
            &root.join("b/src/public/q/B.java"),
            "package q; import p.A; public class B { A a; }",
        );
        for m in ["a", "b"] {
            let p = build_state::manifest_path(&cfg, &root, m);
            write(&p, "stub");
        }
        let seed = vec![root.join("a/src/public/p/A.java")];
        let modules = names(&["a", "b"]);
        // intra：a 被归属过滤掉，只命中 b
        let mut unparsed = HashSet::new();
        let groups = cross_module_groups(
            &root,
            &cfg,
            &modules,
            &[],
            &seed,
            &[],
            &HashSet::new(),
            &mut unparsed,
        );
        assert!(unparsed.is_empty());
        assert_eq!(groups.len(), 1, "intra 种子不该回到归属模块 a：{groups:?}");
        assert_eq!(groups[0].0, "b");
        assert!(groups[0].1[0].ends_with("B.java"));
        // fresh：a 的模块内引用方 A2 还没编，必须补上；b 照常
        let mut unparsed2 = HashSet::new();
        let groups2 = cross_module_groups(
            &root,
            &cfg,
            &modules,
            &seed,
            &[],
            &[],
            &HashSet::new(),
            &mut unparsed2,
        );
        assert_eq!(groups2.len(), 2, "fresh 种子应同时命中 a 和 b：{groups2:?}");
        let ga = groups2.iter().find(|(m, _)| m == "a").expect("应含 a");
        assert_eq!(ga.1.len(), 1, "a 只应带引用方 A2：{:?}", ga.1);
        assert!(ga.1[0].ends_with("A2.java"));
    }

    #[test]
    fn 删除种子按归属过滤_归属模块内已处理() {
        // 删除只来自 build_one：归属模块内的引用方已在 build_one 的删除传播里
        // 处理过，这里只找其它模块的引用方，避免归属模块被重复整编。
        let root = tmp("xmod-rmown");
        let cfg = tmp("xmod-rmown-cfg");
        write(
            &root.join("a/src/public/p/A2.java"),
            "package p; public class A2 { A a; }",
        );
        write(
            &root.join("b/src/public/q/B.java"),
            "package q; import p.A; public class B { A a; }",
        );
        for m in ["a", "b"] {
            let p = build_state::manifest_path(&cfg, &root, m);
            write(&p, "stub");
        }
        let removed = vec![build_state::RemovedSource {
            path: root.join("a/src/public/p/A.java"),
            package: "p".to_string(),
            types: vec!["A".to_string()],
        }];
        let mut unparsed = HashSet::new();
        let groups = cross_module_groups(
            &root,
            &cfg,
            &names(&["a", "b"]),
            &[],
            &[],
            &removed,
            &HashSet::new(),
            &mut unparsed,
        );
        assert!(unparsed.is_empty());
        assert_eq!(groups.len(), 1, "删除种子不该回到归属模块 a：{groups:?}");
        assert_eq!(groups[0].0, "b");
        assert!(groups[0].1[0].ends_with("B.java"));
    }

    #[test]
    fn 账本合并_传播补编不被_skip_覆盖() {
        let propagated = ModuleBuildResult {
            module: "b".to_string(),
            status: "ok".to_string(),
            error_count: 0,
            warning_count: 1,
            duration_ms: 300,
            source_count: 2,
            out_dir: "C:/w/b/classes".to_string(),
            cleaned: 0,
            reason: Some("跨模块传播补编".to_string()),
        };
        let skipped = ModuleBuildResult {
            module: "B".to_string(),
            status: "skipped".to_string(),
            error_count: 0,
            warning_count: 0,
            duration_ms: 0,
            source_count: 0,
            out_dir: String::new(),
            cleaned: 0,
            reason: Some("输入未变化".to_string()),
        };
        let mut ledgers = vec![propagated];
        push_ledger(&mut ledgers, skipped);
        assert_eq!(ledgers.len(), 1, "同一模块只留一条");
        assert_eq!(ledgers[0].status, "ok", "补编过就不是「未变化」");
        assert_eq!(ledgers[0].source_count, 2);
        assert_eq!(ledgers[0].warning_count, 1);
        assert_eq!(ledgers[0].out_dir, "C:/w/b/classes");
        let reason = ledgers[0].reason.as_deref().unwrap();
        assert!(reason.contains("跨模块传播补编") && reason.contains("输入未变化"));
        // 失败优先：随后 make 失败不能被早先的 ok 掩盖
        let failed = ModuleBuildResult {
            module: "b".to_string(),
            status: "failed".to_string(),
            error_count: 3,
            warning_count: 0,
            duration_ms: 100,
            source_count: 1,
            out_dir: String::new(),
            cleaned: 0,
            reason: Some("编译有错误".to_string()),
        };
        push_ledger(&mut ledgers, failed);
        assert_eq!(ledgers[0].status, "failed");
        assert_eq!(ledgers[0].error_count, 3);
    }

    /// 反例门禁 + fixture 差分门禁（真机、`#[ignore]`，方案 §3.4-7 / §3.7）。
    ///
    /// 用真实 ecj + 常驻桥跑完整链路：全量基线 → 保存快速编译（preserve_struct）
    /// → 空闲增量（decide → 编 → struct 指纹 → structural_files）→ 按文本边传播，
    /// 逐字节比对「增量产物 == 从空目录全量产物」。五组反例：
    /// 方法体改动**不**传播；String 常量 / 数字常量 / private 常量 + 内部类 /
    /// 签名改动**必须**传播。另注入桥失败 → 指纹未知 → 宁可多编。
    /// 增删两组走 decide + stale_classes 全链路。
    /// 双源互引一组：同轮一起改、互相内联常量的两个源模块，整体 skip 的旧语义
    /// 会漏掉互引边（反例断言），新语义按种子归属过滤后产物与全量逐字节一致。
    /// 三跳链一组：S→R→T，R 源码没变但内联常量被连带更新，跨模块种子必须含 R
    /// （只报源码变的 S 会漏掉 T），补编后产物与全量逐字节一致。
    ///
    /// 运行：`node scripts/rust-gate.mjs test --lib -- --ignored 结构传播反例门禁_live --nocapture`
    #[test]
    #[ignore]
    fn 结构传播反例门禁_live() {
        use std::collections::BTreeMap;
        use std::sync::atomic::AtomicBool;

        let java = [
            PathBuf::from("D:/ncc/1909home"),
            PathBuf::from("C:/ncc/1909home"),
        ]
        .into_iter()
        .find(|p| p.is_dir())
        .map(|h| h.join("ufjdk").join("bin").join("java.exe"));
        let res = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources");
        let ecj = res.join("ecj").join("ecj-3.17.jar");
        let bridge = res.join("ecj-bridge").join(crate::ecj_worker::BRIDGE_JAR);
        let Some(java) = java else {
            println!("跳过：本机没有 NC home / java");
            return;
        };
        if !java.is_file() || !ecj.is_file() || !bridge.is_file() {
            println!("跳过：本机没有 java / ecj / 桥 jar");
            return;
        }

        fn write_src(p: &Path, s: &str) {
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, s).unwrap();
        }
        fn snapshot(dir: &Path, prefix: &str, out: &mut BTreeMap<String, Vec<u8>>) {
            fn walk(cur: &Path, base: &Path, prefix: &str, out: &mut BTreeMap<String, Vec<u8>>) {
                let Ok(rd) = std::fs::read_dir(cur) else {
                    return;
                };
                for e in rd.flatten() {
                    let p = e.path();
                    if p.is_dir() {
                        walk(&p, base, prefix, out);
                    } else if p.extension().is_some_and(|x| x == "class") {
                        let rel = p
                            .strip_prefix(base)
                            .unwrap()
                            .to_string_lossy()
                            .replace('\\', "/");
                        out.insert(format!("{prefix}/{rel}"), std::fs::read(&p).unwrap());
                    }
                }
            }
            walk(dir, dir, prefix, out);
        }

        let base = crate::test_support::tmp("struct-gate");
        let work = base.join("work");
        std::fs::create_dir_all(&work).unwrap();
        let home = base.join("nchome");
        let index = crate::nc_index::ClassIndex::build(Vec::new());
        let cancel = AtomicBool::new(false);

        #[allow(clippy::too_many_arguments)]
        fn make_env<'a>(
            root: &'a Path,
            home: &'a Path,
            java: &'a Path,
            ecj: &'a Path,
            bridge: &'a Path,
            index: &'a crate::nc_index::ClassIndex,
            work: &'a Path,
            cancel: &'a AtomicBool,
        ) -> compile::CompileEnv<'a> {
            compile::CompileEnv {
                nc_home: home,
                java_exe: java,
                ecj_jar: ecj,
                worker_jar: Some(bridge),
                project_root: root,
                index,
                work_dir: work,
                cancel: Some(cancel),
                overrides: &[],
            }
        }
        let compile_into = |env: &compile::CompileEnv,
                            module: &str,
                            files: Vec<PathBuf>,
                            out: &Path,
                            fast: bool| {
            let job = compile::CompileJob {
                module: module.to_string(),
                files: Some(files),
                out_dir: out.to_path_buf(),
                source_roots: None,
                output_map: Vec::new(),
                seed_jars: Vec::new(),
                fast,
            };
            let r = compile::compile(env, &job, &|_| {}).unwrap();
            assert_eq!(r.error_count, 0, "{module} 编译错误：{:?}", r.problems);
        };
        // struct_fps_for 的无 Ctx 等价物：同一套 classes_for_source + combine 口径
        let fps_of = |layout: &ModuleLayout, sources: &[PathBuf]| {
            live_fps(&java, &ecj, &bridge, &work, &cancel, layout, sources)
        };

        // (名字, A v1, A v2, B, 是否应传播)
        let variants: Vec<(&str, &str, &str, &str, bool)> = vec![
            (
                "方法体改动不传播",
                "package p; public class A { public int f(int v) { return v + 1; } }",
                "package p; public class A { public int f(int v) { return v + 2; } }",
                "package q; import p.A; public class B { public int g(A a) { return a.f(1); } }",
                false,
            ),
            (
                "String常量必须传播",
                "package p; public class A { public static final String S = \"s1\"; }",
                "package p; public class A { public static final String S = \"s2\"; }",
                "package q; import p.A; public class B { public String g() { return A.S; } }",
                true,
            ),
            (
                "数字常量必须传播",
                "package p; public class A { public static final int N = 1; }",
                "package p; public class A { public static final int N = 2; }",
                "package q; import p.A; public class B { public int g() { return A.N; } }",
                true,
            ),
            (
                "private常量与内部类必须传播",
                "package p; public class A { private static final int P = 1; public static class Inner { public int g() { return P; } } }",
                "package p; public class A { private static final int P = 2; public static class Inner { public int g() { return P; } } }",
                "package q; import p.A; public class B { public int g() { return new A.Inner().g(); } }",
                true,
            ),
            (
                "签名改动必须传播",
                "package p; public class A { public int f(int v) { return v; } }",
                "package p; public class A { public int f(long v) { return (int) v; } }",
                "package q; import p.A; public class B { public int g(A a) { return a.f(1); } }",
                true,
            ),
        ];

        let a_rel = "a/src/public/p/A.java";
        let b_rel = "b/src/public/q/B.java";
        // 留给失败注入用：最后一轮的布局与清单
        let mut last: Option<(PathBuf, ModuleLayout, Manifest, PathBuf)> = None;

        for (i, (name, a_v1, a_v2, b_src, expect)) in variants.iter().enumerate() {
            // 每个工作区单独一层父目录：类路径启发式会看兄弟目录，不能互相看见产物
            let inc = base.join(format!("inc{i}")).join("ws");
            let full = base.join(format!("full{i}")).join("ws");
            for root in [&inc, &full] {
                write_src(&root.join(a_rel), a_v1);
                write_src(&root.join(b_rel), b_src);
            }
            let la = ModuleLayout::resolve(&inc, "a");
            let lb = ModuleLayout::resolve(&inc, "b");
            let a = inc.join(a_rel);
            let a_sources = la.collect_sources();
            let b_sources = lb.collect_sources();
            let env = make_env(&inc, &home, &java, &ecj, &bridge, &index, &work, &cancel);
            compile_into(&env, "a", a_sources.clone(), &la.outputs[0], false);
            compile_into(&env, "b", b_sources.clone(), &lb.outputs[0], false);
            let prev_a = build_state::updated_manifest(
                &la,
                None,
                &a_sources,
                "cp",
                "cc",
                vec![],
                true,
                &fps_of(&la, &a_sources),
                false,
            );
            let prev_b = build_state::updated_manifest(
                &lb,
                None,
                &b_sources,
                "cp",
                "cc",
                vec![],
                true,
                &fps_of(&lb, &b_sources),
                false,
            );
            assert!(
                prev_a.sources[0].struct_fp.is_some(),
                "{name}: 基线指纹没取到"
            );

            // 保存快速编译：只编 A，清单保留旧指纹 + pending
            write_src(&a, a_v2);
            compile_into(&env, "a", vec![a.clone()], &la.outputs[0], true);
            let fast_a = build_state::updated_manifest(
                &la,
                Some(&prev_a),
                std::slice::from_ref(&a),
                "cp",
                "cc",
                vec![],
                false,
                &HashMap::new(),
                true,
            );
            assert!(
                fast_a.sources[0].struct_pending,
                "{name}: 快速编译应标 pending"
            );
            assert_eq!(
                fast_a.sources[0].struct_fp, prev_a.sources[0].struct_fp,
                "{name}: 快速编译不能把新指纹写进去"
            );

            // 空闲增量：pending 必须进编译轮；编完做结构判定
            match build_state::decide(&la, Some(&fast_a), "cp", "cc", false) {
                build_state::Decision::Incremental { files, .. } => {
                    assert_eq!(files.len(), 1, "{name}: 空闲轮应只编 A");
                }
                other => panic!("{name}: pending 应强制编译轮，got {other:?}"),
            }
            compile_into(&env, "a", vec![a.clone()], &la.outputs[0], true);
            let post = fps_of(&la, std::slice::from_ref(&a));
            let structural = structural_files(&la, std::slice::from_ref(&a), Some(&fast_a), &post);
            assert_eq!(
                !structural.is_empty(),
                *expect,
                "{name}: 结构判定与预期不符（structural={structural:?}）"
            );

            // 传播：按文本边补编引用方
            if *expect {
                let refs = build_state::referrers(std::slice::from_ref(&a), &b_sources).unwrap();
                assert!(
                    refs.iter().any(|p| p.ends_with("B.java")),
                    "{name}: 没找到引用方 B：{refs:?}"
                );
                compile_into(&env, "b", refs, &lb.outputs[0], true);
            }

            // 对照组：同一份最终源码从空产物目录全量编一遍
            write_src(&full.join(a_rel), a_v2);
            let fenv = make_env(&full, &home, &java, &ecj, &bridge, &index, &work, &cancel);
            let fla = ModuleLayout::resolve(&full, "a");
            let flb = ModuleLayout::resolve(&full, "b");
            compile_into(&fenv, "a", fla.collect_sources(), &fla.outputs[0], false);
            compile_into(&fenv, "b", flb.collect_sources(), &flb.outputs[0], false);
            let mut got = BTreeMap::new();
            snapshot(&la.outputs[0], "a", &mut got);
            snapshot(&lb.outputs[0], "b", &mut got);
            let mut want = BTreeMap::new();
            snapshot(&fla.outputs[0], "a", &mut want);
            snapshot(&flb.outputs[0], "b", &mut want);
            assert_eq!(got, want, "{name}: 增量产物与全量不一致");
            let _ = prev_b;
            last = Some((inc.clone(), la, fast_a, a.clone()));
        }

        // 失败注入：桥 jar 不存在 → 指纹未知 → 一律按结构变化处理（宁可多编）
        let (inc, la, fast_a, a) = last.expect("至少跑过一组");
        let missing = work.join("no-such-bridge.jar");
        let out = la.outputs[0].clone();
        let classes: Vec<PathBuf> = build_state::classes_for_source(&out, "p", &a)
            .iter()
            .filter_map(|r| build_layout::safe_join(&out, r))
            .collect();
        let none =
            crate::ecj_worker::struct_fps(&java, &ecj, &missing, &classes, &work, Some(&cancel))
                .unwrap();
        assert!(none.is_none(), "桥缺失应返回 None 而不是报错");
        let key = build_state::source_stamp(&la, &a, false).unwrap().key();
        let mut post_none = HashMap::new();
        post_none.insert(key, None);
        assert!(
            !structural_files(&la, std::slice::from_ref(&a), Some(&fast_a), &post_none).is_empty(),
            "指纹未知必须按结构变化处理"
        );
        let _ = inc;

        // 增删两组：decide → 编新增 / stale_classes 清删除，产物与全量一致
        let ws = base.join("addrm").join("ws");
        let full = base.join("addrm-full").join("ws");
        let a_src = "package p; public class A { public static final String S = \"s1\"; }";
        let b_src = "package q; import p.A; public class B { public String g() { return A.S; } }";
        let c_src = "package q; import p.A; public class C { public String g() { return A.S; } }";
        for root in [&ws, &full] {
            write_src(&root.join(a_rel), a_src);
            write_src(&root.join(b_rel), b_src);
        }
        let la = ModuleLayout::resolve(&ws, "a");
        let lb = ModuleLayout::resolve(&ws, "b");
        let env = make_env(&ws, &home, &java, &ecj, &bridge, &index, &work, &cancel);
        compile_into(&env, "a", la.collect_sources(), &la.outputs[0], false);
        compile_into(&env, "b", lb.collect_sources(), &lb.outputs[0], false);
        let prev_b = build_state::updated_manifest(
            &lb,
            None,
            &lb.collect_sources(),
            "cp",
            "cc",
            vec![],
            true,
            &fps_of(&lb, &lb.collect_sources()),
            false,
        );
        // 新增 C：只编 C，不全量
        let c = ws.join("b/src/public/q/C.java");
        write_src(&c, c_src);
        match build_state::decide(&lb, Some(&prev_b), "cp", "cc", false) {
            build_state::Decision::Incremental { files, removed, .. } => {
                assert_eq!(files.len(), 1, "新增应只编新文件");
                assert!(files[0].ends_with("C.java"));
                assert!(removed.is_empty());
            }
            other => panic!("新增应走增量，got {other:?}"),
        }
        compile_into(&env, "b", vec![c.clone()], &lb.outputs[0], true);
        let with_c = build_state::updated_manifest(
            &lb,
            Some(&prev_b),
            std::slice::from_ref(&c),
            "cp",
            "cc",
            vec![],
            false,
            &fps_of(&lb, std::slice::from_ref(&c)),
            false,
        );
        write_src(&full.join("b/src/public/q/C.java"), c_src);
        let fenv = make_env(&full, &home, &java, &ecj, &bridge, &index, &work, &cancel);
        // 对照组也要先编 a：b 的类路径靠「兄弟模块/classes」启发式找到 p.A
        let fla = ModuleLayout::resolve(&full, "a");
        compile_into(&fenv, "a", fla.collect_sources(), &fla.outputs[0], false);
        let flb = ModuleLayout::resolve(&full, "b");
        compile_into(&fenv, "b", flb.collect_sources(), &flb.outputs[0], false);
        let mut got = BTreeMap::new();
        snapshot(&lb.outputs[0], "b", &mut got);
        let mut want = BTreeMap::new();
        snapshot(&flb.outputs[0], "b", &mut want);
        assert_eq!(got, want, "新增：增量产物与全量不一致");
        // 删除 C：第一轮没有文件要编，旧 class 靠 stale_classes 清掉
        std::fs::remove_file(&c).unwrap();
        match build_state::decide(&lb, Some(&with_c), "cp", "cc", false) {
            build_state::Decision::Incremental { files, removed, .. } => {
                assert!(files.is_empty(), "只删除时第一轮没有文件要编");
                assert_eq!(removed.len(), 1);
                assert_eq!(removed[0].types, vec!["C".to_string()]);
            }
            other => panic!("删除应走增量，got {other:?}"),
        }
        let mut filtered = with_c.clone();
        filtered.sources.retain(|s| s.rel != "q/C.java");
        let after = build_state::updated_manifest(
            &lb,
            Some(&filtered),
            &[],
            "cp",
            "cc",
            vec![],
            false,
            &HashMap::new(),
            false,
        );
        let stale = build_state::stale_classes(&lb, &with_c, &after);
        assert_eq!(stale.len(), 1, "应清掉 C.class：{stale:?}");
        assert!(stale[0].ends_with("C.class"));
        for p in &stale {
            std::fs::remove_file(p).unwrap();
        }
        std::fs::remove_file(full.join("b/src/public/q/C.java")).unwrap();
        let flb2 = ModuleLayout::resolve(&full, "b");
        // 对照组从空产物目录全量：上一轮带 C 的旧 class 必须先清掉
        let _ = std::fs::remove_dir_all(&flb.outputs[0]);
        compile_into(&fenv, "b", flb2.collect_sources(), &flb.outputs[0], false);
        let mut got = BTreeMap::new();
        snapshot(&lb.outputs[0], "b", &mut got);
        let mut want = BTreeMap::new();
        snapshot(&flb.outputs[0], "b", &mut want);
        assert_eq!(got, want, "删除：增量产物与全量不一致");

        // 反例：两个源模块同轮一起改、互相内联对方常量。a 先编，用的是 b 的旧
        // class（旧常量被内联进 A）；旧实现把「做过结构传播的模块」整体 skip，
        // a 永远得不到重编 → 产物带着旧常量。新语义按种子归属过滤：intra 种子
        // 只排除归属模块的模块内引用方，跨模块边照常成立，a / b 都要补编。
        let ws = base.join("mutual").join("ws");
        let full = base.join("mutual-full").join("ws");
        let cfg = base.join("mutual-cfg");
        let a1 = "package p; import q.B; public class A { public static final int X = 1; public int f() { return B.Y; } }";
        let a2 = "package p; import q.B; public class A { public static final int X = 2; public int f() { return B.Y; } }";
        let b1 = "package q; import p.A; public class B { public static final int Y = 10; public int g() { return A.X; } }";
        let b2 = "package q; import p.A; public class B { public static final int Y = 20; public int g() { return A.X; } }";
        // 互相引用的两个模块没法单独冷启动：先把两份源码一起编进 a 的产物目录
        // 引导，再各自单编、清掉引导留在 a 里的 q/B.class。对照组同一套步骤。
        let bootstrap = |root: &Path, av: &str, bv: &str| {
            write_src(&root.join(a_rel), av);
            write_src(&root.join(b_rel), bv);
            let la = ModuleLayout::resolve(root, "a");
            let lb = ModuleLayout::resolve(root, "b");
            let env = make_env(root, &home, &java, &ecj, &bridge, &index, &work, &cancel);
            let a = root.join(a_rel);
            let b = root.join(b_rel);
            compile_into(&env, "a", vec![a.clone(), b.clone()], &la.outputs[0], false);
            compile_into(&env, "b", vec![b.clone()], &lb.outputs[0], false);
            std::fs::remove_file(la.outputs[0].join("q").join("B.class")).unwrap();
            compile_into(&env, "a", vec![a.clone()], &la.outputs[0], false);
            (la, lb, a, b)
        };
        let (la, lb, a, b) = bootstrap(&ws, a1, b1);
        let env = make_env(&ws, &home, &java, &ecj, &bridge, &index, &work, &cancel);
        let prev_a = build_state::updated_manifest(
            &la,
            None,
            std::slice::from_ref(&a),
            "cp",
            "cc",
            vec![],
            true,
            &fps_of(&la, std::slice::from_ref(&a)),
            false,
        );
        let prev_b = build_state::updated_manifest(
            &lb,
            None,
            std::slice::from_ref(&b),
            "cp",
            "cc",
            vec![],
            true,
            &fps_of(&lb, std::slice::from_ref(&b)),
            false,
        );
        // 同轮保存两份改动，模拟 build_one(a) → build_one(b)：a 先编，内联旧 B.Y
        write_src(&a, a2);
        write_src(&b, b2);
        compile_into(&env, "a", vec![a.clone()], &la.outputs[0], true);
        let ma = build_state::updated_manifest(
            &la,
            Some(&prev_a),
            std::slice::from_ref(&a),
            "cp",
            "cc",
            vec![],
            false,
            &fps_of(&la, std::slice::from_ref(&a)),
            false,
        );
        compile_into(&env, "b", vec![b.clone()], &lb.outputs[0], true);
        let mb = build_state::updated_manifest(
            &lb,
            Some(&prev_b),
            std::slice::from_ref(&b),
            "cp",
            "cc",
            vec![],
            false,
            &fps_of(&lb, std::slice::from_ref(&b)),
            false,
        );
        assert!(
            !structural_files(
                &la,
                std::slice::from_ref(&a),
                Some(&prev_a),
                &fps_of(&la, std::slice::from_ref(&a))
            )
            .is_empty(),
            "A 常量改动应是结构变化"
        );
        assert!(
            !structural_files(
                &lb,
                std::slice::from_ref(&b),
                Some(&prev_b),
                &fps_of(&lb, std::slice::from_ref(&b))
            )
            .is_empty(),
            "B 常量改动应是结构变化"
        );
        let mut pre_a = BTreeMap::new();
        snapshot(&la.outputs[0], "a", &mut pre_a);
        for (m, manifest) in [("a", &ma), ("b", &mb)] {
            let p = build_state::manifest_path(&cfg, &ws, m);
            write(&p, &serde_json::to_string(manifest).unwrap());
        }
        let modules = names(&["a", "b"]);
        let intra = vec![a.clone(), b.clone()];
        // 旧语义反例：整体 skip 两个源模块 → 互引边被吞掉，一条补编都没有
        let old_skip: HashSet<String> = ["a".to_string(), "b".to_string()].into_iter().collect();
        let mut unparsed_old = HashSet::new();
        let old_groups = cross_module_groups(
            &ws,
            &cfg,
            &modules,
            &[],
            &intra,
            &[],
            &old_skip,
            &mut unparsed_old,
        );
        assert!(
            old_groups.is_empty(),
            "旧语义确实漏边（反例前提）：{old_groups:?}"
        );
        // 新语义：两个模块都必须补编对方的引用方
        let mut unparsed = HashSet::new();
        let groups = cross_module_groups(
            &ws,
            &cfg,
            &modules,
            &[],
            &intra,
            &[],
            &HashSet::new(),
            &mut unparsed,
        );
        assert!(unparsed.is_empty());
        assert_eq!(groups.len(), 2, "互引的两个源模块都应补编：{groups:?}");
        for (m, files) in &groups {
            let layout = ModuleLayout::resolve(&ws, m);
            compile_into(&env, m, files.clone(), &layout.outputs[0], true);
        }
        // 补编后结构不再变化 → drain 收敛，不需要第二轮
        assert!(
            structural_files(
                &la,
                std::slice::from_ref(&a),
                Some(&ma),
                &fps_of(&la, std::slice::from_ref(&a))
            )
            .is_empty(),
            "补编后 A 结构应已稳定"
        );
        assert!(
            structural_files(
                &lb,
                std::slice::from_ref(&b),
                Some(&mb),
                &fps_of(&lb, std::slice::from_ref(&b))
            )
            .is_empty(),
            "补编后 B 结构应已稳定"
        );
        let (fla, flb, _, _) = bootstrap(&full, a2, b2);
        let mut got = BTreeMap::new();
        snapshot(&la.outputs[0], "a", &mut got);
        snapshot(&lb.outputs[0], "b", &mut got);
        let mut want = BTreeMap::new();
        snapshot(&fla.outputs[0], "a", &mut want);
        snapshot(&flb.outputs[0], "b", &mut want);
        // 只比 a 的产物：got 里还有 b 的条目，直接整表比会永真（假守卫）
        let got_a: BTreeMap<String, Vec<u8>> = got
            .iter()
            .filter(|(k, _)| k.starts_with("a/"))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        assert_ne!(
            pre_a, got_a,
            "反例前提：传播前 A 应带着旧常量（与补编后不同）"
        );
        assert_eq!(got, want, "双源互引：增量产物与全量不一致");

        // 反例：S→R→T 三跳链。a 里 S 的常量变了，R 源码没变但 `K = S.C` 被连带
        // 更新（R 的 ConstantValue 变 = 结构变化）；b 里 T 只引用 R.K。旧实现
        // build_one 只报「源码变的」S 当跨模块种子，T 与 S 没有文本边 → 漏编。
        // 修复后种子 = 源码变的 ∪ 结构变的（含 R），T 必须被补编。
        let ws = base.join("chain").join("ws");
        let full = base.join("chain-full").join("ws");
        let cfg = base.join("chain-cfg");
        let s_rel = "a/src/public/p/S.java";
        let r_rel = "a/src/public/p/R.java";
        let t_rel = "b/src/public/q/T.java";
        let s1 = "package p; public class S { public static final int C = 1; }";
        let s2 = "package p; public class S { public static final int C = 2; }";
        let r_src = "package p; public class R { public static final int K = S.C; }";
        let t_src = "package q; import p.R; public class T { public int g() { return R.K; } }";
        for root in [&ws, &full] {
            write_src(&root.join(s_rel), s1);
            write_src(&root.join(r_rel), r_src);
            write_src(&root.join(t_rel), t_src);
        }
        let la = ModuleLayout::resolve(&ws, "a");
        let lb = ModuleLayout::resolve(&ws, "b");
        let env = make_env(&ws, &home, &java, &ecj, &bridge, &index, &work, &cancel);
        let s = ws.join(s_rel);
        let a_sources = la.collect_sources();
        compile_into(&env, "a", a_sources.clone(), &la.outputs[0], false);
        compile_into(&env, "b", lb.collect_sources(), &lb.outputs[0], false);
        let prev_a = build_state::updated_manifest(
            &la,
            None,
            &a_sources,
            "cp",
            "cc",
            vec![],
            true,
            &fps_of(&la, &a_sources),
            false,
        );
        // 保存 S：快速编译 + 模块内传播（build_one 的等价步骤）
        write_src(&s, s2);
        compile_into(&env, "a", vec![s.clone()], &la.outputs[0], true);
        let structural_s = structural_files(
            &la,
            std::slice::from_ref(&s),
            Some(&prev_a),
            &fps_of(&la, std::slice::from_ref(&s)),
        );
        assert_eq!(structural_s.len(), 1, "S 常量改动应是结构变化");
        let refs = build_state::referrers(std::slice::from_ref(&s), &a_sources).unwrap();
        assert!(
            refs.iter().any(|p| p.ends_with("R.java")),
            "模块内应找到 R：{refs:?}"
        );
        compile_into(&env, "a", refs.clone(), &la.outputs[0], true);
        let structural_r = structural_files(&la, &refs, Some(&prev_a), &fps_of(&la, &refs));
        assert!(
            structural_r.iter().any(|p| p.ends_with("R.java")),
            "反例前提：R 源码没变但常量被连带更新，必须判为结构变化：{structural_r:?}"
        );
        for m in ["a", "b"] {
            let p = build_state::manifest_path(&cfg, &ws, m);
            write(&p, "stub");
        }
        let modules = names(&["a", "b"]);
        // 旧语义反例：只报源码变的 S → T 与 S 无文本边，一条补编都没有
        let mut unparsed_old = HashSet::new();
        let old_groups = cross_module_groups(
            &ws,
            &cfg,
            &modules,
            &[],
            std::slice::from_ref(&s),
            &[],
            &HashSet::new(),
            &mut unparsed_old,
        );
        assert!(
            old_groups.is_empty(),
            "旧语义确实漏掉 T（反例前提）：{old_groups:?}"
        );
        let mut pre_b = BTreeMap::new();
        snapshot(&lb.outputs[0], "b", &mut pre_b);
        // 新语义：种子 = 源码变的 ∪ 结构变的（含 R）→ 命中 b 的 T
        let mut seeds = vec![s.clone()];
        for p in structural_s.iter().chain(structural_r.iter()) {
            if !seeds.contains(p) {
                seeds.push(p.clone());
            }
        }
        let mut unparsed = HashSet::new();
        let groups = cross_module_groups(
            &ws,
            &cfg,
            &modules,
            &[],
            &seeds,
            &[],
            &HashSet::new(),
            &mut unparsed,
        );
        assert!(unparsed.is_empty());
        assert_eq!(groups.len(), 1, "应命中 b：{groups:?}");
        assert_eq!(groups[0].0, "b");
        for (m, files) in &groups {
            let layout = ModuleLayout::resolve(&ws, m);
            compile_into(&env, m, files.clone(), &layout.outputs[0], true);
        }
        // 对照组：同一份最终源码从空产物目录全量
        write_src(&full.join(s_rel), s2);
        let fenv = make_env(&full, &home, &java, &ecj, &bridge, &index, &work, &cancel);
        let fla = ModuleLayout::resolve(&full, "a");
        let flb = ModuleLayout::resolve(&full, "b");
        compile_into(&fenv, "a", fla.collect_sources(), &fla.outputs[0], false);
        compile_into(&fenv, "b", flb.collect_sources(), &flb.outputs[0], false);
        let mut got = BTreeMap::new();
        snapshot(&la.outputs[0], "a", &mut got);
        snapshot(&lb.outputs[0], "b", &mut got);
        let mut want = BTreeMap::new();
        snapshot(&fla.outputs[0], "a", &mut want);
        snapshot(&flb.outputs[0], "b", &mut want);
        let got_b: BTreeMap<String, Vec<u8>> = got
            .iter()
            .filter(|(k, _)| k.starts_with("b/"))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        assert_ne!(
            pre_b, got_b,
            "反例前提：传播前 T 应带着旧常量（与补编后不同）"
        );
        assert_eq!(got, want, "三跳链：增量产物与全量不一致");

        crate::ecj_worker::shutdown_all();
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 差分门禁扩到真实模块（P1-8，真机 `#[ignore]`）：按规模升序抽样至多 4 个候选，
    /// 拷进临时工作区（绝不改用户源码），全量编一遍做基线；再给一个文件追加
    /// 一行注释（内容哈希变、结构不变），走 decide → 单文件编译 → struct 判定：
    /// 必须只编 1 个文件、结构判定为「没变」、整模块产物与基线逐字节一致。
    /// 模块因缺依赖编不过时打印跳过——这是抽样探针，不是硬门禁。
    ///
    /// 运行：`node scripts/rust-gate.mjs test --lib -- --ignored 真实模块差分抽样_live --nocapture`
    #[test]
    #[ignore]
    fn 真实模块差分抽样_live() {
        use std::collections::BTreeMap;
        use std::sync::atomic::AtomicBool;

        let root = Path::new(r"C:\work\aier\newar");
        let home = [
            PathBuf::from("D:/ncc/1909home"),
            PathBuf::from("C:/ncc/1909home"),
        ]
        .into_iter()
        .find(|p| p.is_dir());
        let res = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources");
        let ecj = res.join("ecj").join("ecj-3.17.jar");
        let bridge = res.join("ecj-bridge").join(crate::ecj_worker::BRIDGE_JAR);
        let Some(home) = home else {
            println!("跳过：本机没有 NC home");
            return;
        };
        let java = home.join("ufjdk").join("bin").join("java.exe");
        if !root.is_dir() || !java.is_file() || !ecj.is_file() || !bridge.is_file() {
            println!("跳过：本机没有工作区 / java / ecj / 桥 jar");
            return;
        }
        // 抽样候选：按源文件数升序取前 4 个（≤400 文件控制成本）。
        // 最小的模块常因缺兄弟模块依赖编不过，逐个试到第一个能单独编过的。
        let modules = crate::eclipse_cp::module_dirs_of(root);
        let mut cands: Vec<(String, usize)> = modules
            .iter()
            .map(|m| {
                (
                    m.clone(),
                    ModuleLayout::resolve(root, m).collect_sources().len(),
                )
            })
            .filter(|(_, n)| *n > 0 && *n <= 400)
            .collect();
        cands.sort_by_key(|(_, n)| *n);
        cands.truncate(4);
        if cands.is_empty() {
            println!("跳过：工作区没有合适规模（1~400 源文件）的模块");
            return;
        }

        fn copy_tree(src: &Path, dst: &Path) {
            let Ok(rd) = std::fs::read_dir(src) else {
                return;
            };
            std::fs::create_dir_all(dst).unwrap();
            for e in rd.flatten() {
                let p = e.path();
                let to = dst.join(e.file_name());
                if p.is_dir() {
                    copy_tree(&p, &to);
                } else {
                    std::fs::copy(&p, &to).unwrap();
                }
            }
        }
        fn snapshot(dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
            fn walk(cur: &Path, base: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
                let Ok(rd) = std::fs::read_dir(cur) else {
                    return;
                };
                for e in rd.flatten() {
                    let p = e.path();
                    if p.is_dir() {
                        walk(&p, base, out);
                    } else if p.extension().is_some_and(|x| x == "class") {
                        let rel = p
                            .strip_prefix(base)
                            .unwrap()
                            .to_string_lossy()
                            .replace('\\', "/");
                        out.insert(rel, std::fs::read(&p).unwrap());
                    }
                }
            }
            walk(dir, dir, out);
        }

        let base = crate::test_support::tmp("real-diff");
        let work = base.join("work");
        std::fs::create_dir_all(&work).unwrap();
        let started = std::time::Instant::now();
        let index = crate::nc_index::ClassIndex::load_or_build(
            crate::nc_index::classpath_jars(&home),
            None,
            None,
        );
        println!("类索引：{} ms", started.elapsed().as_millis());
        let cancel = AtomicBool::new(false);

        for (module, _) in &cands {
            let ws = base.join(format!("ws-{module}"));
            copy_tree(&root.join(module).join("src"), &ws.join(module).join("src"));
            for f in [".classpath", ".project"] {
                let p = root.join(module).join(f);
                if p.is_file() {
                    std::fs::copy(&p, ws.join(module).join(f)).unwrap();
                }
            }
            let layout = ModuleLayout::resolve(&ws, module);
            let sources = layout.collect_sources();
            let out = layout.outputs[0].clone();
            println!("抽样模块 {module}：{} 个源文件", sources.len());
            let env = compile::CompileEnv {
                nc_home: &home,
                java_exe: &java,
                ecj_jar: &ecj,
                worker_jar: Some(&bridge),
                project_root: &ws,
                index: &index,
                work_dir: &work,
                cancel: Some(&cancel),
                overrides: &[],
            };
            let job = compile::CompileJob {
                module: module.clone(),
                files: Some(sources.clone()),
                out_dir: out.clone(),
                source_roots: None,
                output_map: Vec::new(),
                seed_jars: Vec::new(),
                fast: false,
            };
            let r = compile::compile(&env, &job, &|_| {}).unwrap();
            if r.error_count > 0 {
                println!(
                    "跳过：{module} 单独编不过（{} 个错误，多为缺兄弟模块依赖），试下一个候选",
                    r.error_count
                );
                let _ = std::fs::remove_dir_all(&ws);
                continue;
            }
            let mut baseline = BTreeMap::new();
            snapshot(&out, &mut baseline);
            assert!(!baseline.is_empty(), "全量没产出 class");

            // 基线清单（含结构指纹），然后给第一个文件追加一行注释
            let fps = live_fps(&java, &ecj, &bridge, &work, &cancel, &layout, &sources);
            let prev = build_state::updated_manifest(
                &layout,
                None,
                &sources,
                "cp",
                "cc",
                vec![],
                true,
                &fps,
                false,
            );
            let target = sources[0].clone();
            let mut text = std::fs::read(&target).unwrap();
            text.extend_from_slice(b"\n// diff-gate\n");
            std::fs::write(&target, text).unwrap();

            match build_state::decide(&layout, Some(&prev), "cp", "cc", false) {
                build_state::Decision::Incremental { files, .. } => {
                    assert_eq!(files.len(), 1, "注释改动应只编 1 个文件");
                    assert_eq!(files[0], target);
                }
                other => panic!("注释改动应走增量，got {other:?}"),
            }
            let one = compile::CompileJob {
                module: module.clone(),
                files: Some(vec![target.clone()]),
                out_dir: out.clone(),
                source_roots: None,
                output_map: Vec::new(),
                seed_jars: Vec::new(),
                fast: true,
            };
            let r2 = compile::compile(&env, &one, &|_| {}).unwrap();
            assert_eq!(r2.error_count, 0, "单文件编译出错：{:?}", r2.problems);
            let post = live_fps(
                &java,
                &ecj,
                &bridge,
                &work,
                &cancel,
                &layout,
                std::slice::from_ref(&target),
            );
            let structural = structural_files(&layout, &[target], Some(&prev), &post);
            assert!(structural.is_empty(), "注释不该改结构：{structural:?}");
            let mut got = BTreeMap::new();
            snapshot(&out, &mut got);
            assert_eq!(got, baseline, "真实模块：注释增量产物与全量基线不一致");
            println!(
                "PERF real-module-diff module={module} sources={} classes={} ok",
                sources.len(),
                baseline.len()
            );
            crate::ecj_worker::shutdown_all();
            let _ = std::fs::remove_dir_all(&base);
            return;
        }
        println!(
            "跳过：{} 个候选都单独编不过（缺兄弟模块依赖），真实模块抽样未执行",
            cands.len()
        );
        crate::ecj_worker::shutdown_all();
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 真实模块 make 速度基线（P1 退出标准「三组数进基线」的前两组，真机 `#[ignore]`）。
    ///
    /// 量两条数，都在真实工作区 `C:\work\aier\newar` 上：
    /// ① **无变更扫描成本**（`PERF module-nochange`）：直接在真实工作区**只读**跑
    ///    `decide`（扫描 + stat + 哈希命中 + 指纹比对 → Skip），不编译、不拷贝、不改用户源码。
    ///    按规模取小 / 中 / 大三个模块，看「编译全部」无变更时每模块成本随规模怎么涨。
    ///    指纹 None 不影响无变更判定（decide 只看 stat/hash/pending），故无需先编译。
    /// ② **保存热路径 p50**（`PERF module-make`）：抽样可单独编过的模块（≤400 文件），
    ///    拷进临时区（绝不改用户源码），每轮改 1 个文件 → decide 找出它 → 单文件编译
    ///    （常驻 worker）→ struct 结构判定，量整段 p50。这是 make 相对单文件编译多出的
    ///    「decide 扫描 + 结构判定」真实成本。
    ///
    /// 速度基线不是门禁：只 emit PERF 行，不 assert 阈值（机器差异大，拿目标卡 CI 只会调阈值）。
    /// 第三组「单模块签名变更下游传播文件数」需跨模块清单，另探针测。
    ///
    /// 运行：`node scripts/perf-baseline.mjs --only=module-make`
    /// 或 `node scripts/rust-gate.mjs test --lib -- --ignored 模块make速度_live --nocapture`
    #[test]
    #[ignore]
    fn 模块make速度_live() {
        use std::sync::atomic::AtomicBool;
        const RUNS: usize = 10;
        const NOCHANGE_RUNS: usize = 5;
        const MAX_MEASURED: usize = 3;

        let root = Path::new(r"C:\work\aier\newar");
        let home = [
            PathBuf::from("D:/ncc/1909home"),
            PathBuf::from("C:/ncc/1909home"),
        ]
        .into_iter()
        .find(|p| p.is_dir());
        let res = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources");
        let ecj = res.join("ecj").join("ecj-3.17.jar");
        let bridge = res.join("ecj-bridge").join(crate::ecj_worker::BRIDGE_JAR);
        let Some(home) = home else {
            println!("跳过：本机没有 NC home");
            return;
        };
        let java = home.join("ufjdk").join("bin").join("java.exe");
        if !root.is_dir() || !java.is_file() || !ecj.is_file() || !bridge.is_file() {
            println!("跳过：本机没有工作区 / java / ecj / 桥 jar");
            return;
        }
        let modules = crate::eclipse_cp::module_dirs_of(root);
        let mut sized: Vec<(String, usize)> = modules
            .iter()
            .map(|m| {
                (
                    m.clone(),
                    ModuleLayout::resolve(root, m).collect_sources().len(),
                )
            })
            .filter(|(_, n)| *n > 0)
            .collect();
        sized.sort_by_key(|(_, n)| *n);
        if sized.is_empty() {
            println!("跳过：工作区没有源模块");
            return;
        }

        let base = crate::test_support::tmp("make-p50");
        let work = base.join("work");
        std::fs::create_dir_all(&work).unwrap();
        let t0 = std::time::Instant::now();
        let index = crate::nc_index::ClassIndex::load_or_build(
            crate::nc_index::classpath_jars(&home),
            None,
            None,
        );
        println!("类索引：{} ms", t0.elapsed().as_millis());
        let cancel = AtomicBool::new(false);

        // ① 无变更扫描成本：小 / 中 / 大（≤2000 文件控 setup 哈希成本）三个代表，只读真实工作区。
        let pick = |idx: usize| -> Option<&(String, usize)> { sized.get(idx) };
        let last = sized.len().saturating_sub(1);
        let big = sized.iter().rposition(|(_, n)| *n <= 2000).unwrap_or(last);
        let mut picks: Vec<usize> = vec![0, sized.len() / 2, big];
        picks.sort_unstable();
        picks.dedup();
        let mut nc_summary: Option<(String, usize, u64)> = None;
        for idx in picks {
            let Some((module, n)) = pick(idx) else {
                continue;
            };
            let layout = ModuleLayout::resolve(root, module);
            let sources = layout.collect_sources();
            // 只读建清单（stat + 哈希），不编译；指纹留空不影响无变更 Skip 判定。
            let man = build_state::updated_manifest(
                &layout,
                None,
                &sources,
                "cp",
                "cc",
                vec![],
                true,
                &HashMap::new(),
                false,
            );
            let mut samples: Vec<u64> = Vec::new();
            for _ in 0..NOCHANGE_RUNS {
                let t = std::time::Instant::now();
                let d = build_state::decide(&layout, Some(&man), "cp", "cc", false);
                let ms = t.elapsed().as_millis() as u64;
                assert!(
                    matches!(d, build_state::Decision::Skip),
                    "{module} 无变更应 Skip：{d:?}"
                );
                samples.push(ms);
            }
            samples.sort_unstable();
            let ms = samples[samples.len() / 2];
            println!("PERF module-nochange module={module} sources={n} ms={ms}");
            // P1 注册表路径：建基线后可靠空脏集 → decide 直接 Skip，不扫全模块。
            // 与上面的全扫 ms 对比即增量 stat 的收益（大模块尤甚）。
            crate::compile_dirty::invalidate(root);
            crate::compile_dirty::baseline(root, module, &layout.source_roots);
            let mut incr_samples: Vec<u64> = Vec::new();
            for _ in 0..NOCHANGE_RUNS {
                let h = crate::compile_dirty::hint(root, module, &layout.source_roots);
                assert!(
                    h.reliable && h.paths.is_empty(),
                    "{module} 基线后应可靠空脏集"
                );
                let t = std::time::Instant::now();
                let d =
                    build_state::decide_with_hint(&layout, Some(&man), "cp", "cc", false, Some(&h));
                let incr = t.elapsed().as_millis() as u64;
                assert!(
                    matches!(d, build_state::Decision::Skip),
                    "{module} 可靠空集应 Skip：{d:?}"
                );
                incr_samples.push(incr);
            }
            incr_samples.sort_unstable();
            let incr = incr_samples[incr_samples.len() / 2];
            println!("PERF module-nochange-incr module={module} sources={n} ms={incr}");
            if nc_summary.as_ref().map(|(_, s, _)| *n > *s).unwrap_or(true) {
                nc_summary = Some((module.clone(), *n, ms));
            }
        }

        // ② 保存热路径 p50：可单独编过的模块（≤400 文件），拷临时区。
        fn copy_tree(src: &Path, dst: &Path) {
            let Ok(rd) = std::fs::read_dir(src) else {
                return;
            };
            std::fs::create_dir_all(dst).unwrap();
            for e in rd.flatten() {
                let p = e.path();
                let to = dst.join(e.file_name());
                if p.is_dir() {
                    copy_tree(&p, &to);
                } else {
                    std::fs::copy(&p, &to).unwrap();
                }
            }
        }
        let mut cands: Vec<(String, usize)> =
            sized.iter().filter(|(_, n)| *n <= 400).cloned().collect();
        cands.truncate(8);
        let mut measured = 0usize;
        let mut make_summary: Option<(String, usize, u64, u64)> = None;
        for (module, _) in &cands {
            if measured >= MAX_MEASURED {
                break;
            }
            let ws = base.join(format!("ws-{module}"));
            copy_tree(&root.join(module).join("src"), &ws.join(module).join("src"));
            for f in [".classpath", ".project"] {
                let p = root.join(module).join(f);
                if p.is_file() {
                    std::fs::copy(&p, ws.join(module).join(f)).unwrap();
                }
            }
            let layout = ModuleLayout::resolve(&ws, module);
            let sources = layout.collect_sources();
            let out = layout.outputs[0].clone();
            let env = compile::CompileEnv {
                nc_home: &home,
                java_exe: &java,
                ecj_jar: &ecj,
                worker_jar: Some(&bridge),
                project_root: &ws,
                index: &index,
                work_dir: &work,
                cancel: Some(&cancel),
                overrides: &[],
            };
            let job = compile::CompileJob {
                module: module.clone(),
                files: Some(sources.clone()),
                out_dir: out.clone(),
                source_roots: None,
                output_map: Vec::new(),
                seed_jars: Vec::new(),
                fast: false,
            };
            let r = compile::compile(&env, &job, &|_| {}).unwrap();
            if r.error_count > 0 {
                println!(
                    "跳过：{module} 单独编不过（{} 个错误），试下一个候选",
                    r.error_count
                );
                let _ = std::fs::remove_dir_all(&ws);
                continue;
            }
            let fps = live_fps(&java, &ecj, &bridge, &work, &cancel, &layout, &sources);
            let prev = build_state::updated_manifest(
                &layout,
                None,
                &sources,
                "cp",
                "cc",
                vec![],
                true,
                &fps,
                false,
            );
            // 无变更 decide（本模块，暖）
            let mut nc: Vec<u64> = Vec::new();
            for _ in 0..NOCHANGE_RUNS {
                let t = std::time::Instant::now();
                let d = build_state::decide(&layout, Some(&prev), "cp", "cc", false);
                assert!(
                    matches!(d, build_state::Decision::Skip),
                    "{module} 无变更应 Skip：{d:?}"
                );
                nc.push(t.elapsed().as_millis() as u64);
            }
            nc.sort_unstable();
            let nochange = nc[nc.len() / 2];
            // 保存热路径：每轮追加不同注释（内容哈希变 → decide 判改动；ecj 整文件重编，成本同方法体改动）
            let target = sources[0].clone();
            let one = compile::CompileJob {
                module: module.clone(),
                files: Some(vec![target.clone()]),
                out_dir: out.clone(),
                source_roots: None,
                output_map: Vec::new(),
                seed_jars: Vec::new(),
                fast: true,
            };
            let mut samples: Vec<u64> = Vec::new();
            let mut failed = false;
            for i in 0..RUNS {
                let mut text = std::fs::read(&target).unwrap();
                text.extend_from_slice(format!("\n// make-p50-{i}\n").as_bytes());
                std::fs::write(&target, &text).unwrap();
                let t = std::time::Instant::now();
                match build_state::decide(&layout, Some(&prev), "cp", "cc", false) {
                    build_state::Decision::Incremental { files, .. } => {
                        assert_eq!(
                            files.len(),
                            1,
                            "{module} 注释改动应只编 1 个文件：{files:?}"
                        );
                    }
                    other => {
                        println!("PERF module-make failed: decide 非增量 {other:?}");
                        failed = true;
                        break;
                    }
                }
                let rr = compile::compile(&env, &one, &|_| {}).unwrap();
                if rr.error_count > 0 {
                    println!("PERF module-make failed: 单文件编译 {} 错", rr.error_count);
                    failed = true;
                    break;
                }
                let post = live_fps(
                    &java,
                    &ecj,
                    &bridge,
                    &work,
                    &cancel,
                    &layout,
                    std::slice::from_ref(&target),
                );
                let _ =
                    structural_files(&layout, std::slice::from_ref(&target), Some(&prev), &post);
                samples.push(t.elapsed().as_millis() as u64);
            }
            if failed || samples.is_empty() {
                let _ = std::fs::remove_dir_all(&ws);
                continue;
            }
            samples.sort_unstable();
            let n = samples.len();
            let p50 = samples[n / 2];
            println!(
                "PERF module-make module={module} sources={} nochange={nochange} p50={p50} min={} max={} runs={n}",
                sources.len(),
                samples[0],
                samples[n - 1]
            );
            if make_summary
                .as_ref()
                .map(|(_, s, _, _)| sources.len() > *s)
                .unwrap_or(true)
            {
                make_summary = Some((module.clone(), sources.len(), nochange, p50));
            }
            measured += 1;
            let _ = std::fs::remove_dir_all(&ws);
        }

        match make_summary {
            Some((m, s, nc, p50)) => {
                println!("PERF module-make-summary module={m} sources={s} nochange={nc} p50={p50}")
            }
            None => println!(
                "跳过：{} 个候选都单独编不过（缺兄弟模块依赖），make 热路径未测",
                cands.len()
            ),
        }
        match nc_summary {
            Some((m, s, ms)) => {
                println!("PERF module-nochange-summary module={m} sources={s} ms={ms}")
            }
            None => println!("跳过：无变更扫描未测"),
        }
        crate::ecj_worker::shutdown_all();
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 传播扇出只读探针（精度账，真机 `#[ignore]`）：真实工作区抽样类型，用文本边
    /// `referrers_of_names` 跨全部源算「这个类型结构变了会牵动多少文件」——扇出总数、
    /// 涉及几个模块、几个模块触 30% 整模块阈值。**只读**，不编译、不改用户源码。
    ///
    /// 口径声明：这是**文本边扇出**（过度近似的上界），不是「比真实字节码引用多编多少」
    /// 的差值（那需要字节码反向索引，正是待评估的东西）。但扇出规模 + 30% 触发率足以
    /// 判断精确反向图能省多少：若 routinely 触顶整模块，精度无用武之地；若扇出本就小，
    /// 精度省的绝对量也小。一次性决策探针，不接 perf-baseline 回归表。
    ///
    /// 运行：`node scripts/rust-gate.mjs test --lib -- --ignored 传播扇出探针_live --nocapture`
    #[test]
    #[ignore]
    fn 传播扇出探针_live() {
        let root = Path::new(r"C:\work\aier\newar");
        if !root.is_dir() {
            println!("跳过：本机没有工作区");
            return;
        }
        let modules = crate::eclipse_cp::module_dirs_of(root);
        let mut sized: Vec<(String, usize)> = modules
            .iter()
            .map(|m| {
                (
                    m.clone(),
                    ModuleLayout::resolve(root, m).collect_sources().len(),
                )
            })
            .filter(|(_, n)| *n > 0)
            .collect();
        sized.sort_by_key(|(_, n)| *n);
        if sized.is_empty() {
            println!("跳过：工作区没有源模块");
            return;
        }
        // 全部源 + 每模块源数（30% 阈值要用）
        let mut all: Vec<PathBuf> = Vec::new();
        let mut count_by_mod: HashMap<String, usize> = HashMap::new();
        for (m, _) in &sized {
            let srcs = ModuleLayout::resolve(root, m).collect_sources();
            count_by_mod.insert(m.to_ascii_lowercase(), srcs.len());
            all.extend(srcs);
        }
        // 抽样：按规模取 5 个模块，各取前 2 个源文件的首个类型（带种子路径以便排除自身）
        let last = sized.len() - 1;
        let idxs = [
            0,
            sized.len() / 4,
            sized.len() / 2,
            (3 * sized.len()) / 4,
            last,
        ];
        let mut samples: Vec<(String, String, String, PathBuf)> = Vec::new();
        for idx in idxs {
            let (m, _) = &sized[idx];
            let layout = ModuleLayout::resolve(root, m);
            for p in layout.collect_sources().iter().take(2) {
                if let Some(st) = build_state::source_stamp(&layout, p, true) {
                    if let Some(t) = st.types.first() {
                        samples.push((m.clone(), st.package.clone(), t.clone(), p.clone()));
                    }
                }
            }
        }
        samples.sort();
        samples.dedup();
        let mut fanouts: Vec<usize> = Vec::new();
        let mut whole_trips = 0usize;
        let mut max_fanout = 0usize;
        for (from, pkg, ty, seed_path) in &samples {
            let fq = if pkg.is_empty() {
                ty.to_ascii_lowercase()
            } else {
                format!("{pkg}.{ty}").to_ascii_lowercase()
            };
            let changed_fq: HashSet<String> = [fq.clone()].into_iter().collect();
            let changed_pkgs: HashSet<String> = [pkg.to_ascii_lowercase()].into_iter().collect();
            let simple: HashSet<String> = [ty.clone()].into_iter().collect();
            let exclude: HashSet<String> = [build_layout::slash(seed_path).to_ascii_lowercase()]
                .into_iter()
                .collect();
            let refs = build_state::referrers_of_names(
                &changed_fq,
                &changed_pkgs,
                &simple,
                &exclude,
                &all,
            );
            let mut per_mod: HashMap<String, usize> = HashMap::new();
            for p in &refs {
                if let Some(m) = compile::module_of(root, p) {
                    *per_mod.entry(m.to_ascii_lowercase()).or_insert(0) += 1;
                }
            }
            let mut trips = 0usize;
            for (m, cnt) in &per_mod {
                let total = count_by_mod.get(m).copied().unwrap_or(0);
                if total > 0 && cnt * 100 > total.saturating_mul(30) {
                    trips += 1;
                }
            }
            fanouts.push(refs.len());
            whole_trips += trips;
            max_fanout = max_fanout.max(refs.len());
            println!(
                "PERF fanout type={fq} from={from} referrers={} modules={} wholemodule={trips}",
                refs.len(),
                per_mod.len()
            );
        }
        fanouts.sort_unstable();
        let n = fanouts.len();
        if n == 0 {
            println!("跳过：没抽到可解析类型");
            return;
        }
        println!(
            "PERF fanout-summary samples={n} median={} max={max_fanout} wholemodule-trips={whole_trips}",
            fanouts[n / 2]
        );
    }

    /// 成员级浪费只读探针（精度账，真机 `#[ignore]`）：量化「类型级传播比成员级多编多少」。
    /// 对抽样类型 A 提取方法成员，模拟**单个成员结构变更**：类型级会重编 A 的全部文本边
    /// 引用方 |R|；成员级理想只重编「正文真用到那个成员」的引用方。差值 = 浪费。
    ///
    /// 口径声明（近似，别当字节码精确值）：成员用「源码按词命中」代理字节码引用——
    /// 会**高估使用**（同名局部变量/无关词也算命中）→ **低估浪费**，对「浪费很小」的结论
    /// 是保守方向；继承/静态导入可能不点名而用到 → 反向偏差，量级小。只测方法成员（结构
    /// 变更主因是签名改）。**只读**，不编译、不改源码。一次性决策探针，不接回归表。
    ///
    /// 运行：`node scripts/rust-gate.mjs test --lib -- --ignored 成员级浪费探针_live --nocapture`
    #[test]
    #[ignore]
    fn 成员级浪费探针_live() {
        let root = Path::new(r"C:\work\aier\newar");
        if !root.is_dir() {
            println!("跳过：本机没有工作区");
            return;
        }
        let modules = crate::eclipse_cp::module_dirs_of(root);
        let mut sized: Vec<(String, usize)> = modules
            .iter()
            .map(|m| {
                (
                    m.clone(),
                    ModuleLayout::resolve(root, m).collect_sources().len(),
                )
            })
            .filter(|(_, n)| *n > 0)
            .collect();
        sized.sort_by_key(|(_, n)| *n);
        if sized.is_empty() {
            println!("跳过：工作区没有源模块");
            return;
        }
        let mut all: Vec<PathBuf> = Vec::new();
        for (m, _) in &sized {
            all.extend(ModuleLayout::resolve(root, m).collect_sources());
        }
        // 方法名提取：`(` 前的词，跳过控制流关键字与大写开头（构造器/类型名）。
        let method_names = |clean: &str| -> Vec<String> {
            const KW: &[&str] = &[
                "if",
                "for",
                "while",
                "switch",
                "catch",
                "synchronized",
                "return",
                "new",
                "this",
                "super",
                "do",
                "else",
                "try",
                "assert",
                "throw",
                "case",
                "instanceof",
            ];
            let bytes = clean.as_bytes();
            let is_word = |b: u8| b.is_ascii_alphanumeric() || b == b'_' || b == b'$';
            let mut out: Vec<String> = Vec::new();
            for (i, &byte) in bytes.iter().enumerate() {
                if byte != b'(' {
                    continue;
                }
                let mut j = i;
                while j > 0 && is_word(bytes[j - 1]) {
                    j -= 1;
                }
                if j == i {
                    continue;
                }
                let name = &clean[j..i];
                let lower_first = name
                    .chars()
                    .next()
                    .map(|c| c.is_ascii_lowercase())
                    .unwrap_or(false);
                if lower_first && !KW.contains(&name) {
                    out.push(name.to_string());
                }
            }
            out.sort();
            out.dedup();
            out
        };
        let last = sized.len() - 1;
        let idxs = [
            0,
            sized.len() / 4,
            sized.len() / 2,
            (3 * sized.len()) / 4,
            last,
        ];
        let mut samples: Vec<(String, String, String, PathBuf)> = Vec::new();
        for idx in idxs {
            let (m, _) = &sized[idx];
            let layout = ModuleLayout::resolve(root, m);
            for p in layout.collect_sources().iter().take(2) {
                if let Some(st) = build_state::source_stamp(&layout, p, true) {
                    if let Some(t) = st.types.first() {
                        samples.push((m.clone(), st.package.clone(), t.clone(), p.clone()));
                    }
                }
            }
        }
        samples.sort();
        samples.dedup();
        let mut avg_wastes: Vec<f64> = Vec::new();
        let mut sum_type_level = 0usize;
        let mut sum_waste = 0usize;
        let mut max_waste = 0usize;
        for (from, pkg, ty, seed_path) in &samples {
            let Ok(seed_bytes) = std::fs::read(seed_path) else {
                continue;
            };
            let seed_clean = build_state::strip_comments_and_literals(
                &crate::workspace::decode_lossy(&seed_bytes),
            );
            let members = method_names(&seed_clean);
            if members.is_empty() {
                continue;
            }
            let fq = if pkg.is_empty() {
                ty.to_ascii_lowercase()
            } else {
                format!("{pkg}.{ty}").to_ascii_lowercase()
            };
            let changed_fq: HashSet<String> = [fq.clone()].into_iter().collect();
            let changed_pkgs: HashSet<String> = [pkg.to_ascii_lowercase()].into_iter().collect();
            let simple: HashSet<String> = [ty.clone()].into_iter().collect();
            let exclude: HashSet<String> = [build_layout::slash(seed_path).to_ascii_lowercase()]
                .into_iter()
                .collect();
            let refs = build_state::referrers_of_names(
                &changed_fq,
                &changed_pkgs,
                &simple,
                &exclude,
                &all,
            );
            if refs.is_empty() {
                continue;
            }
            // 每个引用方的干净正文（读一次，复用给所有成员匹配）
            let ref_clean: Vec<String> = refs
                .iter()
                .filter_map(|p| std::fs::read(p).ok())
                .map(|b| {
                    build_state::strip_comments_and_literals(&crate::workspace::decode_lossy(&b))
                })
                .collect();
            let r = ref_clean.len();
            let mut type_level = 0usize;
            let mut member_level = 0usize;
            let mut worst = 0usize;
            for m in &members {
                let cnt = ref_clean
                    .iter()
                    .filter(|t| build_state::mentions_word(t, m))
                    .count();
                type_level += r;
                member_level += cnt;
                worst = worst.max(r - cnt);
            }
            let waste = type_level - member_level;
            let avg = waste as f64 / members.len() as f64;
            avg_wastes.push(avg);
            sum_type_level += type_level;
            sum_waste += waste;
            max_waste = max_waste.max(worst);
            println!(
                "PERF member-waste type={fq} from={from} referrers={r} members={} avg-waste={avg:.2} max-waste={worst} add-member-waste={r}",
                members.len()
            );
        }
        avg_wastes.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let n = avg_wastes.len();
        if n == 0 {
            println!("跳过：没抽到「有成员且有引用方」的类型");
            return;
        }
        let pct = if sum_type_level > 0 {
            sum_waste as f64 * 100.0 / sum_type_level as f64
        } else {
            0.0
        };
        println!(
            "PERF member-waste-summary samples={n} median-avg-waste={:.2} max-waste={max_waste} overall-waste-pct={pct:.1} (type-level={sum_type_level} waste={sum_waste})",
            avg_wastes[n / 2]
        );
    }

    /// make 闭包规模只读探针（真机 `#[ignore]`）：量「编译本模块」实际要编多少模块/文件。
    /// make_closure = 目标 + 传递依赖（workspace_deps = classpath 边 ∪ 模块图 join_ext）。
    /// 模块级 join_ext 的通配 import **不按简单名过滤**（连整包所有模块），可能让闭包爆炸→
    /// 单模块编译实编大半个 workspace。本探针只读（源扫描 + 类型索引），不编译、不写输出。
    ///
    /// 运行：`node scripts/rust-gate.mjs test --lib -- --ignored make闭包规模探针_live --nocapture`
    #[test]
    #[ignore]
    fn make闭包规模探针_live() {
        let root = Path::new(r"C:\work\aier\newar");
        if !root.is_dir() {
            println!("跳过：本机没有工作区");
            return;
        }
        let appdata = std::env::var("APPDATA").unwrap_or_default();
        let config_dir = PathBuf::from(appdata).join("io.github.lzlkyb.ncforge");
        let modules = crate::eclipse_cp::module_dirs_of(root);
        if modules.is_empty() {
            println!("跳过：没有源模块");
            return;
        }
        let Some(types) = crate::workspace_types::shared_opt(root, &config_dir) else {
            println!("跳过：类型索引未建");
            return;
        };
        let maps = crate::module_graph::type_maps(&types);
        let known: HashSet<String> = modules.iter().map(|m| m.to_ascii_lowercase()).collect();
        let mut deps = module_deps(root, &modules);
        let mut src_count: HashMap<String, usize> = HashMap::new();
        for m in &modules {
            let layout = ModuleLayout::resolve(root, m);
            src_count.insert(m.to_ascii_lowercase(), layout.collect_sources().len());
            let ext = build_state::module_ext_refs(&layout);
            let entry = deps.entry(m.clone()).or_default();
            for d in crate::module_graph::join_ext(&ext, &maps) {
                if d.eq_ignore_ascii_case(m) || !known.contains(&d.to_ascii_lowercase()) {
                    continue;
                }
                if !entry.iter().any(|x| x.eq_ignore_ascii_case(&d)) {
                    entry.push(d);
                }
            }
        }
        let total_mods = modules.len();
        let mut closure_sizes: Vec<usize> = Vec::new();
        let mut big = 0usize;
        for m in &modules {
            let mut seen: HashSet<String> = HashSet::new();
            let mut queue = vec![m.to_ascii_lowercase()];
            seen.insert(m.to_ascii_lowercase());
            let mut closure_mods = 0usize;
            let mut closure_srcs = 0usize;
            while let Some(cur) = queue.pop() {
                closure_mods += 1;
                closure_srcs += src_count.get(&cur).copied().unwrap_or(0);
                if let Some(ds) = deps.get(&cur) {
                    for d in ds {
                        if seen.insert(d.to_ascii_lowercase()) {
                            queue.push(d.to_ascii_lowercase());
                        }
                    }
                }
            }
            closure_sizes.push(closure_mods);
            if closure_mods * 2 > total_mods {
                big += 1;
            }
            println!(
                "PERF closure module={m} direct={} closure-modules={closure_mods}/{total_mods} closure-sources={closure_srcs}",
                deps.get(m).map(|d| d.len()).unwrap_or(0)
            );
        }
        closure_sizes.sort_unstable();
        let n = closure_sizes.len();
        println!(
            "PERF closure-summary modules={n} median-closure={} max-closure={} over-half-workspace={big}",
            closure_sizes[n / 2],
            closure_sizes[n - 1]
        );
    }
}
