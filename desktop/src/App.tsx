import { ActivityPanel } from "./components/ui/ActivityPanel";
import { createContext, useContext, useEffect, useRef, useState, useCallback, useMemo, lazy, Suspense, memo, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "./lib/tauri";
import { CHANGELOG } from "./lib/about";
import {
  getLastSeenVersion,
  countUnreadVersions,
  CHANGELOG_SEEN_EVENT,
} from "./lib/utils";
import { transitionPage } from "./lib/pageTransition";
import { navigateRail, pageSideEffect } from "./lib/railNavigation";
import { PAGES, PAGES_BY_KEY, HOTKEY_TABS } from "./lib/pages";
import { requestOpenFile } from "./lib/openFileRequest";
import { getKeymap, isWorkspaceSearch, layoutKeyOf, paletteModeOf, RAIL_KEY, WORKSPACE_SEARCH_KEY } from "./lib/keymap";
import { setSideOpen, toggleRail, toggleSide, useRailExpanded } from "./lib/layoutStore";
import { setSidebarView } from "./lib/sidebarView";
import { openServicePanel } from "./lib/servicePanel";
import { getToolReturn, recordToolNavigation } from "./lib/toolReturn";
import "./workbench-upgrade.css";
import { openPalette, usePalette } from "./lib/paletteStore";
import { openLinkedDialog } from "./lib/linkedDialog";
import { ShortcutSheet } from "./components/layout/ShortcutSheet";
import { ReqNameDialogHost } from "./components/svn/ReqNameDialog";
import { showObjectFinder } from "./lib/dbStore";
import { isDbObjectKey } from "./lib/keymap";
import { registerCommands } from "./lib/commandRegistry";
import { setSession } from "./lib/workspaceSession";
import { initReviewSession } from "./lib/reviewSession";
import { initRequirements } from "./lib/requirements";
import { openPatchPage } from "./lib/svnSession";
import { requestOpenChangelog } from "./lib/changelogRequest";
import { showWorkbenchDocument } from "./lib/dockEvents";
import { defaultConnId } from "./lib/dbStore";
import { toggleTheme } from "./lib/theme";
import { serverStart, serverStop } from "./lib/server";
import { toast } from "./components/ui/toast";
import { errorToast } from "./lib/errorToast";
import { ConfirmDialog } from "./components/ui/ConfirmDialog";
import { Header } from "./components/layout/Header";
import { SideNav, WORKSPACE_NAV } from "./components/layout/SideNav";
import { WorkbenchShell } from "./components/workspace/WorkbenchShell";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { UpgradeWelcomeBar } from "./components/update/UpgradeWelcomeBar";
import { useAppHiddenFlag } from "./hooks/useAppHiddenFlag";
import { useWindowSizePersistence } from "./hooks/useWindowSizePersistence";
import { useTableLookup } from "./hooks/useTableLookup";
import { useAppHidden } from "./lib/appVisibility";
import { Skeleton } from "./components/ui/Skeleton";
import { DbConfirmHost } from "./components/db/DbConfirmHost";
import { LinkedDialogHost } from "./components/linked/LinkedDialogHost";
import { wireQuitGuard } from "./lib/quitGuard";

/**
 * 页组件：由 lib/pages.ts 的 PAGES 惰性加载器统一包装。
 * 以前这里手写 5 个 lazy 组件、renderTab 又手写一份 switch 组件清单，
 * 新增页面时 renderTab 走 default 返回 null → 空白页（P1-15）。
 * 现在 renderTab 由 PAGES_BY_KEY + 本表派生，页面只登记一次。
 */
const PAGE_COMPONENTS: Record<string, ReturnType<typeof lazy>> = {};
for (const page of PAGES) {
  if (page.component) PAGE_COMPONENTS[page.key] = lazy(page.component);
}

// 数据字典已并进数据库页的字典标签（见 DbTab / DictWorkspace），不再单独成页。
// 快速导航浮层要查语言服务（间接依赖 Monaco），首次打开时才加载，和文件页共用同一个 chunk。
const QuickPalette = lazy(() =>
  import("./components/workspace/QuickPalette").then((m) => ({ default: m.QuickPalette })),
);

// Ctrl+1~N 的页面序列来自 lib/pages.ts 的 HOTKEY_TABS（按 hotkey 字段排序）。
// 键位是历史映射（Ctrl+1 代码 / 2 版本控制 / 3 数据库 / 4 日志 / 5 设置 / 6 元数据），
// 报告 9.7 明确不重排；不要在 App 层再写一份快捷键清单。

/**
 * 服务启停正在路上：连按 Enter 会把同一条指令发好几遍。
 * 放模块级是因为命令面板与确认框走的是同一个闸。
 */
let svcBusy = false;

/**
 * 停止 NC 服务（命令面板与确认框共用）。
 *
 * 三态与 NC 服务面板保持一致：一律报「已停止」是最坑的——服务可能随后照旧起来。
 */
async function stopServerWithFeedback(): Promise<void> {
  if (svcBusy) return;
  svcBusy = true;
  try {
    const outcome = await serverStop();
    if (outcome === "stopped") toast("已停止", "success");
    else if (outcome === "cancelling") toast("正在取消启动…", "info");
    else toast("服务没有在运行", "info");
  } catch (e) {
    // 「复制全部错误」要能拿到可搜索的英文原文，而不只是中文人话（UI 反馈组约定）。
    errorToast("停止 NC 服务", e);
  } finally {
    svcBusy = false;
  }
}

/**
 * 切页只更新 context，不重建已挂载工具页的元素树（P2-20）。
 *
 * 原来 `toolPanels` 的 useMemo 依赖 `activeTab`，每切一次页就对所有已访问过的
 * 工具页重跑 `renderTab`，与「隐藏页面保活」的预期正好相反。现在 children 由
 * 外层 useMemo 一次性构造，HostedTab 只从 context 读 active 决定显隐。
 */
const ActiveTabContext = createContext<string>("files");
const HostedTab = memo(function HostedTab({ tab, children }: { tab: string; children: ReactNode }) {
  const activeTab = useContext(ActiveTabContext);
  return <ActivityPanel active={activeTab === tab}>{children}</ActivityPanel>;
});

/**
 * 应用外壳（壳子版）。
 *
 * 保留的范式（业务直接沿用）：
 * - QueryClient 全局配置在 main.tsx（staleTime/retry/refetchOnWindowFocus）
 * - 窗口隐藏时停轮询：useAppHidden + refetchInterval（统一节流口径）
 * - 侧栏折叠 + 宽度记忆、Ctrl+1~N 快捷键来自 WORKSPACE_NAV 单一来源
 * - 页面切换过渡动画 transitionPage（pageTransition.ts）
 * - 错误边界 + 骨架屏 + Toast 三态
 *
 * 业务替换点：WORKSPACE_NAV（导航）、renderTab（页面表）、statusQuery（状态源）。
 */
function AppContent() {
  // 窗口最小化时给 <html> 打 data-app-hidden，暂停白名单里的常驻无限动画
  // （不是全部：一次性入场动画被暂停会冻在第一帧，见 index.css 的说明）。
  // WebView2 不会自己为隐藏窗口节流动画，实测不做这事会白烧约 0.6 个 CPU 核。
  useAppHiddenFlag();
  // 退出守卫：点 X 后先查一遍未提交的事务，再决定退不退（见 lib/quitGuard）。
  // 全局只挂一次，卸载时解绑。
  // 审查事件采集必须早于用户第一次打开「改动」页签：否则 AI 改完文件后
  // 时间线是空的（P0-2）。幂等，全局只挂一次。
  useEffect(() => { initReviewSession(); initRequirements(); }, []);
  useEffect(() => wireQuitGuard(), []);
  // 窗口尺寸持久化：启动恢复上次尺寸 + resize 防抖落盘（纯前端方案）
  useWindowSizePersistence();
  // 编辑器里悬停表名看表结构的数据源（没配数据库时静默不生效）
  useTableLookup();
  // 窗口不可见时停掉全部定时轮询（壳子示例 5s；业务按需调）
  const appHidden = useAppHidden();

  const [activeTab, setActiveTab] = useState("files");
  const railExpanded = useRailExpanded();
  /** 命令面板触发的服务停止：先弹确认，确认后才真的停。 */
  const [svcConfirm, setSvcConfirm] = useState<null | "stop">(null);

  // ── 状态源（壳子示例：后端还没有业务状态，这里演示查询范式）──
  // 业务把 queryKey/queryFn 换成自家命令，如 invoke<StatusResponse>("get_status")
  // 只用来显示版本号 / 启动错误，没有「实时」语义：30 秒一次足够，兜住设置页
  // 改完之后漏掉的 invalidate。以前 5 秒一次等于每分钟多打 11 次无意义的 IPC。
  const { data: status } = useQuery({
    queryKey: ["app-status"],
    queryFn: () => invoke<{ version?: string; running?: boolean; platform?: string }>("get_app_info"),
    refetchInterval: appHidden ? false : 30_000,
    retry: false,
  });

  const queryClient = useQueryClient();
  const refreshStatus = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ["app-status"] }),
    [queryClient],
  );

  // ── 更新未读计数（CHANGELOG 看了几版）──
  // 关于页亮点可见或用户打开本版历史时标记已读，提醒仅针对运行版本。
  const [unreadCount, setUnreadCount] = useState(0);
  useEffect(() => {
    const recompute = () =>
      setUnreadCount(
        status?.version ? countUnreadVersions(CHANGELOG.map((c) => c.version), getLastSeenVersion(), status.version) : 0,
      );
    recompute();
    window.addEventListener(CHANGELOG_SEEN_EVENT, recompute);
    return () => window.removeEventListener(CHANGELOG_SEEN_EVENT, recompute);
  }, [status?.version]);

  // ── 页面切换过渡 ──
  const navigate = useCallback((tab: string) => {
    // 三条切页入口（侧栏点击 / ncforge-navigate 事件 / Ctrl+1~N）共用同一套侧栏语义：
    // 切到别的页时展开资源侧栏；日志页及其返回代码页保留原开合偏好（见 railNavigation）。
    // 同页收侧栏只属于侧栏点击（navigateRail），这里不处理，避免 openSearch 等
    // 「同页带动作」入口把刚展开的侧栏又收回去。
    const currentTool = getToolReturn().activeTool;
    recordToolNavigation(tab);
    pageSideEffect(currentTool, tab);
    // 日志页始终翻出工具文档面：同页重入时 WorkbenchFrame 的切页 effect 不会跑。
    if (tab === "logs") showWorkbenchDocument();
    // View Transition 动画：update 回调里同步切 tab；当前页已是目标页时不动画
    transitionPage(() => setActiveTab(tab), activeTab !== tab);
  }, [activeTab]);

  /** 升级欢迎条「查看更新内容」：切到设置页并打开更新历史弹窗。 */
  const openUpdateNotes = useCallback(() => {
    requestOpenChangelog();
    navigate("settings");
  }, [navigate]);

  // 重复点击只切换当前页可见的侧栏；日志往返保留代码侧栏的开合偏好。
  const onRail = useCallback((tab: string) => {
    navigateRail(activeTab, tab, navigate);
  }, [activeTab, navigate]);

  // 命令面板里的应用级命令（导航 / 布局 / 主题 / NC 服务）。文件页的命令由文件页自己登记。
  const navRef = useRef(navigate);
  navRef.current = navigate;
  /**
   * 全工程搜索不再是独立页签：切到文件页并把侧栏切到搜索视图。
   * 侧栏收起时先展开——否则「打开了搜索」却看不到任何东西。
   */
  const openSearch = useCallback(() => {
    setSidebarView("search");
    setSideOpen(true);
    navRef.current("files");
  }, []);
  /** 数据字典不再是独立页签：在数据库页开一个字典文档标签，并翻出文档区。 */
  const openDictPage = useCallback(() => {
    // 动态引：dbActions 静态引 sqlModels（含 Monaco），首屏不该为命令面板这一项赔上整包。
    void import("./lib/dbActions")
      .then((m) => m.openDict(defaultConnId()))
      .catch((e) => toast(`打开数据字典失败：${String(e)}`, "error"));
    showWorkbenchDocument();
    navRef.current("db");
  }, []);
  const openLogs = useCallback(() => {
    // 从源码标签回到排查时路由可能没有变化，仍需明确显示工具文档。
    showWorkbenchDocument();
    navRef.current("logs");
  }, []);
  /** 服务启停正在路上：连按 Enter 会把同一条指令发好几遍。 */
  useEffect(() => {
    // 命令面板跑的是一条命令，没有页面上的按钮态可看，所以每个动作都要自己给反馈：
    // 成功报真实结果，失败报人话（以前是把 Rust 英文原文直接弹出来）。
    const runStart = async () => {
      if (svcBusy) return;
      svcBusy = true;
      try {
        const { isDevelopmentFlowRunning } = await import("./lib/developmentFlowSession");
        if (isDevelopmentFlowRunning()) { toast("开发流程正在运行，请在 NC 服务面板查看或取消", "info"); return; }
        await serverStart();
        toast("中间件启动请求已接受，请在 NC 服务面板查看真实进度", "info");
      } catch (e) {
        // 「复制全部错误」要能拿到可搜索的英文原文，而不只是中文人话（UI 反馈组约定）。
        errorToast("启动 NC 服务", e);
      } finally {
        svcBusy = false;
      }
    };
    // 页面导航项由 PAGES 生成（P1-15 / 7.3-4）：删掉硬编码的 go("files") 等，
    // 新增页面自动出现在命令面板，且带上可见的 Ctrl+N 提示。
    const pageCommands = PAGES.map((p) => ({
      id: `go.${p.key}`,
      title: `转到：${p.label}`,
      hint: p.hotkey != null ? `Ctrl+${p.hotkey}` : undefined,
      run: () => (p.key === "logs" ? openLogs() : navRef.current(p.key)),
    }));
    return registerCommands([
      ...pageCommands,
      { id: "view.search", title: "全工程搜索", hint: WORKSPACE_SEARCH_KEY, run: openSearch },
      {
        id: "go.patch",
        title: "转到：补丁打包",
        hint: "版本控制 · 打包补丁",
        run: openPatchPage,
      },
      {id:"db.objects",title:"查找数据库对象",hint:"Ctrl+Alt+O",run:()=>{navRef.current("db");showObjectFinder();}},
      {
        id: "go.linked",
        title: "打开：工程关联",
        hint: "依赖链 · 覆盖规则 · 产物检查",
        run: () => openLinkedDialog("chain"),
      },
      {
        id: "go.linked.artifacts",
        title: "打开：检查工程产物",
        hint: "工程关联 · 产物检查",
        run: () => openLinkedDialog("artifacts"),
      },
      { id: "go.dict", title: "转到：数据字典", hint: "数据库 · 数据字典", run: openDictPage },
      { id: "view.side", title: "切换侧栏", hint: "Ctrl+B", run: toggleSide },
      { id: "view.rail", title: "展开 / 收起左侧导航栏", hint: RAIL_KEY, run: toggleRail },
      { id: "view.panel", title: "切换底部面板", hint: "Ctrl+J", run: () => setSession({ panelOpen: (v) => !v }) },
      { id: "view.theme", title: "切换深色 / 浅色主题", run: () => toggleTheme() },
      { id: "view.services", title: "打开 NC 服务面板", run: openServicePanel },
      { id: "svc.start", title: "启动 NC 服务", run: () => void runStart() },
      // 停止必须问一句：命令面板能一键到的地方，不能在服务面板要确认、到这里就直接打后端。
      { id: "svc.stop", title: "停止 NC 服务", run: () => setSvcConfirm("stop") },
    ]);
  }, [openSearch, openDictPage, openLogs]);
  // 其它页（如 Java 编辑器里「在数据库中执行此 SQL」）要切页时发这个事件，detail 是页 key。
  // 老的 "search" / "services" / "patch" / "dict" / "linked" 页 key 仍然兼容：
  // 转到文件页的对应视图 / 面板、版本控制页的打包视图、数据库页的字典标签，或工程关联弹框。
  // 其余一律用 PAGES_BY_KEY 校验：未知 key 不再切到空白页（P1-15）。
  useEffect(() => {
    const go = (e: Event) => {
      const tab = (e as CustomEvent<string>).detail;
      if (tab === "search") { openSearch(); return; }
      if (tab === "services") { openServicePanel(); return; }
      if (tab === "patch") { openPatchPage(); return; }
      if (tab === "dict") { openDictPage(); return; }
      if (tab === "linked") { openLinkedDialog("chain"); return; }
      const page = PAGES_BY_KEY[tab];
      if (!page) return;
      if (page.key === "logs") { openLogs(); return; }
      navRef.current(page.key);
    };
    window.addEventListener("ncforge-navigate", go);
    return () => window.removeEventListener("ncforge-navigate", go);
  }, [openSearch, openDictPage, openLogs]);
  const { open: paletteOpen } = usePalette();
  // 浮层的代码块在首次使用前就拉好：第一次按快捷键时才去加载，开头敲的几个字符会落进编辑器里
  useEffect(() => {
    const t = setTimeout(() => void import("./components/workspace/QuickPalette"), 1500);
    return () => clearTimeout(t);
  }, []);

  // ── Ctrl+1~N / Ctrl+K 快捷键：前 N 位来自 WORKSPACE_NAV，最后一位是设置 ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 导航浮层与布局键：任何焦点下都生效（含编辑器），只让位给真正的模态框。
      // 只认 aria-modal="true"：InfoPopover / 大纲 / 历史这类非模态浮层也是 role=dialog，
      // 把它们算进来的话，打开一个说明气泡就按不了 Ctrl+K / Ctrl+B / Ctrl+J。
      const otherDialog = document.querySelector('[role="dialog"][aria-modal="true"]:not([data-palette]), dialog[open]');
      if(isDbObjectKey(e) && !otherDialog) {e.preventDefault();e.stopPropagation();navigate("db");showObjectFinder();return;}
      const pm = paletteModeOf(e, getKeymap());
      const lk = layoutKeyOf(e);
      if ((pm || lk) && !otherDialog) {
        e.preventDefault();
        e.stopPropagation();
        if (pm) openPalette(pm);
        else if (lk === "side") toggleSide();
        else if (lk === "rail") toggleRail();
        else setSession({ panelOpen: (v) => !v });
        return;
      }
      const target = e.target instanceof HTMLElement ? e.target : null;
      const formField = target && !target.closest(".monaco-editor") && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      if (!formField && !document.querySelector('[role="dialog"][aria-modal="true"], dialog[open]') && isWorkspaceSearch(e, getKeymap())) {
        e.preventDefault();
        e.stopPropagation();
        openSearch();
        return;
      }
      // P1-9：模态框（生产库写语句确认 / 删除连接 / 快捷键一览）打开时，
      // Ctrl+1~N 与 Ctrl+K 会把背后页面切走或开搜索，浮层却还挂在 body 上。
      // 统一在这里早退；otherDialog 的 :not([data-palette]) 例外保留——
      // 命令面板自己内部的快捷键仍由它处理。
      if (otherDialog) return;
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      // 输入框 / 编辑区内不抢键：Monaco 的 textarea、各页搜索框在焦点中时，
      // Ctrl+1~N 与 Ctrl+K 都可能是编辑器/浏览器惯例（书签跳转、快速命令）。
      // 放行条件用 tagName + isContentEditable 双保险，不猜具体组件。
      const el = document.activeElement;
      if (
        el instanceof HTMLElement &&
        (el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")
      ) {
        return;
      }
      const idx = Number(e.key);
      if (Number.isInteger(idx) && idx >= 1 && idx <= HOTKEY_TABS.length) {
        e.preventDefault();
        const tab = HOTKEY_TABS[idx - 1];
        if (tab === "logs") openLogs(); else navigate(tab);
        return;
      }
      if (e.key.toLowerCase() === "k") {
        e.preventDefault();
        openSearch();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [navigate, openSearch, openLogs]);

  const navItems = useMemo(() => WORKSPACE_NAV, []);

  /**
   * 挂在外壳里的工具页：由 PAGES 派生（hosted 字段），不再手写页面表。
   * `hosted: false`（文件页）不进这里：它由 WorkbenchShell 自己渲染。
   * 设置页虽不在侧栏主导航，但同样登记在 PAGES 里，自动进这个清单。
   */
  const hostedTabs = useMemo(
    () => PAGES.filter((p) => p.hosted).map((p) => p.key),
    [],
  );
  // renderTab 需要 navigate，但 toolPanels 不能依赖它（navigate 随 activeTab 变，
  // 会让所有已访问工具页重跑 renderTab）——转发到 navRef，引用恒定（P2-20）。
  const navigateViaRef = useCallback((tab: string) => navRef.current(tab), []);
  // children 一次性构造、不再随 activeTab 重建；HostedTab 只从 context 读 active 决定显隐。
  const toolPanels = useMemo(
    () =>
      hostedTabs.map((tab) => (
        <HostedTab key={tab} tab={tab}>
          {/* 每页一个边界 + 自己的 Suspense：谁崩了卸谁，谁在加载谁显示骨架，
              不再共用最外层那一个（那样任一工具页出错会把整个工作台卸掉）。 */}
          <ErrorBoundary resetKey={tab}>
            <Suspense fallback={<Skeleton className="m-4 h-40" />}>{renderTab(tab, refreshStatus, navigateViaRef)}</Suspense>
          </ErrorBoundary>
        </HostedTab>
      )),
    [hostedTabs, refreshStatus, navigateViaRef],
  );

  return (
    <div className="app-shell flex h-screen flex-col overflow-hidden">
      <Header
        onOpenPalette={() => openPalette("file")}
        activeTool={activeTab}
      />
      <div className="app-body">
        <SideNav
          activeTab={activeTab}
          onNavigate={onRail}
          unreadCount={unreadCount}
          status={status}
          collapsed={!railExpanded}
          onToggleRail={toggleRail}
          navItems={navItems}
        />
        <main className="app-main page-transition flex min-h-0 min-w-0 flex-col">
          {/* active 只经 context 下发：切页不重建 toolPanels（P2-20）。 */}
          <ActiveTabContext.Provider value={activeTab}>
            <WorkbenchShell activeTab={activeTab} tool={toolPanels} />
          </ActiveTabContext.Provider>
        </main>
      </div>
      {paletteOpen && (
        <Suspense fallback={null}>
          <QuickPalette activeTab={activeTab} onNavigate={navigate} />
        </Suspense>
      )}
      {/* 数据库/退出确认的弹框挂在最外层：任何页面（含文件页）点 X 都要能弹出来 */}
      <DbConfirmHost />
      {/* 工程关联弹框：代码页状态栏 / 问题面板 / 命令面板三处入口共用 */}
      <LinkedDialogHost />
      {/* 命令面板「停止 NC 服务」的二次确认，文案与服务面板同一条 */}
      <ConfirmDialog
        open={svcConfirm === "stop"}
        title="停止 NC 中间件？"
        description="正在使用这个服务的客户端会立刻断开。停机后要重新加载 200 多个模块，大约 10 秒才能再连上。"
        variant="destructive"
        confirmLabel="停止"
        onCancel={() => setSvcConfirm(null)}
        onConfirm={() => {
          setSvcConfirm(null);
          void stopServerWithFeedback();
        }}
      />
      {/* 版本变化的那次启动浮一条一次性提示，把「升级完成」这个闭环补上 */}
      <UpgradeWelcomeBar currentVersion={status?.version} onOpenHistory={openUpdateNotes} />
      <ShortcutSheet />
      <ReqNameDialogHost />
    </div>
  );
}

