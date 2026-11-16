// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn(), invokeOrToast: vi.fn(), toast: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: h.invoke, invokeOrToast: h.invokeOrToast }));
vi.mock("../ui/toast", () => ({ toast: h.toast }));
vi.mock("../ui/Modal", () => ({
  Modal: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div role="dialog" aria-label="错误记录">{children}</div> : null,
}));

import { DiagnosticsSettings } from "./DiagnosticsSettings";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  h.invoke.mockReset();
  h.invokeOrToast.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = () => act(() => root.render(<DiagnosticsSettings />));
const click = (label: string) => {
  const btn = [...host.querySelectorAll("button")].find(b => b.textContent?.trim() === label);
  if (!btn) throw new Error(`找不到按钮：${label}`);
  return act(async () => { btn.click(); });
};

it("查看：把后端日志显示出来", async () => {
  h.invoke.mockResolvedValue("[123] [render] 渲染失败\nat A.tsx:1\n");
  render();
  await click("查看");
  expect(h.invoke).toHaveBeenCalledWith("frontend_log_read", { maxBytes: 64 * 1024 });
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog?.textContent).toContain("渲染失败");
  expect(dialog?.textContent).toContain("at A.tsx:1");
});

it("🔴 没有记录时给明确空态，不是空白弹窗", async () => {
  h.invoke.mockResolvedValue("");
  render();
  await click("查看");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("暂无错误记录");
});

it("打开目录：走 frontend_log_reveal", async () => {
  render();
  await click("打开目录");
  expect(h.invokeOrToast).toHaveBeenCalledWith("frontend_log_reveal", undefined, "打开日志目录失败");
});

it("🔴 读失败不打开空弹窗（错误已 toast，别再给个空面板）", async () => {
  h.invoke.mockRejectedValue(new Error("读日志失败"));
  render();
  await click("查看");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});