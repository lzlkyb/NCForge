// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DbConn } from "./dbApi";
import type { ConnRuntime } from "./dbStore";
import { connectionKey, type ResultExecutionContext } from "./dbResultContext";
import { analyzeSql } from "./sqlScope";

const data = vi.hoisted(() => ({ conn: null as DbConn | null, rt: { status: "connected" } as ConnRuntime, columns: vi.fn(), epoch: 0 }));
vi.mock("./dbStore", () => ({ connOf: (id: string) => id === data.conn?.id ? data.conn : null, rtOf: () => data.rt, columnsOf: data.columns, sqlColumnEpoch: () => data.epoch }));
vi.mock("./sqlFormat", () => ({ sqlLanguageOf: (url: string) => url.includes("postgresql") ? "postgresql" : "plsql" }));

beforeEach(() => {
  vi.resetModules(); localStorage.clear();
  data.epoch = 0;
  data.conn = { id: "conn", name: "测试", source: "manual", url: "jdbc:oracle:thin:@host", user: "NC", engine: "java", propDs: "", env: "dev", note: "", autoCommit: true, hasPassword: false } as DbConn;
  data.rt = { status: "connected", currentSchema: "NC", tables: [{ name: "BD_MATERIAL", kind: "TABLE" }, { name: "BD_ORG", kind: "TABLE" }, { name: "Item", kind: "TABLE" }] };
  data.columns.mockReset(); data.columns.mockResolvedValue([{ name: "CODE" }, { name: "NAME" }]);
});
function identity(sql: string, startedAt = 1): ResultExecutionContext {
  return Object.freeze({ connId: "conn", source: "manual", connectionKey: connectionKey(data.conn), schema: "NC", sql, startedAt });
}

