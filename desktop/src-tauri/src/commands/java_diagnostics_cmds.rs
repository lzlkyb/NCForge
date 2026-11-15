//! Bounded JDK diagnostics for the workbench's own JVMs and local Java processes.
use crate::java_run;
use crate::state::AppState;
use std::path::Path;
use std::process::Command;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use std::time::Duration;
static DIAGNOSTIC_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[tauri::command]
pub async fn java_diagnostic(
    state: tauri::State<'_, Arc<AppState>>,
    jobs: tauri::State<'_, java_run::JavaRuns>,
    pid: u32,
    action: String,
) -> Result<String, String> {
    let tool = match action.as_str() {
        "threads" => "jstack",
        "histogram" | "vm" | "jfr-start" | "jfr-stop" => "jcmd",
        _ => return Err("不支持的 JVM 诊断操作".into()),
    };
    if pid == 0 {
        return Err("请输入本机 Java 进程号".into());
    }
    let config = state.config.read().await;
    let home = crate::nc_home::resolve(config.nc_home.as_deref())?;
    drop(config);
    let config_dir = state.config_dir.clone();
    let pid_registry = jobs.1.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let process = crate::server::process_name(pid).ok_or("无法确认该进程是否仍在运行")?;
        if !crate::server::is_java_name(&process) {
            return Err("只能对已确认的本机 Java 进程执行诊断".into());
        }
        let executable = Path::new(&home.java)
            .parent()
            .ok_or("Java 目录不可用")?
            .join(if cfg!(windows) {
                format!("{tool}.exe")
            } else {
                tool.into()
            });
        if !executable.is_file() {
            return Err(format!(
                "当前 JDK 缺少 {tool}，请使用包含诊断工具的完整 JDK"
            ));
        }
        let mut cmd = Command::new(executable);
        cmd.arg(pid.to_string());
        match action.as_str() {
            "threads" => {}
            "histogram" => {
                cmd.arg("GC.class_histogram");
            }
            "vm" => {
                cmd.arg("VM.version");
            }
            "jfr-start" => {
                cmd.arg("JFR.start")
                    .arg("name=NCForge")
                    .arg("settings=profile");
            }
            "jfr-stop" => {
                let directory = config_dir.join("java-diagnostics");
                std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
                cmd.arg("JFR.stop").arg("name=NCForge").arg(format!(
                    "filename={}",
                    directory
                        .join(format!("profile-{pid}.jfr"))
                        .to_string_lossy()
                ));
            }
            _ => unreachable!(),
        }
        let mut output = String::new();
        let id = format!(
            "diagnostic-{}",
            DIAGNOSTIC_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        );
        let result = java_run::execute_registered(
            &mut cmd,
            &id,
            &AtomicBool::new(false),
            Duration::from_secs(45),
            |line| {
                if output.len() + line.len() <= 8 * 1024 * 1024 {
                    output.push_str(line);
                }
            },
            |_| {},
            Some(&pid_registry),
        )?;
        if result.ok {
            Ok(output)
        } else {
            Err(format!(
                "JDK 诊断未成功（退出码 {:?}）：{output}",
                result.exit_code
            ))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
