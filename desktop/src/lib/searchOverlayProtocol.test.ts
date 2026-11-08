import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("./tauri", () => ({ invoke: mocks.invoke, listen: vi.fn() }));
vi.mock("./operations", () => ({ trackOperation: vi.fn() }));
vi.mock("./workspaceSession", () => ({ getSession: () => ({ root: "root" }) }));
import { searchWorkspace, setOverlayProvider, type SearchOptions } from "./search";
it("transmits each revision once and recovers a backend eviction using the captured snapshot", async () => {
  const doc = { path: "A.java", text: "old", revision: "test-v1" };
  setOverlayProvider(() => [doc]);
  mocks.invoke.mockResolvedValue({ hits: [] });
  await searchWorkspace({} as SearchOptions);
  expect(mocks.invoke.mock.calls[0][1].options.overlay).toEqual([doc]);
  mocks.invoke.mockRejectedValueOnce("OVERLAY_CACHE_MISS").mockResolvedValueOnce({ hits: [] });
  await searchWorkspace({} as SearchOptions);
  expect(mocks.invoke.mock.calls[1][1].options.overlay).toEqual([]);
  expect(mocks.invoke.mock.calls[2][1].options.overlay).toEqual([doc]);
  expect(mocks.invoke.mock.calls[2][1].overlayRefs).toEqual([{ path: "A.java", key: "test-v1" }]);
  setOverlayProvider(null);
});
