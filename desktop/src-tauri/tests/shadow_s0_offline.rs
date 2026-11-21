//! S0 离线测量（不启 jdt.ls）：工作区模块清单、依赖闭包规模、jar 并集、classpath 规模。
//!
//! 对应 `docs/NCForge-智能代码-单索引常驻-规划-2026-11-21.md` S0 的两项：
//! - **全量 vs 依赖闭包** → 决定 `lang.shadowModules` 默认档位（`all` / `closure`）
//! - **jar 并集规模** → 决定 flat 的 classpath 会不会长到拖慢 jdt.ls 解析
//!
//! 为什么单独一个文件、不复用 `shadow_scale_live.rs`：
//! 那个文件 850 行且要起 jdt.ls（分钟级、依赖 NC home 可执行）；这里全是纯计算
//! （秒级、只读文件系统），跑法、失败模式、CI 可行性都不同。
//!
//! ```bash
//! cargo test --test shadow_s0_offline -- --ignored --nocapture
//! # 换工作区 / NC home：
//! NCFORGE_TEST_WORKSPACE=D:\work\x NCFORGE_NC_HOME=D:\ncc\65home \
//!   cargo test --test shadow_s0_offline -- --ignored --nocapture
//! ```
//!
//! 🔴 结论落 `target/perf/`，不写 test-tmp：`rust-gate.mjs::wipeTmp()` 会清空 test-tmp，
//! 写那儿等于跑一次门禁就把结论删了（`shadow_scale_live.rs` 头注同款教训）。

#![allow(non_snake_case)]

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::Instant;

use nc_forge::compile::{collect_sources, select_jars};
use nc_forge::eclipse_cp::graph;
use nc_forge::nc_index::{classpath_jars, ClassIndex};

/// 与 `shadow.rs:37` 的 `SRC_DIRS` 同源。
///
/// 那边是**私有** `const`，integration test 是外部 crate 拿不到，所以只能复制。
/// 一致性判据：本探针报的模块数，必须等于 flat 生成出来的「源根所属模块数」——
/// 若哪天 `shadow.rs` 加了 `src/test` 之类，这里会先于生产代码暴露出数量偏差。
const SRC_DIRS: [&str; 3] = ["src/public", "src/client", "src/private"];

/// 不算模块的一级目录。`out` 是编译默认输出（含外部源码产物），`META-INF` 是注册文件。
const NOT_MODULE: [&str; 4] = ["out", "META-INF", "nclogs", "bin"];

