//! 探针 A：java-debug 0.32 到底支持哪些调试能力。
//!
//! 本文件**不验证产品行为**，只回答三个问题，结论决定后续三件功能的实现路径：
//!   1. `initialize` 的 capabilities 里有没有 supportsRestartFrame（→ drop frame 走不走 DAP）、
//!      supportsFunctionBreakpoints / supportsDataBreakpoints（→ 方法断点 / 字段观察点能否走 DAP）。
//!   2. `restartFrame` / `setFunctionBreakpoints` / `setDataBreakpoints` 三个请求真实发下去，
//!      适配器是 -32601（没实现）还是 -32001（不支持）还是能成。
//!   3. 多线程目标停止时 `stopped.allThreadsStopped` 是什么值（→ 挂起策略能不能只停一个线程）。
//!
//! 默认 `#[ignore]`，要本机 JDK 8 + 裁剪好的 jdt.ls（含 java-debug.jar）：
//!
//! ```bash
//! node scripts/rust-gate.mjs test --no-default-features --test debug_caps_probe -- --ignored --nocapture --test-threads=1
//! ```
//!
//! 路径可用 `NCFORGE_JAVA_HOME` / `NCFORGE_JDTLS_DIR` 覆盖。

#![allow(non_snake_case)]

#[path = "../src/test_support.rs"]
mod test_support;

use nc_forge::debug::{self, DapClient, DapHandler};
use nc_forge::lsp::{build_initialize_params, JdtlsLaunch, LspClient, LspHandler};
use serde_json::{json, Value};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};

const PROJECT: &str = "caps-live";

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

fn debug_jar() -> PathBuf {
    ls_dir().join("java-debug/com.microsoft.java.debug.plugin-0.32.0.jar")
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .expect("要一个空闲端口")
}

struct Quiet;
impl LspHandler for Quiet {
    fn on_notification(&self, _method: &str, _params: Value) {}
}

/// 适配器事件全收进通道：本探针要的第一份事实就是 `stopped` 的完整 body
/// （`allThreadsStopped` 在不在、是什么）。
struct Events(Sender<(String, Value)>);
impl DapHandler for Events {
    fn on_event(&self, event: &str, body: Value) {
        eprintln!("  [DAP event] {event} {}", compact(&body));
        let _ = self.0.send((event.to_string(), body));
    }
}

struct Target {
    child: Child,
    out: PathBuf,
}

impl Drop for Target {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Ok(log) = std::fs::read_to_string(&self.out) {
            if !log.trim().is_empty() {
                eprintln!("── 目标进程输出 ──\n{log}");
            }
        }
    }
}

/// 目标故意留**两个**线程：main 打转 + 一个 daemon 休眠。
/// 没有第二个线程就没法观察"停一个"和"停全部"的区别。
/// 第 5 行是 main 循环的必经行（断点必须命中）；bg 线程第 7 行起。
fn write_project(ws: &Path) {
    let src = ws.join("src");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(
        ws.join(".project"),
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<projectDescription>
  <name>{PROJECT}</name>
  <buildSpec>
    <buildCommand><name>org.eclipse.jdt.core.javabuilder</name></buildCommand>
  </buildSpec>
  <natures><nature>org.eclipse.jdt.core.javanature</nature></natures>
</projectDescription>
"#
        ),
    )
    .unwrap();
    std::fs::write(
        ws.join(".classpath"),
        r#"<?xml version="1.0" encoding="UTF-8"?>
<classpath>
  <classpathentry kind="src" path="src"/>
  <classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/>
  <classpathentry kind="output" path="bin"/>
</classpath>
"#,
    )
    .unwrap();
    std::fs::write(
        src.join("Caps.java"),
        r#"public class Caps {
    static int total = 0;
    public static void main(String[] args) throws Exception {
        for (int i = 1; i <= 200; i++) {
            total += i;
            if (i == 1) {
                Thread bg = new Thread(() -> {
                    try { Thread.sleep(600_000); } catch (InterruptedException ignored) {}
                }, "bg-sleeper");
                bg.setDaemon(true);
                bg.start();
            }
            Helper.pause();
        }
        System.out.println("total=" + total);
    }
}
class Helper {
    static void pause() throws Exception { Thread.sleep(120); }
}
"#,
    )
    .unwrap();
}

fn compile(java_home: &Path, ws: &Path) {
    std::fs::create_dir_all(ws.join("bin")).unwrap();
    let status = Command::new(java_home.join("bin/javac.exe"))
        .arg("-g")
        .arg("-d")
        .arg(ws.join("bin"))
        .arg(ws.join("src/Caps.java"))
        .status()
        .expect("javac 起不来");
    assert!(status.success(), "Caps.java 编译失败");
}

