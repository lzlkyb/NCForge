//! 探针 B：跨模块断点的真实行为。
//!
//! 复刻生产的形状：**当前模块源码在 jdt.ls 工作区里，另一个模块只有字节码**
//! （class 目录进 classpath，源码在工作区外）——这正是 shadow 只链当前模块时
//! 用户遇到的情况。问两个问题：
//!   1. `setBreakpoints` 指向工作区外的源码路径，适配器认不认（verified / message）。
//!   2. 万一落了点，`stopped` + `stackTrace` 的 source 指向哪里（真实源码 / 字节码 / 空）。
//!
//! 对照实验：同一份 Foreign.java 若**放进**工作区，断点是否 verified ——
//! 两组结果的差就是「跨模块」三个字的净代价。
//!
//! ```bash
//! node scripts/rust-gate.mjs test --no-default-features --test debug_xmod_bp_probe -- --ignored --nocapture --test-threads=1
//! ```

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

const PROJECT: &str = "xmod-live";

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

struct Events(Sender<(String, Value)>);
impl DapHandler for Events {
    fn on_event(&self, event: &str, body: Value) {
        let _ = self.0.send((event.to_string(), body));
    }
}

/// 「当前模块」的源码：在工作区里。
const CAPS_JAVA: &str = r#"public class Caps {
    public static void main(String[] args) throws Exception {
        System.out.println("caps main");
    }
}
"#;

/// 「另一个模块」的源码：编译成 class 进 classpath，**源码文件放在工作区外**。
const FOREIGN_JAVA: &str = r#"public class Foreign {
    public static void run() throws Exception {
        for (int i = 1; i <= 200; i++) {
            Helper.pause();
        }
    }
    public static void main(String[] args) throws Exception {
        run();
    }
}
class Helper {
    static void pause() throws Exception { Thread.sleep(120); }
}
"#;

fn write_workspace(ws: &Path) {
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
  <classpathentry kind="lib" path="mod-b-bin"/>
  <classpathentry kind="output" path="bin"/>
</classpath>
"#,
    )
    .unwrap();
    std::fs::write(src.join("Caps.java"), CAPS_JAVA).unwrap();
}

fn compile(jh: &Path, ws: &Path, modb_src: &Path) {
    // 当前模块
    std::fs::create_dir_all(ws.join("bin")).unwrap();
    assert!(
        Command::new(jh.join("bin/javac.exe"))
            .arg("-g")
            .arg("-d")
            .arg(ws.join("bin"))
            .arg(ws.join("src/Caps.java"))
            .status()
            .expect("javac")
            .success(),
        "Caps.java 编译失败"
    );
    // 另一个模块：源码在工作区外，class 放 mod-b-bin 进 classpath
    let modb_out = ws.join("mod-b-bin");
    std::fs::create_dir_all(&modb_out).unwrap();
    assert!(
        Command::new(jh.join("bin/javac.exe"))
            .arg("-g")
            .arg("-d")
            .arg(&modb_out)
            .arg(modb_src.join("Foreign.java"))
            .status()
            .expect("javac")
            .success(),
        "Foreign.java 编译失败"
    );
}

fn wait_project_ready(client: &LspClient) {
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        if Instant::now() > deadline {
            panic!("90 秒内 jdt.ls 还没解析出 Caps");
        }
        let symbols = client
            .request(
                "workspace/symbol",
                json!({ "query": "Caps" }),
                Duration::from_secs(20),
            )
            .unwrap_or(Value::Null);
        let found = symbols
            .as_array()
            .is_some_and(|a| a.iter().any(|s| s["name"] == "Caps"));
        if found {
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

fn compact(v: &Value) -> String {
    let s = v.to_string();
    if s.len() > 1000 {
        format!("{}…（截断）", &s[..1000])
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
            Err(RecvTimeoutError::Disconnected) => panic!("适配器连接断了"),
        }
    }
}

/// 对指定源码路径下断点，等 stopped，把关键事实打出来。
fn try_bp(client: &DapClient, rx: &Receiver<(String, Value)>, label: &str, src_path: &str) {
    eprintln!("\n================ {label} ================");
    let bp = match client.request(
        "setBreakpoints",
        debug::set_breakpoints_args(
            src_path,
            &[debug::BreakpointSpec {
                line: 5,
                ..Default::default()
            }],
        ),
        Duration::from_secs(20),
    ) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("  setBreakpoints 直接失败：{e}");
            return;
        }
    };
    eprintln!("  setBreakpoints → {}", compact(&bp));
    let verified = bp["breakpoints"][0]["verified"].as_bool();
    let message = bp["breakpoints"][0]["message"].as_str().unwrap_or("");
    eprintln!("  verified={verified:?} message={message}");
    if verified != Some(true) {
        return;
    }
    // 命中了才继续看 source 映射
    let stopped = wait_stopped(rx, 90);
    eprintln!("  stopped → {}", compact(&stopped));
    let tid = match stopped["threadId"].as_i64() {
        Some(t) => t,
        None => return,
    };
    let stack = client
        .request(
            "stackTrace",
            json!({ "threadId": tid, "startFrame": 0, "levels": 10 }),
            Duration::from_secs(15),
        )
        .unwrap_or(Value::Null);
    eprintln!("  stackTrace → {}", compact(&stack));
}

