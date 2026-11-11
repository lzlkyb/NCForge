// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeSql, type SqlAnalysis } from "./sqlScope";
import type { SqlBusinessColumn, SqlBusinessSource } from "./sqlBusiness";

const STORAGE_KEY = "ncforge-sql-join-history";
const columns: Record<string, SqlBusinessColumn[]> = { orders: [{ name: "pk_org" }, { name: "org_version" }, { name: "id" }], orgs: [{ name: "id" }, { name: "version" }] };
const defaultSql = "select o.id from orders o join orgs g on o.pk_org = g.id";
const physicalSources = (analysis: SqlAnalysis): SqlBusinessSource[] => analysis.scopes.flatMap(s => s.sources.filter(s => s.table).map(s => ({ ...s, table: s.table! })));
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-11T10:00:00Z")); vi.resetModules(); localStorage.clear(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function fixture() {
  const h = await import("./sqlJoinHistory"), u = await import("./sqlUsage");
  const scope = u.sqlUsageScope("jdbc:oracle:thin:user/secret@host:1521/db", "NC");
  const learn = (sql: string, token: string, fields = columns, expectedGeneration?: number) => {
    const analysis = analyzeSql(sql, "plsql");
    return h.recordVerifiedSqlJoins(scope, physicalSources(analysis), fields, analysis, token, expectedGeneration);
  };
  const suggest = (sql = defaultSql, fields = columns) => h.sqlHistoricalJoinSuggestions(scope, physicalSources(analyzeSql(sql, "plsql")), fields);
  return { h, u, scope, learn, suggest };
}

