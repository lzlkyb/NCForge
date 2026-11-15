//! Local main/JUnit execution. Classes compile into private run directories, never NCHOME.
use crate::java_run::{self, JavaRunRequest, JavaRunResult, JavaRuns};
use crate::state::AppState;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use tauri::Emitter;

const AGENT_SHA: &str = "115e8e6e6593ca3a9892dfef695df4d487c706e59e71e64dc0ab95716ee02622";
const CLI_SHA: &str = "594c01125b84864a7fc5a9efab19b71b7de36b27346863f6d7cd0cd45400ceb0";
const JUNIT_SHA: &str = "a1de557821293ce903c213c694165fff532cf92081bac4238b9e05b35f04f43f";
async fn download_tool(
    state: &AppState,
    file: &str,
    url: String,
    digest: &str,
) -> Result<PathBuf, String> {
    let dir = state.config_dir.join("java-tools");
    let path = dir.join(file);
    let cached = path.clone();
    let hash = digest.to_owned();
    let valid = tauri::async_runtime::spawn_blocking(move || {
        std::fs::read(&cached).is_ok_and(|bytes| format!("{:x}", Sha256::digest(bytes)) == hash)
    })
    .await
    .map_err(|e| e.to_string())?;
    if valid {
        return Ok(path);
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("下载 Java 测试工具失败：{e}"))?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() + chunk.len() > 8 * 1024 * 1024 {
            return Err("Java 工具包超出 8 MiB 上限".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    if format!("{:x}", Sha256::digest(&bytes)) != digest {
        return Err("Java 工具包校验失败，未执行下载的文件".into());
    }
    let write_path = path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        crate::atomic_file::write_atomic(&write_path, &bytes)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(path)
}
async fn jacoco_tool(state: &AppState, classifier: &str, digest: &str) -> Result<PathBuf, String> {
    let name = if classifier == "runtime" {
        "agent"
    } else {
        "cli"
    };
    download_tool(state, &format!("jacoco-{name}-0.8.12.jar"), format!("https://repo.maven.apache.org/maven2/org/jacoco/org.jacoco.{name}/0.8.12/org.jacoco.{name}-0.8.12-{classifier}.jar"), digest).await
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunLog {
    id: String,
    text: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunStarted {
    id: String,
    pid: u32,
    debug_port: Option<u16>,
}
fn emit_log(app: &tauri::AppHandle, id: &str, text: &str) {
    let _ = app.emit(
        "java-run-log",
        RunLog {
            id: id.into(),
            text: text.into(),
        },
    );
}

fn checked_path(path: &str, allowed: &[String]) -> Result<PathBuf, String> {
    crate::security::path::resolve_safe_path(path, allowed, &[], true)
        .map(|p| crate::nc_home::strip_verbatim(&p))
}
struct CompileSelection<'a> {
    java: &'a Path,
    ecj: &'a Path,
    directory: &'a Path,
    classpath: &'a Path,
    sources: &'a [PathBuf],
    source_roots: &'a [PathBuf],
    cancel: &'a AtomicBool,
    registry: &'a java_run::ProcessRegistry,
}
fn compile_selected(selection: CompileSelection<'_>, log: impl FnMut(&str)) -> Result<(), String> {
    let CompileSelection {
        java,
        ecj,
        directory,
        classpath,
        sources,
        source_roots,
        cancel,
        registry,
    } = selection;
    let out = directory.join("classes");
    std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
    let runner = directory.join("NcJavaTestRunner.java");
    crate::atomic_file::write_atomic(
        &runner,
        include_str!("../../java-runner/NcJavaTestRunner.java").as_bytes(),
    )?;
    let mut args = vec![
        "-1.8".into(),
        "-g".into(),
        "-proc:none".into(),
        "-nowarn".into(),
        "-d".into(),
        out.to_string_lossy().into(),
        "-classpath".into(),
        classpath.to_string_lossy().into(),
    ];
    if !source_roots.is_empty() {
        args.extend([
            "-sourcepath".into(),
            std::env::join_paths(source_roots)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .into(),
        ]);
    }
    for source in sources {
        let bytes = std::fs::read(source).map_err(|e| e.to_string())?;
        let encoding =
            if crate::workspace::detect_encoding(&bytes) == crate::workspace::TextEncoding::Utf8 {
                "UTF-8"
            } else {
                "GBK"
            };
        args.push(format!("{}[{encoding}]", source.to_string_lossy()));
    }
    args.push(format!("{}[UTF-8]", runner.to_string_lossy()));
    let arg_file = directory.join("compile.args");
    java_run::java_args_file(&arg_file, &args)?;
    let mut cmd = Command::new(java);
    cmd.args(["-Xmx512m", "-Dfile.encoding=UTF-8", "-cp"])
        .arg(ecj)
        .arg("org.eclipse.jdt.internal.compiler.batch.Main")
        .arg(format!("@{}", arg_file.to_string_lossy()));
    let result = java_run::execute_registered(
        &mut cmd,
        "compile",
        cancel,
        Duration::from_secs(120),
        log,
        |_| {},
        Some(registry),
    )?;
    if result.ok {
        Ok(())
    } else {
        Err(if result.cancelled {
            "运行准备已取消".into()
        } else {
            "运行前编译失败，请查看输出中的具体错误".into()
        })
    }
}

#[tauri::command]
pub async fn java_run(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    jobs: tauri::State<'_, JavaRuns>,
    request: JavaRunRequest,
) -> Result<JavaRunResult, String> {
    java_run::validate(&request)?;
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut active = jobs.0.lock().map_err(|e| e.to_string())?;
        if !active.is_empty() {
            return Err("已有 Java 运行任务，请先停止或等待完成".into());
        }
        active.insert(request.id.clone(), cancel.clone());
    }
    let id = request.id.clone();
    let pid_registry = jobs.1.clone();
    let work = async {
        let cfg = state.config.read().await;
        let raw_root = cfg.workspace_root.clone().ok_or("尚未选择工程")?;
        let home = crate::nc_home::resolve(cfg.nc_home.as_deref())?;
        let overrides = crate::eclipse_cp::active_overrides(&cfg.linked_overrides); drop(cfg);
        let junit = if request.mode == "test" {
            emit_log(&app, &id, "准备 JUnit 4/5 测试引擎（首次使用按需下载并校验）…\n");
            Some(download_tool(&state, "junit-console-1.10.2.jar", "https://repo.maven.apache.org/maven2/org/junit/platform/junit-platform-console-standalone/1.10.2/junit-platform-console-standalone-1.10.2.jar".into(), JUNIT_SHA).await?)
        } else { None };
        let tools = if request.coverage {
            emit_log(&app, &id, "准备 JaCoCo 覆盖率工具（首次使用按需下载并校验）…\n");
            Some((jacoco_tool(&state, "runtime", AGENT_SHA).await?, jacoco_tool(&state, "nodeps", CLI_SHA).await?))
        } else { None };
        let ecj = super::compile_cmds::find_ecj(&state.config_dir)?;
        let runtime_dir = state.config_dir.join("java-runs");
        let run_id = id.clone(); let handle = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let root = checked_path(&raw_root, std::slice::from_ref(&raw_root))?;
            let home_path = PathBuf::from(home.root);
            let allowed = vec![raw_root, home_path.to_string_lossy().into_owned()];
            let source = checked_path(&request.path, &allowed)?;
            if !crate::build_layout::path_starts_with(&source, &root) { return Err("运行目标必须位于当前工程".into()); }
            if !source.is_dir() && source.extension().is_none_or(|e| e != "java") { return Err("运行源必须是 Java 文件或模块目录".into()); }
            let module = crate::compile::module_of(&root, &source).unwrap_or_default();
            let module_dir = if source.is_dir() { source.clone() } else if module.is_empty() { root.clone() } else { root.join(&module) };
            let directory = java_run::prepare_run_directory(&runtime_dir, &run_id)?;
            let outputs = crate::launch::project_class_dirs(&root, &home_path, &overrides);
            let mut classpath = crate::launch::middleware_classpath(&home_path, &outputs);
            if let Some(junit) = junit { classpath.insert(0, junit); }
            for extra in &request.extra_classpath { classpath.push(checked_path(extra, &allowed)?); }
            let base_cp = directory.join("base-cp.jar"); crate::launch::write_pathing_jar(&base_cp, &classpath)?;
            let sources = if request.mode == "main" && source.is_file() { vec![source.clone()] } else { java_run::selected_sources(&module_dir, &request.classes, source.is_file().then_some(source.as_path()))? };
            let layout = crate::build_layout::ModuleLayout::resolve(&root, &module);
            let mut source_roots = layout.source_roots.clone();
            for extra in ["src/test/java", "src/test", "test", "tests"] { let path = module_dir.join(extra); if path.is_dir() { source_roots.push(path); } }
            compile_selected(CompileSelection { java: Path::new(&home.java), ecj: &ecj, directory: &directory, classpath: &base_cp, sources: &sources, source_roots: &source_roots, cancel: &cancel, registry: &pid_registry }, |text| emit_log(&handle, &run_id, text))?;
            classpath.insert(0, directory.join("classes"));
            let cp = directory.join("runtime-cp.jar"); crate::launch::write_pathing_jar(&cp, &classpath)?;
            let debug_port = if request.debug { Some(crate::server::free_loopback_port()?) } else { None };
            let mut command = Command::new(&home.java); command.current_dir(&module_dir).args(["-Xmx512m", "-Dfile.encoding=UTF-8"]);
            if let Some(port) = debug_port { command.arg(format!("-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:{port}")); }
            let coverage_exec = directory.join("coverage.exec");
            if let Some((agent, _)) = &tools { command.arg(format!("-javaagent:{}=destfile={},append=false", agent.to_string_lossy(), coverage_exec.to_string_lossy())); }
            command.arg("-cp").arg(&cp);
            if request.mode == "main" { command.arg(&request.classes[0]).args(&request.args); }
            else {
                let targets = directory.join("test-targets.txt"); crate::atomic_file::write_atomic(&targets, request.classes.join("\n").as_bytes())?;
                command.arg("NcJavaTestRunner").arg("--targets-file").arg(targets);
            }
            let mut result = java_run::execute_registered(&mut command, &run_id, &cancel, Duration::from_secs(1800), |text| emit_log(&handle, &run_id, text), |pid| { let _ = handle.emit("java-run-started", RunStarted { id: run_id.clone(), pid, debug_port }); }, Some(&pid_registry))?;
            if request.mode == "test" && result.ok && result.tests.is_empty() { result.ok = false; emit_log(&handle, &run_id, "测试进程未返回执行结果，不能判定测试通过。\n"); }
            if let Some((_, cli)) = tools.filter(|_| !result.cancelled && coverage_exec.is_file()) {
                let report = directory.join("coverage");
                let mut report_command = Command::new(&home.java); report_command.arg("-Xmx512m").arg("-jar").arg(cli).arg("report").arg(&coverage_exec).arg("--html").arg(&report);
                let mut report_roots = vec![directory.join("classes")]; report_roots.extend(outputs);
                let report_classes = match java_run::coverage_classes(&directory, &report_roots, &cancel) {
                    Ok(path) => path,
                    Err(error) => { emit_log(&handle, &run_id, &format!("覆盖率报告准备失败：{error}。测试结果保留。\n")); return Ok(result); }
                };
                report_command.arg("--classfiles").arg(report_classes);
                for src in source_roots.into_iter().filter(|p| p.is_dir()) { report_command.arg("--sourcefiles").arg(src); }
                let generated = java_run::execute_registered(&mut report_command, &run_id, &cancel, Duration::from_secs(120), |text| emit_log(&handle, &run_id, text), |_| {}, Some(&pid_registry))?;
                if generated.ok && report.join("index.html").is_file() { result.report = Some(report.join("index.html").to_string_lossy().into()); }
                else { emit_log(&handle, &run_id, "覆盖率报告生成失败，测试结果保留；请查看工具输出。\n"); }
            }
            Ok(result)
        }).await.map_err(|e| format!("运行后台任务失败：{e}"))?
    }.await;
    jobs.0.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    work
}

