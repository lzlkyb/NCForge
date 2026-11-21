//! 实测：影子工程「链几个模块」对 jdt.ls import 耗时与内存的影响（B 方案决策数据）。
//!
//! 为什么要量：`docs/NCForge-代码编辑能力-对标与超越方案-2026-11-15.md` 里的 **152 s**
//! 是**全工作区**口径，而生产只链当前模块（`shadow.rs:357`）。只链一个模块跑多久
//! **从未单独量过** —— 没有这个基线，「链全部 59 个模块会不会太慢」就无法判定。
//!
//! 🔴 两条口径纪律（都来自既有教训，别重犯）：
//! 1. **分段看，不看总耗时**：同源文档 §202 实测三轮总耗时差 4.8 s，但按 `language/status`
//!    拆开状态推进段只差 71 ms，差异几乎全在 OSGi 引导段。拿总耗时当索引收益会把 JVM
//!    抖动记到索引账上。所以这里分别记 `initialize 返回` 与 `initialize → ServiceReady`。
//! 2. **结论写 `target/perf/`**：`rust-gate.mjs::wipeTmp()` 会清空 test-tmp 全部条目，
//!    写那儿等于跑一次门禁就把结论删了。
//!
//! 三组对照（同机、同 JDK、同 jdt.ls、autobuild 全关）：
//! - `single`：一个 project，只链 ic —— **生产现状基线**
//! - `flat`：一个 project，塞 N 个模块的源根 —— 原设想的 B（URI 映射要重写）
//! - `multi`：N 个 project，每模块一个 —— **行业标准形态**（Eclipse/VS Code 多模块 Maven
//!   就是这样，且 URI 前缀替换不用改）
//!
//! ```bash
//! cargo test --test shadow_scale_live -- --ignored --nocapture --test-threads=1
//! # 只跑某一组 / 改模块数：
//! NCFORGE_SCALE_MODE=multi NCFORGE_SCALE_MODULES=10 cargo test --test shadow_scale_live -- --ignored --nocapture
//! ```

#![allow(non_snake_case)]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use nc_forge::lsp::{
    build_initialize_params, build_settings, path_to_uri, JdtlsLaunch, LspClient, LspHandler,
};
use nc_forge::nc_index::{classpath_jars, ClassIndex};
use nc_forge::shadow::{self, ShadowSpec};
use serde_json::{json, Value};

/// 结论落盘目录。**不能写 test-tmp**（见模块头注第 2 条）。
///
/// 🔴 路径里不能留 `../`：`shadow::create_link` 用
/// `Command::new("cmd").args(["/C","mklink","/J"]).arg(link)`，Rust 在 Windows 上
/// 会给含 `..` 的参数加引号，而 `cmd /C` 把带引号的整串当开关解析，直接报
/// `无效开关 - "target"`（2026-11-17 最小探针实测：status=1，stderr 就是这句）。
/// 生产路径由 `config_dir` 拼出来不含 `..`，所以一直没暴露。
/// 注：`canonicalize` 的 `\\?\` 前缀**实测可用**（同一探针 status=0），不必剥掉。
/// 日志/原文截断，避免一次失败的响应把整个结论表撑爆。
fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        return s.to_string();
    }
    let head: String = s.chars().take(n).collect();
    format!("{head}…（共 {} 字符）", s.chars().count())
}

/// 结论落盘目录。**不能写 test-tmp**（见模块头注第 2 条）。
///
/// 🔴 这个目录的路径必须**既不含 `..`，也不含 `\\?\` 前缀** —— 两个字符各有各的死法，
/// 且都是 2026-11-17 用最小探针实测出来的，不是推理：
/// - 带 `..`：`shadow::create_link` 走 `Command::new("cmd").args(["/C","mklink","/J"])`
///   + `.arg(link)`，Rust 在 Windows 上会给含 `..` 的参数加引号，`cmd /C` 把带引号的
///     整串当开关解析，报 `无效开关 - "target"` ⇒ **建 junction 必失败**。
///     （生产路径由 `app_config_dir()` 拼出不含 `..`，所以这个缺陷至今没暴露，是潜在债。）
/// - 带 `\\?\`：Windows 的 `canonicalize()` 返回扩展长度路径前缀。`mklink` 能接受，
///   但 Equinox 启动器不能 —— `Main.canWrite` 用 `File.toPath()` 解析 `-configuration`
///   目录，JDK 的 `WindowsPathParser` 把 `\\?\D:\...` 当 UNC 解析，在 index 2 抛
///   `InvalidPathException: Illegal character [?]`，**jdt.ls 连 initialize 都进不去**，
///   前端只看到一句「语言服务进程已退出」。
///
/// 所以：先 `create_dir_all` 让 canonicalize 必然成功（消掉 `..`），再把前缀摘掉。
fn perf_dir() -> PathBuf {
    let raw = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/perf");
    let _ = std::fs::create_dir_all(&raw);
    let canon = raw.canonicalize().unwrap_or(raw);
    let owned = canon.to_string_lossy().into_owned();
    PathBuf::from(owned.strip_prefix(r"\\?\").unwrap_or(&owned).to_owned())
}

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

fn ls_dir() -> PathBuf {
    if let Ok(d) = std::env::var("NCFORGE_JDTLS_DIR") {
        return PathBuf::from(d);
    }
    let bundled = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/jdtls");
    if bundled.join("plugins").is_dir() {
        return bundled;
    }
    PathBuf::from(r"D:\AItool\aiwork\nc-workbench-m0\jdtls\ls")
}

/// 参与实测的模块。**ic 必须在内**（生产基线就是它），其余按源码量从小到大取，
/// 这样「加模块」的边际成本看得清楚。so 放进来是因为用户报的 DeliveryVO 在那儿。
fn modules(ws: &Path, want: usize) -> Vec<String> {
    let mut sized: Vec<(String, usize)> = Vec::new();
    let Ok(entries) = std::fs::read_dir(ws) else {
        return vec![];
    };
    for e in entries.flatten() {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "out" || name == "META-INF" || name == "nclogs" {
            continue;
        }
        if !["src/public", "src/client", "src/private"]
            .iter()
            .any(|s| p.join(s).is_dir())
        {
            continue;
        }
        let n = count_java(&p);
        if n > 0 {
            sized.push((name, n));
        }
    }
    sized.sort_by_key(|(n, c)| (*c, n.clone()));
    let mut picked: Vec<String> = vec!["ic".to_string()];
    // so 必须进来：跨模块跳转的验收目标
    if sized.iter().any(|(n, _)| n == "so") {
        picked.push("so".to_string());
    }
    for (n, _) in sized {
        if picked.len() >= want {
            break;
        }
        if !picked.contains(&n) {
            picked.push(n);
        }
    }
    picked.truncate(want.max(1));
    picked
}

fn count_java(dir: &Path) -> usize {
    let mut n = 0;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else {
            continue;
        };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                let name = e.file_name().to_string_lossy().to_string();
                if !name.starts_with('.') && name != "classes" && name != "bin" {
                    stack.push(p);
                }
            } else if p.extension().is_some_and(|x| x == "java") {
                n += 1;
            }
        }
    }
    n
}

#[derive(Default)]
struct Rec {
    ready: AtomicBool,
    /// `language/status` 的推进轨迹（type + 时刻），用来看状态段而非总耗时。
    stages: Mutex<Vec<(String, f32)>>,
    /// 服务端报的工程导入进度文案（`Starting`/`Message`），用来确认导入了几个 project。
    messages: Mutex<Vec<String>>,
}

struct H(Arc<Rec>, Instant);

impl LspHandler for H {
    fn on_notification(&self, method: &str, params: Value) {
        if method == "language/status" {
            let kind = params["type"].as_str().unwrap_or_default().to_string();
            self.0
                .stages
                .lock()
                .unwrap()
                .push((kind.clone(), self.1.elapsed().as_secs_f32()));
            if kind == "ServiceReady" {
                self.0.ready.store(true, Ordering::SeqCst);
            }
            let msg = params["message"].as_str().unwrap_or_default();
            if !msg.is_empty() {
                self.0.messages.lock().unwrap().push(msg.to_string());
            }
        }
    }
    fn on_request(&self, method: &str, params: &Value) -> Value {
        if method == "workspace/configuration" {
            let n = params["items"].as_array().map_or(1, Vec::len).max(1);
            let runtime = nc_home().join("ufjdk").to_string_lossy().into_owned();
            return Value::Array((0..n).map(|_| build_settings(&runtime)).collect());
        }
        Value::Null
    }
}

