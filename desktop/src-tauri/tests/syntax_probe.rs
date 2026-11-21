//! 探针：jdt.ls 的**语法服务器**（`-Dsyntaxserver=true`）能不能把冷启动从分钟级压到秒级。
//!
//! 为什么单独一个探针：语义服务器（现状）在 flat 形态下冷导 154~355s，且 **warm 无效**
//! （同一 data 目录第二次 359.1s，实测见 `target/perf/shadow-scale.md`）。也就是说
//! 「预建索引 / 二次打开」这条路已经堵死，唯一还没试的是**换一种服务器**。
//!
//! 而 0.57.0 自带语法服务器，不是新版本才有的能力 —— 反编译
//! `org.eclipse.jdt.ls.core.internal.syntaxserver.SyntaxLanguageServer` 可见它注册了
//! `textDocument/definition`、`typeDefinition`、`hover`、`documentSymbol`、
//! `completion`、`foldingRange`、`selectionRange`，开关是系统属性 `-Dsyntaxserver=true`
//! （`JDTEnvironmentUtils` 里读的就是 `syntaxserver` 这个字面量）。
//!
//! 🔴 本探针要回答**两个**问题，缺一个都不能立项：
//! 1. **能不能跨模块跳**：语法服务器不解析 classpath 上的 jar，只按源根建可见性。
//!    如果它连「A 模块 import B 模块的源码类」都跳不过去，那它对用户毫无价值。
//! 2. **启动有多快**：不 build 不解析 jar，理论上远快于语义服务器；要量出来才能判定
//!    它够不够当「双阶段」的第一阶段。
//!
//! ```bash
//! NCFORGE_SCALE_MODULES=6 cargo test --test syntax_probe -- --ignored --nocapture
//! ```
//!
//! 结论落 `desktop/target/perf/`（不能写 test-tmp：`rust-gate.mjs::wipeTmp()` 会清掉）。

#![allow(non_snake_case)]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use nc_forge::lsp::{
    build_initialize_params, build_settings, path_to_uri, JdtlsLaunch, LspClient, LspHandler,
};
use nc_forge::shadow::{self, ClasspathInputs};
use serde_json::{json, Value};

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

/// 结论落盘目录。**不能写 `..`**：`shadow::create_link` 走 `cmd /C mklink`，
/// 带 `..` 的参数会被 Rust 加引号，而 `cmd /C` 把带引号的整串当开关解析
/// （2026-11-17 最小探针实测 `无效开关 - "target"`）。所以先 canonicalize 再剥 `\\?\`。
fn perf_dir() -> PathBuf {
    let raw = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/perf");
    let _ = std::fs::create_dir_all(&raw);
    let canon = raw.canonicalize().unwrap_or(raw);
    let owned = canon.to_string_lossy().into_owned();
    PathBuf::from(owned.strip_prefix(r"\\?\").unwrap_or(&owned))
}

struct Rec {
    ready: AtomicBool,
    stages: Mutex<Vec<(String, f32)>>,
    messages: Mutex<Vec<String>>,
}

struct H(Arc<Rec>, Instant);

impl H {
    fn new() -> (Arc<Rec>, Self) {
        let rec = Arc::new(Rec {
            ready: AtomicBool::new(false),
            stages: Mutex::new(Vec::new()),
            messages: Mutex::new(Vec::new()),
        });
        let handler = H(rec.clone(), Instant::now());
        (rec, handler)
    }
}

impl LspHandler for H {
    fn on_notification(&self, method: &str, params: Value) {
        if method != "language/status" {
            return;
        }
        let kind = params["type"].as_str().unwrap_or_default().to_string();
        self.0
            .stages
            .lock()
            .unwrap()
            .push((kind.clone(), self.1.elapsed().as_secs_f32()));
        let msg = params["message"].as_str().unwrap_or_default();
        // 语义服务器发 `type=ServiceReady`；语法服务器实测发的是
        // `type=Started` + `message=LightWeightServiceReady`（2026-11-21 实测），
        // 只认 type 会一直判「未就绪」。
        if kind == "ServiceReady" || msg.contains("ServiceReady") {
            self.0.ready.store(true, Ordering::SeqCst);
        }
        if !msg.is_empty() {
            self.0.messages.lock().unwrap().push(msg.to_string());
        }
    }

    fn on_request(&self, method: &str, params: &Value) -> Value {
        // 与生产一致：`workspace/configuration` 必须真答，否则 jdt.ls 卡在初始化
        if method == "workspace/configuration" {
            let n = params["items"].as_array().map_or(1, Vec::len).max(1);
            let runtime = nc_home().join("ufjdk").to_string_lossy().into_owned();
            return Value::Array((0..n).map(|_| build_settings(&runtime)).collect());
        }
        Value::Null
    }
}

/// 递归收集 `.java`，到 `cap` 就停（只用来找一处引用，不需要全量）。
fn java_files(dir: &Path, out: &mut Vec<PathBuf>, cap: usize) {
    if out.len() >= cap {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            java_files(&p, out, cap);
        } else if p.extension().is_some_and(|x| x == "java") {
            out.push(p);
        }
        if out.len() >= cap {
            return;
        }
    }
}

/// 找一处「本模块 import 了另一个项目内模块的类」，返回 `(源文件, 行, 列, 目标模块)`。
///
/// 判据是**目标 `.java` 真的存在于另一个已链模块的源根下** —— 只有这种引用才能证明
/// 语法服务器具备跨源根跳转能力；跳 jar 里的类它本来就做不到（不解析 classpath）。
fn cross_module_ref(ws: &Path, mods: &[String]) -> Option<(PathBuf, u32, u32, String)> {
    const SRCS: [&str; 3] = ["src/private", "src/public", "src/client"];
    for m in mods {
        let mut files = Vec::new();
        for d in SRCS {
            java_files(&ws.join(m).join(d), &mut files, 200);
        }
        for f in files {
            // 只看文件头：import 块一定在最前面，读全文在 7517 个文件上白费 I/O
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
                    // 类名在 import 行末尾，用 rfind 避免命中包名里的同名前缀
                    let ch = t.rfind(cls).unwrap_or(0) as u32;
                    return Some((f.clone(), i as u32, ch, other.clone()));
                }
            }
        }
    }
    None
}

