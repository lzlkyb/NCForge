//! 真机：自定义 jdt.ls 扩展 bundle（`ncforge.typeHierarchy`）在影子工程下的行为。
//!
//! 0.57 没有 LSP 的 TypeHierarchy，改用 `org.eclipse.jdt.ls.core.delegateCommandHandler`
//! 扩展点 + `workspace/executeCommand`。这里验证三件在单测里看不到的事：
//! 1. bundle 能通过 `initializationOptions.bundles` 装上，命令能派发到我们的处理器；
//! 2. JDT 的 `IType.newTypeHierarchy` 在真工程里给出的父/子类型与深度符合预期；
//! 3. 结果里的影子 URI 经 `from_server` 换回真实路径，且 `executeCommand` 参数里
//!    多出来的顶层 `textDocument`（后端 `fill_document_uris` 会加）不会让服务端报错。
//!
//! 默认不跑（`#[ignore]`）：要本机有 JDK 8、裁剪好的 jdt.ls 与 `resources/jdtls-ext/ncforge-jdt-ext.jar`。
//!
//! ```bash
//! cargo test --test type_hierarchy_live -- --ignored --nocapture --test-threads=1
//! ```

#![allow(non_snake_case)]

use nc_forge::lang::LangSession;
use nc_forge::lsp::{build_initialize_params, uri_to_path, JdtlsLaunch, LspClient, LspHandler};
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
    let dir =
        std::env::temp_dir().join(format!("nc-forge-th-{tag}-{}-{nanos}", std::process::id()));
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

