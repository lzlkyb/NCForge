//! 工作区文件监听：外部改动（SVN 更新、Eclipse 保存、脚本生成文件）之后，
//! 通知前端把文件树里**已读过的目录**重新读一遍。
//!
//! 噪音控制三层：
//! 1. 目录级：`.svn` / `.git` 这类元数据目录整棵不看——NC 工作副本里 `.svn`
//!    的写入量比业务代码大一个数量级；
//! 2. 事件级：只认「增 / 删 / 改名」，不认内容与属性变更——文件树只关心目录里
//!    有哪几项，编译一次改几千个 `.class` 的内容，跟着刷新是白烧 IO；
//! 3. 时间级：DEBOUNCE 内的改动合成一批，一次发去重后的父目录集合。
//!
//! 纯逻辑（过滤 / 归类 / 合并）都在本文件；[`WorkspaceWatcher`] 是唯一摸 OS 的地方，
//! 命令层只负责在切工作区时换一份监听（见 `workspace_cmds::restart_watcher`）。
//!
//! 前端契约：事件名 `fs-changed`，载荷
//! `{ "dirs": ["<绝对路径>", …], "rescan": false }`，路径形如 `set_workspace`
//! 的返回值（不带 `\\?\` 前缀）。`rescan` 为真时前端应把所有已读目录重读一遍
//! （平台报了「事件可能丢失」）。

use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Arc;
use std::time::Duration;

use notify::{RecursiveMode, Watcher};

use crate::security::path::display_path;

/// 不参与刷新的目录名（任意一级命中即跳过）。比较忽略大小写：
/// Windows 上 `NC\.SVN\` 与 `.svn` 是同一个目录。
const IGNORED_DIRS: [&str; 3] = [".svn", ".git", ".idea"];

/// 合并窗口：盖得住一次 SVN 更新 / 一次批量生成，又不至于让用户觉得「改完半天没反应」。
const DEBOUNCE: Duration = Duration::from_millis(350);

/// 单批最多带多少个目录：前端对每个目录各读一次盘，解压大压缩包这类场景
/// 不能把 IPC 与 `list_dir` 堆满界面。
const MAX_DIRS: usize = 64;

/// 待发队列上限：到顶立刻发一批，不等合并窗口。
const MAX_PENDING: usize = 256;

/// 这条路径是不是落在不看的目录里。
pub fn is_ignored(path: &Path) -> bool {
    path.components().any(|c| match c {
        Component::Normal(name) => name
            .to_str()
            .is_some_and(|s| IGNORED_DIRS.iter().any(|d| s.eq_ignore_ascii_case(d))),
        _ => false,
    })
}

/// 这类事件有没有可能改变「目录里有哪些项」。
pub fn needs_tree_refresh(kind: &notify::EventKind) -> bool {
    use notify::{event::ModifyKind, EventKind};
    match kind {
        EventKind::Create(_) | EventKind::Remove(_) | EventKind::Any => true,
        // 改名会同时给新旧两个路径；`ModifyKind::Any` 是平台没细分的兜底
        EventKind::Modify(ModifyKind::Name(_) | ModifyKind::Any) => true,
        EventKind::Modify(_) | EventKind::Access(_) | EventKind::Other => false,
    }
}

/// 把这次事件涉及的「受影响的父目录」收进 `out`。
///
/// 只看父目录：新增/删除/改名改变的是**某个目录的列表**；文件内容变化不影响列表，
/// 而 `needs_tree_refresh` 已经把内容事件挡掉了。
pub fn affected_dirs(root: &Path, paths: &[PathBuf], out: &mut BTreeSet<PathBuf>) {
    for p in paths {
        if is_ignored(p) || !p.starts_with(root) {
            continue;
        }
        if let Some(parent) = p.parent() {
            if parent.starts_with(root) {
                out.insert(parent.to_path_buf());
            }
        }
    }
}

/// 一批目录 → 给前端的字符串。上限 `MAX_DIRS`；`BTreeSet` 已去重且有序。
pub fn dirs_payload(dirs: &BTreeSet<PathBuf>) -> Vec<String> {
    dirs.iter()
        .take(MAX_DIRS)
        .map(|d| display_path(d))
        .collect()
}

/// 推给前端的一批结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchBatch {
    /// 需要重新列目录的父目录（形如 `set_workspace` 的返回值）。
    pub dirs: Vec<String>,
    /// 平台报告事件可能丢失（缓冲区溢出 / 改动太快）：前端应把**所有**已读目录重读一遍。
    pub rescan: bool,
}

