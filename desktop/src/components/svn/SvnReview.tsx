import { useEffect, useMemo, useRef, useState } from "react";
import { DockRegion, useWorkbenchDock } from "../workspace/WorkbenchDock";
import { toast } from "../ui/toast";
import { ChangeList } from "./ChangeList";
import { CommitPanel } from "./CommitPanel";
import { RightPane } from "./RightPane";
import { SvnToolbar } from "./SvnToolbar";
import { SvnCommitDrawer } from "./SvnCommitDrawer";
import { SvnCommitOutcome } from "./SvnCommitOutcome";
import { SvnScanNotice } from "./SvnScanNotice";
import { SvnReviewDialogs, type SvnAuth, type SvnBusy } from "./SvnReviewDialogs";
import { useSvnStatus } from "../../hooks/useSvnStatus";
import { useSvnChanges } from "../../hooks/useSvnChanges";
import { svnSession, useSvnView } from "../../lib/svnSession";
import { friendlySvnError, isMarkable, keyOf, type ChangeItem } from "../../lib/svn";
import { getSession, useWorkspaceRoot } from "../../lib/workspaceSession";
import { nextSvnUnreviewed, svnVisibleGroups } from "../../lib/svnList";
import { useSvnListPrefs } from "../../lib/svnListPrefs";
import { isSvnCommittable, isSvnPicked, syncSvnDraft, toggleSvnPicked, useSvnDraft } from "../../lib/svnDraft";
import { workspaceEpoch } from "../../lib/workspaceEpoch";
import { setSideOpen } from "../../lib/layoutStore";
import "../../svn-workbench.css";

