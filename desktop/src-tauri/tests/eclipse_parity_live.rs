//! 真机回归：NCForge 整模块编译结果 vs Eclipse 产物里嵌入的 `Unresolved compilation problem`（跨引擎对账 A1）。
//!
//! 默认不跑（`#[ignore]`）：依赖本机 NC 安装目录、`C:\work\aier\newar` 与 Eclipse 编出的 class。
//! 改了 `compile.rs` / `nc_index.rs` / `eclipse_cp.rs` / `build_layout.rs` 后跑一遍，确认没有「我们报错、Eclipse 干净」的误报：
//!
//! ```bash
//! node scripts/rust-gate.mjs test --test eclipse_parity_live -- --ignored --nocapture
//! ```
//!
//! 只跑部分模块（快）：`PARITY_MODULES=aim,gl,uapbs`。全量约 8 分钟（`uapbd` 最慢）。
//!
//! # 口径（都是 2026-11-10 对账时踩过的坑）
//!
//! - 基线 = Eclipse 在 `.classpath` 各 src 条目 `output=`（默认 `bin`）里产的 class，从常量池里读
//!   `Unresolved compilation problem` 字符串。
//! - Eclipse **只在类变成问题类型时才把 import 级报错一起嵌进去**；只有方法体错误时不嵌。
//!   所以：两边都有错时只比「非 import 的缺失符号」；import 的类型在代码里没用到（注释里出现不算）时，我们的 import 报错不算。
//! - 基线不干净：`out/` 里混有 NCForge 自己单文件编的 class；class 比同目录最新源文件旧的一律当过期跳过。
//! - 只编 `ModuleLayout` 的源根（与生产一致，不含 `src/test`），产物写临时目录，绝不写用户的 `<模块>/classes`。
//!
//! # 白名单
//!
//! `tests/fixtures/eclipse_parity_baseline.txt`：每行 `类型<TAB>相对路径`，表示「已解释、允许存在的差异」。比白名单多出的差异会让测试失败。
//! 刷新白名单（确认差异都已解释后）：`PARITY_WRITE_BASELINE=1`。
//!
//! 类型：`FP` 我们报错且 Eclipse 干净（误报）；`MISS` Eclipse 有错且我们没有（漏报）；
//! `DIFF` 两边都有错但非 import 的缺失符号不一致；`ERR` 整模块编译失败。
//!
//! 工作区根用 `PARITY_ROOT` 覆盖（默认 `C:\work\aier\newar`），NC home 用 `NC_HOME`（默认 `D:\ncc\1909home`）。

use nc_forge::build_layout::ModuleLayout;
use nc_forge::compile::{compile, extract_package, CompileEnv, CompileJob};
use nc_forge::eclipse_cp::ProjectCp;
use nc_forge::nc_index::{classpath_jars, ClassIndex};
use regex::Regex;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::time::SystemTime;

fn env_path(name: &str, default: &str) -> PathBuf {
    std::env::var_os(name)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(default))
}

/// 统一成「正斜杠 + 小写」的比较键（Windows 路径不区分大小写）。
fn key(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/").to_lowercase()
}

fn find_bytes(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    hay.get(from..)?
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|i| i + from)
}

/// 读 class 常量池里的 `Unresolved compilation problem(s)` 字符串，返回逐条消息。
fn class_markers(path: &Path) -> Vec<String> {
    let Ok(b) = std::fs::read(path) else {
        return Vec::new();
    };
    let needle = b"Unresolved compilation problem";
    let mut out = Vec::new();
    let mut pos = 0;
    while let Some(i) = find_bytes(&b, needle, pos) {
        if i < 2 {
            break;
        }
        // Utf8 常量：tag(1) + 长度(2) + 内容；长度就在内容前两字节
        let n = u16::from_be_bytes([b[i - 2], b[i - 1]]) as usize;
        let end = (i + n).min(b.len());
        let s = String::from_utf8_lossy(&b[i..end]).into_owned();
        let mut lines = s
            .replace('\r', "")
            .split('\n')
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect::<Vec<_>>();
        if lines.first().is_some_and(|l| l.starts_with("Unresolved")) {
            lines.remove(0);
        }
        out.extend(lines);
        pos = end.max(i + 1);
    }
    out
}

