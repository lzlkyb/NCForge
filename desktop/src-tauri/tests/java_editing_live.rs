//! 真实 JDT 编辑验收。通过 rust-gate 单独运行，与其他重任务保持串行。
//! NCFORGE_JAVA_HOME / NCFORGE_JDTLS_DIR 必填；不依赖 NC 产品或新增扩展。
use nc_forge::lsp::{
    build_initialize_params, build_settings, path_to_uri, JdtlsLaunch, LspClient, LspHandler,
};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

#[path = "../src/test_support.rs"]
mod test_support;

struct Handler(String);
impl LspHandler for Handler {
    fn on_notification(&self, _method: &str, _params: Value) {}
    fn on_request(&self, method: &str, params: &Value) -> Value {
        if method == "workspace/configuration" {
            return Value::Array(vec![
                build_settings(&self.0);
                params["items"].as_array().map_or(0, Vec::len)
            ]);
        }
        Value::Null
    }
}
struct Temp(PathBuf);
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
struct Running {
    client: LspClient,
    logs: PathBuf,
}
impl std::ops::Deref for Running {
    type Target = LspClient;
    fn deref(&self) -> &Self::Target {
        &self.client
    }
}
impl Drop for Running {
    fn drop(&mut self) {
        if std::thread::panicking() {
            eprintln!("{}", failure_logs(&self.logs));
        }
        self.client.shutdown();
    }
}
fn failure_logs(root: &std::path::Path) -> String {
    let mut paths = vec![root.join("stderr.log"), root.join("data/.metadata/.log")];
    if let Ok(entries) = std::fs::read_dir(root.join("cfg")) {
        paths.extend(
            entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| path.extension().is_some_and(|ext| ext == "log")),
        );
    }
    paths
        .into_iter()
        .filter_map(|path| {
            std::fs::read_to_string(&path)
                .ok()
                .map(|text| format!("{}:\n{text}", path.display()))
        })
        .collect::<Vec<_>>()
        .join("\n")
}
fn java_path(path: PathBuf) -> PathBuf {
    // canonicalize emits Windows verbatim paths; Java 8/OSGi cannot parse those as configuration URLs.
    let text = path.to_string_lossy();
    if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{unc}"))
    } else if let Some(normal) = text.strip_prefix(r"\\?\") {
        PathBuf::from(normal)
    } else {
        path
    }
}
fn request(client: &Running, method: &str, params: Value) -> Value {
    client
        .request(method, params, Duration::from_secs(20))
        .unwrap_or_else(|error| panic!("{method}: {error}\n{}", failure_logs(&client.logs)))
}
fn position_at(source: &str, offset: usize) -> Value {
    let before = &source[..offset];
    json!({"line": before.bytes().filter(|byte| *byte == b'\n').count(),
        "character": before.rsplit('\n').next().unwrap().encode_utf16().count()})
}
fn offset_at(source: &str, position: &Value) -> usize {
    let line = position["line"].as_u64().unwrap() as usize;
    let column = position["character"].as_u64().unwrap() as usize;
    let line_start = source
        .match_indices('\n')
        .take(line)
        .last()
        .map_or(0, |(index, _)| index + 1);
    assert_eq!(
        source[..line_start]
            .bytes()
            .filter(|byte| *byte == b'\n')
            .count(),
        line
    );
    let mut units = 0;
    for (index, ch) in source[line_start..].char_indices() {
        if units == column {
            return line_start + index;
        }
        assert_ne!(ch, '\n', "LSP 编辑列超出行末");
        units += ch.len_utf16();
    }
    assert_eq!(units, column);
    source.len()
}
fn apply_edits(source: &str, edits: &Value) -> String {
    let mut changes = edits
        .as_array()
        .expect("格式化应返回编辑数组")
        .iter()
        .map(|edit| {
            (
                offset_at(source, &edit["range"]["start"]),
                offset_at(source, &edit["range"]["end"]),
                edit["newText"].as_str().unwrap(),
            )
        })
        .collect::<Vec<_>>();
    changes.sort_by_key(|(start, _, _)| *start);
    assert!(changes.windows(2).all(|pair| pair[0].1 <= pair[1].0));
    let mut result = source.to_string();
    for (start, end, text) in changes.into_iter().rev() {
        result.replace_range(start..end, text);
    }
    result
}
fn change(client: &Running, uri: &str, source: &str, version: u32) {
    client
        .notify("textDocument/didChange", json!({"textDocument":{"uri":uri,"version":version},"contentChanges":[{"text":source}]}))
        .unwrap();
}
fn assert_parameter_names(
    client: &Running,
    uri: &str,
    source: &str,
    call: &str,
    expected: &[&str],
) {
    let offset = source.find(call).unwrap() + call.find('(').unwrap() + 1;
    let help = request(
        client,
        "textDocument/signatureHelp",
        json!({"textDocument":{"uri":uri},"position":position_at(source, offset)}),
    );
    let signature = &help["signatures"][help["activeSignature"].as_u64().unwrap_or(0) as usize];
    let parameters = signature["parameters"].as_array().expect("真实参数列表");
    let names = parameters
        .iter()
        .map(|parameter| {
            let label = &parameter["label"];
            if let Some(text) = label.as_str() {
                text.to_string()
            } else {
                let label_text = signature["label"]
                    .as_str()
                    .unwrap()
                    .encode_utf16()
                    .collect::<Vec<_>>();
                String::from_utf16(
                    &label_text
                        [label[0].as_u64().unwrap() as usize..label[1].as_u64().unwrap() as usize],
                )
                .unwrap()
            }
        })
        .map(|label| label.split_whitespace().last().unwrap_or("").to_string())
        .collect::<Vec<_>>();
    assert_eq!(names, expected, "signatureHelp: {help}");
    println!("真实参数名 {call}: {names:?}");
}

