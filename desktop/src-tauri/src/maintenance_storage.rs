use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, Metadata};
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::maintenance_memory;

const RETENTION: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const PLAN_LIFETIME: Duration = Duration::from_secs(5 * 60);
const MAX_ENTRIES: usize = 240_000;
const MAX_CANDIDATES: usize = 500;

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Scope {
    Recommended,
    Language,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageEntry {
    bytes: u64,
    incomplete: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    categories: BTreeMap<&'static str, UsageEntry>,
    free_bytes: Option<u64>,
    total_bytes: Option<u64>,
    sampled_at: u64,
    language_busy: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Compile,
    Download,
    Log,
    Language,
}

impl Kind {
    fn id(self) -> &'static str {
        match self {
            Self::Compile => "compile",
            Self::Download => "download",
            Self::Log => "log",
            Self::Language => "language",
        }
    }
}

struct Candidate {
    relative: PathBuf,
    kind: Kind,
    owner: Option<u32>,
    modified: SystemTime,
    bytes: u64,
    entries: usize,
}

pub struct Plan {
    pub id: u64,
    pub scope: Scope,
    created: SystemTime,
    entries: Vec<Candidate>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    id: u64,
    entries: Vec<PreviewEntry>,
    incomplete: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewEntry {
    key: usize,
    kind: &'static str,
    name: String,
    bytes: u64,
    workspace: Option<String>,
    last_used: Option<u64>,
}

pub const INDEX_OWNER: &str = ".ncforge-workspace";

fn short_text(path: &Path) -> Option<String> {
    use std::io::Read;
    if !fs::symlink_metadata(path).is_ok_and(|meta| !linked(&meta) && meta.is_file()) {
        return None;
    }
    let mut text = String::new();
    fs::File::open(path)
        .ok()?
        .take(4096)
        .read_to_string(&mut text)
        .ok()?;
    Some(text)
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanReport {
    pub removed_bytes: u64,
    pub removed: usize,
    pub skipped: usize,
    pub cancelled: bool,
    pub reasons: BTreeMap<&'static str, usize>,
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn linked(meta: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Junctions and other reparse points can redirect access outside the profile.
        meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    meta.file_type().is_symlink()
}

fn tree_size(path: &Path, remaining: &mut usize, cancelled: &dyn Fn() -> bool) -> UsageEntry {
    let mut result = UsageEntry::default();
    let mut pending = vec![path.to_owned()];
    while let Some(path) = pending.pop() {
        if *remaining == 0 || cancelled() {
            result.incomplete = true;
            break;
        }
        *remaining -= 1;
        match fs::symlink_metadata(&path) {
            Ok(meta) if linked(&meta) => result.incomplete = true,
            Ok(meta) if meta.is_file() => result.bytes = result.bytes.saturating_add(meta.len()),
            Ok(meta) if meta.is_dir() => match fs::read_dir(path) {
                Ok(entries) => {
                    for entry in entries.take(remaining.saturating_sub(pending.len()) + 1) {
                        match entry {
                            Ok(entry) => pending.push(entry.path()),
                            Err(_) => result.incomplete = true,
                        }
                    }
                }
                Err(_) => result.incomplete = true,
            },
            _ => result.incomplete = true,
        }
    }
    result
}

fn category(name: &str) -> &'static str {
    match name {
        "tmp" | "logs" => "temporary",
        "build" | "lang" => "cache",
        "resources" | "resource-packs.json" => "components",
        name if name.starts_with("class-index") && name.ends_with(".bin") => "cache",
        _ => "local",
    }
}

pub fn usage(root: &Path, auxiliary: &[PathBuf], language_busy: bool) -> io::Result<Usage> {
    if !safe_dir(root, Path::new("")) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "无法确认本机数据目录",
        ));
    }
    let mut categories: BTreeMap<_, UsageEntry> = ["temporary", "cache", "components", "local"]
        .into_iter()
        .map(|key| (key, UsageEntry::default()))
        .collect();
    let mut remaining = MAX_ENTRIES;
    for item in fs::read_dir(root)? {
        match item {
            Ok(item) => {
                let cat = categories
                    .get_mut(category(&item.file_name().to_string_lossy()))
                    .unwrap();
                let current = tree_size(&item.path(), &mut remaining, &|| false);
                cat.bytes = cat.bytes.saturating_add(current.bytes);
                cat.incomplete |= current.incomplete;
            }
            Err(_) => categories.get_mut("local").unwrap().incomplete = true,
        }
    }
    // Tauri keeps the WebView profile and staged updater in platform-specific app directories.
    // Windows can resolve both locations to the same directory. Count each root only once.
    let canonical_root = fs::canonicalize(root)?;
    let mut counted = Vec::<PathBuf>::new();
    let components = categories.get_mut("components").unwrap();
    let mut resolved = Vec::new();
    for path in auxiliary {
        match fs::symlink_metadata(path) {
            Ok(meta) if meta.is_dir() && !linked(&meta) => match fs::canonicalize(path) {
                Ok(path) => resolved.push(path),
                Err(_) => components.incomplete = true,
            },
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            _ => components.incomplete = true,
        }
    }
    resolved.sort_by_key(|path| path.components().count());
    for path in resolved {
        if path.starts_with(&canonical_root)
            || counted.iter().any(|parent| path.starts_with(parent))
        {
            continue;
        }
        if canonical_root.starts_with(&path) {
            components.incomplete = true;
            continue;
        }
        let size = tree_size(&path, &mut remaining, &|| false);
        components.bytes = components.bytes.saturating_add(size.bytes);
        components.incomplete |= size.incomplete;
        counted.push(path);
    }
    let disk = maintenance_memory::disk_space(root);
    Ok(Usage {
        categories,
        language_busy,
        sampled_at: now_ms(),
        free_bytes: disk.map(|(free, _)| free),
        total_bytes: disk.map(|(_, total)| total),
    })
}

