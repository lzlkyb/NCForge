import { ActivityPanel } from "./components/ui/ActivityPanel";
import { useEffect, useRef, useState, useCallback, useMemo, lazy, Suspense } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "./lib/tauri";
import { CHANGELOG } from "./lib/about";
import {
  getLastSeenVersion,
  setLastSeenVersion,
  countUnreadVersions,
} from "./lib/utils";
import { transitionPage } from "./lib/pageTransition";
import { requestOpenFile } from "./lib/openFileRequest";
import { getKeymap, isWorkspaceSearch, layoutKeyOf, paletteModeOf, WORKSPACE_SEARCH_KEY } from "./lib/keymap";
import { setSideOpen, toggleSide } from "./lib/layoutStore";
import { openPalette, usePalette } from "./lib/paletteStore";
import { registerCommands } from "./lib/commandRegistry";
import { setSession } from "./lib/workspaceSession";
import { toggleTheme } from "./lib/theme";
import { serverStart, serverStop } from "./lib/server";
import { toast } from "./components/ui/toast";
import { Header } from "./components/layout/Header";
import { SideNav, WORKSPACE_NAV } from "./components/layout/SideNav";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useAppHiddenFlag } from "./hooks/useAppHiddenFlag";
import { useWindowSizePersistence } from "./hooks/useWindowSizePersistence";
import { useTableLookup } from "./hooks/useTableLookup";
import { useAppHidden } from "./lib/appVisibility";
import { Skeleton } from "./components/ui/Skeleton";

// 非首屏 Tab 懒加载：减小首屏 JS，切到对应 Tab 时才加载（fallback 用骨架屏）。
// 业务页照此模式追加：lazy(() => import("./components/tabs/XxxTab").then(m => ({ default: m.XxxTab })))
const SettingsTab = lazy(() =>
  import("./components/tabs/SettingsTab").then((m) => ({ default: m.SettingsTab })),
);
// 文件页带着 Monaco（数 MB），必须懒加载，不拖慢其它页面和首屏。
const FilesTab = lazy(() =>
  import("./components/tabs/FilesTab").then((m) => ({ default: m.FilesTab })),
);
// 搜索页只有静态表单与列表，但仍然懒加载：它是第二个高频页，不该挤进首屏包。
const SearchTab = lazy(() =>
  import("./components/tabs/SearchTab").then((m) => ({ default: m.SearchTab })),
);
// 服务页要拉日志、算状态，和 Monaco 一样只在切过去时加载。
const ServicesTab = lazy(() =>
  import("./components/tabs/ServicesTab").then((m) => ({ default: m.ServicesTab })),
);
// 版本控制页带一份独立的 svn.css 与 Monaco diff editor，同样懒加载。
const SvnTab = lazy(() =>
  import("./components/tabs/SvnTab").then((m) => ({ default: m.SvnTab })),
);
// 补丁页与数据库页各带一份独立样式（patch.css / db.css），同样懒加载。
const PatchTab = lazy(() =>
  import("./components/tabs/PatchTab").then((m) => ({ default: m.PatchTab })),
);
const DbTab = lazy(() => import("./components/tabs/DbTab").then((m) => ({ default: m.DbTab })));
// 快速导航浮层要查语言服务（间接依赖 Monaco），首次打开时才加载，和文件页共用同一个 chunk。
const QuickPalette = lazy(() =>
  import("./components/workspace/QuickPalette").then((m) => ({ default: m.QuickPalette })),
);

/**
 * Ctrl+1~N 快捷键的完整序列：WORKSPACE_NAV 六项 + 设置（第 7 个）。
 *
 * settings 不在 WORKSPACE_NAV 里——它在侧栏 foot 单独渲染（带更新未读红点），
 * 但键盘用户同样需要一键直达，故快捷键序列在 App 层追加，不动侧栏数据源。
 */