describe("SQL 学习只使用已确认的执行对象", () => {
  it("连接身份和实际 schema 隔离，未选择连接时不学习", async () => {
    const { sqlAssistScope } = await import("./sqlAssistLearning");
    const first = sqlAssistScope("conn"); expect(first).toBeTruthy(); expect(sqlAssistScope(null)).toBeNull();
    data.rt.currentSchema = "OTHER"; expect(sqlAssistScope("conn")).not.toBe(first);
    data.rt.currentSchema = "NC"; data.conn!.url += "other"; expect(sqlAssistScope("conn")).not.toBe(first);
  });

  it("嵌套语句和多个结果去重，只记物理表，不记 CTE/别名/函数", async () => {
    const l = await import("./sqlAssistLearning"), u = await import("./sqlUsage");
    const run = identity("WITH c AS (SELECT * FROM bd_material) SELECT * FROM c x JOIN bd_org o ON 1=1 WHERE EXISTS (SELECT 1 FROM bd_material); SELECT * FROM bd_org; SELECT * FROM unknown; SELECT * FROM generate_series(1,3)");
    l.recordSqlExecutionUsage(run); l.recordSqlExecutionUsage(run);
    const snapshot = u.usageSnapshot(l.sqlAssistScope("conn")!);
    expect(Object.keys(snapshot).sort()).toEqual([u.sqlUsageKey("bd_material"), u.sqlUsageKey("bd_org")].sort());
    expect(snapshot[u.sqlUsageKey("bd_material")].execute).toBe(1);
  });

  it("保留 schema 完整身份，禁止把别的 schema 中同名表当成本地表", async () => {
    const l = await import("./sqlAssistLearning"), u = await import("./sqlUsage");
    l.recordSqlExecutionUsage(identity("SELECT * FROM nc.bd_material; SELECT * FROM other.bd_material"));
    expect(Object.keys(u.usageSnapshot(l.sqlAssistScope("conn")!))).toEqual([u.sqlUsageKey("bd_material")]);
    expect(l.sqlAssistObjectKey({ name: "Item", table: "Item", tableRef: 'NC."Item"', schema: "NC", declaration: 0 }, "NC")).toBe('"Item"');
  });

  it("切 schema 或改连接后到达的旧结果不能污染任何作用域", async () => {
    const l = await import("./sqlAssistLearning"), u = await import("./sqlUsage");
    const run = identity("SELECT * FROM bd_material"), old = l.sqlAssistScope("conn")!;
    data.rt.currentSchema = "OTHER"; l.recordSqlExecutionUsage(run);
    expect(Object.keys(u.usageSnapshot(old))).toHaveLength(0); expect(Object.keys(u.usageSnapshot(l.sqlAssistScope("conn")!))).toHaveLength(0);
    data.rt.currentSchema = "NC"; data.conn!.user = "OTHER"; l.recordSqlExecutionUsage(run);
    expect(Object.keys(u.usageSnapshot(old))).toHaveLength(0);
  });

  it("不学习未完成表名、未闭合引号或缺少元数据的对象", async () => {
    const l = await import("./sqlAssistLearning"), u = await import("./sqlUsage");
    l.recordSqlExecutionUsage(identity('SELECT * FROM bd_material.; SELECT * FROM "Item'));
    expect(Object.keys(u.usageSnapshot(l.sqlAssistScope("conn")!))).toHaveLength(0);
    data.rt.tables = undefined; l.recordSqlExecutionUsage(identity("SELECT * FROM bd_material", 2));
    expect(Object.keys(u.usageSnapshot(l.sqlAssistScope("conn")!))).toHaveLength(0);
  });

  it("引号保持大小写，PostgreSQL 未加引号的名称不能命中混合大小写对象", async () => {
    data.conn!.url = "jdbc:postgresql://host/db";
    data.rt.tables = [{ name: "Item", kind: "TABLE" }, { name: "bd_material", kind: "TABLE" }];
    const l = await import("./sqlAssistLearning"), u = await import("./sqlUsage");
    l.recordSqlExecutionUsage(identity('SELECT * FROM "Item"; SELECT * FROM "item"; SELECT * FROM item; SELECT * FROM bd_material'));
    expect(Object.keys(u.usageSnapshot(l.sqlAssistScope("conn")!)).sort()).toEqual([u.sqlUsageKey('"Item"'), u.sqlUsageKey("bd_material")].sort());
  });

  it("Oracle 未加引号的标识符也不能误命中必须加引号的混合大小写表", async () => {
    const l = await import("./sqlAssistLearning"), u = await import("./sqlUsage");
    l.recordSqlExecutionUsage(identity('SELECT * FROM item; SELECT * FROM "Item"'));
    expect(Object.keys(u.usageSnapshot(l.sqlAssistScope("conn")!))).toEqual([u.sqlUsageKey('"Item"')]);
  });
  it("Oracle 引用大写 CTE 不会被学习为同名物理表，引用小写 CTE 不遮蔽物理表", async () => {
    const l = await import("./sqlAssistLearning"), u = await import("./sqlUsage"), scope = l.sqlAssistScope("conn")!;
    l.recordSqlExecutionUsage(identity('WITH "BD_MATERIAL" AS (SELECT 1 FROM dual) SELECT * FROM bd_material'));
    expect(Object.keys(u.usageSnapshot(scope))).toHaveLength(0);
    l.recordSqlExecutionUsage(identity('WITH "bd_material" AS (SELECT 1 FROM dual) SELECT * FROM bd_material', 2));
    expect(u.usageSnapshot(scope)[u.sqlUsageKey("bd_material")].execute).toBe(1);
  });

  it("共享验证器支持本地结构缓存，不把推导字段当成物理表", async () => {
    data.rt.tables = undefined; data.rt.schema = { fetchedAt: 1, tables: { bd_material: [["CODE", "varchar"]] } };
    const { verifiedSqlSource } = await import("./sqlAssistLearning");
    const source = analyzeSql("SELECT * FROM bd_material").scopes[0].sources[0];
    expect(verifiedSqlSource("conn", source)?.tableRef).toBe("bd_material");
    expect(verifiedSqlSource("conn", { name: "bd_material", columns: ["code"], declaration: 0 })).toBeNull();
  });

  it("成功执行的已复核字段 JOIN 可学习，字段失败时不产生历史", async () => {
    const l = await import("./sqlAssistLearning"), joins = await import("./sqlJoinHistory");
    const sql = "SELECT * FROM bd_material m JOIN bd_org o ON m.code = o.code", analysis = analyzeSql(sql);
    const scope = l.sqlAssistScope("conn")!, generation = joins.sqlJoinHistoryGeneration(scope);
    const sources = analysis.scopes[0].sources.map(s => ({ ...s, table: s.table! }));
    const columns = { bd_material: [{ name: "CODE" }], bd_org: [{ name: "CODE" }] };
    l.recordSqlExecutionUsage(identity(sql, 1), generation);
    await vi.waitFor(() => expect(data.columns).toHaveBeenCalledTimes(2));
    l.recordSqlExecutionUsage(identity(sql, 2), generation);
    await vi.waitFor(() => expect(joins.sqlHistoricalJoinSuggestions(scope, sources, columns)).toHaveLength(1));
    joins.clearSqlJoinHistory(scope); data.columns.mockRejectedValue(new Error("metadata failed"));
    l.recordSqlExecutionUsage(identity(sql, 3), joins.sqlJoinHistoryGeneration(scope));
    await vi.waitFor(() => expect(data.columns).toHaveBeenCalledTimes(6));
    expect(joins.sqlHistoricalJoinSuggestions(scope, sources, columns)).toHaveLength(0);
  });

  it("清除偏好或切换 schema 后，迟到字段结果不能回填历史", async () => {
    const l = await import("./sqlAssistLearning"), joins = await import("./sqlJoinHistory");
    const pending: ((cols: { name: string }[]) => void)[] = [];
    data.columns.mockImplementation(() => new Promise(resolve => pending.push(resolve)));
    const scope = l.sqlAssistScope("conn")!, sql = "SELECT * FROM bd_material m JOIN bd_org o ON m.code = o.code";
    l.recordSqlExecutionUsage(identity(sql, 1), joins.sqlJoinHistoryGeneration(scope));
    expect(data.columns).toHaveBeenCalledTimes(2); joins.clearSqlJoinHistory(scope);
    pending.splice(0).forEach(resolve => resolve([{ name: "CODE" }])); await new Promise(resolve => setTimeout(resolve, 0));
    expect(JSON.parse(localStorage.getItem("ncforge-sql-join-history")!).scopes).toEqual({});
    l.recordSqlExecutionUsage(identity(sql, 2), joins.sqlJoinHistoryGeneration(scope)); data.rt.currentSchema = "OTHER";
    pending.splice(0).forEach(resolve => resolve([{ name: "CODE" }])); await new Promise(resolve => setTimeout(resolve, 0));
    expect(JSON.parse(localStorage.getItem("ncforge-sql-join-history")!).scopes).toEqual({});
  });

  it("同批脚本即使逐句起始时间不同也只奖励同表一次", async () => {
    const l = await import("./sqlAssistLearning"), u = await import("./sqlUsage");
    for (let n = 0; n < 50; n++) l.recordSqlExecutionUsage(identity("select * from bd_material", n + 1), undefined, "run:42");
    expect(u.usageSnapshot(l.sqlAssistScope("conn")!)[u.sqlUsageKey("bd_material")].execute).toBe(1);
  });

  it("同库同 schema 刷新结构后，迟到字段不能回填历史 JOIN", async () => {
    const l = await import("./sqlAssistLearning");
    const pending: ((cols: { name: string }[]) => void)[] = [];
    data.columns.mockImplementation(() => new Promise(resolve => pending.push(resolve)));
    l.recordSqlExecutionUsage(identity("SELECT * FROM bd_material m JOIN bd_org o ON m.code = o.code"));
    expect(pending).toHaveLength(2); data.epoch++;
    pending.forEach(resolve => resolve([{ name: "CODE" }]));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(localStorage.getItem("ncforge-sql-join-history")).toBeNull();
  });

  it("学习字段读取最多两路并发，并跳过无法完整复核的超大表集合", async () => {
    const l = await import("./sqlAssistLearning");
    const tables = ["a", "b", "c", "d"];
    data.rt.tables = tables.map(name => ({ name: name.toUpperCase(), kind: "TABLE" }));
    const pending: (() => void)[] = []; let active = 0, peak = 0;
    data.columns.mockImplementation(() => new Promise(resolve => { active++; peak = Math.max(peak, active); pending.push(() => { active--; resolve([{ name: "CODE" }]); }); }));
    l.recordSqlExecutionUsage(identity("SELECT * FROM a JOIN b ON a.code=b.code JOIN c ON b.code=c.code JOIN d ON c.code=d.code"));
    expect(data.columns).toHaveBeenCalledTimes(2); pending.splice(0).forEach(resolve => resolve());
    await vi.waitFor(() => expect(data.columns).toHaveBeenCalledTimes(4)); pending.splice(0).forEach(resolve => resolve());
    await new Promise(resolve => setTimeout(resolve, 0)); expect(peak).toBe(2);
    data.columns.mockClear(); const many = Array.from({ length: 65 }, (_, i) => `t${i}`); data.rt.tables = many.map(name => ({ name: name.toUpperCase(), kind: "TABLE" }));
    l.recordSqlExecutionUsage(identity(`SELECT * FROM ${many.join(", ")}`, 2)); expect(data.columns).not.toHaveBeenCalled();
  });
});
