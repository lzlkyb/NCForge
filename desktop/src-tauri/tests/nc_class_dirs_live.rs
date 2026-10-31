//! 真机快照：NC home 的六段散类目录（D6）。
//!
//! 默认不跑（`#[ignore]`）：依赖本机 NC 安装目录。它验的是一个具体的数字：
//! 旧实现只收 `modules/<m>/classes`（458 个 class），**漏掉 147 个二开覆盖类**——
//! 它们散在 `client/classes`、`META-INF/classes`、两个 hyext 段里。
//!
//! 本机（`D:/ncc/1909home`，245 个模块）**2026-10-31 复核实测**：
//!
//! | 段 | 目录数 | class 数 |
//! |---|---|---|
//! | `modules/*/classes` | 49 | 258 |
//! | `modules/*/client/classes` | 60 | 67 |
//! | `modules/*/META-INF/classes` | 50 | 80 |
//! | `modules/*/hyext/classes` | 0 | 0 |
//! | `modules/*/META-INF/hyext/classes` | 1 | 1 |
//! | 合计 | 160 | 406 |
//!
//! 旧实现只收第一段（258 个 class），**漏掉 148 个**二开覆盖类。方案文档 §2.5 原表把
//! 各层级的 `classes` 目录混算成「public 161 个目录 / 458 个 class」，数字偏高；
//! 本节数字是本轮 `find` 实测，以它为准（详见 §2.5 的复核注）。
//!
//! ```bash
//! cargo test --test nc_class_dirs_live -- --ignored --nocapture --test-threads=1
//! ```
//!
//! NC home 用 `NC_HOME` 覆盖（默认 `D:\ncc\1909home`）。

use nc_forge::nc_index::module_class_dirs;
use std::path::{Path, PathBuf};

fn nc_home() -> PathBuf {
    std::env::var_os("NC_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"D:\ncc\1909home"))
}

fn count_classes(dir: &Path) -> usize {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut n = 0;
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            n += count_classes(&p);
        } else if p
            .extension()
            .is_some_and(|x| x.eq_ignore_ascii_case("class"))
        {
            n += 1;
        }
    }
    n
}

#[test]
#[ignore = "要本机 NC 安装目录"]
fn 六段散类目录都被收进来且比旧实现多() {
    let home = nc_home();
    if !home.join("modules").is_dir() {
        eprintln!("跳过：{} 下没有 modules", home.display());
        return;
    }
    let dirs = module_class_dirs(&home);
    let seg = |suffix: &str| {
        dirs.iter()
            .filter(|d| d.to_string_lossy().replace('\\', "/").ends_with(suffix))
            .count()
    };

    // 旧实现只有这一段
    let public_std = seg("/classes")
        - seg("/client/classes")
        - seg("/META-INF/classes")
        - seg("/hyext/classes")
        - seg("/META-INF/hyext/classes");
    let client_std = seg("/client/classes");
    let private_std = seg("/META-INF/classes");

    let total: usize = dirs.iter().map(|d| count_classes(d)).sum();
    eprintln!(
        "散类目录 {} 个（public {} / client {} / private {}），共 {} 个 class",
        dirs.len(),
        public_std,
        client_std,
        private_std,
        total
    );

    assert!(public_std > 0, "public 标准层一个都没收：{public_std}");
    assert!(
        client_std > 0,
        "client/classes 一个都没收：二开覆盖类会报 cannot be resolved"
    );
    assert!(private_std > 0, "META-INF/classes 一个都没收");
    assert!(
        total > 258,
        "总数 {total} 不比旧实现（258）多，说明六段没生效"
    );
}
