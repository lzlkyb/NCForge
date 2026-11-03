import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import "../../workspace.css";
import { Skeleton } from "../ui/Skeleton";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { BottomPanel } from "../workspace/BottomPanel";
import { GenerateDialog } from "../workspace/GenerateDialog";
import { RenameDialog } from "../workspace/RenameDialog";
import { EmptyProjectSlots, FilePaneSlots } from "../workspace/FilePaneSlots";
import { useFileSlot } from "../workspace/useFileSlot";
import { SwitchProjectDialog } from "../workspace/SwitchProjectDialog";
import { ServicesTab } from "./ServicesTab";
import type { FileTreeHandle } from "../workspace/FileTree";
import { baseName, getWorkspace } from "../../lib/workspace";
import { useTreeProjects } from "../../hooks/useTreeProjects";
import { useProjectSwitch } from "../../hooks/useProjectSwitch";
import { compileCancel } from "../../lib/compile";
import { useFileSession } from "../../hooks/useFileSession";
import { useModuleCompile } from "../../hooks/useModuleCompile";
import { useFilesTabCommands } from "../../hooks/useFilesTabCommands";
import { useLocalHistorySweep } from "../../hooks/useLocalHistorySweep";
import { useTabPersistence, useTabRestore, useTabSessionKeys } from "../../hooks/useTabSession";
import { getRecentRoots } from "../../lib/recentRoots";
import { isUnsaved } from "../../lib/tabDirty";
import { useLangWiring } from "../../hooks/useLangWiring";
import { useProblemJump } from "../../hooks/useProblemJump";
import { useBreakpointsRoot } from "../../hooks/useBreakpointsRoot";
import { setRenameRequest, setGenerateRequest } from "../../lib/editorActions";
import { invalidateFileIndex } from "../../lib/fileIndex";
import { getCodeDiags, useCodeDiags } from "../../lib/diagStore";
import { mergeProblems } from "../../lib/problemList";
import { useNav } from "../../lib/navHistory";
import { LARGE_FILE_LINES } from "../../lib/largeFile";
import {
  getSession,
  setSession,
  useWorkspaceSelector,
  type TabMeta,
  type Updater,
} from "../../lib/workspaceSession";

/**
 * 文件页：状态与编排都在这里，画面在 `workspace/FilePaneSlots`。
 *
 * 标签与编译状态存在 `lib/workspaceSession`（切页卸载不该丢）；打开/保存/关闭
 * 的编排在 `hooks/useFileSession`。
 *
 * **不再自己渲染 `WorkbenchFrame`**：外壳（含文件树 / 标签条 / 编辑器 / 状态栏的容器）
 * 由 `WorkbenchShell` 持有，这边用 portal 把内容注入那几个槽位。这样「文件页」不再是
 * 「所有页面的宿主」——进设置页不必先下载带 Monaco 的这一坨，任何一个工具页抛错
 * 也不会把整个工作台一起卸掉。
 */
