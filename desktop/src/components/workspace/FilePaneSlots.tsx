import { useContext, type Dispatch, type ReactNode, type RefObject, type SetStateAction } from "react";
import type { EncodingMark } from "../../lib/workspace";
import type { TabMeta } from "../../lib/workspaceSession";
import type { FileTreeHandle } from "./FileTree";
import type { useFileSession } from "../../hooks/useFileSession";
import { FileTree } from "./FileTree";
import { TreeHeader } from "./TreeHeader";
import { TreeSvnContext } from "./TreeSvnContext";
import { TreeSvnProvider } from "./TreeSvnProvider";
import { EditorGroupTools } from "./EditorGroupTools";
import { EditorGroupsPane } from "./EditorGroupsPane";
import { EditorBanners } from "./EditorBanners";
import { FileReadFeedback } from "./FileReadFeedback";
import { EditorReadingLayout } from "./EditorReadingLayout";
import type { EditorNavigation } from "./EditorNavRow";
import { ShellStatusBar } from "./ShellStatusBar";
import { NoWorkspace } from "./NoWorkspace";
import { ExtractSqlDialog } from "../db/ExtractSqlDialog";
import { useWorkbenchDock } from "./WorkbenchDock";
import { useFileSlot } from "./useFileSlot";
import { OperationStatus } from "../ui/OperationStatus";
import { useSearchOpenRequests } from "../../hooks/useSearchOpenRequests";
import type { PanelTab } from "./BottomPanel";
import type { LinkedProject } from "../../lib/linkedProjects";
import { jarClassUri } from "../../lib/jarSymbolSearch";
import { libraryUri } from "../../lib/libraryFiles";
import { NavigationChoices } from "./NavigationChoices";
import { JavaEditingDialogs } from "./JavaEditingDialogs";
import { RefactorMenuHost } from "./RefactorMenuHost";
import { VoTableDialog } from "./VoTableDialog";
import { setSearchForm } from "../../lib/searchStore";
import { RefactorWorkbenchHost } from "./RefactorWorkbenchHost";
import { ProjectWorkbenchHost } from "./ProjectWorkbenchHost";

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
  activeMark: EncodingMark | undefined;
  showLargeHint: boolean;
  heavyFile: boolean;
  conflictPath: string | null;
  encodingIssue: { path: string; message: string } | null;
  saving: boolean;
  reveal: { line: number; column?: number; nonce: number; path?: string; group?: "left" | "right" } | null;
  /** 最近工作区（换目录时直接点）。 */
  recentRoots: string[];
  panelOpen: boolean;
  panelTab: PanelTab;
  panels: { outline: boolean; outlinePinned: boolean; generate: boolean };
  compiling: boolean;
  canBack: boolean;
  canForward: boolean;
  treeRef: RefObject<FileTreeHandle>;
}

export interface FilePaneActions {
  setPanels: Dispatch<SetStateAction<FilePaneModel["panels"]>>;
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
  cleanModulePath: (path: string, module: string) => void;
  rebuildModulePath: (path: string, module: string) => void;
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
  const dock = useWorkbenchDock();
  const documentOpen = dock?.documentOpen ?? false;
  const panelExpanded = dock?.panelExpanded ?? false;
  const {
    root, projects, activeTool, tabs, activePath, active, splitPath, activeMark,
    showLargeHint, conflictPath, encodingIssue, saving, reveal,
    panelOpen, panelTab, panels, compiling, canBack, canForward, treeRef,
  } = model;
  const {
    setPanels, setPanelOpen, openPath, compileActive,
    compileModulePath, cleanModulePath, rebuildModulePath,
    onDismissLargeHint, invalidateIndex,
  } = actions;

  const splitTab = splitPath ? tabs.find((t) => t.path === splitPath) ?? null : null;
  // NC 服务停靠在代码页；工具文档需要完整阅读区域，跨页返回时由导航恢复面板。
  const servicesPanel = panelTab === "svc";
  /**
   * 底部面板只在代码页显示，避免展开服务后切数据库或元数据遮住文档。
   * 展开态必须保留内容：两个面在展开时都由 CSS 让位，底部一旦为空就整块纯白（P1-18）。
   */
  const wantPanel = panelOpen && activeTool === "files" && (!documentOpen || servicesPanel || panelExpanded);

  /**
   * 从文件树 / 搜索结果打开一个文件：**先回代码面再打开**。
   *
   * `openFile` 只改会话里的标签与 activePath，它管不到外壳的代码面/文档面哪个在前台。
   * 用户从任何地方点一个源码文件，期待的都是「右边出现代码」——所以这层出口统一补一次
   * `showCode()`，别指望每个调用点自己记得。
   */
  const openInCode = (path: string, pos?: { line?: number; column?: number }) => {
    dock?.showCode();
    openPath(path, pos);
  };

  useSearchOpenRequests(request => {
    dock?.showCode();
    if (request.kind === "file") openPath(request.path, { line: request.line, column: request.column });
    else if (request.kind === "library") session.openJdt(libraryUri(request.hit), request.hit.line, true, (request.hit.ranges[0]?.start ?? 0) + 1);
    else session.openJdt(jarClassUri(request.jar, request.className, request.source), request.line);
  });

