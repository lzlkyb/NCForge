//! 真机：jdt.ls 0.57 的 `java/getRefactorEdit` 到底返回什么。
//!
//! 客户端接线（`lib/refactor.ts`）按这里观察到的形状写：结果是一个
//! `{ edit: WorkspaceEdit, command?, errorMessage? }`，`edit` 里的 uri 由后端换回真实路径。
//!
//! 默认不跑（`#[ignore]`）：要本机有 JDK 8 与裁剪好的 jdt.ls（CI 上没有）。
//!
//! ```bash
//! cargo test --test refactor_live -- --ignored --nocapture --test-threads=1
//! ```

#![allow(non_snake_case)]

use nc_forge::lang::LangSession;
use nc_forge::lsp::{
    build_initialize_params, path_to_uri, uri_to_path, JdtlsLaunch, LspClient, LspHandler,
};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

struct Quiet;
impl LspHandler for Quiet {
    fn on_notification(&self, _method: &str, _params: Value) {}
}

fn temp(tag: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "nc-forge-refactor-{tag}-{}-{nanos}",
        std::process::id()
    ));
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

fn write_project(ws: &Path) -> PathBuf {
    let src = ws.join("src");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(
        ws.join(".project"),
        r#"<?xml version="1.0" encoding="UTF-8"?>
<projectDescription>
  <name>refactor-live</name>
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
    let file = src.join("Calc.java");
    std::fs::write(
        &file,
        r#"public class Calc {
    int add(int a, int b) {
        return a + b;
    }

    int calc(int x) {
        int y = x * 2;
        int z = add(y, 10);
        return z + 1;
    }
}
"#,
    )
    .unwrap();
    file
}

fn wait_project_ready(client: &LspClient) {
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        let found = client
            .request(
                "workspace/symbol",
                json!({ "query": "Calc" }),
                Duration::from_secs(20),
            )
            .ok()
            .and_then(|v| v.as_array().cloned())
            .is_some_and(|a| {
                a.iter()
                    .any(|s| s["name"] == "Calc" && s["location"]["uri"].as_str().is_some())
            });
        if found {
            return;
        }
        assert!(Instant::now() < deadline, "90 秒内 jdt.ls 还没解析出 Calc");
        std::thread::sleep(Duration::from_millis(1000));
    }
}

fn refactor(case: &str, range: Value) -> Value {
    let jh = java_home();
    let jar_missing = !jh.join("bin/java.exe").is_file();
    if jar_missing || !ls_dir().join("plugins").is_dir() {
        eprintln!("跳过：本机没有 JDK 8 或 jdt.ls");
        return Value::Null;
    }
    let base = temp(case);
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
    let lsp = LspClient::spawn(launch.command().unwrap(), Arc::new(Quiet)).expect("jdt.ls 起不来");
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
    wait_project_ready(&lsp);

    let uri = path_to_uri(&file.to_string_lossy());
    let text = std::fs::read_to_string(&file).unwrap();
    lsp.notify(
        "textDocument/didOpen",
        json!({
            "textDocument": { "uri": uri, "languageId": "java", "version": 1, "text": text },
        }),
    )
    .unwrap();

    // 这是 LSP 自定义请求（@JsonSegment("java") + @JsonRequest("getRefactorEdit")），不是 executeCommand
    let res = lsp
        .request(
            "java/getRefactorEdit",
            json!({
                "command": case,
                "commandArguments": [],
                "context": {
                    "textDocument": { "uri": uri },
                    "range": range,
                    "context": { "diagnostics": [] }
                },
                "options": { "tabSize": 4, "insertSpaces": true }
            }),
            Duration::from_secs(60),
        )
        .expect("getRefactorEdit 应成功");

    lsp.shutdown();
    res
}

#[test]
#[ignore = "要本机 JDK 8 + 裁剪好的 jdt.ls"]
fn 提取变量与提取方法返回的形状() {
    // 第 8 行（0 基 7）的 `add(y, 10)` = 第 15~23 列
    let expr =
        json!({ "start": { "line": 7, "character": 16 }, "end": { "line": 7, "character": 26 } });
    let r = refactor("extractVariable", expr);
    if r.is_null() {
        return;
    }
    eprintln!("extractVariable → {r}");
    let edit = &r["edit"];
    let changes = &edit["changes"];
    let list = changes
        .as_object()
        .expect("edit.changes 应是对象")
        .values()
        .next()
        .and_then(|v| v.as_array())
        .expect("至少一个文件的编辑");
    assert!(
        list.iter().any(|e| e["newText"]
            .as_str()
            .is_some_and(|t| t.contains("add(y, 10)"))),
        "替换文本里应包含原表达式：{edit}"
    );

    // 第 6~7 行（0 基）两条语句 → 提取方法
    let stmts =
        json!({ "start": { "line": 6, "character": 8 }, "end": { "line": 7, "character": 26 } });
    let m = refactor("extractMethod", stmts);
    if m.is_null() {
        return;
    }
    eprintln!("extractMethod → {m}");
    if let Some(err) = m["errorMessage"].as_str() {
        panic!("extractMethod 报了错：{err}");
    }
    assert!(m["edit"].is_object(), "extractMethod 应返回 edit：{m}");
}

