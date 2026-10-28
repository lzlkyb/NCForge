import { useMemo, useState } from "react";
import "../../svn.css";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { ChangeList } from "../svn/ChangeList";
import { CommitPanel } from "../svn/CommitPanel";
import { RightPane, type RightMode } from "../svn/RightPane";
import { AuthDialog } from "../svn/AuthDialog";
import { useSvnStatus } from "../../hooks/useSvnStatus";
import { useSvnChanges } from "../../hooks/useSvnChanges";
import {
  formatRevTime,
  friendlySvnError,
  keyOf,
  parseSvnError,
  svnAuthSet,
  type ChangeItem,
} from "../../lib/svn";

/**
 * 版本控制页。
 *
 * 布局照 design/NCForge-版本控制-设计稿-2026-10-28.html：
 * 左改动列表（module 分组 + 审查进度）／右差异面板；提交时右栏原地换成提交视图。
 *
 * 状态与命令分在两个 hook 里（扫描/已审 vs 更新/提交/撤销/冲突），
 * 这个文件只负责布局与「出错弹什么」。
 */
export function SvnTab({ onOpenFile }: { onOpenFile: (path: string) => void }) {
  const [showIgnored, setShowIgnored] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [mode, setMode] = useState<RightMode>("diff");
  const [committing, setCommitting] = useState(false);
  const [busy, setBusy] = useState<null | "commit" | "update" | "revert" | "resolve" | "auth">(null);
  const [auth, setAuth] = useState<{ open: boolean; error: string | null }>({ open: false, error: null });
  const [revertOpen, setRevertOpen] = useState(false);

  const { info, status, reviewed, mark, refresh } = useSvnStatus();
  const { doUpdate, doCommit, doRevert, doResolve } = useSvnChanges({
    setBusy,
    setAuth,
    refresh,
    onCommitted: () => {
      setCommitting(false);
      setSelectedPath(null);
    },
    onReverted: () => setSelectedPath(null),
  });

  const items = useMemo(
    () => status.data?.changes.groups.flatMap((g) => g.items) ?? [],
    [status.data],
  );
  // 提交清单与计数**永远排除构建产物**，跟左栏那个显示开关无关：
  // 打开了「显示全部」是为了看见它们，不是为了把它们提交上去。
  const files = useMemo(() => items.filter((it) => !it.isDir && !it.ignored), [items]);
  const selected = useMemo(
    () => items.find((it) => it.path === selectedPath) ?? null,
    [items, selectedPath],
  );
  const committable = files.filter((f) => f.letter !== "C");
  const conflictCount = files.length - committable.length;

  const pick = (it: ChangeItem) => {
    setSelectedPath(it.path);
    setMode("diff");
    setCommitting(false);
  };

  /** 下一个待审文件：跳过已审与冲突，从当前项的下一项开始绕一圈。 */
  const nextTarget = (): ChangeItem | null => {
    if (files.length === 0) return null;
    const start = selected ? files.findIndex((f) => f.path === selected.path) : -1;
    for (let k = 1; k <= files.length; k += 1) {
      const it = files[(start + k + files.length) % files.length];
      if (it.letter !== "C" && !reviewed.has(keyOf(it.path))) return it;
    }
    return files[(start + 1 + files.length) % files.length] ?? null;
  };

  const markAndNext = () => {
    if (!selected) return;
    // 一律标成已审（不是切换）：这个动作的语义是「看过了，下一个」，
    // 手滑在已审文件上再按一次不该反而把它变回未审。
    void mark(selected.path, selected.revision, true).catch((e) => {
      toast(friendlySvnError(e), "error");
    });
    const next = nextTarget();
    if (next && next.path !== selected.path) {
      setSelectedPath(next.path);
      setMode("diff");
    }
  };

  const statusError = status.error ? parseSvnError(status.error) : null;
  // 不能拿「改动条数」当版本号兜底：那会在 info 失败时显示成 r12（其实是 12 处改动）
  const rev = info.data?.revision ?? 0;

  return (
    <div className="vc-page">
      <div className="vc-head">
        <h1>版本控制</h1>
        <span className="vc-rev">r{rev > 0 ? rev : "?"}</span>
        <span className="vc-url" title={info.data?.url ?? ""}>
          {info.data?.url ?? (info.error ? friendlySvnError(info.error) : "正在识别工作副本…")}
        </span>
        <span className="vc-sp" />
        {status.data && (
          <span className="vc-hint">
            {status.data.changes.shown} 处改动 · 扫于 {formatRevTime(status.data.generatedAtMs)}
          </span>
        )}
        <button type="button" className="vc-btn" disabled={status.isFetching} onClick={refresh}>
          <Icon name="refresh" size={13} className={status.isFetching ? "vc-spin" : undefined} />
          {status.isFetching ? "扫描中…" : "刷新"}
        </button>
        <button type="button" className="vc-btn" disabled={busy !== null} onClick={doUpdate}>
          <Icon name="download" size={13} />
          {busy === "update" ? "更新中…" : "更新"}
        </button>
        <button
          type="button"
          className="vc-btn"
          disabled={!selected || busy !== null}
          onClick={() => setRevertOpen(true)}
          title={selected ? `撤销 ${selected.rel} 的本地改动` : "先在左侧选一个文件"}
        >
          <Icon name="trash" size={13} />
          撤销
        </button>
        <button
          type="button"
          className="vc-btn vc-btn-primary"
          disabled={busy !== null || committable.length === 0 || conflictCount > 0}
          onClick={() => setCommitting(true)}
          title={conflictCount > 0 ? `先解决 ${conflictCount} 个冲突文件` : "勾选要提交的文件"}
        >
          <Icon name="upload" size={13} />
          提交 {committable.length}
        </button>
      </div>

      {statusError && (
        <div style={{ padding: "10px 14px" }}>
          <div className="vc-alert" data-tone={statusError.code === "auth" ? "info" : "warn"}>
            <Icon name="alert" size={13} />
            <span style={{ flex: 1 }}>{friendlySvnError(status.error)}</span>
            {statusError.code === "auth" && (
              <button
                type="button"
                className="vc-btn vc-btn-sm"
                onClick={() => setAuth({ open: true, error: null })}
              >
                填账号
              </button>
            )}
            <button type="button" className="vc-btn vc-btn-sm" onClick={refresh}>
              重试
            </button>
          </div>
        </div>
      )}

      <div className="vc-split">
        <ChangeList
          view={status.data?.changes ?? { groups: [], shown: 0, total: 0, ignored: 0 }}
          reviewed={reviewed}
          selected={selectedPath}
          loading={status.isFetching}
          onSelect={pick}
          showIgnored={showIgnored}
          onToggleIgnored={() => setShowIgnored((v) => !v)}
        />

        {committing ? (
          <CommitPanel
            items={files}
            hasConflict={conflictCount > 0}
            busy={busy === "commit"}
            onSubmit={(message, paths) => void doCommit(message, paths)}
            onCancel={() => setCommitting(false)}
          />
        ) : (
          <RightPane
            file={selected}
            mode={mode}
            onMode={setMode}
            reviewed={selected ? reviewed.has(keyOf(selected.path)) : false}
            busy={busy === "resolve"}
            onToggleReviewed={() => {
              if (!selected) return;
              void mark(selected.path, selected.revision, !reviewed.has(keyOf(selected.path))).catch((e) => {
                toast(friendlySvnError(e), "error");
              });
            }}
            onOpenFile={onOpenFile}
            onMarkAndNext={markAndNext}
            onResolve={(choice) => selected && void doResolve(selected.path, choice)}
            onLater={() => setSelectedPath(null)}
          />
        )}
      </div>

      <ConfirmDialog
        open={revertOpen}
        variant="destructive"
        title="撤销本地改动？"
        confirmLabel="撤销"
        description={
          <>
            将丢弃 <b>{selected?.rel}</b> 的全部本地改动，恢复成 BASE 版本。这是唯一不能从 SVN 取回的操作
            ——工作台会先把这个文件备份到工作副本旁边的 <code>.ncforge-revert-&lt;时间戳&gt;</code> 目录。
          </>
        }
        onCancel={() => setRevertOpen(false)}
        onConfirm={() => {
          setRevertOpen(false);
          if (selected) void doRevert([selected.path], false);
        }}
      />

      <AuthDialog
        open={auth.open}
        host={info.data?.host ?? ""}
        defaultUser={info.data?.user ?? ""}
        busy={busy === "auth"}
        error={auth.error}
        onClose={() => setAuth({ open: false, error: null })}
        onSubmit={async (user, password) => {
          setBusy("auth");
          try {
            await svnAuthSet(user, password);
            setAuth({ open: false, error: null });
            toast("账号已保存，正在重新扫描", "success");
            refresh();
          } catch (e) {
            setAuth({ open: true, error: friendlySvnError(e) });
          } finally {
            setBusy(null);
          }
        }}
      />
    </div>
  );
}