describe("成功查询的关联写法记忆", () => {
  it("至少两次成功执行才提供候选，重复批次去重，并使用当前 alias", async () => {
    const { learn, suggest } = await fixture();
    expect(learn(defaultSql, "run1")).toBe(1); expect(suggest()).toEqual([]);
    expect(learn(defaultSql, "run1")).toBe(0); expect(suggest()).toEqual([]);
    expect(learn(defaultSql, "run2")).toBe(1);
    expect(suggest("select x.id from orders x join orgs y on 1=1")[0]).toMatchObject({ insertText: "x.pk_org = y.id", reason: "历史写法" });
    expect(suggest()[0].source).toContain("成功执行 2 次");
  });

  it("推荐沿用当前aliasRef和nameRef，不存旧别名引用", async () => {
    const { h, scope, learn } = await fixture();
    learn(defaultSql, "1"); learn(defaultSql, "2");
    const sources = [{ table: "orders", alias: "o", aliasRef: '"o"' }, { table: "orgs", alias: "oRder", aliasRef: '"oRder"' }];
    expect(h.sqlHistoricalJoinSuggestions(scope, sources, columns)[0].insertText).toBe('"o".pk_org = "oRder".id');
    expect(h.sqlHistoricalJoinSuggestions(scope, [{ table: "orders", name: "orders", nameRef: '"orders"' }, { table: "orgs", name: "orgs", nameRef: '"orgs"' }], columns)[0].insertText).toBe('"orders".pk_org = "orgs".id');
    expect(localStorage.getItem(STORAGE_KEY)).not.toContain("oRder");
  });

  it("复合关联字段一起学习，逆向写法合并，任一字段未验证不学习子集", async () => {
    const { learn, suggest } = await fixture();
    const sql = "select o.id from orders o join orgs g on o.org_version=g.version and o.pk_org=g.id";
    expect(learn(sql, "a")).toBe(1);
    expect(learn("select o.id from orders o join orgs g on g.id=o.pk_org and g.version=o.org_version", "b")).toBe(1);
    expect(suggest()[0].insertText).toBe("o.org_version = g.version and o.pk_org = g.id");
    const partial = { ...columns, orders: columns.orders.filter(c => c.name !== "org_version") };
    expect(learn(sql, "c", partial)).toBe(0); expect(suggest(defaultSql, partial)).toEqual([]);
  });

  it("只保存表字段身份与统计，不保存SQL正文、字面值、旧alias和连接凭据", async () => {
    const { learn } = await fixture();
    const sql = "select old_order.id from orders old_order join orgs old_org on old_order.pk_org = old_org.id where old_order.id = 'PRIVATE_VALUE'";
    learn(sql, "1"); learn(sql, "2");
    const raw = localStorage.getItem(STORAGE_KEY)!;
    for (const value of ["select", "PRIVATE_VALUE", "old_order", "old_org", "secret", "jdbc:", "run1"]) expect(raw).not.toContain(value);
    expect(raw).toContain("nc.orders"); expect(raw).toContain("pk_org");
  });

  it("词法识别排除字符串注释、表达式、投影、OR条件、CTE和self join", async () => {
    const { learn, suggest } = await fixture();
    const invalid = [
      "select 'o.pk_org = g.id' from orders o join orgs g on 1=1",
      "select o.id from orders o join orgs g on 1=1 -- o.pk_org = g.id",
      "select o.id from orders o join orgs g on o.pk_org = g.id + 1",
      "select o.id from orders o join orgs g on o.pk_org + 1 = g.id",
      "select o.id from orders o join orgs g on not(o.pk_org = g.id)",
      "select o.id from orders o join orgs g on case when o.pk_org=g.id then 0 else 1 end=1",
      "select o.id from orders o join orgs g on o.pk_org = g.id::integer",
      "select o.pk_org = g.id from orders o, orgs g",
      "select o.id from orders o join orgs g on o.pk_org=g.id or o.id=g.version",
      "with x as (select id from orders) select x.id from x join orgs g on x.id=g.id",
      "select a.id from orders a join orders b on a.pk_org=b.id",
      "select o.id from orders o join orgs g on unknown.pk_org=g.id",
      "select o.id from orders o join orgs o on o.pk_org=o.id",
    ];
    for (let i = 0; i < invalid.length; i++) expect(learn(invalid[i], `run-${i}`)).toBe(0);
    expect(suggest()).toEqual([]); expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("同scope重复别名和多实例不猜，内外同名alias依查询作用域独立验证", async () => {
    const { learn, suggest } = await fixture();
    learn(defaultSql, "1"); learn(defaultSql, "2");
    expect(suggest("select o.id from orders o join orgs o on 1=1")).toEqual([]);
    expect(suggest("select o.id from orders o join orgs g on 1=1 join orders other on 1=1")).toEqual([]);
    const nested = "select o.id from orders o join orgs g on o.pk_org=g.id where exists (select o.id from another o join orgs g on o.id=g.id)";
    expect(learn(nested, "3", { ...columns, another: [{ name: "different" }] })).toBe(1);
    expect(suggest()[0].source).toContain("成功执行 3 次");
  });

  it("数据库和schema隔离，带owner与当前schema同名可匹配，其他owner不串", async () => {
    const { h, u, scope, learn, suggest } = await fixture();
    learn(defaultSql, "1"); learn(defaultSql, "2");
    const src = physicalSources(analyzeSql(defaultSql, "plsql"));
    expect(h.sqlHistoricalJoinSuggestions(u.sqlUsageScope("other-db", "NC"), src, columns)).toEqual([]);
    expect(h.sqlHistoricalJoinSuggestions(u.sqlUsageScope("jdbc:oracle:thin:user/secret@host:1521/db", "OTHER"), src, columns)).toEqual([]);
    expect(suggest("select o.id from NC.orders o join NC.orgs g on 1=1")).toHaveLength(1);
    expect(suggest("select o.id from OTHER.orders o join orgs g on 1=1")).toEqual([]);
    const mixed = analyzeSql("select a.id from NC.orders a join OTHER.orders b on a.id=b.id join orgs g on a.pk_org=g.id", "plsql");
    // A basename-only field cache is not evidence for two owners' same table.
    expect(h.recordVerifiedSqlJoins(scope, physicalSources(mixed), columns, mixed, "mixed")).toBe(0);
  });

  it("列删除后停止推荐，带引号表和列按精确身份隔离", async () => {
    const { h, scope, learn, suggest } = await fixture();
    learn(defaultSql, "1"); learn(defaultSql, "2");
    expect(suggest(defaultSql, { ...columns, orgs: [{ name: "renamed" }] })).toEqual([]);
    const sql = 'select a."Key" from "Item" a join orgs g on a."Key"=g.id';
    const analysis = analyzeSql(sql, "plsql"), src = physicalSources(analysis);
    const fields = { '"Item"': [{ name: "Key" }], orgs: [{ name: "id" }] };
    expect(h.recordVerifiedSqlJoins(scope, src, fields, analysis, "quote1")).toBe(1);
    expect(h.recordVerifiedSqlJoins(scope, src, fields, analysis, "quote2")).toBe(1);
    expect(h.sqlHistoricalJoinSuggestions(scope, src, fields)[0].insertText).toContain('a."Key"');
    const other = physicalSources(analyzeSql('select a."Key" from "item" a join orgs g on 1=1', "plsql"));
    expect(h.sqlHistoricalJoinSuggestions(scope, other, { '"item"': [{ name: "Key" }], orgs: [{ name: "id" }] })).toEqual([]);
  });

  it("清空立即落盘，generation阻止旧异步回填，重新使用可以再次学习", async () => {
    const { h, scope, learn, suggest } = await fixture();
    const generation = h.sqlJoinHistoryGeneration(scope);
    learn(defaultSql, "1"); learn(defaultSql, "2"); expect(suggest()).toHaveLength(1);
    expect(h.clearSqlJoinHistory(scope)).toBe(true); expect(suggest()).toEqual([]);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).scopes[scope]).toBeUndefined();
    expect(learn(defaultSql, "old", columns, generation)).toBe(0);
    expect(learn(defaultSql, "1", columns, h.sqlJoinHistoryGeneration(scope))).toBe(1);
    expect(learn(defaultSql, "2")).toBe(1); expect(suggest()).toHaveLength(1);
  });

  it("关闭记忆会停止学习和推荐，重新加载可恢复已保存的写法", async () => {
    const { u, learn, suggest } = await fixture();
    learn(defaultSql, "1"); learn(defaultSql, "2");
    u.setSqlUsageEnabled(false); expect(learn(defaultSql, "3")).toBe(0); expect(suggest()).toEqual([]);
    u.setSqlUsageEnabled(true); vi.resetModules();
    const fresh = await fixture(); expect(fresh.suggest()[0].source).toContain("成功执行 2 次");
  });

  it("排序随14天半衰期衰减，180天过期，并有每scope50与总500上限", async () => {
    const { h, scope, learn, suggest } = await fixture();
    learn(defaultSql, "1"); learn(defaultSql, "2");
    vi.advanceTimersByTime(14 * 86400000);
    expect(suggest()).toHaveLength(1);
    learn("select o.id from orders o join orgs g on o.id=g.id", "3");
    learn("select o.id from orders o join orgs g on o.id=g.id", "4");
    expect(suggest()[0].insertText).toBe("o.id = g.id");
    vi.advanceTimersByTime(180 * 86400000); expect(suggest()).toEqual([]);
    const scopes: Record<string, unknown[]> = {};
    for (let s = 0; s < 12; s++) scopes[`s${s}`] = Array.from({ length: 60 }, (_, i) => ({ left: `nc.a${i}`, right: `nc.b${i}`, from: ["id"], to: ["id"], count: 2, score: 2, lastUsed: Date.now() - s - i }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, scopes })); vi.resetModules();
    const fresh = await import("./sqlJoinHistory"); fresh.clearSqlJoinHistory(scope);
    const retained = Object.values(JSON.parse(localStorage.getItem(STORAGE_KEY)!).scopes) as unknown[][];
    expect(retained.every(list => list.length <= 50)).toBe(true); expect(retained.reduce((n, list) => n + list.length, 0)).toBe(500);
    expect(h.sqlJoinHistoryGeneration(scope)).toBe(0);
  });

  it("损坏存储逐条跳过，保存失败不影响当前会话，危险scope不能污染对象", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, scopes: { s: [{ left: "a", right: "b", from: [], to: [], count: 2, score: 2, lastUsed: Date.now() }] } }));
    const { h, scope, learn, suggest } = await fixture();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    expect(learn(defaultSql, "1")).toBe(1); expect(learn(defaultSql, "2")).toBe(1); expect(suggest()).toHaveLength(1);
    expect(h.clearSqlJoinHistory("__proto__")).toBe(false);
    expect(h.sqlHistoricalJoinSuggestions("constructor", [], {})).toEqual([]);
    expect(h.clearSqlJoinHistory(scope)).toBe(false); expect(suggest()).toEqual([]);
  });
});
