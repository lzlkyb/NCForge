/**
 * 主题（深/浅色）统一管理层。
 * WHY：命令面板(P0-1)也需要切换主题，但主题状态此前散落在 Header 内部。
 * 抽成共享模块后，Header 与命令面板共用同一份逻辑，并通过 `themechange`
 * 事件保持图标/UI 同步，避免各组件各自维护导致状态分裂。
 */

export type Theme = "dark" | "light";
export type ThemeSaveResult = { theme: Theme; stored: boolean };
let transitionTimer: ReturnType<typeof setTimeout>;
let themeRevision = 0;
let requestedTheme: Theme | undefined;

/**
 * 安全读 localStorage：DOM Storage 可能被策略禁用（企业策略 / 隐私模式 /
 * 第三方上下文），此时**访问 `localStorage` 属性本身就抛 SecurityError**。
 * 本模块在 `main.tsx` 的模块初始化阶段就被调用，一次未捕获异常 = 整个应用白屏
 * （审查 P2）。主题偏好属于纯装饰，读不到就用默认值，绝不能让应用挂掉。
 */
function safeGetItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetItem(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    // 配额满 / 被禁用：主题仍在本次会话内生效（class 已切），只是不记忆。
    return false;
  }
}

export function getStoredTheme(): Theme {
  return safeGetItem("theme") === "dark" ? "dark" : "light";
}

export function applyTheme(theme: Theme): boolean {
  const root = document.documentElement;
  requestedTheme = theme;
  // transitionend 会从子元素冒泡，也可能根本不触发；用有界计时器清理，连切可续期。
  clearTimeout(transitionTimer);
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const revision = ++themeRevision;
  const paint = () => {
    if (revision !== themeRevision) return;
    root.classList.toggle("dark", theme === "dark");
    // Monaco 会读取新的 CSS token；必须在 class 实际切换后再通知它。
    window.dispatchEvent(new CustomEvent<Theme>("themechange", { detail: theme }));
  };
  if (!reduced && !document.hidden && document.startViewTransition) {
    // 整页 cross-fade 交给 View Transition（合成器完成）。旧的「全树颜色 transition」
    // 在切换瞬间会让每个节点各跑一次样式重算，大文件树上能明显感到卡顿。
    root.classList.remove("theme-transition");
    const vt = document.startViewTransition(paint);
    // 连续切主题时上一个 transition 会被 skip：ready/finished 都会 reject，吞掉即可。
    void vt.ready.catch(() => {});
    void vt.finished.catch(() => {});
  } else {
    // 旧环境回退：保留 180ms 全树颜色过渡（一次性）。class 必须先加，否则不触发动画。
    if (reduced) {
      root.classList.remove("theme-transition");
    } else {
      root.classList.add("theme-transition");
      transitionTimer = setTimeout(() => root.classList.remove("theme-transition"), 200);
    }
    paint();
  }
  const stored = safeSetItem("theme", theme);
  // 保存结果独立于延迟的绘制事件：所有入口都能同步反馈，包括同值重试。
  window.dispatchEvent(new CustomEvent<ThemeSaveResult>("themesave", { detail: { theme, stored } }));
  return stored;
}

export function toggleTheme(): Theme {
  // 保存失败或动画尚未绘制时，磁盘值/DOM 都可能落后于本次会话的选择。
  const current = requestedTheme ?? (document.documentElement.classList.contains("dark") ? "dark" : "light");
  const next: Theme = current === "dark" ? "light" : "dark";
  applyTheme(next);
  return next;
}