/// 一个工作区的文件监听。拿到即活，`Drop` 即停（换工作区 / 退出应用）。
pub struct WorkspaceWatcher {
    /// OS 监听句柄。字段不可省：`Drop` 它才会停掉底层监听。
    _watcher: notify::RecommendedWatcher,
    stop: Arc<AtomicBool>,
}

impl WorkspaceWatcher {
    /// 监听 `root` 整棵子树；`emit` 在后台线程里被调用，参数是一批去重后的父目录。
    pub fn start(
        root: PathBuf,
        emit: Arc<dyn Fn(WatchBatch) + Send + Sync>,
    ) -> Result<Self, String> {
        let (tx, rx) = mpsc::channel::<notify::Event>();
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            match res {
                // 接收方已退出（正在换工作区）时 send 失败：丢弃即可，回调里不能阻塞
                Ok(ev) => drop(tx.send(ev)),
                Err(e) => log::warn!("文件监听出错：{e}"),
            }
        })
        .map_err(|e| format!("无法创建文件监听：{e}"))?;
        watcher
            .watch(&root, RecursiveMode::Recursive)
            .map_err(|e| format!("无法监听工作区 {}：{e}", display_path(&root)))?;

        let stop = Arc::new(AtomicBool::new(false));
        let stop_thread = Arc::clone(&stop);
        std::thread::Builder::new()
            .name("nc-fs-watch".to_string())
            .spawn(move || {
                let mut pending: BTreeSet<PathBuf> = BTreeSet::new();
                let mut rescan = false;
                loop {
                    // 让出点：没有事件时阻塞在 recv_timeout 上，每轮至多一次 flush
                    if stop_thread.load(Ordering::Relaxed) {
                        break;
                    }
                    match rx.recv_timeout(DEBOUNCE) {
                        Ok(ev) => {
                            // 丢了事件时平台给的补偿信号：宁可让前端重读一遍，也别一直显示旧树
                            rescan |= ev.need_rescan();
                            if needs_tree_refresh(&ev.kind) {
                                affected_dirs(&root, &ev.paths, &mut pending);
                            }
                            if rescan || pending.len() >= MAX_PENDING {
                                flush(&mut pending, &mut rescan, &emit);
                            }
                        }
                        Err(RecvTimeoutError::Timeout) => {
                            flush(&mut pending, &mut rescan, &emit);
                        }
                        // 生产端（watcher 回调里的 tx）没了：循环自行结束，不空转
                        Err(RecvTimeoutError::Disconnected) => break,
                    }
                }
            })
            .map_err(|e| format!("无法启动文件监听线程：{e}"))?;

        Ok(Self {
            _watcher: watcher,
            stop,
        })
    }
}

impl Drop for WorkspaceWatcher {
    fn drop(&mut self) {
        // 线程在下一个合并窗口（≤ DEBOUNCE）看到标志即退出；监听句柄随后被 Drop，
        // 通道断开也会让它立刻醒
        self.stop.store(true, Ordering::Relaxed);
    }
}

