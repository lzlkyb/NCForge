import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ColumnInfo } from "./dbApi";

const h = vi.hoisted(() => ({ columns: vi.fn(), pending: [] as { resolve: (columns: ColumnInfo[]) => void; reject: (error: Error) => void }[] }));
vi.mock("./dbStore", () => ({ columnsOf: h.columns }));
const fields = [{ name: "CODE" }] as ColumnInfo[];
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
const observe = (promise: Promise<ColumnInfo[]>) => promise.catch((error: Error) => error);

beforeEach(() => {
  vi.resetModules(); h.columns.mockReset(); h.pending = [];
  h.columns.mockImplementation(() => new Promise<ColumnInfo[]>((resolve, reject) => h.pending.push({ resolve, reject })));
});
afterEach(async () => { while (h.pending.length) { h.pending.splice(0).forEach(p => p.resolve(fields)); await settle(); } });

describe("SQL 辅助字段读取共享闸门", () => {
  it("全局只有两路读取，普通请求按入队顺序等待", async () => {
    const { sqlAssistColumns: read } = await import("./sqlAssistColumns");
    const first = observe(read("a", "one", () => true)), second = observe(read("b", "two", () => true)), third = observe(read("c", "three", () => true));
    expect(h.columns.mock.calls).toEqual([["a", "one"], ["b", "two"]]);
    h.pending.shift()!.resolve(fields); await settle(); expect(h.columns.mock.calls[2]).toEqual(["c", "three"]);
    h.pending.splice(0).forEach(p => p.resolve(fields)); expect(await Promise.all([first, second, third])).toEqual([fields, fields, fields]);
  });

  it("明确别名的优先请求前置，但不能抢占正在执行的请求", async () => {
    const { sqlAssistColumns: read } = await import("./sqlAssistColumns");
    const tasks = ["one", "two", "three"].map(table => observe(read("c", table, () => true)));
    tasks.push(observe(read("c", "alias", () => true, true))); expect(h.columns).toHaveBeenCalledTimes(2);
    h.pending.shift()!.resolve(fields); await settle(); expect(h.columns.mock.calls[2][1]).toBe("alias");
    h.pending.shift()!.resolve(fields); await settle(); expect(h.columns.mock.calls[3][1]).toBe("three");
    h.pending.splice(0).forEach(p => p.resolve(fields)); await Promise.all(tasks);
  });

  it("合并同连接同表请求，每个订阅者分别检查是否过期，完成后无额外缓存", async () => {
    const { sqlAssistColumns: read } = await import("./sqlAssistColumns");
    let current = true;
    const stale = observe(read("c", "table", () => current)), live = observe(read("c", "table", () => true));
    expect(h.columns).toHaveBeenCalledTimes(1); current = false; h.pending.shift()!.resolve(fields);
    expect(await stale).toEqual(new Error("SQL 字段读取已过期")); expect(await live).toBe(fields);
    const again = observe(read("c", "table", () => true)); expect(h.columns).toHaveBeenCalledTimes(2); h.pending.shift()!.resolve(fields); expect(await again).toBe(fields);
  });

  it("排队中的请求过期后拒绝，不消费底层读取名额", async () => {
    const { sqlAssistColumns: read } = await import("./sqlAssistColumns");
    let current = true;
    const active = [observe(read("c", "one", () => true)), observe(read("c", "two", () => true))];
    const expired = observe(read("c", "stale", () => current)); current = false;
    h.pending.shift()!.resolve(fields); await settle(); expect(await expired).toEqual(new Error("SQL 字段读取已过期")); expect(h.columns).toHaveBeenCalledTimes(2);
    h.pending.shift()!.resolve(fields); await Promise.all(active);
  });

  it("最多排队16个请求，清理过期项之后仍可接收新的有效请求", async () => {
    const { sqlAssistColumns: read } = await import("./sqlAssistColumns");
    let current = true;
    const tasks = [observe(read("c", "one", () => true)), observe(read("c", "two", () => true))];
    tasks.push(observe(read("c", "stale", () => current)));
    for (let i = 0; i < 15; i++) tasks.push(observe(read("c", `queued${i}`, () => true)));
    expect(await observe(read("c", "overflow", () => true))).toEqual(new Error("SQL 字段读取队列已满"));
    current = false; tasks.push(observe(read("c", "replacement", () => true))); expect(h.columns).toHaveBeenCalledTimes(2);
    while (h.pending.length) { h.pending.splice(0).forEach(p => p.resolve(fields)); await settle(); }
    const outcomes = await Promise.all(tasks); expect(outcomes.filter(o => o instanceof Error)).toHaveLength(1); expect(h.columns).toHaveBeenCalledTimes(18);
  });

  it("失败后移除飞行记录，下次请求可以重试", async () => {
    const { sqlAssistColumns: read } = await import("./sqlAssistColumns");
    const first = observe(read("c", "table", () => true)), second = observe(read("c", "table", () => true));
    h.pending.shift()!.reject(new Error("metadata error")); expect(await first).toEqual(new Error("metadata error")); expect(await second).toEqual(new Error("metadata error"));
    const retry = observe(read("c", "table", () => true)); expect(h.columns).toHaveBeenCalledTimes(2); h.pending.shift()!.resolve(fields); expect(await retry).toBe(fields);
  });

  it("新的连接上下文不合并到同id已过期的飞行请求", async () => {
    const { sqlAssistColumns: read } = await import("./sqlAssistColumns");
    let current = true;
    const old = observe(read("c", "table", () => current)); current = false;
    const fresh = observe(read("c", "table", () => true)); expect(h.columns).toHaveBeenCalledTimes(2);
    expect(await old).toEqual(new Error("SQL 字段读取已过期"));
    h.pending.shift()!.resolve([{ name: "OLD" }] as ColumnInfo[]); await settle(); h.pending.shift()!.resolve(fields); expect(await fresh).toBe(fields);
  });

  it("同一排队表的优先订阅可提升位置，保持一次底层请求", async () => {
    const { sqlAssistColumns: read } = await import("./sqlAssistColumns");
    const tasks = ["one", "two", "normal", "target"].map(table => observe(read("c", table, () => true)));
    tasks.push(observe(read("c", "target", () => true, true)));
    h.pending.shift()!.resolve(fields); await settle(); expect(h.columns.mock.calls[2][1]).toBe("target");
    while (h.pending.length) { h.pending.splice(0).forEach(p => p.resolve(fields)); await settle(); }
    expect(await Promise.all(tasks)).toEqual(Array.from({ length: 5 }, () => fields)); expect(h.columns).toHaveBeenCalledTimes(4);
  });

  it("初始已过期及失效检查异常不会读取元数据", async () => {
    const { sqlAssistColumns: read } = await import("./sqlAssistColumns");
    expect(await observe(read("c", "one", () => false))).toEqual(new Error("SQL 字段读取已过期"));
    expect(await observe(read("c", "two", () => { throw new Error("disposed"); }))).toEqual(new Error("SQL 字段读取已过期"));
    expect(h.columns).not.toHaveBeenCalled();
  });
});
