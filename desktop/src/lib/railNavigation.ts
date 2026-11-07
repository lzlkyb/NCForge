import { setSideOpen, toggleSide } from "./layoutStore";

/**
 * 切页对侧栏的副作用：App 的 navigate 与侧栏点击共用这一份规则（7.3-2）。
 * 切到别的页时展开资源侧栏；日志页没有资源侧栏、日志返回代码页时也要保留
 * 用户在代码页设的开合偏好，所以这两种情况不动侧栏。
 */
export function pageSideEffect(active: string, target: string): void {
  if (target === active) return;
  if (target === "logs" || (active === "logs" && target === "files")) return;
  setSideOpen(true);
}

/**
 * 侧栏点击：同页收 / 展侧栏（日志页例外，它没有资源侧栏）。
 * 切页不再自己改侧栏，交给 navigate 里的 pageSideEffect 统一处理，
 * 避免与 ncforge-navigate 事件 / Ctrl+1~N 的语义分叉。
 */
export function navigateRail(active: string, target: string, navigate: (tab: string) => void): void {
  if (target === active) {
    if (target !== "logs") toggleSide();
    return;
  }
  navigate(target);
}
