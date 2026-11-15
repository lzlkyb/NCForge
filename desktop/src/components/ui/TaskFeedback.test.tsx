// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Button } from "./button";
import { TaskFeedback } from "./TaskFeedback";
import { LoadingState } from "./LoadingState";
import { ViewActivityContext } from "../../lib/viewActivity";
import { WAIT_FEEDBACK } from "../../lib/motion";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  expect(vi.getTimerCount()).toBe(0);
  host.remove(); vi.useRealTimers();
});

it("locks immediately, retains the resting label, and never flashes for a short task", async () => {
  const click = vi.fn();
  await act(async () => root.render(<Button onClick={click}>保存设置</Button>));
  await act(async () => root.render(<Button onClick={click} isLoading loadingText="保存中…">{null}</Button>));
  const button = host.querySelector("button")!;
  expect(button.disabled).toBe(true);
  expect(button.getAttribute("aria-busy")).toBe("true");
  expect(button.textContent).toBe("保存设置");
  button.click(); expect(click).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTime(150));
  expect(host.querySelector(".ui-button-loader")).toBeNull();
  await act(async () => root.render(<Button>已保存</Button>));
  await act(async () => vi.advanceTimersByTime(500));
  expect(host.querySelector(".ui-button-loader")).toBeNull();
  expect(button.disabled).toBe(false);
  expect(button.textContent).toBe("已保存");
});

it("reveals a slow button once and resets the delay on the next operation", async () => {
  await act(async () => root.render(<Button isLoading loadingText="保存中…">保存</Button>));
  await act(async () => vi.advanceTimersByTime(WAIT_FEEDBACK.reveal));
  expect(host.querySelector(".ui-button-loader")?.textContent).toContain("保存中");
  await act(async () => root.render(<Button>保存</Button>));
  await act(async () => root.render(<Button isLoading>保存</Button>));
  expect(host.querySelector(".ui-button-loader")).toBeNull();
});

it("offers cancellation immediately, keeps its acknowledgement distinct, and uses real progress", async () => {
  const cancel = vi.fn();
  const props = { active: true, label: "正在写入…", operationKey: "one", onCancel: cancel, progress: { done: 2, total: 5, unit: "个文件" } };
  await act(async () => root.render(<TaskFeedback {...props} />));
  expect(host.firstElementChild?.hasAttribute("data-visible")).toBe(false);
  await act(async () => host.querySelector("button")!.click());
  expect(cancel).toHaveBeenCalledOnce();
  expect(host.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("2");
  await act(async () => vi.advanceTimersByTime(1100));
  expect(host.textContent).toContain("已用 1 秒");
  expect(host.querySelector('[role="status"]')?.textContent).not.toContain("秒");
  expect(host.querySelector('[role="status"]')?.closest('[aria-busy="true"]')).toBeNull();
  await act(async () => root.render(<TaskFeedback {...props} cancelling />));
  expect(host.textContent).toContain("等待任务确认");
  expect(host.querySelector("button")?.disabled).toBe(true);
  await act(async () => root.render(<TaskFeedback {...props} active={false} />));
  expect(host.textContent).toBe("");
  expect(vi.getTimerCount()).toBe(0);
});

it("unknown totals stay indeterminate and a long wait never turns itself into a failure", async () => {
  await act(async () => root.render(<TaskFeedback active label="正在读取结构…" progress={{ done: 4 }} />));
  expect(host.querySelector('[role="progressbar"]')?.hasAttribute("aria-valuenow")).toBe(false);
  await act(async () => vi.advanceTimersByTime(11_000));
  expect(host.textContent).toContain("任务仍在进行");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  await act(async () => root.render(<TaskFeedback active label="正在读取结构…" operationKey="next" />));
  expect(host.textContent).not.toContain("11 秒");
  expect(host.firstElementChild?.hasAttribute("data-visible")).toBe(false);
});

it("hidden retained views stop timers and return to current elapsed time", async () => {
  const view = (active: boolean) => <ViewActivityContext.Provider value={active}>
    <TaskFeedback active label="正在生成…" /><Button isLoading>生成</Button>
  </ViewActivityContext.Provider>;
  await act(async () => root.render(view(true)));
  await act(async () => vi.advanceTimersByTime(100));
  await act(async () => root.render(view(false)));
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => vi.advanceTimersByTime(5000));
  await act(async () => root.render(view(true)));
  expect(host.textContent).toContain("已用 5 秒");
  expect(host.querySelector(".ui-button-loader")).not.toBeNull();
  await act(async () => root.render(view(false)));
  expect(vi.getTimerCount()).toBe(0);
});

it("announces skeletons once per region and delays their visual display", async () => {
  await act(async () => root.render(<LoadingState label="正在打开元数据…" />));
  expect(host.querySelectorAll('[role="status"]')).toHaveLength(1);
  expect(host.querySelector('[role="status"]')?.textContent).toBe("正在打开元数据…");
  expect(host.querySelector('[role="status"]')?.closest('[aria-busy="true"]')).toBeNull();
  expect(host.querySelectorAll('.skeleton[aria-hidden="true"]')).toHaveLength(3);
  expect(host.firstElementChild?.hasAttribute("data-visible")).toBe(false);
  await act(async () => vi.advanceTimersByTime(180));
  expect(host.firstElementChild?.getAttribute("data-visible")).toBe("true");
});