const HOTKEY_TABS: string[] = [...WORKSPACE_NAV.map((n) => n.key), "settings"];

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
  // 窗口收进托盘/最小化时给 <html> 打 data-app-hidden，暂停全部 CSS 动画。
  // WebView2 不会自己为隐藏窗口节流动画，实测不做这事会白烧约 0.6 个 CPU 核。
  useAppHiddenFlag();
  // 窗口尺寸持久化：启动恢复上次尺寸 + resize 防抖落盘（纯前端方案）
  useWindowSizePersistence();
  // 编辑器里悬停表名看表结构的数据源（没配数据库时静默不生效）
  useTableLookup();
  // 窗口不可见时停掉全部定时轮询（壳子示例 5s；业务按需调）
  const appHidden = useAppHidden();

  const [activeTab, setActiveTab] = useState("files");

  // ── 状态源（壳子示例：后端还没有业务状态，这里演示查询范式）──
  // 业务把 queryKey/queryFn 换成自家命令，如 invoke<StatusResponse>("get_status")
  const { data: status } = useQuery({
    queryKey: ["app-status"],
    queryFn: () => invoke<{ version?: string; running?: boolean; platform?: string }>("get_app_info"),
    refetchInterval: appHidden ? false : 5000,
    retry: false,
  });

  const queryClient = useQueryClient();
  const refreshStatus = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ["app-status"] }),
    [queryClient],
  );

  // ── 更新未读计数（CHANGELOG 看了几版）──
  const [unreadCount, setUnreadCount] = useState(0);
  useEffect(() => {
    const versions = CHANGELOG.map((c) => c.version);
    const lastSeen = getLastSeenVersion();
    setUnreadCount(countUnreadVersions(versions, lastSeen));
    if (versions.length > 0 && versions[0] !== lastSeen) {
      // 首启/升级：把最新版标记为已读（红点只提示「有新版未看」，不反复）
      setLastSeenVersion(versions[0]);
    }
  }, []);

  // ── 页面切换过渡 ──
  const navigate = useCallback((tab: string) => {
    // View Transition 动画：update 回调里同步切 tab；当前页已是目标页时不动画
    transitionPage(() => setActiveTab(tab), activeTab !== tab);
  }, [activeTab]);

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
  useEffect(() => {
    const go = (key: string, title: string, hint?: string) => ({ id: `go.${key}`, title: `转到：${title}`, hint, run: () => navRef.current(key) });
    const svc = (run: () => Promise<unknown>, ok: string) => () => void run().then(() => toast(ok, "success"), (e) => toast(String(e), "error"));
    return registerCommands([
      go("files", "文件"),
      go("search", "全工程搜索", WORKSPACE_SEARCH_KEY),
      go("svn", "版本控制"),
      go("services", "NC 服务"),
      go("patch", "补丁"),
      go("db", "数据库"),
      go("settings", "设置"),
      { id: "view.side", title: "切换侧栏", hint: "Ctrl+B", run: toggleSide },
      { id: "view.panel", title: "切换底部面板", hint: "Ctrl+J", run: () => setSession({ panelOpen: (v) => !v }) },
      { id: "view.theme", title: "切换深色 / 浅色主题", run: () => toggleTheme() },
      { id: "svc.start", title: "启动 NC 服务", run: svc(serverStart, "已发出启动指令") },
      { id: "svc.stop", title: "停止 NC 服务", run: svc(serverStop, "已发出停止指令") },
    ]);
  }, []);
  // 其它页（如 Java 编辑器里「在数据库中执行此 SQL」）要切页时发这个事件，detail 是页 key
  useEffect(() => {
    const go = (e: Event) => navRef.current((e as CustomEvent<string>).detail);
    window.addEventListener("ncforge-navigate", go);
    return () => window.removeEventListener("ncforge-navigate", go);
  }, []);
  const { open: paletteOpen } = usePalette();
  // 浮层的代码块在首次使用前就拉好：第一次按快捷键时才去加载，开头敲的几个字符会落进编辑器里
  useEffect(() => {
    const t = setTimeout(() => void import("./components/workspace/QuickPalette"), 1500);
    return () => clearTimeout(t);
  }, []);

  // ── Ctrl+1~7 / Ctrl+K 快捷键：前 6 位来自 WORKSPACE_NAV，第 7 位是设置 ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 导航浮层与布局键：任何焦点下都生效（含编辑器），只让位给别的模态框；浮层自己开着时模式键用来切模式
      const otherDialog = document.querySelector('[role="dialog"]:not([data-palette]), dialog[open]');
      const pm = paletteModeOf(e, getKeymap());
      const lk = layoutKeyOf(e);
      if ((pm || lk) && !otherDialog) {
        e.preventDefault();
        e.stopPropagation();
        if (pm) openPalette(pm);
        else if (lk === "side") toggleSide();
        else setSession({ panelOpen: (v) => !v });
        return;
      }
      const target = e.target instanceof HTMLElement ? e.target : null;
      const formField = target && !target.closest(".monaco-editor") && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      if (!formField && !document.querySelector('[role="dialog"], dialog[open]') && isWorkspaceSearch(e, getKeymap())) {
        e.preventDefault();
        e.stopPropagation();
        navigate("search");
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
        navigate("search");
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [navigate]);

  const navItems = useMemo(() => WORKSPACE_NAV, []);

  return (
    <div className="app-shell flex h-screen flex-col overflow-hidden">
      <Header
        onNavigate={navigate}
        onOpenPalette={() => openPalette("file")}
      />
      <div className="app-body">
        <SideNav
          activeTab={activeTab}
          onNavigate={onRail}
          unreadCount={unreadCount}
          status={status}
          collapsed
          navItems={navItems}
        />
        <main className="app-main page-transition flex min-h-0 min-w-0 flex-col">
          <ErrorBoundary>
            <Suspense fallback={<Skeleton className="m-4 h-40" />}>
              <FilesTab activeTool={activeTab}
                tool={["search", "svn", "services", "patch", "db", "settings"].map(tab => <ActivityPanel key={tab} active={activeTab === tab}>{renderTab(tab, refreshStatus, navigate)}</ActivityPanel>)} />
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>
      {paletteOpen && (
        <Suspense fallback={null}>
          <QuickPalette activeTab={activeTab} onNavigate={navigate} />
        </Suspense>
      )}
    </div>
  );
}

/** 页面表：tab key → 组件。业务把这里换成自家页面。 */
function renderTab(tab: string, refreshStatus: () => void, navigate: (tab: string) => void) {
  switch (tab) {
    case "files":
      return <FilesTab />;
    case "search":
      // 点命中：先把「打开哪个文件、定位到哪行」记到管道里，再切到文件页。
      // 顺序不能反——FilesTab 是懒加载组件，切页时它才挂载，订阅晚于事件，
      // 靠 openFileRequest 的 pending 兜住这一拍。
      return (
        <SearchTab
          onOpenFile={(path, line, column) => {
            requestOpenFile({ path, line, column });
          }}
        />
      );
    case "svn":
      // 「在文件中打开」：和搜索页同一条管道，先记请求再切页（SvnTab 是懒加载）。
      return (
        <SvnTab
          onOpenFile={(path) => {
            requestOpenFile({ path, line: 1 });
          }}
        />
      );
    case "services":
      return <ServicesTab onNavigate={navigate} />;
    case "patch":
      return <PatchTab onNavigate={navigate} />;
    case "db":
      return <DbTab />;
    case "settings":
      return <SettingsTab onChanged={refreshStatus} />;
    default:
      return <FilesTab />;
  }
}

export default function App() {
  return <AppContent />;
}