/// 造 flat 影子：只链模块 + 声明源根，**不给任何 jar**。
///
/// 语法服务器不解析 classpath，给 jar 只是浪费 —— 而这正好让本探针几秒建场，
/// 不必付 `select_jars` 那 95s。
fn build_shadow(base: &Path, ws: &Path, mods: &[String]) -> (PathBuf, usize) {
    let root = base.join("syntax-ws");
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::create_dir_all(root.join(".settings"));
    let mut src_dirs: Vec<String> = Vec::new();
    let mut files = 0;
    for m in mods {
        if shadow::ensure_link(&root.join(m), &ws.join(m), &mut Vec::new()).is_err() {
            continue;
        }
        for d in ["src/public", "src/client", "src/private"] {
            if ws.join(m).join(d).is_dir() {
                src_dirs.push(format!("{m}/{d}"));
            }
        }
        let mut v = Vec::new();
        java_files(&ws.join(m), &mut v, usize::MAX);
        files += v.len();
    }
    std::fs::write(root.join(".project"), shadow::render_project()).unwrap();
    let xml = shadow::render_classpath(&ClasspathInputs {
        src_dirs: &src_dirs,
        src_outputs: &[],
        class_dirs: &[],
        jars: &[],
    });
    std::fs::write(root.join(".classpath"), xml).unwrap();
    (root, files)
}

