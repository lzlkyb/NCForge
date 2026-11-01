import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import "../../workspace.css";
import { Skeleton } from "../ui/Skeleton";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { toast } from "../ui/toast";
import { BottomPanel } from "../workspace/BottomPanel";
import { GenerateDialog } from "../workspace/GenerateDialog";
import { RenameDialog } from "../workspace/RenameDialog";
import { EmptyProjectSlots, FilePaneSlots, useFileSlot } from "../workspace/FilePaneSlots";
import type { FileTreeHandle } from "../workspace/FileTree";
import { baseName, getWorkspace } from "../../lib/workspace";
import { applyWorkspace } from "../../lib/switchWorkspace";
import { compileCancel } from "../../lib/compile";
import { useFileSession } from "../../hooks/useFileSession";
import { useModuleCompile } from "../../hooks/useModuleCompile";
import { useFilesTabCommands } from "../../hooks/useFilesTabCommands";
import { useLocalHistorySweep } from "../../hooks/useLocalHistorySweep";
import { isUnsaved } from "../../lib/tabDirty";
import { ensureFilesSaved } from "../../lib/terminatePreflight";
import { useLangWiring } from "../../hooks/useLangWiring";
import { setRenameRequest, setGenerateRequest } from "../../lib/editorActions";
import { invalidateFileIndex } from "../../lib/fileIndex";
import { getCursor } from "../../lib/cursorStore";
import { getCodeDiags, useCodeDiags } from "../../lib/diagStore";
import { mergeProblems, nextProblem } from "../../lib/problemList";
import { useNav } from "../../lib/navHistory";
import {
  getSession,
  setSession,
  useWorkspaceSelector,
  type TabMeta,
  type Updater,
} from "../../lib/workspaceSession";

/**
 * 超过这个行数就提示「语义补全不可用」。
 *
 * 阈值来自实测：`VoucherBO.java`（6433 行）在 jdt.ls 下补全恒为 0；
 * 几千行的文件打开也明显变慢。2000 行是「还正常」与「开始降级」的分界。
 */
const LARGE_FILE_LINES = 2000;

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

  const session = useFileSession();
  const { openAt, openJdt, goBack, goForward, conflictPath, closingPath } = session;
  const { saving, reveal } = session;
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
    // 只在「还没读过」时写入：启动那一瞬间用户可能已经在「工程关联」里切过工作区
    // （那边已经 `setSession({ root })`），而这条更早发出的 getWorkspace 若这时才回来，
    // 会把新 root 覆盖回旧值——文件树按旧目录重建、SVN/补丁的 query key 也跟着退回去。
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

  const panel = (
    <BottomPanel root={root ?? ""} tab={panelTab} onTab={setPanelTab}
      running={compiling} result={compileResult} onOpenProblem={session.openProblem}
      onOpenAt={openAt}
      inspect={codeDiags}
      onNextProblem={() => jumpToProblem(1)}
      onPrevProblem={() => jumpToProblem(-1)}
      onCancel={() => void compileCancel()} onClose={() => setPanelOpen(false)} />
  );

  // 还没读到工作区（一个 IPC 的工夫）：只影响文件页自己的槽位。以前这里 `return null`
  // 会把**所有页面**一起吞掉——连骨架都没有，用户看到的是整片空白。
  if (root === undefined) {
    return <>{slot("editor", <div className="wb-editor"><Skeleton className="m-4 h-40" /></div>)}</>;
  }

  // 尚未选择工作区：明确引导，不让用户盲猜（NC 服务不依赖工程，它的面板仍要在）
  if (root === null) {
    return (
      <EmptyProjectSlots
        rootInput={rootInput}
        onChange={setRootInput}
        onOpen={() => void applyRoot(rootInput)}
        output={panel}
        servicesPanel={activeTool === "services"}
      />
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
          activeTool,
          tabs,
          activePath,
          active,
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
          panelOpen,
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
          compileActive,
          onDismissLargeHint: (p) => setSession({ largeHintDismissed: (v) => [...v, p] }),
          selectTab: (p) => setSession({ activePath: p }),
          invalidateIndex: invalidateFileIndex,
        }}
      />

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
    </>
  );
}
