//! 补丁出包 —— 扫产品根、判层、校验配对、打 zip。
//!
//! 规则本体在 `patch_view.rs`（纯逻辑），这里只做 IO。与 `build-nc-patch.sh` 的差异
//! 只有三处，且都是「比脚本更不容易出错」的方向：
//!
//! 1. **产物根逐文件探测**：脚本先定一个 `<根>/out` 全局用。实测这台机器上 Eclipse 编译到
//!    `<根>/out`，而工作台的 M3 编译写到 `<模块>/classes`，两边会同时存在新旧两套 class。
//!    这里对每个文件按 `配置根 → <根>/out → <根>/<模块>/classes` 依次找，谁先有就用谁，
//!    并把「这个文件实际用的哪个根」回报给界面——混着用时用户能看出来。
//! 2. **方法名取完整签名**：脚本靠 `diff -F` 的 hunk 头，hunk 头有长度上限会截断
//!    （真实包里出现过 `private String getFirstRowMaterial(SaleO` 这种半截）。
//! 3. **不落 stage 目录**：直接从源文件读进 zip，CHANGES.md 在内存里生成。少一次全量复制，
//!    也少一处「临时目录没删干净」。
//!
//! 保持一致的：目录结构、`.java` 与 `.class` 并排、`CHANGES.md` 放 zip 根、SQL 放 zip 根、
//! 覆盖前先备份、`<描述>_<年月日>.zip` 命名。

use std::collections::{BTreeSet, HashMap};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::patch_view as pv;

