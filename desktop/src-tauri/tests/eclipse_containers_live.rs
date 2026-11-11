//! 真机探针：NC home 一级库容器——Eclipse 插件的取法 vs 我们 `classpath_jars` 的取法。
//!
//! 默认不跑（`#[ignore]`）。Eclipse 一侧的规则来自反编译 `nc.uap.mde`（2013 版）的
//! `CoreUtility.getClasspathEntry` / `ClasspathComputer`：
//! - `Ant_Library` = `standCP(ant)`；`Product_Common_Library` = `standCP(NC_HOME, external)`；
//! - `Middleware_Library` / `Framework_Library` / `Module_Lang_Library` = 目录**下一层**的 jar/zip
//!   （不递归），再按默认排除正则过滤，按文件名忽略大小写排序；
//! - 容器顺序：Ant → 公共 → 中间件 → 框架 → 模块 public/client/private → 语言库 → EJB。
//!
//! 运行：`node scripts/rust-gate.mjs test --test eclipse_containers_live -- --ignored --nocapture`

use nc_forge::nc_index::{classpath_jars, one_level_archives, stand_cp};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

fn nc_home() -> PathBuf {
    std::env::var_os("NC_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"D:\ncc\1909home"))
}

/// 缺 NC home 或关键子目录时打印跳过原因（与 eclipse_parity_live 口径一致）。
///
/// 不守卫的话，两边都取到空集，「空集 == 空集」恒绿——什么都没比也显示成通过。
fn home_ready(home: &Path, need: &[&str]) -> bool {
    let mut missing: Vec<String> = Vec::new();
    if !home.is_dir() {
        missing.push(home.display().to_string());
    } else {
        for d in need {
            let p = home.join(d);
            if !p.is_dir() {
                missing.push(p.display().to_string());
            }
        }
    }
    if missing.is_empty() {
        return true;
    }
    eprintln!("跳过：缺 {}", missing.join(" / "));
    false
}

/// 插件默认的「排除 jar」正则（`EXCEPT_JAR_NC_HOME` 偏好缺省值），大小写不敏感、用 find 语义。
fn except_res() -> Vec<regex::Regex> {
    [
        "nc.bs.framework.tool.config.+.jar",
        "testbill.+.jar",
        ".*PROXY.jar",
    ]
    .iter()
    .map(|s| {
        regex::RegexBuilder::new(s)
            .case_insensitive(true)
            .build()
            .unwrap()
    })
    .collect()
}

fn filtered_one_level(dir: &Path, res: &[regex::Regex]) -> Vec<PathBuf> {
    one_level_archives(dir)
        .into_iter()
        .filter(|p| {
            let n = p.file_name().unwrap().to_string_lossy().to_string();
            !res.iter().any(|r| r.is_match(&n))
        })
        .collect()
}

fn norm(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/").to_lowercase()
}

fn classes_of(jar: &Path) -> BTreeSet<String> {
    let Ok(f) = std::fs::File::open(jar) else {
        return BTreeSet::new();
    };
    let Ok(z) = zip::ZipArchive::new(std::io::BufReader::new(f)) else {
        return BTreeSet::new();
    };
    z.file_names()
        .filter(|n| n.ends_with(".class"))
        .map(|n| n.to_string())
        .collect()
}

#[test]
#[ignore = "依赖本机 NC home"]
fn 一级库容器与_eclipse_取法对比() {
    let home = nc_home();
    if !home_ready(&home, &["framework", "middleware"]) {
        return;
    }
    let res = except_res();

    // Eclipse 的 NC home 一级容器（只含 jar，散类目录不在比较范围）
    let mut eclipse: Vec<(String, PathBuf)> = Vec::new();
    let is_jar = |p: &PathBuf| {
        p.extension()
            .is_some_and(|x| x.eq_ignore_ascii_case("jar") || x.eq_ignore_ascii_case("zip"))
            && !res
                .iter()
                .any(|r| r.is_match(&p.file_name().unwrap().to_string_lossy()))
    };
    for p in stand_cp(&home.join("ant")).into_iter().filter(is_jar) {
        eclipse.push(("Ant".into(), p));
    }
    for p in stand_cp(&home).into_iter().filter(is_jar) {
        eclipse.push(("Common".into(), p));
    }
    for p in stand_cp(&home.join("external")).into_iter().filter(is_jar) {
        eclipse.push(("Common".into(), p));
    }
    for p in filtered_one_level(&home.join("middleware"), &res) {
        eclipse.push(("Middleware".into(), p));
    }
    for p in filtered_one_level(&home.join("framework"), &res) {
        eclipse.push(("Framework".into(), p));
    }
    let lang = filtered_one_level(&home.join("langlib"), &res);

    // 我们的：模块以外的前半段
    let ours_all = classpath_jars(&home);
    let top =
        ["lib", "framework", "external/lib", "middleware", "ant/lib"].map(|d| norm(&home.join(d)));
    let ours: Vec<PathBuf> = ours_all
        .into_iter()
        .filter(|p| top.iter().any(|t| norm(p).starts_with(&format!("{t}/"))))
        .collect();
    // home 在、却一个 jar 都没取到：这不是「通过」，是根本没比
    assert!(
        !eclipse.is_empty() && !ours.is_empty(),
        "两边都没取到一级容器 jar（Eclipse {} / 我们 {}），没有比对任何东西",
        eclipse.len(),
        ours.len()
    );

    let e_set: BTreeMap<String, &str> =
        eclipse.iter().map(|(c, p)| (norm(p), c.as_str())).collect();
    let o_set: BTreeSet<String> = ours.iter().map(|p| norm(p)).collect();

    let only_ours: Vec<&PathBuf> = ours
        .iter()
        .filter(|p| !e_set.contains_key(&norm(p)))
        .collect();
    let only_eclipse: Vec<&(String, PathBuf)> = eclipse
        .iter()
        .filter(|(_, p)| !o_set.contains(&norm(p)))
        .collect();

    println!(
        "Eclipse 一级容器 jar：{}；我们：{}",
        eclipse.len(),
        ours.len()
    );
    let lang_classes: usize = lang.iter().map(|p| classes_of(p).len()).sum();
    let lang_with: Vec<_> = lang
        .iter()
        .filter(|p| !classes_of(p).is_empty())
        .take(5)
        .collect();
    println!(
        "langlib（Eclipse 的 Module_Lang_Library，我们未收）：{} 个 jar，共 {lang_classes} 个 class；有 class 的示例 {:?}",
        lang.len(),
        lang_with
    );
    println!("\n只有我们有（{}）：", only_ours.len());
    let eclipse_classes: BTreeSet<String> =
        eclipse.iter().flat_map(|(_, p)| classes_of(p)).collect();
    for p in &only_ours {
        let cs = classes_of(p);
        let unique = cs.iter().filter(|c| !eclipse_classes.contains(*c)).count();
        println!(
            "  {}  类 {} / Eclipse 里没有的 {}",
            norm(p).replace(&norm(&home), ""),
            cs.len(),
            unique
        );
    }
    println!("\n只有 Eclipse 有（{}）：", only_eclipse.len());
    for (c, p) in &only_eclipse {
        println!("  [{c}] {}", norm(p).replace(&norm(&home), ""));
    }

    // 顺序：共有的 jar 里，同名类先出现的是谁
    // 读 class 一律用原始路径：norm 后的串是全小写的，盘符还原不回来（写死 d:/→D:/ 换台机器就全读空、假绿）
    let ecl_order: Vec<PathBuf> = eclipse.iter().map(|(_, p)| p.clone()).collect();
    let our_order: Vec<PathBuf> = ours
        .iter()
        .filter(|p| e_set.contains_key(&norm(p)))
        .cloned()
        .collect();
    let mut first_e: BTreeMap<String, String> = BTreeMap::new();
    for p in &ecl_order {
        for c in classes_of(p) {
            first_e.entry(c).or_insert_with(|| norm(p));
        }
    }
    let mut first_o: BTreeMap<String, String> = BTreeMap::new();
    for p in &our_order {
        for c in classes_of(p) {
            first_o.entry(c).or_insert_with(|| norm(p));
        }
    }
    let mut shadow_diff: Vec<(&String, &String, &String)> = first_e
        .iter()
        .filter_map(|(c, e)| first_o.get(c).filter(|o| *o != e).map(|o| (c, e, o)))
        .collect();
    shadow_diff.sort();
    println!("\n同名类在两边先命中的 jar 不同：{} 个", shadow_diff.len());
    let mut by_pair: BTreeMap<(String, String), usize> = BTreeMap::new();
    for (_, e, o) in &shadow_diff {
        *by_pair.entry(((*e).clone(), (*o).clone())).or_default() += 1;
    }
    for ((e, o), n) in by_pair.iter().take(15) {
        println!(
            "  Eclipse 先中 {} / 我们先中 {}  ×{n}",
            e.replace(&norm(&home), ""),
            o.replace(&norm(&home), "")
        );
    }

    // 回归断言：集合与 Eclipse 容器完全一致，且同名类的先后顺序也一致
    assert!(
        only_ours.is_empty(),
        "我们多收了 Eclipse 看不到的 jar：{only_ours:?}"
    );
    assert!(
        only_eclipse.is_empty(),
        "我们漏收了 Eclipse 的 jar：{only_eclipse:?}"
    );
    assert!(shadow_diff.is_empty(), "同名类先命中的 jar 与 Eclipse 不同");
}

/// 模块三个容器（Public / Client / Private）的取法与顺序。
///
/// Eclipse 的顺序是「所有模块的 public → 所有模块的 client（uap* 在前）→ 所有模块的 META-INF」，
/// 不是按模块分组；跨模块同名类谁先命中取决于它。这里只比 jar（散类目录另外比）。
#[test]
#[ignore = "依赖本机 NC home"]
fn 模块容器与_eclipse_取法对比() {
    let home = nc_home();
    if !home_ready(&home, &["modules"]) {
        return;
    }
    let res = except_res();
    let names = nc_forge::nc_index::module_names(&home);
    let modules = home.join("modules");
    if names.is_empty() {
        eprintln!("跳过：{} 下没读到模块", modules.display());
        return;
    }
    let keep = |p: &PathBuf| {
        p.extension()
            .is_some_and(|x| x.eq_ignore_ascii_case("jar") || x.eq_ignore_ascii_case("zip"))
            && !res
                .iter()
                .any(|r| r.is_match(&p.file_name().unwrap().to_string_lossy()))
    };
    let mut eclipse: Vec<PathBuf> = Vec::new();
    for n in &names {
        eclipse.extend(stand_cp(&modules.join(n)).into_iter().filter(keep));
    }
    let uap = |n: &String| n.to_ascii_lowercase().starts_with("uap");
    for n in names.iter().filter(|n| uap(n)) {
        eclipse.extend(
            stand_cp(&modules.join(n).join("client"))
                .into_iter()
                .filter(keep),
        );
    }
    for n in names.iter().filter(|n| !uap(n)) {
        eclipse.extend(
            stand_cp(&modules.join(n).join("client"))
                .into_iter()
                .filter(keep),
        );
    }
    for n in &names {
        eclipse.extend(
            stand_cp(&modules.join(n).join("META-INF"))
                .into_iter()
                .filter(keep),
        );
    }

    let mods = norm(&modules);
    let ours: Vec<PathBuf> = classpath_jars(&home)
        .into_iter()
        .filter(|p| norm(p).starts_with(&format!("{mods}/")))
        .collect();
    let e_set: BTreeSet<String> = eclipse.iter().map(|p| norm(p)).collect();
    let o_set: BTreeSet<String> = ours.iter().map(|p| norm(p)).collect();
    // home 与 modules 都在、却一个 jar 都没取到：这不是「通过」，是根本没比
    assert!(
        !e_set.is_empty() && !o_set.is_empty(),
        "两边都没取到模块容器 jar（Eclipse {} / 我们 {}），没有比对任何东西",
        e_set.len(),
        o_set.len()
    );
    println!(
        "Eclipse 模块容器 jar：{}（去重 {}）；我们：{}（去重 {}）",
        eclipse.len(),
        e_set.len(),
        ours.len(),
        o_set.len()
    );
    let only_ours: Vec<&String> = o_set.difference(&e_set).collect();
    let only_eclipse: Vec<&String> = e_set.difference(&o_set).collect();
    println!(
        "只有我们有 {}：{:?}",
        only_ours.len(),
        only_ours.iter().take(8).collect::<Vec<_>>()
    );
    println!(
        "只有 Eclipse 有 {}：{:?}",
        only_eclipse.len(),
        only_eclipse.iter().take(8).collect::<Vec<_>>()
    );

    // 同名类先命中的 jar（只计两边都有的 jar）
    let first = |list: &[PathBuf]| {
        let mut m: BTreeMap<String, String> = BTreeMap::new();
        let mut seen = BTreeSet::new();
        for p in list {
            if !e_set.contains(&norm(p)) || !o_set.contains(&norm(p)) || !seen.insert(norm(p)) {
                continue;
            }
            for c in classes_of(p) {
                m.entry(c).or_insert_with(|| norm(p));
            }
        }
        m
    };
    let fe = first(&eclipse);
    let fo = first(&ours);
    let diff: Vec<(&String, &String, &String)> = fe
        .iter()
        .filter_map(|(c, e)| fo.get(c).filter(|o| *o != e).map(|o| (c, e, o)))
        .collect();
    println!(
        "同名类先命中的 jar 不同：{} 个（共 {} 个类）",
        diff.len(),
        fe.len()
    );
    let mut by_pair: BTreeMap<(String, String), usize> = BTreeMap::new();
    for (_, e, o) in &diff {
        *by_pair.entry(((*e).clone(), (*o).clone())).or_default() += 1;
    }
    for ((e, o), n) in by_pair.iter().take(20) {
        println!(
            "  Eclipse 先中 {} / 我们先中 {}  ×{n}",
            e.replace(&norm(&home), ""),
            o.replace(&norm(&home), "")
        );
    }
    for (c, _, _) in diff.iter().take(10) {
        println!("  例类 {c}");
    }
    assert!(only_ours.is_empty(), "多收：{only_ours:?}");
    assert!(only_eclipse.is_empty(), "漏收：{only_eclipse:?}");
    assert!(diff.is_empty(), "跨模块同名类先命中的 jar 与 Eclipse 不同");
}
