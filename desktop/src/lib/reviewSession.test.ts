// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 审查会话的三类回归（2026-11-11 报告 §6 要求）：
 * - 挂载时序：不打开「改动」页签时点「核对」也要生效（P0-1）；
 * - 事件采集：App 启动接线后，外部写入在面板首次挂载之前就进时间线（P0-2）；
 * - 状态持久：视图 / 勾选 / 比较范围不随组件卸载丢失（P1-8）。
 *
 * 重依赖一律打桩：这里只测「状态与接线」，不拉起 Tauri / Monaco / SVN。
 */
const h = vi.hoisted(() => ({
  setSession: vi.fn(),
  reveal: vi.fn(),
  recompute: vi.fn(),
  setRound: vi.fn(),
  ext: [] as ((paths: readonly string[]) => void)[],
  saves: [] as ((path: string) => void)[],
  hist: [] as ((path: string, id: string) => void)[],
  listHistory: vi.fn((path: string) =>
    Promise.resolve(path.endsWith(".java")
      ? [{ id: "v1", ts: Date.now(), size: 1, note: "" }]
      : [])),
  /** 启动时序：root / 标签是异步恢复的，这里做成可推进的快照。 */
  session: { tabs: [] as { path: string }[], root: null as string | null },
  subs: [] as (() => void)[],
}));

vi.mock("./workspaceSession", () => ({
  getSession: () => h.session,
  setSession: h.setSession,
  subscribe: (cb: () => void) => { h.subs.push(cb); return () => {}; },
}));
vi.mock("./workbenchLayout", () => ({ revealWorkbenchPanel: h.reveal }));
vi.mock("./externalJavaChanges", () => ({
  onExternalJavaChanged: (cb: (paths: readonly string[]) => void) => { h.ext.push(cb); return () => {}; },
}));
vi.mock("./localSaves", () => ({
  onLocalSave: (cb: (path: string) => void) => { h.saves.push(cb); return () => {}; },
}));
vi.mock("./localHistory", () => ({
  onLocalHistoryCaptured: (cb: (path: string, id: string) => void) => { h.hist.push(cb); return () => {}; },
  listLocalHistory: h.listHistory,
  readLocalHistory: vi.fn(() => Promise.resolve({ text: null, size: 0, truncated: false, ts: 0 })),
}));
vi.mock("./reviewMarks", () => ({ initReviewMarks: vi.fn() }));
vi.mock("./changedLinesStore", () => ({
  recomputeChanged: h.recompute,
  setRoundBaselines: h.setRound,
}));

import {
  getReviewState, initReviewSession, isBlockReviewed, markBlockReviewed,
  openChecklist, resetReviewSession, reviewedCount, setDiffScope, setReviewSelected, setReviewView,
} from "./reviewSession";
import { getTimeline, resetChangeTimeline } from "./changeTimeline";
import { computeChanged } from "./changedLines";

beforeEach(() => {
  resetReviewSession();
  resetChangeTimeline();
  h.setSession.mockClear();
  h.reveal.mockClear();
  h.recompute.mockClear();
  h.setRound.mockClear();
  h.ext.length = 0;
  h.saves.length = 0;
  h.hist.length = 0;
  h.listHistory.mockClear();
  h.session = { tabs: [], root: null };
  h.subs.length = 0;
});

describe("审查会话 store", () => {
  it("P0-1 回归：未挂载任何面板时点「核对」也能切页、展开、进清单视图", () => {
    const seen: string[] = [];
    const onNav = (e: Event) => seen.push((e as CustomEvent<string>).detail);
    window.addEventListener("ncforge-navigate", onNav);
    openChecklist();
    window.removeEventListener("ncforge-navigate", onNav);
    expect(seen).toEqual(["files"]);
    expect(h.setSession).toHaveBeenCalledWith({ panelOpen: true, panelTab: "changes" });
    expect(h.reveal).toHaveBeenCalledWith("changes");
    expect(getReviewState().view).toBe("checklist");
  });

  it("P0-2 回归：启动接线后，外部写入在面板首次挂载前就被采集", () => {
    initReviewSession();
    expect(h.ext.length).toBe(1);
    expect(h.saves.length).toBe(1);
    expect(h.hist.length).toBe(1);
    h.ext[0](["D:/w/A.java", "D:/w/B.xml"]);
    expect(getTimeline()).toHaveLength(1);
    expect(getTimeline()[0].paths).toEqual(["D:/w/A.java", "D:/w/B.xml"]);
    expect(getTimeline()[0].kind).toBe("external");
  });

  it("initReviewSession 幂等，不会重复订阅事件源", () => {
    initReviewSession();
    initReviewSession();
    expect(h.ext.length).toBe(1);
  });

  it("冷启动回归：标签恢复晚于 initReviewSession 时，启动回填仍会发生", async () => {
    initReviewSession();
    // 启动瞬间 root 还没到位：活标签与持久快照都读不到，改为等标签恢复
    expect(h.subs.length).toBe(1);
    h.session = { tabs: [{ path: "D:/w/A.java" }], root: "D:/w" };
    h.subs[0]();
    await Promise.resolve();
    await Promise.resolve();
    const events = getTimeline();
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("history");
    expect(events[0].paths).toEqual(["D:/w/A.java"]);
    expect(events[0].versions).toEqual({ "D:/w/A.java": "v1" });
    expect(events[0].label).toContain("启动回填");
    // 已回填过：后续会话变化不再重打 IPC，也不会再插一轮
    h.subs[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.listHistory).toHaveBeenCalledTimes(1);
    expect(getTimeline()).toHaveLength(1);
  });

  it("P1-8 回归：视图 / 比较范围 / 勾选存在 store，模拟组件卸载再读仍在", () => {
    setReviewView("diff");
    setDiffScope(["a.java", "b.xml"], null, null);
    setReviewSelected(["e1", "e2"]);
    // 组件卸载再挂载只会重新订阅同一个 store，状态不归零
    const after = getReviewState();
    expect(after).toMatchObject({ view: "diff", diffPaths: ["a.java", "b.xml"], selected: ["e1", "e2"] });
  });

  it("块级已审按内容指纹：同一块稳定，文件再改即失效", () => {
    const snap = computeChanged("a\nb\nc\n", "a\nB\nc\n");
    const block = snap.blocks[0];
    expect(isBlockReviewed("D:/w/A.java", block)).toBe(false);
    expect(markBlockReviewed("D:/w/A.java", block, true)).toBe(true);
    expect(reviewedCount("D:/w/A.java", snap.blocks)).toBe(1);
    expect(markBlockReviewed("D:/w/A.java", block)).toBe(false);
    const edited = computeChanged("a\nb\nc\n", "a\nB2\nc\n");
    expect(isBlockReviewed("D:/w/A.java", edited.blocks[0])).toBe(false);
  });
});
