//! 真机快照：产物新旧检测接在 `C:\work\aier` 三工程上的表现。
//!
//! 默认不跑（`#[ignore]`）：依赖本机目录与真实产物。
//!
//! 它防的是**两条具体的错**。
//!
//! 其一，只看 `<模块>/classes` 与 `<模块>/out` 两种产物布局，会把 `pm` 判成「一个 class
//! 都没有」——本机 `pm` 的 `uapbd`/`pubapp` 源码没写 `output=`，339 个 class 全在
//! `pm/bin`。所以断言里明确要求 `pm` 不出 `no-output`。
//!
//! 其二，有人把它接回编译流程：这是**按需**命令（实测三工程 8.3 秒 / 149k 个目录条目），
//! 接回去等于每次编译白等 8 秒。编译路径上只有按类判断（毫秒级）。
//!
//! ```bash
//! cargo test --test compile_diag_live -- --ignored --nocapture --test-threads=1
//! ```
//!
//! 工作区根可用 `NC_WORKSPACE` 覆盖（默认 `C:\work\aier`）。

use nc_forge::compile_diag::stale_diagnostics;
use nc_forge::eclipse_cp::graph;
use std::path::PathBuf;
use std::time::Instant;

fn workspace() -> PathBuf {
    std::env::var_os("NC_WORKSPACE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\work\aier"))
}

#[test]
#[ignore = "要本机 C:\\work\\aier 三工程"]
fn 三工程的产物新旧与扫描耗时() {
    let ws = workspace();
    let primary = ws.join("EyePortal");
    if !primary.is_dir() {
        eprintln!("跳过：{} 不存在", primary.display());
        return;
    }
    let g = graph(&primary, &ws.join("nchome"), &[]);
    eprintln!(
        "依赖链：{}，{} 个工程",
        g.projects
            .iter()
            .map(|p| p.name.as_str())
            .collect::<Vec<_>>()
            .join(" → "),
        g.projects.len()
    );

    let t = Instant::now();
    let d = stale_diagnostics(&g.projects);
    let cost = t.elapsed();
    eprintln!("扫描耗时 {} ms，{} 条诊断", cost.as_millis(), d.len());
    for x in &d {
        eprintln!("  [{}] {} · {:?}", x.kind, x.message, x.file);
    }

    // pm 的产物全在 bin：只要 `.classpath` 的 output 被正确采用，就一定有 class
    assert!(
        !d.iter().any(|x| x.project == "pm" && x.kind == "no-output"),
        "pm 被误判成「没有产物」——检查是否写死了产物目录名（本机在 pm/bin）"
    );
    // 这是**按需**操作（用户点按钮），不在编译路径上。上限放宽到 30 秒，
    // 只为防止哪天实现退化成扫两遍整个工作区。
    assert!(
        cost.as_millis() < 30_000,
        "扫描耗时 {} ms，比预期慢一个数量级",
        cost.as_millis()
    );
}