export function FilesTab({ activeTool = "files" }: { activeTool?: string } = {}) {
  const queryClient = useQueryClient();
  const slot = useFileSlot();
  const [rootInput, setRootInput] = useState("");
  const [editingRoot, setEditingRoot] = useState(false);
  // 文件结构 / 本地历史 / 生成代码三个弹层：放这里而不是组件内部，命令面板与快捷键也要能打开它。
  // 合成一个 state：三个布尔各占一个 hook，会把组件顶到体量门禁（≤8）之上
  const [panels, setPanels] = useState({ outline: false, history: false, generate: false });
  const [renameOpen, setRenameOpen] = useState(false);
  // 标签、激活项、面板与编译结果都存在模块级仓库里：切页卸载再回来不该丢。
  //
  // 逐字段订阅（而不是 `useWorkspaceSession()` 拿整份快照）：整快照订阅下，任何一个
  // 字段变化都会让这一页连同整棵文件树、标签条重渲染。编译日志那段尤其致命——
  // 它每 80ms 换一次，而它现在由底部面板自己订阅，本页不再碰。
  const root = useWorkspaceSelector((s) => s.root);
  const tabs = useWorkspaceSelector((s) => s.tabs);
  const activePath = useWorkspaceSelector((s) => s.activePath);
  const splitPath = useWorkspaceSelector((s) => s.splitPath);
  const panelOpen = useWorkspaceSelector((s) => s.panelOpen);
  const panelTab = useWorkspaceSelector((s) => s.panelTab);
  const compiling = useWorkspaceSelector((s) => s.compiling);
  const compileResult = useWorkspaceSelector((s) => s.compileResult);
  const tree = useWorkspaceSelector((s) => s.tree);
  const largeHintDismissed = useWorkspaceSelector((s) => s.largeHintDismissed);
  const encodingIssue = useWorkspaceSelector((s) => s.encodingIssue);
  const setRoot = (v: Updater<string | null | undefined>) => setSession({ root: v });
  const setPanelOpen = (v: Updater<boolean>) => setSession({ panelOpen: v });
  const setPanelTab = (v: Updater<typeof panelTab>) => setSession({ panelTab: v });

  // 标题栏的「新建文件 / 新建文件夹」按钮：交给文件树，由它决定建在哪个目录下
  const treeRef = useRef<FileTreeHandle>(null);
  // 关联工程：多工程树、跨工程打开的确认框与「全部工程搜索」共用这一份列表
  const { projects } = useTreeProjects(root ?? null);

  const session = useFileSession();
  // 跨工程打开 / 切换工作区（含保存确认与确认框）统一在 hook 里
  const { switchTarget, setSwitchTarget, applyRoot, openPath, switchAndOpen } = useProjectSwitch({
    root: root ?? null,
    projects,
    queryClient,
    setRoot,
    setEditingRoot,
    openFile: session.openFile,
  });
  // 标签会话：重启恢复、快照落盘、Ctrl+Shift+T / Ctrl+Tab
  useTabRestore(root, session.openFile);
  useTabPersistence(root, tabs, activePath, splitPath);
  useTabSessionKeys(tabs, activePath, session);
  const { openAt, openJdt, goBack, goForward, conflictPath, closingPath } = session;
  const { saving, reveal } = session;
  useLangWiring({ activePath, openAt, openJdt });
  // 断点按工作区隔离；行号槽与调试面板都查这份快照
  useBreakpointsRoot(root);
  // 本地历史的兜底归档：切文件时抓上一文件 + 每 5 分钟抓一次当前文件
  // （保存前的那一版在 lib/fileSave.saveOne 里抓，那里才拿得到「改动前」）
  useLocalHistorySweep(activePath);
  const codeDiags = useCodeDiags();
  const nav = useNav();
  const { compileActive } = useModuleCompile();
  const jumpToProblem = useProblemJump(compileResult?.problems, activePath, openAt);

  // 换文件时把弹层收起来：留着它就是「另一个文件的符号/版本」压在代码上，容易点错
  useEffect(() => {
    setPanels({ outline: false, history: false, generate: false });
  }, [activePath]);

  // F2 落到自己的重命名流程（Monaco 内置那套只改打开的 model，跨文件会改一半）
  // Alt+Insert 落到生成代码对话框（与 IDEA 同键）
  useEffect(() => {
    setRenameRequest(() => setRenameOpen(true));
    setGenerateRequest(() => setPanels((p) => ({ ...p, generate: true })));
    return () => {
      setRenameRequest(null);
      setGenerateRequest(null);
    };
  }, []);

  useEffect(() => {
    // 只在「还没读过」时写入：会话里的 root 可能已被更早的入口写好（最近工作区恢复等），
    // 而这条更早发出的 getWorkspace 若这时才回来，会把新 root 覆盖回旧值——
    // 文件树按旧目录重建、SVN/补丁的 query key 也跟着退回去。
    getWorkspace()
      .then((r) => {
        if (getSession().root === undefined) setRoot(r);
      })
      .catch(() => {
        if (getSession().root === undefined) setRoot(null);
      });
  }, []);

  // 命令面板里的文件页命令：闭包每帧刷新（hook 内部经 ref 读最新值），登记只做一次
  useFilesTabCommands({
    activePath,
    compiling,
    compileActive,
    closeTab: session.closeTab,
    openOutline: () => setPanels((p) => ({ ...p, outline: true })),
    openHistory: () => setPanels((p) => ({ ...p, history: true })),
    jumpToProblem,
    goBack,
    goForward,
    openRename: () => setRenameOpen(true),
    openGenerate: () => setPanels((p) => ({ ...p, generate: true })),
    reopenClosed: () => void session.reopenLast(),
    openSplit: () => activePath && void session.openSplit(activePath),
    closeSplit: session.closeSplit,
    splitOpen: splitPath !== null,
    canBack: () => nav.canBack,
    canForward: () => nav.canForward,
    // 命令面板每次打开都会问一遍 enabled；从模块仓库现算，不依赖渲染作用域的快照。
    // 只数能跳的：全是 info 建议时这道命令没有目标，nextProblem 也只会返回 null
    hasProblems: () => mergeProblems(compileResult?.problems, getCodeDiags()).some((p) => p.severity !== "info"),
  });

  const panel = (
    <BottomPanel root={root ?? ""} tab={panelTab} onTab={setPanelTab}
      running={compiling} result={compileResult} onOpenProblem={session.openProblem}
      onOpenAt={openAt}
      inspect={codeDiags}
      onNextProblem={() => jumpToProblem(1)}
      onPrevProblem={() => jumpToProblem(-1)}
      onCancel={() => void compileCancel()} onClose={() => setPanelOpen(false)} />
  );

  // NC 服务既是底部面板的一个标签，又要能在没打开工程时使用，所以跟着文件页常驻，
  // 不经过 ActivityPanel 的「访问过才挂载」。
  const services = (
    <ServicesTab
      onNavigate={(tab) =>
        window.dispatchEvent(new CustomEvent("ncforge-navigate", { detail: tab }))
      }
    />
  );

  // 还没读到工作区（一个 IPC 的工夫）：只影响文件页自己的槽位。以前这里 `return null`
  // 会把**所有页面**一起吞掉——连骨架都没有，用户看到的是整片空白。
  if (root === undefined) {
    return <>{slot("editor", <div className="wb-editor"><Skeleton className="m-4 h-40" /></div>)}{services}</>;
  }

  // 尚未选择工作区：明确引导，不让用户盲猜（NC 服务不依赖工程，它的面板仍要在）
  if (root === null) {
    return (
      <>
        <EmptyProjectSlots
          rootInput={rootInput}
          recents={getRecentRoots()}
          onChange={setRootInput}
          onOpen={applyRoot}
          output={panel}
          servicesPanel={panelOpen && panelTab === "svc"}
        />
        {services}
      </>
    );
  }

  const active: TabMeta | null = tabs.find((t) => t.path === activePath) ?? null;
  const showLargeHint =
    active !== null && active.lines > LARGE_FILE_LINES && !largeHintDismissed.includes(active.path);

  return (
    <>
      <FilePaneSlots
        session={session}
        output={panel}
        model={{
          root,
          projects,
          activeTool,
          tabs,
          activePath,
          active,
          splitPath,
          marks: tree.marks,
          // 与退出前的「保存全部」用同一个判定（lib/saveAllDirty.isUnsaved）：
          // 两处口径一旦不一致，就会出现「换目录时警告说会丢、退出时却没弹框」这类怪事
          hasUnsaved: tabs.some(isUnsaved),
          activeMark: active ? tree.marks[active.path] : undefined,
          showLargeHint,
          // 大文件降级：提示条可以关掉，但编辑器里的降级一直有效
          heavyFile: active !== null && active.lines > LARGE_FILE_LINES,
          conflictPath,
          encodingIssue,
          saving,
          reveal,
          rootInput,
          editingRoot,
          recentRoots: getRecentRoots(),
          panelOpen,
          panelTab,
          panels,
          compiling,
          canBack: nav.canBack,
          canForward: nav.canForward,
          treeRef,
        }}
        actions={{
          setRootInput,
          setEditingRoot,
          setPanels,
          setPanelOpen,
          applyRoot,
          openPath,
          compileActive,
          onDismissLargeHint: (p) => setSession({ largeHintDismissed: (v) => [...v, p] }),
          selectTab: (p) => setSession({ activePath: p }),
          openRecentRoot: (p) => void applyRoot(p),
          invalidateIndex: invalidateFileIndex,
        }}
      />

      {services}

      <RenameDialog open={renameOpen} path={activePath} onClose={() => setRenameOpen(false)} />
      <GenerateDialog open={panels.generate} onClose={() => setPanels((p) => ({ ...p, generate: false }))} />

      <ConfirmDialog
        open={closingPath !== null}
        title="放弃未保存的修改？"
        description={`${baseName(closingPath ?? "")} 有未保存的修改，关闭后将丢失。`}
        variant="destructive"
        confirmLabel="放弃并关闭"
        onCancel={session.cancelClose}
        onConfirm={() => {
          if (closingPath) session.closeTab(closingPath, true);
          session.cancelClose();
        }}
      />

      <SwitchProjectDialog
        open={switchTarget !== null}
        from={root}
        to={switchTarget?.project ?? null}
        unsavedCount={tabs.filter(isUnsaved).length}
        onCancel={() => setSwitchTarget(null)}
        onConfirm={() => {
          if (switchTarget) void switchAndOpen(switchTarget);
        }}
      />
    </>
  );
}
