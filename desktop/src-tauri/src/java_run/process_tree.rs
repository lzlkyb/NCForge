//! Own a runner's descendants even after its main process has exited.
use std::process::{Child, Command};
use std::sync::Arc;

pub struct ProcessTree {
    pub pid: u32,
    #[cfg(windows)]
    job: std::os::windows::io::OwnedHandle,
}

impl ProcessTree {
    pub(super) fn spawn(command: &mut Command) -> Result<(Child, Arc<Self>), String> {
        #[cfg(windows)]
        let job = windows_tree::prepare(command)?;
        let child = command.spawn().map_err(|e| format!("无法启动 Java：{e}"))?;
        #[cfg(windows)]
        if let Err(error) = windows_tree::assign(&job, &child) {
            // The child is still suspended, so no user code or descendants ran.
            let mut child = child;
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        let tree = Arc::new(Self {
            pid: child.id(),
            #[cfg(windows)]
            job,
        });
        Ok((child, tree))
    }

    pub(super) fn resume(&self) -> Result<(), String> {
        #[cfg(windows)]
        {
            windows_tree::resume(self.pid)
        }
        #[cfg(not(windows))]
        {
            Ok(())
        }
    }

    pub fn kill(&self) {
        #[cfg(windows)]
        windows_tree::terminate(&self.job);
        #[cfg(unix)]
        {
            // Only the group created by hide(command) is targeted; do not kill a
            // possibly reused parent PID after its process has been reaped.
            let _ = Command::new("kill")
                .args(["-KILL", "--", &format!("-{}", self.pid)])
                .output();
        }
    }
}

impl Drop for ProcessTree {
    fn drop(&mut self) {
        self.kill();
    }
}

#[cfg(windows)]
mod windows_tree {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::os::windows::process::CommandExt;
    use std::process::{Child, Command};
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};

    fn handle(job: &OwnedHandle) -> HANDLE {
        HANDLE(job.as_raw_handle() as isize)
    }

    pub(super) fn prepare(command: &mut Command) -> Result<OwnedHandle, String> {
        // Suspend at creation so even a fast child cannot escape before job assignment.
        command.creation_flags(0x0800_0000 | 0x0000_0004);
        let raw = unsafe { CreateJobObjectW(None, PCWSTR::null()) }
            .map_err(|e| format!("创建运行进程组失败：{e}"))?;
        // CreateJobObject returned one owned handle; only OwnedHandle closes it.
        let job = unsafe { OwnedHandle::from_raw_handle(raw.0 as _) };
        let limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
            BasicLimitInformation:
                windows::Win32::System::JobObjects::JOBOBJECT_BASIC_LIMIT_INFORMATION {
                    LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                    ..Default::default()
                },
            ..Default::default()
        };
        unsafe {
            SetInformationJobObject(
                handle(&job),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        }
        .map_err(|e| format!("设置运行进程组失败：{e}"))?;
        Ok(job)
    }

    pub(super) fn assign(job: &OwnedHandle, child: &Child) -> Result<(), String> {
        unsafe { AssignProcessToJobObject(handle(job), HANDLE(child.as_raw_handle() as isize)) }
            .map_err(|e| format!("登记运行进程组失败：{e}"))
    }

    pub(super) fn resume(pid: u32) -> Result<(), String> {
        let raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) }
            .map_err(|e| format!("读取运行主线程失败：{e}"))?;
        let snapshot = unsafe { OwnedHandle::from_raw_handle(raw.0 as _) };
        let mut entry = THREADENTRY32 {
            dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };
        let mut next = unsafe { Thread32First(handle(&snapshot), &mut entry) };
        while next.is_ok() {
            if entry.th32OwnerProcessID == pid {
                let thread =
                    unsafe { OpenThread(THREAD_SUSPEND_RESUME, false, entry.th32ThreadID) }
                        .map_err(|e| format!("打开运行主线程失败：{e}"))?;
                let previous = unsafe { ResumeThread(thread) };
                let _ = unsafe { CloseHandle(thread) };
                if previous == u32::MAX {
                    return Err(format!(
                        "恢复运行主线程失败：{}",
                        std::io::Error::last_os_error()
                    ));
                }
                if previous > 0 {
                    return Ok(());
                }
            }
            next = unsafe { Thread32Next(handle(&snapshot), &mut entry) };
        }
        Err("没有找到已暂停的运行主线程，未执行用户代码".into())
    }

    pub(super) fn terminate(job: &OwnedHandle) {
        // The owned job, not a live/recycled PID, identifies only this run's tree.
        let _ = unsafe { TerminateJobObject(handle(job), 1) };
    }
}
