//! 真机联调：jdt.ls 0.57.0 + java-debug 0.32.0 + 一个 `suspend=y` 的 Java 8 进程。
//!
//! 覆盖 15.4 的 DAP 客户端与适配器的真实交互，顺序与 `commands/debug_cmds.rs` 相同：
//! `vscode.java.startDebugSession` 拿端口 → `initialize` → `attach` → `setBreakpoints`
//! → `configurationDone` → `continue` → `stopped` → `stackTrace` → `scopes` → `variables`
//! → `evaluate` → `next` → `disconnect`。
//!
//! 默认不跑（`#[ignore]`）：要本机有 JDK 8、裁剪好的 jdt.ls 与 java-debug.jar（CI 上没有）。
//!
//! ```bash
//! cargo test --test java_debug_live -- --ignored --nocapture --test-threads=1
//! ```
//!
//! 路径可用 `NCFORGE_JAVA_HOME` / `NCFORGE_JDTLS_DIR` 覆盖。

#![allow(non_snake_case)]

use nc_forge::debug::{self, DapClient, DapHandler};
use nc_forge::lsp::{build_initialize_params, JdtlsLaunch, LspClient, LspHandler};
use serde_json::{json, Value};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};

const PROJECT: &str = "hello-live";

fn temp(tag: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir =
        std::env::temp_dir().join(format!("nc-forge-dap-{tag}-{}-{nanos}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
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

/// 适配器事件收进通道，测试按需等 `stopped`。
struct Events(Sender<(String, Value)>);
impl DapHandler for Events {
    fn on_event(&self, event: &str, body: Value) {
        let _ = self.0.send((event.to_string(), body));
    }
}

fn wait_event(rx: &Receiver<(String, Value)>, want: &str, timeout: Duration) -> Value {
    let deadline = Instant::now() + timeout;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            panic!("{timeout:?} 内没等到 {want} 事件");
        }
        match rx.recv_timeout(left) {
            Ok((e, body)) if e == want => return body,
            Ok(_) => continue,
            Err(RecvTimeoutError::Timeout) => panic!("{timeout:?} 内没等到 {want} 事件"),
            Err(RecvTimeoutError::Disconnected) => panic!("适配器连接断了，没等到 {want}"),
        }
    }
}

/// 目标进程：`suspend=y` 等调试器连上；测试结束无论成败都要杀掉。
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
    // 第 5 行是断点行（1 基）：total += i;。步过之后到第 6 行 Thread.sleep
    std::fs::write(
        src.join("Hello.java"),
        r#"public class Hello {
    static int total = 0;
    public static void main(String[] args) throws Exception {
        for (int i = 1; i <= 20; i++) {
            total += i;
            Thread.sleep(150);
        }
        System.out.println("total=" + total);
    }
}
"#,
    )
    .unwrap();
}

fn compile(java_home: &Path, ws: &Path) {
    std::fs::create_dir_all(ws.join("bin")).unwrap();
    let status = Command::new(java_home.join("bin/javac.exe"))
        // 不带 -g 时 class 里没有 LocalVariableTable，JDWP 只能看到参数，看不到 i/total
        .arg("-g")
        .arg("-d")
        .arg(ws.join("bin"))
        .arg(ws.join("src/Hello.java"))
        .status()
        .expect("javac 起不来");
    assert!(status.success(), "Hello.java 编译失败");
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
        .arg("Hello")
        .stdout(Stdio::from(file))
        .stderr(Stdio::from(err))
        .spawn()
        .expect("java 起不来");
    let mut target = Target {
        child,
        out: out.to_path_buf(),
    };
    // suspend=y：进程活着并在等调试器。JDWP 端口留给适配器独占，这里不去探（握手失败会被 JVM 当成错误连接）。
    std::thread::sleep(Duration::from_millis(1500));
    if let Ok(Some(code)) = target.child.try_wait() {
        let log = std::fs::read_to_string(out).unwrap_or_default();
        panic!("目标进程自己退了（{code}）：\n{log}");
    }
    target
}

