import { createPortal } from "react-dom";
import type { Dispatch, ReactNode, RefObject, SetStateAction } from "react";
import type { EncodingMark } from "../../lib/workspace";
import type { TabMeta } from "../../lib/workspaceSession";
import { isUnsaved } from "../../lib/tabDirty";
import { setCursor } from "../../lib/cursorStore";
import type { FileTreeHandle } from "./FileTree";
import type { useFileSession } from "../../hooks/useFileSession";
import { FileTree } from "./FileTree";
import { TreeHeader } from "./TreeHeader";
import { TreeSvnProvider } from "./TreeSvnProvider";
import { TabStrip } from "./TabStrip";
import { EditorBanners } from "./EditorBanners";
import { EditorNavRow } from "./EditorNavRow";
import { EditorPane } from "./EditorPane";
import { EmptyEditor } from "./EmptyEditor";
import { EditorStatus } from "./EditorStatus";
import { NoWorkspace } from "./NoWorkspace";
import { ExtractSqlDialog } from "../db/ExtractSqlDialog";
import { useWorkbenchDock, type FileSlotName } from "./WorkbenchDock";
import { LARGE_FILE_LINES } from "../../lib/largeFile";
import { Icon } from "../ui/icon";
import { SearchTab } from "../tabs/SearchTab";
import { requestOpenFile } from "../../lib/openFileRequest";
import { setSidebarView, useSidebarView } from "../../lib/sidebarView";
import { ServiceStatusButton } from "./ServiceStatusButton";
import type { PanelTab } from "./BottomPanel";

/**
 * 文件页四个槽位（树 / 标签条 / 编辑器 / 状态栏）的实际渲染。
 *
 * 从 `FilesTab` 抽出来只为两件事：文件页的接线已经顶到组件体量门禁；以及这些
 * 内容现在都通过 portal 投进外壳的固定槽位，和「页面状态怎么管」是两回事。
 * 这里不持有任何状态——`model` 是当前快照，`actions` 是页面给的回调。
 */

export interface FilePaneModel {
  root: string;
  activeTool: string;
  tabs: TabMeta[];
  activePath: string | null;
  active: TabMeta | null;
  /** 右侧分屏里的文件（null = 没有分屏）。 */
  splitPath: string | null;
  /** 树上的编码标记（`UTF-8!` 徽标用）。 */
  marks: Record<string, EncodingMark>;
  hasUnsaved: boolean;
  activeMark: EncodingMark | undefined;
  showLargeHint: boolean;
  heavyFile: boolean;
  conflictPath: string | null;
  encodingIssue: { path: string; message: string } | null;
  saving: boolean;
  reveal: { line: number; column?: number; nonce: number } | null;
  rootInput: string;
  editingRoot: boolean;
  /** 最近工作区（换目录时直接点）。 */
  recentRoots: string[];
  panelOpen: boolean;
  panelTab: PanelTab;
  panels: { outline: boolean; history: boolean; generate: boolean };
  compiling: boolean;
  canBack: boolean;
  canForward: boolean;
  treeRef: RefObject<FileTreeHandle>;
}

export interface FilePaneActions {
  setRootInput: Dispatch<SetStateAction<string>>;
  setEditingRoot: Dispatch<SetStateAction<boolean>>;
  setPanels: Dispatch<SetStateAction<{ outline: boolean; history: boolean; generate: boolean }>>;
  setPanelOpen: (v: (open: boolean) => boolean) => void;
  applyRoot: (path: string) => Promise<void>;
  compileActive: () => void;
  onDismissLargeHint: (path: string) => void;
  /** 切到某个标签（写会话的 activePath）。 */
  selectTab: (path: string) => void;
  /** 打开一个最近用过的工作区。 */
  openRecentRoot: (path: string) => void;
  /** 新建/改名/删除后让文件索引失效（搜索、快速导航的数据源）。 */
  invalidateIndex: () => void;
}

/**
 * 槽位投递器。
 *
 * 宿主在首帧还没挂上（frame 的 ref 回调比渲染晚一拍），返回 null 即可：
 * `fileHosts` 变化会让 dock context 换新值，订阅它的组件下一帧就进去了。
 * 没有 dock（单测里直接渲染）时退回行内渲染，至少内容还在。
 */
