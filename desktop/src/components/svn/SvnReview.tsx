import { useEffect, useMemo, useRef, useState } from "react";
import { DockRegion, useWorkbenchDock } from "../workspace/WorkbenchDock";
import { isReviewOutdated } from "../../lib/reviewMarks";
import { toast } from "../ui/toast";
import { ChangeList } from "./ChangeList";
import { CommitPanel } from "./CommitPanel";
import { SvnTaskFeedback } from "./SvnTaskFeedback";
import { RightPane } from "./RightPane";
import { SvnToolbar } from "./SvnToolbar";
import { SvnReviewFiles } from "./SvnReviewFiles";
import { SVN_COMMIT_DRAWER_MIN_WIDTH, SvnCommitDrawer } from "./SvnCommitDrawer";
import { SvnCommitOutcome } from "./SvnCommitOutcome";
import { SvnScanNotice } from "./SvnScanNotice";
import { SvnRemote } from "./SvnRemote";
import { HistoryView } from "./HistoryView";
import { SvnReviewDialogs, type SvnAuth, type SvnBusy } from "./SvnReviewDialogs";
import { useSvnStatus } from "../../hooks/useSvnStatus";
import { useSvnChanges } from "../../hooks/useSvnChanges";
import { openSvnChange, svnSession, useSvnView } from "../../lib/svnSession";
import { friendlySvnError, isMarkable, keyOf, type ChangeItem } from "../../lib/svn";
import { getSession, useWorkspaceRoot } from "../../lib/workspaceSession";
import { nextSvnUnreviewed, svnVisibleGroups } from "../../lib/svnList";
import { setSvnListPrefs, useSvnListPrefs } from "../../lib/svnListPrefs";
import { isSvnCommittable, isSvnPicked, selectSvnPaths, syncSvnDraft, useSvnDraft } from "../../lib/svnDraft";
import { workspaceEpoch } from "../../lib/workspaceEpoch";
import { setSideOpen } from "../../lib/layoutStore";
import { useQueryClient } from "@tanstack/react-query";
import { isBlockReviewed, markBlocksReviewed } from "../../lib/reviewSession";
import { blocksForReq, inScope } from "../../lib/blockState";
import { fileIndex } from "../../lib/reqGroups";
import { getRequirements } from "../../lib/requirements";
import { cachedBlocks, type FileBlocks } from "../../hooks/useReqBlocks";
import { Icon } from "../ui/icon";
import { previewWorkingPatch } from "../../lib/reqActions";
import type { ChangedBlock } from "../../lib/changedLines";

/** 文件级已审只在全部块都审完时才标：混改文件在另一个需求下还有没审的块。取不到块时按文件算。 */
const allBlocksDone = (path: string, blocks: readonly ChangedBlock[]) => blocks.every(b => isBlockReviewed(path, b));
import "../../svn-workbench.css";

