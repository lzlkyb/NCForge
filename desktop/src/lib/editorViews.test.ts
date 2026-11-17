// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetEditorViewsForTest,
  createViewReporter,
  flushEditorViews,
  pickRestoreView,
  readEditorView,
  rememberEditorView,
  toRestorableView,
  trimViewState,
} from "./editorViews";

const KEY = "ncforge-editor-views";

/** 一份形如 `editor.saveViewState()` 返回的快照。 */
function view(line = 100, deltaTop = -12) {
  return {
    cursorState: [
      {
        inSelectionMode: false,
        selectionStart: { lineNumber: line, column: 5 },
        position: { lineNumber: line, column: 5 },
      },
    ],
    viewState: { scrollLeft: 0, firstPosition: { lineNumber: line - 20, column: 1 }, firstPositionDeltaTop: deltaTop },
    // 折叠状态：必须在持久化时被丢掉（见下）
    contributionsState: { "editor.contrib.folding": { collapsedRegions: [[1, 40]] } },
  };
}

beforeEach(() => {
  localStorage.clear();
  __resetEditorViewsForTest();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-17T10:00:00Z"));
});

afterEach(() => {
  __resetEditorViewsForTest();
  vi.useRealTimers();
});

describe("视图快照", () => {
  it("存了能读回光标与滚动位置", () => {
    rememberEditorView("C:\\w\\A.java", view(120));
    const snap = readEditorView("c:\\W\\a.java")!;
    expect(snap.cursorState[0].position).toEqual({ lineNumber: 120, column: 5 });
    expect(snap.viewState.firstPosition).toEqual({ lineNumber: 100, column: 1 });
    expect(snap.viewState.firstPositionDeltaTop).toBe(-12);
  });

  it("折叠状态不进快照，恢复时是全部展开", () => {
    rememberEditorView("C:\\w\\A.java", view());
    expect(Object.keys(readEditorView("C:\\w\\A.java")!)).not.toContain("contributionsState");
    expect(toRestorableView(readEditorView("C:\\w\\A.java")!).contributionsState).toEqual({});
  });

  it("没有 firstPosition 就不存（否则 Monaco 会读 undefined 滚回顶部）", () => {
    const broken = { cursorState: view().cursorState, viewState: { scrollLeft: 0, scrollTop: 400 } };
    expect(trimViewState(broken)).toBeNull();
    rememberEditorView("C:\\w\\A.java", broken);
    expect(readEditorView("C:\\w\\A.java")).toBeNull();
  });

  it("光标缺失或行号非法的快照不存", () => {
    expect(trimViewState({ viewState: view().viewState })).toBeNull();
    expect(trimViewState({ cursorState: [], viewState: view().viewState })).toBeNull();
    expect(
      trimViewState({
        cursorState: [{ inSelectionMode: false, selectionStart: { lineNumber: 0, column: 1 }, position: { lineNumber: 0, column: 1 } }],
        viewState: view().viewState,
      }),
    ).toBeNull();
  });

  it("损坏的存储当作没有，不抛错", () => {
    localStorage.setItem(KEY, "{不是 json");
    expect(readEditorView("C:\\w\\A.java")).toBeNull();
    localStorage.setItem(KEY, JSON.stringify({ "c:\\w\\a.java": { viewState: {} } }));
    expect(readEditorView("C:\\w\\A.java")).toBeNull();
  });

  it("不同文件互不影响", () => {    rememberEditorView("C:\\w\\A.java", view(50));
    rememberEditorView("C:\\w\\B.java", view(900));
    expect(readEditorView("C:\\w\\A.java")!.cursorState[0].position.lineNumber).toBe(50);
    expect(readEditorView("C:\\w\\B.java")!.cursorState[0].position.lineNumber).toBe(900);
  });

  it("写盘后模拟重启仍能读到", () => {
    rememberEditorView("C:\\w\\A.java", view(120));
    flushEditorViews();
    __resetEditorViewsForTest(); // 内存清空 = 进程重启
    expect(readEditorView("C:\\w\\A.java")!.cursorState[0].position.lineNumber).toBe(120);
  });

  it("位置没变时不重写（滚动每帧回调，不变就不该产生写盘）", () => {
    rememberEditorView("C:\\w\\A.java", view(120));
    flushEditorViews();
    const first = localStorage.getItem(KEY)!;
    // 换一个更晚的写入时刻：如果真重写了，at 会变
    vi.setSystemTime(new Date("2026-11-17T10:00:05Z"));
    rememberEditorView("C:\\w\\A.java", view(120));
    flushEditorViews();
    expect(localStorage.getItem(KEY)).toBe(first);
  });

  it("超过字节预算时按最旧淘汰，而不是整份丢掉", () => {
    // 每条路径约 2 KB，40 条远超 64 KiB
    const pad = "a".repeat(2000);
    for (let i = 0; i < 40; i++) {
      rememberEditorView(`C:\\w\\${pad}-${i}.java`, view(100 + i));
      vi.setSystemTime(new Date(Date.now() + 1000));
    }
    flushEditorViews();
    const kept = Object.keys(JSON.parse(localStorage.getItem(KEY)!));
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(40);
    // 最新的一定在：淘汰方向反了会让恢复「只剩最老的文件」
    expect(kept.some((p) => p.includes("-39.java"))).toBe(true);
    // 淘汰的是最旧那一端，不是随机挑几个
    expect(kept.some((p) => p.includes("-0.java"))).toBe(false);
    expect(kept.some((p) => p.includes("-5.java"))).toBe(false);
    // 内存也同步删了，下一轮不会又被算进来
    expect(readEditorView(`C:\\w\\${pad}-0.java`)).toBeNull();
  });
});

