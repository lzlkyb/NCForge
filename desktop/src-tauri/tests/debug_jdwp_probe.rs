//! 探针 C：JDWP/JDI 直连的能力边界（drop frame / force return / 单线程挂起）。
//!
//! 驱动 `fixtures/jdi_probe/JdiProbe.java`：起一个 `suspend=y` 的双线程 Java 8 目标，
//! JDI attach 上去，把 VM capabilities 与 popFrames / forceEarlyReturn / 单线程 resume
//! 的**真实结果**（成功或异常）全部打出来。产品侧调试走 DAP（java-debug），
//! 但 DAP 不暴露的能力能不能补，取决于 VM 本身给不给 —— 这份输出就是判据。
//!
//! ```bash
//! node scripts/rust-gate.mjs test --no-default-features --test debug_jdwp_probe -- --ignored --nocapture --test-threads=1
//! ```

#![allow(non_snake_case)]

use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

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

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .expect("要一个空闲端口")
}

const CAPS_JAVA: &str = r#"public class Caps {
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
"#;

fn write_project(ws: &Path) {
    let src = ws.join("src");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(
        ws.join(".project"),
        r#"<?xml version="1.0" encoding="UTF-8"?>
<projectDescription>
  <name>caps-live</name>
  <buildSpec>
    <buildCommand><name>org.eclipse.jdt.core.javabuilder</name></buildCommand>
  </buildSpec>
  <natures><nature>org.eclipse.jdt.core.javanature</nature></natures>
</projectDescription>
"#,
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
    std::fs::write(src.join("Caps.java"), CAPS_JAVA).unwrap();
}

#[test]
#[ignore = "要本机 JDK 8；探针，输出即结论"]
fn jdwp_直连能力_探针() {
    let jh = java_home();
    if !jh.join("bin/java.exe").is_file() || !jh.join("bin/javac.exe").is_file() {
        eprintln!("跳过：{} 下没有 JDK 8", jh.display());
        return;
    }
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target/probe-tmp")
        .join(format!("jdwp-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();
    let ws = base.join("ws");
    write_project(&ws);

    // 编译目标工程（-g 保留局部变量表）
    std::fs::create_dir_all(ws.join("bin")).unwrap();
    let ok = Command::new(jh.join("bin/javac.exe"))
        .arg("-g")
        .arg("-d")
        .arg(ws.join("bin"))
        .arg(ws.join("src/Caps.java"))
        .status()
        .expect("javac 起不来");
    assert!(ok.success(), "Caps.java 编译失败");

    // JDI（com.sun.jdi.*）在 JDK 8 的 lib/tools.jar、JDK 9+ 的 jdk.jdi 模块里。
    let jdi = jdi_java();
    let jdk_home = jdi
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.to_path_buf());
    let tools_jar = jdk_home
        .as_ref()
        .map(|h| h.join("lib/tools.jar"))
        .filter(|j| j.is_file());
    let jdi_args = jdi_classpath_args(tools_jar.as_deref());

    // 编译 JDI 探针本体（-encoding：源文件是 UTF-8 中文注释，javac 默认按平台 GBK 读会乱码失败）
    let probe_src =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/jdi_probe/JdiProbe.java");
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
        "JdiProbe.java 编译失败：\n{}",
        String::from_utf8_lossy(&out.stderr)
    );

    // 目标：suspend=y，等 JDI 连上；JDI 断开后自然退出（main 跑完）。
    let jdwp_port = free_port();
    let log = std::fs::File::create(base.join("target.log")).unwrap();
    let mut target = Command::new(jh.join("bin/java.exe"))
        .arg(format!(
            "-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:{jdwp_port}"
        ))
        .arg("-cp")
        .arg(ws.join("bin"))
        .arg("Caps")
        .stdout(Stdio::from(log.try_clone().unwrap()))
        .stderr(Stdio::from(log))
        .spawn()
        .expect("java 起不来");
    std::thread::sleep(Duration::from_millis(1500));

    let out = Command::new(&jdi)
        .args(&jdi_args)
        .arg("-cp")
        .arg(&probe_out)
        .arg("JdiProbe")
        .arg(jdwp_port.to_string())
        .output()
        .expect("JdiProbe 起不来");

    let _ = target.kill();
    let _ = target.wait();

    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    eprintln!("================ JDI 探针 stdout ================\n{stdout}");
    if !stderr.trim().is_empty() {
        eprintln!("================ JDI 探针 stderr ================\n{stderr}");
    }
    eprintln!("=================================================");

    assert!(
        stdout.contains("forceEarlyReturn") && stdout.contains("popFrames"),
        "探针没跑起来：stdout={stdout}"
    );
}