// ───────────────────────────── 配置与结果 ─────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildOptions {
    /// 工作副本根（`.../newar`）。
    pub root: String,
    /// 用户显式指定的产物根（配置里存的那个）。
    #[serde(default)]
    pub out_root: Option<String>,
    /// NC home，判 hyext 层与 hotwebs 用。
    #[serde(default)]
    pub nc_home: Option<String>,
    /// jar 条目索引缓存文件（放在配置目录下，别丢进工作副本）。
    pub cache_file: String,
    /// 强制放 hyext 的文件（绝对路径）。
    #[serde(default)]
    pub force_hyext: Vec<String>,
    /// 强制不放 hyext。
    #[serde(default)]
    pub force_std: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassFile {
    pub name: String,
    pub path: String,
    /// 相对 java 文件更新？false = 打进去的可能是旧行为。
    pub fresh: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerInfo {
    pub hyext: bool,
    /// 判定依据，直接显示给人看：`hyext（默认模块 ic,不查 jar）`。
    pub why: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Problem {
    /// `error` 会阻止出包；`warn` 只提示。
    pub level: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchItem {
    pub path: String,
    pub rel: String,
    /// 展示用：`ic/private/nc/bs/X.java`。
    pub label: String,
    pub module: String,
    pub section: pv::Section,
    pub pkg_rel: String,
    /// zip 内目录（不含文件名）。
    pub target: String,
    pub layer: Option<LayerInfo>,
    pub classes: Vec<ClassFile>,
    pub problems: Vec<Problem>,
    /// 有 error 的项不允许勾选。
    pub blocked: bool,
    /// 实际用的产物根（relativize 到 root 便于显示）。
    pub out_root_used: Option<String>,
}

impl PatchItem {
    fn has_error(&self) -> bool {
        self.problems.iter().any(|p| p.level == "error")
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    /// 解析出来的源码根（应当唯一）。
    pub root: String,
    pub items: Vec<PatchItem>,
    /// 整批级别的问题（多源码根、NC home 缺失…）。
    pub problems: Vec<Problem>,
    /// 这次用到的产物根，按出现顺序。
    pub out_roots: Vec<String>,
    pub java_count: usize,
    pub class_count: usize,
    pub blocked_count: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildRequest {
    pub options: BuildOptions,
    /// 勾选的文件绝对路径。
    pub files: Vec<String>,
    pub out_dir: String,
    /// 改动内容描述，用于文件名。
    pub desc: String,
    /// 用户手写的功能说明（原样放 CHANGES.md 最前）。
    #[serde(default)]
    pub note: String,
    /// 挂到 zip 根的 SQL 文件。
    #[serde(default)]
    pub sqls: Vec<String>,
    /// `YYYYMMDD`，前端按本地时间给；格式不对就回落到 UTC 当天。
    #[serde(default)]
    pub date: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildResult {
    pub zip_path: String,
    pub entries: usize,
    pub java_count: usize,
    pub class_count: usize,
    /// 覆盖旧包时的备份路径。
    pub backup: Option<String>,
    /// 生成过程中值得说的提示（upm 需比对生产、SQL 文件名非 ASCII…）。
    pub notes: Vec<String>,
}

// ───────────────────────────── 产物根探测 ─────────────────────────────

/// 按顺序找 `<cand>/<模块>/<包目录>/<类名>.class`，返回第一个命中的 (根, 文件)。
///
/// 不用 `find`：脚本注释里写得很清楚，全盘 find 时快时慢（12s~超时），不可靠。
fn find_class(
    cands: &[PathBuf],
    module: &str,
    pkg_dir: &str,
    stem: &str,
) -> Option<(PathBuf, PathBuf)> {
    for cand in cands {
        let rel = if pkg_dir.is_empty() {
            format!("{module}/{stem}.class")
        } else {
            format!("{module}/{pkg_dir}/{stem}.class")
        };
        let p = cand.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        if p.is_file() {
            return Some((cand.clone(), p));
        }
    }
    None
}

/// 候选产物根：用户配置 → `<根>/out` → 该模块自己的 `<模块>/classes`（M3 的落点）。
fn out_root_candidates(root: &Path, module: &str, configured: Option<&Path>) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = Vec::new();
    if let Some(c) = configured {
        v.push(c.to_path_buf());
    }
    v.push(root.join("out"));
    v.push(root.join(module).join("classes"));
    let mut seen = BTreeSet::new();
    v.retain(|p| seen.insert(p.clone()));
    v
}

/// 内部类：`Foo$1.class`、`Foo$EntInfoCache.class`。按前缀扫目录比 glob 可靠。
fn sibling_classes(dir: &Path, stem: &str, java_ms: u64) -> Vec<ClassFile> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !name.starts_with(stem) || !name.ends_with(".class") {
            continue;
        }
        let rest = &name[stem.len()..];
        // 只要 `Foo.class` 或 `Foo$Xxx.class`，不要把 `Foobar.class` 当成内部类
        if !(rest == ".class" || rest.starts_with('$')) {
            continue;
        }
        let ms = mtime_ms(&e.path());
        out.push(ClassFile {
            name,
            path: e.path().display().to_string(),
            fresh: ms >= java_ms,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn mtime_ms(p: &Path) -> u64 {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ───────────────────────────── hyext jar 索引 ─────────────────────────────

/// jar 内容索引：`<jar>\t<mtime:size>\t<条目>`，末尾 `#` 表示这个 jar 扫完了。
///
/// 与脚本的 `.jar-index.tsv` 同格式（人可读、出问题能直接看）。只索引 hyext 目录下的
/// jar——标准目录有几百个，而且「命中标准 jar」不改变层，查了也白查。
#[derive(Default)]
pub struct JarIndex {
    /// jar 绝对路径 → (签名, 类条目)
    map: HashMap<String, (String, Vec<String>)>,
    dirty: bool,
}

impl JarIndex {
    pub fn load(path: &Path) -> Self {
        let mut me = Self::default();
        let Ok(text) = std::fs::read_to_string(path) else {
            return me;
        };
        for line in text.lines() {
            let mut it = line.split('\t');
            let (Some(jar), Some(sig), Some(entry)) = (it.next(), it.next(), it.next()) else {
                continue;
            };
            let e = me
                .map
                .entry(jar.to_string())
                .or_insert_with(|| (sig.to_string(), Vec::new()));
            if entry != "#" {
                e.1.push(entry.to_string());
            }
        }
        me
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let mut s = String::new();
        for (jar, (sig, entries)) in &self.map {
            for e in entries {
                s.push_str(&format!("{jar}\t{sig}\t{e}\n"));
            }
            s.push_str(&format!("{jar}\t{sig}\t#\n"));
        }
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        std::fs::write(path, s)
    }

    fn sig_of(jar: &Path) -> String {
        let md = std::fs::metadata(jar).ok();
        let size = md.as_ref().map(|m| m.len()).unwrap_or(0);
        let ms = md
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        format!("{ms}:{size}")
    }

    /// 扫一个 jar 的 `.class` 条目。jar 坏了就当空，不让它阻断出包。
    fn index_jar(&mut self, jar: &Path) {
        let key = jar.display().to_string();
        let sig = Self::sig_of(jar);
        if let Some((old, _)) = self.map.get(&key) {
            if old == &sig {
                return;
            }
        }
        let mut entries = Vec::new();
        if let Ok(f) = std::fs::File::open(jar) {
            if let Ok(mut z) = zip::ZipArchive::new(f) {
                for i in 0..z.len() {
                    if let Ok(name) = z.by_index_raw(i).map(|e| e.name().to_string()) {
                        if name.ends_with(".class") {
                            entries.push(name);
                        }
                    }
                }
            }
        }
        self.dirty = true;
        self.map.insert(key, (sig, entries));
    }

    /// 在目录下的所有 jar 里找条目，返回命中的 jar。
    fn find(&mut self, dir: &Path, entry: &str) -> Option<PathBuf> {
        let Ok(rd) = std::fs::read_dir(dir) else {
            return None;
        };
        let mut jars: Vec<PathBuf> = rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.extension()
                    .map(|e| e.eq_ignore_ascii_case("jar"))
                    .unwrap_or(false)
            })
            .collect();
        jars.sort();
        for jar in jars {
            self.index_jar(&jar);
            if let Some((_, entries)) = self.map.get(&jar.display().to_string()) {
                if entries.iter().any(|e| e == entry) {
                    return Some(jar);
                }
            }
        }
        None
    }
}

/// 脚本的三层 hyext 目录：`hyext/lib→hyext/classes`、`META-INF/hyext/lib→…/classes`、
/// `client/hyext/lib→…/classes`。
const HY_DIRS: [&str; 3] = [
    "hyext/lib:public",
    "META-INF/hyext/lib:private",
    "client/hyext/lib:client",
];

fn locate_layer(
    module: &str,
    section: pv::Section,
    pkg_rel: &str,
    nc_home: Option<&Path>,
    index: &mut JarIndex,
    forced: Option<bool>,
) -> Result<LayerInfo, Problem> {
    if !section.needs_class() {
        return Ok(LayerInfo {
            hyext: false,
            why: String::new(),
        });
    }
    if let Some(hy) = forced {
        return Ok(LayerInfo {
            hyext: hy,
            why: if hy {
                "hyext（手动指定）".to_string()
            } else {
                "标准层（手动指定）".to_string()
            },
        });
    }
    if pv::is_default_hyext(module) {
        return Ok(LayerInfo {
            hyext: true,
            why: format!("hyext（默认模块 {module},不查 jar）"),
        });
    }
    let Some(home) = nc_home else {
        return Err(Problem {
            level: "error".to_string(),
            text: format!(
                "模块 {module} 不是默认 hyext 模块，需要 NC home 才能判定层；\
                 可在设置里指定 NC home，或手动选层"
            ),
        });
    };
    let mod_dir = home.join("modules").join(module);
    if !mod_dir.is_dir() {
        return Err(Problem {
            level: "error".to_string(),
            text: format!("NC home 下没有模块 {module}：{}", mod_dir.display()),
        });
    }
    let entry = pv::class_entry(pkg_rel).unwrap_or_else(|| pkg_rel.to_string());
    for item in HY_DIRS {
        let (d, seg) = item.split_once(':').unwrap_or((item, ""));
        // 跨段命中要请用户核对：脚本在「段不一致却命中」时会警告，Rust 侧以前把
        // 段丢掉了（绑成 `_sec` 没人用），层判跨段时界面一声不吭。
        let cross = !seg.is_empty() && seg != section.as_str();
        // 同层散类目录：以前的补丁装进来的类是散文件，不在 jar 里
        let loose_dir = mod_dir.join(d.replace("/lib", "/classes"));
        if loose_dir
            .join(entry.replace('/', std::path::MAIN_SEPARATOR_STR))
            .is_file()
        {
            return Ok(LayerInfo {
                hyext: true,
                why: cross_note(&format!("hyext（同层散类 {d}）"), cross, section),
            });
        }
        let dir = mod_dir.join(d);
        if !dir.is_dir() {
            continue;
        }
        if let Some(jar) = index.find(&dir, &entry) {
            let shown = jar.strip_prefix(home).unwrap_or(&jar).display().to_string();
            return Ok(LayerInfo {
                hyext: true,
                why: cross_note(&format!("hyext（命中 {shown}）"), cross, section),
            });
        }
    }
    Ok(LayerInfo {
        hyext: false,
        why: "标准层（hyext jar 里没有同名类）".to_string(),
    })
}

/// 跨段命中时在 why 末尾追一句「请核对」。
///
/// 「本项是 private 段、命中的却是 public 的 hyext 目录」不是错误——补丁照样落位，
/// 但它往往意味着「这个类的实际部署与源码段不一致」，正是用户要盯确认的那句话。
fn cross_note(why: &str, cross: bool, section: pv::Section) -> String {
    if cross {
        format!("{why}；跨段命中：本项是 {} 段，请核对", section.as_str())
    } else {
        why.to_string()
    }
}

// ───────────────────────────── 扫描 ─────────────────────────────

/// 把一批文件解析成补丁清单。勾选状态不在这里（界面自己管）。
pub fn scan(options: &BuildOptions, files: &[String]) -> Result<ScanResult, String> {
    let root = PathBuf::from(&options.root);
    if !root.is_dir() {
        return Err(format!("工作副本根不存在：{}", root.display()));
    }
    let nc_home = options.nc_home.as_ref().map(PathBuf::from);
    let configured_out = options.out_root.as_ref().map(PathBuf::from);
    let mut index = JarIndex::load(Path::new(&options.cache_file));

    let force_hy: std::collections::HashSet<String> =
        options.force_hyext.iter().map(|s| pv::norm(s)).collect();
    let force_std: std::collections::HashSet<String> =
        options.force_std.iter().map(|s| pv::norm(s)).collect();

    let mut items = Vec::new();
    let mut global = Vec::new();
    let mut roots: BTreeSet<String> = BTreeSet::new();
    let mut out_roots: BTreeSet<String> = BTreeSet::new();

    for raw in files {
        let norm = pv::norm(raw);
        let path = PathBuf::from(&norm);
        // 用相对路径展示，绝对路径只在 invokes 里用
        let rel = path
            .strip_prefix(&root)
            .map(|p| pv::norm(&p.display().to_string()))
            .unwrap_or_else(|_| norm.clone());

        let parsed = match pv::parse_path(&norm) {
            Ok(p) => p,
            Err(e) => {
                items.push(PatchItem {
                    path: norm.clone(),
                    rel: rel.clone(),
                    label: rel,
                    module: String::new(),
                    section: pv::Section::Public,
                    pkg_rel: String::new(),
                    target: String::new(),
                    layer: None,
                    classes: Vec::new(),
                    problems: vec![Problem {
                        level: "error".to_string(),
                        text: e.message(),
                    }],
                    blocked: true,
                    out_root_used: None,
                });
                continue;
            }
        };
        if !parsed.root.as_os_str().is_empty() {
            roots.insert(pv::norm(&parsed.root.display().to_string()));
        }

        let label = match parsed.section {
            pv::Section::Upm => format!("{}/META-INF/{}", parsed.module, parsed.pkg_rel),
            pv::Section::Hotwebs => format!("hotwebs/{}", parsed.pkg_rel),
            s => format!("{}/{}/{}", parsed.module, s.as_str(), parsed.pkg_rel),
        };

        let mut problems: Vec<Problem> = Vec::new();
        let mut classes: Vec<ClassFile> = Vec::new();
        let mut out_root_used: Option<String> = None;

        if !path.is_file() {
            problems.push(Problem {
                level: "error".to_string(),
                text: "文件不存在（已删除的文件不能打进补丁；删类要改 .upm 的组件声明）"
                    .to_string(),
            });
        }

        let forced = if force_hy.contains(&norm) {
            Some(true)
        } else if force_std.contains(&norm) {
            Some(false)
        } else {
            None
        };

        let layer = match locate_layer(
            &parsed.module,
            parsed.section,
            &parsed.pkg_rel,
            nc_home.as_deref(),
            &mut index,
            forced,
        ) {
            Ok(l) => Some(l),
            Err(p) => {
                problems.push(p);
                None
            }
        };
        let hyext = layer.as_ref().map(|l| l.hyext).unwrap_or(false);
        let pkg_dir = pv::pkg_dir_of(&parsed.pkg_rel);
        let target = pv::target_dir(&parsed.module, parsed.section, hyext, &pkg_dir);

        // 源码段里的 **.java** 必须有编译产物，且不能比 java 旧（否则打进去的是旧行为）。
        //
        // 只对 .java 要求 class：src/public 下面还有 .xml / .properties / .js 这类资源文件，
        // 它们按脚本规则「只搬文件本身」（下面的写 zip 部分一律写 `target/pkg_rel`），
        // 以前这里不区分扩展名，资源文件被当成类去要 .class，整个包直接阻断。
        let is_java = parsed.pkg_rel.ends_with(".java");
        if parsed.section.needs_class() && is_java && path.is_file() {
            let stem = pv::stem_of(&parsed.pkg_rel);
            let cands = out_root_candidates(&root, &parsed.module, configured_out.as_deref());
            match find_class(&cands, &parsed.module, &pkg_dir, &stem) {
                Some((used, class_path)) => {
                    let java_ms = mtime_ms(&path);
                    let dir = class_path.parent().unwrap_or(&used).to_path_buf();
                    classes = sibling_classes(&dir, &stem, java_ms);
                    if classes.iter().any(|c| !c.fresh) {
                        problems.push(Problem {
                            level: "error".to_string(),
                            text: format!(
                                "{stem}.class 比 .java 旧 —— 源码改了没重新编译。\
                                 重新编译后再出包，否则打进去的是旧行为"
                            ),
                        });
                    }
                    let shown = used
                        .strip_prefix(&root)
                        .unwrap_or(&used)
                        .display()
                        .to_string();
                    out_roots.insert(shown.clone());
                    out_root_used = Some(shown);
                }
                None => {
                    let tried = cands
                        .iter()
                        .map(|c| c.display().to_string())
                        .collect::<Vec<_>>()
                        .join("、");
                    problems.push(Problem {
                        level: "error".to_string(),
                        text: format!("找不到 {stem}.class，已找过：{tried}。先在 IDE 里编译"),
                    });
                }
            }
        }

        if parsed.section == pv::Section::Upm {
            global.push(Problem {
                level: "warn".to_string(),
                text: format!(
                    "{} 是整文件替换：上线前与生产环境的同名 upm 比对，装完重启中间件",
                    label
                ),
            });
        }

        let blocked = problems.iter().any(|p| p.level == "error");
        items.push(PatchItem {
            path: norm,
            rel,
            label,
            module: parsed.module,
            section: parsed.section,
            pkg_rel: parsed.pkg_rel,
            target,
            layer,
            classes,
            problems,
            blocked,
            out_root_used,
        });
    }

    index.dirty.then(|| {
        let _ = index.save(Path::new(&options.cache_file));
    });

    if roots.len() > 1 {
        global.push(Problem {
            level: "error".to_string(),
            text: format!(
                "文件来自多个源码根，疑似混了不同工程：{}",
                roots.iter().cloned().collect::<Vec<_>>().join("、")
            ),
        });
    }

    // 「N java」只数真 java：源码段里的 .xml/.properties 不算（见上面 is_java 的注释）
    let java_count = items
        .iter()
        .filter(|i| i.section.needs_class() && i.pkg_rel.ends_with(".java"))
        .count();
    let class_count = items.iter().map(|i| i.classes.len()).sum();
    let blocked_count = items.iter().filter(|i| i.has_error()).count();

    Ok(ScanResult {
        root: pv::norm(&root.display().to_string()),
        items,
        problems: global,
        out_roots: out_roots.into_iter().collect(),
        java_count,
        class_count,
        blocked_count,
    })
}

// ───────────────────────────── 出包 ─────────────────────────────

/// `YYYYMMDD` 校验；不合法返回 None。
fn normalize_date(d: Option<&str>) -> Option<String> {
    let d = d?.trim();
    if d.len() == 8 && d.chars().all(|c| c.is_ascii_digit()) {
        return Some(d.to_string());
    }
    None
}

/// UTC 当天（本机时区拿不到时兜底；正常路径是前端把本地日期传进来）。
fn utc_today() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86_400) as i64;
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}{m:02}{d:02}")
}

/// 日期 → 1970-01-01 起的天数（与 `civil_from_days` 互逆，只用于单测往返校验）。
#[cfg(test)]
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let mp = if m > 2 { m - 3 } else { m + 9 } as u64;
    let doy = (153 * mp + 2) / 5 + d as u64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe as i64 - 719_468
}

/// Howard Hinnant 的 civil_from_days：不引入时区库也能把天数换成日期。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// SVN 基线与工作副本内容（字节）。基座缺失返回 None。
fn svn_base(path: &Path) -> Option<Vec<u8>> {
    let dir = path.parent()?;
    let name = path.file_name()?.to_string_lossy().to_string();
    let base = dir
        .join(".svn")
        .join("text-base")
        .join(format!("{name}.svn-base"));
    std::fs::read(base).ok()
}

fn read_bytes(p: &Path) -> Result<Vec<u8>, String> {
    let mut f = std::fs::File::open(p).map_err(|e| format!("读不到 {}：{e}", p.display()))?;
    let mut v = Vec::new();
    f.read_to_end(&mut v)
        .map_err(|e| format!("读不到 {}：{e}", p.display()))?;
    Ok(v)
}

/// 备份已有的同名包：`<zip>.bak-<yyyymmddHHMMSS>`（与脚本的 `date +%Y%m%d%H%M%S` 同名格式）。
fn backup_existing(zip: &Path) -> Option<String> {
    if !zip.is_file() {
        return None;
    }
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (y, m, d) = civil_from_days(days);
    let stamp = format!(
        "{y:04}{m:02}{d:02}{:02}{:02}{:02}",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    );
    let bak = zip.with_file_name(format!(
        "{}.bak-{stamp}",
        zip.file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default()
    ));
    std::fs::copy(zip, &bak)
        .ok()
        .map(|_| bak.display().to_string())
}

/// 出包。会先重新扫一遍，保证「清单看到的」与「打进包的」是同一份。
pub fn build(req: &BuildRequest) -> Result<BuildResult, String> {
    if req.files.is_empty() {
        return Err("没有勾选任何文件".to_string());
    }
    let date = normalize_date(req.date.as_deref()).unwrap_or_else(utc_today);
    let scan = scan(&req.options, &req.files)?;

    if scan.problems.iter().any(|p| p.level == "error") {
        return Err(scan
            .problems
            .iter()
            .filter(|p| p.level == "error")
            .map(|p| p.text.clone())
            .collect::<Vec<_>>()
            .join("；"));
    }
    let blocked: Vec<&PatchItem> = scan.items.iter().filter(|i| i.blocked).collect();
    if !blocked.is_empty() {
        return Err(format!(
            "有 {} 个文件不能打进包：{}",
            blocked.len(),
            blocked
                .iter()
                .map(|i| format!(
                    "{}（{}）",
                    i.rel,
                    i.problems
                        .iter()
                        .map(|p| p.text.as_str())
                        .collect::<Vec<_>>()
                        .join("、")
                ))
                .collect::<Vec<_>>()
                .join("；")
        ));
    }

    let out_dir = PathBuf::from(&req.out_dir);
    if !out_dir.is_dir() {
        std::fs::create_dir_all(&out_dir)
            .map_err(|e| format!("建不了输出目录 {}：{e}", out_dir.display()))?;
    }
    let zip_path = out_dir.join(pv::zip_file_name(&req.desc, &date));

    // 所有校验都在「备份旧包 / 动磁盘」之前做完。
    //
    // 以前是先 backup_existing 再查 SQL：SQL 路径写错时旧包已经被改名成 .bak、新包
    // 却没生成——输出目录里那个正式包凭空消失了，用户只知道「出包失败」。
    let mut notes: Vec<String> = Vec::new();
    let mut sql_names = Vec::new();
    // SQL 按文件名平铺在 zip 根：两个同名 SQL 解压时互相覆盖（只剩一个），
    // 叫 CHANGES.md 的 SQL 会把自动生成的变更说明顶掉。都在动磁盘前拦下来。
    let mut sql_by_name: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    for s in &req.sqls {
        let p = Path::new(s);
        if !p.is_file() {
            return Err(format!("SQL 文件不存在：{s}"));
        }
        let name = p
            .file_name()
            .map(|x| x.to_string_lossy().to_string())
            .unwrap_or_default();
        if !name.is_ascii() {
            notes.push(format!(
                "SQL 文件名含非 ASCII（{name}），在 GBK 中间件服务器上解压时可能乱码，建议改英文名"
            ));
        }
        if name == "CHANGES.md" {
            return Err(format!(
                "SQL 不能叫 CHANGES.md（{s}）：zip 根的变更说明也是这个名字，解压时会被这个 SQL 顶掉"
            ));
        }
        if let Some(prev) = sql_by_name.insert(name.clone(), s.clone()) {
            return Err(format!(
                "SQL 文件重名（{name}）：{prev} 与 {s} 平铺在 zip 根会互相覆盖，解压只剩一个。请改个文件名再出包"
            ));
        }
        sql_names.push(name);
    }

    // CHANGES.md 先拼好，再连同文件一起写进 zip。
    // 这里读不到就直接失败（`?`）：留到写 zip 中途才失败，等于已备份 + 半截包。
    let mut md_entries: Vec<pv::MdEntry> = Vec::new();
    for item in &scan.items {
        let working = read_bytes(Path::new(&item.path))?;
        let base = svn_base(Path::new(&item.path));
        let kind = match item.section {
            pv::Section::Upm => pv::MdKind::Upm,
            pv::Section::Hotwebs => pv::MdKind::Hotwebs,
            _ => pv::MdKind::Source,
        };
        md_entries.push(pv::MdEntry {
            label: item.label.clone(),
            kind,
            layer_note: item
                .layer
                .as_ref()
                .map(|l| l.why.clone())
                .filter(|s| !s.is_empty()),
            base,
            working,
        });
    }
    let iso_date = format!("{}-{}-{}", &date[0..4], &date[4..6], &date[6..8]);
    let md = pv::build_changes_md(&req.note, &iso_date, &md_entries, &sql_names);

    // 校验全过了才备份旧包
    let backup = backup_existing(&zip_path);

    // 写 zip：中途任何一步失败都要把半截文件删掉——残缺的 zip 留在输出目录里，
    // 售后会当真包拿去上线。
    let (entries, class_count) = match write_package(&zip_path, &scan.items, &md, &req.sqls) {
        Ok(v) => v,
        Err(e) => {
            let _ = std::fs::remove_file(&zip_path);
            return Err(e);
        }
    };

    Ok(BuildResult {
        zip_path: zip_path.display().to_string(),
        entries,
        java_count: scan.java_count,
        class_count,
        backup,
        notes,
    })
}

/// 写 zip 本体：返回（条目数，编译产物数）。失败时不负责清理半截文件（见调用方）。
fn write_package(
    zip_path: &Path,
    items: &[PatchItem],
    md: &str,
    sqls: &[String],
) -> Result<(usize, usize), String> {
    let file = std::fs::File::create(zip_path).map_err(|e| format!("建不了补丁包：{e}"))?;
    let mut zw = zip::ZipWriter::new(std::io::BufWriter::new(file));
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644);

    // 目录条目：`zip -r` 会带上，保持与历史包一致
    let mut dirs: BTreeSet<String> = BTreeSet::new();
    for item in items {
        let mut acc = String::new();
        for part in item.target.split('/') {
            if !acc.is_empty() {
                acc.push('/');
            }
            acc.push_str(part);
            dirs.insert(acc.clone());
        }
    }
    let mut entries = 0usize;
    for d in &dirs {
        zw.add_directory(format!("{d}/"), opts)
            .map_err(|e| format!("写 zip 目录失败：{e}"))?;
        entries += 1;
    }

    let write = |zw: &mut zip::ZipWriter<std::io::BufWriter<std::fs::File>>,
                 name: &str,
                 data: &[u8]|
     -> Result<(), String> {
        zw.start_file(name.to_string(), opts)
            .map_err(|e| format!("写 zip 失败（{name}）：{e}"))?;
        zw.write_all(data)
            .map_err(|e| format!("写 zip 失败（{name}）：{e}"))
    };

    // CHANGES.md 放 zip 根
    write(&mut zw, "CHANGES.md", md.as_bytes())?;
    entries += 1;

    let mut class_count = 0usize;
    for item in items {
        let base = item
            .pkg_rel
            .rsplit('/')
            .next()
            .unwrap_or(&item.pkg_rel)
            .to_string();
        let dir = item.target.clone();
        // 源码/资源文件本身
        let bytes = read_bytes(Path::new(&item.path))?;
        write(&mut zw, &format!("{dir}/{base}"), &bytes)?;
        entries += 1;
        // 编译产物与其内部类
        for c in &item.classes {
            let bytes = read_bytes(Path::new(&c.path))?;
            write(&mut zw, &format!("{dir}/{}", c.name), &bytes)?;
            entries += 1;
            class_count += 1;
        }
    }

    for s in sqls {
        let p = Path::new(s);
        let name = p
            .file_name()
            .map(|x| x.to_string_lossy().to_string())
            .unwrap_or_default();
        let bytes = read_bytes(p)?;
        write(&mut zw, &name, &bytes)?;
        entries += 1;
    }

    zw.finish()
        .map_err(|e| format!("收尾 zip 失败：{e}"))?
        .flush()
        .map_err(|e| format!("写盘失败：{e}"))?;

    Ok((entries, class_count))
}

/// 继承 nc-patch 脚本缓存的补丁输出目录。
///
/// `.nc-patch-cache.sh` 里是 bash 的 `%q` 转义（中文会变成 `$'/d/NC\xe6\x8a\x80...'`），
/// 直接 std 读出来是乱码路径。这里只做一件事：认出 `CACHED_PATCH_DIR=` 后面那段，
/// 把 `\nnn` 八进制还原成字节再按 UTF-8 解。解不出来就返回 None，界面让用户自己选。
pub fn read_cached_patch_dir(script_dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(script_dir.join(".nc-patch-cache.sh")).ok()?;
    let line = text
        .lines()
        .find(|l| l.trim_start().starts_with("CACHED_PATCH_DIR="))?;
    let raw = line.split_once('=')?.1.trim();
    let unescaped = unescape_bash(raw);
    // MSYS 风格 `/d/NC技术文档/...` → `D:\NC技术文档\...`
    let bytes = unescaped.as_bytes();
    if bytes.len() > 2 && bytes[0] == b'/' && bytes[1].is_ascii_alphabetic() && bytes[2] == b'/' {
        let drive = (bytes[1] as char).to_ascii_uppercase();
        let rest = String::from_utf8_lossy(&bytes[3..]).replace('/', "\\");
        return Some(format!("{drive}:\\{rest}"));
    }
    Some(unescaped)
}

/// bash `$'...'` 里的转义：`\n` `\t` `\'` `\\` 与 `\nnn`（八进制，UTF-8 中文就靠它）。
fn unescape_bash(s: &str) -> String {
    let inner = s.trim_start_matches("$'").trim_end_matches('\'');
    let b = inner.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'\\' {
            out.push(b[i]);
            i += 1;
            continue;
        }
        i += 1;
        if i >= b.len() {
            out.push(b'\\');
            break;
        }
        match b[i] {
            b'n' => {
                out.push(b'\n');
                i += 1;
            }
            b't' => {
                out.push(b'\t');
                i += 1;
            }
            b'r' => {
                out.push(b'\r');
                i += 1;
            }
            b'\\' => {
                out.push(b'\\');
                i += 1;
            }
            b'\'' => {
                out.push(b'\'');
                i += 1;
            }
            c if (b'0'..=b'7').contains(&c) => {
                let mut v: u32 = 0;
                let mut n = 0;
                while n < 3 && i < b.len() && (b'0'..=b'7').contains(&b[i]) {
                    v = v * 8 + (b[i] - b'0') as u32;
                    i += 1;
                    n += 1;
                }
                out.push(v as u8);
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 日期校验与兜底() {
        assert_eq!(normalize_date(Some("20261028")), Some("20261028".into()));
        assert_eq!(normalize_date(Some("2026-10-28")), None);
        assert_eq!(normalize_date(Some("2026102")), None);
        assert_eq!(normalize_date(None), None);
        assert_eq!(utc_today().len(), 8);
    }

    #[test]
    fn 天数换日期往返() {
        // 1970-01-01
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        // 用往返校验，避免手算天数出错
        for (y, m, d) in [(2026, 10, 28), (2000, 2, 29), (1999, 12, 31)] {
            let days = days_from_civil(y, m, d);
            assert_eq!(civil_from_days(days), (y, m, d), "往返失败：{y}-{m}-{d}");
        }
    }

    #[test]
    fn days_from_civil_与_civil_from_days_互逆() {
        for z in [0i64, 1, 365, 10_000, 20_000] {
            let (y, m, d) = civil_from_days(z);
            assert_eq!(days_from_civil(y, m, d), z);
        }
    }

    #[test]
    fn bash_转义还原中文路径() {
        // Git Bash 的 %q 对中文输出八进制：`/d/NC\xe6\x8a\x80...`
        let raw =
            "$'/d/NC\\346\\212\\200\\346\\234\\257/\\345\\276\\205\\344\\270\\212\\347\\272\\277'";
        assert_eq!(unescape_bash(raw), "/d/NC技术/待上线");
    }

    #[test]
    fn 还原成_windows_盘符路径() {
        let raw = "$'/d/patch/dir'";
        assert_eq!(unescape_bash(raw), "/d/patch/dir");
    }

    #[test]
    fn 候选产物根顺序与去重() {
        let root = Path::new(r"C:\ws\newar");
        let c = out_root_candidates(root, "ic", None);
        assert_eq!(c, vec![root.join("out"), root.join("ic").join("classes")]);
        // 配置根与默认根相同时不重复
        let c = out_root_candidates(root, "ic", Some(&root.join("out")));
        assert_eq!(c.len(), 2);
        let c = out_root_candidates(root, "ic", Some(Path::new(r"D:\other\out")));
        assert_eq!(c.len(), 3);
    }

    #[test]
    fn hyext_跨段命中带请核对_同段不带() {
        // uapbd 不是默认 hyext 模块，必须走 NC home 判层这条路
        let tmp = std::env::temp_dir().join(format!("ncforge-xsec-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let mod_dir = tmp.join("modules").join("uapbd");
        std::fs::create_dir_all(mod_dir.join("hyext/classes/nc/bs")).unwrap();
        std::fs::write(mod_dir.join("hyext/classes/nc/bs/Foo.class"), b"x").unwrap();
        std::fs::create_dir_all(mod_dir.join("META-INF/hyext/classes/nc/bs")).unwrap();
        std::fs::write(mod_dir.join("META-INF/hyext/classes/nc/bs/Bar.class"), b"x").unwrap();
        let mut idx = JarIndex::default();

        // private 段的类，散文件却在 public 的 hyext/classes 下 → 跨段，要提示核对
        let l = locate_layer(
            "uapbd",
            pv::Section::Private,
            "nc/bs/Foo.java",
            Some(&tmp),
            &mut idx,
            None,
        )
        .unwrap();
        assert!(l.hyext);
        assert!(l.why.contains("同层散类"), "{}", l.why);
        assert!(l.why.contains("请核对"), "跨段命中必须提示核对：{}", l.why);

        // 同段（private 的散类目录）不该带请核对
        let l2 = locate_layer(
            "uapbd",
            pv::Section::Private,
            "nc/bs/Bar.java",
            Some(&tmp),
            &mut idx,
            None,
        )
        .unwrap();
        assert!(l2.why.contains("同层散类"), "{}", l2.why);
        assert!(
            !l2.why.contains("请核对"),
            "同段命中不该提示核对：{}",
            l2.why
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn 内部类只认同类名() {
        // 目录里放 Foo.class、Foo$1.class、Foobar.class，只应拿到前两个
        let dir = std::env::temp_dir().join(format!("ncp-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for n in [
            "Foo.class",
            "Foo$1.class",
            "Foo$Inner.class",
            "Foobar.class",
        ] {
            std::fs::write(dir.join(n), b"x").unwrap();
        }
        let got: Vec<String> = sibling_classes(&dir, "Foo", 0)
            .into_iter()
            .map(|c| c.name)
            .collect();
        assert_eq!(got, vec!["Foo$1.class", "Foo$Inner.class", "Foo.class"]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
