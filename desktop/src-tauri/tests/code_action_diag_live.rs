//! 真机对照：`textDocument/codeAction` 传诊断 vs 传空数组，返回条数差多少。
//!
//! 🔴 这是 G3-b 的**结案证据**，不是可选的补充测试。
//! 2026-11-17 反编译随包 jdt.ls 0.57 得到的因果链：
//!   · `CodeActionHandler.getProblemLocationCores(unit, params.getContext().getDiagnostics())`
//!     ⇒ problem 位置**只**来自客户端传入的诊断，没有「按 range 反查服务端那份」的逻辑；
//!   · `CodeActionHandler.getProblemId` 把 `diagnostic.code` 解析成整数，失败给 0；
//!   · `QuickFixProcessor.getCorrections` 见 `locations.length == 0` 直接 `return emptyList()`，
//!     `process` 见 `id == 0` 也直接 return。
//! 推论：传空数组 ⇒ 一条 quickfix 都拿不到。本测试用真实会话证明它，并证明传真实诊断能拿到。
//!
//! 默认不跑（`#[ignore]`）：要本机有 JDK 8 与裁剪好的 jdt.ls（CI 上没有）。
//!
//! ```bash
//! cargo test --test code_action_diag_live -- --ignored --nocapture --test-threads=1
//! ```

#![allow(non_snake_case)]

use nc_forge::lsp::{build_initialize_params, path_to_uri, JdtlsLaunch, LspClient, LspHandler};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[path = "../src/test_support.rs"]
mod test_support;

/// 收 `textDocument/publishDiagnostics`：对照要用的诊断必须是**服务端自己发的那份原件**，
/// 不能自己造（造的 code 未必是真 problem id，那样测出来的绿是假的）。
/// 同时收 `language/status` 的 `ServiceReady` —— 工程导入完成才有它。
#[derive(Default)]
struct CollectDiags {
    latest: Mutex<Vec<Value>>,
    ready: Mutex<bool>,
}
impl LspHandler for CollectDiags {
    fn on_notification(&self, method: &str, params: Value) {
        if method == "language/status" && params["type"] == "ServiceReady" {
            *self.ready.lock().unwrap() = true;
            return;
        }
        if method != "textDocument/publishDiagnostics" {
            return;
        }
        if let Some(list) = params["diagnostics"].as_array() {
            *self.latest.lock().unwrap() = list.clone();
        }
    }
}

fn temp(tag: &str) -> PathBuf {
    // 走共享 helper（`src/test_support.rs`）而不是裸 `temp_dir()`：它返回 canonicalize
    // 后的路径，jdt.ls 回传的 URI 与本机断言才在三个平台上一致。
    // integration 测试拿不到 crate 内部的 `cfg(test)` 模块，所以直接包含源文件
    // （与 `java_editing_live.rs` 同一写法）。
    test_support::tmp(&format!("ca-diag-{tag}"))
}
fn java_home() -> PathBuf {
    std::env::var("NCFORGE_JAVA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(r"D:\ncc\1909home\ufjdk"))
}

fn ls_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("NCFORGE_JDTLS_DIR") {
        return PathBuf::from(dir);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/jdtls")
}

/// 造一个**有 quickfix 可用**的错误：未使用的 import。
/// jdt.ls 对它会给「移除未使用的导入」等提案，且不依赖外部依赖，最稳。
///
/// 🔴 工程形态照抄已验证可行的 `java_completion_live.rs`：单行 `.project`、
/// `render_classpath` 生成的 `.classpath`、源码放在 `src/<package>/` 下。
/// 手写多行 XML + 裸 `src` 的版本实测**不被 0.57 导入**（只建兜底
/// `jdt.ls-java-project`，`workspace/symbol` 永远查不到类）。
fn write_project(ws: &Path) -> PathBuf {
    let src = ws.join("src/demo");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(
        ws.join(".project"),
        "<projectDescription><name>ca-diag-live</name><buildSpec><buildCommand><name>org.eclipse.jdt.core.javabuilder</name></buildCommand></buildSpec><natures><nature>org.eclipse.jdt.core.javanature</nature></natures></projectDescription>",
    )
    .unwrap();
    std::fs::write(
        ws.join(".classpath"),
        nc_forge::shadow::render_classpath(&nc_forge::shadow::ClasspathInputs {
            src_dirs: &["src".into()],
            class_dirs: &[],
            jars: &[],
        }),
    )
    .unwrap();
    let file = src.join("Unused.java");
    // 第 1 行（0 基 0）是 package，第 2 行（0 基 1）是未使用的 import
    std::fs::write(
        &file,
        "package demo;\n\nimport java.util.List;\n\npublic class Unused {\n    int add(int a, int b) {\n        return a + b;\n    }\n}\n",
    )
    .unwrap();
    file
}

fn wait_symbols(client: &LspClient) {
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        let found = client
            .request(
                "workspace/symbol",
                json!({ "query": "Unused" }),
                Duration::from_secs(20),
            )
            .ok()
            .and_then(|v| v.as_array().cloned())
            .is_some_and(|a| {
                a.iter()
                    .any(|s| s["name"] == "Unused" && s["location"]["uri"].as_str().is_some())
            });
        if found {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "90 秒内 jdt.ls 还没解析出 Unused"
        );
        std::thread::sleep(Duration::from_millis(1000));
    }
}