/// jdt.ls 进程的峰值内存（MB）。
///
/// 🔴 `LspClient` 的 `child` 是私有字段、没有 `pid()`，拿不到进程号。改用 **data 目录**
/// 在命令行里唯一定位：`JdtlsLaunch` 会把 `-data <dir>` 传给 jdt.ls，而本实测每组的
/// data 目录都不同，所以匹配它是可靠的（比按进程名匹配 java.exe 精确得多——机器上
/// 还有别的 JVM 在跑）。
///
/// 用 WMI 的 `PeakWorkingSetSize` 而不是 tasklist：后者只给当前值，看不到峰值。
/// jdt.ls 进程的内存（峰值 MB、当前 MB）与 PID。
///
/// 🔴 两次踩坑，都记在这儿：
/// 1. **`Win32_Process.PeakWorkingSetSize` 在这台机器上是坏的**：实测同一进程它报
///    640172 字节，而 `WorkingSetSize` 报 621965312（593 MB）—— 峰值小于当前值，
///    逻辑上不可能。第一版据此得出「jdt.ls 峰值 1 MB」的荒谬结论。改用
///    `Get-Process` 的 `PeakWorkingSet64`（625 MB，与当前值同量级，可信）。
/// 2. 第一版用 WQL `CommandLine LIKE '%...%'` 并把反斜杠翻倍，匹配不可靠。
///    现在用 `-Filter` 取全部 java.exe 再在 PowerShell 里 `-like` 过滤（反斜杠在
///    字符串拼接里是字面量，不用转义），数据目录经环境变量传入，绕开引号地狱。
///
/// 返回 PID 与当前值是为了可核验：量到的是哪个进程、峰值是否 ≥ 当前值，不能是个黑数。
fn peak_memory_mb(data_dir: &Path) -> Option<(u32, f64, f64)> {
    let script = "Get-CimInstance Win32_Process -Filter \"Name='java.exe'\" | \
                  Where-Object { $_.CommandLine -like ('*' + $env:NCF_SCALE_DATA + '*') } | \
                  ForEach-Object { $_.ProcessId } | \
                  ForEach-Object { $p = Get-Process -Id $_ -ErrorAction SilentlyContinue; \
                                   if ($p) { \"$($p.Id) $($p.PeakWorkingSet64) $($p.WorkingSet64)\" } }";
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .env("NCF_SCALE_DATA", data_dir)
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut best: Option<(u32, f64, f64)> = None;
    for line in text.lines() {
        let mut it = line.split_whitespace();
        if let (Some(pid), Some(peak), Some(cur)) = (it.next(), it.next(), it.next()) {
            if let (Ok(pid), Ok(peak), Ok(cur)) =
                (pid.parse::<u32>(), peak.parse::<f64>(), cur.parse::<f64>())
            {
                let m = |b: f64| b / 1024.0 / 1024.0;
                let cand = (pid, m(peak), m(cur));
                if best.is_none_or(|(_, p, _)| cand.1 > p) {
                    best = Some(cand);
                }
            }
        }
    }
    best
}

/// jdt.ls 自报的工程导入耗时（`<data>/.metadata/.log` 里的 `Workspace initialized in Nms`）。
///
/// 为什么要它：我们这边轮询 `language/status` 得到的是「initialize 返回到 ServiceReady」，
/// 里面混着 OSGi 引导、bundle 启动、构建作业。jdt.ls 自己打的那一行**只覆盖导入段**，
/// 是更贴近「导入 N 个工程值多少秒」这个问题的口径。两个都记，互为交叉验证。
fn workspace_init_ms(data_dir: &Path) -> Option<u64> {
    let log = data_dir.join(".metadata/.log");
    let text = std::fs::read_to_string(log).ok()?;
    let mut last = None;
    for line in text.lines() {
        if let Some(i) = line.find("Workspace initialized in ") {
            let rest = &line[i + "Workspace initialized in ".len()..];
            if let Some(digits) = rest.split("ms").next() {
                if let Ok(v) = digits.trim().parse::<u64>() {
                    last = Some(v);
                }
            }
        }
    }
    last
}

/// 一组实测的结果。
struct Measurement {
    mode: String,
    java_files: usize,
    classpath_kb: u64,
    projects_on_disk: usize,
    init_secs: f32,
    ready_secs: f32,
    ready: bool,
    /// ServiceReady 之后 language/status 的状态推进段耗时（去掉 OSGi 引导）。
    stage_secs: f32,
    /// jdt.ls 进程峰值内存（MB）。
    peak_mb: Option<f64>,
    /// 上面那个峰值属于哪个 java 进程。带 PID 是为了可核验 —— 内存量错进程比不量更糟。
    peak_pid: Option<u32>,
    /// jdt.ls 自报的工程导入段耗时（毫秒），来自 `<data>/.metadata/.log`。
    /// 与 `stage_secs` 互为交叉验证：前者只覆盖导入，后者混着 OSGi 引导。
    import_ms: Option<u64>,
    /// 跨模块跳转是否落到工作区源码（B 方案的真正收益）。
    cross_module_target: String,
    /// jdt.ls **实际**导入的工程数（`java/project.getAll`）。
    /// 🔴 这是判断 multi 是否真生效的唯一硬证据：磁盘上摆了 N 个 .project 不等于
    /// 导入了 N 个。没有这一列，「multi 和 single 耗时差不多」既可能是 B 不贵、
    /// 也可能是压根没导入，两者结论完全相反。
    imported_projects: usize,
}

/// 把「依赖别的模块的 class 目录」改写成「依赖别的模块的工程」。
///
/// 🔴 为什么必须有这一步（第一版漏了，导致结论差点错）：`shadow::generate` 给每个
/// 工程的 `.classpath` 塞了 ~820 条 `kind="lib"`，指向**所有**模块的 `<module>/classes`。
/// 于是 ic 工程靠 `so/classes`（字节码）就能解析 DeliveryVO —— multi 形态下跨模块
/// 跳转**仍然落到字节码**。那不是 B 不行，是探针没建模工程间依赖。
///
/// Eclipse / Maven 多模块的真实形态是工程引用：
/// `<classpathentry combineaccessrules="false" kind="src" path="/nc-forge-so"/>`
/// （VS Code Java 导入多模块 Maven 时生成的就是这个）。只有这样才能让「ic 里的类型引用」
/// 解析到 so 工程的**源根**。
///
/// `out/<module>` 那些条目保持 lib 不动：它们不是本工作区的源码模块产物。
fn link_projects(proj: &Path, module: &str, mods: &[String]) -> usize {
    let cp = proj.join(".classpath");
    let Ok(xml) = std::fs::read_to_string(&cp) else {
        return 0;
    };
    let mut out = String::with_capacity(xml.len());
    let mut changed = 0usize;
    for line in xml.lines() {
        if line.contains("kind=\"lib\"") {
            if let Some(m) = lib_module(line) {
                if m != module && mods.contains(&m) {
                    out.push_str(&format!(
                        "\t<classpathentry combineaccessrules=\"false\" kind=\"src\" path=\"/nc-forge-{m}\"/>\n"
                    ));
                    changed += 1;
                    continue;
                }
            }
        }
        out.push_str(line);
        out.push('\n');
    }
    if changed > 0 {
        let _ = std::fs::write(&cp, out);
    }
    changed
}

/// 从 `kind="lib"` 条目里取出模块名，认出**两种**产物目录：
/// `C:/work/aier/newar/so/classes` → `so`，`C:/work/aier/newar/out/so` → `so`。
///
/// 🔴 只认第一种会白改（2026-11-17 实测）：本工作区 `so/classes` 根本不存在，只有
/// `out/so`；而 `out/so` 在 classpath 里排第 41 行、工程引用排第 191 行 ——
/// Eclipse 按顺序解析，字节码赢。所以第二种必须一起换成工程引用。
fn lib_module(line: &str) -> Option<String> {
    let i = line.find("path=\"")? + "path=\"".len();
    let rest = &line[i..];
    let end = rest.find('"')?;
    let p = rest[..end].replace('\\', "/");
    let tail = if let Some(t) = p.strip_suffix("/classes") {
        t
    } else {
        let i = p.rfind("/out/")?;
        &p[i + "/out/".len()..]
    };
    if tail.is_empty() || tail.contains('/') {
        return None;
    }
    Some(tail.to_string())
}

/// 造一个「多 project」影子工作区：每个模块一个 Eclipse project。
///
/// 这是 Eclipse / VS Code 处理多模块 Maven 的形态。每个 project 内仍是
/// `<module>/src/*` 的 junction，所以 `LangSession` 的前缀替换（`shadow/<m>` → `real/<m>`）
/// **不用改** —— 这正是它比 flat 形态风险低的原因。
fn build_multi_project(
    base: &Path,
    ws: &Path,
    mods: &[String],
    index: &ClassIndex,
    home: &Path,
) -> (PathBuf, usize, usize, u64) {
    let root = base.join("multi-ws");
    let mut files = 0;
    let mut cp_bytes = 0u64;
    let mut linked = 0usize;
    for m in mods {
        let proj = root.join(m);
        let spec = ShadowSpec {
            workspace_root: ws,
            module: m,
            nc_home: home,
            shadow_dir: &proj,
            index,
            extra_jars: &[],
            overrides: &[],
            extra_modules: None,
        };
        match shadow::generate(&spec) {
            Ok(p) => {
                files += p.source_files;
                cp_bytes += std::fs::metadata(proj.join(".classpath"))
                    .map(|x| x.len())
                    .unwrap_or(0);
                // 🔴 必须改工程名：`shadow::render_project()` 把名字硬编码成
                // `nc-forge-shadow`（`PROJECT_NAME`）。Eclipse workspace 里工程名
                // **必须唯一**，59 个同名 .project 只会导入第一个，实测就变成
                // 「假 multi」——量出来的数会和 single 一样，据此判 B 不可行就错了。
                // 生产若采用 B，这一处是必须改的（也是 B 的真实改动面之一）。
                let pj = proj.join(".project");
                if let Ok(xml) = std::fs::read_to_string(&pj) {
                    let renamed = xml.replace(
                        "<name>nc-forge-shadow</name>",
                        &format!("<name>nc-forge-{m}</name>"),
                    );
                    let _ = std::fs::write(&pj, renamed);
                }
                // 工程间依赖：没有它，multi 只是把 single 复制了 N 份，量不出 B 的收益。
                linked += link_projects(&proj, m, mods);
            }
            Err(e) => println!("[警] 模块 {m} 影子生成失败：{e}"),
        }
    }
    if linked > 0 {
        println!("[量] multi: 共写入 {linked} 条工程间引用（kind=src path=/nc-forge-*）");
    }
    (root, mods.len(), files, cp_bytes / 1024)
}