fn start_target(java_home: &Path, ws: &Path, jdwp_port: u16, out: &Path) -> Target {
    let file = std::fs::File::create(out).unwrap();
    let err = file.try_clone().unwrap();
    let child = Command::new(java_home.join("bin/java.exe"))
        .arg(format!(
            "-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:{jdwp_port}"
        ))
        .arg("-cp")
        .arg(ws.join("bin"))
        .arg("Caps")
        .stdout(Stdio::from(file))
        .stderr(Stdio::from(err))
        .spawn()
        .expect("java 起不来");
    let mut target = Target {
        child,
        out: out.to_path_buf(),
    };
    std::thread::sleep(Duration::from_millis(1500));
    if let Ok(Some(code)) = target.child.try_wait() {
        let log = std::fs::read_to_string(out).unwrap_or_default();
        panic!("目标进程自己退了（{code}）：\n{log}");
    }
    target
}

fn wait_project_ready(client: &LspClient) {
    let deadline = Instant::now() + Duration::from_secs(90);
    let mut round = 0;
    loop {
        if Instant::now() > deadline {
            panic!("90 秒内 jdt.ls 还没解析出 Caps");
        }
        round += 1;
        let symbols = client
            .request(
                "workspace/symbol",
                json!({ "query": "Caps" }),
                Duration::from_secs(20),
            )
            .unwrap_or(Value::Null);
        if round <= 3 || round % 5 == 0 {
            eprintln!("  [workspace/symbol #{round}] {symbols}");
        }
        let found = symbols
            .as_array()
            .is_some_and(|a| a.iter().any(|s| s["name"] == "Caps"));
        let located = symbols
            .as_array()
            .is_some_and(|a| a.iter().any(|s| s["location"]["uri"].as_str().is_some()));
        if found && located {
            return;
        }
        // 每 10 轮交叉验证一次：jdt.ls 眼里的工程与源路径到底是什么
        if round == 10 {
            let all = client
                .request(
                    "workspace/executeCommand",
                    json!({ "command": "java.project.getAll", "arguments": [null, null] }),
                    Duration::from_secs(20),
                )
                .unwrap_or(Value::Null);
            eprintln!("  [java.project.getAll] {all}");
            let cps = client
                .request(
                    "workspace/executeCommand",
                    json!({ "command": "java.project.getClasspaths", "arguments": [null, json!({"scope":"runtime"})] }),
                    Duration::from_secs(20),
                )
                .unwrap_or(Value::Null);
            eprintln!("  [java.project.getClasspaths] {cps}");
        }
        std::thread::sleep(Duration::from_millis(1000));
    }
}

fn ask_port(client: &LspClient) -> u16 {
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        let res = client
            .request(
                "workspace/executeCommand",
                json!({ "command": "vscode.java.startDebugSession", "arguments": [] }),
                Duration::from_secs(30),
            )
            .unwrap_or(Value::Null);
        let port = res
            .as_u64()
            .and_then(|n| u16::try_from(n).ok())
            .or_else(|| res.as_str().and_then(|s| s.trim().parse().ok()));
        if let Some(p) = port.filter(|p| *p > 0) {
            return p;
        }
        if Instant::now() > deadline {
            panic!("java-debug 没给端口，最后一次回复：{res}");
        }
        std::thread::sleep(Duration::from_millis(1000));
    }
}

/// 发一个请求，**不管成败**，把结果或错误原样打出来。
/// 探针的全部意义就在于这份原始输出：成功/失败都是事实。
fn probe(client: &DapClient, command: &str, args: Value, secs: u64) {
    let shown = if args.is_null() {
        "{}".to_string()
    } else {
        args.to_string()
    };
    eprintln!("\n──── probe: {command} {shown}");
    match client.request(command, args, Duration::from_secs(secs)) {
        Ok(body) => eprintln!("  → OK: {}", compact(&body)),
        Err(e) => eprintln!("  → ERR: {e}"),
    }
}

fn compact(v: &Value) -> String {
    let s = v.to_string();
    if s.len() > 1200 {
        format!("{}…（截断，共 {} 字符）", &s[..1200], s.len())
    } else {
        s
    }
}

fn wait_stopped(rx: &Receiver<(String, Value)>, secs: u64) -> Value {
    let deadline = Instant::now() + Duration::from_secs(secs);
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            panic!("{secs} 秒内没等到 stopped 事件");
        }
        match rx.recv_timeout(left) {
            Ok((e, body)) if e == "stopped" => return body,
            Ok(_) => continue,
            Err(RecvTimeoutError::Timeout) => panic!("{secs} 秒内没等到 stopped 事件"),
            Err(RecvTimeoutError::Disconnected) => panic!("适配器连接断了，没等到 stopped"),
        }
    }
}

