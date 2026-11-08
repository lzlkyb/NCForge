// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ copy: vi.fn(), history: { c: [{ at: 1, sql: "select * from test", ms: 1, summary: "1行", ok: true }] } }));
vi.mock("../../lib/dbStore", () => ({ useDbConns: () => [{ id: "c", name: "测试库" }], openSessionPanel: vi.fn() }));
vi.mock("../../lib/dbHistory", () => ({ subscribeHistory: () => () => {}, getHistoryMap: () => mocks.history, historyHits: () => [{ connId: "c", entry: mocks.history.c[0] }], filterHits: (hits: unknown) => hits, historyTime: () => "刚刚", clearHistory: vi.fn() }));
vi.mock("../../lib/dbActions", () => ({ openTable: vi.fn() }));
vi.mock("../../lib/dbConfirm", () => ({ reconnectSession: vi.fn() }));
vi.mock("../../lib/utils", () => ({ copyText: mocks.copy }));
import { HistoryDrawer } from "./HistoryDrawer";
import { DbErrorBox } from "./DbErrorBox";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const host = document.createElement("div"); document.body.append(host);
let root = createRoot(host);
afterEach(async () => { await act(async () => root.unmount()); root = createRoot(host); vi.clearAllMocks(); });
it("double clicking history never executes; explicit action executes once", async () => {
  const pick = vi.fn();
  await act(async () => root.render(<HistoryDrawer connId="c" onPick={pick} onClose={() => {}} />));
  const content = host.querySelector<HTMLButtonElement>(".dbx-history-content")!;
  await act(async () => { content.click(); content.click(); content.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
  expect(pick.mock.calls.every(([, run]) => run === false)).toBe(true);
  pick.mockClear();
  const run = [...host.querySelectorAll("button")].find(b => b.textContent === "填入并执行")!;
  await act(async () => run.click());
  expect(pick).toHaveBeenCalledExactlyOnceWith("select * from test", true);
});
it("similar table suggestions are named native keyboard buttons", async () => {
  await act(async () => root.render(<DbErrorBox error="ORA-00942: table or view does not exist" sql="select * from TESTT" knownTables={["TEST"]} />));
  const button = host.querySelector<HTMLButtonElement>('button[aria-label="复制表名 test"]')!;
  expect(button).not.toBeNull(); expect(button.type).toBe("button");
  button.focus(); expect(document.activeElement).toBe(button);
  await act(async () => button.click());
  expect(mocks.copy).toHaveBeenCalledWith("test", expect.any(Function), expect.any(Function));
});
