import { TreeSvnProvider } from "../workspace/TreeSvnProvider";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import "../../workspace.css";
import { WorkbenchFrame } from "../workspace/WorkbenchFrame";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { EmptyEditor } from "../workspace/EmptyEditor";
import { toast } from "../ui/toast";
import { EditorPane } from "../workspace/EditorPane";
import { FileTree, type FileTreeHandle } from "../workspace/FileTree";
import { BottomPanel } from "../workspace/BottomPanel";
import { EditorBanners } from "../workspace/EditorBanners";
import { EditorStatus } from "../workspace/EditorStatus";
import { EditorNavRow } from "../workspace/EditorNavRow";
import { RenameDialog } from "../workspace/RenameDialog";
import { NoWorkspace } from "../workspace/NoWorkspace";
import { TabStrip } from "../workspace/TabStrip";
import { TreeHeader } from "../workspace/TreeHeader";
import { baseName, getWorkspace } from "../../lib/workspace";
import { applyWorkspace } from "../../lib/switchWorkspace";
import { compileCancel } from "../../lib/compile";
import { useFileSession } from "../../hooks/useFileSession";
import { useModuleCompile } from "../../hooks/useModuleCompile";
import { useFilesTabCommands } from "../../hooks/useFilesTabCommands";
import { useLocalHistorySweep } from "../../hooks/useLocalHistorySweep";
import { isUnsaved } from "../../lib/saveAllDirty";
import { ensureFilesSaved } from "../../lib/terminatePreflight";
import { useLangWiring } from "../../hooks/useLangWiring";
import { setRenameRequest } from "../../lib/editorActions";
import { invalidateFileIndex } from "../../lib/fileIndex";
import { setCursor, getCursor } from "../../lib/cursorStore";
import { getCodeDiags, useCodeDiags } from "../../lib/diagStore";
import { mergeProblems, nextProblem } from "../../lib/problemList";
import { useNav } from "../../lib/navHistory";
import { setSession, useWorkspaceSession, type TabMeta, type Updater } from "../../lib/workspaceSession";

/**
 * 超过这个行数就提示「语义补全不可用」。
 *
 * 阈值来自实测：`VoucherBO.java`（6433 行）在 jdt.ls 下补全恒为 0；
 * 几千行的文件打开也明显变慢。2000 行是「还正常」与「开始降级」的分界。
 */
const LARGE_FILE_LINES = 2000;

/**
 * 文件页：左树 + 中编辑器 + 底部面板。
 *
 * 标签与编译状态存在 `lib/workspaceSession`（切页卸载不该丢）；打开/保存/关闭
 * 的编排在 `hooks/useFileSession`；标题栏、标签条、提示条、状态栏各自是
 * `workspace/` 下的独立组件。本文件只做接线与布局。
 */
