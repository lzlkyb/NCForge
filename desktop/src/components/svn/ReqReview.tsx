/**
 * 版本控制页「按需求审查」视图（按需求审查 P1 · 方案二）。
 *
 * 左栏选需求，右侧把这个需求的文件一页连续往下滚，审完的文件自动折叠。
 * 与「审查改动」读同一份扫描结果、共用同一份已审状态（文件级 + 块级），不会审两遍。
 * 提交、撤销、冲突处理仍在「审查改动」，这里只管审和出包。
 */
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { DockRegion } from "../workspace/WorkbenchDock";
import { Icon } from "../ui/icon";
import { Menu, MenuItem } from "../ui/Menu";
import { toast } from "../ui/toast";
import { ReqFileSection } from "./ReqFileSection";
import { ReqJournalHint } from "./ReqJournalHint";
import { ReqReviewSidebar, UNCLAIMED_ID, pendingBlocks } from "./ReqReviewSidebar";
import { useSvnStatus } from "../../hooks/useSvnStatus";
import { cachedBlocks, useReqBlocks } from "../../hooks/useReqBlocks";
import { markBlocksReviewed } from "../../lib/reviewSession";
import { changedSincePackage, FILE_SOURCE_LABEL, fileSource, groupByRequirement, reqName } from "../../lib/reqGroups";
import { claimFiles, closeRequirement, copyFileList, createRequirement, mergeRequirement, packRequirement, renameRequirement } from "../../lib/reqActions";
import { useRequirements } from "../../lib/requirements";
import { friendlySvnError, isMarkable, keyOf, type ChangeItem } from "../../lib/svn";
import { svnSession, useSvnView } from "../../lib/svnSession";
import { useWorkspaceRoot } from "../../lib/workspaceSession";
import "../../svn-workbench.css";

export function ReqReview({ onOpenFile }: { onOpenFile: (path: string) => void }) {
  const root = useWorkspaceRoot() ?? "";
  return <ReqReviewPanel key={root} root={root} onOpenFile={onOpenFile} />;
}

