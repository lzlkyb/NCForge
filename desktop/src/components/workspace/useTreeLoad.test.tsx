// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSession, setSession } from "../../lib/workspaceSession";
import { invalidateWorkspaceRequests } from "../../lib/workspaceEpoch";
import { useTreeLoad } from "./useTreeLoad";

const h = vi.hoisted(() => ({ listDir: vi.fn(), encodingMarks: vi.fn(), changed: null as ((payload: { dirs: string[] }) => void) | null }));
vi.mock("../../lib/workspace", async importOriginal => ({
  ...await importOriginal<typeof import("../../lib/workspace")>(),
  listDir: h.listDir, encodingMarks: h.encodingMarks,
}));
vi.mock("../../lib/tauri", () => ({
  listen: async (_event: string, handler: typeof h.changed) => { h.changed = handler; return () => { if (h.changed === handler) h.changed = null; }; },
}));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const A = "D:/tree-a", B = "D:/tree-b";
const java = [{ name: "A.java", isDir: false }];
let host: HTMLDivElement;
let root: Root;
function Probe({ path }: { path: string }) { useTreeLoad(path, false); return null; }
const render = async (path: string) => { await act(async () => { root.render(<Probe path={path} />); }); };
const switchTo = async (path: string) => {
  await act(async () => { invalidateWorkspaceRequests(); setSession({ root: path }); root.render(<Probe path={path} />); });
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  h.listDir.mockReset().mockResolvedValue([]);
  h.encodingMarks.mockReset().mockResolvedValue([]);
  h.changed = null;
  invalidateWorkspaceRequests();
  setSession({ root: A, tree: { root: null, dirs: {}, marks: {}, expanded: new Set() } });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe("目录刷新与工程切换", () => {
  it("旧目录刷新晚到不能写入新工程或启动编码扫描", async () => {
    await render(A);
    const old = deferred<typeof java>();
    h.listDir.mockImplementation(path => path === A ? old.promise : Promise.resolve([]));
    act(() => { h.changed?.({ dirs: [A] }); });
    await switchTo(B);
    await act(async () => { old.resolve(java); });
    expect(getSession().tree.root).toBe(B);
    expect(getSession().tree.dirs[A]).toBeUndefined();
    expect(h.encodingMarks).not.toHaveBeenCalled();
  });

  it("切走再切回来也不能采用旧会话的目录结果", async () => {
    await render(A);
    const old = deferred<typeof java>();
    h.listDir.mockReturnValueOnce(old.promise);
    act(() => { h.changed?.({ dirs: [A] }); });
    await switchTo(B); await switchTo(A);
    await act(async () => { old.resolve(java); });
    expect(getSession().tree.dirs[A]).toEqual({ status: "ok", items: [] });
    expect(h.encodingMarks).not.toHaveBeenCalled();
  });

  it("编码标记返回时再次核对工程归属", async () => {
    const marks = deferred<{ path: string; charset: string }[]>();
    h.listDir.mockResolvedValueOnce(java);
    h.encodingMarks.mockReturnValueOnce(marks.promise);
    await render(A);
    expect(h.encodingMarks).toHaveBeenCalledOnce();
    await switchTo(B);
    await act(async () => { marks.resolve([{ path: `${A}/A.java`, charset: "GBK" }]); });
    expect(getSession().tree.marks).toEqual({});
  });
});
