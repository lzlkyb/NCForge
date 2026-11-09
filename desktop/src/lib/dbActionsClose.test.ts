// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(), dispose: vi.fn(), ask: vi.fn(), guardTx: vi.fn(),
  guardSlotTx: vi.fn(), isLastTabOn: vi.fn(),
}));
vi.mock("../components/ui/toast", () => ({ toast: mocks.toast }));
vi.mock("./sqlModels", () => ({ disposeSqlModel: mocks.dispose }));
vi.mock("./dbConfirm", () => ({
  ask: mocks.ask, guardTx: mocks.guardTx, guardSlotTx: mocks.guardSlotTx,
  isLastTabOn: mocks.isLastTabOn, ensureConnected: vi.fn(async () => true),
  confirmProdWrite: vi.fn(async () => true), reconnectSession: vi.fn(),
}));
vi.mock("./tauri", () => ({ invoke: vi.fn() }));

import { requestCloseTab } from "./dbActions";
import { __resetDbForTest, getDb, openDictTab, openSqlTab, openTableTab, setConns, setSqlDraft, sqlTabOf } from "./dbStore";
import type { DbConn } from "./dbApi";

const conn: DbConn = {
  id: "c1", name: "开发库", env: "dev", source: "manual", url: "", user: "u",
  propDs: null, autoCommit: false, note: "", hasPassword: false, engine: "java",
};
beforeEach(() => {
  localStorage.clear();
  __resetDbForTest();
  setConns([conn]);
  for (const fn of [mocks.toast, mocks.dispose, mocks.ask, mocks.guardTx, mocks.guardSlotTx, mocks.isLastTabOn]) fn.mockReset();
  mocks.isLastTabOn.mockReturnValue(false);
  mocks.guardTx.mockResolvedValue(true);
  mocks.guardSlotTx.mockResolvedValue(true);
  mocks.ask.mockResolvedValue(true);
});

it("关闭 SQL 标签会弹带「撤销」的通知，点撤销把草稿与激活项原样找回", async () => {
  const id = openSqlTab("c1", "select 1");
  setSqlDraft(id, "select * from important");
  await requestCloseTab(id);
  expect(mocks.dispose).toHaveBeenCalledWith(id);
  expect(getDb().tabs.some((t) => t.id === id)).toBe(false);
  expect(mocks.toast).toHaveBeenCalledTimes(1);
  const [message, variant, options] = mocks.toast.mock.calls[0] as [string, string, { action: { label: string; onClick: () => void } }];
  expect(message).toContain("已关闭");
  expect(variant).toBe("info");
  expect(options.action.label).toBe("撤销");
  options.action.onClick();
  expect(sqlTabOf(id)?.sql).toBe("select * from important");
  expect(getDb().active).toBe(id);
});

it("表页关闭同样可撤销，字典标签不弹通知也不入栈", async () => {
  const t = openTableTab("c1", "T1");
  await requestCloseTab(t);
  expect(mocks.toast).toHaveBeenCalledTimes(1);
  expect(getDb().recentlyClosed[0].tab.table).toBe("T1");
  await requestCloseTab(openDictTab("c1"));
  expect(mocks.toast).toHaveBeenCalledTimes(1);
  expect(getDb().recentlyClosed).toHaveLength(1);
});

it("危险操作确认被取消时既不关闭，也不弹撤销、不入找回栈", async () => {
  const id = openSqlTab("c1", "draft");
  mocks.isLastTabOn.mockReturnValue(true);
  mocks.guardTx.mockResolvedValue(false);
  await requestCloseTab(id);
  expect(getDb().tabs.some((t) => t.id === id)).toBe(true);
  expect(mocks.toast).not.toHaveBeenCalled();
  expect(getDb().recentlyClosed).toHaveLength(0);
});
