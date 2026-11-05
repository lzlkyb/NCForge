//! 真机：jdt.ls 0.57 的语义高亮怎么拿。
//!
//! 0.57 既没有标准 LSP 的 `textDocument/semanticTokens/full`，也没开 draft 的推送
//! （`textDocument/semanticHighlighting` 需要客户端声明能力，且是每行 base64 的旧编码）。
//! 它提供的是两个 `workspace/executeCommand`：
//! - `java.project.getSemanticTokensLegend`：`arguments: []` → `{ tokenTypes, tokenModifiers }`；
//! - `java.project.provideSemanticTokens`：`arguments: ["<影子工程 URI>"]` →
//!   `{ data: [Δline, Δstart, length, type, modifiers]... }`（标准 LSP 5 元组增量编码）。
//!
//! 这里验证四件事：
//! 1. legend 与 `TokenType` 声明顺序一致（前端按索引解类型，顺序错了就全歪）；
//! 2. 影子 URI 能被服务端认出来（`LangSession::shadow_uri_of` 产出的就是它）；
//! 3. `data` 是合法的 5 元组增量流，解出来的位置落在源码上；
//! 4. 缓冲区里的未保存修改也参与计算（`didOpen` 的文本才是准的）。
//!
//! 默认不跑（`#[ignore]`）：要本机有 JDK 8 与裁剪好的 jdt.ls。
//!
//! ```bash
//! cargo test --test semantic_tokens_live -- --ignored --nocapture --test-threads=1
//! ```

#![allow(non_snake_case)]

use nc_forge::lang::LangSession;
use nc_forge::lsp::{build_initialize_params, JdtlsLaunch, LspClient, LspHandler};
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
        std::env::temp_dir().join(format!("nc-forge-st-{tag}-{}-{nanos}", std::process::id()));
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

const PROJECT_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<projectDescription>
  <name>st-live</name>
  <buildSpec>
    <buildCommand><name>org.eclipse.jdt.core.javabuilder</name></buildCommand>
  </buildSpec>
  <natures><nature>org.eclipse.jdt.core.javanature</nature></natures>
</projectDescription>
"#;

const CLASSPATH_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<classpath>
  <classpathentry kind="src" path="src"/>
  <classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/>
  <classpathentry kind="output" path="bin"/>
</classpath>
"#;

// 注意别用 `\` 续行：Rust 会把下一行开头的空白一起吃掉，文件就没有缩进了，
// 语义 token 的列号会整体左移（第一次写这个探针就踩了）。
const TOKEN_DEMO: &str = concat!(
    "package demo;\n",
    "public class TokenDemo {\n",
    "    private static final int LIMIT = 10;\n",
    "    private String name;\n",
    "\n",
    "    public int compute(int input) {\n",
    "        int local = input * LIMIT;\n",
    "        return local + name.length();\n",
    "    }\n",
    "\n",
    "    @Deprecated\n",
    "    public int oldCompute(int input) {\n",
    "        return 0;\n",
    "    }\n",
    "}\n",
);

fn write_project(ws: &Path) {
    let src = ws.join("src/demo");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(ws.join(".project"), PROJECT_XML).unwrap();
    std::fs::write(ws.join(".classpath"), CLASSPATH_XML).unwrap();
    std::fs::write(src.join("TokenDemo.java"), TOKEN_DEMO).unwrap();
}

fn wait_project_ready(client: &LspClient) {
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        let found = client
            .request(
                "workspace/symbol",
                json!({ "query": "TokenDemo" }),
                Duration::from_secs(20),
            )
            .ok()
            .and_then(|v| v.as_array().cloned())
            .is_some_and(|a| {
                a.iter()
                    .any(|s| s["name"] == "TokenDemo" && s["location"]["uri"].as_str().is_some())
            });
        if found {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "90 秒内 jdt.ls 还没解析出 TokenDemo"
        );
        std::thread::sleep(Duration::from_millis(1000));
    }
}

fn execute(session: &LangSession, command: &str, args: Value) -> Value {
    session
        .client
        .request(
            "workspace/executeCommand",
            json!({ "command": command, "arguments": args }),
            Duration::from_secs(60),
        )
        .unwrap_or_else(|e| panic!("{command} 失败: {e}"))
}

/// 解 5 元组增量流：`(line, start, length, type, modifiers)`，行列都是 0 起。
fn decode(data: &[u32], legend: &[String]) -> Vec<(u32, u32, u32, String, u32)> {
    let mut out = Vec::new();
    let (mut line, mut start) = (0u32, 0u32);
    for t in data.as_chunks::<5>().0 {
        line += t[0];
        start = if t[0] == 0 { start + t[1] } else { t[1] };
        let ty = legend
            .get(t[3] as usize)
            .cloned()
            .unwrap_or_else(|| format!("#{}", t[3]));
        out.push((line, start, t[2], ty, t[4]));
    }
    out
}

