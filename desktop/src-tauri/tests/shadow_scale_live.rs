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
    } else if let Some(i) = p.rfind("/out/") {
        &p[i + "/out/".len()..]
    } else {
        return None;
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
/// 手工拼 `.classpath`：`shadow::generate` 只支持单模块，这里把每个模块的源根
/// 都塞进同一个 project。jar 段沿用 ic 的（够解析用，实测关注的是源根数量的影响）。
fn build_flat(
    base: &Path,
    ws: &Path,
    mods: &[String],
    index: &ClassIndex,
    home: &Path,
) -> (PathBuf, usize, usize, u64) {
    let root = base.join("flat-ws");
    let _ = std::fs::create_dir_all(root.join(".settings"));
    // 先用生产逻辑生成 ic 那份，拿到 jar / class 目录段
    let spec = ShadowSpec {
        workspace_root: ws,
        module: "ic",
        nc_home: home,
        shadow_dir: &root,
        index,
        extra_jars: &[],
        overrides: &[],
    };
    let mut files = 0;
    if let Ok(p) = shadow::generate(&spec) {
        files += p.source_files;
    }
    // 其余模块建 junction 并追加源根
    let mut extra_src = String::new();
    for m in mods.iter().filter(|m| m.as_str() != "ic") {
        let link = root.join(m);
        if !link.exists() {
            let _ = shadow::ensure_link(&link, &ws.join(m), &mut Vec::new());
        }
        for s in ["src/public", "src/client", "src/private"] {
            if ws.join(m).join(s).is_dir() {
                extra_src.push_str(&format!(
                    "\t<classpathentry kind=\"src\" path=\"{m}/{s}\"/>\n"
                ));
            }
        }
        files += count_java(&ws.join(m));
    }
    let cp_path = root.join(".classpath");
    if let Ok(xml) = std::fs::read_to_string(&cp_path) {
        // 插到 JRE_CONTAINER 之前，保持「源码在前」的既有顺序约定
        let anchor = "<classpathentry kind=\"con\"";
        let merged = match xml.find(anchor) {
            Some(i) => {
                let head = xml[..i].trim_end();
                format!("{head}\n{extra_src}{}", &xml[i..])
            }
            None => xml.replace("</classpath>", &format!("{extra_src}</classpath>")),
        };
        let _ = std::fs::write(&cp_path, merged);
    }
    let kb = std::fs::metadata(&cp_path).map(|x| x.len()).unwrap_or(0) / 1024;
    (root, 1, files, kb)
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
