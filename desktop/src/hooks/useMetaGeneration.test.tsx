// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { metaGenerationPlan } from "../test/metaGenerationFixture";
import type { BmfGenDiff } from "../lib/bmf";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../lib/tauri", () => ({ invoke: mocks.invoke }));
import { useMetaGeneration } from "./useMetaGeneration";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement, api: ReturnType<typeof useMetaGeneration>;
const diff = (ms: number): BmfGenDiff => ({ items: [], manifest: null, timings: { ...metaGenerationPlan.timings, diffMs: ms } });
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>((r) => { resolve = r; }), resolve }; }
function Harness() { api = useMetaGeneration("D:/workspace/METADATA/demo.bmf"); return <div>{api.root}</div>; }
beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation((command: string) => {
    if (command === "bmf_generate_plan") return Promise.resolve(metaGenerationPlan);
    if (command === "bmf_validate") return Promise.resolve([]);
    if (command === "bmf_gen_diff") return Promise.resolve(diff(1));
    if (command === "bmf_gen_apply") return Promise.resolve({ written: 1, skipped: 0, manifest: "manifest", items: [] });
    throw new Error(`unexpected ${command}`);
  });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
it("落盘目录快速变化时，迟到的旧漂移结果不能覆盖新目录", async () => {
  await act(async () => root.render(<Harness />));
  const old = deferred<BmfGenDiff>(), fresh = deferred<BmfGenDiff>();
  mocks.invoke.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => fresh.promise);
  act(() => api.setRoot("D:/workspace/a"));
  act(() => api.setRoot("D:/workspace/b"));
  await act(async () => fresh.resolve(diff(2)));
  await act(async () => old.resolve(diff(99)));
  expect(api.root).toBe("D:/workspace/b"); expect(api.diffMs).toBe(2);
});
it("校验读取失败仍可预览产物，但不能写入磁盘", async () => {
  mocks.invoke.mockImplementation((command: string) => {
    if (command === "bmf_generate_plan") return Promise.resolve(metaGenerationPlan);
    if (command === "bmf_validate") return Promise.reject(new Error("校验读取失败"));
    if (command === "bmf_gen_diff") return Promise.resolve(diff(1));
    throw new Error(`unexpected ${command}`);
  });
  await act(async () => root.render(<Harness />));
  expect(api.plan).toBe(metaGenerationPlan);
  await act(async () => api.apply(new Set(["vo"])));
  expect(api.err).toContain("规则校验未完成");
  expect(mocks.invoke.mock.calls.some(([command]) => command === "bmf_gen_apply")).toBe(false);
});