/// 造一个「单 project 多源根」影子工作区（flat 形态）。
///
/// 走 `shadow::generate` 的 `extra_modules` 分支（= 生产路径），不再手工拼 `.classpath`：
/// 旧版只拿 `ic` 的 jar 段拼，测出来的 classpath 比生产实际的小得多（生产是全体 import
/// 的并集），boot 时间会被低估。
fn build_flat(
    base: &Path,
    ws: &Path,
    mods: &[String],
    index: &ClassIndex,
    home: &Path,
) -> (PathBuf, usize, usize, u64) {
    let root = base.join("flat-ws");
    let _ = std::fs::create_dir_all(root.join(".settings"));
    let spec = ShadowSpec {
        workspace_root: ws,
        module: "ic",
        nc_home: home,
        shadow_dir: &root,
        index,
        extra_jars: &[],
        overrides: &[],
        extra_modules: Some(mods),
    };
    let p = shadow::generate(&spec).expect("flat 影子生成失败");
    let kb = std::fs::metadata(root.join(".classpath"))
        .map(|x| x.len())
        .unwrap_or(0)
        / 1024;
    (root, p.modules.len(), p.source_files, kb)
}

// 三种模式的建场参数各不一样，硬拆成 struct 只是把噪音搬到另一个文件
#[allow(clippy::too_many_arguments)]
fn run_one(
    mode: &str,
    base: &Path,
    ws: &Path,
    mods: &[String],
    index: &ClassIndex,
    home: &Path,
    ls: &Path,
    ready_timeout: Duration,
) -> Measurement {
    let case = base.join(mode);
    let _ = std::fs::remove_dir_all(&case);
    std::fs::create_dir_all(&case).unwrap();

    let t = Instant::now();
    let (root, projects, files, cp_kb) = match mode {
        "multi" => build_multi_project(&case, ws, mods, index, home),
        "flat" => build_flat(&case, ws, mods, index, home),
        _ => {
            let shadow = case.join("single-ws");
            let spec = ShadowSpec {
                workspace_root: ws,
                module: "ic",
                nc_home: home,
                shadow_dir: &shadow,
                index,
                extra_jars: &[],
                overrides: &[],
                extra_modules: None,
            };
            let p = shadow::generate(&spec).unwrap();
            let kb = std::fs::metadata(shadow.join(".classpath"))
                .map(|x| x.len())
                .unwrap_or(0)
                / 1024;
            (shadow, 1, p.source_files, kb)
        }
    };
    println!(
        "[量] {mode}: 造影子 {:.1}s，project {projects} 个，源文件 {files}，classpath {cp_kb}KB",
        t.elapsed().as_secs_f32()
    );

    // 探针源根必须在 jdt.ls 启动前加好（import 时读 .classpath，之后加不生效）。
    // multi 的 ic project 在 root/ic，其余形态 root 本身就是工程目录。
    let ic_project = if mode == "multi" {
        root.join("ic")
    } else {
        root.clone()
    };
    let probe_src = add_probe_source_root(&ic_project);

    let rec = Arc::new(Rec::default());
    let data = case.join("jdtls-data");
    let t0 = Instant::now();
    let cmd = JdtlsLaunch {
        java_exe: &home.join("ufjdk/bin/java.exe"),
        ls_dir: ls,
        data_dir: &data,
        config_dir: &case.join("jdtls-config"),
        xmx_mb: 2048,
        syntax_server: false,
    }
    .command()
    .unwrap();
    // 🔴 必须用 spawn_with_stderr：`spawn` 把 jdt.ls 的 stderr 丢进 NUL，进程一退出
    // 就只剩「语言服务进程已退出」这一句，真实死因（OSGi 配置区、JVM 参数、堆）全看不见。
    let stderr_log = case.join("jdtls-stderr.log");
    let client = LspClient::spawn_with_stderr(cmd, Arc::new(H(rec.clone(), t0)), &stderr_log)
        .unwrap_or_else(|e| panic!("{mode}: 拉起 jdt.ls 失败 {e}"));
    let root_s = root.to_string_lossy().into_owned();
    let runtime = home.join("ufjdk").to_string_lossy().into_owned();
    let mut init = build_initialize_params(&root_s, &runtime, std::process::id(), &[]);
    if mode == "multi" {
        // 显式把每个模块 project 作为 workspaceFolder 报上去。
        // jdt.ls 本来也会递归扫 rootUri 下的 `.project`，但显式声明消除「它到底扫没扫到」
        // 这个不确定性 —— 实测要量的是导入 N 个工程的代价，不能让它退化成导入 1 个。
        init["workspaceFolders"] = Value::Array(
            mods.iter()
                .map(|m| {
                    let p = root.join(m);
                    json!({ "uri": path_to_uri(&p.to_string_lossy()), "name": format!("nc-forge-{m}") })
                })
                .collect(),
        );
    }
    client
        .request("initialize", init, Duration::from_secs(180))
        .unwrap();
    let init_secs = t0.elapsed().as_secs_f32();
    println!("[量] {mode}: initialize 返回 {init_secs:.1}s");
    client.notify("initialized", json!({})).unwrap();
    client
        .notify(
            "workspace/didChangeConfiguration",
            json!({ "settings": build_settings(&runtime) }),
        )
        .unwrap();
    while !rec.ready.load(Ordering::SeqCst) && t0.elapsed() < ready_timeout {
        std::thread::sleep(Duration::from_millis(500));
    }
    let ready_secs = t0.elapsed().as_secs_f32();
    let ready = rec.ready.load(Ordering::SeqCst);
    // 峰值必须在 shutdown 之前取：进程一退出就查不到了
    let peak = peak_memory_mb(&data);
    // 护栏：一个带着 Xmx2048 走到 ServiceReady 的 JVM，峰值不可能低于 16MB。
    // 低于这个数说明量错了进程或计数器坏了 —— 宁可判失败，也不要把垃圾数写进结论表。
    let peak = peak.filter(|(_, p, cur)| *p >= 16.0 && *p >= *cur);
    match peak {
        Some((pid, mb, cur)) => {
            println!("[量] {mode}: 内存 峰值 {mb:.0}MB / 当前 {cur:.0}MB（PID {pid}）")
        }
        None => println!("[警] {mode}: 内存测量失败或数值不合理（{peak:?}），不计入结论"),
    }
    // jdt.ls 自报的导入段耗时（.metadata/.log），与上面的轮询值互为交叉验证
    let init_ms = workspace_init_ms(&data);
    println!("[量] {mode}: jdt.ls 自报导入耗时 {:?}", init_ms);
    // 状态推进段：initialize 返回之后到 ServiceReady 的那一段（去掉 OSGi 引导）
    let stage_secs = (ready_secs - init_secs).max(0.0);
    let stages = rec.stages.lock().unwrap().clone();
    println!("[量] {mode}: 状态轨迹 {:?}", stages);

    // 客观计数：到底导入了几个工程。
    // 🔴 `java.project.getAll` 是**非静态命令**（jdt.ls 平台日志里有清单），直接当 LSP
    // 方法发会得到 `Unsupported request method`，必须走 `workspace/executeCommand`。
    let imported = if ready {
        match client.request(
            "workspace/executeCommand",
            json!({"command":"java.project.getAll","arguments":[]}),
            Duration::from_secs(30),
        ) {
            Ok(v) => {
                let n = v.as_array().map_or(0, Vec::len);
                println!(
                    "[量] {mode}: java.project.getAll → {n} 个工程{}",
                    if n == 0 {
                        format!("（原文：{}）", truncate(&v.to_string(), 300))
                    } else {
                        String::new()
                    }
                );
                n
            }
            Err(e) => {
                println!("[警] {mode}: java/project.getAll 失败 {e}");
                0
            }
        }
    } else {
        0
    };

    // 跨模块跳转：在 ic 工程里点 so 模块的 DeliveryVO。
    // 这是 B 方案的真正收益 —— A 方案靠索引改写，B 方案应让 jdt.ls 自己就解析到源码。
    let cross = if ready {
        probe_cross_module(&client, &probe_src)
    } else {
        "未就绪，跳过".to_string()
    };
    println!("[量] {mode}: 跨模块 definition → {cross}");

    client.shutdown();
    Measurement {
        mode: mode.to_string(),
        java_files: files,
        classpath_kb: cp_kb,
        projects_on_disk: projects,
        init_secs,
        ready_secs,
        ready,
        stage_secs,
        peak_mb: peak.map(|(_, mb, _)| mb),
        peak_pid: peak.map(|(pid, _, _)| pid),
        import_ms: init_ms,
        cross_module_target: cross,
        imported_projects: imported,
    }
}

/// 在 ic 里造一个引用 so 模块 DeliveryVO 的类，问 jdt.ls 它的定义在哪。
/// 给影子工程加一个**属于自己的**探针源根，返回该目录。
///
/// 🔴 为什么必须有这一步（2026-11-17 实测教训）：第一版把探针文件写到
/// `<工程>/ic/src/private/...`，而源根是 junction，等于**直接改用户的真实工作区** ——
/// 实测在 `C:\work\aier\newar\ic\src\private\ncforge\probe\` 下留下了 ScaleProbe.java
/// 和两层新建目录。实测探针没有权利写用户的源码树。
///
/// 做法：在工程目录下建 `probe-src` 并往 `.classpath` 追加一条 src 条目。
/// **必须在 jdt.ls 启动前加** —— jdt.ls 只在 import 时读 `.classpath`，启动后追加
/// 源根不会生效（不 refresh 的话新文件根本不在编译单元里）。
fn add_probe_source_root(project_dir: &Path) -> PathBuf {
    let probe = project_dir.join("probe-src");
    let _ = std::fs::create_dir_all(&probe);
    let cp = project_dir.join(".classpath");
    if let Ok(xml) = std::fs::read_to_string(&cp) {
        if !xml.contains("probe-src") {
            let entry = "\t<classpathentry kind=\"src\" path=\"probe-src\"/>\n";
            let merged = match xml.find("</classpath>") {
                Some(i) => format!("{}{}{}", &xml[..i], entry, &xml[i..]),
                None => format!("{xml}{entry}"),
            };
            let _ = std::fs::write(&cp, merged);
        }
    }
    probe
}