fn digits(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn compile_owner(name: &str) -> Option<u32> {
    let suffix = name.strip_prefix("ecj-")?.strip_suffix(".args")?;
    let (pid, seq) = suffix.split_once('-').unwrap_or((suffix, "0"));
    (digits(pid) && digits(seq))
        .then(|| pid.parse().ok())
        .flatten()
}

fn download_owner(name: &str) -> Option<u32> {
    let (pack, pid) = name.strip_prefix(".tmp-")?.rsplit_once('-')?;
    let known = ["jdtls", "ecj", "svnkit", "ncdb", "cfr"];
    (known.contains(&pack) && digits(pid))
        .then(|| pid.parse().ok())
        .flatten()
}

fn language_name(name: &str) -> bool {
    name.rsplit_once('-').is_some_and(|(module, fingerprint)| {
        module.len() <= 40
            && module
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            && fingerprint.len() == 16
            && fingerprint.bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}

fn safe_dir(root: &Path, relative: &Path) -> bool {
    let mut path = root.to_owned();
    if !fs::symlink_metadata(root).is_ok_and(|meta| !linked(&meta) && meta.is_dir()) {
        return false;
    }
    for component in relative.components() {
        let std::path::Component::Normal(name) = component else {
            return false;
        };
        path.push(name);
        if !fs::symlink_metadata(&path).is_ok_and(|meta| !linked(&meta) && meta.is_dir()) {
            return false;
        }
    }
    true
}

struct Scan<'a> {
    root: &'a Path,
    pids: Option<&'a HashSet<u32>>,
    now: SystemTime,
    remaining: usize,
    incomplete: bool,
    cancelled: &'a dyn Fn() -> bool,
}

impl Scan<'_> {
    fn candidate(
        &mut self,
        relative: PathBuf,
        kind: Kind,
        owner: Option<u32>,
    ) -> Option<Candidate> {
        if owner.is_some_and(|pid| {
            pid == std::process::id() || self.pids.is_none_or(|live| live.contains(&pid))
        }) {
            return None;
        }
        let path = self.root.join(&relative);
        let meta = fs::symlink_metadata(&path).ok()?;
        let expected_dir = matches!(kind, Kind::Download | Kind::Language);
        if linked(&meta) || (expected_dir && !meta.is_dir()) || (!expected_dir && !meta.is_file()) {
            return None;
        }
        let modified = meta.modified().ok()?;
        if kind != Kind::Language && self.now.duration_since(modified).ok()? < RETENTION {
            return None;
        }
        let before = self.remaining;
        let measure = tree_size(&path, &mut self.remaining, self.cancelled);
        if measure.incomplete {
            self.incomplete = true;
            return None;
        }
        Some(Candidate {
            relative,
            kind,
            owner,
            modified,
            bytes: measure.bytes,
            entries: before - self.remaining,
        })
    }
}

fn scan(
    root: &Path,
    id: u64,
    scope: Scope,
    now: SystemTime,
    pids: Option<&HashSet<u32>>,
    cancelled: &dyn Fn() -> bool,
) -> (Plan, Preview) {
    let sources: &[(&str, Kind)] = match scope {
        Scope::Recommended => &[
            ("tmp", Kind::Compile),
            ("resources", Kind::Download),
            ("logs", Kind::Log),
        ],
        Scope::Language => &[("lang/jdtls-ws", Kind::Language)],
    };
    let mut entries = Vec::new();
    let mut incomplete = false;
    let mut names = 0;
    let mut scan = Scan {
        root,
        pids,
        now,
        remaining: MAX_ENTRIES,
        incomplete: false,
        cancelled,
    };
    'sources: for &(dir, kind) in sources {
        if !safe_dir(root, Path::new(dir)) {
            incomplete |= !matches!(fs::symlink_metadata(root.join(dir)), Err(error) if error.kind() == io::ErrorKind::NotFound);
            continue;
        }
        let Ok(items) = fs::read_dir(root.join(dir)) else {
            incomplete = true;
            continue;
        };
        for item in items {
            names += 1;
            if cancelled() || names > 20_000 {
                incomplete = true;
                break 'sources;
            }
            let Ok(item) = item else {
                incomplete = true;
                continue;
            };
            let name = item.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            let owner = match kind {
                Kind::Compile => match compile_owner(name) {
                    Some(pid) => Some(pid),
                    None => continue,
                },
                Kind::Download => match download_owner(name) {
                    Some(pid) => Some(pid),
                    None => continue,
                },
                Kind::Log if name == "frontend.log.1" => None,
                Kind::Language if language_name(name) => None,
                _ => continue,
            };
            if let Some(candidate) = scan.candidate(Path::new(dir).join(name), kind, owner) {
                entries.push(candidate);
            }
            if scan.remaining == 0 || entries.len() == MAX_CANDIDATES {
                incomplete = true;
                break 'sources;
            }
        }
    }
    entries.sort_by(|a, b| b.bytes.cmp(&a.bytes).then(a.relative.cmp(&b.relative)));
    let preview = Preview {
        id,
        incomplete: incomplete || scan.incomplete,
        entries: entries
            .iter()
            .enumerate()
            .map(|(key, item)| {
                let folder = root.join(&item.relative);
                let language = item.kind == Kind::Language;
                PreviewEntry {
                    key,
                    kind: item.kind.id(),
                    bytes: item.bytes,
                    name: item
                        .relative
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned(),
                    workspace: language
                        .then(|| short_text(&folder.join(INDEX_OWNER)))
                        .flatten(),
                    last_used: language
                        .then(|| short_text(&folder.join(".ncforge-used")))
                        .flatten()
                        .and_then(|stamp| stamp.trim().parse().ok()),
                }
            })
            .collect(),
    };
    (
        Plan {
            id,
            scope,
            created: now,
            entries,
        },
        preview,
    )
}