fn mtime(p: &Path) -> Option<SystemTime> {
    std::fs::metadata(p).ok()?.modified().ok()
}

/// 源文件对应的 Eclipse class 里嵌的消息。`Err` = 不可比对（没产物 / 产物过期）。
fn eclipse_markers(
    cp: &ProjectCp,
    root: &Path,
    src: &Path,
    text: &str,
) -> Result<Vec<String>, &'static str> {
    let rel = src.strip_prefix(root).map_err(|_| "outside")?;
    let hit = cp
        .srcs
        .iter()
        .filter(|s| rel.starts_with(&s.path))
        .max_by_key(|s| s.path.components().count())
        .ok_or("nosrcentry")?;
    let out = hit
        .output
        .clone()
        .or_else(|| cp.default_output.clone())
        .unwrap_or_else(|| PathBuf::from("bin"));
    let stem = src.file_stem().and_then(|s| s.to_str()).ok_or("name")?;
    let pkg = extract_package(text).unwrap_or_default().replace('.', "/");
    let dir = root.join(out).join(pkg);
    let main = dir.join(format!("{stem}.class"));
    if !main.is_file() {
        return Err("noclass");
    }
    // 同目录任一源文件比 class 新 ⇒ 这份产物可能是源码变化前编的（或 NCForge 单文件编的），不作基线
    let newest = std::fs::read_dir(src.parent().ok_or("parent")?)
        .map_err(|_| "readdir")?
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "java"))
        .filter_map(|e| mtime(&e.path()))
        .max();
    if let (Some(c), Some(n)) = (mtime(&main), newest) {
        if c < n {
            return Err("stale");
        }
    }
    let mut msgs: BTreeSet<String> = class_markers(&main).into_iter().collect();
    let prefix = format!("{stem}$");
    for e in std::fs::read_dir(&dir).map_err(|_| "readdir")?.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with(&prefix) && name.ends_with(".class") {
            msgs.extend(class_markers(&e.path()));
        }
    }
    Ok(msgs.into_iter().collect())
}

/// 「缺失的东西」的全名；不是这类消息（Type mismatch 等连带错误）返回 `None`。
fn symbol_of(msg: &str) -> Option<String> {
    let m = msg.strip_prefix("The import ").unwrap_or(msg);
    let m = m
        .strip_suffix(" cannot be resolved to a type")
        .or_else(|| m.strip_suffix(" cannot be resolved to a variable"))
        .or_else(|| m.strip_suffix(" cannot be resolved"))?;
    (!m.is_empty()
        && m.chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '.' | '_' | '$')))
    .then(|| m.to_string())
}

/// 同一个缺失物的不同粒度（`nc.vo.pim` 与 `nc.vo.pim.x`、全名与简单名）视为一致。
///
/// 简单名相等还不够：`nc.vo.Foo` 与 `other.Foo` 是两个不同的缺失物，
/// 只比简单名会把真实的 FP / MISS / DIFF 静默放过，所以包前缀也要兼容。
fn same(a: &str, b: &str) -> bool {
    if a == b || a.starts_with(&format!("{b}.")) || b.starts_with(&format!("{a}.")) {
        return true;
    }
    let (pa, la) = a.rsplit_once('.').unwrap_or(("", a));
    let (pb, lb) = b.rsplit_once('.').unwrap_or(("", b));
    if la != lb {
        return false;
    }
    // 一方只有简单名（没带包）= 粒度更粗、包未知，不算冲突
    pa.is_empty()
        || pb.is_empty()
        || pa == pb
        || pa.starts_with(&format!("{pb}."))
        || pb.starts_with(&format!("{pa}."))
}

