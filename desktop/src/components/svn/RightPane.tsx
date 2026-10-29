import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "../ui/icon";
import { DiffPane } from "./DiffPane";
import { HistoryView } from "./HistoryView";
import { BlameView } from "./BlameView";
import { ConflictPane } from "./ConflictPane";
import {
  friendlySvnError,
  isMarkable,
  keyOf,
  svnBlame,
  svnDiff,
  type ChangeItem,
} from "../../lib/svn";

export type RightMode = "diff" | "log" | "blame";

/**
 * 右栏宿主：按选中文件与视图模式决定渲染什么，并且只在需要时才发请求。
 *
 * 请求按需开：diff 只在「差异」模式下要，blame 只在「Blame」模式下要。
 * 一个文件来回切三个视图不会三次重复拉 BASE（React Query 按 key 缓存）。
 */
export function RightPane({
  file,
  mode,
  onMode,
  reviewed,
  busy,
  onToggleReviewed,
  onOpenFile,
  onMarkAndNext,
  onResolve,
  onLater,
}: {
  file: ChangeItem | null;
  mode: RightMode;
  onMode: (m: RightMode) => void;
  reviewed: boolean;
  busy: boolean;
  onToggleReviewed: () => void;
  onOpenFile: (path: string) => void;
  onMarkAndNext: () => void;
  onResolve: (choice: "mine" | "theirs" | "base") => void;
  onLater: () => void;
}) {
  const path = file?.path ?? "";
  const isConflict = file?.letter === "C";
  /** 已删除（D）/ 缺失（!）：盘上没有内容可对比，也不该去拉 BASE。 */
  const isGone = file?.letter === "D" || file?.letter === "!";
  const needDiff = !!file && !isConflict && !file.isDir && !isGone;

  const diff = useQuery({
    queryKey: ["svn-diff", path],
    queryFn: () => svnDiff(path),
    enabled: needDiff && mode !== "log",
    retry: false,
  });

  const blame = useQuery({
    queryKey: ["svn-blame", path],
    queryFn: () => svnBlame(path),
    enabled: !!file && mode === "blame",
    retry: false,
  });

  // Alt+↓：标记已审并跳到下一个。放在这里而不是 DiffPane 里，是因为
  // DiffPane 的 hook 数已经贴着门禁上限（8），再塞一个监听就要拆组件了。
  useEffect(() => {
    // 目录、已删除、缺失、冲突都标记不了（见 `isMarkable`），不接这个快捷键
    if (!file || !isMarkable(file)) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.key !== "ArrowDown") return;
      // 账号框这类模态打开时不抢：标记会连带把选中项跳走，而用户正忙着填密码
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      e.preventDefault();
      onMarkAndNext();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [file, onMarkAndNext]);

  if (!file) {
    return (
      <section className="vc-main">
        <div className="vc-empty">
          <Icon name="gitBranch" size={26} />
          <div>
            从左边选一个文件开始审查
            <br />
            标记已审后按 <kbd>Alt</kbd>+<kbd>↓</kbd> 逐个往下走
          </div>
        </div>
      </section>
    );
  }

  if (isConflict) {
    return (
      <ConflictPane
        file={file}
        busy={busy}
        onResolve={onResolve}
        onOpenFile={() => onOpenFile(file.path)}
        onLater={onLater}
      />
    );
  }

  if (file.isDir) {
    return (
      <section className="vc-main">
        <div className="vc-bar">
          <span className="vc-badge" data-st="untracked">
            {file.letter}
          </span>
          <b>{file.rel}</b>
          <span className="vc-sp" />
          <button type="button" className="vc-btn vc-btn-sm" onClick={() => onMode("log")}>
            看历史
          </button>
        </div>
        <div className="vc-empty">
          <Icon name="folder" size={22} />
          <div>
            目录级的改动（新增 / 未纳管 / 属性变更）
            <br />
            SVN 把整个目录当一个条目报出来，里面的文件不单独列
          </div>
        </div>
      </section>
    );
  }

  // 已删除 / 缺失有自己的空态：以前它们会掉到下面「拿不到这个文件的内容」的
  // 错误警报里，看起来像工具出故障，实际是正常状态（用户自己删的）。
  if (isGone) {
    return (
      <section className="vc-main">
        <div className="vc-bar">
          <span className="vc-badge" data-st="del">
            {file.letter}
          </span>
          <b>{file.rel.slice(file.rel.lastIndexOf("/") + 1)}</b>
          <span className="vc-sp" />
          <button type="button" className="vc-btn vc-btn-sm" onClick={() => onMode("log")}>
            看历史
          </button>
        </div>
        <div className="vc-empty">
          <Icon name="trash" size={22} />
          <div>
            {file.letter === "D" ? "这个文件已在本地删除，没有可对比的内容" : "这个文件不在盘上了（SVN 标记为缺失）"}
            <br />
            {file.letter === "D"
              ? "提交后服务器上也会删掉；不想删就用右上角「撤销」把它恢复回来"
              : "在文件夹里把它放回来，或者提交这次删除"}
          </div>
        </div>
      </section>
    );
  }

  if (mode === "log") {
    return <HistoryView path={file.path} title={file.rel} onBack={() => onMode("diff")} />;
  }

  if (mode === "blame") {
    return (
      <BlameView
        title={file.rel}
        text={diff.data?.workingText ?? ""}
        lines={blame.data}
        loading={blame.isLoading || diff.isLoading}
        error={blame.error ? friendlySvnError(blame.error) : null}
        onShowDiff={() => onMode("diff")}
      />
    );
  }

  if (diff.isLoading) {
    return (
      <section className="vc-main">
        <div className="vc-empty">
          <Icon name="spinner" size={20} className="animate-spin" />
          <div>正在取 BASE 版本对比…</div>
        </div>
      </section>
    );
  }

  if (diff.error || !diff.data) {
    return (
      <section className="vc-main">
        <div className="vc-bar">
          <span className="vc-badge" data-st="untracked">
            {file.letter}
          </span>
          <b>{file.rel.slice(file.rel.lastIndexOf("/") + 1)}</b>
          <span className="vc-sp" />
          <button type="button" className="vc-btn vc-btn-sm" onClick={() => onMode("log")}>
            看历史
          </button>
        </div>
        <div style={{ padding: 12 }}>
          <div className="vc-alert" data-tone="warn">
            <Icon name="alert" size={13} />
            <span>{diff.error ? friendlySvnError(diff.error) : "拿不到这个文件的内容"}</span>
          </div>
          {file.isDir && <div className="vc-hint" style={{ marginTop: 8 }}>目录没有可对比的内容，展开到具体文件再看。</div>}
        </div>
      </section>
    );
  }

  return (
    <DiffPane
      file={file}
      data={diff.data}
      reviewed={reviewed}
      onToggleReviewed={onToggleReviewed}
      onOpenInEditor={() => onOpenFile(file.path)}
      onShowLog={() => onMode("log")}
      onShowBlame={() => onMode("blame")}
      onMarkAndNext={onMarkAndNext}
    />
  );
}

/** 选中项是否已审：把 key 规则收在一处，别让调用方各写一遍小写化。 */
export function isReviewed(reviewed: Set<string>, path: string): boolean {
  return reviewed.has(keyOf(path));
}
