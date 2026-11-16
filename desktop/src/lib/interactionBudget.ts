/**
 * 交互延迟采样（仅 dev 构建启用）。
 *
 * 为什么需要：设计契约 R3 给了延迟预算（编辑回显 p95 ≤ 50ms、面板 ≤ 100ms、
 * 切换 ≤ 150ms），但预算必须能被测，否则只是一句话。这里用最轻的方式采集：
 * keydown/动作触发时打一个 performance.now()，在「下一帧绘制完成」时结算。
 *
 * rAF + setTimeout(0) 而不是单 rAF：单 rAF 回调在**绘制之前**执行，测不到上屏；
 * 套一层 setTimeout 让回调排在当前帧的渲染之后，才接近用户感知的延迟。
 *
 * 环形缓冲 + 上限 500 条：长期挂着的 dev 会话不会把内存吃满。
 * 生产构建不 install（见 main.tsx 的 import.meta.env.DEV 判断），零成本。
 */

export type InteractionKind = "keydown" | "command" | "tab-switch" | "drag";

export type InteractionSample = { kind: InteractionKind; ms: number; at: number };

export type InteractionSummary = { n: number; p50: number; p95: number; max: number };

const CAP = 500;

let samples: InteractionSample[] = [];
let installed = false;

/** 最近秩百分位：p95 取「第 95% 个样本」，不做插值，便于人工核对。 */
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

export function summarize(list: InteractionSample[]): Record<string, InteractionSummary> {
  const grouped = new Map<string, number[]>();
  for (const s of list) {
    if (!Number.isFinite(s.ms) || s.ms < 0) continue;
    const arr = grouped.get(s.kind) ?? [];
    arr.push(s.ms);
    grouped.set(s.kind, arr);
  }
  const out: Record<string, InteractionSummary> = {};
  for (const [kind, values] of grouped) {
    out[kind] = {
      n: values.length,
      p50: Math.round(percentile(values, 50)),
      p95: Math.round(percentile(values, 95)),
      max: Math.round(Math.max(...values)),
    };
  }
  return out;
}

export function record(kind: InteractionKind, ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  samples.push({ kind, ms, at: Date.now() });
  if (samples.length > CAP) samples = samples.slice(-CAP);
}

export function snapshot(): { samples: InteractionSample[]; summary: Record<string, InteractionSummary> } {
  return { samples: [...samples], summary: summarize(samples) };
}

export function clear(): void {
  samples = [];
}

/** 从「动作开始」到「绘制完成」结算一次。调用方负责传开始时间。 */
export function settle(kind: InteractionKind, startedAt: number): void {
  const done = () => record(kind, performance.now() - startedAt);
  if (typeof requestAnimationFrame !== "function") {
    setTimeout(done, 0);
    return;
  }
  requestAnimationFrame(() => setTimeout(done, 0));
}

/** 包住一次同步动作：handler 执行完开始计时结算（含本次渲染）。 */
export function measure<T>(kind: InteractionKind, action: () => T): T {
  const startedAt = performance.now();
  const result = action();
  settle(kind, startedAt);
  return result;
}

export function installInteractionBudget(): void {
  if (installed) return;
  installed = true;

  // capture 阶段：先于应用自己的 handler 开始计时，避免把业务逻辑漏在预算外。
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.repeat || event.isComposing) return;
      const startedAt = performance.now();
      requestAnimationFrame(() => setTimeout(() => record("keydown", performance.now() - startedAt), 0));
    },
    { capture: true, passive: true },
  );

  (window as unknown as { __ncInteraction?: unknown }).__ncInteraction = {
    snapshot,
    clear,
    version: 1,
  };
}
