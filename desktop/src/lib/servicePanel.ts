import { setSession } from "./workspaceSession";

/**
 * 打开底部面板的「NC 服务」标签。
 *
 * NC 服务不再是独立页签：服务卡片与日志常驻在文件页底部面板，状态栏的
 * 服务状态胶囊、命令面板、启动/停止后的引导都从这里进。
 */
export function openServicePanel(): void {
  setSession({ panelOpen: true, panelTab: "svc" });
  // 设置页会收起底部面板：显式打开服务时切回文件页，入口在任何页面上都不会「点了没反应」。
  window.dispatchEvent(new CustomEvent("ncforge-navigate", { detail: "files" }));
}
