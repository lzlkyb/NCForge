//! 工作区文件监听：外部改动（SVN 更新、Eclipse 保存、脚本生成文件）之后，
//! 通知前端把文件树里**已读过的目录**重新读一遍。
//!
//! 噪音控制三层：
//! 1. 目录级：`.svn` / `.git` 这类元数据目录整棵不看——NC 工作副本里 `.svn`
//!    的写入量比业务代码大一个数量级；
//! 2. 事件级：只认「增 / 删 / 改名」，不认内容与属性变更——文件树只关心目录里
//!    有哪几项，编译一次改几千个 `.class` 的内容，跟着刷新是白烧 IO；
//! 3. 时间级：DEBOUNCE 内的改动合成一批，一次发去重后的父目录集合；持续不断的事件
//!    最多合并 MAX_WAIT，不会因为「一直有新事件」而一直不发。
//!
//! 前两层在 OS 回调里就做掉，再入有界队列（EVENT_QUEUE）：编译 / SVN 更新 / 解压
//! 这类事件风暴不会无限排队吃内存；队列满了就丢事件、记一笔，下一批改成全量重读。
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
use std::time::{Duration, Instant};

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

/// 待发目录上限：到顶改为全量重读，不再继续积累路径。
const MAX_PENDING: usize = 256;

/// 一批最多带多少个外部改动的 `.java`：再多就让前端按「全工作区」处理。
const MAX_JAVA: usize = 64;

/// 一批最多攒多久：持续写入时每来一个事件都会重置 DEBOUNCE，没有这个上限
/// 编译期间目录变化可能几十秒都送不到前端。
const MAX_WAIT: Duration = Duration::from_millis(1000);

/// OS 回调 → 合并线程之间的有界队列长度（已过滤后的事件）。
const EVENT_QUEUE: usize = 4096;

/// 这个事件值不值得送进队列：内容 / 属性变更、全在元数据目录里的，回调里就丢掉。
/// 平台的「可能丢事件」信号无论如何都要送。
///
/// **`.java` 内容变更是例外**：树不用刷新，但构建引擎要知道「外部改了源码」。
/// 只放行 `.java`，编译写出的 `.class` 仍然在回调里丢掉。
pub fn worth_queueing(ev: &notify::Event) -> bool {
    ev.need_rescan()
        || (needs_tree_refresh(&ev.kind) && ev.paths.iter().any(|p| !is_ignored(p)))
        || (is_java_change(&ev.kind) && ev.paths.iter().any(|p| is_java_path(p)))
}

/// 外部源码改动：内容变更 + 增删改名（新增/删除会让模块走全量）。
pub fn is_java_change(kind: &notify::EventKind) -> bool {
    use notify::{event::ModifyKind, EventKind};
    matches!(
        kind,
        EventKind::Create(_)
            | EventKind::Remove(_)
            | EventKind::Modify(ModifyKind::Data(_))
            | EventKind::Modify(ModifyKind::Any)
            | EventKind::Modify(ModifyKind::Name(_))
    )
}

pub fn is_java_path(path: &Path) -> bool {
    !is_ignored(path)
        && path
            .extension()
            .is_some_and(|x| x.eq_ignore_ascii_case("java"))
}

/// 合并状态机（纯逻辑，时间由调用方传入，便于单测）。
#[derive(Default)]
struct Batcher {
    pending: BTreeSet<PathBuf>,
    rescan: bool,
    /// 外部改动的 `.java`（绝对路径，已去重）
    java: BTreeSet<PathBuf>,
    /// `.java` 太多，下一批让前端按全工作区处理
    java_overflow: bool,
    /// 这一批第一个事件到达的时间；空批为 None。
    since: Option<Instant>,
}

impl Batcher {
    fn add(&mut self, root: &Path, ev: &notify::Event, now: Instant) {
        self.rescan |= ev.need_rescan();
        if !self.rescan && needs_tree_refresh(&ev.kind) {
            affected_dirs(root, &ev.paths, &mut self.pending);
            self.rescan |= self.pending.len() >= MAX_PENDING;
        }
        if is_java_change(&ev.kind) {
            for p in &ev.paths {
                if p.starts_with(root) && is_java_path(p) {
                    if self.java.len() < MAX_JAVA {
                        self.java.insert(p.clone());
                    } else {
                        self.java_overflow = true;
                    }
                }
            }
        }
        if self.since.is_none()
            && (self.rescan || !self.pending.is_empty() || !self.java.is_empty())
        {
            self.since = Some(now);
        }
    }

    /// 队列溢出丢了事件：下一批让前端整体重读。
    fn mark_lost(&mut self, now: Instant) {
        self.rescan = true;
        self.since.get_or_insert(now);
    }

    /// 重扫 / 源码改动都要尽快送：持续队列溢出不能退化成逐事件触发整棵树重读。
    fn due(&self, now: Instant) -> bool {
        let urgent = self.rescan || !self.java.is_empty();
        self.since
            .is_some_and(|t| now.duration_since(t) >= if urgent { DEBOUNCE } else { MAX_WAIT })
    }