fn minus(x: &BTreeSet<String>, y: &BTreeSet<String>) -> Vec<String> {
    x.iter()
        .filter(|n| !y.iter().any(|m| same(n, m)))
        .cloned()
        .collect()
}

struct Tools {
    block: Regex,
    line: Regex,
    import: Regex,
}

impl Tools {
    fn new() -> Self {
        Self {
            block: Regex::new(r"(?s)/\*.*?\*/").unwrap(),
            line: Regex::new(r"//[^\n]*").unwrap(),
            import: Regex::new(r"^\s*import\s+(?:static\s+)?([A-Za-z0-9_.$]+)\s*;").unwrap(),
        }
    }

    /// import 的类型在代码里没被用到（注释里出现不算）时，Eclipse 不会把这条 import 报错嵌进 class。
    fn unused_import(&self, msg: &str, line: u32, text: &str) -> bool {
        if !(msg.starts_with("The import ") && msg.contains(" cannot be resolved")) {
            return false;
        }
        let Some(src) = text.lines().nth(line.saturating_sub(1) as usize) else {
            return false;
        };
        let Some(cap) = self.import.captures(src) else {
            return false; // 通配或读不出：不抑制
        };
        let simple = cap[1].rsplit('.').next().unwrap_or("");
        if simple.is_empty() {
            return false;
        }
        let no_block = self.block.replace_all(text, " ");
        let no_comment = self.line.replace_all(&no_block, " ");
        let body = no_comment
            .lines()
            .filter(|l| !l.trim_start().starts_with("import "))
            .collect::<Vec<_>>()
            .join("\n");
        let word = Regex::new(&format!(r"\b{}\b", regex::escape(simple))).unwrap();
        !word.is_match(&body)
    }
}

fn read_text(p: &Path) -> String {
    let b = std::fs::read(p).unwrap_or_default();
    match String::from_utf8(b.clone()) {
        Ok(s) => s,
        Err(_) => b.iter().map(|&c| c as char).collect(),
    }
}

fn modules_of(root: &Path, cp: &ProjectCp) -> Vec<String> {
    let wanted: Option<BTreeSet<String>> = std::env::var("PARITY_MODULES")
        .ok()
        .map(|s| s.split(',').map(|m| m.trim().to_string()).collect());
    let mut out: BTreeSet<String> = BTreeSet::new();
    for s in &cp.srcs {
        let Some(first) = s.path.components().next() else {
            continue;
        };
        let name = first.as_os_str().to_string_lossy().into_owned();
        if root.join(&name).is_dir() {
            out.insert(name);
        }
    }
    out.into_iter()
        .filter(|m| wanted.as_ref().is_none_or(|w| w.contains(m)))
        .collect()
}

fn baseline_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("eclipse_parity_baseline.txt")
}

fn read_baseline() -> BTreeSet<(String, String)> {
    std::fs::read_to_string(baseline_path())
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter_map(|l| {
            let mut it = l.split('\t');
            let (k, p) = (it.next()?, it.next()?);
            Some((k.trim().to_string(), p.trim().to_lowercase()))
        })
        .collect()
}