  const tree = (
    <>
          <TreeHeader root={root} projectCount={projects.length}
            onCreateFile={() => treeRef.current?.startCreate("file")}
            onCreateDir={() => treeRef.current?.startCreate("dir")} />
          <FileTree key={root} ref={treeRef} root={root} projects={projects} activePath={activePath}
            onOpen={openInCode} onPin={session.pin}
            onCreated={(p) => { invalidateIndex(); dock?.showCode(); void session.openFile(p); }}
            onRenamed={(a, b) => { invalidateIndex(); session.handleRenamed(a, b); }}
            onDeleted={(ps) => { invalidateIndex(); session.handleDeleted(ps); }}
            openPaths={tabs.map((t) => t.path)}
            onCompileModule={compileModulePath}
            onCleanModule={cleanModulePath}
            onRebuildModule={rebuildModulePath} />
    </>
  );

  const tabStrip = (
    <EditorGroupTools root={root} session={session} compiling={compiling} canCompile={active !== null && !active.virtual} onCompile={() => void compileActive()}
      reading={{ pinned: panels.outline && panels.outlinePinned, heavy: model.heavyFile, onTogglePinned: () => setPanels(p => ({ ...p, outline: !(p.outline && p.outlinePinned), outlinePinned: true })) }} />
  );

  const navigation: EditorNavigation | null = active ? {
    active, root, canBack, canForward,
    onBack: session.goBack, onForward: session.goForward, onJumpHistory: session.goToHistory,
    outlineOpen: panels.outline,
  } : null;

  const editor = (
    <>
      <FileReadFeedback root={root} onOpen={p=>p.startsWith("jdt://")?session.openJdt(p,1):session.openFile(p)}/>
      <EditorBanners active={active} activePath={activePath} conflictPath={conflictPath}
        encodingIssue={encodingIssue} showLargeHint={showLargeHint} onUnifyEol={session.unifyEol}
        onReload={(p) => void session.reloadFile(p)} onOverwriteSave={(p) => void session.saveFile(p, true)}
        onSaveUtf8={(p) => void session.saveAsUtf8(p)}
        onDismissLargeHint={onDismissLargeHint} />
      <EditorReadingLayout split={!!splitTab} pinned={panels.outlinePinned}
        onTogglePin={() => setPanels(p => ({ ...p, outlinePinned: !p.outlinePinned }))}
        onCloseOutline={() => setPanels(p => ({ ...p, outline: false }))}
        onJump={(line, column) => { if (active) void session.openAt(active.path, line, true, column); }}
        nav={navigation}>
        <EditorGroupsPane root={root} tabs={tabs} session={session} reveal={reveal} tools={tabStrip} nav={navigation} />
      </EditorReadingLayout>
      <ExtractSqlDialog />
    </>
  );

  const status = (
    <ShellStatusBar root={root} active={active} mark={activeMark} saving={saving}
      panelOpen={panelOpen} onTogglePanel={() => setPanelOpen((v) => !v)}
      activeTool={activeTool} />
  );

  return (
    <TreeSvnProvider root={root}>
      <NavigationChoices />
      <JavaEditingDialogs />
      <RefactorMenuHost />
      <RefactorWorkbenchHost />
      {/* B3：表名点「在工程中搜索」时跳到搜索页。和 TableRelations 用的是同一条路
          （setSearchForm + 切页事件），不另造一套导航。 */}
      <VoTableDialog
        onSearch={(text) => {
          setSearchForm({ query: text, regex: false, scope: "all" });
          window.dispatchEvent(new CustomEvent("ncforge-navigate", { detail: "search" }));
        }}
      />
      <ProjectWorkbenchHost />
      {slot("tree", <>{tree}<TreeSvnSummary /></>)}
      {/* 执行/分组工具已并入文件标签条（EditorGroupsPane → TabStrip），
          不再单独占一行 36px 的 `.wb-code-tools`。 */}
      {slot("editor", editor)}
      {slot("status", status)}
      {slot("output", wantPanel ? output : null)}
    </TreeSvnProvider>
  );
}

/** 尚未打开工程时的槽位内容（树一列提示 + 中间打开引导 + 状态栏）。 */
export function EmptyProjectSlots({
  recents,
  onOpen,
  output,
  servicesPanel,
}: {
  recents: string[];
  /** 失败时返回原因，由引导页贴在按钮下方。 */
  onOpen: (path: string) => Promise<string | null>;
  output: ReactNode;
  servicesPanel: boolean;
}) {
  const slot = useFileSlot();
  return (
    <>
      {slot("tree", <div className="wb-no-project">尚未打开工程</div>)}
      {slot("editor", <NoWorkspace recents={recents} onOpen={onOpen} />)}
      {slot("status", (
        <footer className="wb-status">
          <span className="wb-status-path wb-no-project">尚未打开工程</span>
          <OperationStatus compact/><span className="wb-status-sp" />
        </footer>
      ))}
      {slot("output", servicesPanel ? output : null)}
    </>
  );
}

function TreeSvnSummary() {
  return useContext(TreeSvnContext).summary;
}
