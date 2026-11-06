// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkbenchAutoLayout } from "./useWorkbenchAutoLayout";
import { getWorkbenchLayout, restoreWorkbenchLayout, updateWorkbenchLayout } from "../lib/workbenchLayout";
import { setSession } from "../lib/workspaceSession";
import type { CompileResult } from "../lib/compile";

const mocks = vi.hoisted(() => ({ debug: { target: "server", stopSeq: 0, paused: false, targets: { server: { paused: false }, client: { paused: false }, remote: { paused: false } } } }));
vi.mock("../lib/debugSession", () => ({ useDebugSnapshot: () => mocks.debug }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const result = (ok = false): CompileResult => ({ ok, durationMs: 1, sourceCount: 1, errorCount: ok ? 0 : 1, warningCount: 0, problems: [], diagnostics: [], jarCount: 0, rounds: 1, outDir: "D:/project/classes" });
let host: HTMLDivElement, root: Root;
function Probe({ enabled }: { enabled: boolean }) { useWorkbenchAutoLayout(enabled); return null; }
const render = (enabled = true) => act(() => root.render(<Probe enabled={enabled} />));
beforeEach(() => {
  restoreWorkbenchLayout(); setSession({ compileResult: null });
  mocks.debug = { target: "server", stopSeq: 0, paused: false, targets: { server: { paused: false }, client: { paused: false }, remote: { paused: false } } };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); restoreWorkbenchLayout(); setSession({ compileResult: null }); });

describe("工作台自动布局", () => {
  it("历史失败与成功不改变布局，新的失败才进入排错", () => {
    setSession({ compileResult: result() }); render();
    expect(getWorkbenchLayout().mode).toBe("code");
    act(() => setSession({ compileResult: result(true) }));
    expect(getWorkbenchLayout().mode).toBe("code");
    act(() => setSession({ compileResult: result() }));
    expect(getWorkbenchLayout().mode).toBe("diagnose");
  });
  it("锁定阻止编译失败与新的暂停改写布局", () => {
    updateWorkbenchLayout({ locked: true }); render();
    act(() => setSession({ compileResult: result() }));
    mocks.debug = { ...mocks.debug, stopSeq: 1, paused: true, targets: { ...mocks.debug.targets, server: { paused: true } } }; render();
    expect(getWorkbenchLayout().mode).toBe("code");
    updateWorkbenchLayout({ locked: false }); render();
    expect(getWorkbenchLayout().mode).toBe("code");
  });
  it("切到旧暂停目标不切布局，当前目标新的暂停才进入调试", () => {
    mocks.debug.targets.client.paused = true; render();
    mocks.debug = { ...mocks.debug, target: "client", stopSeq: 4, paused: true }; render();
    expect(getWorkbenchLayout().mode).toBe("code");
    mocks.debug = { ...mocks.debug, target: "server", stopSeq: 0, paused: false }; render();
    mocks.debug = { ...mocks.debug, target: "client", stopSeq: 4, paused: true }; render();
    expect(getWorkbenchLayout().mode).toBe("code");
    mocks.debug = { ...mocks.debug, stopSeq: 5 }; render();
    expect(getWorkbenchLayout().mode).toBe("debug");
  });
  it("尚未访问的目标从运行变为首次暂停时进入调试", () => {
    render();
    mocks.debug = { ...mocks.debug, target: "remote", stopSeq: 1, paused: true, targets: { ...mocks.debug.targets, remote: { paused: true } } }; render();
    expect(getWorkbenchLayout().mode).toBe("debug");
  });
  it("其他工具页的完成与暂停不切布局，回到代码也不重放旧事件", () => {
    render(false);
    act(() => setSession({ compileResult: result() }));
    mocks.debug = { ...mocks.debug, stopSeq: 1, paused: true, targets: { ...mocks.debug.targets, server: { paused: true } } }; render(false);
    expect(getWorkbenchLayout().mode).toBe("code"); render();
    expect(getWorkbenchLayout().mode).toBe("code");
    mocks.debug = { ...mocks.debug, stopSeq: 2 }; render();
    expect(getWorkbenchLayout().mode).toBe("debug");
  });
});