/// `definition` 的目标 URI 与起始行（失败返回原因，便于诊断）。
fn def_target(client: &LspClient, uri: &str, line: u32, ch: u32) -> Result<(String, u32), String> {
    let v = client
        .request(
            "textDocument/definition",
            json!({ "textDocument": { "uri": uri }, "position": { "line": line, "character": ch } }),
            Duration::from_secs(30),
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
        .ok_or_else(|| {
            let s = v.to_string();
            format!("无目标：{}", s.chars().take(160).collect::<String>())
        })?;
    let range = if first["range"].is_object() {
        &first["range"]
    } else {
        &first["targetRange"]
    };
    Ok((
        target.to_string(),
        range["start"]["line"].as_u64().unwrap_or(0) as u32,
    ))
}

#[test]
#[ignore = "实测探针：真起 jdt.ls（语法模式）+ 真实工作区，约 1~3 分钟"]
fn 语法服务器_跨模块跳转与启动耗时() {
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
        .unwrap_or(6);
    let all = shadow::workspace_modules(&ws);
    assert!(all.len() > 1, "工作区里模块不足：{}", all.len());

    // 🔴 先找一处真实跨模块引用，再决定链哪些模块 —— 反过来（先截断模块再找）
    // 会因为截断后的模块之间恰好没有调用而白跑一趟（第一版就是这么失败的）。
    let Some((real_file, line, ch, other)) = cross_module_ref(&ws, &all) else {
        panic!("{} 个模块里没找到跨模块 import，无法验证跳转", all.len());
    };
    let src_mod = real_file
        .strip_prefix(&ws)
        .ok()
        .and_then(|r| r.components().next())
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .expect("引用文件必须落在一个模块目录下");
    let mut mods = vec![src_mod.clone(), other.clone()];
    for m in &all {
        if mods.len() >= want.max(2) {
            break;
        }
        if !mods.contains(m) {
            mods.push(m.clone());
        }
    }

    let base = perf_dir().join("syntax-probe");
    let _ = std::fs::create_dir_all(&base);
    let t = Instant::now();
    let (root, files) = build_shadow(&base, &ws, &mods);
    println!(
        "[量] 建场 {:.1}s：{} 个模块 / {} 个源文件（不选 jar）",
        t.elapsed().as_secs_f32(),
        mods.len(),
        files
    );
    let rel = real_file.strip_prefix(&ws).unwrap();
    let shadow_file = root.join(rel);
    let uri = path_to_uri(&shadow_file.to_string_lossy());
    println!(
        "[量] 待测引用：{}:{}:{} → 目标模块 {}",
        rel.display(),
        line + 1,
        ch,
        other
    );

    let (rec, handler) = H::new();
    let t0 = Instant::now();
    let cmd = JdtlsLaunch {
        java_exe: &home.join("ufjdk/bin/java.exe"),
        ls_dir: &ls,
        data_dir: &base.join("jdtls-data"),
        config_dir: &base.join("jdtls-config"),
        xmx_mb: 2048,
        syntax_server: true,
    }
    .command()
    .expect("组装命令失败");
    let client = LspClient::spawn_with_stderr(cmd, Arc::new(handler), &base.join("stderr.log"))
        .expect("拉起语法服务器失败");
    let root_s = root.to_string_lossy().into_owned();
    let runtime = home.join("ufjdk").to_string_lossy().into_owned();
    let init = build_initialize_params(&root_s, &runtime, std::process::id(), &[]);
    client
        .request("initialize", init, Duration::from_secs(180))
        .expect("initialize 失败");
    let init_secs = t0.elapsed().as_secs_f32();
    client.notify("initialized", json!({})).unwrap();
    client
        .notify(
            "workspace/didChangeConfiguration",
            json!({ "settings": build_settings(&runtime) }),
        )
        .unwrap();
    client
        .notify(
            "textDocument/didOpen",
            json!({ "textDocument": {
                "uri": uri,
                "languageId": "java",
                "version": 1,
                "text": std::fs::read_to_string(&shadow_file).unwrap_or_default(),
            }}),
        )
        .unwrap();

    // ready 与「definition 出结果」分别计时：语法服务器可能不发 ServiceReady，
    // 那时只能靠 definition 轮询判活，两个数都要留痕
    let deadline = Instant::now() + Duration::from_secs(300);
    let mut ready_secs = None;
    let mut first_hit: Option<(f32, String, u32)> = None;
    let mut last_err = String::from("（一次都没发出）");
    let mut symbol = String::from("（未测）");
    let mut symbol_done = false;
    while Instant::now() < deadline {
        if ready_secs.is_none() && rec.ready.load(Ordering::SeqCst) {
            ready_secs = Some(t0.elapsed().as_secs_f32());
        }
        // 🔴 definition 拿不到结果时，必须分清是「服务端不响应」还是「响应了但解析不到」。
        // documentSymbol 最便宜 —— 它只要把文件读进来就能答。
        if !symbol_done && rec.ready.load(Ordering::SeqCst) {
            symbol_done = true;
            symbol = match client.request(
                "textDocument/documentSymbol",
                json!({ "textDocument": { "uri": uri } }),
                Duration::from_secs(30),
            ) {
                Ok(v) => format!(
                    "documentSymbol → {}",
                    v.to_string().chars().take(120).collect::<String>()
                ),
                Err(e) => format!("documentSymbol 失败：{e}"),
            };
        }
        match def_target(&client, &uri, line, ch) {
            Ok((target, tl)) => {
                first_hit = Some((t0.elapsed().as_secs_f32(), target, tl));
                break;
            }
            Err(e) => {
                last_err = e;
                std::thread::sleep(Duration::from_secs(2));
            }
        }
    }
    let stages = rec.stages.lock().unwrap().clone();
    let messages = rec.messages.lock().unwrap().clone();
    client.shutdown();

    let md = format!(
        "## 语法服务器探针（{} 个模块 / {} 个源文件）\n\n\
         | 项 | 实测 |\n|---|---|\n\
         | initialize 返回 | {init_secs:.1}s |\n\
         | ServiceReady | {} |\n\
         | 首次 definition 命中 | {} |\n\
         | 命中目标 | {} |\n\
         | 是否跨模块 | {} |\n\
         | 最后一次失败原因 | {} |\n\
         | 文件是否被解析 | {} |\n\n\
         状态轨迹：`{}`\n\n近期消息：{}\n",
        mods.len(),
        files,
        ready_secs
            .map(|s| format!("{s:.1}s"))
            .unwrap_or_else(|| "**未收到**".into()),
        first_hit
            .as_ref()
            .map(|(s, ..)| format!("{s:.1}s"))
            .unwrap_or_else(|| "**300s 内没有结果**".into()),
        first_hit
            .as_ref()
            .map(|(_, t, l)| format!("`{}` 行 {}", t.rsplit('/').next().unwrap_or(t), l + 1))
            .unwrap_or_else(|| "—".into()),
        match &first_hit {
            Some((_, t, _)) => {
                if t.contains(&other) {
                    "**是**".to_string()
                } else {
                    "否（回到了自己模块）".to_string()
                }
            }
            None => "—".into(),
        },
        last_err.chars().take(200).collect::<String>(),
        symbol,
        stages
            .iter()
            .map(|(k, s)| format!("{k}@{s:.1}s"))
            .collect::<Vec<_>>()
            .join(" → "),
        messages
            .iter()
            .rev()
            .take(6)
            .cloned()
            .collect::<Vec<_>>()
            .join(" / ")
    );
    println!("\n{md}");
    let out = perf_dir().join("syntax-probe.md");
    let _ = std::fs::write(&out, &md);
    println!("[出] 结论：{}", out.display());
}
