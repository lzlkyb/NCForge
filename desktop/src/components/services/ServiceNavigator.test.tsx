// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceNavigator } from "./ServiceNavigator";
import { ServiceRunToolbar } from "./ServiceRunToolbar";
import { ServiceActionsBar } from "./ServiceActionsBar";
import type { ServiceSource } from "../../lib/servicePresentation";
import type { ServerStatus } from "../../lib/server";
import type { ClientStatus } from "../../lib/client";

vi.mock("../../hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => true }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement, queryClient: QueryClient;
const middleware = { state: "running", pid: 42, port: 80, portAddress: "127.0.0.1", portOwnedBySelf: true, debugPort: 5005 } as ServerStatus;
const client = { state: "stopped", pid: null, port: 80, host: "127.0.0.1", debugPort: null } as ClientStatus;
const start = vi.fn(), stop = vi.fn(), details = vi.fn(), config = vi.fn(), deploy = vi.fn();

function Console() {
  const [source, setSource] = useState<ServiceSource>("middleware");
  return <>
    <ServiceRunToolbar source={source} status={source === "middleware" ? middleware : client} busy={null} debugMode={false}
      onStart={() => start(source)} onStop={() => stop(source)} onRestart={vi.fn()} onRetry={vi.fn()}
      debugAttached={false} debugBusy={false} onAttachDebug={vi.fn()} onDetachDebug={vi.fn()}
      navigator={<ServiceNavigator source={source} onSource={setSource} middleware={{ status: middleware, busy: null, failed: false }} client={{ status: client, busy: null, failed: false }} />}
      tools={<ServiceActionsBar configOpen={false} onToggleConfig={config} previewing={false} onCommandLine={vi.fn()} onRevealLog={vi.fn()}
        known failed={false} onRetryStatus={vi.fn()} onDetails={details} onDeploy={deploy} />} />
    <section id="sc-service-console" role="tabpanel" aria-labelledby={`sc-service-${source}`} />
  </>;
}

const click = async (element: Element) => act(async () => (element as HTMLButtonElement).click());
const selected = () => container.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')!;
beforeEach(async () => {
  vi.clearAllMocks();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  await act(async () => root.render(<QueryClientProvider client={queryClient}><Console /></QueryClientProvider>));
});
afterEach(async () => { await act(async () => root.unmount()); queryClient.clear(); container.remove(); });

describe("工具栏服务来源", () => {
  it("两个来源及其状态与主要操作处于同一工具栏，来源位于日志面板之外", () => {
    const toolbar = container.querySelector(".sc-run-toolbar")!;
    expect(toolbar.querySelector('[role="tablist"]')?.getAttribute("aria-orientation")).toBe("horizontal");
    expect(toolbar.querySelectorAll('[role="tab"]')).toHaveLength(2);
    expect(toolbar.querySelector("#sc-service-middleware")?.textContent).toContain("中间件端口监听中");
    expect(toolbar.querySelector("#sc-service-client")?.textContent).toContain("客户端已停止");
    expect(toolbar.querySelector("#sc-service-client")?.getAttribute("title")).toContain("连接 127.0.0.1:80");
    expect(container.querySelector('[role="tabpanel"] [role="tablist"]')).toBeNull();
    expect(container.querySelector(".sc-side-tools")).toBeNull();
  });

  it("方向键与首尾键切换来源后保留焦点，运行操作始终作用于当前来源", async () => {
    const first = selected(); first.focus();
    for (const [key, source] of [["ArrowRight", "client"], ["ArrowLeft", "middleware"], ["End", "client"], ["Home", "middleware"], ["ArrowDown", "client"], ["ArrowUp", "middleware"], ["ArrowRight", "client"]]) {
      await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
      expect(selected().id).toBe(`sc-service-${source}`);
      expect(document.activeElement).toBe(selected());
      expect(selected().tabIndex).toBe(0);
      expect(container.querySelector('[role="tabpanel"]')?.getAttribute("aria-labelledby")).toBe(selected().id);
    }
    expect(container.querySelector("#sc-service-middleware")).toBe(first);
    await click([...container.querySelectorAll("button")].find(button => button.textContent === "启动")!);
    expect(start).toHaveBeenCalledWith("client");
    await click(first);
    await click([...container.querySelectorAll("button")].find(button => button.textContent === "停止")!);
    expect(stop).toHaveBeenCalledWith("middleware");
  });

  it("低频工具在更多菜单中各保留一个入口且仍可执行", async () => {
    expect(container.textContent).not.toContain("启动设置");
    const trigger = container.querySelector('[aria-label="更多服务工具"]')!;
    for (const [label, action] of [["运行详情", details], ["启动设置", config], ["元数据投送", deploy]] as const) {
      await click(trigger);
      const items = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
      for (const name of ["运行详情", "启动设置", "启动命令行", "日志位置", "元数据投送", "NCC / BIP 报文解密"]) {
        expect(items.filter(item => item.textContent?.includes(name))).toHaveLength(1);
      }
      const item = items.find(item => item.textContent === label)!;
      item.focus(); await click(item);
      expect(action).toHaveBeenCalledOnce();
      expect(document.activeElement).toBe(trigger);
      expect(document.querySelector('[role="menu"]')).toBeNull();
    }
  });
});