/// 等服务端把诊断推过来（建索引期间会连推多份，取最后一份非空的）。
fn wait_diags(handler: &CollectDiags) -> Vec<Value> {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        {
            let list = handler.latest.lock().unwrap();
            if !list.is_empty() {
                return list.clone();
            }
        }
        assert!(Instant::now() < deadline, "60 秒内没收到任何诊断");
        std::thread::sleep(Duration::from_millis(500));
    }
}

fn count_actions(res: &Value) -> usize {
    res.as_array().map(|a| a.len()).unwrap_or(0)
}

#[test]
#[ignore = "要本机 JDK 8 + 裁剪好的 jdt.ls"]
fn 传真实诊断能拿到快速修复而传空数组拿不到() {
    let jh = java_home();
    if !jh.join("bin/java.exe").is_file() || !ls_dir().join("plugins").is_dir() {
        eprintln!("跳过：本机没有 JDK 8 或 jdt.ls");
        return;
    }
    let base = temp("compare");
    let ws = base.join("ws");
    let file = write_project(&ws);

    let data = base.join("data");
    let cfg = base.join("cfg");
    let launch = JdtlsLaunch {
        java_exe: &jh.join("bin/java.exe"),
        ls_dir: &ls_dir(),
        data_dir: &data,
        config_dir: &cfg,
        xmx_mb: 1024,
    };
    let handler = Arc::new(CollectDiags::default());
    // stderr 落盘：jdt.ls 起不来时唯一的线索在这里（默认 spawn 会丢进 NUL）。
    let err_log = base.join("jdtls-stderr.log");
    let lsp = LspClient::spawn_with_stderr(launch.command().unwrap(), handler.clone(), &err_log)
        .expect("jdt.ls 起不来");
    lsp.request(
        "initialize",
        build_initialize_params(
            &ws.to_string_lossy(),
            &jh.to_string_lossy(),
            std::process::id(),
            &[],
        ),
        Duration::from_secs(120),
    )
    .expect("initialize");
    // 🔴 必须发 `initialized` 通知：LSP 握手是 initialize（请求）+ initialized（通知）两步，
    // jdt.ls 收到后者才开始导入工作区工程。漏了它只会创建兜底的 `jdt.ls-java-project`，
    // 自己的工程一条都不导入 ⇒ `workspace/symbol` 永远查不到类，表现为「90 秒超时」。
    // 产品侧在 `shadow.rs:726` 有这一步；`refactor_live.rs` 漏了，所以它在本机也是红的。
    lsp.notify("initialized", json!({})).expect("initialized");
    // 🔴 还要推一次配置：jdt.ls 拿到 runtime 设置后才真正导入工作区工程。
    // 完整握手 = initialize → initialized → didChangeConfiguration → 等 ServiceReady，
    // 与产品侧 `shadow.rs:718-734` 一致。少任何一步都只会有兜底工程 `jdt.ls-java-project`。
    lsp.notify(
        "workspace/didChangeConfiguration",
        json!({ "settings": nc_forge::lsp::build_settings(&jh.to_string_lossy()) }),
    )
    .expect("didChangeConfiguration");
    let ready_deadline = Instant::now() + Duration::from_secs(120);
    while !*handler.ready.lock().unwrap() {
        if Instant::now() >= ready_deadline {
            // 让服务端自己说它导入了哪些工程 —— 比猜 rootUri 形态可靠。
            let projects = lsp.request("java/project.getAll", json!({}), Duration::from_secs(20));
            eprintln!("rootUri = {}", path_to_uri(&ws.to_string_lossy()));
            eprintln!("java/project.getAll → {projects:?}");
            let log = std::fs::read_to_string(base.join("data/.metadata/.log")).unwrap_or_default();
            let lines: Vec<&str> = log.lines().collect();
            let from = lines.len().saturating_sub(30);
            eprintln!("── .metadata/.log 尾部 ──\n{}", lines[from..].join("\n"));
            lsp.shutdown();
            panic!("jdt.ls 没在 120 秒内 ServiceReady");
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    // 就绪等待失败时把 stderr 尾部打出来，否则「90 秒没解析出符号」无从定位。
    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| wait_symbols(&lsp))).is_err() {
        let tail = std::fs::read_to_string(&err_log).unwrap_or_default();
        let lines: Vec<&str> = tail.lines().collect();
        let from = lines.len().saturating_sub(60);
        eprintln!("── jdt.ls stderr 尾部 ──\n{}", lines[from..].join("\n"));
        lsp.shutdown();
        panic!(
            "jdt.ls 未就绪，stderr 见上（日志留在 {}）",
            err_log.display()
        );
    }

    let uri = path_to_uri(&file.to_string_lossy());
    let text = std::fs::read_to_string(&file).unwrap();
    lsp.notify(
        "textDocument/didOpen",
        json!({
            "textDocument": { "uri": uri, "languageId": "java", "version": 1, "text": text },
        }),
    )
    .unwrap();

    let diags = wait_diags(&handler);
    eprintln!("服务端推来的诊断：{diags:#?}");
    // 诊断必须带 code，否则本对照本身就没意义（服务端按 code 匹配 problem id）
    let with_code: Vec<&Value> = diags.iter().filter(|d| !d["code"].is_null()).collect();
    assert!(
        !with_code.is_empty(),
        "诊断里没有 code，无法做对照：{diags:#?}"
    );

    // 取第一条带 code 的诊断所在的 range 作为请求范围（模拟光标落在那个问题上）
    let target = with_code[0];
    let range = target["range"].clone();

    let ask = |diagnostics: Value| -> Value {
        lsp.request(
            "textDocument/codeAction",
            json!({
                "textDocument": { "uri": uri },
                "range": range,
                "context": { "diagnostics": diagnostics },
            }),
            Duration::from_secs(60),
        )
        .expect("codeAction 应成功")
    };

    // ① 修复前的行为：传空数组
    let empty = ask(json!([]));
    let empty_n = count_actions(&empty);
    let empty_titles: Vec<String> = empty
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x["title"].as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    eprintln!("传空数组 → {empty_n} 条：{empty_titles:?}");

    // ② 修复后的行为：传服务端自己那份诊断（只传相交的，与前端 pickCodeActionDiagnostics 同口径）
    let full = ask(json!(diags));
    let full_n = count_actions(&full);
    let full_titles: Vec<String> = full
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x["title"].as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    eprintln!("传真实诊断 → {full_n} 条：{full_titles:?}");

    lsp.shutdown();
    let _ = std::fs::remove_dir_all(&base);

    // 🔴 核心断言：传诊断必须比传空多拿到东西。
    // 若两者相等，说明「空数组堵死 quickfix」这个结论不成立，修法的 premise 就错了。
    assert!(
        full_n > empty_n,
        "传真实诊断({full_n})必须多于传空数组({empty_n})，否则 G3-b 的因果结论不成立。\n空：{empty_titles:?}\n全：{full_titles:?}"
    );
}
