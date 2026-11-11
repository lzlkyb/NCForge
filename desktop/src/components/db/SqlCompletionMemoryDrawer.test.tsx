// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ConnRuntime } from "../../lib/dbStore";
const h = vi.hoisted(() => ({ runtime: { status: "connected", currentSchema: "A" } as ConnRuntime }));
vi.mock("../../lib/dbStore", () => ({ useConnOf: () => ({ id: "c", name: "测试库", url: "test", user: "NC" }), useConnRt: () => h.runtime }));
let host: HTMLDivElement, root: Root;
beforeEach(() => { vi.resetModules(); localStorage.clear(); h.runtime = { status: "connected", currentSchema: "A" }; host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const button = (name: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
const clickText = (text: string) => act(() => Array.from(host.querySelectorAll("button")).find(b => b.textContent === text)!.click());
it("仅剩历史关联时也能清除，并作废迟到学习", async () => {
  const { SqlCompletionMemoryDrawer } = await import("./SqlCompletionMemoryDrawer"), u = await import("../../lib/sqlUsage"), joins = await import("../../lib/sqlJoinHistory");
  const { connectionKey } = await import("../../lib/dbResultContext");
  const scope = u.sqlUsageScope(connectionKey({ id: "c", url: "test", user: "NC" } as never), "A"), before = joins.sqlJoinHistoryGeneration(scope);
  act(() => root.render(<SqlCompletionMemoryDrawer connId="c" onClose={() => {}} />));
  expect(button("清除当前 schema 补全记忆").disabled).toBe(false);
  act(() => button("清除当前 schema 补全记忆").click()); clickText("确认清除");
  expect(joins.sqlJoinHistoryGeneration(scope)).toBe(before + 1);
});
it("清除确认绑定原schema，切换后不能误清新scope", async () => {
  const { SqlCompletionMemoryDrawer } = await import("./SqlCompletionMemoryDrawer"), u = await import("../../lib/sqlUsage");
  const { connectionKey } = await import("../../lib/dbResultContext");
  const identity = connectionKey({ id: "c", url: "test", user: "NC" } as never), b = u.sqlUsageScope(identity, "B"), key = u.sqlUsageKey("orders");
  u.recordSqlUsage(b, key, "accept");
  act(() => root.render(<SqlCompletionMemoryDrawer connId="c" onClose={() => {}} />));
  act(() => button("清除当前 schema 补全记忆").click());
  h.runtime = { ...h.runtime, currentSchema: "B" };
  act(() => root.render(<SqlCompletionMemoryDrawer connId="c" onClose={() => {}} />));
  expect(host.querySelector('[aria-label="确认清除补全记忆"]')).toBeNull();
  expect(u.usageSnapshot(b)[key].accept).toBe(1);
});
