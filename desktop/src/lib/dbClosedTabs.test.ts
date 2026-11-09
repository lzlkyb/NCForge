// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import {
  MAX_RECENTLY_CLOSED, __resetDbForTest, clearRecentlyClosed, closeTab, getDb,
  moveDbTab, openDictTab, openSqlTab, openTableTab, patchTab, restoreClosedTab,
  setConns, setSqlDraft, sqlTabOf, type SqlTab,
} from "./dbStore";
import { persistentTabsChanged } from "./dbTabPersistence";
import type { DbConn } from "./dbApi";

vi.mock("./tauri", () => ({ invoke: vi.fn() }));

const conn: DbConn = {
  id: "c1", name: "开发库", env: "dev", source: "manual", url: "", user: "u",
  propDs: null, autoCommit: false, note: "", hasPassword: false, engine: "java",
};
beforeEach(() => { localStorage.clear(); __resetDbForTest(); setConns([conn]); });

it("关闭 SQL 后草稿、行数上限与原位置都能找回，结果集不带回来", () => {
  const a = openSqlTab("c1");
  const b = openTableTab("c1", "T1");
  const c = openSqlTab("c1");
  setSqlDraft(c, "select * from secret where id = 1");
  patchTab<SqlTab>(c, { maxRows: 123, timeoutSec: 77 });
  const entry = closeTab(c);
  expect(entry).toBeTruthy();
  expect(getDb().tabs.map((t) => t.id)).toEqual([a, b]);
  expect(getDb().recentlyClosed).toHaveLength(1);
  expect(getDb().recentlyClosed[0].tab.sql).toBe("select * from secret where id = 1");
  expect(restoreClosedTab(entry!)).toBe(c);
  expect(getDb().tabs.map((t) => t.id)).toEqual([a, b, c]);
  expect(getDb().active).toBe(c);
  const restored = sqlTabOf(c)!;
  expect(restored.sql).toBe("select * from secret where id = 1");
  expect(restored.maxRows).toBe(123);
  expect(restored.timeoutSec).toBe(77);
  expect(restored.results).toEqual([]);
  expect(getDb().recentlyClosed).toHaveLength(0);
});

it("找回栈上限 20，同一标签反复关闭只留最后一份", () => {
  for (let i = 0; i < MAX_RECENTLY_CLOSED + 5; i++) closeTab(openSqlTab("c1", `s${i}`));
  expect(getDb().recentlyClosed).toHaveLength(MAX_RECENTLY_CLOSED);
  const id = openSqlTab("c1", "x");
  closeTab(id);
  expect(restoreClosedTab()).toBe(id);
  closeTab(id);
  expect(getDb().recentlyClosed.filter((e) => e.tab.id === id)).toHaveLength(1);
});

it("字典标签不进栈；删除连接时关掉的表页也不进栈", () => {
  const d = openDictTab("c1");
  expect(closeTab(d)).toBeNull();
  const t = openTableTab("c1", "T1");
  expect(closeTab(t, false)).toBeNull();
  expect(getDb().recentlyClosed).toHaveLength(0);
});

it("连接删除后 SQL 降级「未选连接」、表页跳过并继续找上一条", () => {
  const s = openSqlTab("c1", "draft");
  closeTab(s);
  const t = openTableTab("c1", "T1");
  closeTab(t);
  setConns([]);
  expect(restoreClosedTab()).toBe(s);
  expect(getDb().tabs.some((x) => x.id === t)).toBe(false);
  expect(sqlTabOf(s)?.connId).toBeNull();
  expect(sqlTabOf(s)?.sql).toBe("draft");
});

it("同 id 已重新打开时只激活，不插入重复标签", () => {
  const a = openSqlTab("c1", "old");
  const entry = closeTab(a);
  const b = openSqlTab("c1", "new");
  patchTab<SqlTab>(b, { id: a });
  expect(restoreClosedTab(entry!)).toBe(a);
  expect(getDb().tabs.filter((t) => t.id === a)).toHaveLength(1);
  expect(getDb().active).toBe(a);
  expect(sqlTabOf(a)?.sql).toBe("new");
});

it("拖拽排序插到目标前、空白落点插到末尾，顺序变化会被持久化感知", () => {
  const a = openSqlTab("c1"), b = openTableTab("c1", "T"), c = openSqlTab("c1");
  moveDbTab(c, a);
  expect(getDb().tabs.map((t) => t.id)).toEqual([c, a, b]);
  const before = getDb().tabs;
  moveDbTab(a, null);
  expect(getDb().tabs.map((t) => t.id)).toEqual([c, b, a]);
  expect(persistentTabsChanged(before, getDb().tabs)).toBe(true);
  moveDbTab("missing", a);
  expect(getDb().tabs.map((t) => t.id)).toEqual([c, b, a]);
});

it("清空记录同时清掉落盘内容", () => {
  closeTab(openSqlTab("c1", "x"));
  expect(JSON.parse(localStorage.getItem("ncforge-db-closed-tabs")!).items).toHaveLength(1);
  clearRecentlyClosed();
  expect(getDb().recentlyClosed).toHaveLength(0);
  expect(JSON.parse(localStorage.getItem("ncforge-db-closed-tabs")!).items).toHaveLength(0);
});

it("关闭栈落盘，重载模块后仍能找回草稿", async () => {
  const id = openSqlTab("c1");
  setSqlDraft(id, "select 7 from dual");
  closeTab(id);
  expect(JSON.parse(localStorage.getItem("ncforge-db-closed-tabs")!).items[0].tab.sql).toBe("select 7 from dual");
  vi.resetModules();
  const fresh = await import("./dbStore");
  expect(fresh.getDb().recentlyClosed).toHaveLength(1);
  expect(fresh.restoreClosedTab()).toBe(id);
  expect(fresh.sqlTabOf(id)?.sql).toBe("select 7 from dual");
});
