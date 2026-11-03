import { ActivityPanel } from "./components/ui/ActivityPanel";
import { useEffect, useRef, useState, useCallback, useMemo, lazy, Suspense } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "./lib/tauri";
import { CHANGELOG } from "./lib/about";
import {
  getLastSeenVersion,
  countUnreadVersions,
  CHANGELOG_SEEN_EVENT,
} from "./lib/utils";
import { transitionPage } from "./lib/pageTransition";
import { requestOpenFile } from "./lib/openFileRequest";
import { getKeymap, isWorkspaceSearch, layoutKeyOf, paletteModeOf, RAIL_KEY, WORKSPACE_SEARCH_KEY } from "./lib/keymap";
import { setSideOpen, toggleRail, toggleSide, useRailExpanded } from "./lib/layoutStore";
import { setSidebarView } from "./lib/sidebarView";
import { openServicePanel } from "./lib/servicePanel";
import { openPalette, usePalette } from "./lib/paletteStore";
import { openLinkedDialog } from "./lib/linkedDialog";
import { ShortcutSheet } from "./components/layout/ShortcutSheet";
import { registerCommands } from "./lib/commandRegistry";
import { setSession } from "./lib/workspaceSession";
import { openPatchPage } from "./lib/svnSession";
import { requestOpenChangelog } from "./lib/changelogRequest";
import { showWorkbenchDocument } from "./lib/dockEvents";
import { defaultConnId, openDictTab } from "./lib/dbStore";
import { toggleTheme } from "./lib/theme";
import { serverStart, serverStop } from "./lib/server";
import { toast } from "./components/ui/toast";
import { failureText } from "./lib/friendlyError";
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

// 非首屏 Tab 懒加载：减小首屏 JS，切到对应 Tab 时才加载（fallback 用骨架屏）。
// 业务页照此模式追加：lazy(() => import("./components/tabs/XxxTab").then(m => ({ default: m.XxxTab })))
const SettingsTab = lazy(() =>
  import("./components/tabs/SettingsTab").then((m) => ({ default: m.SettingsTab })),
);
// 文件页（带 Monaco）由 WorkbenchShell 自己懒加载：外壳不依赖编辑器，
// 「进设置也要先下载数 MB 的编辑器」这个问题就是在这儿解决的。
// 全工程搜索与 NC 服务已并进文件页（侧栏视图 / 底部面板），不再单独成页。
// 版本控制页带一份独立的 svn.css 与 Monaco diff editor，同样懒加载。
// 补丁打包已并进这一页的「打包补丁」视图（读的是同一份工作副本改动）。
const SvnTab = lazy(() =>
  import("./components/tabs/SvnTab").then((m) => ({ default: m.SvnTab })),
);
const DbTab = lazy(() => import("./components/tabs/DbTab").then((m) => ({ default: m.DbTab })));
// 工程关联不再是页签：入口在代码页状态栏 / 问题面板 / 命令面板，弹框本身懒加载。
// NC 日志页：要读 5MB 级的日志文件并归因，切过去才加载。
const LogTab = lazy(() => import("./components/tabs/LogTab").then((m) => ({ default: m.LogTab })));
// 数据字典已并进数据库页的字典标签（见 DbTab / DictWorkspace），不再单独成页。
// 快速导航浮层要查语言服务（间接依赖 Monaco），首次打开时才加载，和文件页共用同一个 chunk。
const QuickPalette = lazy(() =>
  import("./components/workspace/QuickPalette").then((m) => ({ default: m.QuickPalette })),
);

/**
 * Ctrl+1~N 快捷键的完整序列：WORKSPACE_NAV 全部项 + 设置（追加在尾部）。
 *
 * settings 不在 WORKSPACE_NAV 里——它在侧栏 foot 单独渲染（带更新未读红点），
 * 但键盘用户同样需要一键直达，故快捷键序列在 App 层追加，不动侧栏数据源。
 * 加导航项会把它往后挤一位（补丁 / 数据字典 / 工程关联并入别处后，设置从 Ctrl+10 变 Ctrl+5）。
 */
