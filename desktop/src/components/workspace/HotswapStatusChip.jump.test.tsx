// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/tauri", () => ({ invoke: vi.fn(), listen: vi.fn(async () => () => {}) }));
vi.mock("../ui/toast", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));
vi.mock("../../hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => true }));
vi.mock("../../lib/server", () => ({ serverStatus: vi.fn(async () => ({ state: "running", runId: "run-1" })) }));
vi.mock("../../lib/hotswap", () => ({
  HOTSWAP_STATUS_KEY: ["hotswap-status"],
  dismissHotswapFailure: vi.fn(),
  failureSummary: vi.fn(() => ""),
  hotswapClearPending: vi.fn(async () => {}),
  hotswapPushPending: vi.fn(async () => {}),
  hotswapStatus: vi.fn(async () => ({
    enabled: true, auto: true, agentOnline: false, agentAttached: false, stale: false,
    pending: 0, pendingClasses: [], last: null, staleReport: null,
    client: { running: false, agentOnline: false, agentAttached: false, stale: false },
  })),
  shortClassName: vi.fn((name: string) => name),
  startHotswapEvents: vi.fn(() => () => {}),
  useHotswapEvent: () => null,
}));

import { HotswapStatusChip } from "./HotswapStatusChip";
import { clearSettingsRequest, getSettingsRequest } from "../../lib/settingsJump";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

beforeEach(async () => {
  clearSettingsRequest();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(<QueryClientProvider client={client}><HotswapStatusChip /></QueryClientProvider>));
  await flush();
  await flush();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  client.clear();
  clearSettingsRequest();
});

describe("热替换状态泡设置入口", () => {
  it("设置跳到编译与热替换分类的热替换行", async () => {
    const chip = host.querySelector<HTMLButtonElement>("button.wb-status-chip");
    expect(chip).not.toBeNull();
    await act(async () => chip!.click());
    const navigate = vi.fn();
    window.addEventListener("ncforge-navigate", navigate);
    const settings = [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] button')].find(b => b.textContent === "设置")!;
    await act(async () => settings.click());
    window.removeEventListener("ncforge-navigate", navigate);
    expect(getSettingsRequest()).toMatchObject({ section: "编译与热替换", itemId: "build-hotswap" });
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ detail: "settings" }));
  });
});