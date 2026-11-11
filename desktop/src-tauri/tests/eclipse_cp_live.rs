//! 真机快照：本机 `C:\work\aier` 三工程（`EyePortal → pm → newar`）。
//!
//! 默认不跑（`#[ignore]`）：依赖本机目录与编译产物存在，CI 上没有意义。
//! 它验的不是「规则对不对」（那是 `src/eclipse_cp.rs` 单测的事），而是
//! **规则接到真实工程上之后，出来的目录序列是不是方案文档写的那三条**：
//!
//! - `EyePortal` 9 个输出目录、`pm` 8 个、`newar` 35 个（去重后，含各自的默认 `bin` /
//!   `out/bin`）；
//! - `pm` 整段排在 `newar` 之前（18 个同名类该由 pm 赢）；
//! - `pm/bin`（339 个 class）在类路径里，且排在 `newar/out/uapbd` 之前。
//!
//! ```bash
//! cargo test --test eclipse_cp_live -- --ignored --nocapture --test-threads=1
//! ```
//!
//! 工作区根可用 `NC_WORKSPACE` 覆盖（默认 `C:\work\aier`）。

// 测试名里带工程名（EyePortal），clippy 的 snake_case 在 `-D warnings` 下会挂。
#![allow(non_snake_case)]

use nc_forge::eclipse_cp::class_roots;
use std::path::{Path, PathBuf};

fn workspace() -> PathBuf {
    std::env::var_os("NC_WORKSPACE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\work\aier"))
}

fn skip_unless(ws: &Path) -> bool {
    if ws.join("EyePortal").is_dir() && ws.join("pm").is_dir() && ws.join("newar").is_dir() {
        return false;
    }
    eprintln!("跳过：{} 下没有 EyePortal/pm/newar 三工程", ws.display());
    true
}

#[test]
#[ignore = "要本机 C:\\work\\aier 三工程"]
fn 三工程的类目录数量与顺序() {
    let ws = workspace();
    if skip_unless(&ws) {
        return;
    }
    let (portal, pm, newar) = (ws.join("EyePortal"), ws.join("pm"), ws.join("newar"));
    // 空 home：让 NC home 那段是空的，只看工程段
    let home = std::env::temp_dir().join("ncforge-cp-live-no-home");

    let dirs = class_roots(&portal, &home);
    let count = |root: &Path| dirs.iter().filter(|d| d.starts_with(root)).count();

    assert_eq!(count(&portal), 9, "EyePortal 应有 9 个输出目录");
    assert_eq!(count(&pm), 8, "pm 应有 8 个（7 个显式 + 默认 bin）");
    // 35 = 34 个显式 + 默认 out/bin；再加 5 个「工作台编译产物 `<模块>/classes`」——
    // 这些模块在 Eclipse 里的输出是 out/<模块> 或默认 out/bin，工作台却编到 `<模块>/classes`，
    // 不把它排到 Eclipse 旧产物前面，改了代码运行时也不生效（A4）。
    // 数量随本机哪些模块已经被工作台编译过而变，这里只锁「不少于 Eclipse 的 35」。
    assert!(
        count(&newar) >= 35,
        "newar 至少 35 个（34 个显式 + 默认 out/bin），实际 {}",
        count(&newar)
    );
    assert_eq!(dirs.len(), 9 + 8 + count(&newar), "总数 = 9 + 8 + newar");

    // 段顺序：EyePortal → pm → newar
    let pos = |root: &Path| dirs.iter().position(|d| d.starts_with(root)).unwrap();
    assert!(pos(&portal) < pos(&pm), "主工程必须在最前");
    assert!(pos(&pm) < pos(&newar), "直接依赖要排在传递依赖之前");

    // D0 的核心断言：pm/bin 在，且压过 newar 的同名类目录
    let pm_bin = pm.join("bin");
    let newar_uapbd = newar.join("out").join("uapbd");
    assert!(pm_bin.is_dir(), "{} 应存在", pm_bin.display());
    assert!(newar_uapbd.is_dir(), "{} 应存在", newar_uapbd.display());
    let i_pm = dirs
        .iter()
        .position(|d| d == &pm_bin)
        .expect("pm/bin 必须进类路径");
    let i_newar = dirs
        .iter()
        .position(|d| d == &newar_uapbd)
        .expect("newar/out/uapbd 必须在类路径里");
    assert!(
        i_pm < i_newar,
        "pm/bin 排在 {} 位、newar/out/uapbd 排在 {} 位：顺序反了，pm 改的类就不生效",
        i_pm,
        i_newar
    );

    eprintln!("EyePortal → pm → newar 共 {} 个类目录", dirs.len());
    for (i, d) in dirs.iter().enumerate() {
        eprintln!("  {i:>2}. {}", d.display());
    }
}

/// `exported="true"` 传递的承重证据：EyePortal 直接引用的工程只有 pm，
/// newar 必须靠 `pm → newar` 那条 exported 边才能进来。
#[test]
#[ignore = "要本机 C:\\work\\aier 三工程"]
fn exported_边让_newar_进到_EyePortal_的类路径() {
    let ws = workspace();
    if skip_unless(&ws) {
        return;
    }
    let (portal, newar) = (ws.join("EyePortal"), ws.join("newar"));
    let dirs = class_roots(
        &portal,
        &std::env::temp_dir().join("ncforge-cp-live-no-home"),
    );
    assert!(
        dirs.iter().any(|d| d.starts_with(&newar)),
        "newar 没进来：EyePortal 有 95 个类只能经 pm 的 exported 边拿到，编译会挂"
    );
}
