// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceAlerts } from "./ServiceAlerts";
import type { ServerStatus } from "../../lib/server";
import type { HotswapReport, HotswapStatus } from "../../lib/hotswap";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const report = (target: "server" | "client", state: "failed" | "partial" = "failed"): HotswapReport => ({
  state, atMs: 1, requested: 2, redefined: [], notLoaded: [], code: "unsupported", message: null, elapsedMs: 0,
  requestedNames: [], target,
  shadowed: state === "partial" ? [{ name: "a.Foo", loader: "app", source: "D:/w/out" }] : [],
});

const hotswap = (staleReport: HotswapReport): HotswapStatus => ({
  enabled: true, auto: true, agentOnline: true, agentAttached: true, stale: true, pending: 0, pendingClasses: [],
  last: null, staleReport, client: { running: true, agentOnline: true, agentAttached: true, stale: true },
});

const running = { state: "running", projectRoot: "D:/w", portOwner: null, port: 80 } as unknown as ServerStatus;

async function show(props: Partial<Parameters<typeof ServiceAlerts>[0]>) {
  await act(async () => root.render(
    <ServiceAlerts status={running} busy={false} onKill={vi.fn()} onNavigate={vi.fn()} {...props} />,
  ));
}
const restartButton = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.startsWith("重启"));

describe("服务页告警条的重启按钮", () => {
  it("客户端页：客户端热替换失败给「重启客户端」，点击触发回调", async () => {
    const onRestart = vi.fn();
    await show({ source: "client", clientRunning: true, hotswap: hotswap(report("client")), onRestart });
    expect(restartButton()?.textContent).toBe("重启客户端");
    await act(async () => restartButton()!.click());
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it("客户端页：客户端被遮挡也给「重启客户端」", async () => {
    await show({ source: "client", clientRunning: true, hotswap: hotswap(report("client", "partial")), onRestart: vi.fn() });
    expect(restartButton()?.textContent).toBe("重启客户端");
  });

  it("客户端页：过时报告属于中间件时不讲", async () => {
    await show({ source: "client", clientRunning: true, hotswap: hotswap(report("server")), onRestart: vi.fn() });
    expect(host.querySelector(".sv-alert")).toBeNull();
  });

  it("客户端页：客户端没在运行时不讲", async () => {
    await show({ source: "client", clientRunning: false, hotswap: hotswap(report("client")), onRestart: vi.fn() });
    expect(host.querySelector(".sv-alert")).toBeNull();
  });

  it("中间件页：中间件失败给「重启服务」，客户端的失败不讲", async () => {
    await show({ hotswap: hotswap(report("server")), onRestart: vi.fn() });
    expect(restartButton()?.textContent).toBe("重启服务");
    await show({ hotswap: hotswap(report("client")), onRestart: vi.fn() });
    expect(host.querySelector(".sv-alert")).toBeNull();
  });

  it("客户端页不讲端口占用，也不讲还没选工程", async () => {
    const status = { state: "running", projectRoot: "", portOwner: { name: "java.exe", pid: 9 }, portOwnedBySelf: false, port: 80 } as unknown as ServerStatus;
    await show({ status, source: "client", clientRunning: true });
    expect(host.textContent).toBe("");
    await show({ status });
    expect(host.textContent).toContain("占用");
    expect(host.textContent).toContain("还没选工程目录");
  });
});
