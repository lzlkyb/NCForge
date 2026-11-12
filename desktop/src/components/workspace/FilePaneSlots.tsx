import { useContext, type Dispatch, type ReactNode, type RefObject, type SetStateAction } from "react";
import type { EncodingMark } from "../../lib/workspace";
import type { TabMeta } from "../../lib/workspaceSession";
import { isUnsaved } from "../../lib/tabDirty";
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
import { Icon } from "../ui/icon";
import { SearchTab } from "../tabs/SearchTab";
import { setSidebarView, useSidebarView } from "../../lib/sidebarView";
import { ServiceStatusButton } from "./ServiceStatusButton";
import type { PanelTab } from "./BottomPanel";
import type { LinkedProject } from "../../lib/linkedProjects";
import { jarClassUri } from "../../lib/jarSymbolSearch";

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
  panels: { outline: boolean; outlinePinned: boolean; history: boolean; generate: boolean };
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
    showLargeHint, heavyFile, conflictPath, encodingIssue, saving, reveal,
    recentRoots, panelOpen, panelTab, panels, compiling, canBack, canForward, treeRef,
  } = model;
  const {
    setPanels, setPanelOpen, applyRoot, openPath, compileActive,
    compileModulePath, cleanModulePath, rebuildModulePath,
    onDismissLargeHint, openRecentRoot, invalidateIndex,
  } = actions;

  const sideView = useSidebarView();
  const splitTab = splitPath ? tabs.find((t) => t.path === splitPath) ?? null : null;
  // NC 服务停靠在代码页；工具文档需要完整阅读区域，跨页返回时由导航恢复面板。
  const servicesPanel = panelTab === "svc";
  /**
   * 底部面板只在代码页显示，避免展开服务后切数据库或元数据遮住文档。
   * 展开态必须保留内容：两个面在展开时都由 CSS 让位，底部一旦为空就整块纯白（P1-18）。
   */
  const wantPanel = panelOpen && activeTool === "files" && (!documentOpen || servicesPanel || panelExpanded);

  const tree = (
    <>
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
            onOpenJarClass={(jar, className) => session.openJdt(jarClassUri(jar, className), 1)}
            onOpenSrcNote={(jar, className, line) =>
              session.openJdt(jarClassUri(jar, className, true), line)
            }
          />
        </>
      ) : (
        <>
          <TreeHeader root={root} projectCount={projects.length} recents={recentRoots}
            onOpen={(path) => void applyRoot(path)}
            onOpenRecent={openRecentRoot}
            onCreateFile={() => treeRef.current?.startCreate("file")}
            onCreateDir={() => treeRef.current?.startCreate("dir")}
            onSearch={() => setSidebarView("search")} />
          <FileTree key={root} ref={treeRef} root={root} projects={projects} activePath={activePath}
            onOpen={openPath} onPin={session.pin}
            onCreated={(p) => { invalidateIndex(); void session.openFile(p); }}
            onRenamed={(a, b) => { invalidateIndex(); session.handleRenamed(a, b); }}
            onDeleted={(ps) => { invalidateIndex(); session.handleDeleted(ps); }}
            openPaths={tabs.map((t) => t.path)}
            onCompileModule={compileModulePath}
            onCleanModule={cleanModulePath}
            onRebuildModule={rebuildModulePath} />
        </>
      )}
    </>
  );

  const tabStrip = (
    <EditorGroupTools root={root} session={session} compiling={compiling} canCompile={active !== null && !active.virtual} onCompile={() => void compileActive()} />
  );

  const navigation: EditorNavigation | null = active ? {
    active, root, canBack, canForward, heavy: heavyFile,
    onBack: session.goBack, onForward: session.goForward, onJumpHistory: session.goToHistory,
    outlineOpen: panels.outline,
    onToggleOutline: () => setPanels(p => ({ ...p, outline: !p.outline })),
    history: {
      open: panels.history,
      onToggle: () => setPanels(p => ({ ...p, history: !p.history })),
      onClose: () => setPanels(p => ({ ...p, history: false })),
      dirty: isUnsaved(active),
      onRestored: p => void session.reloadFile(p),
    },
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
          {/* 服务不依赖工作区：没开工程也要能从这里启动中间件 */}
          <ServiceStatusButton />
        </footer>
      ))}
      {slot("output", servicesPanel ? output : null)}
    </>
  );
}

function TreeSvnSummary() {
  return useContext(TreeSvnContext).summary;
}
