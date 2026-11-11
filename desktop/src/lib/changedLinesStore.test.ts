import { beforeEach, describe, expect, it, vi } from "vitest";

/** svnDiff 是唯一的 IPC；外部事件与会话只用到纯注册 / 读取，打桩即可。 */
vi.mock("./svn", () => ({
  svnDiff: vi.fn(() => Promise.resolve({
    baseText: "a\nb\nc\n", workingText: "a\nB\nc\n",
    encoding: "UTF-8", eol: "LF", baseEmpty: false,
    baseSize: 6, workingSize: 6, editable: true,
  })),
}));
vi.mock("./externalJavaChanges", () => ({ onExternalJavaChanged: () => () => {} }));
vi.mock("./workspaceSession", () => ({ getSession: () => ({ activePath: null, root: null }) }));

import {
  getEffectiveBaseline, getSnapshotFor, invalidateBaselines, publishSnapshot,
  requestBaseline, resetChangedLines, setRoundBaselines, subscribeBaseline,
  subscribeSnapshot,
} from "./changedLinesStore";
import { EMPTY_CHANGED } from "./changedLines";
import { svnDiff } from "./svn";

const path = "D:/work/src/A.java";

beforeEach(() => {
  resetChangedLines();
  vi.mocked(svnDiff).mockClear();
});

describe("changedLinesStore 基线层", () => {
  it("P0-3 回归：SVN 写操作后清缓存，色条基线立即失效而不是留着旧 BASE", async () => {
    requestBaseline(path);
    await vi.waitFor(() => expect(getEffectiveBaseline(path)?.state).toBe("ok"));
    expect(getEffectiveBaseline(path)?.baseText).toBe("a\nb\nc\n");

    const notified = vi.fn();
    const off = subscribeBaseline(notified);
    invalidateBaselines();
    off();
    expect(notified).toHaveBeenCalled();
    // 缓存没了 → 装饰层会重新 requestBaseline；提交后的 +9 −4 不会一直挂着
    expect(getEffectiveBaseline(path)).toBeUndefined();
  });

  it("轮基线覆盖 SVN BASE，切回后恢复", async () => {
    requestBaseline(path);
    await vi.waitFor(() => expect(getEffectiveBaseline(path)?.state).toBe("ok"));
    const svnRef = getEffectiveBaseline(path);
    setRoundBaselines(new Map([[path, "a\nb\n"]]));
    expect(getEffectiveBaseline(path)).toMatchObject({ baseText: "a\nb\n", label: "本轮前" });
    expect(getEffectiveBaseline(path)).not.toBe(svnRef);
    setRoundBaselines(new Map());
    expect(getEffectiveBaseline(path)).toMatchObject({ baseText: "a\nb\nc\n", label: "SVN 基线" });
  });

  it("effective 是稳定引用，供给 useSyncExternalStore 不会每次读取换对象", () => {
    const a = getEffectiveBaseline(path);
    const b = getEffectiveBaseline(path);
    expect(a).toBe(b);
  });

  it("P2 回归：快照引用没变且改动行内容没变时不重复广播", () => {
    const notified = vi.fn();
    const off = subscribeSnapshot(notified);
    const snap = { ...EMPTY_CHANGED, added: 1, addedLines: [2], touchedLines: [2] };
    publishSnapshot(path, snap, [{ line: 2, text: "B" }]);
    expect(notified).toHaveBeenCalledTimes(1);
    publishSnapshot(path, snap, [{ line: 2, text: "B" }]);
    expect(notified).toHaveBeenCalledTimes(1);
    publishSnapshot(path, snap, [{ line: 2, text: "B2" }]);
    expect(notified).toHaveBeenCalledTimes(2);
    off();
    expect(getSnapshotFor(path)).toBe(snap);
  });
});
