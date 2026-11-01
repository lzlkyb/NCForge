// jdt.ls 的诊断快照（只读小仓库）。
//
// 这些诊断本来只写成 Monaco 的波浪线：界面上有黄线，但「问题」面板里看不到，
// 于是同一件事有两套说法——面板说「没有发现问题」，代码里却满屏波浪线。
// 这里把最新一批诊断摊平成数组，面板与「跳到下一处」共用同一份。
//
// 与 `lib/lang.ts` 的分工：那边负责把 `textDocument/publishDiagnostics` 收下来、
// 按「服务安静下来」的时机刷标记；这里只管给 React 一个稳定的快照。
import { useSyncExternalStore } from "react";

export type DiagSeverity = "error" | "warning" | "info";

/** 一条代码检查问题。行列都是 1 基（与编辑器、面板一致）。 */
export interface CodeDiag {
  path: string;
  line: number;
  column: number;
  severity: DiagSeverity;
  message: string;
}

let items: CodeDiag[] = [];
/** 上次发布的内容签名。诊断每存一次盘就可能重发一遍，没变时不能换引用。 */
let signature = "";
const listeners = new Set<() => void>();

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

/**
 * 发布一批诊断。
 *
 * 内容没变就**不换引用**：`useSyncExternalStore` 的快照一旦每次都是新数组，
 * 订阅方会无限重渲染（这个坑在 SQL 片段库那边踩过一次）。
 */
export function setCodeDiags(next: CodeDiag[]): void {
  const sig = next.map((d) => `${d.path.toLowerCase()}|${d.line}|${d.severity}|${d.message}`).join("\n");
  if (sig === signature) return;
  signature = sig;
  items = next;
  listeners.forEach((l) => l());
}

export function getCodeDiags(): CodeDiag[] {
  return items;
}

export function useCodeDiags(): CodeDiag[] {
  return useSyncExternalStore(subscribe, getCodeDiags, getCodeDiags);
}

/**
 * 非 React 侧订阅（Error Lens 的装饰器用）。
 *
 * 与 `useCodeDiags` 同一个数据源、同一套「内容不变不换引用」的规则，
 * 只是不给组件用——Monaco 的装饰集合不是 React 状态。
 */
export const subscribeCodeDiags = subscribe;