#[test]
#[ignore = "要本机 JDK 8 + 裁剪好的 jdt.ls（含 java-debug.jar）；探针，输出即结论"]
fn java_debug_capabilities_探针() {
    let jh = java_home();
    if !jh.join("bin/java.exe").is_file() || !jh.join("bin/javac.exe").is_file() {
        eprintln!("跳过：{} 下没有 JDK 8", jh.display());
        return;
    }
    let jar = debug_jar();
    if !jar.is_file() {
        eprintln!("跳过：没有 java-debug.jar（{}）", jar.display());
        return;
    }

    // 🔴 不能用系统 Temp 目录：`IMPORT_EXCLUSIONS` 里有 `**/temp/**`，
    // 路径落在 AppData\Local\Temp 下会被整条排除，jdt.ls 只建默认 invisible project，
    // workspace/symbol 永远为空（2026-11-18 实测：java_debug_live 同款症状的根因）。
    // 也不能 canonicalize：`\\?\` 前缀 equinox 启动器不吃，jdt.ls 秒退。
    // 所以：target/probe-tmp 下手工拼路径，两者都避开。
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target/probe-tmp")
        .join(format!("caps-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();
    let ws = base.join("ws");
    write_project(&ws);
    compile(&jh, &ws);

    let jdwp_port = free_port();
    let _target = start_target(&jh, &ws, jdwp_port, &base.join("target.log"));

    let launch = JdtlsLaunch {
        java_exe: &jh.join("bin/java.exe"),
        ls_dir: &ls_dir(),
        data_dir: &base.join("data"),
        config_dir: &base.join("cfg"),
        xmx_mb: 1024,
    };
    let lsp = LspClient::spawn_with_stderr(
        launch.command().unwrap(),
        Arc::new(Quiet),
        &base.join("jdtls.log"),
    )
    .expect("jdt.ls 起不来");
    let init_res = lsp.request(
        "initialize",
        build_initialize_params(
            &ws.to_string_lossy(),
            &jh.to_string_lossy(),
            std::process::id(),
            &[jar.to_string_lossy().into_owned()],
        ),
        Duration::from_secs(120),
    );
    if init_res.is_err() {
        let log = std::fs::read_to_string(base.join("jdtls.log")).unwrap_or_default();
        eprintln!("── jdt.ls 起了就死，stderr 日志 ──\n{log}");
    }
    init_res.expect("initialize 应成功");
    // 不发 initialized，jdt.ls 不会启动工作区导入（shadow_scale_live.rs:582 同款；
    // 2026-11-18 实测 java_debug_live.rs 缺这一步会卡在「90 秒解析不出类」）。
    lsp.notify("initialized", json!({})).expect("initialized");
    wait_project_ready(&lsp);
    let dap_port = ask_port(&lsp);

    let (tx, rx) = channel();
    let client = DapClient::connect(dap_port, Arc::new(Events(tx)), Duration::from_secs(10))
        .expect("连不上 java-debug");

    let init = client
        .request(
            "initialize",
            debug::initialize_args(),
            Duration::from_secs(30),
        )
        .expect("DAP initialize");
    eprintln!("\n================ DAP initialize capabilities ================");
    eprintln!(
        "{}",
        serde_json::to_string_pretty(&init).unwrap_or_default()
    );
    eprintln!("=============================================================");

    let caps = &init;
    for key in [
        "supportsConfigurationDoneRequest",
        "supportsFunctionBreakpoints",
        "supportsConditionalBreakpoints",
        "supportsHitConditionalBreakpoints",
        "supportsEvaluateForHovers",
        "supportsSetVariable",
        "supportsRestartFrame",
        "supportsStepBack",
        "supportsDataBreakpoints",
        "supportsLogPoints",
        "supportsExceptionFilterOptions",
        "supportsExceptionInfoRequest",
        "supportsSetExpression",
        "supportsModules",
        "supportsLoadedSourcesRequest",
        "supportsDebuggerProperties",
        "supportsSteppingGranularity",
    ] {
        eprintln!("  capabilities.{key} = {}", caps[key]);
    }

    let caps_file = ws.join("src/Caps.java").to_string_lossy().into_owned();

    let attached = client
        .request(
            "attach",
            debug::attach_args(
                "127.0.0.1",
                jdwp_port,
                PROJECT,
                &[ws.to_string_lossy().into_owned()],
            ),
            Duration::from_secs(40),
        )
        .expect("attach 到 JDWP 应成功");
    eprintln!("\n──── attach → {}", compact(&attached));

    // ① 普通行断点：基线，必须 verified 否则后面全免谈。
    let bp = client
        .request(
            "setBreakpoints",
            debug::set_breakpoints_args(
                &caps_file,
                &[debug::BreakpointSpec {
                    line: 5,
                    ..Default::default()
                }],
            ),
            Duration::from_secs(20),
        )
        .expect("setBreakpoints");
    eprintln!("\n──── ① setBreakpoints line=5 → {}", compact(&bp));

    // ② 条件断点：产品已支持。logpoint 单独留到下一轮（实测带 {i} 插值的 logpoint
    // 会抛 JDWP error 13 并把会话拖进「stopped 但线程未挂起」的僵死态，先排除干扰）。
    probe(
        &client,
        "setBreakpoints",
        debug::set_breakpoints_args(
            &caps_file,
            &[debug::BreakpointSpec {
                line: 6,
                condition: Some("i > 3".into()),
                ..Default::default()
            }],
        ),
        20,
    );

    // ③ 方法断点（DAP setFunctionBreakpoints）。
    probe(
        &client,
        "setFunctionBreakpoints",
        json!({ "breakpoints": [{ "name": "main" }] }),
        20,
    );

    // ④ 数据断点 / 字段观察点（DAP setDataBreakpoints）：java-debug 大概率没有。
    probe(
        &client,
        "setDataBreakpoints",
        json!({
            "breakpoints": [{
                "dataId": "Caps.total",
                "accessType": "write"
            }]
        }),
        20,
    );

    client
        .request("configurationDone", json!({}), Duration::from_secs(15))
        .expect("configurationDone");

    // ⑤ 等命中断点。stopped 的完整 body 是第二份事实（allThreadsStopped）。
    // suspend=y 的目标 attach 后不会自己跑：先主动放行一次（入口若自动停，
    // 这个 continue 正好把它送进断点）。
    let threads = client
        .request("threads", json!({}), Duration::from_secs(15))
        .unwrap_or(Value::Null);
    eprintln!("\n──── threads（放行前）→ {}", compact(&threads));
    // 必须放行 **main**：threads 数组第一个可能是 Attach Listener（实测就是），
    // continue 一个不会跑代码的线程等于没放行。
    let main_tid = threads["threads"]
        .as_array()
        .and_then(|a| {
            a.iter()
                .find(|t| t["name"].as_str().is_some_and(|n| n.contains("main")))
                .or_else(|| a.first())
        })
        .and_then(|t| t["id"].as_i64());
    if let Some(tid) = main_tid {
        eprintln!("  continue 线程 {tid}");
        let _ = client.request(
            "continue",
            json!({ "threadId": tid }),
            Duration::from_secs(15),
        );
    }
    let stopped = wait_stopped(&rx, 90);
    eprintln!("\n================ stopped 事件完整 body ================");
    eprintln!(
        "{}",
        serde_json::to_string_pretty(&stopped).unwrap_or_default()
    );
    eprintln!("=======================================================");

    let thread_id = stopped["threadId"].as_i64().expect("stopped 没带 threadId");

    let threads = client
        .request("threads", json!({}), Duration::from_secs(15))
        .expect("threads");
    eprintln!("\n──── ⑤ threads → {}", compact(&threads));

    let stack = client
        .request(
            "stackTrace",
            json!({ "threadId": thread_id, "startFrame": 0, "levels": 20 }),
            Duration::from_secs(15),
        )
        .expect("stackTrace");
    eprintln!("\n──── ⑥ stackTrace → {}", compact(&stack));
    let frame_id = stack["stackFrames"][0]["id"].as_i64().unwrap_or(0);

    // ⑥ restartFrame：drop frame 的 DAP 路径。错误码 -32601 = 适配器根本没接这个请求。
    probe(&client, "restartFrame", json!({ "frameId": frame_id }), 20);

    // ⑦ 步进粒度：statement / method / instruction。
    for granularity in ["statement", "method", "instruction"] {
        probe(
            &client,
            "next",
            json!({ "threadId": thread_id, "granularity": granularity }),
            20,
        );
    }

    // ⑧ evaluate：表达式求值与赋值副作用。
    probe(
        &client,
        "evaluate",
        json!({ "expression": "1+1", "frameId": frame_id, "context": "hover" }),
        20,
    );
    probe(
        &client,
        "evaluate",
        json!({ "expression": "total", "frameId": frame_id, "context": "watch" }),
        20,
    );

    // ⑨ 变量与 setVariable：产品已支持，记录一次原始回执。
    let scopes = client
        .request(
            "scopes",
            json!({ "frameId": frame_id }),
            Duration::from_secs(15),
        )
        .expect("scopes");
    eprintln!("\n──── ⑨ scopes → {}", compact(&scopes));
    if let Some(vref) = scopes["scopes"][0]["variablesReference"].as_i64() {
        let vars = client
            .request(
                "variables",
                debug::variables_args(vref, None, None),
                Duration::from_secs(15),
            )
            .expect("variables");
        eprintln!("──── variables → {}", compact(&vars));
    }

    eprintln!("\n================ 探针 A 结束：以上输出即结论 ================");
    let _ = client.request(
        "disconnect",
        json!({ "terminateDebuggee": false }),
        Duration::from_secs(15),
    );
}