#[test]
#[ignore = "要本机 JDK 8 + 裁剪好的 jdt.ls"]
fn 语义高亮命令返回标准五元组并且认影子路径() {
    let jh = java_home();
    if !jh.join("bin/java.exe").is_file() || !ls_dir().join("plugins").is_dir() {
        eprintln!("跳过：本机没有 JDK 8 / jdt.ls");
        return;
    }
    let base = temp("shadow");
    let real = base.join("real");
    write_project(&real);
    let shadow = base.join("shadow");
    std::fs::create_dir_all(&shadow).unwrap();
    nc_forge::shadow::ensure_link(&shadow.join("src"), &real.join("src")).unwrap();
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
    lsp.notify("initialized", json!({})).unwrap();
    wait_project_ready(&lsp);

    let session = LangSession::new(lsp, "gl", &real, &shadow);

    // ── ① legend：类型顺序就是 TokenType 的声明顺序 ──
    let legend = execute(&session, "java.project.getSemanticTokensLegend", json!([]));
    eprintln!("legend = {legend}");
    let types: Vec<String> = legend["tokenTypes"]
        .as_array()
        .expect("legend 应有 tokenTypes")
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    assert_eq!(
        types,
        [
            "comment",
            "keyword",
            "string",
            "number",
            "regexp",
            "operator",
            "namespace",
            "type",
            "struct",
            "class",
            "interface",
            "enum",
            "annotation",
            "typeParameter",
            "function",
            "member",
            "property",
            "macro",
            "variable",
            "parameter",
            "label",
        ]
    );
    let modifiers: Vec<String> = legend["tokenModifiers"]
        .as_array()
        .expect("legend 应有 tokenModifiers")
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    eprintln!("modifiers = {modifiers:?}");
    assert!(modifiers.iter().any(|m| m == "static"), "{modifiers:?}");
    assert!(modifiers.iter().any(|m| m == "readonly"), "{modifiers:?}");

    // ── ② 打开文档；缓冲区与磁盘故意不一致，验证用的是缓冲区文本 ──
    let file = real.join("src/demo/TokenDemo.java");
    let uri = session
        .shadow_uri_of(&file.to_string_lossy())
        .expect("影子 URI");
    eprintln!("shadow uri = {uri}");
    let buffer = format!("// edited in buffer\n{TOKEN_DEMO}");
    session
        .client
        .notify(
            "textDocument/didOpen",
            json!({ "textDocument": { "uri": uri, "languageId": "java", "version": 1, "text": buffer } }),
        )
        .unwrap();

    // ── ③ 拉取 token ──
    let res = execute(&session, "java.project.provideSemanticTokens", json!([uri]));
    let raw = res["data"].as_array().expect("应有 data");
    assert!(!raw.is_empty(), "空的 token 流说明 URI 没被认出来: {res}");
    let data: Vec<u32> = raw
        .iter()
        .map(|v| v.as_u64().expect("data 里只能是整数") as u32)
        .collect();
    assert_eq!(data.len() % 5, 0, "5 元组流长度必须是 5 的倍数");
    let tokens = decode(&data, &types);
    for (line, start, len, ty, mods) in &tokens {
        eprintln!("{line:>3}:{start:<3} +{len:<20} {ty:<12} mods={mods}");
    }

    // ── ④ 位置与类型 ──
    // 缓冲区在磁盘文本前多了一行，所有行号都应 +1。
    // 0.57 的这套映射很有限：类/接口名一律是 `type`，字段是 `property`，
    // 局部变量与形参都是 `variable`，方法名是 `function`（CLASS/INTERFACE/PARAMETER
    // 这些枚举值在 SimpleName 访问器里根本不发）。
    let at = |line: u32, start: u32| {
        tokens
            .iter()
            .find(|t| t.0 == line && t.1 == start)
            .unwrap_or_else(|| panic!("{line}:{start} 应有 token，实际 {tokens:?}"))
    };
    let cls = at(2, 13); // `public class TokenDemo {` 的 TokenDemo
    assert_eq!(cls.3, "type", "{cls:?}");
    assert_eq!(cls.2, "TokenDemo".len() as u32);
    let method = at(6, 15); // `public int compute(int input) {` 的 compute
    assert_eq!(method.3, "function", "{method:?}");
    let param = at(6, 27); // 同一行的 input
    assert_eq!(param.3, "variable", "{param:?}");
    let pkg = at(1, 8); // `package demo;` 的 demo
    assert_eq!(pkg.3, "namespace", "{pkg:?}");

    let static_bit = 1u32 << modifiers.iter().position(|m| m == "static").unwrap();
    let readonly_bit = 1u32 << modifiers.iter().position(|m| m == "readonly").unwrap();
    let limit = at(3, 29); // `private static final int LIMIT = 10;` 的 LIMIT
    assert_eq!(limit.3, "property", "{limit:?}");
    assert_eq!(
        limit.4 & (static_bit | readonly_bit),
        static_bit | readonly_bit,
        "static final 字段应带 static + readonly 修饰: {limit:?}"
    );
    // @Deprecated 的方法：function + deprecated 修饰位（前端据此画删除线）
    let deprecated_bit = 1u32 << modifiers.iter().position(|m| m == "deprecated").unwrap();
    let old = tokens
        .iter()
        .find(|t| t.3 == "function" && t.4 & deprecated_bit != 0)
        .unwrap_or_else(|| panic!("oldCompute 应带 deprecated 修饰: {tokens:?}"));
    assert_eq!(old.0, 12, "缓冲区行号（注释行 +1）: {old:?}");
    assert!(
        tokens.iter().any(|t| t.3 == "annotation"),
        "`@Deprecated` 应是 annotation token: {tokens:?}"
    );
    // 行号不能越过文档（14 行有效，0..=13）
    assert!(
        tokens.iter().all(|t| t.0 < 14),
        "token 行号越界: {tokens:?}"
    );

    // 同一文件重复拉取结果稳定（没有随机的行内顺序）
    let again = execute(&session, "java.project.provideSemanticTokens", json!([uri]));
    assert_eq!(again["data"], res["data"]);

    session.client.shutdown();
}