#[test]
#[ignore = "要本机 JDK 8 + 裁剪好的 jdt.ls（含 java-debug.jar）；探针，输出即结论"]
fn 跨模块断点_探针() {
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

    // 同探针 A：系统 Temp 会被 IMPORT_EXCLUSIONS 的 `**/temp/**` 整条排除，
    // jdt.ls 只建默认 invisible project；`\\?\` 前缀 equinox 不吃。两坑都避开。
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target/probe-tmp")
        .join(format!("xmod-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();
    let ws = base.join("ws");
    let modb_src = base.join("mod-b-src");
    std::fs::create_dir_all(&modb_src).unwrap();
    std::fs::write(modb_src.join("Foreign.java"), FOREIGN_JAVA).unwrap();
    write_workspace(&ws);
    compile(&jh, &ws, &modb_src);

    // 目标跑的是 Foreign.main（模拟「要调的代码在另一个模块」）
    let jdwp_port = free_port();
    let log = std::fs::File::create(base.join("target.log")).unwrap();
    struct Guard(Child);
    impl Drop for Guard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
            let _ = std::fs::read_to_string("target.log");
        }
    }
    let target = Command::new(jh.join("bin/java.exe"))
        .arg(format!(
            "-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:{jdwp_port}"
        ))
        .arg("-cp")
        .arg(format!(
            "{}\\{}",
            ws.join("bin").to_string_lossy(),
            ws.join("mod-b-bin").to_string_lossy()
        ))
        .arg("Foreign")
        .stdout(Stdio::from(log.try_clone().unwrap()))
        .stderr(Stdio::from(log))
        .spawn()
        .expect("java 起不来");
    let _guard = Guard(target);
    std::thread::sleep(Duration::from_millis(1500));

    let launch = JdtlsLaunch {
        java_exe: &jh.join("bin/java.exe"),
        ls_dir: &ls_dir(),
        data_dir: &base.join("data"),
        config_dir: &base.join("cfg"),
        xmx_mb: 1024,
    };
    let lsp = LspClient::spawn(launch.command().unwrap(), Arc::new(Quiet)).expect("jdt.ls 起不来");
    lsp.request(
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
    // 不发 initialized，jdt.ls 不会导入工作区（详见探针 A 同款注释）。
    lsp.notify("initialized", json!({})).expect("initialized");
    wait_project_ready(&lsp);
    let dap_port = ask_port(&lsp);

    let (tx, rx) = channel();
    let client = DapClient::connect(dap_port, Arc::new(Events(tx)), Duration::from_secs(10))
        .expect("连不上 java-debug");
    let _ = client.request(
        "initialize",
        debug::initialize_args(),
        Duration::from_secs(30),
    );

    client
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
        .expect("attach");
    client
        .request("configurationDone", json!({}), Duration::from_secs(15))
        .expect("configurationDone");

    // 对照组：源码在工作区外（跨模块形状）
    try_bp(
        &client,
        &rx,
        "对照组：源码在工作区外（只有字节码进 classpath）",
        &modb_src.join("Foreign.java").to_string_lossy(),
    );

    // 把同一份源码放进工作区再来一次（实验组）
    let in_ws = ws.join("src/Foreign.java");
    std::fs::write(&in_ws, FOREIGN_JAVA).unwrap();
    try_bp(
        &client,
        &rx,
        "实验组：同一份源码放进工作区",
        &in_ws.to_string_lossy(),
    );

    let _ = client.request("disconnect", json!({}), Duration::from_secs(15));
}