#[tauri::command]
pub fn java_run_cancel(jobs: tauri::State<'_, JavaRuns>, id: String) -> Result<(), String> {
    if let Some(flag) = jobs.0.lock().map_err(|e| e.to_string())?.get(&id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}
#[tauri::command]
pub async fn java_run_discover(
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
) -> Result<Vec<java_run::TestCandidate>, String> {
    let root = state
        .config
        .read()
        .await
        .workspace_root
        .clone()
        .ok_or("尚未选择工程")?;
    tauri::async_runtime::spawn_blocking(move || {
        let resolved = checked_path(&path, std::slice::from_ref(&root))?;
        let root_path = PathBuf::from(root);
        let module = crate::compile::module_of(&root_path, &resolved).unwrap_or_default();
        let target = if resolved.is_dir() {
            resolved
        } else if module.is_empty() {
            root_path
        } else {
            root_path.join(module)
        };
        java_run::discover_tests(&target)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn java_run_open_report(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
) -> Result<(), String> {
    let allowed = state.config_dir.join("java-runs");
    let target = tauri::async_runtime::spawn_blocking(move || {
        checked_path(&path, &[allowed.to_string_lossy().into_owned()])
    })
    .await
    .map_err(|e| e.to_string())??;
    if target.file_name().is_none_or(|name| name != "index.html") {
        return Err("只能打开本工作台生成的覆盖率首页".into());
    }
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(target.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}
