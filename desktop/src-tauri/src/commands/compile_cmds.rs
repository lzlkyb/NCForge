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
        "找不到 Java 编译器组件（ecj）。请点击下载按钮，或到设置 → 维护 → 组件与更新下载，然后重新编译"
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

/// 「已经有人在后台建索引」的在飞标记。
///
/// 索引冷的时候每次保存都会走到 `compile_file` 的跳过分支；没有这个标记的话，
/// 连按十次保存就是十个 `spawn_blocking` 排在 `INDEX_GATE` 上干等同一件事。
static WARMING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

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
fn deploy_after_compile(
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

/// 编译 `path` 所在的模块。`path` 可以是模块目录，也可以是模块内任一文件；
/// 进度以 `compile-log` 事件逐行推给前端，返回值是完整结果（含问题列表）。
#[tauri::command]
pub async fn compile_module(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
) -> Result<CompileResult, String> {
    let (root, module, _target) = resolve_module(&state, &path).await?;
    // NC home 由配置决定（见 nc_home::resolve），编译与启动服务共用同一份解析结果
    let home = nc_home::resolve(state.config.read().await.nc_home.as_deref())?;
    let nc_home = PathBuf::from(&home.root);
    let java = PathBuf::from(&home.java);
    let ecj = find_ecj(&state.config_dir)?;
    let cache_path = state.config_dir.join("class-index.bin");
    let work_dir = state.config_dir.join("tmp");
    let config_dir = state.config_dir.clone();
    let st = state.inner().clone();
    // 覆盖表在这里取（async 上下文里读配置），进 spawn_blocking 后只管用
    let (overrides, deploy_on_start) = {
        let cfg = state.config.read().await;
        (
            crate::eclipse_cp::active_overrides(&cfg.linked_overrides),
            cfg.deploy_on_start,
        )
    };

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
        if result.error_count == 0 {
            deploy_after_compile(
                deploy_on_start,
                &config_dir,
                &root,
                &nc_home,
                &overrides,
                &log,
            );
        }
        Ok(result)
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

/// 把同一轮里几个模块的单文件编译结果并成一份。
///
/// 不合并的话前端要处理「一次保存返回多份 CompileResult」，问题面板、错误计数、
/// 状态栏全都得知道这个形状；合并成一份后，它和 `compile_module` 的返回值同构，
/// 前端只有一条路径。
fn merge_results(results: Vec<CompileResult>, files: usize) -> CompileResult {
    let modules = results.len();
    // 单模块时给真实产物目录（面板上「输出」那一栏要看得出 class 落在哪）；
    // 跨模块只能给一句汇总——列第一个模块的目录会让人以为只编了那个模块
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
    };
    for r in results {
        total.duration_ms += r.duration_ms;
        total.source_count += r.source_count;
        total.error_count += r.error_count;
        total.warning_count += r.warning_count;
        // jar 数是「这一轮挂了多少」，取最大值才是真实峰值；加起来只会得到一个
        // 没有意义的数（几轮各挂 16 个 jar 不等于挂了 48 个）
        total.jar_count = total.jar_count.max(r.jar_count);
        total.rounds += r.rounds;
        total.problems.extend(r.problems);
        total.diagnostics.extend(r.diagnostics);
    }
    total.ok = total.error_count == 0;
    total
}

/// 编译**一批文件**（编辑器保存后自动编译走这条；手动「编译当前文件」传一个）。
///
/// 一批里可能跨模块，按模块分组后**每组一轮 JVM**：ecj 启动约 0.9 s，一个文件一轮
/// 的话「连续保存 5 个文件」就是 5 秒纯等待。同模块的多个文件丢进同一份参数文件，
/// 与在 Eclipse 里连续保存的效果一致。
///
/// 代价见 `docs/NCForge-自动编译-调研与方案-20261104.md` §4.1：**发现不了跨文件的
/// 签名变更**——改了方法参数只重编当前文件，引用方仍是旧字节码，运行期才炸。
/// 所以它只是第一道网，改签名仍要手动「编译模块」。
///
/// **不看 `auto_compile` 开关**：那个开关是「保存后要不要自动编」的前端偏好，
/// 由 `autoCompileQueue` 在入队前判；命令本身必须无条件可用，否则手动
/// 「编译当前文件」在关掉自动编译后就永远失败了。
#[tauri::command]
pub async fn compile_file(
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
    let total_files: usize = groups.iter().map(|(_, f)| f.len()).sum();

    let home = nc_home::resolve(state.config.read().await.nc_home.as_deref())?;
    let nc_home = PathBuf::from(&home.root);
    let java = PathBuf::from(&home.java);
    let ecj = find_ecj(&state.config_dir)?;
    let cache_path = state.config_dir.join("class-index.bin");
    let work_dir = state.config_dir.join("tmp");
    let st = state.inner().clone();
    let overrides =
        crate::eclipse_cp::active_overrides(&state.config.read().await.linked_overrides);

    tauri::async_runtime::spawn_blocking(move || {
        // 索引还没建好就先跳过：首次冷扫 10~100 秒，把它挂在「保存」上会一直亮着
        // 「编译中」（期间命令面板里的编译项全灰），而自动编译这条链路又刻意不写
        // 编译日志，用户只会看到编辑器卡住。顺手在后台起一次建索引，下次保存就能编上。
        if lookup_index(&nc_home, "")?.is_none() {
            // 同一时刻只让一个后台任务去建：连按保存不该排出十个等闸的线程
            if !WARMING.swap(true, std::sync::atomic::Ordering::SeqCst) {
                let (h, c) = (nc_home.clone(), cache_path.clone());
                tauri::async_runtime::spawn_blocking(move || {
                    let _ = cached_index(&h, &c, "", &|_| {});
                    WARMING.store(false, std::sync::atomic::Ordering::SeqCst);
                });
            }
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
        st.compile_cancel
            .store(false, std::sync::atomic::Ordering::SeqCst);
        // 自动编译**不写 compile-log**：那是手动编译的输出面板，每次保存往里塞几行
        // 会把它淹掉。真要排查，后端 log 里有。
        let log = |_: &str| {};
        let mut results = Vec::with_capacity(groups.len());
        for (module, files) in groups {
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
                module,
                files: Some(files),
                seed_jars: seed,
            };
            // 不写回模块 seed：单文件挑出的 jar 是整模块 seed 的子集，写回去会让下一次
            // 整模块编译少挂 jar、多跑几轮「按报错补 jar」。也**不投送元数据**——单个 class
            // 与 upm 无关，投送只在整模块编译成功后做。
            results.push(compile::compile(&env, &job, &log)?);
        }
        Ok(CompileFileOutcome::Done {
            result: merge_results(results, total_files),
        })
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
    let (root, nc_home_cfg, overrides, deploy_on_start) = {
        let cfg = state.config.read().await;
        let root = cfg
            .workspace_root
            .clone()
            .ok_or_else(|| "尚未选择工作区目录".to_string())?;
        (
            root,
            cfg.nc_home.clone(),
            crate::eclipse_cp::active_overrides(&cfg.linked_overrides),
            cfg.deploy_on_start,
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
    let config_dir = state.config_dir.clone();
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
            None => {
                log("全部模块编译完成");
                deploy_after_compile(
                    deploy_on_start,
                    &config_dir,
                    &root,
                    &nc_home,
                    &overrides,
                    &log,
                );
            }
        }
        Ok(total)
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
        }
    }

    #[test]
    fn 多模块结果按字段合并而不是相加_jar_数() {
        let merged = merge_results(vec![result(0, 16, vec![1, 2]), result(2, 40, vec![3])], 3);
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
        let merged = merge_results(vec![result(0, 16, vec![])], 1);
        assert_eq!(merged.out_dir, "C:/w/m/classes");
    }

    #[test]
    fn 全部无错才算_ok() {
        let merged = merge_results(vec![result(0, 1, vec![]), result(0, 1, vec![])], 2);
        assert!(merged.ok);
        assert_eq!(merged.error_count, 0);
    }
}
