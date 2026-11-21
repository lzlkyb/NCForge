use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Weak};

use crate::{java_bridge::Bridge, state::AppState};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessRow {
    group: &'static str,
    pid: u32,
    resident_bytes: Option<u64>,
    private_bytes: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySnapshot {
    sampled_at: u64,
    rows: Vec<ProcessRow>,
    idle_compilers: usize,
    partial: bool,
}

pub(super) struct Process {
    pid: u32,
    parent: u32,
    name: String,
    #[cfg(not(windows))]
    resident_bytes: u64,
}

pub fn sample(state: &AppState) -> MemorySnapshot {
    let own = std::process::id();
    let (compilers, idle_compilers) = crate::ecj_worker::memory_processes();
    let mut known = HashMap::new();
    for bridge in compilers.iter().filter_map(Weak::upgrade) {
        if let Some(pid) = bridge.memory_pid() {
            known.insert(pid, "compiler");
        }
    }
    if let Ok(lang) = state.lang.try_lock() {
        if let Some(pid) = lang
            .session
            .as_ref()
            .and_then(|session| session.client.memory_pid())
        {
            known.insert(pid, "language");
        }
    }
    let database: Vec<Arc<Bridge>> = state
        .db_procs
        .try_lock()
        .ok()
        .map(|pool| pool.values().filter_map(Weak::upgrade).collect())
        .unwrap_or_default();
    for bridge in database {
        if let Some(pid) = bridge.memory_pid() {
            known.insert(pid, "database");
        }
    }
    let processes = platform::processes();
    let mut partial = processes.is_none();
    let processes = processes.unwrap_or_default();
    let parents: HashMap<_, _> = processes.iter().map(|p| (p.pid, p.parent)).collect();
    let roots: HashSet<_> = known.keys().copied().chain([own]).collect();
    let mut rows = Vec::new();
    for process in &processes {
        if !belongs(process.pid, &parents, &roots) {
            continue;
        }
        let group = if process.pid == own {
            "main"
        } else if let Some(group) = known.get(&process.pid) {
            group
        } else if webview(&process.name) {
            "webview"
        } else {
            "other"
        };
        let (resident_bytes, private_bytes) = platform::memory(process);
        partial |= resident_bytes.is_none();
        rows.push(ProcessRow {
            group,
            pid: process.pid,
            resident_bytes,
            private_bytes,
        });
    }
    if !rows.iter().any(|row| row.pid == own) {
        partial = true;
        let (resident_bytes, private_bytes) = platform::own_memory();
        rows.push(ProcessRow {
            group: "main",
            pid: own,
            resident_bytes,
            private_bytes,
        });
    }
    rows.sort_by_key(|row| (std::cmp::Reverse(row.resident_bytes), row.pid));
    MemorySnapshot {
        sampled_at: super::maintenance_storage::now_ms(),
        rows,
        idle_compilers,
        partial,
    }
}

fn belongs(mut pid: u32, parents: &HashMap<u32, u32>, roots: &HashSet<u32>) -> bool {
    for _ in 0..32 {
        if roots.contains(&pid) {
            return true;
        }
        let Some(&parent) = parents.get(&pid) else {
            return false;
        };
        if parent == 0 || parent == pid {
            return false;
        }
        pid = parent;
    }
    false
}

fn webview(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name == "msedgewebview2.exe"
        || name.contains("webkit.webcontent")
        || name.contains("webkit.networking")
        || name.contains("webkit.gpu")
}

pub fn live_pids() -> Option<HashSet<u32>> {
    Some(
        platform::processes()?
            .into_iter()
            .map(|process| process.pid)
            .collect(),
    )
}

pub fn disk_space(path: &Path) -> Option<(u64, u64)> {
    platform::disk_space(path)
}

#[cfg(windows)]
mod platform {
    use super::{Path, Process};
    use std::{ffi::c_void, mem::size_of, os::windows::ffi::OsStrExt};
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    pub(super) fn processes() -> Option<Vec<Process>> {
        let handle = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }.ok()?;
        let mut entry = PROCESSENTRY32W {
            dwSize: size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut output = Vec::new();
        let first = unsafe { Process32FirstW(handle, &mut entry) };
        if first.is_ok() {
            loop {
                let end = entry
                    .szExeFile
                    .iter()
                    .position(|c| *c == 0)
                    .unwrap_or(entry.szExeFile.len());
                output.push(Process {
                    pid: entry.th32ProcessID,
                    parent: entry.th32ParentProcessID,
                    name: String::from_utf16_lossy(&entry.szExeFile[..end]),
                });
                if unsafe { Process32NextW(handle, &mut entry) }.is_err() {
                    break;
                }
            }
        }
        let _ = unsafe { CloseHandle(handle) };
        first.ok()?;
        Some(output)
    }

    #[repr(C)]
    #[derive(Default)]
    struct Counters {
        size: u32,
        faults: u32,
        peak_working: usize,
        working: usize,
        peak_paged: usize,
        paged: usize,
        peak_nonpaged: usize,
        nonpaged: usize,
        pagefile: usize,
        peak_pagefile: usize,
        private: usize,
    }

    #[link(name = "psapi")]
    extern "system" {
        fn GetProcessMemoryInfo(process: *mut c_void, counters: *mut Counters, size: u32) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetDiskFreeSpaceExW(
            path: *const u16,
            available: *mut u64,
            total: *mut u64,
            free: *mut u64,
        ) -> i32;
    }

    fn read_memory(pid: u32) -> (Option<u64>, Option<u64>) {
        let Ok(handle) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) })
        else {
            return (None, None);
        };
        let size = size_of::<Counters>() as u32;
        let mut counters = Counters {
            size,
            ..Default::default()
        };
        let ok = unsafe { GetProcessMemoryInfo(handle.0 as *mut c_void, &mut counters, size) } != 0;
        let _ = unsafe { CloseHandle(handle) };
        (
            ok.then_some(counters.working as u64),
            ok.then_some(counters.private as u64),
        )
    }

    pub(super) fn memory(process: &Process) -> (Option<u64>, Option<u64>) {
        read_memory(process.pid)
    }
    pub(super) fn own_memory() -> (Option<u64>, Option<u64>) {
        read_memory(std::process::id())
    }

    pub(super) fn disk_space(path: &Path) -> Option<(u64, u64)> {
        let path: Vec<_> = path.as_os_str().encode_wide().chain([0]).collect();
        let (mut available, mut total) = (0, 0);
        let ok = unsafe {
            GetDiskFreeSpaceExW(
                path.as_ptr(),
                &mut available,
                &mut total,
                std::ptr::null_mut(),
            )
        };
        (ok != 0).then_some((available, total))
    }
}