fn probe_cross_module(client: &LspClient, probe_src: &Path) -> String {
    let pkg = probe_src.join("ncforge/probe");
    if std::fs::create_dir_all(&pkg).is_err() {
        return "无法建探针目录".to_string();
    }
    let text = "package ncforge.probe;\nimport nc.vo.so.m4331.entity.DeliveryVO;\npublic class ScaleProbe {\n    DeliveryVO vo;\n}\n";
    let path = pkg.join("ScaleProbe.java");
    if std::fs::write(&path, text).is_err() {
        return "无法写探针文件".to_string();
    }
    let uri = path_to_uri(&path.to_string_lossy());
    let _ = client.notify(
        "textDocument/didOpen",
        json!({ "textDocument": { "uri": uri, "languageId": "java", "version": 1, "text": text } }),
    );
    // 给 jdt.ls 一点时间解析新文件
    std::thread::sleep(Duration::from_secs(8));
    // 第 4 行（0 基 3）的 DeliveryVO
    let pos = json!({ "line": 3, "character": 6 });
    match client.request(
        "textDocument/definition",
        json!({ "textDocument": { "uri": uri }, "position": pos }),
        Duration::from_secs(60),
    ) {
        Ok(v) => {
            let first = v
                .as_array()
                .and_then(|a| a.first())
                .cloned()
                .unwrap_or(Value::Null);
            let target = first["targetUri"]
                .as_str()
                .or_else(|| first["uri"].as_str())
                .unwrap_or("(空)");
            if target.contains("jdt://") {
                format!("jdt://（字节码）{target}")
            } else if target.to_lowercase().ends_with("deliveryvo.java") {
                format!("源码 {target}")
            } else {
                format!("其他 {target}")
            }
        }
        Err(e) => format!("请求失败 {e}"),
    }
}