const HOTKEY_TABS: string[] = [...WORKSPACE_NAV.map((n) => n.key), "settings"];

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
    toast(failureText("停止 NC 服务", e), "error");
  } finally {
    svcBusy = false;
  }
}

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
  // 只在用户真正打开「更新历史」时写 lastSeen（SettingsTab 里的 markChangelogSeen），
  // 启动时不再替用户标记已读，否则红点与「未读」语义互相矛盾。
  const [unreadCount, setUnreadCount] = useState(0);
  useEffect(() => {
    const recompute = () =>
      setUnreadCount(
        countUnreadVersions(CHANGELOG.map((c) => c.version), getLastSeenVersion()),
      );
    recompute();
    window.addEventListener(CHANGELOG_SEEN_EVENT, recompute);
    return () => window.removeEventListener(CHANGELOG_SEEN_EVENT, recompute);
  }, []);

  // ── 页面切换过渡 ──
  const navigate = useCallback((tab: string) => {
    // View Transition 动画：update 回调里同步切 tab；当前页已是目标页时不动画
    transitionPage(() => setActiveTab(tab), activeTab !== tab);
  }, [activeTab]);

  /** 升级欢迎条「查看更新内容」：切到设置页并打开更新历史弹窗。 */
  const openUpdateNotes = useCallback(() => {
    requestOpenChangelog();
    navigate("settings");
  }, [navigate]);

  // 竖栏点击：点当前项 = 收起 / 展开侧栏（和 VS Code 一致）；点别的项一律先把侧栏展开
  const onRail = useCallback((tab: string) => {
    if (tab === activeTab) {
      toggleSide();
      return;
    }
    setSideOpen(true);
    navigate(tab);
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
  const openDict = useCallback(() => {
    openDictTab(defaultConnId());
    showWorkbenchDocument();
    navRef.current("db");
  }, []);
  /** 服务启停正在路上：连按 Enter 会把同一条指令发好几遍。 */
  useEffect(() => {
    const go = (key: string, title: string, hint?: string) => ({ id: `go.${key}`, title: `转到：${title}`, hint, run: () => navRef.current(key) });
    // 命令面板跑的是一条命令，没有页面上的按钮态可看，所以每个动作都要自己给反馈：
    // 成功报真实结果，失败报人话（以前是把 Rust 英文原文直接弹出来）。
    const runStart = async () => {
      if (svcBusy) return;
      svcBusy = true;
      try {
        await serverStart();
        toast("已发出启动指令，正在加载模块（通常 10 秒左右）", "success");
      } catch (e) {
        toast(failureText("启动 NC 服务", e), "error");
      } finally {
        svcBusy = false;
      }
    };
    return registerCommands([
      go("files", "代码"),
      { id: "view.search", title: "全工程搜索", hint: WORKSPACE_SEARCH_KEY, run: openSearch },
      go("svn", "版本控制"),
      {
        id: "go.patch",
        title: "转到：补丁打包",
        hint: "版本控制 · 打包补丁",
        run: openPatchPage,
      },
      go("db", "数据库"),
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
      go("logs", "NC 日志"),
      { id: "go.dict", title: "转到：数据字典", hint: "数据库 · 数据字典", run: openDict },
      go("settings", "设置"),
      { id: "view.side", title: "切换侧栏", hint: "Ctrl+B", run: toggleSide },
      { id: "view.rail", title: "展开 / 收起左侧导航栏", hint: RAIL_KEY, run: toggleRail },
      { id: "view.panel", title: "切换底部面板", hint: "Ctrl+J", run: () => setSession({ panelOpen: (v) => !v }) },
      { id: "view.theme", title: "切换深色 / 浅色主题", run: () => toggleTheme() },
      { id: "view.services", title: "打开 NC 服务面板", run: openServicePanel },
      { id: "svc.start", title: "启动 NC 服务", run: () => void runStart() },
      // 停止必须问一句：命令面板能一键到的地方，不能在服务面板要确认、到这里就直接打后端。
      { id: "svc.stop", title: "停止 NC 服务", run: () => setSvcConfirm("stop") },
    ]);
  }, [openSearch, openDict]);
  // 其它页（如 Java 编辑器里「在数据库中执行此 SQL」）要切页时发这个事件，detail 是页 key。
  // 老的 "search" / "services" / "patch" / "dict" / "linked" 页 key 仍然兼容：
  // 转到文件页的对应视图 / 面板、版本控制页的打包视图、数据库页的字典标签，或工程关联弹框。
  useEffect(() => {
    const go = (e: Event) => {
      const tab = (e as CustomEvent<string>).detail;
      if (tab === "search") openSearch();
      else if (tab === "services") openServicePanel();
      else if (tab === "patch") openPatchPage();
      else if (tab === "dict") openDict();
      else if (tab === "linked") openLinkedDialog("chain");
      else navRef.current(tab);
    };
    window.addEventListener("ncforge-navigate", go);
    return () => window.removeEventListener("ncforge-navigate", go);
  }, [openSearch, openDict]);
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
        navigate(HOTKEY_TABS[idx - 1]);
        return;
      }
      if (e.key.toLowerCase() === "k") {
        e.preventDefault();
        openSearch();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [navigate, openSearch]);

  const navItems = useMemo(() => WORKSPACE_NAV, []);

  /**
   * 挂在外壳里的工具页：由 `WORKSPACE_NAV` 派生，不再手写第二份页面表。
   *
   * 以前这里是一个 7 项字面量，加导航项时侧栏与 Ctrl+N 自动生效、这个数组不会——
   * 点进去只看到文件页，编译器也不报错。`hosted: false`（文件页）不进这里：
   * 它由 WorkbenchShell 自己渲染。
   *
   * 设置页不在 `WORKSPACE_NAV` 里（它是侧栏底部的独立入口，不进 Ctrl+1~N 的导航
   * 序号），但同样得有面板——漏了它，点「设置」就是一片空白。
   */
  const hostedTabs = useMemo(
    () => [...WORKSPACE_NAV.filter((n) => n.hosted !== false).map((n) => n.key), "settings"],
    [],
  );
  const toolPanels = useMemo(
    () =>
      hostedTabs.map((tab) => (
        <ActivityPanel
          key={tab}
          active={activeTab === tab}
          data-page-panel={activeTab === tab ? "" : undefined}
          className={activeTab === tab ? "animate-tab-in" : ""}
        >
          {/* 每页一个边界 + 自己的 Suspense：谁崩了卸谁，谁在加载谁显示骨架，
              不再共用最外层那一个（那样任一工具页出错会把整个工作台卸掉）。 */}
          <ErrorBoundary resetKey={tab}>
            <Suspense fallback={<Skeleton className="m-4 h-40" />}>{renderTab(tab, refreshStatus, navigate)}</Suspense>
          </ErrorBoundary>
        </ActivityPanel>
      )),
    [activeTab, hostedTabs, refreshStatus, navigate],
  );

  return (
    <div className="app-shell flex h-screen flex-col overflow-hidden">
      <Header
        onOpenPalette={() => openPalette("file")}
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
          <WorkbenchShell activeTab={activeTab} tool={toolPanels} />
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
    </div>
  );
}

/** 页面表：tab key → 组件。业务把这里换成自家页面。 */
function renderTab(tab: string, refreshStatus: () => void, navigate: (tab: string) => void) {
  switch (tab) {
    case "svn":
      // 「在文件中打开」：和搜索同一条管道，先记请求再切页（SvnTab 是懒加载）。
      // 补丁打包是这一页的第二个视图，共用同一条渲染通道。
      return (
        <SvnTab
          onNavigate={navigate}
          onOpenFile={(path) => {
            requestOpenFile({ path, line: 1 });
          }}
        />
      );
    case "db":
      return <DbTab />;
    case "logs":
      return <LogTab />;
    case "settings":
      return <SettingsTab onChanged={refreshStatus} />;
    default:
      // 到这儿说明导航项没有对应页面（加了导航忘了加页面表）。以前 default 返回
      // <FilesTab/>，「看着能用」——点进去只看到文件页，还不报错；更糟的是
      // 一旦有人把 "files" 塞进工具页数组，这里就是「宿主里再套一个宿主」。
      console.warn(`[NCForge] 导航项「${tab}」没有注册页面`);
      return null;
  }
}

export default function App() {
  return <AppContent />;
}
