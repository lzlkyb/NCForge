// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), remember: vi.fn() }));
vi.mock("../lib/appConfig", () => ({ getConfig: mocks.get, patchConfig: mocks.patch, rememberAutoCompile: mocks.remember }));
import { useAutoCompilePref } from "./useAutoCompilePref";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("自动编译保存失败保留原值并提供同值重试，成功后同步缓存", async () => {
  mocks.get.mockResolvedValue({ auto_compile: true });
  mocks.patch.mockRejectedValueOnce(new Error("只读配置")).mockResolvedValue({ auto_compile: false });
  const host = document.createElement("div");
  const root = createRoot(host);
  let state!: ReturnType<typeof useAutoCompilePref>;
  function Harness() { state = useAutoCompilePref(); return null; }
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => state.save(false));
    expect(state.value).toBe(true);
    expect(state.feedback.error).toContain("只读配置");
    expect(mocks.remember).not.toHaveBeenCalled();
    await act(async () => state.feedback.onRetry());
    expect(state.value).toBe(false);
    expect(mocks.remember).toHaveBeenCalledWith(false);
    expect(state.feedback.saved).toBe(true);
    expect(mocks.patch).toHaveBeenNthCalledWith(2, { auto_compile: false });
  } finally { await act(async () => root.unmount()); }
});
