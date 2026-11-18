//! 探针 D：**java-debug 已经占用的 JVM，能不能再开一条 JDWP 直连**。
//!
//! 这是「JDWP 直连补齐 force return / drop frame / 单线程恢复 / 方法断点 /
//! 字段观察点」这条技术路线的生死判据。探针 A/C 已证明这些能力在 JDI 层真实
//! 可用（popFrames / forceEarlyReturn / SUSPEND_EVENT_THREAD 全绿），DAP 侧
//! 则要幺没有（setFunctionBreakpoints 被拒）、要幺对底层帧无效
//! （restartFrame 报 "Current stack frame doesn't support restart"）。
//! 但产品的调试会话由 java-debug 适配器持有 —— 同一个 VM 上再开一条 JDWP
//! 连接，HotSpot 收不收、两条连接会不会互相踩断点、第二条连接 dispose 会不
//! 会带走目标进程，只能实测。
//!
//! 流程：起目标（suspend=y，Helper.pause 在第 17 行）→ jdt.ls + DAP attach →
//! 行断点（Caps 第 10 行）命中、main 挂起 → **此时**跑
//! `fixtures/jdi_probe/JdiCoexist.java`（第二条 JDWP 连接）：
//!   1. attach 同端口成不成（`RESULT: attach-ok` / `attach-failed`）。
//!   2. 自建断点（Helper 第 17 行，SUSPEND_EVENT_THREAD）能不能收到命中
//!      （DAP 侧 continue 放行 main 之后）。
//!   3. 命中后 popFrames 成不成（第二条连接改执行流，VM 认不认）。
//!   4. 第二条连接 dispose 后目标进程还在不在（客户端异常退出不能带走
//!      用户的进程，这是产品化前提）。
//!
//! ```bash
//! node scripts/rust-gate.mjs test --no-default-features --test debug_jdwp_coexist_probe -- --ignored --nocapture --test-threads=1
//! ```
//!
//! 路径可用 `NCFORGE_JAVA_HOME` / `NCFORGE_JDTLS_DIR` / `NCFORGE_JDI_JAVA` 覆盖。

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

const PROJECT: &str = "caps-live";

