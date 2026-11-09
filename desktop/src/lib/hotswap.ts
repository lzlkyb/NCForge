// 热替换（Rust `hotswap.rs` / `commands/hotswap_cmds.rs`）的前端出口。
//
// 后端在编译通过后自己推送，前端只做三件事：显示状态、失败时提醒、推送后重装断点。
// 事件订阅放在模块级（`startHotswapEvents` 幂等）：toast 与断点重装不该因为
// 状态栏重渲染或某个组件卸载而丢掉。
import { useSyncExternalStore } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { invoke, listen } from "./tauri";
import { toast } from "../components/ui/toast";
import { reinstallBreakpoints } from "./debugSync";
import { requestServiceRestart } from "./servicePanel";

export type HotswapState = "ok" | "partial" | "failed";

export interface HotswapLoaded {
  name: string;
  loader: string;
}

export interface HotswapShadowed extends HotswapLoaded {
  /** 实际加载来源目录；来自 jar 或启动类加载器时为空串。 */
  source: string;
}

/** 一次推送的结果（Rust `hotswap::Report`）。`unavailable` 后端不发，这里不会出现。 */
export interface HotswapReport {
  state: HotswapState;
  atMs: number;
  requested: number;
  redefined: HotswapLoaded[];
  notLoaded: string[];
  shadowed: HotswapShadowed[];
  code: string | null;
  message: string | null;
  elapsedMs: number;
  /** 本批请求替换的类名（失败时 `redefined` 为空，靠它知道哪些类没进 JVM）。 */
  requestedNames: string[];
}

/** Rust `HotswapStatus`。 */
export interface HotswapStatus {
  enabled: boolean;
  auto: boolean;
  agentOnline: boolean;
  /** 本次启动带了 agent；agent 就绪前 `agentOnline` 为 false（约 2.5 分钟）。 */
  agentAttached: boolean;
  stale: boolean;
  pending: number;
  pendingClasses: string[];
  last: HotswapReport | null;
  staleReport: HotswapReport | null;
}

export const HOTSWAP_STATUS_KEY = ["hotswap-status"] as const;

/** 「热替换失败」toast 的归属标识。 */
const FAILURE_TOAST_KEY = "hotswap-failed";

/**
 * 收回「热替换失败」通知。错误通知不会自己消失：服务重启后它说的「服务上仍是旧代码」
 * 已经不对，用户点开小签卡片时也已经看到了同样的信息（而且它会压住卡片）。
 */
export function dismissHotswapFailure(): void {
  toast.dismiss(FAILURE_TOAST_KEY);
}

export const hotswapStatus = () => invoke<HotswapStatus>("hotswap_status");
export const hotswapPushPending = () => invoke<HotswapReport>("hotswap_push_pending");
export const hotswapClearPending = () => invoke<void>("hotswap_clear_pending");

/** 类的短名：`nc.bs.Foo$1` → `Foo$1`。 */
export const shortClassName = (name: string) => name.slice(name.lastIndexOf(".") + 1);

/** 失败原因的一句话（toast、告警条共用）。 */
export function failureSummary(r: HotswapReport): string {
  if (r.state === "partial") {
    const names = r.shadowed.map((s) => shortClassName(s.name)).join("、");
    return `${names} 被同名类遮挡，改动不会生效`;
  }
  // agent 的 unsupported 消息是 JVM 原文（英文），翻成人话；其余照原文给
  if (r.code === "unsupported") return "改了类的结构（增删方法、字段或改签名），热替换只能改方法体";
  return r.message || "agent 拒绝了这次替换";
}

// ── 最近一次事件：状态栏「已替换 N 个类」的 8 秒高亮与弹出卡里的断点行都读它 ──

export interface HotswapEvent {
  report: HotswapReport;
  /** 重新下发的断点数；null = 还在下发或没附加调试。 */
  breakpoints: number | null;
}

let lastEvent: HotswapEvent | null = null;
const listeners = new Set<() => void>();
const emit = (next: HotswapEvent) => {
  lastEvent = next;
  listeners.forEach((l) => l());
};
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

export function useHotswapEvent(): HotswapEvent | null {
  return useSyncExternalStore(subscribe, () => lastEvent);
}

let started = false;
let refreshStatus: (() => void) | null = null;

/**
 * 让状态栏小签重读状态。设置页改了开关后调：小签只在服务重启或收到事件时才重查，
 * 不刷新的话「关→开」之后小签一直隐藏（缓存里还是 enabled=false）。
 * 设置页不在 QueryClientProvider 里测试，所以走这里而不是 useQueryClient。
 */
export function refreshHotswapStatus(): void {
  refreshStatus?.();
}

/** 订阅后端热替换事件（幂等，整个应用只挂一次）。 */
export function startHotswapEvents(queryClient: QueryClient): void {
  if (started) return;
  started = true;
  const refresh = () => void queryClient.invalidateQueries({ queryKey: HOTSWAP_STATUS_KEY });
  refreshStatus = refresh;
  void listen<HotswapReport>("hotswap-result", (report) => {
    emit({ report, breakpoints: null });
    refresh();
    // 新结果取代旧的失败提醒：再失败会弹新的，成功则不该还挂着「失败」
    dismissHotswapFailure();
    if (report.state === "failed") {
      toast.error(`热替换失败：${failureSummary(report)}。服务上仍是旧代码。`, {
        raw: report.message ?? undefined,
        action: { label: "重启服务", onClick: requestServiceRestart },
        key: FAILURE_TOAST_KEY,
      });
      return;
    }
    if (report.redefined.length === 0) return;
    void reinstallBreakpoints("server").then((n) => {
      if (lastEvent?.report === report) emit({ report, breakpoints: n });
    });
  });
  void listen<number>("hotswap-pending", refresh);
}
