// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChangeTimelinePanel } from "./ChangeTimelinePanel";
import type { ChangeEvent } from "../../lib/changeTimeline";

const mocks = vi.hoisted(() => ({
  events: [] as ChangeEvent[],
  review: { view: "timeline", round: null, selected: [] as string[], diffPaths: [], startEvent: null, endEvent: null },
  tabs: [] as { path: string; mtimeMs: number; deferred?: boolean; virtual?: string }[],
  restore: vi.fn((_path: string, _id: string, _mtime?: number) => Promise.resolve()),
  selectRound: vi.fn((_ev: ChangeEvent) => Promise.resolve()),
  setDiffScope: vi.fn(),
  toast: vi.fn(),
  recompute: vi.fn(),
  subs: new Set<() => void>(),
  reviewSubs: new Set<() => void>(),
}));

vi.mock("../../lib/changeTimeline", () => ({
  subscribeTimeline: (cb: () => void) => { mocks.subs.add(cb); return () => { mocks.subs.delete(cb); }; },
  getTimeline: () => mocks.events,
  clearTimeline: vi.fn(),
}));
vi.mock("../../lib/reviewSession", () => ({
  subscribeReviewSession: (cb: () => void) => { mocks.reviewSubs.add(cb); return () => { mocks.reviewSubs.delete(cb); }; },
  getReviewState: () => mocks.review,
  selectRound: mocks.selectRound,
  setDiffScope: mocks.setDiffScope,
  setReviewSelected: vi.fn(),
  setReviewView: vi.fn(),
  openTimeline: vi.fn(),
}));
vi.mock("../../lib/localHistory", () => ({ restoreLocalHistory: mocks.restore }));
vi.mock("../../lib/changedLinesStore", () => ({ recomputeChanged: mocks.recompute }));
vi.mock("../../lib/workspaceSession", () => ({ getSession: () => ({ tabs: mocks.tabs, root: "C:\\w" }) }));
vi.mock("../ui/toast", () => ({ toast: mocks.toast }));
vi.mock("../ui/ConfirmDialog", () => ({
  ConfirmDialog: ({ open, onConfirm, confirmLabel }: { open?: boolean; onConfirm: () => void; confirmLabel: string }) =>
    open === false ? null : <div role="dialog"><button onClick={onConfirm}>{confirmLabel}</button></div>,
}));
vi.mock("./MultiFileDiffPanel", () => ({ MultiFileDiffPanel: () => <div data-testid="multi-diff" /> }));
vi.mock("./ReviewChecklist", () => ({ ReviewChecklist: () => <div data-testid="checklist" /> }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

const A = "C:\\w\\modules\\ic\\A.java";
const B = "C:\\w\\modules\\ic\\B.java";

const round = (over: Partial<ChangeEvent> = {}): ChangeEvent => ({
  id: "e1", at: Date.now() - 60_000, kind: "me", paths: [A, B], versions: { [A]: "v1", [B]: "v2" }, ...over,
});

const render = async () => {
  await act(async () => root.render(
    <ChangeTimelinePanel root="C:\\w" activePath={A} onOpenAt={() => {}} />,
  ));
};

const btn = (text: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => (b.textContent ?? "").includes(text));
/** 行内按钮文案会和工具栏重名（「比较」 vs 「比较选中两点」），按全等取。 */
const btnExact = (text: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => (b.textContent ?? "").trim() === text);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.events = [round()];
  mocks.review = { view: "timeline", round: null, selected: [], diffPaths: [], startEvent: null, endEvent: null };
  mocks.tabs = [{ path: A, mtimeMs: 0, deferred: true }, { path: B, mtimeMs: 500 }];
  mocks.restore.mockImplementation(() => Promise.resolve());
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("ChangeTimelinePanel 还原本轮", () => {
  it("延迟标签（mtimeMs=0）不当冲突基准，不传 0 给后端", async () => {
    await render();
    await act(async () => { btn("还原本轮")!.click(); });
    await act(async () => { btn("覆盖并还原")!.click(); });
    await act(async () => {});
    const calls = mocks.restore.mock.calls;
    expect(calls).toHaveLength(2);
    // 内容已加载的标签仍带 mtime 做冲突校验
    expect(calls.find((c) => c[0] === B)).toEqual([B, "v2", 500]);
    // 重启恢复出来的占位标签 mtime 未知：传 undefined，不能传 0（后端必判 CONFLICT）
    expect(calls.find((c) => c[0] === A)).toEqual([A, "v1", undefined]);
    expect(mocks.recompute).toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith("已还原 2/2 个文件到该归档点", "success");
  });

  it("部分失败时列出失败文件与原因，不静默", async () => {
    mocks.restore.mockImplementation((path: string) =>
      path === A ? Promise.reject(new Error("CONFLICT: 磁盘上的文件自你打开后被改过")) : Promise.resolve());
    await render();
    await act(async () => { btn("还原本轮")!.click(); });
    await act(async () => { btn("覆盖并还原")!.click(); });
    await act(async () => {});
    const lastToast = mocks.toast.mock.calls[mocks.toast.mock.calls.length - 1];
    const [message, tone] = lastToast;
    expect(tone).toBe("warning");
    expect(message).toContain("已还原 1/2");
    expect(message).toContain("A.java");
    expect(message).toContain("磁盘被别的途径改过，先刷新再恢复");
  });

  it("没有归档点的轮直接提示去本地历史，不进确认框", async () => {
    mocks.events = [round({ versions: undefined })];
    await render();
    await act(async () => { btn("还原本轮")!.click(); });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("没有归档点"), "info");
    expect(mocks.restore).not.toHaveBeenCalled();
  });
});

describe("ChangeTimelinePanel 变更后快照轮", () => {
  it("标出「变更后」，选轮时剥掉不能当轮前基线的 versions", async () => {
    mocks.events = [round({ post: true })];
    await render();
    const badge = [...container.querySelectorAll(".ncf-kind")].find((n) => n.textContent === "变更后");
    expect(badge).toBeTruthy();
    expect(badge!.getAttribute("title")).toContain("不能当轮前基线");
    await act(async () => { btn("选这一轮")!.click(); });
    expect(mocks.selectRound).toHaveBeenCalledTimes(1);
    const passed = mocks.selectRound.mock.calls[0][0] as ChangeEvent;
    expect(passed.versions).toBeUndefined();
    expect(passed.id).toBe("e1");
  });

  it("非 post 轮的 versions 原样传给选轮", async () => {
    await render();
    await act(async () => { btn("选这一轮")!.click(); });
    const passed = mocks.selectRound.mock.calls[0][0] as ChangeEvent;
    expect(passed.versions).toEqual({ [A]: "v1", [B]: "v2" });
  });

  it("post 轮比较时退化为 SVN 基线，不拿变更后快照当 A 点", async () => {
    mocks.events = [round({ kind: "history", post: true })];
    await render();
    await act(async () => { btnExact("比较")!.click(); });
    expect(mocks.setDiffScope).toHaveBeenCalledWith([A, B], null, null);
  });

  it("普通归档轮比较时仍用自己做 A 点", async () => {
    mocks.events = [round({ kind: "history" })];
    await render();
    await act(async () => { btnExact("比较")!.click(); });
    expect(mocks.setDiffScope).toHaveBeenCalledWith([A, B], expect.objectContaining({ id: "e1" }), null);
  });
});
