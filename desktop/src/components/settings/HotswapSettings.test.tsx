// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ status: vi.fn(), push: vi.fn() }));
vi.mock("../../lib/appConfig", () => ({ getConfig: async () => ({ hotswap_enabled: true, hotswap_auto: true }), patchConfig: vi.fn() }));
vi.mock("../../lib/hotswap", () => ({ hotswapStatus: mocks.status, hotswapPushPending: mocks.push, refreshHotswapStatus: vi.fn() }));
import { HotswapSettings } from "./HotswapSettings";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("未知状态不声称没有待推送类，代理就绪且有待推类时才能推送", async () => {
  mocks.status.mockRejectedValueOnce(new Error("unavailable")).mockResolvedValueOnce({ agentOnline: false, agentAttached: true, pending: 3 }).mockResolvedValueOnce({ agentOnline: true, agentAttached: true, pending: 3 });
  const host = document.createElement("div");document.body.append(host);
  const root = createRoot(host);
  const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === text)!;
  try {
    await act(async () => root.render(<HotswapSettings />));
    const row = host.querySelector("#build-hotswap-live")!;
    expect(row.textContent).toContain("状态未知");
    expect(row.textContent).not.toContain("没有待推送");
    expect(button("立即推送").disabled).toBe(true);
    await act(async () => button("重新读取状态").click());
    expect(row.textContent).toContain("代理就绪后可推送");
    expect(button("立即推送").disabled).toBe(true);
    await act(async () => button("重新读取状态").click());
    expect(button("立即推送").disabled).toBe(false);
  } finally { await act(async () => root.unmount());host.remove(); }
});