/** 未在 PAGES 登记的页面：给一个可见空态，而不是静默返回 null（P1-15）。 */
function UnregisteredPage({ tabKey }: { tabKey: string }) {
  return (
    <div role="alert" className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
      <p className="text-base font-medium text-foreground">页面未注册</p>
      <p>没有找到页面「{tabKey}」对应的组件。</p>
      <p className="text-xs">请在 lib/pages.ts 的 PAGES 中登记该页面（key / label / component）。</p>
    </div>
  );
}

/** 页面表：由 PAGES_BY_KEY + PAGE_COMPONENTS 派生，新增页面只改 lib/pages.ts。 */
function renderTab(tab: string, refreshStatus: () => void, navigate: (tab: string) => void) {
  const page = PAGES_BY_KEY[tab];
  const Comp = page?.component ? PAGE_COMPONENTS[tab] : undefined;
  if (!Comp) {
    // 以前 default 只 console.warn + return null → 整块主区空白（P1-15）。
    console.warn(`[NCForge] 页面「${tab}」未在 PAGES 登记或没有 component`);
    return <UnregisteredPage tabKey={tab} />;
  }
  switch (tab) {
    case "svn":
      // 「在文件中打开」：和搜索同一条管道，先记请求再切页（SvnTab 是懒加载）。
      // 补丁打包是这一页的第二个视图，共用同一条渲染通道。
      return (
        <Comp
          onNavigate={navigate}
          onOpenFile={(path: string) => {
            requestOpenFile({ path, line: 1 });
          }}
        />
      );
    case "settings":
      return <Comp onChanged={refreshStatus} />;
    default:
      return <Comp />;
  }
}

export default function App() {
  return <AppContent />;
}
