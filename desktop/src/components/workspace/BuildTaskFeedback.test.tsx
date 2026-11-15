// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import type { Operation } from "../../lib/operations";
import { BuildTaskFeedback } from "./BuildTaskFeedback";
import { ViewActivityContext } from "../../lib/viewActivity";

const mocks = vi.hoisted(() => ({
  session: { root: "D:/p", compiling: false, buildProgress: null as null | { phase: string; done: number; total: number; module: string | null }, panelOpen: true, panelTab: "build" },
  operation: null as Operation | null,
}));
vi.mock("../../lib/workspaceSession", () => ({ useWorkspaceSelector: (selector: (s: typeof mocks.session) => unknown) => selector(mocks.session) }));
vi.mock("../../lib/operations", () => ({ useOperation: () => mocks.operation }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(10_000);
  mocks.session = { root: "D:/p", compiling: false, buildProgress: null, panelOpen: true, panelTab: "build" };
  mocks.operation = { id: 1, key: "compile.manual", label: "编译工程", scope: "D:/p", state: "running", phase: "编译磁盘中的源码", startedAt: 10_000, visible: false };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });

it("shows a registered build before IO, preserves actual phase counts and keeps a log entry", async () => {
  const log = vi.fn();
  await act(async () => root.render(<BuildTaskFeedback root="D:/p" onShowLog={log} />));
  expect(host.textContent).toContain("编译磁盘中的源码");
  expect(host.querySelector(".ui-task-feedback")?.hasAttribute("data-visible")).toBe(false);
  mocks.session.compiling = true; mocks.session.buildProgress = { phase: "编译", done: 2, total: 5, module: "gl" };
  await act(async () => root.render(<BuildTaskFeedback root="D:/p" onShowLog={log} />));
  expect(host.textContent).toContain("当前模块：gl"); expect(host.textContent).toContain("2 / 5 个模块");
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click()); expect(log).toHaveBeenCalledOnce();
  mocks.operation!.state = "cancelling";
  await act(async () => root.render(<BuildTaskFeedback root="D:/p" onShowLog={log} />));
  expect(host.textContent).toContain("等待任务确认"); expect(host.textContent).not.toContain("编译成功");
});

it("cancelled outcomes stop timing and are superseded by a newer result or a different workspace", async () => {
  mocks.operation!.state = "cancelled"; mocks.operation!.endedAt = 11_000; mocks.operation!.detail = "已停止当前编译";
  await act(async () => root.render(<BuildTaskFeedback root="D:/p" onShowLog={() => {}} />));
  expect(host.textContent).toContain("本轮编译已取消"); expect(vi.getTimerCount()).toBe(0);
  await act(async () => root.render(<BuildTaskFeedback root="D:/p" resultCompletedAt={12_000} onShowLog={() => {}} />));
  expect(host.textContent).toBe("");
  await act(async () => root.render(<BuildTaskFeedback root="D:/other" onShowLog={() => {}} />));
  expect(host.textContent).toBe("");
});

it("a later automatic build cannot display the previous manual failure as its current phase", async () => {
  mocks.operation!.state = "failed"; mocks.operation!.endedAt = 9_000; mocks.operation!.detail = "上次网络失败";
  mocks.session.compiling = true;
  await act(async () => root.render(<BuildTaskFeedback root="D:/p" onShowLog={() => {}} />));
  expect(host.textContent).toContain("正在编译工程"); expect(host.textContent).not.toContain("上次网络失败");
});

it("an inactive parent page cannot be reactivated by its retained build slot", async () => {
  await act(async () => root.render(<ViewActivityContext.Provider value={false}><BuildTaskFeedback root="D:/p" onShowLog={() => {}} /></ViewActivityContext.Provider>));
  expect(vi.getTimerCount()).toBe(0);
});
