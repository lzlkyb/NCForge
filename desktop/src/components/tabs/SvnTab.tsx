import { useMemo, useState } from "react";
import "../../svn.css";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { ChangeList } from "../svn/ChangeList";
import { CommitPanel } from "../svn/CommitPanel";
import { RightPane } from "../svn/RightPane";
import { AuthDialog } from "../svn/AuthDialog";
import { SvnToolbar } from "../svn/SvnToolbar";
import { HousekeepingDialog } from "../svn/HousekeepingDialog";
import { useSvnStatus } from "../../hooks/useSvnStatus";
import { useSvnChanges } from "../../hooks/useSvnChanges";
import { svnSession, useSvnView } from "../../lib/svnSession";
import {
  friendlySvnError,
  isMarkable,
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
  // P2-9：选中项 / 右栏视图模式 / 忽略文件显示进模块级仓库——「看 diff →
  // 文件页改代码 → 回来审下一个」的动线不再每次重新找位置。
  const { showIgnored, selectedPath, mode } = useSvnView();
  const [committing, setCommitting] = useState(false);
  const [busy, setBusy] = useState<null | "commit" | "update" | "revert" | "resolve" | "auth">(null);
  const [auth, setAuth] = useState<{ open: boolean; error: string | null }>({ open: false, error: null });
  const [revertOpen, setRevertOpen] = useState(false);
  const [hkOpen, setHkOpen] = useState(false);

  const { info, status, reviewed, mark, refresh, scanProgress } = useSvnStatus();
  const { doUpdate, doCommit, doRevert, doResolve } = useSvnChanges({
    setBusy,
    setAuth,
    refresh,
    onCommitted: () => {
      setCommitting(false);
      svnSession.set({ selectedPath: null });
    },
    onReverted: () => svnSession.set({ selectedPath: null }),
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
  /** 能撤销的只有文件：目录改走递归要连带备份整棵子树，现在只备份文件，见下。 */
  const canRevert = !!selected && !selected.isDir && busy === null;

  const pick = (it: ChangeItem) => {
    svnSession.set({ selectedPath: it.path, mode: "diff" });
    setCommitting(false);
  };

  /**
   * 下一个待审文件：跳过不能再标记的条目（冲突/已删除/目录），从当前项的下一项开始绕一圈。
   *
   * `justMarked` 是刚标记成功的路径：`mark` 虽然写了后端，但本次渲染里的 `reviewed`
   * 还是旧快照，不算上它就会「标记完最后一个未审文件，界面原地不动」。
   */
  const nextTarget = (justMarked: string | null): ChangeItem | null => {
    if (files.length === 0) return null;
    const seen = (p: string) => reviewed.has(keyOf(p)) || p === justMarked;
    const start = selected ? files.findIndex((f) => f.path === selected.path) : -1;
    for (let k = 1; k <= files.length; k += 1) {
      const it = files[(start + k + files.length) % files.length];
      if (isMarkable(it) && !seen(it.path)) return it;
    }
    return null;
  };

  const markAndNext = async () => {
    if (!selected) return;
    // D / ! 文件盘上已经没了（或读不到 metadata），标记必然失败——以前照样弹一句
    // 「读文件信息失败」然后跳走，用户只记住了「报错了」。这里直接说明并跳过。
    if (!isMarkable(selected)) {
      const why =
        selected.isDir ? "目录没有可审的内容" : "这个文件已经不在盘上（已删除/缺失）";
      toast(`${why}，跳过标记`, "info");
      const skipTo = nextTarget(null);
      if (skipTo) {
        svnSession.set({ selectedPath: skipTo.path, mode: "diff" });
      }
      return;
    }
    try {
      // 一律标成已审（不是切换）：这个动作的语义是「看过了，下一个」，
      // 手滑在已审文件上再按一次不该反而把它变回未审。
      // 必须 await：失败就不该跳走（用户会以为标记成功、内容已看过）。
      await mark(selected.path, selected.revision, true);
    } catch (e) {
      toast(`标记失败，没有跳转：${friendlySvnError(e)}`, "error");
      return;
    }
    const next = nextTarget(selected.path);
    if (next) {
      svnSession.set({ selectedPath: next.path, mode: "diff" });
    } else {
      toast("这一轮的文件都审过了", "info");
    }
  };

  const statusError = status.error ? parseSvnError(status.error) : null;
  // 不能拿「改动条数」当版本号兜底：那会在 info 失败时显示成 r12（其实是 12 处改动）
  const rev = info.data?.revision ?? 0;

  return (
    <div className="vc-page">
      <SvnToolbar
        rev={rev}
        url={info.data?.url ?? (info.error ? friendlySvnError(info.error) : null)}
        generatedAtMs={status.data?.generatedAtMs ?? null}
        shown={status.data?.changes.shown ?? null}
        fetching={status.isFetching}
        scanned={scanProgress}
        busy={busy}
        canRevert={canRevert}
        revertTitle={
          !selected
            ? "先在左侧选一个文件"
            : selected.isDir
              ? "目录不能在这里撤销：SVN 只恢复目录节点本身，里面文件的改动不会动"
              : `撤销 ${selected.rel} 的本地改动`
        }
        committable={committable.length}
        conflicts={conflictCount}
        hkOpen={hkOpen}
        onRefresh={() => void refresh()}
        onUpdate={() => void doUpdate()}
        onRevert={() => setRevertOpen(true)}
        onCommit={() => setCommitting(true)}
        onHousekeeping={() => setHkOpen(true)}
      />

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
          // 扫描失败时左栏不能显示「工作副本是干净的」——那是最危险的一句假话
          error={status.error ? friendlySvnError(status.error) : null}
          onSelect={pick}
          showIgnored={showIgnored}
          onToggleIgnored={() => svnSession.set({ showIgnored: !showIgnored })}
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
            onMode={(m) => svnSession.set({ mode: m })}
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
            onLater={() => svnSession.set({ selectedPath: null })}
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
            // 后端会先联网验证再落盘，这里返回成功就是「服务器认这个密码」
            await svnAuthSet(user, password);
            setAuth({ open: false, error: null });
            toast("账号已验证并保存，正在重新扫描", "success");
            void refresh();
          } catch (e) {
            const { code, message } = parseSvnError(e);
            // 这里的失败是「这次输入的密码不对」，不是「缺账号」——
            // 套 friendlySvnError 的 auth 分支会把具体原因换成通用引导
            setAuth({ open: true, error: code === "auth" ? message : friendlySvnError(e) });
          } finally {
            setBusy(null);
          }
        }}
      />

      {/* 备份目录清理 + 失效标记清理；清完重扫一次，让审查进度按新标记重算 */}
      <HousekeepingDialog
        open={hkOpen}
        onClose={() => setHkOpen(false)}
        onPruned={() => void refresh()}
      />
    </div>
  );
}
