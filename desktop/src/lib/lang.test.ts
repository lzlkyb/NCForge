import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const openVirtualModel = vi.fn();

vi.mock("./monacoSetup", () => ({ monaco: { editor: {}, languages: {}, MarkerSeverity: {} } }));
vi.mock("./editorStore", () => ({
  forEachModel: vi.fn(),
  onModelLifecycle: vi.fn(),
  openVirtualModel: (...a: unknown[]) => openVirtualModel(...a),
}));
vi.mock("./tauri", () => ({ invoke: (...a: unknown[]) => invoke(...a), listen: vi.fn() }));
vi.mock("./appConfig", () => ({ getConfig: () => ({}) }));
vi.mock("./workspaceSession", () => ({ getSession: () => ({ root: null }) }));

import { loadJdtSource } from "./lang";

describe("loadJdtSource", () => {
  beforeEach(() => {
    invoke.mockReset();
    openVirtualModel.mockReset();
  });

  it("同一地址只请求一次，但每次都重建只读 model（标签关掉后再跳转不能空白）", async () => {
    invoke.mockResolvedValue("class A {}");
    const uri = "jdt://contents/a.jar/p/A.class";
    await loadJdtSource(uri);
    await loadJdtSource(uri);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(openVirtualModel).toHaveBeenCalledTimes(2);
    expect(openVirtualModel).toHaveBeenLastCalledWith(uri, "class A {}");
  });

  it("请求失败不缓存，下次可重试", async () => {
    const uri = "jdt://contents/b.jar/p/B.class";
    invoke.mockRejectedValueOnce(new Error("boom"));
    await expect(loadJdtSource(uri)).rejects.toThrow();
    invoke.mockResolvedValueOnce("class B {}");
    await loadJdtSource(uri);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
