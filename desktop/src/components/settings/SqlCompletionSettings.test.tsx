// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getSqlUsageEnabled, setSqlUsageEnabled } from "../../lib/sqlUsage";
import { SqlCompletionSettings } from "./SqlCompletionSettings";
vi.mock("./SettingsGroup", () => ({ SettingsGroup: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); setSqlUsageEnabled(true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root.render(<SqlCompletionSettings />));
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });
it("学习开关立即生效并保存到本机", () => {
  act(() => host.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
  expect(getSqlUsageEnabled()).toBe(false);
  expect(JSON.parse(localStorage.getItem("ncforge-sql-usage")!).enabled).toBe(false);
});
it("持久化失败保留会话设置，可在恢复存储后重试同一值", () => {
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("readonly"); });
  act(() => host.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
  expect(getSqlUsageEnabled()).toBe(false); expect(host.querySelector('[role="alert"]')?.textContent).toContain("未保存到本机");
  write.mockRestore();
  act(() => [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "重试保存")!.click());
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(JSON.parse(localStorage.getItem("ncforge-sql-usage")!).enabled).toBe(false);
});
