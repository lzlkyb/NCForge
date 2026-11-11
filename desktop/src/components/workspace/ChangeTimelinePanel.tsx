import { useState, useSyncExternalStore } from "react";
import {
  clearTimeline, getTimeline, subscribeTimeline, type ChangeEvent, type ChangeKind,
} from "../../lib/changeTimeline";
import { copyReviewNotes, relativeDisplay } from "../../lib/reviewNotes";
import { restoreLocalHistory } from "../../lib/localHistory";
import { recomputeChanged } from "../../lib/changedLinesStore";
import { getSession } from "../../lib/workspaceSession";
import {
  getReviewState, selectRound, setDiffScope, setReviewSelected, setReviewView,
  subscribeReviewSession,
} from "../../lib/reviewSession";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { toast } from "../ui/toast";
import { MultiFileDiffPanel } from "./MultiFileDiffPanel";
import { ReviewChecklist } from "./ReviewChecklist";

const KIND: Record<ChangeKind, { text: string; hint: string }> = {
  me: { text: "我", hint: "本工作台保存" },
  external: { text: "外部", hint: "AI / SVN 更新 / 其他编辑器写入，已排除本人保存" },
  history: { text: "归档", hint: "写盘前自动归档的本地历史版本" },
};

interface ConfirmSpec {
  title: string;
  description: string;
  destructive: boolean;
  confirmLabel: string;
  onConfirm: () => void;
}

/**
 * B1 底部「改动」面板：时间线 ↔ 多文件 diff ↔ 审查清单。
 *
 * 视图 / 勾选 / 比较范围全部存在 reviewSession（P1-8）：切到「问题」页签再回来
 * 不会归零。事件采集由 App 启动时接线，不在这里初始化（P0-2）。
 * 「轮」是主轴：选中一轮后代码面色条收敛到该轮，清单也按该轮范围生成（S9）。
 */
/**
 * 「变更后」快照轮不能直接当轮前基线：`versions` 里存的是改动之后的内容，
 * 拿它当基线色条会一条不画（假「没有改动」）。这里剥掉 versions，让
 * `loadRoundBaseTexts` 退回按归档时间推断（`ts < ev.at` 的最近一版）。
 * `roundBaseline.ts` 是只读参考，不改它，只在前端保证不喂错数据。
 */
function roundBaselineSafe(ev: ChangeEvent): ChangeEvent {
  return ev.post === true ? { ...ev, versions: undefined } : ev;
}