export function SvnReview({ onOpenFile }: { onOpenFile: (path: string) => void }) {
  const root = useWorkspaceRoot() ?? "";
  return <SvnReviewPanel key={root} root={root} onOpenFile={onOpenFile} />;
}
function SvnReviewPanel({ root, onOpenFile }: { root: string; onOpenFile: (path: string) => void }) {
  const dock = useWorkbenchDock(), workarea = useRef<HTMLDivElement>(null);
  const {showIgnored,selectedPath,mode,commitOpen} = useSvnView();
  const prefs = useSvnListPrefs(root), draft = useSvnDraft(root);
  const [busy,setBusy] = useState<SvnBusy>(null), [auth,setAuth] = useState<SvnAuth>({open:false,error:null});
  const [revertTarget,setRevertTarget] = useState<ChangeItem | null>(null), [hkOpen,setHkOpen] = useState(false), [marking,setMarking] = useState(false);
  const markLock = useRef(false);
  const {info,status,reviewed,mark,refresh,scanProgress} = useSvnStatus();
  const {doUpdate,doCommit,doRevert,doResolve,writeBusy} = useSvnChanges({setBusy,setAuth,refresh,onCommitted:() => svnSession.set({commitOpen:false,selectedPath:null}),onReverted:() => svnSession.set({selectedPath:null})});
  const view = status.data?.changes ?? {groups:[],shown:0,total:0,ignored:0};
  const items = useMemo(() => status.data?.changes.groups.flatMap(g => g.items) ?? [],[status.data]);
  useEffect(() => { if (root && status.data && !status.error) syncSvnDraft(root,items); },[root,items,status.data,status.error]);
  const selected = items.find(it => selectedPath && keyOf(it.path) === keyOf(selectedPath)) ?? null;
  const eligible = items.filter(isSvnCommittable), pickedCount = eligible.filter(it => isSvnPicked(draft.picked,it.path)).length;
  const locked = !!writeBusy || busy !== null, selectionLocked = locked || !!draft.unknown;
  const queue = svnVisibleGroups(view,prefs.filter,prefs.search,prefs.sort,showIgnored,reviewed,draft.picked).filter(g => !prefs.closed.includes(g.module)).flatMap(g => g.items);
  const openFile = (path: string) => {
    // 不能只 showCode()：那会把代码面露出来却不变 activeTab，SVN 工具条、
    // 变更列表侧栏与文件页状态栏混屏，文档标签随 surface hidden 后根本没有
    // 入口回到 SVN 文档面（P1-19）。与 MetaGenerate 一致，显式导航到文件页。
    window.dispatchEvent(new CustomEvent("ncforge-navigate", { detail: "files" }));
    onOpenFile(path);
  };
  const pick = (it: ChangeItem) => { dock?.showDocument(); svnSession.set({selectedPath:it.path,mode:"diff"}); if (window.matchMedia?.("(max-width:640px)").matches) setSideOpen(false); };
  const refreshNow = () => { void refresh().catch(error => toast(friendlySvnError(error),"error")); };
  const showHistory = () => { svnSession.set({mode:"log",selectedPath:null}); dock?.showDocument(); };
  const closeCommit = () => { svnSession.set({commitOpen:false}); document.querySelector<HTMLButtonElement>("[data-commit-trigger]")?.focus(); };
  const markAndNext = async () => {
    if (!selected || !isMarkable(selected) || markLock.current || locked) return;
    const epoch = workspaceEpoch(), path = selected.path, visible = [...queue];
    markLock.current = true; setMarking(true);
    try {
      await mark(path,selected.revision,true);
      if (getSession().root !== root || workspaceEpoch() !== epoch || svnSession.get().selectedPath !== path) return;
      const next = nextSvnUnreviewed(visible,path,reviewed,path);
      if (next) svnSession.set({selectedPath:next.path,mode:"diff"});
      else toast("当前筛选中的可审文件已全部审查，可以准备提交","success");
    } catch (error) { toast(`标记失败，仍保留当前文件：${friendlySvnError(error)}`,"error"); }
    finally { markLock.current = false; setMarking(false); }
  };
  const toggleReviewed = () => {
    if (!selected || !isMarkable(selected) || locked || markLock.current) return;
    markLock.current = true; setMarking(true);
    void mark(selected.path,selected.revision,!reviewed.has(keyOf(selected.path))).catch(error => toast(friendlySvnError(error),"error")).finally(() => { markLock.current = false; setMarking(false); });
  };
  return <>
    <DockRegion region="toolbar"><SvnToolbar rev={info.data?.revision ?? 0} info={info.data} url={info.data?.url ?? null} generatedAtMs={status.data?.generatedAtMs ?? null} shown={status.data?.changes.shown ?? null} fetching={status.isFetching} scanned={scanProgress} busy={writeBusy?.kind ?? busy} canRevert={!!selected && !selected.isDir && !locked} revertTitle={selected ? `备份并撤销 ${selected.rel}` : "先选择文件"} committable={eligible.length} pickedCount={pickedCount} conflicts={items.filter(it => it.letter === "C").length} hkOpen={hkOpen} onRefresh={refreshNow} onUpdate={() => void doUpdate()} onRevert={() => setRevertTarget(selected)} onCommit={() => { svnSession.set({commitOpen:!commitOpen}); dock?.showDocument(); }} onHousekeeping={() => setHkOpen(true)} onHistory={showHistory} onFiles={() => setSideOpen(true)} /></DockRegion>
    <DockRegion region="sidebar"><ChangeList view={view} root={root} reviewed={reviewed} picked={draft.picked} busy={selectionLocked} selected={selectedPath} loading={status.isFetching} error={status.error ? friendlySvnError(status.error) : null} onSelect={pick} onOpenFile={openFile} showIgnored={showIgnored} onToggleIgnored={() => svnSession.set({showIgnored:!showIgnored})} /></DockRegion>
    <DockRegion region="document"><div className="vc-review-document">
      <SvnScanNotice error={status.error} fetching={status.isFetching} onAuth={() => setAuth({open:true,error:null})} onRefresh={refreshNow} />
      <SvnCommitOutcome root={root} onHistory={showHistory} onRefresh={refreshNow} />
      <div className="vc-review-workarea" ref={workarea}>
        <div className="vc-review-main"><RightPane file={selected} mode={mode} onMode={next => svnSession.set({mode:next})} reviewed={selected ? reviewed.has(keyOf(selected.path)) : false} busy={locked} disabled={locked || marking} picked={selected ? isSvnPicked(draft.picked,selected.path) : false} onTogglePicked={() => selected && !selectionLocked && toggleSvnPicked(root,selected.path)} onToggleReviewed={toggleReviewed} onOpenFile={openFile} onMarkAndNext={markAndNext} onResolve={choice => selected && void doResolve(selected.path,choice)} onLater={() => svnSession.set({selectedPath:null})} /></div>
        <SvnCommitDrawer host={workarea} open={commitOpen} onClose={closeCommit}><CommitPanel items={items} root={root} reviewed={reviewed} busy={locked} onSubmit={(message,paths) => { void doCommit(message,paths); }} onCancel={closeCommit} onSelect={pick} /></SvnCommitDrawer>
      </div>
    </div></DockRegion>
    <SvnReviewDialogs revertTarget={revertTarget} setRevertTarget={setRevertTarget} onRevert={doRevert} auth={auth} setAuth={setAuth} info={info.data} busy={busy} setBusy={setBusy} hkOpen={hkOpen} setHkOpen={setHkOpen} refresh={refresh} />
  </>;
}