/// 等 jdt.ls 能把工程里的类解析出来（导入 + 索引完成），再去要调试端口。
fn wait_project_ready(client: &LspClient) {
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        if Instant::now() > deadline {
            panic!("90 秒内 jdt.ls 还没解析出 Hello");
        }
        let symbols = client
            .request(
                "workspace/symbol",
                json!({ "query": "Hello" }),
                Duration::from_secs(20),
            )
            .unwrap_or(Value::Null);
        let found = symbols
            .as_array()
            .is_some_and(|a| a.iter().any(|s| s["name"] == "Hello"));
        let located = symbols
            .as_array()
            .is_some_and(|a| a.iter().any(|s| s["location"]["uri"].as_str().is_some()));
        if found && located {
            return;
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

#[test]
#[ignore = "要本机 JDK 8 + 裁剪好的 jdt.ls（含 java-debug.jar）"]
fn 真机走完一条调试会话() {
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

    let base = temp("live");
    let ws = base.join("ws");
    write_project(&ws);
    compile(&jh, &ws);

    let jdwp_port = free_port();
    let _target = start_target(&jh, &ws, jdwp_port, &base.join("target.log"));

    let data = base.join("data");
    let cfg = base.join("cfg");
    let launch = JdtlsLaunch {
        java_exe: &jh.join("bin/java.exe"),
        ls_dir: &ls_dir(),
        data_dir: &data,
        config_dir: &cfg,
        xmx_mb: 1024,
    };
    let lsp = LspClient::spawn(launch.command().unwrap(), Arc::new(Quiet)).expect("jdt.ls 起不来");
    let init = lsp
        .request(
            "initialize",
            build_initialize_params(
                &ws.to_string_lossy(),
                &jh.to_string_lossy(),
                std::process::id(),
                &[jar.to_string_lossy().into_owned()],
            ),
            Duration::from_secs(120),
        )
        .expect("initialize 应成功");
    assert!(init["capabilities"]["executeCommandProvider"].is_object());
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
    assert_eq!(init["supportsConfigurationDoneRequest"], true);

    let hello = ws.join("src/Hello.java").to_string_lossy().into_owned();
    let attached = client
        .request(
            "attach",
            debug::attach_args(jdwp_port, PROJECT, &[ws.to_string_lossy().into_owned()]),
            Duration::from_secs(40),
        )
        .expect("attach 到 JDWP 应成功");
    // attach 成功时 java-debug 一般不带 body；拿不到就看下一次 setBreakpoints 的 verified
    eprintln!("attach 回复：{attached}");

    let bp = client
        .request(
            "setBreakpoints",
            debug::set_breakpoints_args(&hello, &[5]),
            Duration::from_secs(20),
        )
        .expect("setBreakpoints");
    assert_eq!(
        bp["breakpoints"][0]["verified"], true,
        "第 5 行断点没落点：{bp}"
    );

    client
        .request("configurationDone", json!({}), Duration::from_secs(15))
        .expect("configurationDone");

    // suspend=y 的目标在 attach 后可能先停在入口：见到非 breakpoint 的 stopped 就继续；
    // 一直没事件的话按线程列表主动 continue 一次（不同适配器在这一步的时序不一样）
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut resumed = false;
    let stopped = loop {
        if Instant::now() > deadline {
            panic!("60 秒内没命中断点");
        }
        match rx.recv_timeout(Duration::from_secs(5)) {
            Ok((e, body)) if e == "stopped" => {
                let reason = body["reason"].as_str().unwrap_or("").to_string();
                if reason == "breakpoint" {
                    break body;
                }
                let tid = body["threadId"].as_i64().unwrap_or(1);
                let _ = client.request(
                    "continue",
                    json!({ "threadId": tid }),
                    Duration::from_secs(15),
                );
            }
            Ok(_) => {}
            Err(RecvTimeoutError::Timeout) => {
                if !resumed {
                    resumed = true;
                    let threads = client
                        .request("threads", json!({}), Duration::from_secs(15))
                        .expect("threads");
                    if let Some(tid) = threads["threads"]
                        .as_array()
                        .and_then(|a| a.first())
                        .and_then(|t| t["id"].as_i64())
                    {
                        eprintln!("没等到入口暂停，主动继续线程 {tid}");
                        let _ = client.request(
                            "continue",
                            json!({ "threadId": tid }),
                            Duration::from_secs(15),
                        );
                    }
                }
            }
            Err(RecvTimeoutError::Disconnected) => panic!("等断点时适配器连接断了"),
        }
    };
    let thread_id = stopped["threadId"].as_i64().expect("threadId");

    let stack = client
        .request(
            "stackTrace",
            json!({ "threadId": thread_id, "startFrame": 0, "levels": 20 }),
            Duration::from_secs(15),
        )
        .expect("stackTrace");
    let frame = &stack["stackFrames"][0];
    assert_eq!(frame["line"], 5, "断点应停在第 5 行：{stack}");
    let frame_id = frame["id"].as_i64().unwrap();

    let scopes = client
        .request(
            "scopes",
            json!({ "frameId": frame_id }),
            Duration::from_secs(15),
        )
        .expect("scopes");
    eprintln!("scopes：{scopes}");
    let locals = scopes["scopes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| {
            s["name"]
                .as_str()
                .is_some_and(|n| n.to_ascii_lowercase().contains("local"))
        })
        .or_else(|| scopes["scopes"].as_array().unwrap().first())
        .unwrap_or_else(|| panic!("没有作用域：{scopes}"));
    let vars_ref = locals["variablesReference"].as_i64().unwrap();

    let vars = client
        .request(
            "variables",
            json!({ "variablesReference": vars_ref }),
            Duration::from_secs(15),
        )
        .expect("variables");
    assert!(
        vars["variables"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["name"] == "i"),
        "局部变量里应有 i：{vars}"
    );

    let value = client
        .request(
            "evaluate",
            json!({ "expression": "i + 100", "frameId": frame_id, "context": "repl" }),
            Duration::from_secs(15),
        )
        .expect("evaluate");
    let text = value["result"].as_str().unwrap_or("");
    assert!(
        text.parse::<i64>().is_ok_and(|n| (101..=120).contains(&n)),
        "i + 100 的结果不对：{value}"
    );

    // 步过：从第 5 行到第 6 行
    client
        .request(
            "next",
            json!({ "threadId": thread_id }),
            Duration::from_secs(15),
        )
        .expect("next");
    let stepped = wait_event(&rx, "stopped", Duration::from_secs(30));
    let tid = stepped["threadId"].as_i64().unwrap();
    let stack = client
        .request(
            "stackTrace",
            json!({ "threadId": tid, "startFrame": 0, "levels": 5 }),
            Duration::from_secs(15),
        )
        .expect("stackTrace after step");
    assert_eq!(
        stack["stackFrames"][0]["line"], 6,
        "步过应到第 6 行：{stack}"
    );

    client.close();
    lsp.shutdown();
    eprintln!("DAP 链路验证通过：dap_port={dap_port} jdwp_port={jdwp_port}");
}
