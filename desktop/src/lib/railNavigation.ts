import { setSideOpen, toggleSide } from "./layoutStore";

/** Logs have their own list/detail layout, so navigation must not mutate the hidden resource-sidebar preference. */
export function navigateRail(active: string, target: string, navigate: (tab: string) => void): void {
  if (target === active) {
    if (target !== "logs") toggleSide();
    return;
  }
  if (target !== "logs" && !(active === "logs" && target === "files")) setSideOpen(true);
  navigate(target);
}
