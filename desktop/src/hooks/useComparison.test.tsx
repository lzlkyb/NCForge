// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useComparison } from "./useComparison";
import type { ResultSnapshot } from "../lib/dbResultTools";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
it("terminates replaced workers and ignores their late replies", async () => {
  const workers: any[] = [];
  class FakeWorker {
    onmessage: any; onerror: any;
    terminate = vi.fn(); postMessage = vi.fn();
    constructor() { workers.push(this); }
  }
  vi.stubGlobal("Worker", FakeWorker);
  const host = document.createElement("div"); const root = createRoot(host);
  let result: any;
  const before = { columns: Array.from({ length: 201 }, (_, i) => `c${i}`), rows: Array.from({ length: 100 }, () => []) } as unknown as ResultSnapshot;
  const after = { ...before, rows: [] };
  const first = ["c0"], second = ["c1"];
  function Probe({ keys }: { keys: string[] }) { result = useComparison(before, after, keys); return null; }
  try {
    await act(async () => root.render(<Probe keys={first} />));
    await act(async () => root.render(<Probe keys={second} />));
    expect(workers[0].terminate).toHaveBeenCalled();
    await act(async () => workers[0].onmessage({ data: { model: null, error: "stale" } }));
    expect(result.error).toBe(""); expect(result.pending).toBe(true);
    await act(async () => workers[1].onmessage({ data: { model: null, error: "current" } }));
    expect(result.error).toBe("current");
    expect(workers[1].terminate).toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});
