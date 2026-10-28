import { useEffect, useRef, useState } from "react";
import "../../workspace.css";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { EmptyState } from "../ui/EmptyState";
import { toast } from "../ui/toast";
import { EditorPane } from "../workspace/EditorPane";
import { FileTree, type FileTreeHandle } from "../workspace/FileTree";
import { BottomPanel } from "../workspace/BottomPanel";
import { EditorBanners } from "../workspace/EditorBanners";
import { EditorStatus } from "../workspace/EditorStatus";
import { NoWorkspace } from "../workspace/NoWorkspace";
import { TabStrip } from "../workspace/TabStrip";
import { TreeHeader } from "../workspace/TreeHeader";
import { closeModel } from "../../lib/editorStore";
import { baseName, getWorkspace, setWorkspace } from "../../lib/workspace";
import { compileModule, onCompileLog } from "../../lib/compile";
import { useFileSession } from "../../hooks/useFileSession";
import { useLangWiring } from "../../hooks/useLangWiring";
import { stopLang } from "../../lib/lang";
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
export function FilesTab() {
  const [rootInput, setRootInput] = useState("");
  const [editingRoot, setEditingRoot] = useState(false);
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
  } = useWorkspaceSession();
  const setRoot = (v: Updater<string | null | undefined>) => setSession({ root: v });
  const setPanelOpen = (v: Updater<boolean>) => setSession({ panelOpen: v });
  const setPanelTab = (v: Updater<typeof panelTab>) => setSession({ panelTab: v });
  const setCompiling = (v: Updater<boolean>) => setSession({ compiling: v });
  const setCompileResult = (v: Updater<typeof compileResult>) => setSession({ compileResult: v });
  const setCompileLog = (v: Updater<string[]>) => setSession({ compileLog: v });

  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  // 标题栏的「新建文件 / 新建文件夹」按钮：交给文件树，由它决定建在哪个目录下
  const treeRef = useRef<FileTreeHandle>(null);

  const {
    conflictPath,
    closingPath,
    reveal,
    openFile,
    saveFile,
    reloadFile,
    closeTab,
    handleRenamed,
    handleDeleted,
    openProblem,
    openAt,
    openJdt,
    unifyEol,
    cancelClose,
  } = useFileSession();
  useLangWiring({ activePath, openAt, openJdt });

  useEffect(() => {
    getWorkspace()
      .then((r) => setRoot(r))
      .catch(() => setRoot(null));
  }, []);

  // 编译过程的逐行进度（首次建类索引时较久，靠它让界面有反馈）。
  // 切页期间这个订阅会断，期间的日志行收不到，但最终结果写回仓库，回来仍然可见。
  useEffect(() => {
    let off: (() => void) | undefined;
    void onCompileLog((line) => setCompileLog((l) => [...l, line])).then((f) => (off = f));
    return () => off?.();
  }, []);

  const applyRoot = async (path: string) => {
    try {
      const shown = await setWorkspace(path);
      // 换目录后旧标签不再属于当前工作区：全部关掉（调用方已在有未保存修改时警告）
      tabs.forEach((t) => closeModel(t.path));
      void stopLang();
      setSession({ tabs: [] });
      setSession({ activePath: null });
      // 编译结果和路径都指向旧工程，留着会让人误读成新工程的问题列表。
      // 这几项现在活在模块级仓库里，不重置就会跨工作区残留。
      setCompileResult(null);
      setCompileLog([]);
      setRoot(shown);
      setEditingRoot(false);
    } catch (e) {
      toast(`无法打开目录：${e}`, "error");
    }
  };

  /** 编译当前文件所在的模块；有未保存的文件先提醒，因为 ecj 读的是磁盘上的内容。 */
  const compileActive = async () => {
    if (!activePath || compiling || tabs.find((t) => t.path === activePath)?.virtual) return;
    if (tabs.some((t) => t.dirty || t.eolChanged)) {
      toast("有未保存的文件，编译读取的是磁盘版本，请先保存（Ctrl+S）", "warning");
    }
    setPanelOpen(true);
    setPanelTab("build");
    setCompiling(true);
    setCompileResult(null);
    setCompileLog([]);
    try {
      const r = await compileModule(activePath);
      setCompileResult(r);
      setPanelTab(r.errorCount > 0 ? "problems" : "build");
    } catch (e) {
      setCompileLog((l) => [...l, `编译失败：${e}`]);
      toast(`编译失败：${e}`, "error");
    } finally {
      setCompiling(false);
    }
  };

  if (root === undefined) return null;

  // 尚未选择工作区：明确引导，不让用户盲猜
  if (root === null) {
    return (
      <NoWorkspace
        value={rootInput}
        onChange={setRootInput}
        onOpen={() => void applyRoot(rootInput)}
      />
    );
  }

  const active: TabMeta | null = tabs.find((t) => t.path === activePath) ?? null;
  const hasUnsaved = tabs.some((t) => t.dirty || t.eolChanged);
  /** 当前文件在树上被标了 UTF-8! 时，状态栏也说一句。 */
  const activeMark = active ? tree.marks[active.path] : undefined;
  const showLargeHint =
    active !== null && active.lines > LARGE_FILE_LINES && !largeHintDismissed.includes(active.path);
  /** 大文件降级：提示条可以关掉，但编辑器里的降级一直有效。 */
  const heavyFile = active !== null && active.lines > LARGE_FILE_LINES;

  return (
    <div className="wb-root">
      <section className="wb-tree">
        <TreeHeader
          root={root}
          editing={editingRoot}
          draft={rootInput}
          unsaved={hasUnsaved}
          onDraftChange={setRootInput}
          onOpen={() => void applyRoot(rootInput)}
          onToggleEditing={() => {
            setRootInput(root);
            setEditingRoot((v) => !v);
          }}
          onCreateFile={() => treeRef.current?.startCreate("file")}
          onCreateDir={() => treeRef.current?.startCreate("dir")}
        />
        <FileTree
          ref={treeRef}
          root={root}
          activePath={activePath}
          onOpen={(p) => void openFile(p)}
          onCreated={(p) => void openFile(p)}
          onRenamed={handleRenamed}
          onDeleted={handleDeleted}
          openPaths={tabs.map((t) => t.path)}
        />
      </section>

      <section className="wb-main">
        <TabStrip
          tabs={tabs}
          activePath={activePath}
          compiling={compiling}
          canCompile={active !== null && !active.virtual}
          onSelect={(p) => setSession({ activePath: p })}
          onClose={closeTab}
          onCompile={() => void compileActive()}
        />

        <EditorBanners
          active={active}
          activePath={activePath}
          conflictPath={conflictPath}
          showLargeHint={showLargeHint}
          onUnifyEol={unifyEol}
          onReload={(p) => void reloadFile(p)}
          onOverwriteSave={(p) => void saveFile(p, true)}
          onDismissLargeHint={(p) => setSession({ largeHintDismissed: (v) => [...v, p] })}
        />

        <div className="wb-editor">
          <EditorPane
            activePath={activePath}
            readOnly={active?.readOnly ?? false}
            reveal={reveal}
            heavy={heavyFile}
            onCursor={(line, column) => setCursor({ line, column })}
            onSave={() => activePath && void saveFile(activePath)}
          />
          {!active && (
            <div className="wb-editor-empty" style={{ pointerEvents: "none" }}>
              <EmptyState icon="file" description="从左侧文件树打开一个文件" />
            </div>
          )}
        </div>

        {panelOpen && (
          <BottomPanel
            root={root}
            tab={panelTab}
            onTab={setPanelTab}
            running={compiling}
            result={compileResult}
            log={compileLog}
            onOpenProblem={openProblem}
            onClose={() => setPanelOpen(false)}
          />
        )}

        <EditorStatus
          root={root}
          active={active}
          mark={activeMark}
          cursor={cursor}
          panelOpen={panelOpen}
          onTogglePanel={() => setPanelOpen((v) => !v)}
        />
      </section>

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
    </div>
  );
}
