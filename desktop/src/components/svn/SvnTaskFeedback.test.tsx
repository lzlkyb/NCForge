// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { SvnTaskFeedback } from "./SvnTaskFeedback";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
beforeEach(() => { vi.useFakeTimers(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });

it("scan counters are real, stay outside the live message and do not invent totals", async () => {
  await act(async () => root.render(<SvnTaskFeedback root="D:/p" fetching scanned={{ done: 3, total: 7, scanned: 40, module: "gl" }} busy={null} hasPrevious />));
  expect(host.querySelector(".ui-task-detail")?.textContent).toContain("3 / 7 个模块");
  expect(host.querySelector('[role="status"]')?.textContent).not.toContain("3 / 7");
  await act(async () => root.render(<SvnTaskFeedback root="D:/p" fetching scanned={{ done: null, total: null, scanned: 40, module: null }} busy={null} hasPrevious />));
  expect(host.textContent).toContain("40 条"); expect(host.textContent).not.toMatch(/%|40\s*\//);
  expect(host.textContent).toContain("上次扫描结果"); expect(host.querySelector("button")).toBeNull();
});

it("a new write operation resets the wait and never carries scan progress into a commit", async () => {
  await act(async () => root.render(<SvnTaskFeedback root="D:/p" fetching scanned={{ done: 3, total: 7, scanned: 40, module: "gl" }} busy={null} hasPrevious />));
  await act(async () => vi.advanceTimersByTime(1200)); expect(host.querySelector(".ui-task-feedback")?.hasAttribute("data-visible")).toBe(true);
  await act(async () => root.render(<SvnTaskFeedback root="D:/p" fetching scanned={{ done: 3, total: 7, scanned: 40, module: "gl" }} busy="commit" hasPrevious />));
  expect(host.textContent).toContain("正在提交所选文件"); expect(host.textContent).not.toContain("3 / 7");
  expect(host.querySelector(".ui-task-feedback")?.hasAttribute("data-visible")).toBe(false);
  await act(async () => root.render(<SvnTaskFeedback root="D:/p" fetching={false} scanned={null} busy={null} hasPrevious />));
  expect(host.textContent).toBe(""); expect(vi.getTimerCount()).toBe(0);
});
