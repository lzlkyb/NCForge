import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "../ui/icon";
import { DiffPane } from "./DiffPane";
import { HistoryView } from "./HistoryView";
import { BlameView } from "./BlameView";
import { ConflictPane } from "./ConflictPane";
import {
  formatBytes,
  friendlySvnError,
  isMarkable,
  letterTone,
  svnStatusLabel,
  svnDiff,
  type ChangeItem,
} from "../../lib/svn";
import { svnBlameSnapshot } from "../../lib/svnHistory";
import { useWorkspaceRoot } from "../../lib/workspaceSession";
import { workspaceEpoch } from "../../lib/workspaceEpoch";
import { readFile } from "../../lib/workspace";

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
  onPrepareNew,
  onMarkAndNext,
  onResolve,
  onLater,
  focused,
  onFocus,
  disabled = false,
}: {
  file: ChangeItem | null;
  mode: RightMode;
  onMode: (m: RightMode) => void;
  reviewed: boolean;
  busy: boolean;
  onToggleReviewed: () => void;
  onOpenFile: (path: string) => void;
  onPrepareNew?: () => void;
  onMarkAndNext: () => void;
  onResolve: (choice: "mine" | "theirs" | "base") => void;
  onLater: () => void;
  focused?: boolean;
  onFocus?: () => void;
  disabled?: boolean;
}) {
  const root = useWorkspaceRoot(); const epoch = workspaceEpoch();
  const [historyRevision, setHistoryRevision] = useState<number | undefined>();
  const path = file?.path ?? "";
  const isConflict = file?.letter === "C";
  /** 已删除（D）/ 缺失（!）：盘上没有内容可对比，也不该去拉 BASE。 */
  const isGone = file?.letter === "!";
  const isNew = file?.letter === "?" || file?.letter === "A";
  const newFile = useQuery({
    queryKey: ["svn-new-file", root, epoch, path, file?.letter, file?.mtimeMs],
    queryFn: () => readFile(path),
    enabled: isNew && !file?.isDir,
    retry: false,
  });
  const needDiff = !!file && !isNew && !isConflict && !file.isDir && !isGone;

  const diff = useQuery({
    queryKey: ["svn-diff", root, epoch, path],
    queryFn: () => svnDiff(path),
    enabled: needDiff && mode === "diff",
    retry: false,
  });

  const blame = useQuery({
    queryKey: ["svn-blame-snapshot", root, epoch, path],
    queryFn: () => svnBlameSnapshot(path),
    enabled: !!file && !isNew && !file.isDir && mode === "blame",
    retry: false,
  });

  // Alt+↓：标记已审并跳到下一个。放在这里而不是 DiffPane 里，是因为
  // DiffPane 的 hook 数已经贴着门禁上限（8），再塞一个监听就要拆组件了。
  useEffect(() => {
    // 目录、已删除、缺失、冲突都标记不了（见 `isMarkable`），不接这个快捷键
    const readable = isNew ? newFile.data && !newFile.isFetching : diff.data && !diff.isFetching;
    if (!file || !isMarkable(file) || disabled || mode !== "diff" || !readable) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || !e.altKey || e.key !== "ArrowDown") return;
      if ((e.target as HTMLElement)?.closest("input,textarea,select,[contenteditable='true']")) return;
      // 账号框这类模态打开时不抢：标记会连带把选中项跳走，而用户正忙着填密码
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      e.preventDefault();
      onMarkAndNext();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [file, onMarkAndNext, disabled, mode, diff.data, diff.isFetching, isNew, newFile.data, newFile.isFetching]);

  if (mode === "log" && root && !isNew) {
    const module = file?.rel.includes("/") ? `${root.replace(/[\\/]$/, "")}/${file.rel.split("/")[0]}` : undefined;
    return <HistoryView key={`${root}:${epoch}:${path}:${historyRevision ?? ""}`} path={file?.path ?? root} title={file?.rel ?? "工作副本"} modulePath={module} initialRevision={historyRevision} onBack={() => { setHistoryRevision(undefined); onMode("diff"); }} />;
  }

  if (!file) {
    return (
      <section className="vc-main">
        <div className="vc-empty">
          <Icon name="gitBranch" size={26} />
          <div>
            从左边选一个文件开始审查
            <br />
            按 <kbd>Alt</kbd>+<kbd>↓</kbd> 标记已审并查看下一项
          </div>
        </div>
      </section>
    );
  }

  if (isNew) {
    const data = newFile.data;
    const binary = String(newFile.error ?? "").includes("疑似二进制文件");
    const lines = data?.text ? data.text.split(/\r\n|\n|\r/).length - Number(/[\r\n]$/.test(data.text)) : 0;
    return <section className="vc-main">
      <div className="vc-bar">
        <b title={file.rel}>{file.rel.split("/").pop()}</b>
        <span title={`SVN ${file.letter}`}>{file.letter === "A" ? "已加入 SVN · 待提交" : "本地新增 · 未加入 SVN"}</span>
        <span className="vc-sp" />
        {data && isMarkable(file) && <button type="button" className="vc-btn vc-btn-sm vc-btn-primary vc-review-next" aria-keyshortcuts="Alt+ArrowDown" title="标记已审并查看下一项 · Alt+↓" disabled={disabled || newFile.isFetching} onClick={onMarkAndNext}><Icon name="check" size={12} /><span>已审并看下一项</span></button>}
        {data && <button type="button" className="vc-btn vc-btn-sm" aria-pressed={reviewed} disabled={disabled || newFile.isFetching} onClick={onToggleReviewed}>{reviewed ? "取消已审" : "标记已审"}</button>}
        {onPrepareNew && <button type="button" className="vc-btn vc-btn-sm" disabled={disabled} onClick={onPrepareNew}>准备提交</button>}
        <button type="button" className="vc-btn vc-btn-sm" onClick={() => onOpenFile(file.path)}>{file.isDir ? "打开目录" : "打开编辑器"}</button>
      </div>
      {file.isDir ? <div className="vc-empty">{file.rel} · 新增目录</div>
        : binary ? <div className="vc-empty">{file.rel} · 二进制文件</div>
        : newFile.error ? <div className="vc-alert" data-tone="warn" role="alert">读取本地文件失败：{String(newFile.error)} <button type="button" className="vc-btn vc-btn-sm" disabled={newFile.isFetching} onClick={() => void newFile.refetch()}>重试</button></div>
        : data ? <>
          <div className="vc-bar">{lines} 行新增 · {data.encoding} · {formatBytes(data.size)}</div>
          <pre aria-label="新增文件内容" tabIndex={0} style={{ flex: 1, minHeight: 0, overflow: "auto", margin: 0, padding: "12px 16px", fontFamily: "var(--font-mono)", tabSize: 4 }}>{data.text || "空文件"}</pre>
        </> : <div className="vc-empty" role="status">正在读取本地文件…</div>}
    </section>;
  }

  if (isConflict) {
    return (
      <ConflictPane
        // 必须带 key：`choice` 是面板内 state，换文件时 React 会复用同一个实例，
        // 于是一个文件上的「已选作最终内容」会原封不动地带到下一个冲突文件上，
        // 用户没选过的文件也会立刻可点「已解决」——那是不可逆的覆盖。
        key={file.path}
        file={file}
        busy={busy}
        onResolve={onResolve}
        onOpenFile={() => onOpenFile(file.path)}
        onLater={onLater}
      />
    );
  }

  // 历史放在目录 / 已删除之前：这两种状态也提供「看历史」，以前分支顺序把它们
  // 挡在外面，按钮点了没反应。目录的 log 由后端按路径查，已删除/缺失的条目
  // 仍在版本控制里（D / !），同样查得到。

  if (file.isDir) {
    return (
      <section className="vc-main">
        <div className="vc-bar">
          <span className="vc-badge vc-badge-label" data-st="untracked" title={`SVN ${file.letter}`}>
            {svnStatusLabel[file.letter]}
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
            目录级的改动（新增 / 未跟踪 / 属性变更）
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
          <span className="vc-badge vc-badge-label" data-st={letterTone(file.letter)} title={`SVN ${file.letter}`}>
            {svnStatusLabel[file.letter]}
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

  if (mode === "blame") {
    return (
      <BlameView
        title={file.rel}
        snapshot={blame.data}
        loading={blame.isLoading}
        retrying={blame.isFetching}
        error={blame.error ? friendlySvnError(blame.error) : null}
        onShowDiff={() => onMode("diff")}
        onRetry={() => void blame.refetch()}
        onShowRevision={revision => { setHistoryRevision(revision); onMode("log"); }}
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
          <span className="vc-badge vc-badge-label" data-st="untracked" title={`SVN ${file.letter}`}>
            {svnStatusLabel[file.letter]}
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
            <span style={{ flex: 1 }}>{diff.error ? friendlySvnError(diff.error) : "拿不到这个文件的内容"}</span>
            {/* 失败多半是 svn 瞬时错（锁 / 网络 / 服务器忙）：留一个原地重试，
                否则用户只能去顶栏点「刷新」，把整份改动清单重扫一遍 */}
            <button type="button" className="vc-btn vc-btn-sm" disabled={diff.isFetching}
              onClick={() => void diff.refetch()}>
              {diff.isFetching ? "重试中…" : "重试"}
            </button>
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
      focused={focused}
      onFocus={onFocus}
      disabled={disabled || diff.isFetching}
    />
  );
}
