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
import { getStoredTheme } from "./lib/theme";
import { initializeAppearance } from "./lib/appearance";
import "./index.css";
// 独立模块导入保证 Vite 开发注入与生产构建都包含补充样式。
import "./interaction-refinements.css";
import "./appearance.css";

// 启动即应用已保存的主题，避免首帧闪烁。
document.documentElement.classList.toggle("dark", getStoredTheme() === "dark");
initializeAppearance();

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
            <App />
          </ToastProvider>
        </ResourceProvider>
      </UpdateProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