#[test]
#[ignore = "需要本机 JDK 8 和 jdt.ls；通过 rust-gate 串行运行"]
fn formatting_and_real_parameter_names() {
    let java_home = java_path(PathBuf::from(
        std::env::var("NCFORGE_JAVA_HOME").expect("NCFORGE_JAVA_HOME"),
    ));
    let ls_dir = java_path(PathBuf::from(
        std::env::var("NCFORGE_JDTLS_DIR").expect("NCFORGE_JDTLS_DIR"),
    ));
    let temp = Temp(java_path(test_support::tmp("java-editing-live")));
    let root = temp.0.join("中文 空格工程");
    let src = root.join("src/demo");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(root.join(".project"), "<projectDescription><name>editing-live</name><buildSpec><buildCommand><name>org.eclipse.jdt.core.javabuilder</name></buildCommand></buildSpec><natures><nature>org.eclipse.jdt.core.javanature</nature></natures></projectDescription>").unwrap();
    std::fs::write(root.join(".classpath"), "<classpath><classpathentry kind=\"src\" path=\"src\"/><classpathentry kind=\"con\" path=\"org.eclipse.jdt.launching.JRE_CONTAINER\"/><classpathentry kind=\"output\" path=\"bin\"/></classpath>").unwrap();
    let source = "package demo;\npublic class EditingDemo {\nprivate int keep=1;\npublic void load(String name,int count) {}\npublic void load(int count) {}\nvoid use() {\nload(\"中文\",2);\nload(3);\n}\n}\n";
    let file = src.join("EditingDemo.java");
    std::fs::write(&file, source).unwrap();
    let running = Running {
        client: LspClient::spawn_with_stderr(
            JdtlsLaunch {
                java_exe: &java_home.join("bin/java.exe"),
                ls_dir: &ls_dir,
                data_dir: &temp.0.join("data"),
                config_dir: &temp.0.join("cfg"),
                xmx_mb: 600,
                syntax_server: false,
            }
            .command()
            .unwrap(),
            Arc::new(Handler(java_home.to_string_lossy().into_owned())),
            &temp.0.join("stderr.log"),
        )
        .unwrap(),
        logs: temp.0.clone(),
    };
    let client = &running;
    client
        .request(
            "initialize",
            build_initialize_params(
                &root.to_string_lossy(),
                &java_home.to_string_lossy(),
                std::process::id(),
                &[],
            ),
            Duration::from_secs(90),
        )
        .unwrap_or_else(|error| panic!("initialize: {error}\n{}", failure_logs(&temp.0)));
    client.notify("initialized", json!({})).unwrap();
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        let symbols = request(client, "workspace/symbol", json!({"query":"EditingDemo"}));
        if symbols
            .as_array()
            .is_some_and(|items| items.iter().any(|symbol| symbol["name"] == "EditingDemo"))
        {
            break;
        }
        assert!(Instant::now() < deadline, "JDT 未完成工程索引");
        std::thread::sleep(Duration::from_secs(1));
    }
    let uri = path_to_uri(&file.to_string_lossy());
    client
        .notify(
            "textDocument/didOpen",
            json!({"textDocument":{"uri":uri,"version":1,"languageId":"java","text":source}}),
        )
        .unwrap();
    let options = json!({"tabSize":4,"insertSpaces":true});
    let edits = request(
        client,
        "textDocument/formatting",
        json!({"textDocument":{"uri":uri},"options":options}),
    );
    assert!(
        !edits.as_array().unwrap().is_empty(),
        "整文件格式化没有真实编辑"
    );
    let formatted = apply_edits(source, &edits);
    assert!(formatted.contains("load(\"中文\", 2)"), "{formatted}");
    assert!(formatted.contains("private int keep = 1;"), "{formatted}");
    change(client, &uri, &formatted, 2);
    let repeat = request(
        client,
        "textDocument/formatting",
        json!({"textDocument":{"uri":uri},"options":options}),
    );
    assert_eq!(
        apply_edits(&formatted, &repeat),
        formatted,
        "格式化应当幂等"
    );
    assert_parameter_names(
        client,
        &uri,
        &formatted,
        "load(\"中文\", 2)",
        &["name", "count"],
    );
    assert_parameter_names(client, &uri, &formatted, "load(3)", &["count"]);
    change(client, &uri, source, 3);
    let start = source.find("void use()").unwrap();
    let end = source[start..].find("\n}").unwrap() + start + 2;
    let selected = request(
        client,
        "textDocument/rangeFormatting",
        json!({"textDocument":{"uri":uri},"range":{"start":position_at(source,start),"end":position_at(source,end)},"options":options}),
    );
    assert!(
        !selected.as_array().unwrap().is_empty(),
        "选区格式化没有真实编辑"
    );
    let ranged = apply_edits(source, &selected);
    assert!(ranged.contains("load(\"中文\", 2)"), "{ranged}");
    assert!(
        ranged.contains("private int keep=1;"),
        "选区外字段不应格式化: {ranged}"
    );
    println!("整文件与选区格式化、幂等性、真实参数名和重载全部通过");
}
