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
import { useWorkbenchDock, type FileSlotName } from "./WorkbenchDock";

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
  panelOpen: boolean;
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
    root, activeTool, tabs, activePath, active, hasUnsaved, activeMark,
    showLargeHint, heavyFile, conflictPath, encodingIssue, saving, reveal,
    rootInput, editingRoot, panelOpen, panels, compiling, canBack, canForward, treeRef,
  } = model;
  const {
    setRootInput, setEditingRoot, setPanels, setPanelOpen, applyRoot, compileActive,
    onDismissLargeHint, selectTab, invalidateIndex,
  } = actions;

  const servicesPanel = activeTool === "services";
  /**
   * 底部面板要不要显示，与拆开之前同一条规则：设置页不要；打开文档页（补丁 /
   * 数据库 / 工程关联）时让位，除非当前是 NC 服务（它的日志就住在底部面板里）。
   */
  const wantPanel = panelOpen && activeTool !== "settings" && (!documentOpen || servicesPanel);

  const tree = (
    <TreeSvnProvider root={root}>
      <TreeHeader root={root} editing={editingRoot} draft={rootInput} unsaved={hasUnsaved}
        onDraftChange={setRootInput} onOpen={() => void applyRoot(rootInput)}
        onToggleEditing={() => { setRootInput(root); setEditingRoot((v) => !v); }}
        onCreateFile={() => treeRef.current?.startCreate("file")}
        onCreateDir={() => treeRef.current?.startCreate("dir")} />
      <FileTree key={root} ref={treeRef} root={root} activePath={activePath}
        onOpen={(p) => void session.openFile(p, { preview: true })} onPin={session.pin}
        onCreated={(p) => { invalidateIndex(); void session.openFile(p); }}
        onRenamed={(a, b) => { invalidateIndex(); session.handleRenamed(a, b); }}
        onDeleted={(ps) => { invalidateIndex(); session.handleDeleted(ps); }}
        openPaths={tabs.map((t) => t.path)} />
    </TreeSvnProvider>
  );

  const tabStrip = (
    <TabStrip root={root} tabs={tabs} activePath={activePath} compiling={compiling}
      canCompile={active !== null && !active.virtual} onSelect={selectTab}
      onClose={session.closeTab} onCloseMany={session.closeMany} onPin={session.pin}
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
      <div className="wb-editor">
        <EditorPane activePath={activePath} readOnly={active?.readOnly ?? false} reveal={reveal}
          heavy={heavyFile} onCursor={setCursor}
          onSave={() => activePath && void session.saveFile(activePath)} />
        {!active && <EmptyEditor root={root} onOpen={(p) => void session.openFile(p)} />}
      </div>
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
  onChange,
  onOpen,
  output,
  servicesPanel,
}: {
  rootInput: string;
  onChange: Dispatch<SetStateAction<string>>;
  onOpen: () => void;
  output: ReactNode;
  servicesPanel: boolean;
}) {
  const slot = useFileSlot();
  return (
    <>
      {slot("tree", <div className="wb-no-project">尚未打开工程</div>)}
      {slot("editor", <NoWorkspace value={rootInput} onChange={onChange} onOpen={onOpen} />)}
      {slot("status", <div className="wb-status wb-no-project">尚未打开工程</div>)}
      {slot("output", servicesPanel ? output : null)}
    </>
  );
}