#[test]
#[ignore = "要本机 NC 安装目录和 Eclipse 工作区（全量约 8 分钟）"]
fn 整模块编译与_eclipse_产物一致() {
    let root = env_path("PARITY_ROOT", r"C:\work\aier\newar");
    let home = env_path("NC_HOME", r"D:\ncc\1909home");
    let java = home.join("ufjdk").join("bin").join("java.exe");
    let ecj = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("ecj")
        .join("ecj-3.17.jar");
    if !root.join(".classpath").is_file() || !java.is_file() || !ecj.is_file() {
        eprintln!(
            "跳过：缺 {} / {} / {}",
            root.display(),
            java.display(),
            ecj.display()
        );
        return;
    }
    let cp = ProjectCp::load(&root).expect("读 .classpath");
    let modules = modules_of(&root, &cp);
    assert!(!modules.is_empty(), "没有可比对的模块");

    // 类索引缓存与各模块工作目录落在仓库 target/ 下：既不会在 %TEMP% 堆积
    // （全量跑一次几百 MB），也避开 macOS /var→/private/var 与 Windows 8.3 短名的路径不一致。
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join("test-tmp")
        .join("parity");
    std::fs::create_dir_all(&base).unwrap();
    let cache = base.join("class-index.tsv");
    let index = ClassIndex::load_or_build(classpath_jars(&home), Some(&cache), None);
    let tools = Tools::new();
    let cancel = AtomicBool::new(false);

    // (类型, 相对路径) -> 说明
    let mut found: BTreeMap<(String, String), String> = BTreeMap::new();
    let mut totals = (0usize, 0usize, 0usize); // 文件、可比对、我们的报错数
    for module in &modules {
        let layout = ModuleLayout::resolve(&root, module);
        let files = layout.collect_sources();
        if files.is_empty() {
            continue;
        }
        let work = base.join(format!("{module}-{}", std::process::id()));
        std::fs::create_dir_all(&work).unwrap();
        let env = CompileEnv {
            nc_home: &home,
            java_exe: &java,
            ecj_jar: &ecj,
            worker_jar: None,
            project_root: &root,
            index: &index,
            work_dir: &work,
            cancel: Some(&cancel),
            overrides: &[],
        };
        let job = CompileJob {
            module: module.clone(),
            files: None,
            out_dir: work.join("out"),
            source_roots: Some(layout.source_roots.clone()),
            output_map: Vec::new(),
            seed_jars: Vec::new(),
            fast: false,
        };
        let started = std::time::Instant::now();
        let result = compile(&env, &job, &|_| {});
        let _ = std::fs::remove_dir_all(&work);
        let r = match result {
            Ok(r) => r,
            Err(e) => {
                found.insert(("ERR".into(), module.to_lowercase()), e);
                continue;
            }
        };
        let mut ours: BTreeMap<String, Vec<(u32, String)>> = BTreeMap::new();
        for p in r.problems.iter().filter(|p| p.severity == "error") {
            ours.entry(key(Path::new(&p.file)))
                .or_default()
                .push((p.line, p.message.clone()));
        }
        totals.2 += r.error_count;
        let mut compared = 0;
        for f in &files {
            totals.0 += 1;
            let text = read_text(f);
            let Ok(ecl) = eclipse_markers(&cp, &root, f, &text) else {
                continue;
            };
            compared += 1;
            let mine: Vec<String> = ours
                .get(&key(f))
                .map(|v| {
                    v.iter()
                        .filter(|(ln, m)| !tools.unused_import(m, *ln, &text))
                        .map(|(_, m)| m.clone())
                        .collect()
                })
                .unwrap_or_default();
            let rel = key(f.strip_prefix(&root).unwrap_or(f));
            let ecl_all: BTreeSet<String> = ecl.iter().filter_map(|m| symbol_of(m)).collect();
            let mine_all: BTreeSet<String> = mine.iter().filter_map(|m| symbol_of(m)).collect();
            if !mine_all.is_empty() && ecl.is_empty() {
                found.insert(("FP".into(), rel), join(&mine_all));
            } else if !ecl_all.is_empty() && mine.is_empty() {
                found.insert(("MISS".into(), rel), join(&ecl_all));
            } else if !ecl.is_empty() && !mine.is_empty() {
                // 两边都有错：只比非 import 的缺失符号
                let non_import = |v: &[String]| -> BTreeSet<String> {
                    v.iter()
                        .filter(|m| !m.starts_with("The import "))
                        .filter_map(|m| symbol_of(m))
                        .collect()
                };
                let (so, se) = (non_import(&mine), non_import(&ecl));
                let (a, b) = (minus(&so, &se), minus(&se, &so));
                if !a.is_empty() || !b.is_empty() {
                    found.insert(
                        ("DIFF".into(), rel),
                        format!("仅我们={} 仅Eclipse={}", a.join(","), b.join(",")),
                    );
                }
            }
        }
        totals.1 += compared;
        println!(
            "{module}: 文件 {} 可比对 {compared} 我们报错 {}  {:.0}s",
            files.len(),
            r.error_count,
            started.elapsed().as_secs_f32()
        );
    }
    println!(
        "合计：源文件 {} 可比对 {} 我们报错 {}；差异 {} 条",
        totals.0,
        totals.1,
        totals.2,
        found.len()
    );
    for ((k, p), d) in &found {
        println!("  {k}\t{p}\t{d}");
    }

    if std::env::var_os("PARITY_WRITE_BASELINE").is_some() {
        let mut s = String::from(
            "# 类型<TAB>相对路径（小写、正斜杠）。表示「已解释、允许存在的差异」，说明写在下面的注释里。\n",
        );
        for ((k, p), d) in &found {
            s.push_str(&format!("{k}\t{p}\t# {d}\n"));
        }
        std::fs::create_dir_all(baseline_path().parent().unwrap()).unwrap();
        std::fs::write(baseline_path(), s).unwrap();
        println!("已写基线：{}", baseline_path().display());
        return;
    }

    let base = read_baseline();
    let fresh: Vec<String> = found
        .iter()
        .filter(|((k, p), _)| !base.contains(&(k.clone(), p.clone())))
        .map(|((k, p), d)| format!("{k} {p} :: {d}"))
        .collect();
    let gone: Vec<String> = base
        .iter()
        .filter(|(k, p)| {
            !found.contains_key(&(k.clone(), p.clone()))
                && modules
                    .iter()
                    .any(|m| p.starts_with(&format!("{}/", m.to_lowercase())))
        })
        .map(|(k, p)| format!("{k} {p}"))
        .collect();
    if !gone.is_empty() {
        println!(
            "白名单里已不再出现的差异（可以从基线里删）：\n  {}",
            gone.join("\n  ")
        );
    }
    assert!(
        fresh.is_empty(),
        "出现了白名单之外的和 Eclipse 不一致（{} 条）：\n  {}\n确认是合理差异后用 PARITY_WRITE_BASELINE=1 刷新基线",
        fresh.len(),
        fresh.join("\n  ")
    );
}