pub fn preview(root: &Path, id: u64, scope: Scope) -> (Plan, Preview) {
    preview_interruptible(root, id, scope, &|| false)
}

pub fn preview_interruptible(
    root: &Path,
    id: u64,
    scope: Scope,
    cancelled: &dyn Fn() -> bool,
) -> (Plan, Preview) {
    let pids = (scope == Scope::Recommended)
        .then(maintenance_memory::live_pids)
        .flatten();
    scan(root, id, scope, SystemTime::now(), pids.as_ref(), cancelled)
}

impl Plan {
    pub fn expired(&self) -> bool {
        SystemTime::now()
            .duration_since(self.created)
            .map_or(true, |elapsed| elapsed > PLAN_LIFETIME)
    }

    pub fn valid_selection(&self, selected: &[usize]) -> bool {
        !selected.is_empty()
            && selected.len() <= self.entries.len()
            && selected.iter().all(|key| *key < self.entries.len())
    }
}

fn remove(scan: &mut Scan<'_>, item: &Candidate) -> Result<u64, &'static str> {
    let parent = item.relative.parent().ok_or("unsafe")?;
    if !safe_dir(scan.root, parent) {
        return Err("unsafe");
    }
    let Some(live) = scan.candidate(item.relative.clone(), item.kind, item.owner) else {
        return Err("changed");
    };
    if (live.modified, live.bytes, live.entries) != (item.modified, item.bytes, item.entries) {
        return Err("changed");
    }
    let path = scan.root.join(&item.relative);
    let result = if matches!(item.kind, Kind::Download | Kind::Language) {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    };
    result
        .map(|()| live.bytes)
        .map_err(|error| match error.kind() {
            io::ErrorKind::PermissionDenied => "access",
            io::ErrorKind::NotFound => "changed",
            _ => "busy",
        })
}

pub fn apply(
    root: &Path,
    plan: Plan,
    selected: Option<&[usize]>,
    cancelled: impl Fn() -> bool,
    progress: impl Fn(usize, usize),
) -> CleanReport {
    let selected: HashSet<_> = selected
        .map(|keys| keys.iter().copied().collect())
        .unwrap_or_else(|| (0..plan.entries.len()).collect());
    let pids = (plan.scope == Scope::Recommended)
        .then(maintenance_memory::live_pids)
        .flatten();
    let mut scan = Scan {
        root,
        pids: pids.as_ref(),
        now: SystemTime::now(),
        remaining: MAX_ENTRIES,
        incomplete: false,
        cancelled: &cancelled,
    };
    let mut report = CleanReport::default();
    let total = selected.len();
    progress(0, total);
    for (index, item) in plan.entries.into_iter().enumerate() {
        if !selected.contains(&index) {
            continue;
        }
        if cancelled() {
            report.cancelled = true;
            break;
        }
        let result = if item.kind == Kind::Log {
            crate::frontend_log::with_rotation_lock(|| remove(&mut scan, &item))
        } else {
            remove(&mut scan, &item)
        };
        match result {
            Ok(bytes) => {
                report.removed += 1;
                report.removed_bytes = report.removed_bytes.saturating_add(bytes);
            }
            Err(reason) => {
                report.skipped += 1;
                *report.reasons.entry(reason).or_default() += 1;
            }
        }
        progress(report.removed + report.skipped, total);
    }
    report.cancelled |= cancelled();
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_owned_entries_only_and_live_revalidation() {
        let work = tempfile::tempdir_in(crate::test_support::tmp("maintenance-storage")).unwrap();
        let root = work.path();
        fs::create_dir(root.join("tmp")).unwrap();
        fs::create_dir(root.join("logs")).unwrap();
        fs::write(root.join("tmp/ecj-99999-32.args"), b"owned").unwrap();
        fs::write(root.join("tmp/stuff.tmp"), b"user").unwrap();
        fs::write(
            root.join(format!("tmp/ecj-{}-32.args", std::process::id())),
            b"running",
        )
        .unwrap();
        fs::write(root.join("logs/frontend.log"), b"current").unwrap();
        let future = SystemTime::now() + RETENTION + Duration::from_secs(1);
        let (plan, visible) = scan(
            root,
            1,
            Scope::Recommended,
            future,
            Some(&HashSet::new()),
            &|| false,
        );
        assert_eq!(visible.entries.len(), 1);
        assert_eq!(visible.entries[0].bytes, 5);
        assert_eq!(
            apply(root, plan, Some(&[0]), || false, |_, _| ()).removed,
            0
        );
        assert!(root.join("tmp/stuff.tmp").exists());
        assert!(root.join("logs/frontend.log").exists());
    }

    #[test]
    fn language_cleanup_skips_modified_and_unknown_directories() {
        let work = tempfile::tempdir_in(crate::test_support::tmp("maintenance-index")).unwrap();
        let root = work.path();
        let index = root.join("lang/jdtls-ws/mod-0011223344556677");
        fs::create_dir_all(&index).unwrap();
        fs::create_dir_all(root.join("lang/jdtls-ws/untagged")).unwrap();
        let (plan, visible) = preview(root, 1, Scope::Language);
        assert_eq!(visible.entries.len(), 1);
        fs::write(index.join("new"), b"x").unwrap();
        assert_eq!(apply(root, plan, None, || false, |_, _| ()).skipped, 1);
        let (latest, _) = preview(root, 2, Scope::Language);
        assert_eq!(
            apply(root, latest, None, || false, |_, _| ()).removed_bytes,
            1
        );
        assert!(!index.exists());
        assert!(root.join("lang/jdtls-ws/untagged").exists());
    }

    #[test]
    fn language_plan_respects_selection_and_cancel_between_items() {
        let work = tempfile::tempdir_in(crate::test_support::tmp("maintenance-cancel")).unwrap();
        let root = work.path();
        let first = root.join("lang/jdtls-ws/a-0011223344556677");
        let second = root.join("lang/jdtls-ws/b-0011223344556677");
        let third = root.join("lang/jdtls-ws/c-0011223344556677");
        for entry in [&first, &second, &third] {
            fs::create_dir_all(entry).unwrap();
            fs::write(entry.join("index"), b"content").unwrap();
        }
        let (plan, _) = preview(root, 1, Scope::Language);
        let stop = std::cell::Cell::new(false);
        assert!(plan.valid_selection(&[0, 2]));
        assert!(!plan.valid_selection(&[3]));
        let report = apply(
            root,
            plan,
            Some(&[0, 2]),
            || stop.get(),
            |done, _| {
                if done == 1 {
                    stop.set(true);
                }
            },
        );
        assert!(report.cancelled);
        assert_eq!(report.removed, 1);
        assert!(!first.exists());
        assert!(second.exists() && third.exists());
    }

    #[test]
    fn storage_usage_covers_profile_with_protected_data_separate() {
        let work = tempfile::tempdir_in(crate::test_support::tmp("maintenance-usage")).unwrap();
        let root = work.path();
        fs::create_dir(root.join("local-history")).unwrap();
        fs::create_dir(root.join("resources")).unwrap();
        fs::write(root.join("local-history/record"), b"keep").unwrap();
        fs::write(root.join("resources/installed"), b"pkg").unwrap();
        fs::write(root.join("class-index.bin"), b"index").unwrap();
        let runtime =
            tempfile::tempdir_in(crate::test_support::tmp("maintenance-runtime")).unwrap();
        fs::write(runtime.path().join("webview"), b"view").unwrap();
        let roots = [
            runtime.path().to_owned(),
            runtime.path().to_owned(),
            root.join("resources"),
        ];
        let usage = usage(root, &roots, false).unwrap();
        assert_eq!(usage.categories["local"].bytes, 4);
        assert_eq!(usage.categories["components"].bytes, 7);
        assert_eq!(usage.categories["cache"].bytes, 5);
        assert!(usage.free_bytes.is_some());
    }
}