#[cfg(not(windows))]
mod platform {
    use super::{Path, Process};
    use std::process::Command;

    pub(super) fn processes() -> Option<Vec<Process>> {
        let output = Command::new("ps")
            .args(["-axo", "pid=,ppid=,rss=,comm="])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        Some(
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .filter_map(|line| {
                    let mut parts = line.split_whitespace();
                    let pid = parts.next()?.parse().ok()?;
                    let parent = parts.next()?.parse().ok()?;
                    let resident_bytes = parts.next()?.parse::<u64>().ok()?.saturating_mul(1024);
                    Some(Process {
                        pid,
                        parent,
                        resident_bytes,
                        name: parts.collect::<Vec<_>>().join(" "),
                    })
                })
                .collect(),
        )
    }

    pub(super) fn memory(process: &Process) -> (Option<u64>, Option<u64>) {
        (Some(process.resident_bytes), None)
    }
    pub(super) fn own_memory() -> (Option<u64>, Option<u64>) {
        (None, None)
    }

    pub(super) fn disk_space(path: &Path) -> Option<(u64, u64)> {
        let output = Command::new("df").arg("-Pk").arg(path).output().ok()?;
        if !output.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let fields: Vec<_> = text.lines().last()?.split_whitespace().collect();
        Some((
            fields.get(3)?.parse::<u64>().ok()?.saturating_mul(1024),
            fields.get(1)?.parse::<u64>().ok()?.saturating_mul(1024),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ownership_follows_known_roots_and_stops_at_cycles() {
        let parents = HashMap::from([(2, 1), (3, 2), (4, 5), (5, 4), (8, 7)]);
        assert!(belongs(3, &parents, &HashSet::from([1])));
        assert!(belongs(8, &parents, &HashSet::from([7])));
        assert!(!belongs(4, &parents, &HashSet::from([1])));
        assert!(!belongs(8, &parents, &HashSet::from([1])));
    }

    #[test]
    fn current_process_has_resident_measurement() {
        let pid = std::process::id();
        let snapshot = platform::processes().unwrap();
        let current = snapshot.iter().find(|row| row.pid == pid).unwrap();
        assert!(platform::memory(current).0.is_some_and(|value| value > 0));
    }
}