export function useFileSlot() {
  const dock = useWorkbenchDock();
  return (name: FileSlotName, node: ReactNode) => {
    if (!node) return null;
    const host = dock?.fileHosts[name];
    return host ? createPortal(node, host) : dock ? null : node;
  };
}

export function FilePaneSlots({
  model,
  actions,
  session,
  output,
}: {
  model: FilePaneModel;
  actions: FilePaneActions;
  /** `useFileSession()` 的返回值：打开 / 保存 / 关闭都在里面。 */
  session: ReturnType<typeof useFileSession>;
  /** 底部面板（已构造好的元素，没有就不投）。 */
  output: ReactNode;
}) {
  const slot = useFileSlot();
  // 底部面板要不要让位给文档页，取决于外壳当前的文档槽有没有被占
  const documentOpen = useWorkbenchDock()?.documentOpen ?? false;
  const {
    root, activeTool, tabs, activePath, active, splitPath, hasUnsaved, activeMark,
    showLargeHint, heavyFile, conflictPath, encodingIssue, saving, reveal,
    rootInput, editingRoot, recentRoots, panelOpen, panelTab, panels, compiling, canBack, canForward, treeRef,
  } = model;
  const {
    setRootInput, setEditingRoot, setPanels, setPanelOpen, applyRoot, compileActive,
    onDismissLargeHint, selectTab, openRecentRoot, invalidateIndex,
  } = actions;

  const sideView = useSidebarView();
  const splitTab = splitPath ? tabs.find((t) => t.path === splitPath) ?? null : null;
  const splitHeavy = splitTab !== null && splitTab.lines > LARGE_FILE_LINES;
  // NC 服务是底部面板的一个标签；它不依赖当前工具页，用户主动选了这个标签就留着面板
  const servicesPanel = panelTab === "svc";
  /**
   * 底部面板要不要显示，与拆开之前同一条规则：设置页不要；打开文档页（补丁 /
   * 数据库 / 工程关联）时让位，除非当前是 NC 服务（它的日志就住在底部面板里）。
   */
  const wantPanel = panelOpen && activeTool !== "settings" && (!documentOpen || servicesPanel);

  const tree = (
    <TreeSvnProvider root={root}>
      {sideView === "search" ? (
        <>
          <div className="wb-pane-title">
            <span>全工程搜索</span>
            <div className="wb-pane-acts">
              <button
                type="button"
                className="wb-icon-btn"
                title="返回文件树"
                aria-label="返回文件树"
                onClick={() => setSidebarView("files")}
              >
                <Icon name="close" size={14} />
              </button>
            </div>
          </div>
          <SearchTab onOpenFile={(path, line, column) => requestOpenFile({ path, line, column })} />
        </>
      ) : (
        <>
          <TreeHeader root={root} editing={editingRoot} draft={rootInput} unsaved={hasUnsaved}
            recents={recentRoots}
            onDraftChange={setRootInput} onOpen={() => void applyRoot(rootInput)}
            onOpenRecent={openRecentRoot}
            onToggleEditing={() => { setRootInput(root); setEditingRoot((v) => !v); }}
            onCreateFile={() => treeRef.current?.startCreate("file")}
            onCreateDir={() => treeRef.current?.startCreate("dir")}
            onSearch={() => setSidebarView("search")} />
          <FileTree key={root} ref={treeRef} root={root} activePath={activePath}
            onOpen={(p) => void session.openFile(p, { preview: true })} onPin={session.pin}
            onCreated={(p) => { invalidateIndex(); void session.openFile(p); }}
            onRenamed={(a, b) => { invalidateIndex(); session.handleRenamed(a, b); }}
            onDeleted={(ps) => { invalidateIndex(); session.handleDeleted(ps); }}
            openPaths={tabs.map((t) => t.path)} />
        </>
      )}
    </TreeSvnProvider>
  );

  const tabStrip = (
    <TabStrip root={root} tabs={tabs} activePath={activePath} splitPath={splitTab?.path ?? null}
      compiling={compiling} canCompile={active !== null && !active.virtual} onSelect={selectTab}
      onClose={session.closeTab} onCloseMany={session.closeMany} onPin={session.pin}
      onOpenSplit={(p) => void session.openSplit(p)} onCloseSplit={session.closeSplit}
      onCompile={() => void compileActive()} />
  );

  const editor = (
    <>
      <EditorBanners active={active} activePath={activePath} conflictPath={conflictPath}
        encodingIssue={encodingIssue} showLargeHint={showLargeHint} onUnifyEol={session.unifyEol}
        onReload={(p) => void session.reloadFile(p)} onOverwriteSave={(p) => void session.saveFile(p, true)}
        onSaveUtf8={(p) => void session.saveAsUtf8(p)}
        onDismissLargeHint={onDismissLargeHint} />
      {active && (
        <EditorNavRow
          active={active}
          root={root}
          canBack={canBack}
          canForward={canForward}
          onBack={session.goBack}
          onForward={session.goForward}
          outlineOpen={panels.outline}
          onToggleOutline={() => setPanels((p) => ({ ...p, outline: !p.outline }))}
          onCloseOutline={() => setPanels((p) => ({ ...p, outline: false }))}
          onJump={(line) => void session.openAt(active.path, line)}
          history={{
            open: panels.history,
            onToggle: () => setPanels((p) => ({ ...p, history: !p.history })),
            onClose: () => setPanels((p) => ({ ...p, history: false })),
            dirty: active ? isUnsaved(active) : false,
            // 恢复写的是磁盘：标签的 mtime 变了，必须重载，否则下一次保存会撞 CONFLICT
            onRestored: (p) => void session.reloadFile(p),
          }}
        />
      )}
      <div className="wb-editor" data-split={splitTab ? "" : undefined}>
        <div className="wb-editor-group">
          <div className="wb-editor-body">
            <EditorPane activePath={activePath} readOnly={active?.readOnly ?? false} reveal={reveal}
              heavy={heavyFile} onCursor={setCursor}
              onSave={() => activePath && void session.saveFile(activePath)} />
          </div>
        </div>
        {splitTab && (
          <section className="wb-editor-group wb-editor-split" aria-label="分屏编辑器">
            <div className="wb-split-head">
              <span className="wb-split-name" title={splitTab.path}>{splitTab.name}</span>
              <button type="button" className="wb-icon-btn" title="关闭分屏" aria-label="关闭分屏"
                onClick={session.closeSplit}>
                <Icon name="close" size={12} />
              </button>
            </div>
            <div className="wb-editor-body">
              {/* 光标不回报：状态栏显示的是主编辑器的位置，分屏移动光标不该改它 */}
              <EditorPane activePath={splitTab.path} readOnly={splitTab.readOnly} reveal={null}
                heavy={splitHeavy} onCursor={() => {}}
                onSave={() => void session.saveFile(splitTab.path)} />
            </div>
          </section>
        )}
        {!active && <EmptyEditor root={root} onOpen={(p) => void session.openFile(p)} />}
      </div>
      <ExtractSqlDialog />
    </>
  );

  const status = (
    <EditorStatus root={root} active={active} mark={activeMark} saving={saving}
      panelOpen={panelOpen} onTogglePanel={() => setPanelOpen((v) => !v)} />
  );

  return (
    <>
      {slot("tree", tree)}
      {slot("tabs", tabStrip)}
      {slot("editor", editor)}
      {slot("status", status)}
      {slot("output", wantPanel ? output : null)}
    </>
  );
}

/** 尚未打开工程时的槽位内容（树一列提示 + 中间打开引导 + 状态栏）。 */
export function EmptyProjectSlots({
  rootInput,
  recents,
  onChange,
  onOpen,
  onOpenRecent,
  output,
  servicesPanel,
}: {
  rootInput: string;
  recents: string[];
  onChange: Dispatch<SetStateAction<string>>;
  onOpen: () => void;
  onOpenRecent: (path: string) => void;
  output: ReactNode;
  servicesPanel: boolean;
}) {
  const slot = useFileSlot();
  return (
    <>
      {slot("tree", <div className="wb-no-project">尚未打开工程</div>)}
      {slot("editor", <NoWorkspace value={rootInput} recents={recents} onChange={onChange}
        onOpen={onOpen} onOpenRecent={onOpenRecent} />)}
      {slot("status", (
        <footer className="wb-status">
          <span className="wb-status-path wb-no-project">尚未打开工程</span>
          <span className="wb-status-sp" />
          {/* 服务不依赖工作区：没开工程也要能从这里启动中间件 */}
          <ServiceStatusButton />
        </footer>
      ))}
      {slot("output", servicesPanel ? output : null)}
    </>
  );
}
