//! 工作区监听的事件 / 路径分类规则（纯逻辑，从 watcher.rs 拆出）。
//!
//! 只回答「这个事件 / 路径归哪条通道」：文件树刷新、外部 java 改动、可审查文本、
//! SVN 脏集、库目录来源。不摸 OS、无状态；合并与发送仍在 watcher.rs。

use std::path::{Component, Path};

/// 不参与刷新的目录名（任意一级命中即跳过）。比较忽略大小写：
/// Windows 上 `NC\.SVN\` 与 `.svn` 是同一个目录。
const IGNORED_DIRS: [&str; 3] = [".svn", ".git", ".idea"];

/// 这个事件值不值得送进队列：内容 / 属性变更、全在元数据目录里的，回调里就丢掉。
/// 平台的「可能丢事件」信号无论如何都要送。
///
/// **`.java` 内容变更是例外**：树不用刷新，但构建引擎要知道「外部改了源码」。
/// 只放行 `.java`，编译写出的 `.class` 仍然在回调里丢掉。
///
/// **可审查文本文件的内容变更是另一个例外**：AI 工具 / 别的编辑器改 `.xml`、
/// `.sql`、`.properties`、`.js` 时，审查时间线、改动色条、已审角标都要跟着更新，
/// 不送的话这些改动对工作台完全不可见（只有 `.java` 能进自动编译那条线）。
pub fn worth_queueing(ev: &notify::Event, root: &Path) -> bool {
    ev.need_rescan()
        || (needs_tree_refresh(&ev.kind) && ev.paths.iter().any(|p| !is_ignored(p)))
        || (is_java_change(&ev.kind) && ev.paths.iter().any(|p| is_java_path(p)))
        || (is_review_change(&ev.kind) && ev.paths.iter().any(|p| is_review_path(p)))
        // 版本控制页的增量刷新要知道「哪个模块脏了」。这条比前三条宽：SVN 的
        // modified 只认 mtime/size，`touch` 一下、改个 .txt 都算——它们进不了
        // 文件树与审查时间线，但不送进来增量就会漏掉这次改动。
        || (is_svn_watchable(&ev.kind) && ev.paths.iter().any(|p| svn_relevant(p, root)))
}

/// SVN 脏集关心的事件：除了「读」都算。
///
/// `Access` 是读文件 / 读属性（应用自己打开标签就一堆），送进来纯属噪音。
pub(crate) fn is_svn_watchable(kind: &notify::EventKind) -> bool {
    use notify::EventKind;
    !matches!(kind, EventKind::Access(_) | EventKind::Other)
}

/// 这个路径变了，有没有可能让 `svn status` 的结论变。
///
/// **元数据目录认 `entries` 与 `wc.db` 两种**：
/// - format 10（1.6 及更早）每个目录一份 `.svn/entries`；
/// - format 12+（1.7 起）整份副本只有一个 `.svn/wc.db`，`entries` 退化成占位内容
///   （只写着 `12`），**add / delete 根本不会改它**。
///
/// SVNKit 升到 1.10.11 后两种副本都能操作，只认 `entries` 会让 1.7+ 副本里
/// 「`svn add` 一个已存在的文件」完全不可见：文件本身没被写过、脏集又是空的，
/// 增量刷新把这次新增当成不存在。
///
/// 🔴 **`root` 必须传**：`svn_view::is_ignored` 的契约是「只看相对路径」，
/// 它按整段匹配 `classes`/`out`/`target`/`bin` 等目录名。把绝对路径直接喂进去，
/// 工作区本身住在 `D:\out\newar`、`C:\dev\target\ws` 下时**每个文件都会被判忽略**，
/// 脏集永远为空 ⇒ 首次全量之后所有增量都走缓存，改动再也不出现。
pub fn svn_relevant(path: &Path, root: &Path) -> bool {
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        // 构建产物 / 归档：`svn_view::is_ignored` 本来就不把它们当改动。
        // 先按扩展名挡掉是性能考虑——编译一次几千个 .class 事件全走下面的
        // 字符串切分，会把 OS 回调拖慢。
        const NOISE: [&str; 6] = ["class", "jar", "zip", "log", "tmp", "bak"];
        if NOISE.iter().any(|e| ext.eq_ignore_ascii_case(e)) {
            return false;
        }
    }
    if is_ignored(path) {
        let name_is = |p: Option<&Path>, want: &str| {
            p.and_then(|x| x.file_name())
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.eq_ignore_ascii_case(want))
        };
        if !name_is(path.parent(), ".svn") {
            return false;
        }
        // wc.db-wal / wc.db-journal 是 SQLite 的临时文件，一次事务写好几遍，
        // 认它们等于把噪音全收进来；真正的提交落在 wc.db 本身。
        return name_is(Some(path), "entries") || name_is(Some(path), "wc.db");
    }
    // 构建产物目录（classes / out / target …）里的东西，改了 SVN 也不报。
    // 先剥掉工作区根：规则只该作用于工程内部的相对路径。
    let rel = path.strip_prefix(root).unwrap_or(path);
    !crate::svn_view::is_ignored(&rel.to_string_lossy(), false)
}

/// 可审查文件的**内容**变更。不含增 / 删 / 改名：那类改动由文件树与「转到文件」
/// 清单负责（见 `needs_tree_refresh` / `files_changed`），新建的文件本来就没有
/// 旧内容可供比对，删掉的文件在编辑器里也不再存在。
pub(crate) fn is_review_change(kind: &notify::EventKind) -> bool {
    use notify::{event::ModifyKind, EventKind};
    matches!(
        kind,
        EventKind::Modify(ModifyKind::Data(_)) | EventKind::Modify(ModifyKind::Any)
    )
}

/// 可审查 = 工作区内的文本文件（与「转到文件」清单同一套判定：二进制扩展名 /
/// 构建产物目录都不算）。`.java` 也在其中——它同样要进审查时间线。
pub(crate) fn is_review_path(path: &Path) -> bool {
    !is_ignored(path) && crate::search::is_listed_path(path)
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

/// 库文件目录（library_index）收录的来源：jar、class、文本条目与 `.classpath`。
/// 这些变了才失效目录；普通图片 / 二进制改动不该触发重扫。
pub fn is_library_path(path: &Path) -> bool {
    if is_ignored(path) {
        return false;
    }
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if name.eq_ignore_ascii_case(".classpath") {
        return true;
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    ext == "jar" || ext == "class" || crate::library_index::text_entry(name)
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
