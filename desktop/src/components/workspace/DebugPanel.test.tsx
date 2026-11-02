// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DebugPanel } from "./DebugPanel";
import { setSession } from "../../lib/workspaceSession";

vi.mock("../../lib/debugSession", () => ({
  useDebugSnapshot: () => ({
    status: { state: "stopped", module: null, dapPort: null, jdwpPort: null, message: "" },
    paused: false,
    threadId: null,
    threads: [],
    frames: [],
    frameId: null,
    scopes: [],
    variables: {},
    watches: [],
    stopSeq: 0,
    busy: null,
    error: null,
  }),
  attachDebugger: vi.fn(),
  detachDebugger: vi.fn(),
  pauseDebug: vi.fn(),
  resumeDebug: vi.fn(),
  selectFrame: vi.fn(),
  stepDebug: vi.fn(),
  expandVariables: vi.fn(),
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
  localStorage.clear();
  localStorage.setItem(
    KEY,
    JSON.stringify([
      { path: "C:/p2-ws/a.java", line: 3 },
      { path: "C:/p2-ws/b.java", line: 8 },
    ]),
  );
  setSession({ root: "C:/p2-ws" });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("调试面板的全局断点清理", () => {
  it("显示当前断点数，点一下清空并落盘", async () => {
    await act(async () => root.render(<DebugPanel onOpenAt={vi.fn()} />));
    const clear = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      b.title.includes("清空当前工作区"),
    )!;
    expect(clear.textContent).toContain("（2）");

    await act(async () => clear.click());
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toEqual([]);
    expect(clear.disabled).toBe(true);
  });
});
