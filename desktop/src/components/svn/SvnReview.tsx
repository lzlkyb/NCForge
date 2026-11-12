import { useEffect, useMemo, useRef, useState } from "react";
import { DockRegion, useWorkbenchDock } from "../workspace/WorkbenchDock";
import { isReviewOutdated } from "../../lib/reviewMarks";
import { toast } from "../ui/toast";
import { ChangeList } from "./ChangeList";
import { CommitPanel } from "./CommitPanel";
import { RightPane } from "./RightPane";
import { SvnToolbar } from "./SvnToolbar";
import { SvnReviewFiles } from "./SvnReviewFiles";
import { SVN_COMMIT_DRAWER_MIN_WIDTH, SvnCommitDrawer } from "./SvnCommitDrawer";
import { SvnCommitOutcome } from "./SvnCommitOutcome";
import { SvnScanNotice } from "./SvnScanNotice";
import { SvnReviewDialogs, type SvnAuth, type SvnBusy } from "./SvnReviewDialogs";
import { useSvnStatus } from "../../hooks/useSvnStatus";
import { useSvnChanges } from "../../hooks/useSvnChanges";
import { svnSession, useSvnView } from "../../lib/svnSession";
import { friendlySvnError, isMarkable, keyOf, type ChangeItem } from "../../lib/svn";
import { getSession, useWorkspaceRoot } from "../../lib/workspaceSession";
import { nextSvnUnreviewed, svnVisibleGroups } from "../../lib/svnList";
import { setSvnListPrefs, useSvnListPrefs } from "../../lib/svnListPrefs";
import { isSvnCommittable, isSvnPicked, selectSvnPaths, syncSvnDraft, useSvnDraft } from "../../lib/svnDraft";
import { workspaceEpoch } from "../../lib/workspaceEpoch";
import { setSideOpen } from "../../lib/layoutStore";
import { useQueryClient } from "@tanstack/react-query";
import { markBlocksReviewed } from "../../lib/reviewSession";
import { cachedBlocks, type FileBlocks } from "../../hooks/useReqBlocks";
import "../../svn-workbench.css";

