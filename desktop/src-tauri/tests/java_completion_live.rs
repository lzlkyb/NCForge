//! Java 补全实机验收：复用生产 LSP 客户端与初始化参数，所有文件放测试临时目录。
//! NCFORGE_JDTLS_DIR / NCFORGE_JAVA_HOME 必填；NCFORGE_NC_HOME 可选，加入 NC 类场景。
use nc_forge::java_type_completion;
use nc_forge::java_types::TypeCatalog;
use nc_forge::lang::LangSession;
use nc_forge::lsp::{
    build_initialize_params, build_settings, path_to_uri, JdtlsLaunch, LspClient, LspHandler,
};
use nc_forge::nc_index::{classpath_jars, ClassIndex};
use nc_forge::shadow::{render_classpath, ClasspathInputs};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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
struct TempWorkspace(PathBuf);
impl Drop for TempWorkspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn items(result: &Value) -> Vec<Value> {
    result
        .as_array()
        .or_else(|| result["items"].as_array())
        .cloned()
        .unwrap_or_default()
}
fn demo(body: &str) -> String {
    format!("package demo;\npublic class CompletionDemo {{\n  void demo() {{\n    StringBuilder builder = new StringBuilder();\n    java.util.List<String> names = new java.util.ArrayList<>();\n    {body}\n  }}\n}}\n")
}
fn position(source: &str) -> (String, Value) {
    let index = source.find("/*cursor*/").expect("cursor");
    let before = &source[..index];
    let line = before.bytes().filter(|&b| b == b'\n').count();
    let character = before.rsplit('\n').next().unwrap().encode_utf16().count();
    (
        source.replace("/*cursor*/", ""),
        json!({ "line": line, "character": character }),
    )
}
type JarInput = Vec<(PathBuf, Option<PathBuf>)>;
fn nc_jars(base: &Path) -> (JarInput, Option<Arc<ClassIndex>>) {
    let Ok(home) = std::env::var("NCFORGE_NC_HOME") else {
        return (vec![], None);
    };
    let cache = base.join("class-index.bin");
    if let Ok(existing) = std::env::var("NCFORGE_CLASS_CACHE") {
        std::fs::copy(existing, &cache).unwrap();
    }
    let index = ClassIndex::load_or_build(classpath_jars(Path::new(&home)), Some(&cache), None);
    let mut ids = std::collections::BTreeSet::new();
    for name in ["nc.vo.pub.lang.UFDouble", "nc.vo.pub.BusinessException"] {
        ids.insert(
            index
                .jar_for_class(name)
                .unwrap_or_else(|| panic!("NC home 没找到 {name}")),
        );
    }
    let jars = ids
        .into_iter()
        .map(|id| (index.jars[id as usize].clone(), None))
        .collect();
    (jars, Some(Arc::new(index)))
}

