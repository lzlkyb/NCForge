import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/tauri", () => ({ invoke: vi.fn(), listen: vi.fn(async () => () => {}) }));
vi.mock("../ui/toast", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

import { chipView } from "./HotswapStatusChip";
import { failureSummary, type HotswapReport, type HotswapStatus } from "../../lib/hotswap";

const report = (p: Partial<HotswapReport>): HotswapReport => ({
  state: "ok", atMs: 1, requested: 1, redefined: [{ name: "a.B", loader: "App" }], notLoaded: [], shadowed: [], requestedNames: ["a.B"],
  code: null, message: null, elapsedMs: 5, ...p,
});
const status = (p: Partial<HotswapStatus>): HotswapStatus => ({
  enabled: true, auto: true, agentOnline: true, agentAttached: true, stale: false, pending: 0, pendingClasses: [],
  last: null, staleReport: null, ...p,
});

describe("热替换小签", () => {
  it("成功后高亮期内显示类数，过了回落成灰色入口", () => {
    const s = status({ last: report({}) });
    expect(chipView(s, false, true)).toMatchObject({ tone: "ok", label: "已替换 1 个类" });
    expect(chipView(s, false, false)).toMatchObject({ tone: "idle", label: "热替换" });
  });
  it("失败与部分生效一直保留，不随高亮期结束", () => {
    expect(chipView(status({ last: report({ state: "failed", code: "unsupported" }) }), false, false).tone).toBe("bad");
    const partial = report({ state: "partial", shadowed: [{ name: "a.C", loader: "App", source: "" }] });
    expect(chipView(status({ last: partial }), false, false)).toMatchObject({ tone: "warn", label: "热替换 · 1 个未生效" });
  });
  it("待推送优先于上次结果；推送中优先于一切", () => {
    const s = status({ pending: 4, last: report({ state: "failed" }) });
    expect(chipView(s, false, false).label).toBe("↑ 待推送 4");
    expect(chipView(s, true, false).tone).toBe("busy");
  });
  it("agent 不在线时区分「准备中」与「未挂载」", () => {
    expect(chipView(status({ agentOnline: false }), false, false).label).toBe("热替换 · 准备中");
    expect(chipView(status({ agentOnline: false, agentAttached: false }), false, false).label).toBe("热替换 · 未挂载");
  });
  it("失败原因：JVM 的英文 unsupported 翻成人话，其余照原文", () => {
    expect(failureSummary(report({ state: "failed", code: "unsupported", message: "attempted to add a method" }))).toContain("改了类的结构");
    expect(failureSummary(report({ state: "failed", code: "verify", message: "校验失败" }))).toBe("校验失败");
  });
});