export function SvnReview({ onOpenFile }: { onOpenFile: (path: string) => void }) {
  const root = useWorkspaceRoot() ?? "";
  return <SvnReviewPanel key={root} root={root} onOpenFile={onOpenFile} />;
}
function SvnReviewPanel({ root, onOpenFile }: { root: string; onOpenFile: (path: string) => void }) {
  const dock = useWorkbenchDock(), workarea = useRef<HTMLDivElement>(null);
  const {showIgnored,selectedPath,mode,commitOpen,changeIntent} = useSvnView();
  const prefs = useSvnListPrefs(root), draft = useSvnDraft(root);
  const [busy,setBusy] = useState<SvnBusy>(null), [auth,setAuth] = useState<SvnAuth>({open:false,error:null});
  const [revertTarget,setRevertTarget] = useState<ChangeItem | null>(null), [hkOpen,setHkOpen] = useState(false), [marking,setMarking] = useState(false);
  const markLock = useRef(false), qc = useQueryClient();
  const [focused,setFocused] = useState(false);
  const {info,status,reviewed,mark,refresh,scanProgress,streamed} = useSvnStatus();
  const {doUpdate,doCommit,doRevert,doResolve,writeBusy} = useSvnChanges({setBusy,setAuth,refresh,onCommitted:() => svnSession.set({commitOpen:false,selectedPath:null}),onReverted:() => svnSession.set({selectedPath:null})});
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
    setSvnListPrefs(root, {
      search:"",
      filter:changeIntent.action === "conflict" && target.letter === "C" ? "conflict" : "all",
      closed:prefs.closed.filter(module => module !== target.module),
    });
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
  const queue = svnVisibleGroups(view,prefs.filter,prefs.search,prefs.sort,showIgnored,reviewed,draft.picked,outdated).filter(g => !prefs.closed.includes(g.module)).flatMap(g => g.items);
  const openFile = (path: string) => {
    // 不能只 showCode()：那会把代码面露出来却不变 activeTab，SVN 工具条、
    // 变更列表侧栏与文件页状态栏混屏，文档标签随 surface hidden 后根本没有
    // 入口回到 SVN 文档面（P1-19）。与 MetaGenerate 一致，显式导航到文件页。
    window.dispatchEvent(new CustomEvent("ncforge-navigate", { detail: "files" }));
    onOpenFile(path);
  };
  const pick = (it: ChangeItem) => { dock?.showDocument(); svnSession.set({selectedPath:it.path,mode:"diff",changeIntent:null}); if (window.matchMedia?.("(max-width:640px)").matches) setSideOpen(false); };
  const refreshNow = () => { void refresh().catch(error => toast(friendlySvnError(error),"error")); };
  const showHistory = () => { svnSession.set({mode:"log",selectedPath:null}); dock?.showDocument(); };
  const closeCommit = () => { svnSession.set({commitOpen:false}); document.querySelector<HTMLButtonElement>("[data-commit-trigger]")?.focus(); };
  const reviewCommitFile = (item: ChangeItem) => {
    pick(item);
    if ((workarea.current?.clientWidth ?? 0) < SVN_COMMIT_DRAWER_MIN_WIDTH) svnSession.set({ commitOpen: false });
  };
  const markAndNext = async () => {
    if (!selected || !isMarkable(selected) || markLock.current || locked) return;
    const epoch = workspaceEpoch(), path = selected.path, visible = [...queue];
    markLock.current = true; setMarking(true);
    try {
      // P1：整个文件的块一起标（混改文件里按需求分块是 P2），块级标记落盘、重启不丢。
      markBlocksReviewed(path,cachedBlocks(qc,root,selected),true);
      await mark(path,selected.revision,true);
      if (getSession().root !== root || workspaceEpoch() !== epoch || svnSession.get().selectedPath !== path) return;
      const next = nextSvnUnreviewed(visible,path,reviewed,path);
      if (next) svnSession.set({selectedPath:next.path,mode:"diff"});
      else toast("当前筛选中没有下一项待审文件","success");
    } catch (error) { toast(`标记失败，仍保留当前文件：${friendlySvnError(error)}`,"error"); }
    finally { markLock.current = false; setMarking(false); }
  };
  const markReqAll = (reqItems: ChangeItem[], blocks: Map<string, FileBlocks>) => {
    if (locked || markLock.current) return;
    const todo = reqItems.filter(it => isMarkable(it) && !reviewed.has(keyOf(it.path)));
    for (const it of reqItems) markBlocksReviewed(it.path,blocks.get(keyOf(it.path))?.blocks ?? cachedBlocks(qc,root,it),true);
    markLock.current = true; setMarking(true);
    void Promise.all(todo.map(it => mark(it.path,it.revision,true))).then(() => toast(`已标记 ${reqItems.length} 个文件为已审`,"success")).catch(error => toast(friendlySvnError(error),"error")).finally(() => { markLock.current = false; setMarking(false); });
  };
  const toggleReviewed = () => {
    if (!selected || !isMarkable(selected) || locked || markLock.current) return;
    markLock.current = true; setMarking(true);
    void mark(selected.path,selected.revision,!reviewed.has(keyOf(selected.path))).catch(error => toast(friendlySvnError(error),"error")).finally(() => { markLock.current = false; setMarking(false); });
  };
  return <>
    <DockRegion region="toolbar"><SvnToolbar rev={info.data?.revision ?? 0} info={info.data} url={info.data?.url ?? null} generatedAtMs={status.data?.generatedAtMs ?? null} shown={(streamed ?? status.data?.changes)?.shown ?? null} fetching={status.isFetching} scanned={scanProgress} busy={writeBusy?.kind ?? busy} canRevert={!!selected && !selected.isDir && !locked} revertTitle={selected ? `备份并撤销 ${selected.rel}` : "先选择文件"} committable={eligible.length} pickedCount={pickedCount} conflicts={items.filter(it => it.letter === "C").length} hkOpen={hkOpen} onRefresh={refreshNow} onUpdate={() => void doUpdate()} onRevert={() => setRevertTarget(selected)} onCommit={() => { svnSession.set({commitOpen:!commitOpen}); dock?.showDocument(); }} onHousekeeping={() => setHkOpen(true)} onHistory={showHistory} onFiles={() => setSideOpen(true)} /></DockRegion>
    <DockRegion region="sidebar"><ChangeList view={view} root={root} reviewed={reviewed} outdated={outdated} picked={draft.picked} busy={selectionLocked} selected={selectedPath} loading={status.isFetching} error={status.error ? friendlySvnError(status.error) : null} onSelect={pick} onOpenFile={openFile} showIgnored={showIgnored} onToggleIgnored={() => svnSession.set({showIgnored:!showIgnored})} onMarkReqAll={markReqAll} /></DockRegion>
    <DockRegion region="document"><div className="vc-review-document" data-focus={focused || undefined}>
      {focused && <div className="vc-focus-bar"><SvnReviewFiles items={queue} selected={selectedPath} onSelect={pick}/><button type="button" className="vc-btn vc-btn-sm vc-focus-exit" onClick={()=>{setFocused(false);requestAnimationFrame(()=>workarea.current?.querySelector<HTMLButtonElement>('[aria-label="专注对比"]')?.focus());}}>退出专注对比</button></div>}
      <SvnScanNotice error={status.error} fetching={status.isFetching} onAuth={() => setAuth({open:true,error:null})} onRefresh={refreshNow} />
      <SvnCommitOutcome root={root} onHistory={showHistory} onRefresh={refreshNow} />
      <div className="vc-review-workarea" ref={workarea}>
        <div className="vc-review-main"><RightPane file={selected} mode={mode} onMode={next => svnSession.set({mode:next})} reviewed={selected ? reviewed.has(keyOf(selected.path)) : false} busy={locked} disabled={locked || marking} focused={focused} onFocus={()=>{setFocused(true);requestAnimationFrame(()=>workarea.current?.parentElement?.querySelector<HTMLButtonElement>('.vc-focus-exit')?.focus());}} onToggleReviewed={toggleReviewed} onOpenFile={openFile} onPrepareNew={root && selected && isSvnCommittable(selected) && !selectionLocked ? () => { selectSvnPaths(root, [...draft.picked, selected.path]); svnSession.set({commitOpen:true}); } : undefined} onMarkAndNext={markAndNext} onResolve={choice => selected && void doResolve(selected.path,choice)} onLater={() => svnSession.set({selectedPath:null})} /></div>
        <SvnCommitDrawer host={workarea} open={commitOpen} onClose={closeCommit}><CommitPanel items={items} root={root} reviewed={reviewed} outdated={outdated} busy={locked} onSubmit={(message,paths) => { void doCommit(message,paths); }} onCancel={closeCommit} onSelect={reviewCommitFile} /></SvnCommitDrawer>
      </div>
    </div></DockRegion>
    <SvnReviewDialogs revertTarget={revertTarget} setRevertTarget={setRevertTarget} onRevert={doRevert} auth={auth} setAuth={setAuth} info={info.data} busy={busy} setBusy={setBusy} hkOpen={hkOpen} setHkOpen={setHkOpen} refresh={refresh} />
  </>;
}