fn ext_jar() -> PathBuf {
    if let Ok(p) = std::env::var("NCFORGE_JDTLS_EXT_JAR") {
        return PathBuf::from(p);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/jdtls-ext/ncforge-jdt-ext.jar")
}

fn write_project(ws: &Path) {
    let src = ws.join("src/demo");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(
        ws.join(".project"),
        r#"<?xml version="1.0" encoding="UTF-8"?>
<projectDescription>
  <name>th-live</name>
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
    std::fs::write(
        src.join("Shape.java"),
        "package demo;\npublic interface Shape { double area(); }\n",
    )
    .unwrap();
    std::fs::write(
        src.join("Circle.java"),
        "package demo;\npublic class Circle implements Shape {\n    public double area() { return 3.14; }\n}\n",
    )
    .unwrap();
    std::fs::write(
        src.join("Square.java"),
        "package demo;\npublic class Square implements Shape {\n    public double area() { return 4.0; }\n}\n",
    )
    .unwrap();
    std::fs::write(
        src.join("Use.java"),
        "package demo;\npublic class Use {\n    Shape shape;\n    Circle circle;\n}\n",
    )
    .unwrap();
}

fn wait_project_ready(client: &LspClient) {
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        let found = client
            .request(
                "workspace/symbol",
                json!({ "query": "Square" }),
                Duration::from_secs(20),
            )
            .ok()
            .and_then(|v| v.as_array().cloned())
            .is_some_and(|a| {
                a.iter()
                    .any(|s| s["name"] == "Square" && s["location"]["uri"].as_str().is_some())
            });
        if found {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "90 秒内 jdt.ls 还没解析出 Square"
        );
        std::thread::sleep(Duration::from_millis(1000));
    }
}

/// 发一次 `ncforge.typeHierarchy`：形状与前端 + 后端 `prepare` 完全一致。
fn hierarchy(session: &LangSession, real_file: &Path, line: u32, character: u32) -> Value {
    let uri = session.shadow_uri_of(&real_file.to_string_lossy()).unwrap();
    // 前端形状：uri 留空（Monaco 的 %3A 形态换不过去），由 prepare 按 path 重算
    let mut params = session.to_server(&json!({
        "command": "ncforge.typeHierarchy",
        "arguments": [{ "uri": "", "line": line, "character": character }]
    }));
    params["arguments"][0]["uri"] = json!(uri);
    // prepare 还会给所有请求加顶层 textDocument：executeCommand 参数里多这个字段
    // 不能被服务端当成坏参数（Gson 忽略未知字段——这里就是那条证明）
    params["textDocument"] = json!({ "uri": uri });
    let raw = session
        .client
        .request("workspace/executeCommand", params, Duration::from_secs(60))
        .expect("ncforge.typeHierarchy 应成功（bundle 装上了吗？）");
    session.from_server(&raw)
}

#[test]
#[ignore = "要本机 JDK 8 + 裁剪好的 jdt.ls + 扩展 bundle"]
fn 类型层级在影子工程下返回父类子类与真实路径() {
    let jh = java_home();
    if !jh.join("bin/java.exe").is_file()
        || !ls_dir().join("plugins").is_dir()
        || !ext_jar().is_file()
    {
        eprintln!("跳过：本机没有 JDK 8 / jdt.ls / 扩展 bundle");
        return;
    }
    let base = temp("shadow");
    let real = base.join("real");
    write_project(&real);
    let shadow = base.join("shadow");
    std::fs::create_dir_all(&shadow).unwrap();
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
    let init = lsp
        .request(
            "initialize",
            build_initialize_params(
                &shadow.to_string_lossy(),
                &jh.to_string_lossy(),
                std::process::id(),
                &[ext_jar().to_string_lossy().into_owned()],
            ),
            Duration::from_secs(120),
        )
        .expect("initialize");
    let cmds = init["capabilities"]["executeCommandProvider"]["commands"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert!(
        cmds.iter().any(|c| c == "ncforge.typeHierarchy"),
        "扩展 bundle 没装上，命令列表里没有 ncforge.typeHierarchy"
    );
    wait_project_ready(&lsp);

    let session = LangSession::new(lsp, "gl", &real, &shadow);
    for name in ["Shape.java", "Circle.java", "Square.java", "Use.java"] {
        let file = real.join("src/demo").join(name);
        let text = std::fs::read_to_string(&file).unwrap();
        let uri = session.shadow_uri_of(&file.to_string_lossy()).unwrap();
        session
            .client
            .notify(
                "textDocument/didOpen",
                json!({ "textDocument": { "uri": uri, "languageId": "java", "version": 1, "text": text } }),
            )
            .unwrap();
    }

    // ① Shape 声明名上：子类型是 Circle / Square（都是直接实现，深度 1）
    let shape_file = real.join("src/demo/Shape.java");
    let shape = hierarchy(&session, &shape_file, 1, 18);
    eprintln!("Shape → {shape}");
    assert_eq!(shape["type"]["name"], "Shape");
    assert_eq!(shape["type"]["kind"], "interface");
    let subs = shape["subtypes"].as_array().expect("应有 subtypes");
    let names: Vec<&str> = subs.iter().filter_map(|s| s["name"].as_str()).collect();
    assert_eq!(names.len(), 2, "Shape 应有两个子类型：{names:?}");
    for s in subs {
        assert_eq!(s["depth"], 1, "直接实现深度应为 1：{s}");
        assert_eq!(s["direct"], true);
        let uri = s["location"]["uri"].as_str().expect("子类型应有位置");
        let path = uri_to_path(uri).expect("应能换回路径");
        assert!(
            path.to_lowercase()
                .starts_with(&real.to_string_lossy().to_lowercase()),
            "子类型位置应是真实路径（不是影子）：{path}"
        );
    }

    // ② Use 里 `Circle circle;` 的类型引用上：父类型含 Shape（直接）与 Object（无位置）
    let use_file = real.join("src/demo/Use.java");
    let circle = hierarchy(&session, &use_file, 3, 6);
    eprintln!("Circle → {circle}");
    assert_eq!(circle["type"]["name"], "Circle");
    let supers = circle["supertypes"].as_array().expect("应有 supertypes");
    let shape_entry = supers
        .iter()
        .find(|s| s["qualifiedName"] == "demo.Shape")
        .expect("Circle 的父类型里应有 demo.Shape");
    assert_eq!(shape_entry["depth"], 1);
    assert_eq!(shape_entry["direct"], true);
    let p = uri_to_path(shape_entry["location"]["uri"].as_str().unwrap()).unwrap();
    assert_eq!(
        p.replace('\\', "/").to_lowercase(),
        shape_file
            .to_string_lossy()
            .replace('\\', "/")
            .to_lowercase(),
        "父类型位置应换回真实路径"
    );
    let object = supers
        .iter()
        .find(|s| s["qualifiedName"] == "java.lang.Object")
        .expect("应有 java.lang.Object");
    assert!(
        object.get("location").is_none() || object["location"].is_null(),
        "二进制类型可能没有源码位置，字段缺省即可：{object}"
    );

    // ③ 光标在字段名上：退到所在类（IDEA 里也是这个行为），不能报错
    let enclosing = hierarchy(&session, &use_file, 2, 10);
    assert_eq!(enclosing["type"]["name"], "Use");

    session.client.shutdown();
}