#[test]
#[ignore = "需要本机 JDK 8 与 jdt.ls；通过 rust-gate 单独运行"]
fn java_completion_acceptance() {
    let java_home = PathBuf::from(std::env::var("NCFORGE_JAVA_HOME").expect("NCFORGE_JAVA_HOME"));
    let ls_dir = PathBuf::from(std::env::var("NCFORGE_JDTLS_DIR").expect("NCFORGE_JDTLS_DIR"));
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let temp = TempWorkspace(
        std::env::temp_dir().join(format!("ncforge-completion-{}-{stamp}", std::process::id())),
    );
    let root = temp.0.join("中文 空格工程");
    let src = root.join("src/demo");
    std::fs::create_dir_all(&src).unwrap();
    let (jars, index) = nc_jars(&temp.0);
    std::fs::write(root.join(".project"), "<projectDescription><name>completion-live</name><buildSpec><buildCommand><name>org.eclipse.jdt.core.javabuilder</name></buildCommand></buildSpec><natures><nature>org.eclipse.jdt.core.javanature</nature></natures></projectDescription>").unwrap();
    std::fs::write(
        root.join(".classpath"),
        render_classpath(&ClasspathInputs {
            src_dirs: &["src".into()],
            class_dirs: &[],
            jars: &jars,
        }),
    )
    .unwrap();
    std::fs::write(
        src.join("CompletionDemo.java"),
        demo("builder.append(\"ready\");"),
    )
    .unwrap();
    std::fs::write(
        src.join("WorkspaceWidget.java"),
        "package demo; public class WorkspaceWidget { public void refresh() {} }",
    )
    .unwrap();
    let client = LspClient::spawn(
        JdtlsLaunch {
            java_exe: &java_home.join("bin/java.exe"),
            ls_dir: &ls_dir,
            data_dir: &temp.0.join("data"),
            config_dir: &temp.0.join("cfg"),
            xmx_mb: 768,
        }
        .command()
        .unwrap(),
        Arc::new(Handler(java_home.to_string_lossy().into_owned())),
    )
    .unwrap();
    let extension = std::env::var("NCFORGE_JDTLS_EXT")
        .ok()
        .into_iter()
        .collect::<Vec<_>>();
    let initialized = client
        .request(
            "initialize",
            build_initialize_params(
                &root.to_string_lossy(),
                &java_home.to_string_lossy(),
                std::process::id(),
                &extension,
            ),
            Duration::from_secs(90),
        )
        .unwrap();
    client.notify("initialized", json!({})).unwrap();
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        let symbols = client
            .request(
                "workspace/symbol",
                json!({"query":"CompletionDemo"}),
                Duration::from_secs(15),
            )
            .unwrap();
        if symbols
            .as_array()
            .is_some_and(|a| a.iter().any(|s| s["name"] == "CompletionDemo"))
        {
            break;
        }
        assert!(Instant::now() < deadline, "语言服务未完成工程索引");
        std::thread::sleep(Duration::from_secs(1));
    }
    let mut session = LangSession::new(client, "demo", &root, &root);
    if let Some(index) = index {
        let cache = std::env::var("NCFORGE_TYPE_CATALOG_CACHE")
            .map(PathBuf::from)
            .unwrap_or_else(|_| temp.0.join("type-names.json"));
        let start = Instant::now();
        let catalog = TypeCatalog::load(&index, &cache, &|_, _| {});
        println!(
            "全 NC 类名目录 {} 个 jar，准备 {:.2}s",
            index.jars.len(),
            start.elapsed().as_secs_f32()
        );
        session = session.with_completion_catalog(index, Arc::new(catalog), &root);
    }
    let client = &session.client;
    let uri = path_to_uri(&src.join("CompletionDemo.java").to_string_lossy());
    let mut cases = vec![
        (
            "JDK 类名前缀",
            demo("ArrayL/*cursor*/ values;"),
            "ArrayList",
        ),
        ("驼峰首字母", demo("SB/*cursor*/ value;"), "StringBuilder"),
        (
            "工作区类",
            demo("WorkspaceW/*cursor*/ value;"),
            "WorkspaceWidget",
        ),
        ("对象方法重载", demo("builder.app/*cursor*/;"), "append"),
        (
            "构造器与菱形泛型",
            demo("java.util.List<String> list = new ArrayL/*cursor*/();"),
            "ArrayList",
        ),
        (
            "链式调用",
            demo("builder.append(\"ok\").toS/*cursor*/;"),
            "toString",
        ),
        ("流与泛型方法", demo("names.stream().ma/*cursor*/;"), "map"),
        (
            "继承方法",
            demo("WorkspaceWidget widget = new WorkspaceWidget(); widget.toS/*cursor*/;"),
            "toString",
        ),
        (
            "废弃方法",
            demo("Thread worker = new Thread(); worker.sto/*cursor*/;"),
            "stop",
        ),
        ("泛型返回值", demo("names.ge/*cursor*/;"), "get"),
        ("静态方法", demo("Math.ma/*cursor*/;"), "max"),
        (
            "完整包名前缀",
            demo("java.util.HashM/*cursor*/ value;"),
            "HashMap",
        ),
        ("同名类区分包", demo("Date/*cursor*/ value;"), "Date"),
        (
            "注解",
            "package demo;\n@Deprec/*cursor*/\npublic class CompletionDemo {}".into(),
            "Deprecated",
        ),
    ];
    if !jars.is_empty() {
        cases.push(("NC 类前缀", demo("UFDou/*cursor*/ value;"), "UFDouble"));
        cases.push(("NC 类方法", demo("nc.vo.pub.lang.UFDouble amount = new nc.vo.pub.lang.UFDouble(); amount.ad/*cursor*/;"), "add"));
        cases.push(("NC 跨模块未导入类", demo("BaseD/*cursor*/ dao;"), "BaseDAO"));
        cases.push((
            "按需加载后成员",
            demo("nc.bs.dao.BaseDAO dao = new nc.bs.dao.BaseDAO(); dao.retri/*cursor*/;"),
            "retrieveByPK",
        ));
    }
    let fields = (0..6500)
        .map(|i| format!("  private int field{i};\n"))
        .collect::<String>();
    cases.push(("6500 行有效源码", format!("package demo;\npublic class CompletionDemo {{\n{fields}  void demo() {{ ArrayL/*cursor*/ values; }}\n}}\n"), "ArrayList"));
    let mut results = vec![];
    let mut failures = vec![];
    for (index, (name, source, expected)) in cases.iter().enumerate() {
        let (text, pos) = position(source);
        let td = json!({ "uri": uri, "version": index + 1 });
        client
            .notify(
                if index == 0 {
                    "textDocument/didOpen"
                } else {
                    "textDocument/didChange"
                },
                if index == 0 {
                    json!({"textDocument":{"uri":uri,"version":1,"languageId":"java","text":text}})
                } else {
                    json!({"textDocument":td,"contentChanges":[{"text":text}]})
                },
            )
            .unwrap();
        let start = Instant::now();
        let raw = if *name == "NC 跨模块未导入类" {
            java_type_completion::candidates(&session, &json!({"prefix":"BaseD"}))
        } else {
            client
                .request(
                    "textDocument/completion",
                    json!({"textDocument":{"uri":uri},"position":pos}),
                    Duration::from_secs(15),
                )
                .unwrap()
        };
        let completion_ms = start.elapsed().as_millis();
        let list = items(&raw);
        let selected = list.iter().find(|item| {
            item["label"].as_str().is_some_and(|s| {
                s.starts_with(expected)
                    && s.as_bytes()
                        .get(expected.len())
                        .is_none_or(|c| matches!(c, b' ' | b'(' | b'<'))
            })
        });
        let resolved = selected.map(|item| {
            if *name == "NC 跨模块未导入类" {
                java_type_completion::resolve(
                    &session,
                    &json!({
                        "name":item["data"]["ncfType"],"textDocument":{"uri":uri},"position":pos
                    }),
                    Duration::from_secs(15),
                )
                .unwrap()
            } else {
                java_type_completion::resolve_item(&session, item, Duration::from_secs(15)).unwrap()
            }
        });
        let total_ms = start.elapsed().as_millis();
        let warm_start = Instant::now();
        client
            .request(
                "textDocument/completion",
                json!({"textDocument":{"uri":uri},"position":pos}),
                Duration::from_secs(15),
            )
            .unwrap();
        let warm_ms = warm_start.elapsed().as_millis();
        if *name == "对象方法重载" {
            assert!(list.len() >= 10, "重载遗漏");
        }
        if *name == "泛型返回值" {
            assert!(resolved.as_ref().unwrap()["label"]
                .as_str()
                .unwrap()
                .contains(": String"));
        }
        if *name == "同名类区分包" {
            for fqcn in ["java.util.Date", "java.sql.Date"] {
                assert!(
                    list.iter().any(|item| item["detail"] == fqcn),
                    "缺少同名类型 {fqcn}"
                );
            }
        }
        if *name == "废弃方法" {
            assert!(
                resolved.as_ref().unwrap()["deprecated"] == true
                    || resolved.as_ref().unwrap()["tags"]
                        .as_array()
                        .is_some_and(|a| a.contains(&json!(1))),
                "废弃标记缺失：raw={selected:?}, resolved={resolved:?}"
            );
        }
        if *name == "JDK 类名前缀" || *name == "NC 跨模块未导入类" {
            assert!(
                resolved.as_ref().unwrap().to_string().contains("import "),
                "未生成导入"
            );
        }
        if selected.is_none() {
            failures.push(*name);
        }
        results.push(json!({"case":name,"source":source,"raw":selected,"ms":total_ms,"completionMs":completion_ms,"resolveMs":total_ms-completion_ms,"warmMs":warm_ms,"count":list.len(),"incomplete":raw.get("isIncomplete"),"expected":expected,"found":selected.is_some(),"labels":list.iter().take(5).map(|v|v["label"].clone()).collect::<Vec<_>>(),"resolved":resolved}));
    }
    let mut all_jars = jars.iter().map(|(p, _)| p.clone()).collect::<Vec<_>>();
    if let Some((index, _, _)) = &session.completion_catalog {
        all_jars.extend(nc_forge::compile::type_dependency_jars(
            index,
            "nc.bs.dao.BaseDAO",
        ));
        all_jars.sort();
        all_jars.dedup();
    }
    let report = json!({"classpathJars":all_jars,"server":initialized["capabilities"]["completionProvider"],"cases":results});
    for result in &results {
        println!(
            "{}: {} ms, {} 项, 命中 {}",
            result["case"], result["ms"], result["count"], result["found"]
        );
    }
    if let Ok(path) = std::env::var("NCFORGE_COMPLETION_REPORT") {
        std::fs::write(path, serde_json::to_string_pretty(&report).unwrap()).unwrap();
    }
    client.shutdown();
    assert!(failures.is_empty(), "补全验收失败：{failures:?}");
}