    /// 下一次 recv 最多等多久：平时 DEBOUNCE，但不能越过这一批的 MAX_WAIT 截止点。
    fn wait(&self, now: Instant) -> Duration {
        let urgent = self.rescan || !self.java.is_empty();
        match self.since {
            Some(t) => DEBOUNCE.min(
                (if urgent { DEBOUNCE } else { MAX_WAIT }).saturating_sub(now.duration_since(t)),
            ),
            None => DEBOUNCE,
        }
    }

    fn flush(&mut self, emit: &Arc<dyn Fn(WatchBatch) + Send + Sync>) {
        self.since = None;
        flush(
            &mut self.pending,
            &mut self.rescan,
            &mut self.java,
            &mut self.java_overflow,
            emit,
        );
    }
}

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
    /// 外部改动的 `.java`（绝对路径）。前端据此触发一次自动编译；
    /// 与 `dirs` 分开：树刷新和「源码变了」是两件事，不能互相冒充。
    pub java: Vec<String>,
    /// 改动的 `.java` 太多：前端应按「全工作区」处理，不要逐个文件编。
    pub java_overflow: bool,
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
        let (tx, rx) = mpsc::sync_channel::<notify::Event>(EVENT_QUEUE);
        // 队列满时丢掉的事件不能当没发生：记下来，合并线程据此改成全量重读
        let lost = Arc::new(AtomicBool::new(false));
        let lost_cb = Arc::clone(&lost);
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            match res {
                // 先过滤再入队：内容变更（编译写 .class）与 .svn 写入占事件的绝大多数
                Ok(ev) if worth_queueing(&ev) => match tx.try_send(ev) {
                    Ok(()) => {}
                    Err(mpsc::TrySendError::Full(_)) => lost_cb.store(true, Ordering::Relaxed),
                    // 接收方已退出（正在换工作区）：丢弃即可，回调里不能阻塞
                    Err(mpsc::TrySendError::Disconnected(_)) => {}
                },
                Ok(_) => {}
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
                let mut batch = Batcher::default();
                loop {
                    // 让出点：没有事件时阻塞在 recv_timeout 上，每轮至多一次 flush
                    if stop_thread.load(Ordering::Relaxed) {
                        break;
                    }
                    match rx.recv_timeout(batch.wait(Instant::now())) {
                        // 丢了事件时平台给的补偿信号（need_rescan）在 add 里并入：
                        // 宁可让前端重读一遍，也别一直显示旧树
                        Ok(ev) => batch.add(&root, &ev, Instant::now()),
                        Err(RecvTimeoutError::Timeout) => batch.flush(&emit),
                        // 生产端（watcher 回调里的 tx）没了：循环自行结束，不空转
                        Err(RecvTimeoutError::Disconnected) => break,
                    }
                    if lost.swap(false, Ordering::Relaxed) {
                        batch.mark_lost(Instant::now());
                    }
                    if batch.due(Instant::now()) {
                        batch.flush(&emit);
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
    java: &mut BTreeSet<PathBuf>,
    java_overflow: &mut bool,
    emit: &Arc<dyn Fn(WatchBatch) + Send + Sync>,
) {
    if pending.is_empty() && !*rescan && java.is_empty() && !*java_overflow {
        return;
    }
    // 超过单批上限时列表只带得走前 MAX_DIRS 个。剩下的不能就这么丢了——
    // 让前端把已读目录整体重读一遍（它本来就只读用户展开过的那几层）。
    let overflow = pending.len() > MAX_DIRS;
    let batch = WatchBatch {
        dirs: dirs_payload(pending),
        rescan: *rescan || overflow,
        java: java.iter().map(|p| display_path(p)).collect(),
        java_overflow: *java_overflow,
    };
    *rescan = false;
    pending.clear();
    java.clear();
    *java_overflow = false;
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
        let (mut java, mut java_overflow) = (BTreeSet::new(), false);
        flush(
            &mut pending,
            &mut rescan,
            &mut java,
            &mut java_overflow,
            &emit,
        );
        let batch = rx.try_recv().expect("应当发了一批");
        assert_eq!(batch.dirs.len(), MAX_DIRS);
        // 装不下的目录不能静默丢掉，否则它们会一直停在旧内容
        assert!(batch.rescan, "超过单批上限必须改成全量重扫");
        assert!(pending.is_empty() && !rescan);

        // 没超上限时不该无谓地全量重扫
        pending.insert(root().join("one"));
        flush(
            &mut pending,
            &mut rescan,
            &mut java,
            &mut java_overflow,
            &emit,
        );
        assert!(!rx.try_recv().expect("应当又发了一批").rescan);
    }

    fn ev(kind: K, path: PathBuf) -> notify::Event {
        notify::Event::new(kind).add_path(path)
    }

    #[test]
    fn 回调里先过滤再入队() {
        let src = root().join("newar").join("src");
        assert!(worth_queueing(&ev(
            K::Create(CreateKind::File),
            src.join("A.java")
        )));
        // 编译改 .class 内容、.svn 里的新建：都不进队列
        assert!(!worth_queueing(&ev(
            K::Modify(ModifyKind::Data(DataChange::Content)),
            src.join("A.class")
        )));
        // 外部改 .java 内容：树不用刷新，但必须送进队列让构建引擎知道
        assert!(worth_queueing(&ev(
            K::Modify(ModifyKind::Data(DataChange::Content)),
            src.join("A.java")
        )));
        assert!(!worth_queueing(&ev(
            K::Create(CreateKind::File),
            root().join(".svn").join("tmp")
        )));
        // 平台说可能丢事件：必须送
        let lost = notify::Event::new(K::Other).set_flag(notify::event::Flag::Rescan);
        assert!(worth_queueing(&lost));
    }

    #[test]
    fn 持续事件最多合并一个截止期() {
        let t0 = Instant::now();
        let mut b = Batcher::default();
        let src = root().join("newar").join("src");
        // 每 100ms 来一个事件（比 DEBOUNCE 短，旧逻辑永远等不到超时）。
        // 用非 .java 的普通文件：.java 改动是 urgent，350ms 就会发（见下一个断言）。
        let mut now = t0;
        let mut flushed_at = None;
        for i in 0..30 {
            b.add(
                &root(),
                &ev(K::Create(CreateKind::File), src.join(format!("F{i}.xml"))),
                now,
            );
            if b.due(now) {
                flushed_at = Some(now.duration_since(t0));
                break;
            }
            // 等待时间不能越过本批截止点
            assert!(b.wait(now) <= MAX_WAIT.saturating_sub(now.duration_since(t0)));
            now += Duration::from_millis(100);
        }
        let at = flushed_at.expect("持续写入时也必须按期发出");
        assert!(
            at >= MAX_WAIT && at < MAX_WAIT + Duration::from_millis(100),
            "{at:?}"
        );

        // 发完后状态清空，空批等待恢复 DEBOUNCE
        let (tx, rx) = mpsc::channel::<WatchBatch>();
        let emit: Arc<dyn Fn(WatchBatch) + Send + Sync> = Arc::new(move |x| drop(tx.send(x)));
        b.flush(&emit);
        assert_eq!(rx.try_recv().unwrap().dirs.len(), 1);
        assert!(!b.due(now) && b.wait(now) == DEBOUNCE);

        // 队列溢出丢了事件：合并一个窗口后要求全量重读
        b.mark_lost(now);
        assert!(!b.due(now));
        assert!(b.due(now + DEBOUNCE));
        b.flush(&emit);
        assert!(rx.try_recv().unwrap().rescan);
    }

    #[test]
    fn 持续溢出不会逐事件触发全量重读() {
        let t0 = Instant::now();
        let mut b = Batcher::default();
        let (tx, rx) = mpsc::channel::<WatchBatch>();
        let emit: Arc<dyn Fn(WatchBatch) + Send + Sync> = Arc::new(move |x| drop(tx.send(x)));
        for ms in 0..2000 {
            let now = t0 + Duration::from_millis(ms);
            b.mark_lost(now);
            if b.due(now) {
                b.flush(&emit);
            }
        }
        let batches: Vec<_> = rx.try_iter().collect();
        assert!(!batches.is_empty());
        assert!(batches.len() <= 6, "两秒内只允许按合并窗口重扫");
        assert!(batches.iter().all(|batch| batch.rescan));
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
        // macOS 的 FSEvents 交回真实路径（/var → /private/var），notify 内部也按
        // canonical 路径匹配监听根；用非 canonical 的临时目录会让事件被平台侧丢掉，
        // 与合并窗口无关。Windows 保持原样，避免 \\?\ 前缀干扰事件路径比较。
        #[cfg(unix)]
        let root = dir.path().canonicalize().unwrap();
        #[cfg(windows)]
        let root = dir.path().to_path_buf();
        let (tx, rx) = mpsc::channel::<WatchBatch>();
        let emit: Arc<dyn Fn(WatchBatch) + Send + Sync> = Arc::new(move |batch| {
            let _ = tx.send(batch);
        });
        let _watcher = WorkspaceWatcher::start(root.clone(), emit).unwrap();

        // FSEvents（macOS）的事件流是异步就绪的：start 返回后立刻写一次文件，事件可能
        // 落在监听真正生效之前。固定 sleep 猜不中窗口，改成「写一次、等一小会儿」重试；
        // 断言没放松——仍要求某一批事件里出现工作区根，只是不再赌首次写入的时序。
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut attempt = 0u32;
        loop {
            std::fs::write(root.join(format!("external-{attempt}.txt")), "x").unwrap();
            attempt += 1;
            match rx.recv_timeout(Duration::from_millis(500)) {
                Ok(got) if got.dirs.iter().any(|d| Path::new(d) == root) => break,
                Ok(_) | Err(RecvTimeoutError::Timeout) => {
                    assert!(
                        Instant::now() < deadline,
                        "10 秒内没有收到工作区根的刷新事件（写了 {attempt} 次）"
                    );
                }
                Err(RecvTimeoutError::Disconnected) => panic!("事件通道被关闭"),
            }
        }
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
