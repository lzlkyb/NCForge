import { beforeEach, describe, expect, it, vi } from "vitest";

// editorStore 会拉进 monaco（几 MB，且 node 环境跑不动）。这个仓库只依赖它的
// dirty 事件，换成假实现即可，顺便能手动触发事件验证同步逻辑。
const dirty = vi.hoisted(() => ({
  handler: null as ((path: string, dirty: boolean) => void) | null,
}));

vi.mock("./editorStore", () => ({
  onDirtyChange: (cb: (path: string, d: boolean) => void) => {
    dirty.handler = cb;
    return () => {};
  },
}));

const { getSession, setSession, subscribe } = await import("./workspaceSession");

function tab(path: string) {
  return {
    path,
    name: path.split(/[\\/]/).pop() ?? path,
    encoding: "UTF-8" as const,
    hasBom: false,
    eol: "CRLF" as const,
    mtimeMs: 0,
    dirty: false,
    eolChanged: false,
    readOnly: false,
    readOnlyReason: null,
    lines: 1,
  };
}

beforeEach(() => {
  setSession({
    root: "C:\\work\\newar",
    tabs: [],
    activePath: null,
    panelOpen: true,
    panelTab: "problems",
    compiling: false,
    compileResult: null,
    compileLog: [],
  });
});

describe("workspaceSession 仓库", () => {
  it("函数 updater 拿到上一版的值", () => {
    setSession({ tabs: [tab("a.java")] });
    setSession({ tabs: (prev) => [...prev, tab("b.java")] });
    expect(getSession().tabs.map((t) => t.path)).toEqual(["a.java", "b.java"]);
  });

  it("值没变就不广播（同一数组引用不触发重渲染）", () => {
    const tabs = [tab("a.java")];
    setSession({ tabs });
    const seen = vi.fn();
    const off = subscribe(seen);
    setSession({ tabs: (prev) => prev });
    setSession({ tabs });
    expect(seen).not.toHaveBeenCalled();
    off();
  });

  it("一次 patch 改多个字段只广播一次", () => {
    const seen = vi.fn();
    const off = subscribe(seen);
    setSession({ activePath: "a.java", panelOpen: false, compiling: true });
    expect(seen).toHaveBeenCalledTimes(1);
    off();
  });

  it("未保存圆点跟着 editorStore 的 dirty 事件翻转", () => {
    setSession({ tabs: [tab("a.java"), tab("b.java")] });
    dirty.handler?.("b.java", true);
    expect(getSession().tabs.map((t) => t.dirty)).toEqual([false, true]);
    dirty.handler?.("b.java", false);
    expect(getSession().tabs.map((t) => t.dirty)).toEqual([false, false]);
  });

  it("dirty 事件指向已关闭的文件时不广播", () => {
    setSession({ tabs: [tab("a.java")] });
    const seen = vi.fn();
    const off = subscribe(seen);
    dirty.handler?.("gone.java", true);
    expect(seen).not.toHaveBeenCalled();
    off();
  });
});