export function SvnReview({ onOpenFile }: { onOpenFile: (path: string) => void }) {
  const root = useWorkspaceRoot() ?? "";
  return <SvnReviewPanel key={root} root={root} onOpenFile={onOpenFile} />;
}
function SvnReviewPanel({ root, onOpenFile }: { root: string; onOpenFile: (path: string) => void }) {
  const dock = useWorkbenchDock(), workarea = useRef<HTMLDivElement>(null);
  const {page,showIgnored,selectedPath,mode,commitOpen,changeIntent,historyRevision} = useSvnView();
  const prefs = useSvnListPrefs(root), draft = useSvnDraft(root);
  const [busy,setBusy] = useState<SvnBusy>(null), [auth,setAuth] = useState<SvnAuth>({open:false,error:null});
  const [revertTarget,setRevertTarget] = useState<ChangeItem | null>(null), [hkOpen,setHkOpen] = useState(false), [marking,setMarking] = useState(false);
  const markLock = useRef(false), qc = useQueryClient();
  const [focused,setFocused] = useState(false);
  const {info,status,reviewed,mark,refresh,scanProgress,streamed} = useSvnStatus();
  const clearAffectedSelection = (paths: readonly string[]) => {
    const path = svnSession.get().selectedPath;
    if (path && paths.some(item => keyOf(item) === keyOf(path))) svnSession.set({selectedPath:null});
  };
  const {doUpdate,doCommit,doRevert,doResolve,writeBusy} = useSvnChanges({
    setBusy,setAuth,refresh,
    onCommitted:paths => { svnSession.set({commitOpen:false}); clearAffectedSelection(paths); },
    onReverted:clearAffectedSelection,
  });
  // 流式上屏：扫描途中的已扫条目优先显示，最终结果一到整份换掉（后端排好的序）。
  // items（提交面板/草稿/冲突计数的依据）仍然只取最终结果——流式数据绝不进写路径。
  const view = streamed ?? status.data?.changes ?? {groups:[],shown:0,total:0,ignored:0};
  const items = useMemo(() => status.data?.changes.groups.flatMap(g => g.items) ?? [],[status.data]);
  // 首扫期间列表里已经有文件了：选中回退查流式条目，点开就能看 diff
  // （diff 是单文件请求，不依赖整轮扫描的结论）。
  const streamedItems = useMemo(() => streamed?.groups.flatMap(g => g.items) ?? [],[streamed]);
  useEffect(() => {
    if (root && status.data && !status.error && !changeIntent) syncSvnDraft(root,items);
  }, [root,items,status.data,status.error,changeIntent]);
  const selected = items.find(it => selectedPath && keyOf(it.path) === keyOf(selectedPath)) ?? streamedItems.find(it => selectedPath && keyOf(it.path) === keyOf(selectedPath)) ?? null;
  const eligible = items.filter(isSvnCommittable), pickedCount = eligible.filter(it => isSvnPicked(draft.picked,it.path)).length;
  const locked = !!writeBusy || busy !== null, selectionLocked = locked || !!draft.unknown;
  useEffect(() => {
    if (!root || !changeIntent || !status.data || status.isFetching || status.error) return;
    syncSvnDraft(root,items);
    const target = items.find(item => keyOf(item.path) === keyOf(changeIntent.path) && !item.ignored);
    svnSession.set({changeIntent:null});
    if (!target) {
      svnSession.set({selectedPath:null});
      toast("此文件当前没有可查看的 SVN 改动", "info");
      return;
    }
    const reqs = getRequirements().view;
    const reqIds = fileIndex(reqs).get(keyOf(target.path))?.reqs.filter(id => reqs.reqs.some(req => req.id === id && req.status === "open")) ?? [];
    const targetGroups = new Set([target.module,...(reqIds.length ? reqIds : ["-"]).map(id => "req:" + id)]);
    setSvnListPrefs(root, {
      search:"",
      filter:changeIntent.action === "conflict" && target.letter === "C" ? "conflict" : "all",
      closed:prefs.closed.filter(group => !targetGroups.has(group)),
    });
    svnSession.set({selectedReq:reqIds[0] ?? "-"});
    if (changeIntent.action !== "commit") return;
    if (selectionLocked) {
      toast("当前提交草稿暂不可更改，请先完成正在进行的操作", "warning");
      return;
    }
    if (!isSvnCommittable(target)) {
      toast("此文件当前无法加入提交，请查看文件状态", "warning");
      return;
    }
    selectSvnPaths(root,[...draft.picked,target.path]);
    svnSession.set({commitOpen:true});
  }, [changeIntent,status.data,status.isFetching,status.error,selectionLocked,items,root,prefs.closed,draft.picked]);
  const outdated = useMemo(() => {
    const paths = new Set<string>();
    for (const item of items) {
      const key = keyOf(item.path);
      if (!reviewed.has(key) && isReviewOutdated(item.path)) paths.add(key);
    }
    return paths;
  }, [items, reviewed]);
  const queue = svnVisibleGroups(view,prefs.filter,prefs.search,prefs.sort,showIgnored,reviewed,draft.picked,outdated).filter(g => prefs.groupBy === "req" || !prefs.closed.includes(g.module)).flatMap(g => g.items);
  const openFile = (path: string) => {
    // 不能只 showCode()：那会把代码面露出来却不变 activeTab，SVN 工具条、
    // 变更列表侧栏与文件页状态栏混屏，文档标签随 surface hidden 后根本没有
    // 入口回到 SVN 文档面（P1-19）。与 MetaGenerate 一致，显式导航到文件页。
    window.dispatchEvent(new CustomEvent("ncforge-navigate", { detail: "files" }));
    onOpenFile(path);
  };
  const pick = (it: ChangeItem) => { dock?.showDocument(); svnSession.set({selectedPath:it.path,mode:"diff",changeIntent:null}); if (window.matchMedia?.("(max-width:640px)").matches) setSideOpen(false); };
  const refreshNow = () => { void refresh().catch(error => toast(friendlySvnError(error),"error")); };
  const showHistory = (revision?: number) => { svnSession.set({page:"history",historyRevision:revision ?? null}); dock?.showDocument(); };
  const closeCommit = () => { svnSession.set({commitOpen:false}); document.querySelector<HTMLButtonElement>("[data-commit-trigger]")?.focus(); };
  const reviewCommitFile = (item: ChangeItem) => {
    pick(item);
    if ((workarea.current?.clientWidth ?? 0) < SVN_COMMIT_DRAWER_MIN_WIDTH) svnSession.set({ commitOpen: false });
  };
  const nextConflict = () => {
    if (getSession().root !== root || svnSession.get().page !== "review" || svnSession.get().selectedPath !== selectedPath) return;
    const paths = items.filter(item => item.letter === "C" && keyOf(item.path) !== keyOf(selectedPath ?? ""));
    if (paths.length) {
      openSvnChange(paths[0].path,"conflict");
    } else {
      svnSession.set({selectedPath:null});
    }
  };
  const markAndNext = async () => {
    if (!selected || !isMarkable(selected) || markLock.current || locked) return;
    const epoch = workspaceEpoch(), path = selected.path, visible = [...queue];
    markLock.current = true; setMarking(true);
    try {
      // 按需求分组时只标「从哪个需求组点开的」那个需求的块（设计稿拍板 4），块级标记落盘、重启不丢。
      const all = cachedBlocks(qc,root,selected), ctx = prefs.groupBy === "req" ? svnSession.get().selectedReq : null;
      markBlocksReviewed(path,blocksForReq(path,all,ctx,fileIndex(getRequirements().view).get(keyOf(path))),true);
      if (allBlocksDone(path,all)) await mark(path,selected.revision,true);
      if (getSession().root !== root || workspaceEpoch() !== epoch || svnSession.get().selectedPath !== path) return;
      const next = nextSvnUnreviewed(visible,path,reviewed,path);
      if (next) svnSession.set({selectedPath:next.path,mode:"diff"});
      else toast("当前筛选中没有下一项待审文件","success");
    } catch (error) { toast(`标记失败，仍保留当前文件：${friendlySvnError(error)}`,"error"); }
    finally { markLock.current = false; setMarking(false); }
  };
  const markReqAll = (reqId: string, reqItems: ChangeItem[], blocks: Map<string, FileBlocks>) => {
    if (locked || markLock.current) return;
    for (const it of reqItems) {
      const fb = blocks.get(keyOf(it.path));
      markBlocksReviewed(it.path,fb ? fb.infos.filter(info => inScope(info,reqId)).map(info => info.block) : cachedBlocks(qc,root,it),true);
    }
    const todo = reqItems.filter(it => isMarkable(it) && !reviewed.has(keyOf(it.path)) && allBlocksDone(it.path,blocks.get(keyOf(it.path))?.blocks ?? []));
    markLock.current = true; setMarking(true);
    // 计数用 todo.length：reqItems 里含已审 / 不可标记 / 块未审完的文件，上面已过滤掉，
    // 拿 reqItems.length 报数会虚高（说「已标记 8 个」实际只标了 3 个）。
    void Promise.all(todo.map(it => mark(it.path,it.revision,true))).then(() => toast(`已标记 ${todo.length} 个文件为已审`,"success")).catch(error => toast(friendlySvnError(error),"error")).finally(() => { markLock.current = false; setMarking(false); });
  };
  const toggleReviewed = () => {
    if (!selected || !isMarkable(selected) || locked || markLock.current) return;
    markLock.current = true; setMarking(true);
    void mark(selected.path,selected.revision,!reviewed.has(keyOf(selected.path))).catch(error => toast(friendlySvnError(error),"error")).finally(() => { markLock.current = false; setMarking(false); });
  };
  const dialogs = <SvnReviewDialogs revertTarget={revertTarget} setRevertTarget={setRevertTarget} onRevert={doRevert} auth={auth} setAuth={setAuth} info={info.data} busy={busy} setBusy={setBusy} hkOpen={hkOpen} setHkOpen={setHkOpen} refresh={refresh} />;
  const conflictPaths = status.data && !status.error ? items.filter(item => item.letter === "C").map(item => item.path) : null;
  if (page === "remote") return <>
    <SvnRemote root={root} info={info.data} busy={writeBusy?.kind ?? busy} conflicts={conflictPaths} update={doUpdate} onConflict={path => openSvnChange(path,"conflict")} onHistory={showHistory} onRefresh={() => refresh(true)} onAuth={() => setAuth({open:true,error:null})}/>
    {dialogs}
  </>;
  if (page === "history") return <>
    <DockRegion region="document">{root ? <HistoryView key={`${root}:${historyRevision}`} path={root} title="工作副本" initialRevision={historyRevision ?? undefined} onBack={() => svnSession.set({page:"review"})}/> : <div className="vc-empty">打开 SVN 工作副本后可以查看版本历史。</div>}</DockRegion>
    {dialogs}
  </>;
  const waitingFile = changeIntent?.path.split(/[\\/]/).pop();
  const hiddenSelection = selected && !queue.some(item => keyOf(item.path) === keyOf(selected.path));
  return <>
    <DockRegion region="toolbar"><SvnToolbar rev={info.data?.revision ?? 0} info={info.data} url={info.data?.url ?? null} generatedAtMs={status.data?.generatedAtMs ?? null} shown={(streamed ?? status.data?.changes)?.shown ?? null} fetching={status.isFetching} busy={writeBusy?.kind ?? busy} canRevert={!!selected && !selected.isDir && !locked} revertTitle={selected ? `备份并撤销 ${selected.rel}` : "先选择文件"} committable={eligible.length} pickedCount={pickedCount} conflicts={conflictPaths?.length ?? 0} hkOpen={hkOpen} onRefresh={refreshNow} onUpdate={() => {svnSession.set({page:"remote"});dock?.showDocument();}} onRevert={() => setRevertTarget(selected)} onCommit={() => { svnSession.set({commitOpen:!commitOpen}); dock?.showDocument(); }} onHousekeeping={() => setHkOpen(true)} onFiles={() => setSideOpen(true)} /></DockRegion>
    <DockRegion region="sidebar"><ChangeList view={view} root={root} reviewed={reviewed} outdated={outdated} picked={draft.picked} busy={selectionLocked} selected={selectedPath} loading={status.isFetching} error={status.error ? friendlySvnError(status.error) : null} onSelect={pick} onOpenFile={openFile} showIgnored={showIgnored} onToggleIgnored={() => svnSession.set({showIgnored:!showIgnored})} onMarkReqAll={markReqAll} /></DockRegion>
    <DockRegion region="document"><div className="vc-review-document" data-focus={focused || undefined}>
      {focused && <div className="vc-focus-bar"><SvnReviewFiles items={queue} selected={selectedPath} onSelect={pick}/><button type="button" className="vc-btn vc-btn-sm vc-focus-exit" onClick={()=>{setFocused(false);requestAnimationFrame(()=>workarea.current?.querySelector<HTMLButtonElement>('[aria-label="专注对比"]')?.focus());}}>退出专注对比</button></div>}
      <SvnTaskFeedback root={root} fetching={status.isFetching} scanned={scanProgress} busy={writeBusy?.kind ?? busy} startedAt={writeBusy?.startedAt} hasPrevious={!!status.data} />
      <SvnScanNotice error={status.error} fetching={status.isFetching} onAuth={() => setAuth({open:true,error:null})} onRefresh={refreshNow} />
      {waitingFile && <div className="vc-alert" role="status" data-tone={status.error ? "warn" : "info"}><Icon name="info" size={14}/><span>{status.error ? "重新扫描后继续定位" : changeIntent?.action === "commit" ? "正在确认提交状态" : "正在定位"} · {waitingFile}</span><button className="vc-btn vc-btn-sm" type="button" onClick={() => svnSession.set({changeIntent:null})}>取消定位</button></div>}
      {hiddenSelection && !changeIntent && <div className="vc-alert" data-tone="info"><span>当前文件不在清单的可见范围内。</span><button className="vc-btn vc-btn-sm" type="button" onClick={() => openSvnChange(selected.path,selected.letter === "C" ? "conflict" : "review")}>显示并定位</button></div>}
      <SvnCommitOutcome root={root} onHistory={showHistory} onRefresh={refreshNow} />
      <div className="vc-review-workarea" ref={workarea}>
        <div className="vc-review-main"><RightPane file={selected} mode={mode} onMode={next => svnSession.set({mode:next})} reviewed={selected ? reviewed.has(keyOf(selected.path)) : false} busy={locked} disabled={locked || marking} focused={focused} onFocus={()=>{setFocused(true);requestAnimationFrame(()=>workarea.current?.parentElement?.querySelector<HTMLButtonElement>('.vc-focus-exit')?.focus());}} onToggleReviewed={toggleReviewed} onOpenFile={openFile} onPrepareNew={root && selected && isSvnCommittable(selected) && !selectionLocked ? () => { selectSvnPaths(root, [...draft.picked, selected.path]); svnSession.set({commitOpen:true}); } : undefined} onMarkAndNext={markAndNext} onResolve={choice => selected && void doResolve(selected.path,choice)} onLater={nextConflict} /></div>
        <SvnCommitDrawer host={workarea} open={commitOpen} onClose={closeCommit}><CommitPanel items={items} root={root} reviewed={reviewed} outdated={outdated} busy={locked} onSubmit={(message,paths) => { void doCommit(message,paths); }} onCancel={closeCommit} onSelect={reviewCommitFile} onPatch={paths => void previewWorkingPatch(root,paths)} /></SvnCommitDrawer>
      </div>
    </div></DockRegion>
    {dialogs}
  </>;
}