describe("恢复源选择", () => {
  it("内存里有就优先用内存：同一次运行内切回来不该被磁盘上的旧位置覆盖", () => {
    rememberEditorView("C:\\w\\A.java", view(10));
    flushEditorViews();
    const inMemory = { cursorState: view(999).cursorState, viewState: view(999).viewState, contributionsState: {} };
    expect(pickRestoreView(inMemory, "C:\\w\\A.java")).toBe(inMemory);
  });

  it("内存为空（进程重启）时退到磁盘快照，且折叠状态是空的", () => {
    rememberEditorView("C:\\w\\A.java", view(120));
    flushEditorViews();
    __resetEditorViewsForTest(); // 内存清空 = 重启
    const restored = pickRestoreView(null, "C:\\w\\A.java") as {
      cursorState: { position: { lineNumber: number } }[];
      viewState: { firstPosition: { lineNumber: number } };
      contributionsState: unknown;
    };
    expect(restored.cursorState[0].position.lineNumber).toBe(120);
    expect(restored.viewState.firstPosition.lineNumber).toBe(100);
    expect(restored.contributionsState).toEqual({});
  });

  it("两边都没有时返回 null，让 Monaco 保持默认（不硬造一个位置）", () => {
    expect(pickRestoreView(undefined, "C:\\w\\Nope.java")).toBeNull();
  });
});

describe("节流上报器", () => {  it("连续上报只取一次，flush 保证最后一次落盘", () => {
    const reporter = createViewReporter(300);
    const getState = vi.fn(() => view(10));
    reporter.report("C:\\w\\A.java", getState);
    reporter.report("C:\\w\\A.java", getState);
    reporter.report("C:\\w\\A.java", getState);
    // 第一次立刻取；后两次落在同一个待触发定时器里
    expect(getState).toHaveBeenCalledTimes(1);

    getState.mockReturnValue(view(200));
    vi.advanceTimersByTime(300);
    expect(getState).toHaveBeenCalledTimes(2);
    expect(readEditorView("C:\\w\\A.java")!.cursorState[0].position.lineNumber).toBe(200);
  });

  it("flush 会取消待触发的定时器并立即取最新状态", () => {
    const reporter = createViewReporter(300);
    const getState = vi.fn(() => view(10));
    reporter.report("C:\\w\\A.java", getState);
    getState.mockReturnValue(view(300));
    reporter.report("C:\\w\\A.java", getState); // 进待触发
    reporter.flush("C:\\w\\A.java", getState);
    expect(readEditorView("C:\\w\\A.java")!.cursorState[0].position.lineNumber).toBe(300);
    vi.advanceTimersByTime(1000);
    expect(getState).toHaveBeenCalledTimes(2); // 定时器已被取消，没有第三次
  });

  it("路径为空时什么都不做（没有 model 的编辑器不该写盘）", () => {
    const reporter = createViewReporter(300);
    const getState = vi.fn(() => view());
    reporter.report(null, getState);
    reporter.flush(null, getState);
    expect(getState).not.toHaveBeenCalled();
  });
});
