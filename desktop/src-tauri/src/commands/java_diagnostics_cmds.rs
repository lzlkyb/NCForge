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

/// 各诊断动作的时间上限。
///
/// 🔴 `jfr-stop` **不能复用 45s**：它要把目标 JVM 里累积的整份 profile 落盘，
/// 录制久了就是几百 MB，45s 写不完 ⇒ `execute_registered` 超时分支 `tree.kill()`
/// 杀掉 jcmd ⇒ **`.jfr` 文件半截不可用**，而目标 JVM 里的录制**仍在继续跑**
/// （JFR.stop 没执行完），用户既拿不到数据又白背一份开销。
/// 其余动作只读快照、输出有界，45s 足够。
fn diagnostic_timeout(action: &str) -> Duration {
    match action {
        "jfr-stop" => Duration::from_secs(180),
        _ => Duration::from_secs(45),
    }
}

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
            diagnostic_timeout(&action),
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

#[cfg(test)]
mod tests {
    use super::*;

    /// jfr-stop 要落盘整份 profile，必须比只读快照的动作宽得多。
    #[test]
    fn jfr_stop_gets_a_longer_budget_than_snapshot_actions() {
        assert_eq!(diagnostic_timeout("jfr-stop"), Duration::from_secs(180));
        for action in ["threads", "histogram", "vm", "jfr-start"] {
            assert_eq!(
                diagnostic_timeout(action),
                Duration::from_secs(45),
                "{action} 只读快照，不该跟着放宽"
            );
        }
        assert!(
            diagnostic_timeout("jfr-stop") >= Duration::from_secs(120),
            "几百 MB 的 profile 落盘 45s 不够，杀进程会留下半截 .jfr"
        );
    }
}
