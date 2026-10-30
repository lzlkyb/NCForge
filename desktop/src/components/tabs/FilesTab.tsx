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
import { Breadcrumb } from "../workspace/Breadcrumb";
import { NoWorkspace } from "../workspace/NoWorkspace";
import { TabStrip } from "../workspace/TabStrip";
import { TreeHeader } from "../workspace/TreeHeader";
import { closeModel } from "../../lib/editorStore";
import { baseName, getWorkspace, setWorkspace } from "../../lib/workspace";
import { compileCancel, compileModule, isCompileCancelled, onCompileLog } from "../../lib/compile";
import { useFileSession } from "../../hooks/useFileSession";
import { isUnsaved } from "../../lib/saveAllDirty";
import { useLangWiring } from "../../hooks/useLangWiring";
import { stopLang } from "../../lib/lang";
import { registerCommands } from "../../lib/commandRegistry";
import { invalidateFileIndex } from "../../lib/fileIndex";
import { langRegenerate } from "../../lib/appConfig";
import { setCursor } from "../../lib/cursorStore";
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
  const setCompiling = (v: Updater<boolean>) => setSession({ compiling: v });
  const setCompileResult = (v: Updater<typeof compileResult>) => setSession({ compileResult: v });
  const setCompileLog = (v: Updater<string[]>) => setSession({ compileLog: v });

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
    unifyEol,
    cancelClose,
  } = useFileSession();
  useLangWiring({ activePath, openAt, openJdt });

  // 切到 NC 服务：面板打开并停在「NC 服务」标签，服务的卡片与日志就住在那里
  useEffect(() => {
    if (activeTool === "services") setSession({ panelOpen: true, panelTab: "svc" });
  }, [activeTool]);

  useEffect(() => {
    getWorkspace()
      .then((r) => setRoot(r))
      .catch(() => setRoot(null));
  }, []);

  // 编译过程的逐行进度（首次建类索引时较久，靠它让界面有反馈）。
  // 切页期间这个订阅会断，期间的日志行收不到，但最终结果写回仓库，回来仍然可见。
  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    void onCompileLog((line) => setCompileLog((l) => [...l, line])).then((f) => {
      // listen 握手是异步的：resolve 前就卸载的话，拿到的取消函数没人调，
      // 每挂载一次就多留一个监听，编译日志行会成倍重复。
      if (cancelled) f();
      else off = f;
    });
    return () => {
      cancelled = true;
      off?.();
    };
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
      void queryClient.invalidateQueries({ queryKey: ["svn-info"] });
      void queryClient.invalidateQueries({ queryKey: ["svn-status"] });
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
      // 取消不是失败：不要用红色错误把用户自己的操作说成「编译失败」
      if (isCompileCancelled(e)) {
        setCompileLog((l) => [...l, "编译已取消"]);
        toast("已取消编译", "info");
      } else {
        setCompileLog((l) => [...l, `编译失败：${e}`]);
        toast(`编译失败：${e}`, "error");
      }
    } finally {
      setCompiling(false);
    }
  };

  // 命令面板里的文件页命令。闭包每次渲染都是新的，用 ref 拿最新值，登记只做一次
  const live = useRef({ activePath, compiling, compileActive, closeTab });
  live.current = { activePath, compiling, compileActive, closeTab };
  useEffect(() => registerCommands([
    { id: "build.compile", title: "编译当前模块", run: () => void live.current.compileActive(), enabled: () => !!live.current.activePath && !live.current.compiling },
    { id: "build.cancel", title: "取消编译", run: () => void compileCancel(), enabled: () => live.current.compiling },
    { id: "tab.close", title: "关闭当前标签", run: () => live.current.activePath && live.current.closeTab(live.current.activePath), enabled: () => !!live.current.activePath },
    {
      id: "lang.regenerate",
      title: "重新生成代码智能工程（补全 / 跳转异常时用）",
      run: () => void langRegenerate().then(() => toast("已重新生成并重启代码智能", "success"), (e) => toast(`重新生成失败：${e}`, "error")),
    },
  ]), []);

  if (root === undefined) return null;

  const panel = <BottomPanel root={root ?? ""} tab={panelTab} onTab={setPanelTab}
    running={compiling} result={compileResult} log={compileLog} onOpenProblem={openProblem}
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
        {active && <Breadcrumb root={root} active={active} />}
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