fn nc_home() -> PathBuf {
    std::env::var("NCFORGE_NC_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(r"D:\ncc\1909home"))
}

fn workspace() -> PathBuf {
    std::env::var("NCFORGE_TEST_WORKSPACE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(r"C:\work\aier\newar"))
}

/// 结论落盘目录。不建 junction，所以不像 `shadow_scale_live` 那样非要剥 `\\?\`，
/// 但仍统一成同一个 `target/perf`，方便两批数据放一起看。
fn perf_dir() -> PathBuf {
    let raw = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/perf");
    let _ = std::fs::create_dir_all(&raw);
    raw.canonicalize().unwrap_or(raw)
}

/// 工作区里「有源码」的模块：一级目录 + 含 `SRC_DIRS` 任一。
///
/// 与生产即将实现的 flat 清单同口径（规划 §4.1）：**不取依赖闭包**。
fn workspace_modules(ws: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(ws) else {
        return out;
    };
    for e in entries.flatten() {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || NOT_MODULE.contains(&name.as_str()) {
            continue;
        }
        if SRC_DIRS.iter().any(|s| p.join(s).is_dir()) {
            out.push(name);
        }
    }
    out.sort();
    out
}

fn mb(bytes: u64) -> f64 {
    bytes as f64 / 1024.0 / 1024.0
}

#[test]
#[ignore]
fn s0_模块清单_闭包_jAR并集() {
    let ws = workspace();
    let home = nc_home();
    assert!(ws.is_dir(), "工作区不存在：{}", ws.display());
    assert!(home.is_dir(), "NC home 不存在：{}", home.display());

    let mut md = String::new();
    md.push_str("# S0 离线测量：模块清单 / 闭包 / jar 并集\n\n");

    // ── 1. 模块清单（全量）────────────────────────────────────────────
    let mods = workspace_modules(&ws);
    let mut per_module: Vec<(String, usize, usize, u128)> = Vec::new(); // (名, 文件数, jar 数, select 耗时ms)
    let mut all_files: Vec<PathBuf> = Vec::new();
    let mut total_bytes: u64 = 0;

    let t_index = Instant::now();
    let index = ClassIndex::load_or_build(classpath_jars(&home), None, None);
    let index_ms = t_index.elapsed().as_millis();
    println!(
        "[量] ClassIndex: {} 个 jar / {} 个类，构建+加载 {:.2}s",
        index.jars.len(),
        index.class_count(),
        index_ms as f64 / 1000.0
    );

    let t_all = Instant::now();
    for m in &mods {
        let dir = ws.join(m);
        let files = collect_sources(&dir);
        if files.is_empty() {
            continue;
        }
        let t = Instant::now();
        let jars = select_jars(&index, &files);
        let ms = t.elapsed().as_millis();
        for f in &files {
            if let Ok(meta) = std::fs::metadata(f) {
                total_bytes += meta.len();
            }
        }
        per_module.push((m.clone(), files.len(), jars.len(), ms));
        all_files.extend(files);
    }
    let scan_secs = t_all.elapsed().as_secs_f32();

    let total_files: usize = per_module.iter().map(|x| x.1).sum();
    println!(
        "[量] 全量：{} 个模块 / {} 个 .java / {:.1}MB 源码，逐模块 select_jars 合计 {:.2}s",
        per_module.len(),
        total_files,
        mb(total_bytes),
        scan_secs
    );

    // 逐个打印（大的在前），便于看「耗时是不是集中在少数大模块」
    let mut sorted = per_module.clone();
    sorted.sort_by_key(|(_, n, _, _)| std::cmp::Reverse(*n));
    md.push_str(&format!(
        "## 1. 模块清单（全量）\n\n共 **{}** 个有源码模块 / **{}** 个 `.java` / **{:.1} MB** 源码。\n\n",
        per_module.len(),
        total_files,
        mb(total_bytes)
    ));
    md.push_str("| 模块 | .java | select_jars 命中 jar | 耗时 |\n|---|---|---|---|\n");
    for (m, n, j, ms) in sorted.iter().take(15) {
        println!("[量]   {m:<12} {n:>5} 文件  {j:>4} jar  {ms:>5}ms");
        md.push_str(&format!("| {m} | {n} | {j} | {ms}ms |\n"));
    }
    if sorted.len() > 15 {
        md.push_str(&format!("| …其余 {} 个模块 | | | |\n", sorted.len() - 15));
    }

    // ── 2. 依赖闭包（eclipse_cp）──────────────────────────────────────
    // 主工程 = 工作区根本身（newar 的 .project 名是 ar，`.classpath` 里没有 `/X` 工程引用）
    let g = graph(&ws, &home, &[]);
    let closure_names: Vec<String> = g.projects.iter().map(|p| p.name.clone()).collect();
    println!(
        "[量] 闭包：{} 个工程 → {:?}（主工程 {}）",
        closure_names.len(),
        closure_names,
        g.primary
    );
    md.push_str(&format!(
        "\n## 2. 依赖闭包（`eclipse_cp::graph`）\n\n主工程 `{}`，闭包 **{}** 个工程：`{:?}`。\n\n",
        g.primary,
        closure_names.len(),
        closure_names
    ));
    md.push_str(&format!(
        "> 对比全量 **{}** 个含 `SRC_DIRS` 目录的模块（其中 **{}** 个真有 `.java`）：\n\
         > 闭包覆盖的是「Eclipse 工程级依赖」，而用户在**同一个工程内部**跨模块跳\n\
         > （模块不是独立 project）——闭包天然看不到它们。\n\
         > 这正是规划 §4.1「默认全工作区、不要用 graph」的实测依据。\n\
         > ⚠️ 顺带一条 S1 的实现细节：源根要按「**真有 `.java`**」筛（{} vs {}），\n\
         > 否则会生成空源根，jdt.ls 会报 classpath 警告。\n\n",
        mods.len(),
        per_module.len(),
        mods.len(),
        per_module.len()
    ));

    // ── 3. jar 并集 vs 单模块基线 ────────────────────────────────────
    let t_union = Instant::now();
    let union: BTreeSet<u32> = select_jars(&index, &all_files);
    let union_ms = t_union.elapsed().as_millis();

    // 基线：ic（生产现状只链它）
    let ic_files = collect_sources(&ws.join("ic"));
    let ic_jars = select_jars(&index, &ic_files);
    // 对照：文件最多的那个模块
    let biggest = sorted.first().map(|x| x.0.clone()).unwrap_or_default();
    let big_jars = collect_sources(&ws.join(&biggest));
    let big_set = select_jars(&index, &big_jars);

    let cp_bytes: u64 = union
        .iter()
        .filter_map(|&i| index.jars.get(i as usize))
        .map(|p| p.to_string_lossy().len() as u64 + 24) // +24 ≈ XML 标签开销
        .sum();

    println!(
        "[量] jar：ic {} 条 / {} {} 条 / 并集 {} 条（{:.0}KB classpath），并集计算 {:.2}s",
        ic_jars.len(),
        biggest,
        big_set.len(),
        union.len(),
        cp_bytes as f64 / 1024.0,
        union_ms as f64 / 1000.0
    );
    md.push_str(&format!(
        "## 3. jar 并集\n\n\
         | 口径 | jar 条数 | 说明 |\n|---|---|---|\n\
         | `ic`（生产现状） | {} | 只链一个模块 |\n\
         | `{}`（最大模块） | {} | 单模块上限 |\n\
         | **全量并集** | **{}** | flat 实际要写进 `.classpath` 的条数 |\n\n\
         并集 classpath 估算 **{:.0} KB**（每条按路径长度 + 24 字节标签）。\n\
         全量 {} 文件一次性 `select_jars` 耗时 **{:.2}s**（含逐文件解码）。\n\n",
        ic_jars.len(),
        biggest,
        big_set.len(),
        union.len(),
        cp_bytes as f64 / 1024.0,
        total_files,
        union_ms as f64 / 1000.0
    ));

    // ── 4. ClassIndex 固定成本 ───────────────────────────────────────
    md.push_str(&format!(
        "## 4. 固定成本\n\n\
         `ClassIndex` 载入 {} 个 jar / {} 个类：**{:.2}s**。\n\
         这是 flat 与 single 都要付的，不构成两者差异。\n\n",
        index.jars.len(),
        index.class_count(),
        index_ms as f64 / 1000.0
    ));

    let out = perf_dir().join("shadow-s0-offline.md");
    let _ = std::fs::write(&out, &md);
    println!("[出] 结论：{}", out.display());

    // 基本自洽（不是「必须通过」的业务断言，是防止测出空数据还当成功）
    assert!(!mods.is_empty(), "一个模块都没识别出来，口径错了");
    assert!(union.len() >= ic_jars.len(), "并集不可能比单模块少");
}
