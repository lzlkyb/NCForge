// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DebugPanel } from "./DebugPanel";
import { setSession } from "../../lib/workspaceSession";
import type { DapStackFrame } from "../../lib/debug";
import { prepareDebugSourceNavigation } from "../../lib/debugSourceNavigation";
const mocks = vi.hoisted(() => ({ paused: false, stopSeq: 0, frames: [] as DapStackFrame[], frameId: null as number | null }));

vi.mock("../../lib/debugSession", () => ({
  useDebugSnapshot: () => ({
    target: "server",
    // 断点清单只在已附加时渲染，所以这里直接给 attached
    status: {
      target: "server",
      state: "attached",
      module: "nc-forge-shadow",
      dapPort: 5005,
      jdwpPort: 5006,
      jdwpHost: "127.0.0.1",
      message: "",
      exceptionFilters: [{ filter: "caught", label: "Caught Exceptions", default: false }],
    },
    paused: mocks.paused,
    threadId: null,
    threads: [],
    frames: mocks.frames,
    frameId: mocks.frameId,
    scopes: [],
    variables: {},
    watches: [],
    stopSeq: mocks.stopSeq,
    busy: null,
    error: null,
    targets: {
      server: { state: "attached", paused: false, busy: null },
      client: { state: "stopped", paused: false, busy: null },
      remote: { state: "stopped", paused: false, busy: null },
    },
    anyPaused: false,
    stopReason: null,
    stopText: null,
    exception: null,
    console: [],
    enabledFilters: [],
  }),
  attachDebugger: vi.fn(),
  detachDebugger: vi.fn(),
  selectDebugTarget: vi.fn(),
  pauseDebug: vi.fn(),
  resumeDebug: vi.fn(),
  selectFrame: vi.fn(),
  stepDebug: vi.fn(),
  expandVariables: vi.fn(),
  setVariableValue: vi.fn(),
  evaluateConsole: vi.fn(),
  clearConsole: vi.fn(),
  setExceptionFilter: vi.fn(),
  refreshThreadsNow: vi.fn(),
  selectThread: vi.fn(),
  MAX_DEBUG_WATCHES: 12,
  addWatch: vi.fn(),
  removeWatch: vi.fn(),
}));
vi.mock("../../lib/debugKeys", () => ({
  debugKeyLabels: () => ({ resume: "F5", over: "F6", into: "F11", out: "Shift+F11" }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const KEY = "ncforge-breakpoints:c:/p2-ws";
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  mocks.paused = false; mocks.stopSeq = 0; mocks.frames = []; mocks.frameId = null;
  localStorage.clear();
  localStorage.setItem(
    KEY,
    JSON.stringify([
      { path: "C:/p2-ws/a.java", line: 3 },
      { path: "C:/p2-ws/b.java", line: 8 },
    ]),
  );
  const tabs = ["a", "b"].map(name => ({ path: `C:/p2-ws/${name}.java`, name: `${name}.java`, encoding: "UTF-8" as const, hasBom: false, eol: "LF" as const, mtimeMs: 1, dirty: false, eolChanged: false, readOnly: false, readOnlyReason: null, lines: 2 }));
  setSession({ root: "C:/p2-ws", tabs, activePath: "C:/p2-ws/a.java" });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("调试面板的断点清单", () => {
  it("异步栈帧只定位一次，切工具页签重新挂载不重放旧暂停", async () => {
    const open = vi.fn(); prepareDebugSourceNavigation("server", 11);
    mocks.paused = true; mocks.stopSeq = 11;
    await act(async () => root.render(<DebugPanel onOpenAt={open} />)); expect(open).not.toHaveBeenCalled();
    mocks.frameId = 2; mocks.frames = [{ id: 2, name: "method", line: 8, column: 1, source: { path: "C:/p2-ws/b.java" } }];
    await act(async () => root.render(<DebugPanel onOpenAt={open} />)); expect(open).toHaveBeenCalledWith("C:/p2-ws/b.java", 8);
    await act(async () => root.render(null));
    await act(async () => root.render(<DebugPanel onOpenAt={open} />)); expect(open).toHaveBeenCalledTimes(1);
  });
  it("暂停后主动切换源码时，晚到栈帧不抢回旧文件", async () => {
    const open = vi.fn(); prepareDebugSourceNavigation("server", 12);
    mocks.paused = true; mocks.stopSeq = 12;
    await act(async () => root.render(<DebugPanel onOpenAt={open} />));
    setSession({ activePath: "C:/p2-ws/b.java" });
    mocks.frameId = 2; mocks.frames = [{ id: 2, name: "method", line: 3, column: 1, source: { path: "C:/p2-ws/a.java" } }];
    await act(async () => root.render(<DebugPanel onOpenAt={open} />)); expect(open).not.toHaveBeenCalled();
  });
  it("显示当前断点数，点一下清空并落盘", async () => {
    await act(async () => root.render(<DebugPanel onOpenAt={vi.fn()} />));
    const header = document.querySelector(".dbg-bp-col .dbg-col-h");
    expect(header?.textContent).toContain("· 2");
    const clear = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      b.title.includes("清空当前工作区"),
    )!;
    expect(clear.disabled).toBe(false);

    await act(async () => clear.click());
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toEqual([]);
    expect(clear.disabled).toBe(true);
  });
});