fn flush(
    pending: &mut BTreeSet<PathBuf>,
    rescan: &mut bool,
    emit: &Arc<dyn Fn(WatchBatch) + Send + Sync>,
) {
    if pending.is_empty() && !*rescan {
        return;
    }
    // 超过单批上限时列表只带得走前 MAX_DIRS 个。剩下的不能就这么丢了——
    // 让前端把已读目录整体重读一遍（它本来就只读用户展开过的那几层）。
    let overflow = pending.len() > MAX_DIRS;
    let batch = WatchBatch {
        dirs: dirs_payload(pending),
        rescan: *rescan || overflow,
    };
    *rescan = false;
    pending.clear();
    emit(batch);
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, DataChange, MetadataKind, ModifyKind, RenameMode};
    use notify::EventKind as K;

    fn root() -> PathBuf {
        PathBuf::from("C:\\work").join("aier")
    }

    #[test]
    fn 元数据目录整棵不看() {
        let deep = root()
            .join(".svn")
            .join("pristine")
            .join("ab")
            .join("x.svn-base");
        assert!(is_ignored(&deep));
        // 大小写不敏感（Windows 同一目录）
        assert!(is_ignored(&root().join(".SVN").join("entries")));
        assert!(!is_ignored(
            &root().join("newar").join("src").join("A.java")
        ));
        // 名字里含 `.svn` 但不是这个目录名，不能误伤
        assert!(!is_ignored(&root().join("newar").join("my.svn.notes")));
    }

    #[test]
    fn 只有增删改名才刷新目录列表() {
        assert!(needs_tree_refresh(&K::Create(CreateKind::File)));
        assert!(needs_tree_refresh(&K::Remove(
            notify::event::RemoveKind::File
        )));
        assert!(needs_tree_refresh(&K::Modify(ModifyKind::Name(
            RenameMode::Both
        ))));
        assert!(needs_tree_refresh(&K::Any));
        // 内容 / 属性变化不改变目录里有哪些项
        assert!(!needs_tree_refresh(&K::Modify(ModifyKind::Data(
            DataChange::Content
        ))));
        assert!(!needs_tree_refresh(&K::Modify(ModifyKind::Metadata(
            MetadataKind::WriteTime
        ))));
        assert!(!needs_tree_refresh(&K::Access(
            notify::event::AccessKind::Any
        )));
    }

    #[test]
    fn 事件落到父目录且去重() {
        let mut out = BTreeSet::new();
        affected_dirs(
            &root(),
            &[
                root().join("newar").join("src").join("A.java"),
                root().join("newar").join("src").join("B.java"),
                root().join("newar").join("src").join("sub").join("C.java"),
            ],
            &mut out,
        );
        let src = root().join("newar").join("src");
        assert_eq!(out.len(), 2);
        assert!(out.contains(&src));
        assert!(out.contains(&src.join("sub")));
    }

    #[test]
    fn 工作区外与元数据目录被丢掉() {
        let mut out = BTreeSet::new();
        affected_dirs(
            &root(),
            &[
                PathBuf::from("C:\\elsewhere").join("X.java"),
                root().join(".svn").join("entries"),
            ],
            &mut out,
        );
        assert!(out.is_empty());
    }

    #[test]
    fn 载荷有上限() {
        let mut dirs = BTreeSet::new();
        for i in 0..(MAX_DIRS + 10) {
            dirs.insert(root().join(format!("m{i}")));
        }
        assert_eq!(dirs_payload(&dirs).len(), MAX_DIRS);
    }

    #[test]
    fn 目录过多时改为全量重扫() {
        let (tx, rx) = mpsc::channel::<WatchBatch>();
        let emit: Arc<dyn Fn(WatchBatch) + Send + Sync> = Arc::new(move |b| {
            let _ = tx.send(b);
        });

        let mut pending = BTreeSet::new();
        for i in 0..=MAX_DIRS {
            pending.insert(root().join(format!("m{i}")));
        }
        let mut rescan = false;
        flush(&mut pending, &mut rescan, &emit);
        let batch = rx.try_recv().expect("应当发了一批");
        assert_eq!(batch.dirs.len(), MAX_DIRS);
        // 装不下的目录不能静默丢掉，否则它们会一直停在旧内容
        assert!(batch.rescan, "超过单批上限必须改成全量重扫");
        assert!(pending.is_empty() && !rescan);

        // 没超上限时不该无谓地全量重扫
        pending.insert(root().join("one"));
        flush(&mut pending, &mut rescan, &emit);
        assert!(!rx.try_recv().expect("应当又发了一批").rescan);
    }

    #[test]
    fn 改名两边各落一个目录() {
        let a = root().join("newar").join("src");
        let b = root().join("newar").join("test");
        let mut out = BTreeSet::new();
        affected_dirs(&root(), &[a.join("A.java"), b.join("A.java")], &mut out);
        assert!(out.contains(&a) && out.contains(&b));
    }

    /// 真 OS 监听 + 合并窗口 + 事件推送整条链路：纯函数全绿也可能因为通道/线程接错而一枪不放。
    #[test]
    fn 真实监听报出新建文件的父目录() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let (tx, rx) = mpsc::channel::<WatchBatch>();
        let emit: Arc<dyn Fn(WatchBatch) + Send + Sync> = Arc::new(move |batch| {
            let _ = tx.send(batch);
        });
        let _watcher = WorkspaceWatcher::start(root.clone(), emit).unwrap();

        std::fs::write(root.join("external.txt"), "x").unwrap();
        let got = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("新建文件后没有收到目录事件");
        assert!(
            got.dirs.iter().any(|d| Path::new(d) == root),
            "事件里应当有工作区根：{got:?}"
        );
    }

    /// `.svn` 目录里的写入不能变成刷新事件（NC 工作副本里这类写入最密集）。
    #[test]
    fn 真实监听不报元数据目录() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let (tx, rx) = mpsc::channel::<WatchBatch>();
        let emit: Arc<dyn Fn(WatchBatch) + Send + Sync> = Arc::new(move |batch| {
            let _ = tx.send(batch);
        });
        let _watcher = WorkspaceWatcher::start(root.clone(), emit).unwrap();

        let svn = root.join(".svn");
        std::fs::create_dir_all(&svn).unwrap();
        std::fs::write(svn.join("entries"), "x").unwrap();
        assert!(
            rx.recv_timeout(Duration::from_millis(1200)).is_err(),
            "`.svn` 里的改动不该触发刷新"
        );
    }
}