fn java_home() -> PathBuf {
    std::env::var("NCFORGE_JAVA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(r"D:\ncc\1909home\ufjdk"))
}

/// JDI 客户端用的 JDK：本机 ufjdk（JDK 8）的 tools.jar 被裁剪到缺
/// `com.sun.jdi.Capability`、`BreakpointRequest`、`forceEarlyReturn`，JDI 跑不起来；
/// 用完整 JDK 17（jdk.jdi 模块完整）。目标进程仍跑 JDK 8（JDWP 跨版本兼容）。
fn jdi_java() -> PathBuf {
    std::env::var("NCFORGE_JDI_JAVA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(r"D:\AItool\jdk-17.0.20.1+1\bin\java.exe"))
}

/// JDK 9+ 的 JDI 在 jdk.jdi 模块，classpath 代码要显式 `--add-modules`；
/// JDK 8 走 lib/tools.jar。按 tools.jar 在不在自动选。
fn jdi_classpath_args(tools_jar: Option<&Path>) -> Vec<String> {
    match tools_jar {
        Some(jar) => vec!["-cp".into(), jar.to_string_lossy().into_owned()],
        None => vec!["--add-modules".into(), "jdk.jdi".into()],
    }
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

/// 适配器事件全收进通道：本探针要的第一份事实就是 `stopped` 事件
/// （main 必须停在 Caps 第 10 行，第二条连接才有的可探）。
struct Events(Sender<(String, Value)>);
impl DapHandler for Events {
    fn on_event(&self, event: &str, body: Value) {
        eprintln!("  [DAP event] {event} {}", compact(&body));
        let _ = self.0.send((event.to_string(), body));
    }
}

struct Target {
    child: Child,
}

impl Drop for Target {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// 与探针 C 同款布局：**Helper.pause 的方法体在第 17 行**（JdiCoexist 的断点行号
/// 照此写死），main 循环必经行是第 10 行（DAP 断点行号照此写死）。
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
        Thread bg = new Thread(() -> {
            try { Thread.sleep(600_000); } catch (InterruptedException ignored) {}
        }, "bg-sleeper");
        bg.setDaemon(true);
        bg.start();
        for (int i = 1; i <= 200; i++) {
            total += i;
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
    let mut target = Target { child };
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

/// 轮询子进程输出文件里出现 marker（探针 D 靠它卡住时序：
/// 必须等第二条连接 attach 并下好断点，才敢 DAP continue 放行 main）。
fn wait_marker(log: &Path, marker: &str, secs: u64) -> bool {
    let deadline = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < deadline {
        if let Ok(text) = std::fs::read_to_string(log) {
            if text.contains(marker) {
                return true;
            }
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

fn compact(v: &Value) -> String {
    let s = v.to_string();
    if s.len() > 1200 {
        format!("{}…（截断，共 {} 字符）", &s[..1200], s.len())
    } else {
        s
    }
}

#[test]
#[ignore = "要本机 JDK 8 + 完整 JDK 17 + 裁剪好的 jdt.ls（含 java-debug.jar）；探针，输出即结论"]
fn jdwp_双连接共存_探针() {
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
    let jdi = jdi_java();
    if !jdi.is_file() {
        eprintln!("跳过：JDI 用的 JDK 17 不在（{}）", jdi.display());
        return;
    }

    // 🔴 不能用系统 Temp 目录：`IMPORT_EXCLUSIONS` 里有 `**/temp/**`，
    // 路径落在 AppData\Local\Temp 下会被整条排除，jdt.ls 只建默认 invisible project，
    // workspace/symbol 永远为空（2026-11-18 实测：java_debug_live 同款症状的根因）。
    // 也不能 canonicalize：`\\?\` 前缀 equinox 启动器不吃，jdt.ls 秒退。
    // 所以：target/probe-tmp 下手工拼路径，两者都避开。
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target/probe-tmp")
        .join(format!("coexist-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();
    let ws = base.join("ws");
    write_project(&ws);
    compile(&jh, &ws);

    let jdwp_port = free_port();
    let mut target = start_target(&jh, &ws, jdwp_port, &base.join("target.log"));

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
    // 不发 initialized，jdt.ls 不会启动工作区导入（2026-11-18 实测）。
    lsp.notify("initialized", json!({})).expect("initialized");
    wait_project_ready(&lsp);
    let dap_port = ask_port(&lsp);

    let (tx, rx) = channel();
    let client = DapClient::connect(dap_port, Arc::new(Events(tx)), Duration::from_secs(10))
        .expect("连不上 java-debug");

    client
        .request(
            "initialize",
            debug::initialize_args(),
            Duration::from_secs(30),
        )
        .expect("DAP initialize");

    let caps_file = ws.join("src/Caps.java").to_string_lossy().into_owned();
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
        .expect("attach 到 JDWP 应成功");

    // DAP 断点：Caps 第 10 行（main 循环必经行）。命中后 main 挂起，
    // 这就是「java-debug 已占用的 JVM」状态。
    let bp = client
        .request(
            "setBreakpoints",
            debug::set_breakpoints_args(
                &caps_file,
                &[debug::BreakpointSpec {
                    line: 10,
                    ..Default::default()
                }],
            ),
            Duration::from_secs(20),
        )
        .expect("setBreakpoints");
    eprintln!("──── setBreakpoints line=10 → {}", compact(&bp));

    client
        .request("configurationDone", json!({}), Duration::from_secs(15))
        .expect("configurationDone");

    // suspend=y 的目标 attach 后不会自己跑：主动放行 main 一次，把它送进断点。
    let threads = client
        .request("threads", json!({}), Duration::from_secs(15))
        .unwrap_or(Value::Null);
    eprintln!("──── threads（放行前）→ {}", compact(&threads));
    let main_tid = threads["threads"]
        .as_array()
        .and_then(|a| {
            a.iter()
                .find(|t| t["name"].as_str().is_some_and(|n| n.contains("main")))
                .or_else(|| a.first())
        })
        .and_then(|t| t["id"].as_i64());
    let tid = main_tid.expect("threads 里没有 main");
    let _ = client.request(
        "continue",
        json!({ "threadId": tid }),
        Duration::from_secs(15),
    );
    let stopped = wait_stopped(&rx, 90);
    let stopped_thread = stopped["threadId"].as_i64().expect("stopped 没带 threadId");
    eprintln!(
        "──── main 已停在断点上：stopped threadId={stopped_thread} reason={}",
        stopped["reason"]
    );
    assert_eq!(stopped_thread, tid, "停住的应该就是 main");

    // ================= 第二条 JDWP 连接进场 =================
    // 编译 JdiCoexist.java（-encoding：源文件是 UTF-8 中文注释，
    // javac 默认按平台 GBK 读会乱码失败）。
    let jdk_home = jdi
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.to_path_buf());
    let tools_jar = jdk_home
        .as_ref()
        .map(|h| h.join("lib/tools.jar"))
        .filter(|j| j.is_file());
    let jdi_args = jdi_classpath_args(tools_jar.as_deref());

    let probe_src =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/jdi_probe/JdiCoexist.java");
    let probe_out = base.join("probe-bin");
    std::fs::create_dir_all(&probe_out).unwrap();
    let out = Command::new(jdi.with_file_name("javac.exe"))
        .args(&jdi_args)
        .arg("-encoding")
        .arg("UTF-8")
        .arg("-d")
        .arg(&probe_out)
        .arg(&probe_src)
        .output()
        .expect("javac 起不来");
    assert!(
        out.status.success(),
        "JdiCoexist.java 编译失败：\n{}",
        String::from_utf8_lossy(&out.stderr)
    );

    let coex_log = base.join("coexist.log");
    let file = std::fs::File::create(&coex_log).unwrap();
    let err = file.try_clone().unwrap();
    let mut coex = Command::new(&jdi)
        .args(&jdi_args)
        .arg("-cp")
        .arg(&probe_out)
        .arg("JdiCoexist")
        .arg(jdwp_port.to_string())
        .stdout(Stdio::from(file))
        .stderr(Stdio::from(err))
        .spawn()
        .expect("JdiCoexist 起不来");

    // 时序卡点：必须等第二条连接 attach 并下好断点，才敢放行 main ——
    // 否则 main 先跑过 Helper.pause，第二条连接就永远等不到命中。
    let armed = wait_marker(&coex_log, "breakpoint-set", 40);
    eprintln!("──── 第二条连接断点就位：{armed}（false 则下面是它自己的失败原因）");

    // 放行 main → 执行第 10 行 → 进 Helper.pause → 第二条连接的断点应命中。
    let _ = client.request(
        "continue",
        json!({ "threadId": tid }),
        Duration::from_secs(15),
    );

    // 等第二条连接跑完（命中 → 打印线程 → popFrames → resume → dispose → 退出）。
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        if let Ok(Some(_)) = coex.try_wait() {
            break;
        }
        if Instant::now() > deadline {
            let _ = coex.kill();
            let _ = coex.wait();
            panic!(
                "90 秒内 JdiCoexist 没跑完（main 没放行成功？）\n{}",
                read_or_empty(&coex_log)
            );
        }
        std::thread::sleep(Duration::from_millis(200));
    }

    let stdout = read_or_empty(&coex_log);
    eprintln!(
        "================ 探针 D：第二条 JDWP 连接 stdout ================\n{stdout}\n=================================================================="
    );

    // 安全性数据点：第二条连接 dispose 之后，目标进程还在不在。
    // 在的话「JDWP 直连客户端崩溃/退出不会带走用户进程」这个产品化前提才成立。
    match target.child.try_wait() {
        Ok(Some(code)) => eprintln!(
            "⚠️ 目标进程在第二条连接 dispose 后退出了（code={code}）——双连接路线有安全性问题"
        ),
        Ok(None) => eprintln!("✓ 目标进程仍在运行：第二条连接 dispose 没有带走 VM"),
        Err(e) => eprintln!("try_wait 失败：{e}"),
    }

    let _ = client.request(
        "disconnect",
        json!({ "terminateDebuggee": true }),
        Duration::from_secs(15),
    );

    assert!(
        stdout.contains("RESULT: attach-ok"),
        "第二条 JDWP 连接没 attach 上 —— 「JDWP 直连」路线不成立，2/3/4 项只能另找出路：\n{stdout}"
    );
    assert!(
        stdout.contains("RESULT: hit") && stdout.contains("popframes-ok"),
        "第二条连接没拿到命中或 popFrames 失败 —— 双连接共存有问题：\n{stdout}"
    );
}

fn read_or_empty(p: &Path) -> String {
    std::fs::read_to_string(p).unwrap_or_default()
}
