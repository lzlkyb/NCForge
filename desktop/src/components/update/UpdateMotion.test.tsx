// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { UpdateReadout } from "./UpdateReadout";
import { AVAILABLE_PROCESS, UpdateProcess } from "./UpdateProcess";

const mocks = vi.hoisted(() => ({
  hidden: false,
  update: { status: "downloading", progress: 0, progressIndeterminate: true, bytesPerSec: 0, downloadedBytes: 0, totalBytes: null as number | null },
}));
vi.mock("../../contexts/UpdateContext", () => ({ useUpdate: () => mocks.update, friendlyError: (message: string) => ({ friendly: message }) }));
vi.mock("../../lib/appVisibility", () => ({ useAppHidden: () => mocks.hidden }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers(); mocks.hidden = false;
  mocks.update = { status: "downloading", progress: 0, progressIndeterminate: true, bytesPerSec: 0, downloadedBytes: 0, totalBytes: null };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });

it("one deadline detects missing download events and new progress clears the waiting state", async () => {
  await act(async () => root.render(<UpdateReadout />));
  expect(vi.getTimerCount()).toBe(1);
  await act(async () => vi.advanceTimersByTime(4001));
  expect(host.textContent).toContain("等待响应"); expect(vi.getTimerCount()).toBe(0);
  mocks.update.downloadedBytes = 64;
  await act(async () => root.render(<UpdateReadout />));
  expect(host.textContent).not.toContain("等待响应"); expect(vi.getTimerCount()).toBe(1);
});

it("unknown transfers use a static readout and hidden windows release the deadline", async () => {
  await act(async () => root.render(<UpdateReadout />));
  expect(host.querySelector('[role="progressbar"]')?.getAttribute("aria-valuetext")).toBe("总大小未知");
  expect(host.querySelector(".ur-sweep,.animate-spin")).toBeNull();
  mocks.hidden = true; await act(async () => root.render(<UpdateReadout />)); expect(vi.getTimerCount()).toBe(0);
  mocks.hidden = false; mocks.update.status = "ready";
  await act(async () => root.render(<UpdateReadout />));
  expect(host.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
  expect(host.querySelector(".ur-sweep,.animate-spin")).toBeNull(); expect(vi.getTimerCount()).toBe(0);
});

it("checks have delayed visual feedback, while a ready or failed result is shown immediately", async () => {
  await act(async () => root.render(<UpdateProcess process={{ ...AVAILABLE_PROCESS, status: "checking" }} />));
  expect(host.querySelector(".ui-task-feedback")?.hasAttribute("data-visible")).toBe(false);
  await act(async () => vi.advanceTimersByTime(1200)); expect(host.querySelector(".ui-task-elapsed")?.textContent).toContain("1 秒");
  await act(async () => root.render(<UpdateProcess process={{ ...AVAILABLE_PROCESS, status: "ready" }} />));
  expect(host.textContent).toContain("更新包已下载并验证"); expect(host.querySelector(".ui-task-feedback")).toBeNull(); expect(vi.getTimerCount()).toBe(0);
  await act(async () => root.render(<UpdateProcess process={{ ...AVAILABLE_PROCESS, status: "error", error: "校验失败" }} />));
  expect(host.textContent).toContain("校验失败"); expect(host.textContent).toContain("查看错误详情");
});
