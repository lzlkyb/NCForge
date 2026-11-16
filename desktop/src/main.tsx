import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { UpdateProvider } from "./contexts/UpdateContext";
import { ResourceProvider } from "./contexts/ResourceContext";
// ToastProvider 必须挂载：`toast()` 是模块级单例，靠它的 effect 注入实现；
// 不挂就是彻底的空操作——所有成功/失败提示都静默消失（曾经就是这样，
// 保存配置失败、复制成功、端口改完都在「无声」进行，排查时完全看不出发生过什么）。
import { ToastProvider } from "./components/ui/toast";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { getStoredTheme } from "./lib/theme";
import { reportFirstFrame } from "./lib/bootTrace";
import { installGlobalErrorLogging } from "./lib/frontendLog";
import { installInteractionBudget } from "./lib/interactionBudget";
import { initializeAppearance } from "./lib/appearance";
import { initializeUiDensity } from "./lib/uiDensity";
import { initializeMotionPreference } from "./lib/motionPreference";
import { initializeFonts } from "./lib/fonts";
import "./index.css";
// 独立模块导入保证 Vite 开发注入与生产构建都包含补充样式。
import "./interaction-refinements.css";
import "./appearance.css";
import "./workbench-layout.css";
// 材质在布局之后接入：外层实底不能遮住共享柔光背景。
import "./glass-material.css";
import "./interaction-density.css";
import "./native-workbench.css";
import "./selection-states.css";
import "./content-first.css";
import "./forge-controls.css";
import "./motion-feedback.css";
// The approved material layer follows layout and control defaults in dev and packaged builds.
import "./workbench-material.css";

// 启动即应用已保存的主题，避免首帧闪烁。
document.documentElement.classList.toggle("dark", getStoredTheme() === "dark");
document.documentElement.classList.add("forge-controls");
initializeAppearance();
initializeUiDensity();
initializeMotionPreference();
initializeFonts();
// 渲染之外的异常（事件回调、异步 rejection）ErrorBoundary 抓不到，必须全局兜底。
// 装在 render 之前：启动阶段本身崩了也要留下现场。
installGlobalErrorLogging();
// 交互延迟采样只在 dev 构建启用：DESIGN.md §3 的预算要能被测，生产构建零成本。
if (import.meta.env.DEV) installInteractionBudget();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 3000, // E-P1-8: 3s 内复用缓存，避免 5s 轮询强制重新 fetch
    },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <UpdateProvider>
        {/* ResourceProvider 必须在 ToastProvider 内层之外无所谓、但在 App 之内：
            它的启动自检（拉本地快照 → 缺包则发起下载）要早于任何 Tab 渲染，
            否则首启对话框会晚一个渲染周期才出现。 */}
        <ResourceProvider>
          <ToastProvider>
            {/* 外壳级兜底：Header / SideNav / WorkbenchFrame 任一渲染期抛错时，
                App 内部那层边界管不到，原来会卸载整个 root 变白屏（P1-8）。 */}
            <ErrorBoundary>
              <App />
            </ErrorBoundary>
          </ToastProvider>
        </ResourceProvider>
      </UpdateProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);

// 冷启动基线：首帧画完后上报一次，Rust 侧补上「进程启动」这段起点（见 `boot_timing`）。
// 用 requestAnimationFrame 而不是 setTimeout(0)：rAF 回调意味着这一帧已经画出来了。
// 失败不弹提示：旧后端没有这个命令时，用户不该因为一条统计而看到一个错误。
requestAnimationFrame(() => reportFirstFrame());