#[test]
#[ignore = "需要真实工作区 + jdt.ls + JDK8，单组最长 15 分钟"]
fn 影子工程规模对import耗时的影响_三组对照() {
    let ws = workspace();
    let home = nc_home();
    let ls = ls_dir();
    assert!(ws.join("ic").is_dir(), "工作区不可用：{}", ws.display());
    assert!(
        ls.join("plugins").is_dir(),
        "jdt.ls 不可用：{}",
        ls.display()
    );
    assert!(
        home.join("ufjdk/bin/java.exe").is_file(),
        "JDK 不可用：{}",
        home.display()
    );

    let want: usize = std::env::var("NCFORGE_SCALE_MODULES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(10);
    let only = std::env::var("NCFORGE_SCALE_MODE").ok();
    let timeout = Duration::from_secs(
        std::env::var("NCFORGE_SCALE_TIMEOUT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(900),
    );

    let base = perf_dir().join(format!("shadow-scale-{}", std::process::id()));
    std::fs::create_dir_all(&base).unwrap();

    // 类索引只建一次，三组共用（它的耗时不属于本实测的变量）
    let t = Instant::now();
    let cache = perf_dir().join("scale-class-index.bin");
    let index = ClassIndex::load_or_build(classpath_jars(&home), Some(&cache), None);
    println!(
        "[量] 类索引 {} jar / {} 类，{:.1}s",
        index.jars.len(),
        index.class_count(),
        t.elapsed().as_secs_f32()
    );

    let mods = modules(&ws, want);
    println!("[量] 参与模块（{} 个）：{:?}", mods.len(), mods);
    let total_java: usize = mods.iter().map(|m| count_java(&ws.join(m))).sum();
    println!("[量] 这些模块共 {total_java} 个 .java");

    let modes: Vec<&str> = match only.as_deref() {
        Some(m) => vec![m],
        None => vec!["single", "flat", "multi"],
    };
    let mut rows: Vec<Measurement> = Vec::new();
    for m in modes {
        println!("\n===== {m} =====");
        rows.push(run_one(m, &base, &ws, &mods, &index, &home, &ls, timeout));
    }

    // 汇总落盘
    let mut md = String::from("# 影子工程规模 → jdt.ls import 实测\n\n");
    md.push_str(&format!(
        "工作区 `{}`，模块 {} 个（{:?}），共 {} 个 .java。\n",
        ws.display(),
        mods.len(),
        mods,
        total_java
    ));
    md.push_str("JDK8 + 随包 jdt.ls，autobuild 关闭，Xmx 2048MB。\n\n");
    md.push_str("| 形态 | 磁盘 project | **实际导入** | 源文件 | classpath KB | initialize s | ServiceReady s | 状态段 s | **jdt.ls 自报导入** | 峰值内存 MB | 跨模块 definition |\n");
    md.push_str("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n");
    for r in &rows {
        md.push_str(&format!(
            "| {} | {} | {} | {} | {} | {:.1} | {:.1}{} | {:.1} | {} | {} | {} |\n",
            r.mode,
            r.projects_on_disk,
            r.imported_projects,
            r.java_files,
            r.classpath_kb,
            r.init_secs,
            r.ready_secs,
            if r.ready { "" } else { "（未就绪）" },
            r.stage_secs,
            r.import_ms
                .map(|v| format!("{:.1}s", v as f64 / 1000.0))
                .unwrap_or_else(|| "n/a".into()),
            match (r.peak_mb, r.peak_pid) {
                (Some(mb), Some(pid)) => format!("{mb:.0}（PID {pid}）"),
                _ => "n/a".into(),
            },
            r.cross_module_target
        ));
    }
    md.push_str(
        "\n口径：**状态段 = ServiceReady − initialize 返回**，去掉 OSGi 引导抖动；\n\
         **jdt.ls 自报导入** 取 `<data>/.metadata/.log` 的 `Workspace initialized in Nms`，\n\
         只覆盖导入段，与状态段互为交叉验证。\n",
    );
    let out = perf_dir().join("shadow-scale.md");
    std::fs::write(&out, &md).unwrap();
    println!("\n{md}");
    println!("[量] 结论已写 {}", out.display());

    // 唯一硬断言：生产基线必须能就绪，否则整个实测无意义
    if let Some(s) = rows.iter().find(|r| r.mode == "single") {
        assert!(s.ready, "生产基线（single）都没就绪，实测环境有问题");
    }
}

// ─────────────────────────────────────────────────────────────────────────
// S0：warm 复用 + 增量是否生效
//
// 规划 `docs/NCForge-智能代码-单索引常驻-规划-2026-11-21.md` S0 的两个阻塞项：
// 1. **flat warm** —— 同一 data/config 目录第二次导入要多久，决定 S4 要不要做双进程
// 2. **增量是否生效** —— 不重启引擎时，磁盘上的文件变化能不能进索引
//
// 为什么单独写而不复用 `run_one`：`run_one` 每次都 `remove_dir_all(case)` 且现造 data 目录，
// 结构性排除了 warm；增量则要在同一个会话里做「改文件 → 再查询」，`run_one` 是启动即关。
// ─────────────────────────────────────────────────────────────────────────

/// 起一次 jdt.ls 并等到 ServiceReady，返回 (client, initialize 秒, ready 秒, 是否就绪)。
///
/// 🔴 `data` 与 `config` 由调用方给：**第二次必须传同一个**才算 warm
/// （jdt.ls 的 workspace 索引在 `-data`，OSGi 缓存在 `-configuration`，少复用哪一半都不算）。
///
/// `#[allow(too_many_arguments)]`：8 个参数确实多，但与 `run_one` 同样理由 ——
/// 硬拆成 struct 只是把「传什么」搬到另一个文件，参数校验反而更弱。
/// （clippy 是 `-D warnings`，CI 上这个不能当警告放过。）
#[allow(clippy::too_many_arguments)]
fn boot_flat(
    root: &Path,
    data: &Path,
    config: &Path,
    log_dir: &Path,
    home: &Path,
    ls: &Path,
    timeout: Duration,
    syntax: bool,
    tag: &str,
) -> (LspClient, f32, f32, bool) {
    let _ = std::fs::create_dir_all(log_dir);
    let rec = Arc::new(Rec::default());
    let t0 = Instant::now();
    let cmd = JdtlsLaunch {
        java_exe: &home.join("ufjdk/bin/java.exe"),
        ls_dir: ls,
        data_dir: data,
        config_dir: config,
        xmx_mb: 2048,
        syntax_server: syntax,
    }
    .command()
    .unwrap_or_else(|e| panic!("{tag}: 组装 jdt.ls 命令失败 {e}"));
    let stderr_log = log_dir.join(format!("{tag}-stderr.log"));
    let client = LspClient::spawn_with_stderr(cmd, Arc::new(H(rec.clone(), t0)), &stderr_log)
        .unwrap_or_else(|e| panic!("{tag}: 拉起 jdt.ls 失败 {e}"));
    let root_s = root.to_string_lossy().into_owned();
    let runtime = home.join("ufjdk").to_string_lossy().into_owned();
    let init = build_initialize_params(&root_s, &runtime, std::process::id(), &[]);
    client
        .request("initialize", init, Duration::from_secs(300))
        .unwrap_or_else(|e| panic!("{tag}: initialize 失败 {e}"));
    let init_secs = t0.elapsed().as_secs_f32();
    client.notify("initialized", json!({})).unwrap();
    client
        .notify(
            "workspace/didChangeConfiguration",
            json!({ "settings": build_settings(&runtime) }),
        )
        .unwrap();
    while !rec.ready.load(Ordering::SeqCst) && t0.elapsed() < timeout {
        std::thread::sleep(Duration::from_millis(300));
    }
    let ready_secs = t0.elapsed().as_secs_f32();
    let ready = rec.ready.load(Ordering::SeqCst);
    println!(
        "[量] {tag}: initialize {init_secs:.1}s → ready {ready_secs:.1}s（{}）",
        if ready { "就绪" } else { "超时" }
    );
    (client, init_secs, ready_secs, ready)
}

#[test]
#[ignore = "需要真实工作区 + jdt.ls + JDK8；两轮全量导入，最长 30 分钟"]
fn s0_flat_warm_同一data目录导入两次() {
    let ws = workspace();
    let home = nc_home();
    let ls = ls_dir();
    assert!(ws.join("ic").is_dir(), "工作区不可用：{}", ws.display());
    assert!(
        ls.join("plugins").is_dir(),
        "jdt.ls 不可用：{}",
        ls.display()
    );
    assert!(
        home.join("ufjdk/bin/java.exe").is_file(),
        "JDK 不可用：{}",
        home.display()
    );

    let timeout = Duration::from_secs(
        std::env::var("NCFORGE_SCALE_TIMEOUT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(900),
    );
    let cache = perf_dir().join("scale-class-index.bin");
    let t = Instant::now();
    let index = ClassIndex::load_or_build(classpath_jars(&home), Some(&cache), None);
    println!(
        "[量] 类索引 {} jar / {} 类，{:.1}s（有缓存时这段接近 0，不计入 flat 差异）",
        index.jars.len(),
        index.class_count(),
        t.elapsed().as_secs_f32()
    );

    let case = perf_dir().join("s0-warm");
    let _ = std::fs::remove_dir_all(&case);
    std::fs::create_dir_all(&case).unwrap();

    // 全量模块：warm 要测的是「全量索引能不能被复用」，模块少就失去意义
    let mods = modules(&ws, usize::MAX);
    let t_build = Instant::now();
    let (root, _, files, kb) = build_flat(&case, &ws, &mods, &index, &home);
    println!(
        "[量] 建场 {:.1}s：{} 个模块 / {} 个源文件 / classpath {}KB",
        t_build.elapsed().as_secs_f32(),
        mods.len(),
        files,
        kb
    );

    let data = case.join("jdtls-data");
    let config = case.join("jdtls-config");
    let logs = case.join("logs");

    let (c1, i1, r1, ok1) = boot_flat(
        &root, &data, &config, &logs, &home, &ls, timeout, false, "cold",
    );
    let peak1 = peak_memory_mb(&data);
    c1.shutdown();
    // 等 JVM 真正退出：data 目录的索引要 flush 完，否则第二轮读的是半截
    std::thread::sleep(Duration::from_secs(5));

    let (c2, i2, r2, ok2) = boot_flat(
        &root, &data, &config, &logs, &home, &ls, timeout, false, "warm",
    );
    let peak2 = peak_memory_mb(&data);
    let cross = if ok2 {
        // warm 场景也要验一次语义可用（不能只是「起得快」）
        let probe = add_probe_source_root(&root);
        probe_cross_module(&c2, &probe)
    } else {
        "未就绪".to_string()
    };
    c2.shutdown();

    let mut md = String::from("# flat 的 cold vs warm（同一 data/config 目录）\n\n");
    md.push_str(&format!(
        "工作区 `{}`，{} 个模块 / {} 个源文件，classpath {}KB，Xmx 2048MB。\n\n",
        ws.display(),
        mods.len(),
        files,
        kb
    ));
    md.push_str(
        "| 轮次 | initialize s | ServiceReady s | 就绪 | 峰值 MB |\n|---|---|---|---|---|\n",
    );
    for (tag, i, r, ok, peak) in [
        ("cold（全新 data）", i1, r1, ok1, peak1),
        ("**warm（同一 data）**", i2, r2, ok2, peak2),
    ] {
        md.push_str(&format!(
            "| {tag} | {i:.1} | {r:.1} | {} | {} |\n",
            if ok { "是" } else { "否" },
            peak.map(|(_, mb, _)| format!("{mb:.0}"))
                .unwrap_or_else(|| "n/a".into())
        ));
    }
    md.push_str(&format!(
        "\nwarm 跨模块 definition → {cross}\n\n\
         > 判读：warm 若显著低于 cold，S4 可以直接等（不必做双进程）；\n\
         > 若 warm ≈ cold，说明缓存没命中，要先查 `.classpath` 指纹是否每次都在变。\n"
    ));
    let out = perf_dir().join("shadow-s0-warm.md");
    let _ = std::fs::write(&out, &md);
    println!("\n{md}");
    println!("[出] 结论：{}", out.display());

    assert!(ok1 && ok2, "两轮都必须就绪，否则 warm 数据不可比");
}

/// 问一次 definition，取 (目标文件名, 起始行 0 基)。失败返回 Err。
fn def_site(client: &LspClient, uri: &str, line: u32, ch: u32) -> Result<(String, u32), String> {
    let v = client
        .request(
            "textDocument/definition",
            json!({ "textDocument": { "uri": uri }, "position": { "line": line, "character": ch } }),
            Duration::from_secs(60),
        )
        .map_err(|e| e.to_string())?;
    let first = v
        .as_array()
        .and_then(|a| a.first())
        .cloned()
        .unwrap_or(Value::Null);
    let target = first["targetUri"]
        .as_str()
        .or_else(|| first["uri"].as_str())
        .ok_or_else(|| format!("definition 无目标：{}", truncate(&v.to_string(), 200)))?;
    let range = if first["range"].is_object() {
        &first["range"]
    } else {
        &first["targetRange"]
    };
    let ln = range["start"]["line"].as_u64().unwrap_or(u64::MAX) as u32;
    let name = target.rsplit('/').next().unwrap_or(target).to_string();
    Ok((name, ln))
}

#[test]
#[ignore = "需要真实工作区 + jdt.ls + JDK8；含 3 次 10 秒等待"]
fn s0_增量_外部改文件后跳转是否更新() {
    let ws = workspace();
    let home = nc_home();
    let ls = ls_dir();
    assert!(ws.join("ic").is_dir(), "工作区不可用：{}", ws.display());
    assert!(
        ls.join("plugins").is_dir(),
        "jdt.ls 不可用：{}",
        ls.display()
    );

    let timeout = Duration::from_secs(
        std::env::var("NCFORGE_SCALE_TIMEOUT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(600),
    );
    let cache = perf_dir().join("scale-class-index.bin");
    let index = ClassIndex::load_or_build(classpath_jars(&home), Some(&cache), None);

    // 增量与模块规模无关，3 个模块足够启动
    let mods = modules(&ws, 3);
    let case = perf_dir().join("s0-incremental");
    let _ = std::fs::remove_dir_all(&case);
    std::fs::create_dir_all(&case).unwrap();
    let (root, _, _, _) = build_flat(&case, &ws, &mods, &index, &home);

    // 🔴 只在影子工程自己的 probe-src 里造文件，**绝不改用户源码树**
    // （2026-11-17 教训：第一版探针直接写到 junction 目标，在用户工作区留下垃圾）
    let probe = add_probe_source_root(&root);
    let pkg = probe.join("ncforge/probe");
    std::fs::create_dir_all(&pkg).unwrap();
    let a_path = pkg.join("IncA.java");
    let b_path = pkg.join("IncB.java");
    // IncA 里 `IncB.target` 的 target 从第 2 行第 17 列开始
    let a_text = "package ncforge.probe;\npublic class IncA {\n    int v = IncB.target();\n}\n";
    let b_v1 =
        "package ncforge.probe;\npublic class IncB {\n    public static int target() { return 1; }\n}\n";
    // 头部插两行注释：语义不变，只把 target 从第 2 行推到第 4 行
    let b_v2 = "// moved 1\n// moved 2\npackage ncforge.probe;\npublic class IncB {\n    public static int target() { return 1; }\n}\n";
    std::fs::write(&a_path, a_text).unwrap();
    std::fs::write(&b_path, b_v1).unwrap();

    let data = case.join("jdtls-data");
    let config = case.join("jdtls-config");
    let logs = case.join("logs");
    let (client, _, _, ready) = boot_flat(
        &root, &data, &config, &logs, &home, &ls, timeout, false, "inc",
    );
    assert!(ready, "服务未就绪");

    let a_uri = path_to_uri(&a_path.to_string_lossy());
    client
        .notify(
            "textDocument/didOpen",
            json!({ "textDocument": { "uri": a_uri, "languageId": "java", "version": 1, "text": a_text } }),
        )
        .unwrap();
    std::thread::sleep(Duration::from_secs(10));

    let before = def_site(&client, &a_uri, 2, 18);
    println!("[量] 改动前 definition → {before:?}（期望 IncB.java 第 2 行）");

    // 只改磁盘，不发任何通知 —— 这模拟 SVN 更新 / 在 Eclipse 里改
    std::fs::write(&b_path, b_v2).unwrap();
    std::thread::sleep(Duration::from_secs(10));
    let self_watch = def_site(&client, &a_uri, 2, 18);
    println!("[量] 改后不发通知（等 10s）→ {self_watch:?}");

    // 再显式推一次 didChangeWatchedFiles（S2.5 要实现的通道）
    let b_uri = path_to_uri(&b_path.to_string_lossy());
    client
        .notify(
            "workspace/didChangeWatchedFiles",
            json!({ "changes": [ { "uri": b_uri, "type": 2 } ] }),
        )
        .unwrap();
    std::thread::sleep(Duration::from_secs(8));
    let after_notify = def_site(&client, &a_uri, 2, 18);
    println!("[量] 推送 didChangeWatchedFiles 后 → {after_notify:?}");

    client.shutdown();

    let verdict = |r: &Result<(String, u32), String>| match r {
        Ok((n, l)) => format!("{n}:{l}"),
        Err(e) => format!("失败 {e}"),
    };
    let saw_self = matches!(&self_watch, Ok((n, l)) if n.contains("IncB") && *l == 4);
    let saw_notify = matches!(&after_notify, Ok((n, l)) if n.contains("IncB") && *l == 4);

    let mut md = String::from("# 增量：外部改文件后跳转会不会更新\n\n");
    md.push_str(&format!(
        "影子工程 `{}`，探针 `{}`。改的是 `IncB.java` 头部注释（target 从第 2 行推到第 4 行）。\n\n",
        root.display(),
        b_path.display()
    ));
    md.push_str("| 时刻 | definition 落点 |\n|---|---|\n");
    md.push_str(&format!("| 改动前 | {} |\n", verdict(&before)));
    md.push_str(&format!(
        "| 改后不发通知（10s） | {} |\n",
        verdict(&self_watch)
    ));
    md.push_str(&format!(
        "| 推送 `didChangeWatchedFiles` 后 | {} |\n",
        verdict(&after_notify)
    ));
    md.push_str(&format!(
        "\n## 结论\n\n\
         - jdt.ls 自己感知 junction 后的真实文件变化：**{}**\n\
         - 显式推送 `workspace/didChangeWatchedFiles` 有效：**{}**\n\n\
         > {}\n",
        if saw_self { "是" } else { "**否**" },
        if saw_notify { "是" } else { "**否**" },
        if saw_notify {
            "⇒ S2.5 按「自己推 didChangeWatchedFiles」实现即可，不依赖 jdt.ls 的文件监视。"
        } else if saw_self {
            "⇒ jdt.ls 自己能感知，S2.5 可以简化；但 junction 的监视语义仍建议显式推一次兜底。"
        } else {
            "⇒ **两条都不生效**：flat 之后索引会冻结在导入那一刻，S2.5 必须先解决这个再上 S1。"
        }
    ));
    let out = perf_dir().join("shadow-s0-incremental.md");
    let _ = std::fs::write(&out, &md);
    println!("\n{md}");
    println!("[出] 结论：{}", out.display());
}

/// 往工程的 `.classpath` 里追加一条源根（幂等）。`add_probe_source_root` 是它的特例。
///
/// 为什么需要通用版：junction 测试要加一个**不是** `probe-src` 的源根，而
/// `add_probe_source_root` 把名字写死成 `probe-src` 且只用一次。
fn add_src_root(project_dir: &Path, name: &str) -> PathBuf {
    let dir = project_dir.join(name);
    let _ = std::fs::create_dir_all(&dir);
    let cp = project_dir.join(".classpath");
    if let Ok(xml) = std::fs::read_to_string(&cp) {
        let needle = format!("path=\"{name}\"");
        if !xml.contains(&needle) {
            let entry = format!("\t<classpathentry kind=\"src\" path=\"{name}\"/>\n");
            let merged = match xml.find("</classpath>") {
                Some(i) => format!("{}{}{}", &xml[..i], entry, &xml[i..]),
                None => format!("{xml}{entry}"),
            };
            let _ = std::fs::write(&cp, merged);
        }
    }
    dir
}

/// **junction 源根**能不能感知外部改动 —— 这才是生产形态。
///
/// 上一条 `s0_增量_外部改文件后跳转是否更新` 的 `probe-src` 是影子工程**自己的真实目录**，
/// 只证明了「jdt.ls 能感知自己工程里的文件变化」。生产里每个模块根都是
/// `mklink /J` 到真实工作区，jdt.ls 的 watcher 挂在 junction 路径上，
/// 目标目录的 mtime 变化能不能穿透过来是**另一件事**（Windows 上 junction 的 FindFirstChangeNotification
/// 行为与普通目录不同）。
///
/// 所以这里自建一条 junction 指向**工程外的临时目录**（不碰用户源码），改那个真实文件，
/// 看 junction 路径上的源根是否跟着更新。
#[test]
#[ignore = "需要真实工作区 + jdt.ls + JDK8；含 3 次等待"]
fn s0_增量_junction源根能否感知外部改动() {
    let ws = workspace();
    let home = nc_home();
    let ls = ls_dir();
    assert!(ws.join("ic").is_dir(), "工作区不可用：{}", ws.display());
    assert!(
        ls.join("plugins").is_dir(),
        "jdt.ls 不可用：{}",
        ls.display()
    );

    let timeout = Duration::from_secs(
        std::env::var("NCFORGE_SCALE_TIMEOUT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(600),
    );
    let cache = perf_dir().join("scale-class-index.bin");
    let index = ClassIndex::load_or_build(classpath_jars(&home), Some(&cache), None);
    let mods = modules(&ws, 3);
    let case = perf_dir().join("s0-junction");
    let _ = std::fs::remove_dir_all(&case);
    std::fs::create_dir_all(&case).unwrap();
    let (root, _, _, _) = build_flat(&case, &ws, &mods, &index, &home);

    // 真实目录在工程外（模拟用户工作区里的模块源码），junction 在影子工程内
    let real = case.join("jreal");
    let real_pkg = real.join("ncforge/probe");
    std::fs::create_dir_all(&real_pkg).unwrap();
    let jreal_file = real_pkg.join("Junc.java");
    let j_v1 =
        "package ncforge.probe;\npublic class Junc {\n    public static int value() { return 7; }\n}\n";
    // 头部插两行，把 value 从第 2 行推到第 4 行
    let j_v2 = "// moved A\n// moved B\npackage ncforge.probe;\npublic class Junc {\n    public static int value() { return 7; }\n}\n";
    std::fs::write(&jreal_file, j_v1).unwrap();

    let link = root.join("probe-junc");
    if !link.exists() {
        shadow::ensure_link(&link, &real, &mut Vec::new()).unwrap_or_else(|e| {
            panic!(
                "建 junction 失败（{} → {}）：{e}",
                link.display(),
                real.display()
            )
        });
    }
    // 🔴 必须在 jdt.ls 启动前加源根：import 时读 .classpath，之后加不生效
    add_src_root(&root, "probe-junc");

    // 引用 Junc 的类放在另一个真实源根（probe-src），避免「同目录内改动」被当成普通 edit
    let probe = add_probe_source_root(&root);
    let pkg = probe.join("ncforge/probe");
    std::fs::create_dir_all(&pkg).unwrap();
    let d_path = pkg.join("IncD.java");
    let d_text = "package ncforge.probe;\npublic class IncD {\n    int w = Junc.value();\n}\n";
    std::fs::write(&d_path, d_text).unwrap();

    let data = case.join("jdtls-data");
    let config = case.join("jdtls-config");
    let logs = case.join("logs");
    let (client, _, _, ready) = boot_flat(
        &root, &data, &config, &logs, &home, &ls, timeout, false, "junc",
    );
    assert!(ready, "服务未就绪");

    let d_uri = path_to_uri(&d_path.to_string_lossy());
    client
        .notify(
            "textDocument/didOpen",
            json!({ "textDocument": { "uri": d_uri, "languageId": "java", "version": 1, "text": d_text } }),
        )
        .unwrap();
    std::thread::sleep(Duration::from_secs(12));

    // `    int w = Junc.value();` → Junc 起于 12，value 起于 17
    let before = def_site(&client, &d_uri, 2, 19);
    println!("[量] junction 改动前 → {before:?}（期望 Junc.java 第 2 行）");
    if before.is_err() {
        // 诊断：类名能解析说明源根在、只是方法没索引；类名也不行则是 probe-junc 没被当源根
        println!(
            "[诊] 同文件里 `Junc` 类名的 definition → {:?}",
            def_site(&client, &d_uri, 2, 14)
        );
    }

    // 通过**真实路径**改（等价于 SVN 更新 / Eclipse 里改），junction 侧只看得到结果
    std::fs::write(&jreal_file, j_v2).unwrap();
    std::thread::sleep(Duration::from_secs(12));
    let self_watch = def_site(&client, &d_uri, 2, 19);
    println!("[量] junction 改后不发通知（12s）→ {self_watch:?}");

    // 兜底通道：显式推 junction 侧的 URI（生产里 S2.5 就这么做）
    let link_file = link.join("ncforge/probe/Junc.java");
    let link_uri = path_to_uri(&link_file.to_string_lossy());
    client
        .notify(
            "workspace/didChangeWatchedFiles",
            json!({ "changes": [ { "uri": link_uri, "type": 2 } ] }),
        )
        .unwrap();
    std::thread::sleep(Duration::from_secs(10));
    let after_notify = def_site(&client, &d_uri, 2, 19);
    println!("[量] junction 推送通知后 → {after_notify:?}");

    client.shutdown();

    let verdict = |r: &Result<(String, u32), String>| match r {
        Ok((n, l)) => format!("{n}:{l}"),
        Err(e) => format!("失败 {e}"),
    };
    let saw_self = matches!(&self_watch, Ok((n, l)) if n.contains("Junc") && *l == 4);
    let saw_notify = matches!(&after_notify, Ok((n, l)) if n.contains("Junc") && *l == 4);

    let mut md = String::from("# 增量：junction 源根能否感知外部改动（生产形态）\n\n");
    md.push_str(&format!(
        "junction `{}` → 真实目录 `{}`。改真实文件，看 junction 侧源根是否更新。\n\n",
        link.display(),
        real.display()
    ));
    md.push_str("| 时刻 | definition 落点 |\n|---|---|\n");
    md.push_str(&format!("| 改动前 | {} |\n", verdict(&before)));
    md.push_str(&format!(
        "| 改后不发通知（12s） | {} |\n",
        verdict(&self_watch)
    ));
    md.push_str(&format!(
        "| 推送 `didChangeWatchedFiles`（junction URI）后 | {} |\n",
        verdict(&after_notify)
    ));
    md.push_str(&format!(
        "\n## 结论\n\n\
         - junction 源根自己感知真实文件变化：**{}**\n\
         - 显式推 junction URI 有效：**{}**\n\n\
         > {}\n",
        if saw_self { "是" } else { "**否**" },
        if saw_notify { "是" } else { "**否**" },
        if saw_notify && !saw_self {
            "⇒ junction 不穿透（或不可靠），**S2.5 必须显式推 didChangeWatchedFiles**，且 URI 用 junction 侧路径。"
        } else if saw_notify && saw_self {
            "⇒ 两条都有效：jdt.ls 能穿透 junction，S2.5 可只做保底（批量更新/超时后补推）。"
        } else {
            "⇒ **两条都不生效**：flat 之后索引会冻结在导入那一刻，S2.5 必须先解决这个再上 S1。"
        }
    ));
    let out = perf_dir().join("shadow-s0-junction.md");
    let _ = std::fs::write(&out, &md);
    println!("\n{md}");
    println!("[出] 结论：{}", out.display());
}

/// **import 期间能不能跳转** —— 决定 S4 是「双进程」还是「单实例渐进可用」。
///
/// 背景：S0 已测出 flat 的 import 要 3~6 分钟（warm 也不省），而 Eclipse/IDEA 同样体量的
/// workspace 却不必干等 —— 它们的做法是「UI 先出、索引进后台」（IDEA 的 dumb mode、
/// Eclipse 的 splash + background job）。jdt.ls 没有这个契约，客户端只能等 `ServiceReady`。
///
/// 但状态轨迹显示 jdt.ls 是**逐个 project 导入**的（`Starting` 事件密集出现）。如果
/// 已导入的部分能响应 `definition`，那就不该等 ServiceReady —— 直接边导边用，
/// 体感最接近 Eclipse，也不需要双进程（省 700MB 内存和一套切换逻辑）。
///
/// 做法：`initialize` 返回后立刻 `didOpen` 一个引用 **so 模块类型**的探针文件，
/// 然后每 3 秒问一次 definition，记录「第几秒开始有结果」与 `ServiceReady` 的时刻。
///
/// 判读：
/// - 结果早于 ServiceReady 很多 → **单实例渐进可用**，S4 改成「不阻塞 UI + 前缀进度」
/// - 只在 ServiceReady 后才有   → 只能双进程（S4 原方案）
#[test]
#[ignore = "需要真实工作区 + jdt.ls + JDK8；最长 6 分钟"]
fn s0_import期间能否响应跳转() {
    let ws = workspace();
    let home = nc_home();
    let ls = ls_dir();
    assert!(ws.join("ic").is_dir(), "工作区不可用：{}", ws.display());
    assert!(
        ls.join("plugins").is_dir(),
        "jdt.ls 不可用：{}",
        ls.display()
    );

    let cache = perf_dir().join("scale-class-index.bin");
    let index = ClassIndex::load_or_build(classpath_jars(&home), Some(&cache), None);
    // 3 个模块：够触发「多 project 逐个导入」，又不至于等太久
    let mods = modules(&ws, 3);
    let case = perf_dir().join("s0-early");
    let _ = std::fs::remove_dir_all(&case);
    std::fs::create_dir_all(&case).unwrap();
    let (root, _, files, _) = build_flat(&case, &ws, &mods, &index, &home);
    println!("[量] 建场完成：{} 个模块 / {} 个源文件", mods.len(), files);

    // 探针：引用 so 模块的 DeliveryVO（跨模块，必须等 so 导入后才可能有结果）
    let probe = add_probe_source_root(&root);
    let pkg = probe.join("ncforge/probe");
    std::fs::create_dir_all(&pkg).unwrap();
    let probe_path = pkg.join("EarlyProbe.java");
    let probe_text = "package ncforge.probe;\nimport nc.vo.so.m4331.entity.DeliveryVO;\npublic class EarlyProbe {\n    DeliveryVO vo;\n}\n";
    std::fs::write(&probe_path, probe_text).unwrap();

    let rec = Arc::new(Rec::default());
    let t0 = Instant::now();
    let data = case.join("jdtls-data");
    let config = case.join("jdtls-config");
    let cmd = JdtlsLaunch {
        java_exe: &home.join("ufjdk/bin/java.exe"),
        ls_dir: &ls,
        data_dir: &data,
        config_dir: &config,
        xmx_mb: 2048,
        syntax_server: false,
    }
    .command()
    .unwrap();
    let stderr_log = case.join("early-stderr.log");
    let client = LspClient::spawn_with_stderr(cmd, Arc::new(H(rec.clone(), t0)), &stderr_log)
        .expect("拉起 jdt.ls 失败");

    let root_s = root.to_string_lossy().into_owned();
    let runtime = home.join("ufjdk").to_string_lossy().into_owned();
    let init = build_initialize_params(&root_s, &runtime, std::process::id(), &[]);
    client
        .request("initialize", init, Duration::from_secs(300))
        .unwrap();
    let init_at = t0.elapsed().as_secs_f32();
    client.notify("initialized", json!({})).unwrap();
    client
        .notify(
            "workspace/didChangeConfiguration",
            json!({ "settings": build_settings(&runtime) }),
        )
        .unwrap();

    let pem_uri = path_to_uri(&probe_path.to_string_lossy());
    client
        .notify(
            "textDocument/didOpen",
            json!({ "textDocument": { "uri": pem_uri, "languageId": "java", "version": 1, "text": probe_text } }),
        )
        .unwrap();
    println!("[量] didOpen 于 {init_at:.1}s（initialize 刚返回）");

    // 每 3 秒问一次，直到拿到结果 / 就绪 / 超时
    let mut timeline: Vec<(f32, String)> = Vec::new();
    let mut first_hit: Option<f32> = None;
    let mut ready_at: Option<f32> = None;
    let deadline = Duration::from_secs(420);
    while t0.elapsed() < deadline {
        let at = t0.elapsed().as_secs_f32();
        let is_ready = rec.ready.load(Ordering::SeqCst);
        if is_ready && ready_at.is_none() {
            ready_at = Some(at);
        }
        // definition 用短超时：import 期间可能不响应，别让一次请求卡住整个循环
        let r = client.request(
            "textDocument/definition",
            json!({ "textDocument": { "uri": pem_uri }, "position": { "line": 3, "character": 6 } }),
            Duration::from_secs(8),
        );
        let desc = match &r {
            Ok(v) => {
                let n = v.as_array().map_or(0, Vec::len);
                let has_src = v
                    .as_array()
                    .and_then(|a| a.first())
                    .and_then(|f| f["targetUri"].as_str().or_else(|| f["uri"].as_str()))
                    .map(|u| !u.contains("jdt://"))
                    .unwrap_or(false);
                if n == 0 {
                    "empty".to_string()
                } else if has_src {
                    "SRC".to_string()
                } else {
                    format!("{n} 项(非源码)")
                }
            }
            Err(e) => format!(
                "timeout/err:{}",
                e.to_string().chars().take(30).collect::<String>()
            ),
        };
        println!("[量] {at:>6.1}s  ready={is_ready}  definition={desc}");
        timeline.push((at, desc.clone()));
        if first_hit.is_none() && desc == "SRC" {
            first_hit = Some(at);
        }
        // 拿到源码结果且已就绪就收工；没就绪但已能跳也够了（这本身就是结论）
        if first_hit.is_some() && ready_at.is_some() {
            break;
        }
        if first_hit.is_some() && at > first_hit.unwrap() + 12.0 {
            break;
        }
        std::thread::sleep(Duration::from_secs(3));
    }
    client.shutdown();

    let ready_at = ready_at.or(Some(t0.elapsed().as_secs_f32()));
    let mut md = String::from("# import 期间能否跳转（能否不等 ServiceReady）\n\n");
    md.push_str(&format!(
        "{} 个模块 / {} 个源文件。`initialize` 返回于 {init_at:.1}s，随后立刻 didOpen 探针。\n\n",
        mods.len(),
        files
    ));
    md.push_str("| 时刻 | 就绪 | definition |\n|---|---|---|\n");
    for (at, d) in &timeline {
        md.push_str(&format!(
            "| {at:.1}s | {} | {d} |\n",
            if ready_at.map(|r| *at >= r).unwrap_or(false) {
                "是"
            } else {
                "否"
            }
        ));
    }
    md.push_str(&format!(
        "\n## 结论\n\n- 首次拿到**源码跳转**：{}\n- ServiceReady：{}\n- 提前量：{}\n\n",
        first_hit
            .map(|t| format!("{t:.1}s"))
            .unwrap_or_else(|| "**始终没有**".into()),
        ready_at
            .map(|t| format!("{t:.1}s"))
            .unwrap_or_else(|| "未就绪".into()),
        match (first_hit, ready_at) {
            (Some(f), Some(r)) if r > f => format!("**{:.1}s**（可边导边用）", r - f),
            (Some(f), _) => format!("{f:.1}s（早于就绪）"),
            _ => "无".into(),
        }
    ));
    md.push_str(
        "> 判读：提前量显著（> 30s）⇒ 单实例渐进可用，S4 不必双进程；\n\
         > 只有就绪后才有结果 ⇒ 只能双进程。\n",
    );
    let out = perf_dir().join("shadow-s0-early.md");
    let _ = std::fs::write(&out, &md);
    println!("\n{md}");
    println!("[出] 结论：{}", out.display());
}

/// 阶段 2 的核心验收：**生产 `shadow::generate` 的 flat 形态**能不能被 jdt.ls 正确导入，
/// 且**一个实例**能跨模块跳转。
///
/// 与 `s0_flat_*` 的区别：那些是手工拼 `.classpath` 的一次性实验（`build_flat`）；这里
/// 走的是产品代码 —— `extra_modules: Some(全模块)`、per-src `output="shadow-bin/<m>"`、
/// 按「真有 .java」筛源根。跑通才算 flat 可用，也是「切模块不重启」的前提。
///
/// 耗时：`select_jars` 约 95s + 导入 130~360s，合计 4~8 分钟。
#[test]
#[ignore = "需要真实工作区 + jdt.ls + JDK8；一次全量导入 4~8 分钟"]
fn s2_生产flat_单实例跨模块跳转() {
    let ws = workspace();
    let home = nc_home();
    let ls = ls_dir();
    assert!(ls.join("plugins").is_dir(), "jdt.ls 不可用");
    assert!(home.join("ufjdk/bin/java.exe").is_file(), "JDK 不可用");

    let timeout = Duration::from_secs(
        std::env::var("NCFORGE_SCALE_TIMEOUT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(900),
    );
    let want: usize = std::env::var("NCFORGE_SCALE_MODULES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(6);
    let all = shadow::workspace_modules(&ws);
    assert!(all.len() > 1, "工作区里模块不足：{}", all.len());

    // 🔴 先找跨模块引用再定模块清单：反过来（先截断清单再找引用）会因截断后的模块之间
    //    恰好没有调用而白跑一趟（2026-11-21 踩过）。
    let Some((src_file, line, ch, other, target_cls)) = cross_module_ref(&ws, &all) else {
        panic!("{} 个模块里没找到跨模块 import", all.len());
    };
    let src_mod = src_file
        .strip_prefix(&ws)
        .ok()
        .and_then(|r| r.components().next())
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .expect("引用文件必须落在某个模块目录下");
    let mut mods = vec![src_mod.clone(), other.clone()];
    for m in &all {
        if mods.len() >= want.max(2) {
            break;
        }
        if !mods.contains(m) {
            mods.push(m.clone());
        }
    }
    println!(
        "[场] 引用 {}/{} 行{} → {}（模块 {}）；本次链 {} 个模块",
        src_mod,
        src_file.file_name().unwrap_or_default().to_string_lossy(),
        line + 1,
        target_cls,
        other,
        mods.len()
    );

    let case = perf_dir().join("s2-flat-prod");
    let _ = std::fs::remove_dir_all(&case);
    std::fs::create_dir_all(&case).unwrap();
    let shadow_dir = case.join("shadow");
    let cache = perf_dir().join("scale-class-index.bin");
    let index = ClassIndex::load_or_build(classpath_jars(&home), Some(&cache), None);

    let t_build = Instant::now();
    let project = shadow::generate(&ShadowSpec {
        workspace_root: &ws,
        module: &src_mod,
        nc_home: &home,
        shadow_dir: &shadow_dir,
        index: &index,
        extra_jars: &[],
        overrides: &[],
        extra_modules: Some(&mods),
    })
    .unwrap_or_else(|e| panic!("flat 影子生成失败：{e}"));
    let build_secs = t_build.elapsed().as_secs_f32();
    println!(
        "[量] 生产 flat 建场 {build_secs:.1}s：{} 个模块 / {} 个源文件 / {} 个 jar",
        project.modules.len(),
        project.source_files,
        project.jar_count
    );
    // 形态断言：清单里每个模块都真的链进来了（少一个就说明 sweep/筛选把它丢了）
    for m in &mods {
        assert!(
            project.modules.iter().any(|x| x == m),
            "模块 {m} 没有进影子工程：{:?}",
            project.modules
        );
        assert!(shadow_dir.join(m).is_dir(), "模块 {m} 的 junction 不存在");
    }
    // 🔴 红线：flat 的每条源根都带 output，且 output 必须落在 `shadow-bin/` 内。
    //    照抄 NC 官方的 `<模块>/classes` 会经 junction 把 class 写进用户工作区。
    let cp = std::fs::read_to_string(shadow_dir.join(".classpath")).unwrap_or_default();
    let src_entries: Vec<&str> = cp.lines().filter(|l| l.contains("kind=\"src\"")).collect();
    assert!(!src_entries.is_empty(), ".classpath 里没有源根");
    for l in &src_entries {
        assert!(
            l.contains(&format!("output=\"{}/", nc_forge::shadow::OUTPUT_DIR)),
            "源根缺 shadow-bin output：{l}"
        );
    }

    let data = case.join("jdtls-data");
    let config = case.join("jdtls-config");
    let logs = case.join("logs");
    let (client, init_secs, ready_secs, ready) = boot_flat(
        &shadow_dir,
        &data,
        &config,
        &logs,
        &home,
        &ls,
        timeout,
        false,
        "prod",
    );
    assert!(ready, "flat 实例没有就绪（{ready_secs:.1}s 超时）");

    // 🔴 必须相对**模块真实目录**再拼影子根：`Path::join(绝对路径)` 会整个替换，
    // 传绝对的 src_file 得到的是真实文件的 URI，jdt.ls 不认识 ⇒ definition 恒空。
    let rel = src_file
        .strip_prefix(ws.join(&src_mod))
        .unwrap_or_else(|_| panic!("{} 不在模块 {} 下", src_file.display(), src_mod));
    let shadow_file = shadow_dir.join(&src_mod).join(rel);
    // 自检：影子侧这份必须真的存在（junction 建错了会在这里先炸，而不是等 definition 超时）
    assert!(
        shadow_file.is_file(),
        "影子侧文件不存在：{}",
        shadow_file.display()
    );
    let uri = path_to_uri(&shadow_file.to_string_lossy());
    println!("[场] definition 起点：{}", shadow_file.display());
    let t_def = Instant::now();
    let (target_name, target_line) =
        def_site(&client, &uri, line, ch).unwrap_or_else(|e| panic!("跨模块 definition 失败：{e}"));
    let def_secs = t_def.elapsed().as_secs_f32();
    let expect = format!("{target_cls}.java");
    println!(
        "[量] 跨模块 definition {def_secs:.2}s → {target_name}:{}",
        target_line + 1
    );
    assert_eq!(
        target_name, expect,
        "跳转目标不是 {expect}（拿到 {target_name}）—— flat 导入没把两个模块连起来"
    );
    client.shutdown();

    let md = format!(
        "# 生产 flat 单实例跨模块跳转\n\n\
         > 判读：本测试**通过**才是阶段 2 可用的证据；跳错或超时说明 flat 影子工程\n\
         > 没被正确导入，别急着做阶段 3/4。\n\n\
         | 项 | 值 |\n|---|---|\n\
         | 链入模块 | {} |\n\
         | 源文件 | {} |\n\
         | jar | {} |\n\
         | 建场（含 select_jars） | {build_secs:.1}s |\n\
         | initialize 返回 | {init_secs:.1}s |\n\
         | ServiceReady | {ready_secs:.1}s |\n\
         | 跨模块 definition | {def_secs:.2}s → {target_name}:{} |\n\n\
         > 实测说 `shadow-bin`：每条源根都显式声明输出，且输出落在影子目录内 ——\n\
         > 源根是 junction，照抄官方的 `<模块>/classes` 会写进用户工作区。\n",
        project.modules.len(),
        project.source_files,
        project.jar_count,
        target_line + 1,
    );
    let out = perf_dir().join("shadow-s2-flat-prod.md");
    let _ = std::fs::write(&out, &md);
    println!("\n{md}");
    println!("[出] 结论：{}", out.display());
}

/// 找一处真实的跨模块 import：返回（引用方源文件, 行, 类名的列, 被引用方模块）。
fn cross_module_ref(ws: &Path, mods: &[String]) -> Option<(PathBuf, u32, u32, String, String)> {
    const SRCS: [&str; 3] = ["src/private", "src/public", "src/client"];
    for m in mods {
        let mut files = Vec::new();
        for d in SRCS {
            java_files(&ws.join(m).join(d), &mut files, 400);
        }
        for f in files {
            // 只看文件头：import 块一定在最前面，读全文在上万个文件上白费 I/O
            let Ok(bytes) = std::fs::read(&f) else {
                continue;
            };
            let head = &bytes[..bytes.len().min(8192)];
            let txt = String::from_utf8_lossy(head);
            for (i, line) in txt.lines().enumerate().take(80) {
                let t = line.trim();
                let Some(rest) = t.strip_prefix("import ") else {
                    continue;
                };
                let Some(fqn) = rest.strip_suffix(';') else {
                    continue;
                };
                let Some((pkg, cls)) = fqn.rsplit_once('.') else {
                    continue;
                };
                if pkg.starts_with("java.") || pkg.starts_with("javax.") {
                    continue;
                }
                let rel = format!("{}/{}.java", pkg.replace('.', "/"), cls);
                for other in mods.iter().filter(|x| *x != m) {
                    if !SRCS
                        .iter()
                        .any(|s| ws.join(other).join(s).join(&rel).is_file())
                    {
                        continue;
                    }
                    // 🔴 列号相对**原始行**算：`t` 是 trim 过的，行首有缩进时
                    // rfind 的结果会偏小（2026-11-21 在 syntax_probe 里踩过）。
                    // 类名在 import 行末尾，用 rfind 避免命中包名里的同名前缀。
                    let ch = line.rfind(cls).unwrap_or(0) as u32;
                    // 第 5 项是**被引用的类名**：跳转目标是它所在的文件，不是引用方自己
                    // （2026-11-21 首轮把 `src_file.file_name()` 当期望值，断言必错）
                    return Some((f.clone(), i as u32, ch, other.clone(), cls.to_string()));
                }
            }
        }
    }
    None
}

/// 递归收集 `.java`，最多 `limit` 个（找一处引用就够，不必扫全）。
fn java_files(dir: &Path, out: &mut Vec<PathBuf>, limit: usize) {
    if out.len() >= limit {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        if out.len() >= limit {
            return;
        }
        let p = e.path();
        if p.is_dir() {
            java_files(&p, out, limit);
        } else if p.extension().and_then(|x| x.to_str()) == Some("java") {
            out.push(p);
        }
    }
}
