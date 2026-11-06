// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { ServiceRunToolbar } from "./ServiceRunToolbar";
import type { ServerStatus } from "../../lib/server";

describe("中间件端口冲突操作", () => {
  it("JVM准备中遇到第三方监听仍可停止本次启动", async () => {
    const host = document.createElement("div"), root = createRoot(host), stop = vi.fn();
    const status = { state: "starting", pid: 42, port: 80, portAddress: "127.0.0.1", portOwner: { pid: 99, name: "java.exe" }, portOwnedBySelf: false, debugPort: null } as ServerStatus;
    await act(async () => root.render(<ServiceRunToolbar source="middleware" status={status} busy={null} debugMode={false} onStart={vi.fn()} onStop={stop} onRestart={vi.fn()} onRetry={vi.fn()} debugAttached={false} debugBusy={false} onAttachDebug={vi.fn()} onDetachDebug={vi.fn()} />));
    expect(host.textContent).toContain("端口冲突");
    const button = [...host.querySelectorAll("button")].find(b => b.textContent === "停止启动");
    expect(button).toBeTruthy(); await act(async () => button!.click()); expect(stop).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
  });
});