fn join(s: &BTreeSet<String>) -> String {
    s.iter().cloned().collect::<Vec<_>>().join(",")
}

/// 简单名相同、包不同 = 两个不同的缺失物，对账不能判一致（否则真实 FP/MISS/DIFF 被静默放过）。
/// 纯逻辑，不依赖 NC home，普通 `cargo test` 就该跑。
#[test]
fn 同名不同包不算同一个缺失物() {
    assert!(!same("nc.vo.Foo", "other.Foo"));
    assert!(!same("nc.vo.Foo", "nc.itf.Foo"));
    assert!(!same("nc.vo.Foo", "nc.vo.FooBar"));
    // 「不同粒度」的原意要保留：包前缀、全名与简单名
    assert!(same("nc.vo.pim", "nc.vo.pim.x"));
    assert!(same("nc.vo.pim.x", "nc.vo.pim"));
    assert!(same("nc.vo.Foo", "nc.vo.Foo"));
    assert!(same("Foo", "nc.vo.Foo"));
    assert!(same("nc.vo.Foo", "Foo"));
    assert!(same("nc.vo.Foo", "nc.vo.sub.Foo"));
    // 差集口径：两边各有一个同名不同包的缺失物，两条都得留下来
    let ours: BTreeSet<String> = ["nc.vo.Foo".to_string()].into_iter().collect();
    let ecl: BTreeSet<String> = ["other.Foo".to_string()].into_iter().collect();
    assert_eq!(minus(&ours, &ecl), vec!["nc.vo.Foo".to_string()]);
    assert_eq!(minus(&ecl, &ours), vec!["other.Foo".to_string()]);
}