/// 真机：影子工程映射下，提取的编辑要能落回**真实路径**。
///
/// 这是前端接 `lang_request` 时唯一没法在单测里覆盖的一段：`prepare` 用真实路径算出
/// 影子 URI（前端给的 `file://` 因盘符 `%3A` 编码对不上，不能靠前缀替换），结果再用
/// `from_server` 换回真实路径。差一个前缀的表现就是「提取没反应」。
///
/// 不清理临时目录：`shadow/src` 是指向 `real/src` 的 junction，
/// `remove_dir_all` 会顺着链接删到真实副本；交给系统临时目录回收。
#[test]
#[ignore = "要本机 JDK 8 + 裁剪好的 jdt.ls"]
fn 影子工程映射下提取变量返回真实路径() {
    let jh = java_home();
    if !jh.join("bin/java.exe").is_file() || !ls_dir().join("plugins").is_dir() {
        eprintln!("跳过：本机没有 JDK 8 或 jdt.ls");
        return;
    }
    let base = temp("shadow-refactor");
    let real = base.join("real");
    let file = write_project(&real);
    let shadow = base.join("shadow");
    std::fs::create_dir_all(&shadow).unwrap();
    // 真实形态：源码用 junction 链过去，工程描述文件写在影子目录里
    nc_forge::shadow::ensure_link(&shadow.join("src"), &real.join("src"), &mut Vec::new()).unwrap();
    for name in [".project", ".classpath"] {
        std::fs::copy(real.join(name), shadow.join(name)).unwrap();
    }

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
            &shadow.to_string_lossy(),
            &jh.to_string_lossy(),
            std::process::id(),
            &[],
        ),
        Duration::from_secs(120),
    )
    .expect("initialize");
    wait_project_ready(&lsp);

    let text = std::fs::read_to_string(&file).unwrap();
    let session = LangSession::new(lsp, "gl", &real, &shadow);
    // didOpen 用的是影子 URI：jdt.ls 只认自己工程里的路径
    let uri = session.shadow_uri_of(&file.to_string_lossy()).unwrap();
    session
        .client
        .notify(
            "textDocument/didOpen",
            json!({ "textDocument": { "uri": uri, "languageId": "java", "version": 1, "text": text } }),
        )
        .unwrap();

    // 前端形状：uri 留空，由 prepare 按 path 算出的影子 URI 填进来
    let mut params = session.to_server(&json!({
        "command": "extractVariable",
        "commandArguments": [],
        "context": {
            "textDocument": { "uri": "" },
            "range": { "start": { "line": 7, "character": 16 }, "end": { "line": 7, "character": 26 } },
            "context": { "diagnostics": [] }
        },
        "options": { "tabSize": 4, "insertSpaces": true }
    }));
    params["context"]["textDocument"]["uri"] = json!(uri);
    let res = session
        .client
        .request("java/getRefactorEdit", params, Duration::from_secs(60))
        .expect("getRefactorEdit 应成功");
    let out = session.from_server(&res);

    let changes = out["edit"]["changes"]
        .as_object()
        .expect("影子路径下也应返回 edit.changes");
    let paths: Vec<String> = changes.keys().filter_map(|u| uri_to_path(u)).collect();
    assert!(
        paths
            .iter()
            .any(|p| p.eq_ignore_ascii_case(&file.to_string_lossy())),
        "编辑应落回真实路径，实际是 {paths:?}"
    );
    assert!(
        changes
            .values()
            .filter_map(Value::as_array)
            .flatten()
            .any(|e| e["newText"]
                .as_str()
                .is_some_and(|t| t.contains("add(y, 10)"))),
        "替换文本里应包含原表达式：{out}"
    );
    // 改名落点（前端的「选中新名字」）也要一起换回真实路径，否则不会选中
    let cmd_uri = out["command"]["arguments"][0]["uri"].as_str().unwrap_or("");
    assert_eq!(
        uri_to_path(cmd_uri).as_deref().map(str::to_lowercase),
        Some(file.to_string_lossy().to_lowercase()),
        "改名命令里的 uri 应换成真实路径：{out}"
    );
    session.client.shutdown();
}
