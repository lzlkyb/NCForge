import type { ClientStatus } from "./client";
import type { ServerStatus } from "./server";

export type ServiceSource = "middleware" | "client";
export type ServiceBusy = "start" | "stop" | "restart" | "kill" | null;
export type ServiceStatus = ServerStatus | ClientStatus;
export const serviceNames = { middleware: "中间件", client: "客户端" } as const;

/** 状态描述只采用进程/端口证据，工作台数据库连接不参与服务健康判断。 */
export function servicePresentation(source: ServiceSource, status: ServiceStatus | null, failed = false, busy: ServiceBusy = null) {
  // 手动停止是我们强杀的，退出码非零不算崩溃（后端同名原因串：`server.rs` stop()）
  const crashed = !!status?.exitCode && status.reason !== "已手动停止";
  const conflict = source === "middleware" && status && "portOwner" in status && !!status.portOwner && !status.portOwnedBySelf;
  const state = busy === "stop" ? "stopping" : busy === "start" || busy === "restart" ? "starting" : failed ? "unknown" : !status ? "loading" : conflict ? "conflict" : status.state;
  const labels = { stopping: "停止中", starting: "启动中", unknown: "状态未知", loading: "读取中", conflict: "端口冲突", running: source === "middleware" ? "端口监听中" : "进程运行中", stopped: crashed ? "异常退出" : status?.reason?.includes("失败") ? "启动失败" : "已停止" };
  const tone = state === "running" ? "ok" : state === "conflict" || (state === "stopped" && crashed) ? "bad" : ["starting", "unknown", "stopping"].includes(state) ? "warn" : "idle";
  const host = status && "host" in status ? status.host : status && "portAddress" in status ? status.portAddress ?? "127.0.0.1" : "";
  return { state, label: labels[state], tone, endpoint: status ? `${host}:${status.port}` : "尚未读取端点", conflict: !!conflict };
}