export function FilesTab({ activeTool = "files", tool }: { activeTool?: string; tool?: ReactNode } = {}) {
  const queryClient = useQueryClient();
  const [rootInput, setRootInput] = useState("");
  const [editingRoot, setEditingRoot] = useState(false);
  // 文件结构 / 本地历史两个弹层：放这里而不是组件内部，命令面板也要能打开它。
  // 合成一个 state：两个布尔各占一个 hook，会把组件顶到体量门禁（≤8）之上
  const [panels, setPanels] = useState({ outline: false, history: false });
  const [renameOpen, setRenameOpen] = useState(false);
  // 标签、激活项、面板与编译结果都存在模块级仓库里：切页卸载再回来不该丢。
  const {
    root,
    tabs,
    activePath,
    panelOpen,
    panelTab,
    compiling,
    compileResult,
    compileLog,
    tree,
    largeHintDismissed,
    encodingIssue,
  } = useWorkspaceSession();
  const setRoot = (v: Updater<string | null | undefined>) => setSession({ root: v });
  const setPanelOpen = (v: Updater<boolean>) => setSession({ panelOpen: v });
  const setPanelTab = (v: Updater<typeof panelTab>) => setSession({ panelTab: v });

  // 标题栏的「新建文件 / 新建文件夹」按钮：交给文件树，由它决定建在哪个目录下
  const treeRef = useRef<FileTreeHandle>(null);

  const {
    conflictPath,
    closingPath,
    saving,
    reveal,
    openFile,
    saveFile,
    saveAsUtf8,
    reloadFile,
    closeTab,
    closeMany,
    pin,
    handleRenamed,
    handleDeleted,
    openProblem,
    openAt,
    openJdt,
    goBack,
    goForward,
    unifyEol,
    cancelClose,
  } = useFileSession();
  useLangWiring({ activePath, openAt, openJdt });
  // 本地历史的兜底归档：切文件时抓上一文件 + 每 5 分钟抓一次当前文件
  // （保存前的那一版在 lib/fileSave.saveOne 里抓，那里才拿得到「改动前」）
  useLocalHistorySweep(activePath);
  const codeDiags = useCodeDiags();
  const nav = useNav();
  const { compileActive } = useModuleCompile();

  /**
   * 跳到上一条 / 下一条问题。
   *
   * 位置用光标而不是上一次跳转的目标：执行时刻的位置才是「我现在看到哪儿了」。
   * 不用 `useCursor()` 订阅——那会让整页跟着每次方向键重渲染。
   */
  const jumpToProblem = (dir: 1 | -1) => {
    const list = mergeProblems(compileResult?.problems, getCodeDiags());
    const p = nextProblem(list, activePath ? { path: activePath, line: getCursor().line } : null, dir);
    if (!p) {
      toast("当前没有可跳转的问题", "info");
      return;
    }
    void openAt(p.path, p.line);
  };

  // 切到 NC 服务：面板打开并停在「NC 服务」标签，服务的卡片与日志就住在那里
  useEffect(() => {
    if (activeTool === "services") setSession({ panelOpen: true, panelTab: "svc" });
  }, [activeTool]);

  // 换文件时把弹层收起来：留着它就是「另一个文件的符号/版本」压在代码上，容易点错
  useEffect(() => {
    setPanels({ outline: false, history: false });
  }, [activePath]);

  // F2 落到自己的重命名流程（Monaco 内置那套只改打开的 model，跨文件会改一半）
  useEffect(() => {
    setRenameRequest(() => setRenameOpen(true));
    return () => setRenameRequest(null);
  }, []);

  useEffect(() => {
    getWorkspace()
      .then((r) => setRoot(r))
      .catch(() => setRoot(null));
  }, []);

  // 命令面板里的文件页命令：闭包每帧刷新（hook 内部经 ref 读最新值），登记只做一次
  useFilesTabCommands({
    activePath,
    compiling,
    compileActive,
    closeTab,
    openOutline: () => setPanels((p) => ({ ...p, outline: true })),
    openHistory: () => setPanels((p) => ({ ...p, history: true })),
    jumpToProblem,
    goBack,
    goForward,
    openRename: () => setRenameOpen(true),
    canBack: () => nav.canBack,
    canForward: () => nav.canForward,
    // 命令面板每次打开都会问一遍 enabled；从模块仓库现算，不依赖渲染作用域的快照。
    // 只数能跳的：全是 info 建议时这道命令没有目标，nextProblem 也只会返回 null
    hasProblems: () => mergeProblems(compileResult?.problems, getCodeDiags()).some((p) => p.severity !== "info"),
  });

  const applyRoot = async (path: string) => {
    // 切换会 closeModel 掉全部标签：没落盘的修改必须先问用户，与「工程关联」页的切换一致
    if (!(await ensureFilesSaved("切换工程"))) return;
    try {
      // 切换的副作用（关模型 / 停 jdt.ls / 清会话 / 失效 svn 缓存）统一在 lib 里，
      // 「工程关联」页用的是同一份——两边各写一套必然分叉
      const shown = await applyWorkspace(path, queryClient);
      setRoot(shown);
      setEditingRoot(false);
    } catch (e) {
      toast(`无法打开目录：${e}`, "error");
    }
  };

  if (root === undefined) return null;

  const panel = <BottomPanel root={root ?? ""} tab={panelTab} onTab={setPanelTab}
    running={compiling} result={compileResult} log={compileLog} onOpenProblem={openProblem}
    onOpenAt={openAt}
    inspect={codeDiags}
    onNextProblem={() => jumpToProblem(1)}
    onPrevProblem={() => jumpToProblem(-1)}
    onCancel={() => void compileCancel()} onClose={() => setPanelOpen(false)} />;

  // 尚未选择工作区：明确引导，不让用户盲猜（NC 服务不依赖工程，它的面板仍要在）
  if (root === null) {
    return <WorkbenchFrame activeTool={activeTool} tool={tool} tree={<div className="wb-no-project">尚未打开工程</div>} tabs={null}
      editor={<NoWorkspace value={rootInput} onChange={setRootInput} onOpen={() => void applyRoot(rootInput)} />}
      output={activeTool === "services" ? panel : null} status={<div className="wb-status wb-no-project">尚未打开工程</div>} />;
  }

  const active: TabMeta | null = tabs.find((t) => t.path === activePath) ?? null;
  // 与退出前的「保存全部」用同一个判定（lib/saveAllDirty.isUnsaved）：
  // 两处口径一旦不一致，就会出现「换目录时警告说会丢、退出时却没弹框」这类怪事
  const hasUnsaved = tabs.some(isUnsaved);
  /** 当前文件在树上被标了 UTF-8! 时，状态栏也说一句。 */
  const activeMark = active ? tree.marks[active.path] : undefined;
  const showLargeHint =
    active !== null && active.lines > LARGE_FILE_LINES && !largeHintDismissed.includes(active.path);
  /** 大文件降级：提示条可以关掉，但编辑器里的降级一直有效。 */
  const heavyFile = active !== null && active.lines > LARGE_FILE_LINES;

  return (
    <>
    <WorkbenchFrame
      activeTool={activeTool}
      tool={tool}
      tree={<TreeSvnProvider root={root}>
        <TreeHeader root={root} editing={editingRoot} draft={rootInput} unsaved={hasUnsaved}
          onDraftChange={setRootInput} onOpen={() => void applyRoot(rootInput)}
          onToggleEditing={() => { setRootInput(root); setEditingRoot(v => !v); }}
          onCreateFile={() => treeRef.current?.startCreate("file")}
          onCreateDir={() => treeRef.current?.startCreate("dir")} />
        <FileTree key={root} ref={treeRef} root={root} activePath={activePath}
          onOpen={p => void openFile(p, { preview: true })} onPin={pin} onCreated={p => { invalidateFileIndex(); void openFile(p); }}
          onRenamed={(a, b) => { invalidateFileIndex(); handleRenamed(a, b); }} onDeleted={ps => { invalidateFileIndex(); handleDeleted(ps); }} openPaths={tabs.map(t => t.path)} />
      </TreeSvnProvider>}
      tabs={<TabStrip root={root} tabs={tabs} activePath={activePath} compiling={compiling}
        canCompile={active !== null && !active.virtual} onSelect={p => setSession({ activePath: p })}
        onClose={closeTab} onCloseMany={closeMany} onPin={pin} onCompile={() => void compileActive()} />}
      editor={<>
        <EditorBanners active={active} activePath={activePath} conflictPath={conflictPath}
          encodingIssue={encodingIssue} showLargeHint={showLargeHint} onUnifyEol={unifyEol}
          onReload={p => void reloadFile(p)} onOverwriteSave={p => void saveFile(p, true)}
          onSaveUtf8={p => void saveAsUtf8(p)}
          onDismissLargeHint={p => setSession({ largeHintDismissed: v => [...v, p] })} />
        {active && (
          <EditorNavRow
            active={active}
            root={root}
            canBack={nav.canBack}
            canForward={nav.canForward}
            onBack={goBack}
            onForward={goForward}
            outlineOpen={panels.outline}
            onToggleOutline={() => setPanels((p) => ({ ...p, outline: !p.outline }))}
            onCloseOutline={() => setPanels((p) => ({ ...p, outline: false }))}
            onJump={(line) => void openAt(active.path, line)}
            history={{
              open: panels.history,
              onToggle: () => setPanels((p) => ({ ...p, history: !p.history })),
              onClose: () => setPanels((p) => ({ ...p, history: false })),
              dirty: isUnsaved(active),
              // 恢复写的是磁盘：标签的 mtime 变了，必须重载，否则下一次保存会撞 CONFLICT
              onRestored: (p) => void reloadFile(p),
            }}
          />
        )}
        <div className="wb-editor">
          <EditorPane activePath={activePath} readOnly={active?.readOnly ?? false} reveal={reveal}
            heavy={heavyFile} onCursor={setCursor} onSave={() => activePath && void saveFile(activePath)} />
          {!active && <EmptyEditor root={root} onOpen={p => void openFile(p)} />}
        </div>
      </>}
      output={panelOpen && panel}
      status={<EditorStatus root={root} active={active} mark={activeMark} saving={saving}
        panelOpen={panelOpen} onTogglePanel={() => setPanelOpen(v => !v)} />}
    />

      <RenameDialog open={renameOpen} path={activePath} onClose={() => setRenameOpen(false)} />

      <ConfirmDialog
        open={closingPath !== null}
        title="放弃未保存的修改？"
        description={`${baseName(closingPath ?? "")} 有未保存的修改，关闭后将丢失。`}
        variant="destructive"
        confirmLabel="放弃并关闭"
        onCancel={cancelClose}
        onConfirm={() => {
          if (closingPath) closeTab(closingPath, true);
          cancelClose();
        }}
      />
    </>
  );
}