function ReqReviewPanel({ root, onOpenFile }: { root: string; onOpenFile: (path: string) => void }) {
  const { status, reviewed, mark, refresh } = useSvnStatus();
  const { reqId } = useSvnView(), reqs = useRequirements(), qc = useQueryClient();
  const [onlyNew, setOnlyNew] = useState(false), [marking, setMarking] = useState(false);
  const items = useMemo(() => status.data?.changes.groups.flatMap((g) => g.items).filter((it) => !it.ignored) ?? [], [status.data]);
  const grouping = useMemo(() => groupByRequirement(items, reqs.view), [items, reqs.view]);
  const allGrouped = useMemo(() => grouping.groups.flatMap((g) => g.items), [grouping]);
  const blocks = useReqBlocks(root, allGrouped);
  const active = reqId === UNCLAIMED_ID ? null : grouping.groups.find((g) => g.req.id === reqId) ?? grouping.groups[0] ?? null;
  const selectedId = active?.req.id ?? (grouping.unclaimed.length ? UNCLAIMED_ID : null);
  const files = active ? active.items : selectedId === UNCLAIMED_ID ? grouping.unclaimed : [];
  const isDone = (it: ChangeItem) => { const fb = blocks.get(keyOf(it.path)); return fb && fb.blocks.length ? fb.done === fb.blocks.length : reviewed.has(keyOf(it.path)); };
  const shown = onlyNew ? files.filter((it) => !isDone(it)) : files;
  const openFile = (path: string) => { window.dispatchEvent(new CustomEvent("ncforge-navigate", { detail: "files" })); onOpenFile(path); };
  const markFiles = (targets: ChangeItem[]) => {
    if (marking) return;
    for (const it of targets) markBlocksReviewed(it.path, blocks.get(keyOf(it.path))?.blocks ?? cachedBlocks(qc, root, it), true);
    const todo = targets.filter((it) => isMarkable(it) && !reviewed.has(keyOf(it.path)));
    if (!todo.length) return;
    setMarking(true);
    void Promise.all(todo.map((it) => mark(it.path, it.revision, true))).catch((e) => toast(friendlySvnError(e), "error")).finally(() => setMarking(false));
  };
  const jump = (it: ChangeItem) => document.querySelector(`[data-file-key="${CSS.escape(it.path.toLowerCase())}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
  const { pending } = pendingBlocks(files, blocks, reviewed);
  const since = active ? changedSincePackage(active, reqs.view) : null;
  const openReqs = reqs.view.reqs.filter((r) => r.status === "open");
  return <>
    <DockRegion region="toolbar"><div className="vc-rq-tools">
      <button type="button" className="vc-btn" disabled={status.isFetching} onClick={() => void refresh().catch((e) => toast(friendlySvnError(e), "error"))}><Icon name={status.isFetching ? "spinner" : "refresh"} size={13} className={status.isFetching ? "animate-spin" : undefined} /><span>刷新</span></button>
      <button type="button" className="vc-btn" onClick={() => void createRequirement().then((id) => { if (id) svnSession.set({ reqId: id }); })}><Icon name="plus" size={13} /><span>新建需求</span></button>
    </div></DockRegion>
    <DockRegion region="sidebar"><ReqReviewSidebar grouping={grouping} view={reqs.view} selected={selectedId} blocks={blocks} reviewed={reviewed} onSelect={(id) => svnSession.set({ reqId: id })} /></DockRegion>
    <DockRegion region="document"><div className="vc-rq-doc">
      <ReqJournalHint view={reqs.view} loaded={reqs.loaded} />
      {!selectedId && <div className="vc-empty"><Icon name="check" size={24} /><div>{status.isFetching && !status.data ? "正在扫描工作副本…" : "没有待审的需求改动"}</div></div>}
      {selectedId && <div className="vc-rq-bar-top">
        <span className="vc-rq-name" title={active?.req.name}>{active ? active.req.name : "未认领的改动"}</span>
        <span className="vc-rq-meta">{files.length} 个文件 · {pending ? `待审 ${pending} 块` : "全部审完"}{since !== null ? ` · 出过包${since ? `，之后又改了 ${since} 个文件` : ""}` : ""}</span>
        <span className="vc-sp" />
        <label className="vc-rq-toggle" title="隐藏已经审完的文件；审完后又被改过的文件会重新出现"><input type="checkbox" checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} />只看新改动</label>
        {active && <button type="button" className="vc-btn vc-btn-sm vc-btn-primary" onClick={() => packRequirement(root, active.req, active.items)}><Icon name="package" size={12} /><span>出包…</span></button>}
        <Menu portal width="w-64" trigger={(isOpen, toggle) => <button type="button" className="vc-btn vc-btn-sm" aria-label={active ? "需求操作" : "归入需求"} aria-haspopup="menu" aria-expanded={isOpen} onClick={toggle}><Icon name="more" size={14} /></button>}>
          {close => active ? <>
            <MenuItem label="改名…" hint="如补上清单号" onClick={() => { close(); void renameRequirement(active.req); }} />
            {active.req.mergeHint && <MenuItem label={`并入「${reqName(reqs.view, active.req.mergeHint)}」`} hint="名字很像" onClick={() => { close(); if (active.req.mergeHint) void mergeRequirement(active.req, active.req.mergeHint); }} />}
            <MenuItem label="本需求全部标为已审" disabled={marking} onClick={() => { close(); markFiles(active.items); }} />
            <MenuItem label="复制文件清单" onClick={() => { close(); void copyFileList(active.items); }} />
            <MenuItem label="关闭需求" hint="文件回到未认领" onClick={() => { close(); void closeRequirement(active.req); }} />
          </> : <>
            <MenuItem label={`把全部 ${files.length} 个归入：`} disabled onClick={() => undefined} />
            {openReqs.map((r) => <MenuItem key={r.id} label={r.name} onClick={() => { close(); void claimFiles(files.map((it) => it.path), r.id); }} />)}
            <MenuItem label="＋ 新建需求…" onClick={() => { close(); void claimFiles(files.map((it) => it.path), "new"); }} />
          </>}
        </Menu>
      </div>}
      {files.length > 1 && <div className="vc-rq-chips"><span>跳到：</span>{files.map((it) => {
        const fb = blocks.get(keyOf(it.path)), done = isDone(it);
        return <button key={it.path} type="button" className="vc-chip" data-done={done || undefined} onClick={() => jump(it)}>{done && <Icon name="check" size={11} />}{active?.mixed.has(keyOf(it.path)) && <span className="vc-tag" data-tone="mix">混</span>}{it.rel.split("/").pop()}{fb && !done ? ` · ${fb.done}/${fb.blocks.length}` : ""}</button>;
      })}</div>}
      {onlyNew && files.length > 0 && !shown.length && <div className="vc-empty"><Icon name="check" size={24} /><div>这个需求的改动都审完了</div></div>}
      <div className="vc-rq-stack">
        {shown.map((it) => {
          const mixed = active?.mixed.get(keyOf(it.path)) ?? [];
          return <div key={it.path}>
            {!active && <div className="vc-rq-src"><span className="vc-tag" data-tone="muted">{FILE_SOURCE_LABEL[fileSource(reqs.view, it.path)]}</span></div>}
            <ReqFileSection it={it} root={root} fb={blocks.get(keyOf(it.path))} done={isDone(it)} mixedWith={mixed.map((id) => reqName(reqs.view, id))} disabled={marking} onMark={() => markFiles([it])} onOpenFile={openFile} />
          </div>;
        })}
      </div>
    </div></DockRegion>
  </>;
}
