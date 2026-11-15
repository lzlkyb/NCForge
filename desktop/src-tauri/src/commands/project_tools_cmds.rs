use crate::java_run::{JavaRunResult, JavaRuns};
use crate::state::AppState;
use std::process::Command;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use tauri::Emitter;

fn tool_arguments(tool: &str, action: &str) -> Result<(&'static str, Vec<&'static str>), String> {
    match (tool, action) {
        ("maven", "compile") => Ok(("mvn", vec!["--batch-mode", "compile"])),
        ("maven", "test") => Ok(("mvn", vec!["--batch-mode", "test"])),
        ("maven", "package") => Ok(("mvn", vec!["--batch-mode", "package"])),
        ("gradle", "classes") => Ok(("gradle", vec!["--no-daemon", "classes"])),
        ("gradle", "test") => Ok(("gradle", vec!["--no-daemon", "test"])),
        ("gradle", "build") => Ok(("gradle", vec!["--no-daemon", "build"])),
        _ => Err("请选择 Maven 或 Gradle 的受支持任务".into()),
    }
}
#[tauri::command]
pub async fn project_run_tool(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    jobs: tauri::State<'_, JavaRuns>,
    id: String,
    tool: String,
    action: String,
) -> Result<JavaRunResult, String> {
    if id.is_empty() || id.len() > 80 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("任务标识无效".into());
    }
    let (program, args) = tool_arguments(&tool, &action)?;
    let configured = state
        .config
        .read()
        .await
        .workspace_root
        .clone()
        .ok_or("尚未打开工程")?;
    let root = crate::security::path::resolve_safe_path(
        &configured,
        std::slice::from_ref(&configured),
        &[],
        true,
    )?;
    let root = crate::nc_home::strip_verbatim(&root);
    if tool == "maven" && !root.join("pom.xml").is_file() {
        return Err("当前工程根没有 pom.xml；请选择 Maven 工程后运行".into());
    }
    if tool == "gradle"
        && !root.join("build.gradle").is_file()
        && !root.join("build.gradle.kts").is_file()
    {
        return Err("当前工程根没有 Gradle 构建文件".into());
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut active = jobs.0.lock().map_err(|e| e.to_string())?;
        if !active.is_empty() {
            return Err("已有运行或构建任务，请先停止或等待完成".into());
        }
        active.insert(id.clone(), cancelled.clone());
    }
    let request_id = id.clone();
    let pid_registry = jobs.1.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let wrapper = if tool == "maven" {
            if cfg!(windows) {
                "mvnw.cmd"
            } else {
                "mvnw"
            }
        } else if cfg!(windows) {
            "gradlew.bat"
        } else {
            "gradlew"
        };
        let wrapper_path = root.join(wrapper);
        let executable = if wrapper_path.is_file() {
            wrapper_path
        } else {
            std::path::PathBuf::from(if cfg!(windows) {
                format!("{program}.cmd")
            } else {
                program.into()
            })
        };
        let mut command = Command::new(executable);
        command.current_dir(root).args(args);
        crate::java_run::execute_registered(
            &mut command,
            &request_id,
            &cancelled,
            Duration::from_secs(1800),
            |text| {
                let _ = app.emit(
                    "java-run-log",
                    serde_json::json!({"id":request_id,"text":text}),
                );
            },
            |_| {},
            Some(&pid_registry),
        )
    })
    .await
    .map_err(|e| format!("构建工具任务失败：{e}"));
    jobs.0.lock().map_err(|e| e.to_string())?.remove(&id);
    result?
}
#[tauri::command]
pub async fn project_stop_tool(jobs: tauri::State<'_, JavaRuns>, id: String) -> Result<(), String> {
    if let Some(cancel) = jobs.0.lock().map_err(|e| e.to_string())?.get(&id) {
        cancel.store(true, Ordering::Relaxed);
    }
    Ok(())
}
#[tauri::command]
pub async fn project_open_terminal(state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    let configured = state
        .config
        .read()
        .await
        .workspace_root
        .clone()
        .ok_or("尚未打开工程")?;
    let root = crate::security::path::resolve_safe_path(
        &configured,
        std::slice::from_ref(&configured),
        &[],
        true,
    )?;
    // This is an explicit interactive terminal action; background build commands remain hidden.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        Command::new("powershell.exe")
            .args(["-NoLogo", "-NoExit"])
            .current_dir(root)
            .creation_flags(0x0000_0010)
            .spawn()
            .map_err(|e| format!("打开终端失败：{e}"))?;
    }
    #[cfg(not(windows))]
    {
        Command::new("x-terminal-emulator")
            .current_dir(root)
            .spawn()
            .map_err(|e| format!("未找到系统终端，请安装 x-terminal-emulator：{e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn permits_only_fixed_build_actions() {
        assert!(tool_arguments("maven", "test").is_ok());
        assert!(tool_arguments("gradle", "build").is_ok());
        assert!(tool_arguments("maven", "test & del").is_err());
        assert!(tool_arguments("cmd", "test").is_err());
    }
}
