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
import { ToolTab } from "./ToolTab";
import { TabStrip } from "./TabStrip";
import { EditorBanners } from "./EditorBanners";
import { FileReadFeedback } from "./FileReadFeedback";
import { EditorNavRow } from "./EditorNavRow";
import { EditorPane } from "./EditorPane";
import { EmptyEditor } from "./EmptyEditor";
import { ShellStatusBar } from "./ShellStatusBar";
import { NoWorkspace } from "./NoWorkspace";
import { ExtractSqlDialog } from "../db/ExtractSqlDialog";
import { useWorkbenchDock } from "./WorkbenchDock";
import { useFileSlot } from "./useFileSlot";
import { LARGE_FILE_LINES } from "../../lib/largeFile";
import { Icon } from "../ui/icon";
import { OperationStatus } from "../ui/OperationStatus";
import { SearchTab } from "../tabs/SearchTab";
import { setSidebarView, useSidebarView } from "../../lib/sidebarView";
import { ServiceStatusButton } from "./ServiceStatusButton";
import type { PanelTab } from "./BottomPanel";
import type { LinkedProject } from "../../lib/linkedProjects";

/**
 * 文件页四个槽位（树 / 标签条 / 编辑器 / 状态栏）的实际渲染。
 *
 * 从 `FilesTab` 抽出来只为两件事：文件页的接线已经顶到组件体量门禁；以及这些
 * 内容现在都通过 portal 投进外壳的固定槽位，和「页面状态怎么管」是两回事。
 * 这里不持有任何状态——`model` 是当前快照，`actions` 是页面给的回调。
 */

export interface FilePaneModel {
  root: string;
  /** 关联工程（含当前）：多工程树与「全部工程搜索」共用。 */
  projects: LinkedProject[];
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
  applyRoot: (path: string) => Promise<string | null>;
  /**
   * 在任意关联工程里打开文件。跨工程的会先保存 / 确认再切工作区；
   * `pos` 用于搜索命中（行、列）。
   */
  openPath: (path: string, pos?: { line?: number; column?: number }) => void;
  compileActive: () => void;
  /** 编译指定路径所属的模块：不依赖活动标签，供文件树右键使用。 */
  compileModulePath: (path: string) => void;
  onDismissLargeHint: (path: string) => void;
  /** 切到某个标签（写会话的 activePath）。 */
  selectTab: (path: string) => void;
  /** 打开一个最近用过的工作区。 */
  openRecentRoot: (path: string) => void;
  /** 新建/改名/删除后让文件索引失效（搜索、快速导航的数据源）。 */
  invalidateIndex: () => void;
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
    root, projects, activeTool, tabs, activePath, active, splitPath, hasUnsaved, activeMark,
    showLargeHint, heavyFile, conflictPath, encodingIssue, saving, reveal,
    rootInput, editingRoot, recentRoots, panelOpen, panelTab, panels, compiling, canBack, canForward, treeRef,
  } = model;
  const {
    setRootInput, setEditingRoot, setPanels, setPanelOpen, applyRoot, openPath, compileActive,
    compileModulePath, onDismissLargeHint, selectTab, openRecentRoot, invalidateIndex,
  } = actions;

  const sideView = useSidebarView();
  const splitTab = splitPath ? tabs.find((t) => t.path === splitPath) ?? null : null;
  const splitHeavy = splitTab !== null && splitTab.lines > LARGE_FILE_LINES;
  // NC 服务是底部面板的一个标签；它不依赖当前工具页，用户主动选了这个标签就留着面板
  const servicesPanel = panelTab === "svc";
  /**
   * 底部面板要不要显示，与拆开之前同一条规则：设置页不要；打开文档页（补丁 /
   * 数据库）时让位，除非当前是 NC 服务（它的日志就住在底部面板里）。
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
          <SearchTab
            projects={projects}
            onOpenFile={(path, line, column) => openPath(path, { line, column })}
          />
        </>
      ) : (
        <>
          <TreeHeader root={root} projectCount={projects.length} editing={editingRoot} draft={rootInput} unsaved={hasUnsaved}
            recents={recentRoots}
            onDraftChange={setRootInput} onOpen={() => void applyRoot(rootInput)}
            onOpenRecent={openRecentRoot}
            onToggleEditing={() => { setRootInput(root); setEditingRoot((v) => !v); }}
            onCreateFile={() => treeRef.current?.startCreate("file")}
            onCreateDir={() => treeRef.current?.startCreate("dir")}
            onSearch={() => setSidebarView("search")} />
          <FileTree key={root} ref={treeRef} root={root} projects={projects} activePath={activePath}
            onOpen={openPath} onPin={session.pin}
            onCreated={(p) => { invalidateIndex(); void session.openFile(p); }}
            onRenamed={(a, b) => { invalidateIndex(); session.handleRenamed(a, b); }}
            onDeleted={(ps) => { invalidateIndex(); session.handleDeleted(ps); }}
            openPaths={tabs.map((t) => t.path)}
            onCompileModule={compileModulePath} />
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
      <FileReadFeedback root={root} onOpen={p=>p.startsWith("jdt://")?session.openJdt(p,1):session.openFile(p)}/>
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
              onSave={(prepare) => activePath && void session.saveFile(activePath, false, undefined, prepare)} />
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
                onSave={(prepare) => void session.saveFile(splitTab.path, false, undefined, prepare)} />
            </div>
          </section>
        )}
        {!active && <EmptyEditor root={root} onOpen={(p) => void session.openFile(p)} />}
      </div>
      <ExtractSqlDialog />
    </>
  );

  const status = (
    <ShellStatusBar root={root} active={active} mark={activeMark} saving={saving}
      panelOpen={panelOpen} onTogglePanel={() => setPanelOpen((v) => !v)}
      activeTool={activeTool} />
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
  output,
  servicesPanel,
}: {
  rootInput: string;
  recents: string[];
  onChange: (value: string) => void;
  /** 失败时返回原因，由引导页贴在输入框下方。 */
  onOpen: (path: string) => Promise<string | null>;
  output: ReactNode;
  servicesPanel: boolean;
}) {
  const slot = useFileSlot();
  return (
    <>
      {slot("tree", <div className="wb-no-project">尚未打开工程</div>)}
      {/* 数据库标签不依赖工程目录；空工程也要登记多文档工具的停靠宿主。 */}
      {slot("tabs", <div className="wb-tabs" role="tablist"><ToolTab /></div>)}
      {slot("editor", <NoWorkspace value={rootInput} recents={recents} onChange={onChange}
        onOpen={onOpen} />)}
      {slot("status", (
        <footer className="wb-status">
          <span className="wb-status-path wb-no-project">尚未打开工程</span>
          <OperationStatus compact/><span className="wb-status-sp" />
          {/* 服务不依赖工作区：没开工程也要能从这里启动中间件 */}
          <ServiceStatusButton />
        </footer>
      ))}
      {slot("output", servicesPanel ? output : null)}
    </>
  );
}