export function ChangeTimelinePanel({
  root, activePath, onOpenAt,
}: {
  root: string;
  activePath?: string | null;
  onOpenAt: (path: string, line: number, push?: boolean, column?: number) => void;
}) {
  const events = useSyncExternalStore(subscribeTimeline, getTimeline, getTimeline);
  const review = useSyncExternalStore(subscribeReviewSession, getReviewState, getReviewState);
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null);

  const allPaths = [...new Set(events.flatMap((e) => e.paths))];
  const compare = (paths: string[], from: ChangeEvent | null, to: ChangeEvent | null = null) => {
    if (!paths.length) { toast("这一轮没有可比较的文件", "info"); return; }
    setDiffScope(paths, from, to);
  };
  const compareSelected = () => {
    const picked = events.filter((e) => review.selected.includes(e.id)).sort((a, b) => a.at - b.at);
    if (picked.length < 2) { toast("先勾选两个时间点", "info"); return; }
    const paths = [...new Set(picked.flatMap((e) => e.paths))];
    compare(paths, picked[0], picked[picked.length - 1]);
  };

  const restoreRound = (ev: ChangeEvent) => {
    const entries = Object.entries(ev.versions ?? {});
    if (!entries.length) { toast("这一轮没有归档点；请从「本地历史」选版本恢复", "info"); return; }
    setConfirm({
      title: "还原这一轮到归档点？",
      description: `会把 ${entries.length} 个文件的磁盘内容覆盖为该归档点，这轮之后的所有改动都会被替换。恢复前后端会自动把当前内容再归档一版；编辑器里未保存的内容不会写进磁盘，请先保存或放弃。`,
      destructive: true,
      confirmLabel: "覆盖并还原",
      onConfirm: () => void (async () => {
        const failed: string[] = [];
        let n = 0;
        for (const [path, id] of entries) {
          const tab = getSession().tabs.find((t) => t.path === path);
          // expectedMtimeMs 只在「内容已加载、mtime 可信」时才给：
          // 重启恢复出来的占位标签 mtimeMs 是 0，拿它当基准后端必判 CONFLICT，
          // 结果是这一轮每个文件都还原失败（后端恢复前仍会先归档当前内容，不会丢）。
          const expected = tab && !tab.deferred && !tab.virtual && tab.mtimeMs > 0 ? tab.mtimeMs : undefined;
          try {
            await restoreLocalHistory(path, id, expected);
            n += 1;
          } catch (e) {
            // 不许静默：用户必须知道哪个文件没还原、为什么（CONFLICT 要给下一步动作）
            const why = String(e).includes("CONFLICT") ? "磁盘被别的途径改过，先刷新再恢复" : String(e);
            failed.push(`${relativeDisplay(path, root)}：${why}`);
          }
        }
        // 只改了工作副本内容，SVN BASE 没变：不能 refreshBaseline，只需让装饰重算
        recomputeChanged();
        if (failed.length) {
          toast(`已还原 ${n}/${entries.length} 个；${failed.length} 个失败：${failed[0]}${failed.length > 1 ? " 等" : ""}`, "warning");
        } else {
          toast(`已还原 ${n}/${entries.length} 个文件到该归档点`, "success");
        }
      })(),
    });
  };

  const copyRound = (ev: ChangeEvent) => {
    void copyReviewNotes(
      ev.paths.map((p) => ({ path: p, line: 1, text: `${KIND[ev.kind].text}改动：${relativeDisplay(p, root)}`, comment: KIND[ev.kind].hint })),
      root,
    ).then((ok) => toast(ok ? "已复制这一轮文件清单（带 file:line）" : "复制失败", ok ? "info" : "error"));
  };

  const clearAll = () => setConfirm({
    title: "清空改动时间线？",
    description: "只清内存中的事件记录，磁盘文件、SVN 状态与本地历史都不受影响。",
    destructive: false,
    confirmLabel: "清空记录",
    onConfirm: () => { clearTimeline(); setReviewSelected([]); void selectRound(null); },
  });

  return (
    <div className="ncf-timeline">
      <div className="ncf-tl-bar">
        <button type="button" className="ncf-link" data-on={review.view === "timeline" || undefined} onClick={() => setReviewView("timeline")}>改动时间线</button>
        <button type="button" className="ncf-link" data-on={review.view === "checklist" || undefined} onClick={() => setReviewView("checklist")}>审查清单</button>
        <span className="ncf-tl-sp" />
        <span className="ncf-tl-count">{events.length} 轮 · {allPaths.length} 个文件</span>
        {review.round && <span className="ncf-tl-count">已选：{review.round.label ?? "一轮"}</span>}
        {review.view === "timeline" && (
          <>
            <button type="button" className="ncf-link" onClick={compareSelected} title="按本地历史归档点比较两个时间点；无归档点会明确提示退化">比较选中两点</button>
            <button type="button" className="ncf-link" onClick={clearAll}>清空</button>
          </>
        )}
      </div>

      {review.view === "diff" && (
        <MultiFileDiffPanel paths={review.diffPaths} root={root}
          startEvent={review.startEvent} endEvent={review.endEvent}
          onBack={() => setReviewView("timeline")} />
      )}
      {review.view === "checklist" && (
        <ReviewChecklist root={root} activePath={activePath} round={review.round} onOpenAt={onOpenAt} />
      )}
      {review.view === "timeline" && (
        <div className="ncf-tl-list">
          {events.length === 0 && (
            <div className="ncf-empty">还没有改动记录。保存文件、或外部程序（AI / SVN 更新 / 别的编辑器）改动工作区里的文件后，这里会按「轮」记下来；启动时也会从本地历史回填最近一次归档点。</div>
          )}
          {events.map((ev) => (
            <div key={ev.id} className="ncf-ev" data-kind={ev.kind} data-on={review.round?.id === ev.id || undefined}>
              <input type="checkbox" checked={review.selected.includes(ev.id)} aria-label="选中这个时间点"
                onChange={(e) => setReviewSelected(e.target.checked
                  ? [...review.selected, ev.id]
                  : review.selected.filter((x) => x !== ev.id))} />
              <span className="ncf-kind" title={KIND[ev.kind].hint}>{KIND[ev.kind].text}</span>
              {ev.post === true && (
                <span className="ncf-kind" title="归档点是「变更后」快照（兜底归档 / 切页归档 / 启动回填取的都是磁盘现状），不能当轮前基线：选它做基线会退化成按归档时间推断，比较时直接退化为 SVN 基线">变更后</span>
              )}
              <time dateTime={new Date(ev.at).toISOString()}>
                {new Date(ev.at).toLocaleTimeString("zh-CN", { hour12: false })}
              </time>
              <span className="ncf-ev-files" title={ev.paths.join("\n")}>
                {ev.paths.length} 个文件 · {ev.paths.slice(0, 2).map((p) => relativeDisplay(p, root)).join("、")}{ev.paths.length > 2 ? " 等" : ""}
              </span>
              <span className="ncf-ev-actions">
                <button type="button" className="ncf-link" data-on={review.round?.id === ev.id || undefined}
                  title="选中这一轮：代码面色条只看这轮改动"
                  onClick={() => void selectRound(review.round?.id === ev.id ? null : roundBaselineSafe(ev))}>
                  {review.round?.id === ev.id ? "取消选轮" : "选这一轮"}
                </button>
                <button type="button" className="ncf-link" onClick={() => compare(ev.paths, ev.kind === "history" && ev.post !== true ? ev : null)}>比较</button>
                <button type="button" className="ncf-link" onClick={() => copyRound(ev)}>复制给 Claude</button>
                <button type="button" className="ncf-link" onClick={() => restoreRound(ev)}>还原本轮</button>
                {ev.paths[0] && <button type="button" className="ncf-link" onClick={() => onOpenAt(ev.paths[0], 1)}>打开</button>}
              </span>
            </div>
          ))}
        </div>
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          description={confirm.description}
          variant={confirm.destructive ? "destructive" : "default"}
          confirmLabel={confirm.confirmLabel}
          onCancel={() => setConfirm(null)}
          onConfirm={() => { const fn = confirm.onConfirm; setConfirm(null); fn(); }}
        />
      )}
    </div>
  );
}
