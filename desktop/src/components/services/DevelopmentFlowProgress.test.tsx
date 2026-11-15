// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { DevelopmentFlowProgress } from "./DevelopmentFlowProgress";

const mocks = vi.hoisted(() => ({
  snapshot: { state: "running", root: "D:/project", phase: "正在启动中间件", detail: "", startedAt: 10_000, operationId: 1 },
  panel: { panelOpen: true, panelTab: "svc" }, cancel: vi.fn(async () => {}), dismiss: vi.fn(),
}));
vi.mock("../../hooks/useDevelopmentFlow", () => ({ useDevelopmentFlow: () => ({
  root: "D:/project", snapshot: mocks.snapshot, running: ["running", "cancelling"].includes(mocks.snapshot.state), cancel: mocks.cancel, dismiss: mocks.dismiss,
}) }));
vi.mock("../../lib/workspaceSession", () => ({ useWorkspaceSelector: (selector: (s: typeof mocks.panel) => unknown) => selector(mocks.panel) }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(10_000);
  mocks.snapshot = { state: "running", root: "D:/project", phase: "正在启动中间件", detail: "", startedAt: 10_000, operationId: 1 };
  mocks.panel = { panelOpen: true, panelTab: "svc" };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.clearAllMocks(); });
const render = () => act(async () => root.render(<DevelopmentFlowProgress />));

it("offers cancellation immediately, then waits for confirmation and keeps the actual result", async () => {
  await render();
  const cancel = [...host.querySelectorAll("button")].find(button => button.textContent === "取消流程")!;
  expect(cancel.disabled).toBe(false);
  expect(host.querySelector(".ui-task-feedback")?.hasAttribute("data-visible")).toBe(false);
  await act(async () => cancel.click()); expect(mocks.cancel).toHaveBeenCalledOnce();
  mocks.snapshot.state = "cancelling"; await render();
  expect(host.textContent).toContain("等待任务确认");
  expect(host.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
  mocks.snapshot.state = "cancelled"; mocks.snapshot.detail = "开发流程已取消，已经启动的中间件仍在运行"; await render();
  expect(host.querySelector(".ui-task-feedback")).toBeNull();
  expect(host.textContent).toContain("已经启动的中间件仍在运行");
  expect(vi.getTimerCount()).toBe(0);
});

it("the hidden service slot stops the clock and resumes with real elapsed time", async () => {
  await render(); await act(async () => vi.advanceTimersByTime(1100));
  expect(host.querySelector(".ui-task-elapsed")?.textContent).toContain("1 秒");
  expect(host.querySelector('[role="status"]')?.textContent).not.toContain("已用");
  mocks.panel.panelOpen = false; await render(); expect(vi.getTimerCount()).toBe(0);
  await act(async () => vi.advanceTimersByTime(4000));
  mocks.panel.panelOpen = true; await render();
  expect(host.querySelector(".ui-task-elapsed")?.textContent).toContain("5 秒");
});

it("old workspace results stay isolated, and successful completion remains readable", async () => {
  mocks.snapshot.root = "D:/other"; await render(); expect(host.textContent).toBe("");
  mocks.snapshot.root = "D:/project"; mocks.snapshot.state = "success"; mocks.snapshot.detail = "中间件和客户端已启动"; await render();
  expect(host.querySelector('[role="status"]')?.textContent).toContain("中间件和客户端已启动");
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="关闭开发流程结果"]')!.click());
  expect(mocks.dismiss).toHaveBeenCalledOnce();
});
