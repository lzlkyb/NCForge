// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  ask: vi.fn(),
  guardTx: vi.fn(),
  guardSlotTx: vi.fn(),
  isLastTabOn: vi.fn(),
  exec: vi.fn(),
}));
vi.mock("../components/ui/toast", () => ({ toast: mocks.toast }));
vi.mock("./sqlModels", () => ({ disposeSqlModel: vi.fn() }));
vi.mock("./dbConfirm", () => ({
  ask: mocks.ask,
  guardTx: mocks.guardTx,
  guardSlotTx: mocks.guardSlotTx,
  isLastTabOn: mocks.isLastTabOn,
  ensureConnected: vi.fn(async () => true),
  confirmProdWrite: vi.fn(async () => true),
  reconnectSession: vi.fn(),
}));
vi.mock("./tauri", () => ({ invoke: vi.fn() }));
vi.mock("./dbApi", async () => {
  const actual = await vi.importActual<typeof import("./dbApi")>("./dbApi");
  return { ...actual, dbApi: { ...actual.dbApi, exec: mocks.exec } };
});

import { runStatements, switchConn } from "./dbActions";
import {
  __resetDbForTest,
  clearSlots,
  getDb,
  isRunning,
  openSqlTab,
  patchTab,
  setConns,
  sqlTabOf,
  type RunToken,
  type SqlTab,
} from "./dbStore";
import type { DbConn } from "./dbApi";

const conn = (id: string): DbConn => ({
  id,
  name: id,
  env: "dev",
  source: "manual",
  url: "",
  user: "u",
  propDs: null,
  autoCommit: false,
  note: "",
  hasPassword: false,
  engine: "java",
});

const token = (id = 1, connId = "c1"): RunToken => ({ id, connId, at: 0, slot: null, kind: "execute" });

beforeEach(() => {
  localStorage.clear();
  __resetDbForTest();
  setConns([conn("c1"), conn("c2")]);
  for (const fn of [mocks.toast, mocks.ask, mocks.guardTx, mocks.guardSlotTx, mocks.isLastTabOn, mocks.exec]) fn.mockReset();
  mocks.isLastTabOn.mockReturnValue(false);
  mocks.guardTx.mockResolvedValue(true);
  mocks.guardSlotTx.mockResolvedValue(true);
  mocks.ask.mockResolvedValue(true);
});

it("「在跑」只有一个事实：设置 run 就是执行中，清掉就结束", () => {
  const id = openSqlTab("c1");
  expect(isRunning(sqlTabOf(id))).toBe(false);
  patchTab<SqlTab>(id, { run: token() });
  expect(isRunning(sqlTabOf(id))).toBe(true);
  patchTab<SqlTab>(id, { run: undefined });
  expect(isRunning(sqlTabOf(id))).toBe(false);
});

it("已在执行时再发起执行会被拒，不会把上一趟的 run 顶掉", async () => {
  const id = openSqlTab("c1", "select 1 from dual");
  const mine = token(7);
  patchTab<SqlTab>(id, { run: mine });
  const out = await runStatements(id, [{ text: "select 1 from dual", startLine: 1 } as never]);
  expect(out.done).toBe(0);
  expect(mocks.exec).not.toHaveBeenCalled();
  // 关键：拒绝的是新请求，不是把正在跑的那趟清掉
  expect(sqlTabOf(id)?.run?.id).toBe(7);
});

it("执行中切连接会把运行身份作废，切回来也不残留「永远转圈」", async () => {
  const id = openSqlTab("c1");
  patchTab<SqlTab>(id, { run: token() });
  await switchConn(id, "c2");
  expect(sqlTabOf(id)?.connId).toBe("c2");
  // 这就是历史上那个「永久 loading」：切连接时 finally 的复位被 sameRun 跳过
  expect(isRunning(sqlTabOf(id))).toBe(false);
  await switchConn(id, "c1");
  expect(isRunning(sqlTabOf(id))).toBe(false);
});

it("断开 / 删连接清槽时，运行身份一起清掉", () => {
  const a = openSqlTab("c1");
  const b = openSqlTab("c2");
  patchTab<SqlTab>(a, { run: token(1, "c1"), slot: "2" });
  patchTab<SqlTab>(b, { run: token(2, "c2") });
  clearSlots("c1");
  expect(isRunning(sqlTabOf(a))).toBe(false);
  expect(sqlTabOf(a)?.slot).toBeNull();
  // 别的连接不受影响
  expect(isRunning(sqlTabOf(b))).toBe(true);
  expect(getDb().tabs.find((t) => t.id === b)).toBeTruthy();
});
