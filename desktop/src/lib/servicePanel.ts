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

/** 打开服务面板的同时请求重启中间件（服务页会先弹它自己的确认框）。 */
export const SERVICE_RESTART_EVENT = "ncforge-service-restart";
let restartRequested = false;

export function requestServiceRestart(): void {
  restartRequested = true;
  openServicePanel();
  window.dispatchEvent(new CustomEvent(SERVICE_RESTART_EVENT));
}

/**
 * 服务页取走挂起的重启请求。服务页可能在请求之后才挂载（面板原本关着），
 * 所以除了事件还要留一个标志，挂载时再取一次。
 */
export function takeServiceRestartRequest(): boolean {
  const r = restartRequested;
  restartRequested = false;
  return r;
}
