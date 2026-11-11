// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const STORAGE_KEY = "ncforge-sql-usage";
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-11T10:00:00Z")); vi.resetModules(); localStorage.clear(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("SQL 补全使用记忆", () => {
  it("稳定连接身份与 schema 隔离，存储中不保留 JDBC 凭据", async () => {
    const u = await import("./sqlUsage");
    const identity = 'jdbc:oracle:thin:user/secret@host:1521/service';
    const a = u.sqlUsageScope(identity, "A"), b = u.sqlUsageScope(identity, "B");
    expect(a).toBe(u.sqlUsageScope(identity, "A")); expect(a).not.toBe(b);
    expect(a).not.toBe(u.sqlUsageScope(identity.replace('host','other'), "A"));
    u.recordSqlUsage(a, u.sqlUsageKey("bd_material"), "accept"); u.flushSqlUsage();
    expect(Object.keys(u.usageSnapshot(b))).toHaveLength(0);
    expect(localStorage.getItem(STORAGE_KEY)).not.toContain("secret");
    expect(localStorage.getItem(STORAGE_KEY)).not.toContain("jdbc:");
  });

  it("表、带引号名称和不同子句字段分开，快照只随本作用域变化", async () => {
    const u = await import("./sqlUsage");
    const a = u.sqlUsageKey('"Item"'), b = u.sqlUsageKey('"item"'), field = u.sqlUsageKey('"Item"', 'code', 'where');
    expect(a).not.toBe(b); expect(a).not.toBe(field);
    const empty = u.usageSnapshot("empty"); expect(u.usageSnapshot("empty")).toBe(empty);
    const notify = vi.fn(), off = u.subscribeSqlUsage(notify);
    u.recordSqlUsage("a", a, "type"); const snapshot = u.usageSnapshot("a");
    u.recordSqlUsage("b", b, "accept"); expect(u.usageSnapshot("a")).toBe(snapshot);
    u.recordSqlUsage("a", field, "accept"); expect(u.usageSnapshot("a")).not.toBe(snapshot);
    expect(Object.keys(u.usageSnapshot("a"))).toHaveLength(2); expect(notify).toHaveBeenCalledTimes(3); off();
  });

  it("输入未执行也可学习，明确接受强于单次输入，新近使用可前移", async () => {
    const u = await import("./sqlUsage");
    u.recordSqlUsage("c", "typed", "type"); u.recordSqlUsage("c", "accepted", "accept");
    expect(u.usageSnapshot("c").typed.type).toBe(1);
    expect(u.sqlUsageRank("c", "accepted")).toBeGreaterThan(u.sqlUsageRank("c", "typed"));
    vi.advanceTimersByTime(2000); u.recordSqlUsage("c", "new", "accept");
    expect(u.sqlUsageRank("c", "new")).toBeGreaterThan(u.sqlUsageRank("c", "accepted"));
    expect(u.sqlUsageReason("c", "new")).toBe("最近使用");
  });

  it("同一执行批次或短时间反复执行不会无限加权", async () => {
    const u = await import("./sqlUsage");
    for (let i = 0; i < 500; i++) u.recordSqlUsage("c", "table", "execute", "batch-1");
    expect(u.usageSnapshot("c").table.execute).toBe(1);
    u.recordSqlUsage("c", "table", "execute", "batch-2");
    expect(u.usageSnapshot("c").table.execute).toBe(2);
    for (let i = 0; i < 500; i++) u.recordSqlUsage("c", "plain", "execute");
    expect(u.usageSnapshot("c").plain.execute).toBe(1);
    vi.advanceTimersByTime(30000); u.recordSqlUsage("c", "plain", "execute");
    expect(u.usageSnapshot("c").plain.execute).toBe(2);
  });

  it("立即撤销可撤回接受奖励，后续修改不能被旧回执覆盖", async () => {
    const u = await import("./sqlUsage");
    const receipt = u.recordSqlUsage("c", "table", "accept")!;
    expect(u.rollbackSqlUsage(receipt)).toBe(true); expect(u.usageSnapshot("c").table).toBeUndefined();
    const next = u.recordSqlUsage("c", "table", "accept")!;
    u.setSqlUsagePinned("c", "table", true);
    expect(u.rollbackSqlUsage(next)).toBe(false); expect(u.usageSnapshot("c").table.pinned).toBe(true);
  });

  it("固定优先、长期偏好衰减、关闭同时停止学习和个性化排序", async () => {
    const u = await import("./sqlUsage");
    u.recordSqlUsage("c", "table", "accept"); const recent = u.sqlUsageRank("c", "table");
    vi.advanceTimersByTime(28 * 86400000); expect(u.sqlUsageRank("c", "table")).toBeLessThan(recent);
    u.setSqlUsagePinned("c", "pinned", true); u.recordSqlUsage("c", "new", "accept");
    expect(u.sqlUsageRank("c", "pinned")).toBeGreaterThan(u.sqlUsageRank("c", "new"));
    expect(u.sqlUsageReason("c", "pinned")).toBe("已固定");
    u.setSqlUsageEnabled(false); expect(u.getSqlUsageEnabled()).toBe(false);
    expect(u.recordSqlUsage("c", "ignored", "accept")).toBeNull(); expect(u.sqlUsageRank("c", "pinned")).toBe(0);
    expect(u.sqlUsageReason("c", "pinned")).toBe("");
  });

  it("合并写盘且重启恢复，忘记和清空立即落盘并允许从新行为学习", async () => {
    let u = await import("./sqlUsage"); const set = vi.spyOn(Storage.prototype, "setItem");
    for (let i = 0; i < 30; i++) u.recordSqlUsage("c", `table-${i}`, "accept");
    expect(set).not.toHaveBeenCalled(); vi.advanceTimersByTime(300); expect(set).toHaveBeenCalledTimes(1);
    vi.resetModules(); u = await import("./sqlUsage"); expect(Object.keys(u.usageSnapshot("c"))).toHaveLength(30);
    u.forgetSqlUsage("c", "table-0"); expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).scopes.c["table-0"]).toBeUndefined();
    u.clearSqlUsage("c"); expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).scopes.c).toBeUndefined();
    expect(u.recordSqlUsage("c", "table-0", "accept")).not.toBeNull();
  });

  it("pagehide 保存尚在合并窗口里的最后一次使用", async () => {
    const u = await import("./sqlUsage"); u.recordSqlUsage("c", "last", "accept");
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull(); window.dispatchEvent(new Event("pagehide"));
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).scopes.c.last.count).toBe(1);
  });

  it("损坏条目逐项跳过，存储失败仍保持当前会话可用", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, enabled: true, scopes: { c: {
      bad: { score: "many", lastUsed: 0, count: 1, accept: 1, type: 0, execute: 0, pinned: false },
      valid: { score: 3, lastUsed: Date.now(), count: 1, accept: 1, type: 0, execute: 0, pinned: false },
    } } }));
    const u = await import("./sqlUsage"); expect(Object.keys(u.usageSnapshot("c"))).toEqual(["valid"]);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    expect(u.recordSqlUsage("c", "new", "accept")).not.toBeNull(); expect(u.flushSqlUsage()).toBe(false);
    expect(u.usageSnapshot("c").new.count).toBe(1); expect(u.clearSqlUsage("c")).toBe(false);
    expect(Object.keys(u.usageSnapshot("c"))).toHaveLength(0);
  });

  it("容量有上限且保留较新的固定对象", async () => {
    const u = await import("./sqlUsage"); u.setSqlUsagePinned("c", "keep", true);
    for (let i = 0; i < 1100; i++) { vi.advanceTimersByTime(1); u.recordSqlUsage("c", `t-${i}`, "accept"); }
    expect(Object.keys(u.usageSnapshot("c"))).toHaveLength(1000); expect(u.usageSnapshot("c").keep.pinned).toBe(true);
    expect(u.usageSnapshot("c")["t-0"]).toBeUndefined();
  });

  it("加载过大存储同时限制总记录与作用域，危险属性名不能污染快照", async () => {
    const scopes: Record<string, unknown> = {};
    for (let n = 0; n < 70; n++) scopes[`scope-${n}`] = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`t-${i}`, {
      score: 1, lastUsed: Date.now() - n, count: 1, accept: 1, type: 0, execute: 0, pinned: false,
    }]));
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, enabled: true, scopes }));
    const u = await import("./sqlUsage");
    const retained = Array.from({ length: 70 }, (_, n) => Object.keys(u.usageSnapshot(`scope-${n}`)).length);
    expect(retained.reduce((a, b) => a + b, 0)).toBe(6000);
    expect(retained.filter(n => n > 0).length).toBeLessThanOrEqual(64);
    expect(Object.keys(u.usageSnapshot("constructor"))).toHaveLength(0);
    expect(u.recordSqlUsage("constructor", "table", "accept")).toBeNull();
    expect(u.recordSqlUsage("c", "__proto__", "accept")).toBeNull();
    expect(u.sqlUsageRank("c", "constructor")).toBe(0);
  });
});
