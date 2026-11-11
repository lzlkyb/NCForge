import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Cell, ExecResult } from "./dbApi";
import { clearSqlBusinessCache, readSqlBusinessMetadata, sqlBusinessMetadata, sqlConditionSuggestions, sqlEnumSuggestions, sqlJoinSuggestions } from "./sqlBusiness";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("./tauri", () => ({ invoke: h.invoke }));
const headers = ["RELATION", "SOURCE_TABLE", "SOURCE_COLUMN", "TARGET_TABLE", "TARGET_COLUMN", "POSITION"];
function rows(columns: string[], data: Cell[][], hasMore = false): ExecResult {
  return { kind: "rows", columns: columns.map(name => ({ name, type: "VARCHAR2", precision: 0, scale: 0 })), rows: data, rowCount: data.length, hasMore, ms: 0, output: [], tx: { autoCommit: true, statements: 0, rows: 0, since: 0 } };
}
const response = (foreign = rows(headers, []), references = rows(headers, []), enums?: ExecResult) => ({ foreign, references, enums, notes: [], sharedSession: false });
const metadata = () => sqlBusinessMetadata("orders", response(rows(headers, [["fk_org", "orders", "pk_org", "orgs", "id", 1]])));
const sources = [{ table: "orders", alias: "o" }, { table: "orgs", alias: "g" }];
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
beforeEach(() => { clearSqlBusinessCache(); h.invoke.mockReset(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-11T10:00:00Z")); });
afterEach(() => { clearSqlBusinessCache(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("NC 补全证据", () => {
  it("依据真实表头解析并按 POSITION 配对复合外键", () => {
    const m = sqlBusinessMetadata("orders", response(rows(headers, [
      ["fk_org", "orders", "org_version", "orgs", "version", 2],
      ["fk_org", "orders", "pk_org", "orgs", "id", 1],
    ]), rows(headers, [["nc_org", "orders", "pk_org", "orgs", "id", 1]])));
    expect(m.relations[0].from).toEqual(["pk_org", "org_version"]);
    expect(sqlJoinSuggestions(m, sources).map(s => s.insertText)).toEqual(["o.pk_org = g.id and o.org_version = g.version", "o.pk_org = g.id"]);
    expect(sqlJoinSuggestions(m, [...sources].reverse())[0].reason).toBe("外键");
  });

  it("缺失表头、冲突位置、缺失位置和截断关系均不构造关联", () => {
    for (const result of [
      rows(["table", "column"], [["orders", "id"]]),
      rows(headers, [["fk", "orders", "x", "orgs", "id", 2]]),
      rows(headers, [["fk", "orders", "x", "orgs", "id", 1], ["fk", "orders", "y", "orgs", "id", 1]]),
      rows(headers, [["fk", "orders", "x", "orgs", "id", 1]], true),
    ]) expect(sqlBusinessMetadata("orders", response(result)).relations).toEqual([]);
  });

  it("NC 局部失败仍保留完整 FK，主会话结果不参与补全", () => {
    const value = { ...response(rows(headers, [["fk", "orders", "pk_org", "orgs", "id", 1]])), partial: true };
    expect(sqlJoinSuggestions(sqlBusinessMetadata("orders", value), sources)).toHaveLength(1);
    expect(sqlJoinSuggestions({ ...metadata(), sharedSession: true }, sources)).toEqual([]);
  });

  it("重复别名和多实例不猜，唯一新 JOIN 别名可以确定关系", () => {
    expect(sqlJoinSuggestions(metadata(), sources.map(s => ({ ...s, alias: "x" })))).toEqual([]);
    const many = [...sources, { table: "orders", alias: "o2" }];
    expect(sqlJoinSuggestions(metadata(), many)).toEqual([]);
    expect(sqlJoinSuggestions(metadata(), many, "o2")[0].insertText).toBe("o2.pk_org = g.id");
    const self = { ...metadata(), relations: [{ id: "外键:self", kind: "外键" as const, source: "orders", target: "orders", from: ["parent"], to: ["id"] }] };
    expect(sqlJoinSuggestions(self, [{ table: "orders", alias: "a" }, { table: "orders", alias: "b" }], "b")).toEqual([]);
  });

  it("不同 schema 的同名物理表不串，并正确引用特殊名称", () => {
    const m = { ...metadata(), schema: "NC" };
    expect(sqlJoinSuggestions(m, [{ table: "orders", alias: "o", schema: "OTHER" }, sources[1]])).toEqual([]);
    expect(sqlJoinSuggestions(m, [{ table: "NC.orders", alias: "o" }, sources[1]])).toHaveLength(1);
    expect(sqlJoinSuggestions(m, [{ table: "NC.orders", alias: "select" }, sources[1]])[0].insertText).toBe('"select".pk_org = g.id');
    expect(sqlJoinSuggestions(m, [{ table: "NC.orders", alias: "odd name" }, sources[1]], undefined, "mysql")[0].insertText).toContain("`odd name`");
  });

  it("FK与业务条件沿用原始alias引号，未起别名时沿用nameRef", () => {
    const quoted = [{ table: "orders", alias: "o", aliasRef: '"o"' }, { table: "orgs", alias: "oRder", aliasRef: '"oRder"' }];
    expect(sqlJoinSuggestions(metadata(), quoted)[0].insertText).toBe('"o".pk_org = "oRder".id');
    expect(sqlConditionSuggestions(quoted[0], [{ name: "dr", type: "NUMBER" }], "plsql")[0].insertText).toBe('nvl("o".dr, 0) = 0');
    expect(sqlConditionSuggestions({ table: "orders", name: "orders", nameRef: '"orders"' }, [{ name: "pk_org" }], "plsql")[0].insertText).toBe('"orders".pk_org = ${1::pk_org}');
    expect(sqlConditionSuggestions({ table: "orders", alias: "a", aliasRef: "[a]" }, [{ name: "dr", type: "INT" }], "tsql")[0].insertText).toBe("isnull([a].dr, 0) = 0");
  });

  it("只解析 FIELD / ENUM_VALUE / ENUM_LABEL，文本按列类型转义", () => {
    const m = sqlBusinessMetadata("orders", response(undefined, undefined, rows(["ENUM_LABEL", "FIELD", "ENUM_VALUE"], [
      ["启用", "status", 1], ["姓名", "status", "O'Brien"], ["空码", "status", ""],
    ])));
    expect(sqlEnumSuggestions(m, "STATUS", "VARCHAR2(20)").map(s => s.insertText)).toEqual(["'1'", "'O''Brien'", "''"]);
    expect(sqlEnumSuggestions(m, "status", "NUMBER(1)").map(s => s.insertText)).toEqual(["1"]);
    expect(sqlEnumSuggestions(m, "status", "")).toEqual([]);
    expect(sqlEnumSuggestions({ ...m, sharedSession: true }, "status", "NUMBER")).toEqual([]);
  });

  it("缺失、截断、空枚举与中文含义冲突不建议", () => {
    for (const result of [rows(["FIELD", "VALUE", "LABEL"], [["status", 1, "启用"]]), rows(["FIELD", "ENUM_VALUE", "ENUM_LABEL"], [["status", 1, "启用"]], true), undefined]) {
      expect(sqlBusinessMetadata("orders", response(undefined, undefined, result)).enums).toEqual([]);
    }
    const m = sqlBusinessMetadata("orders", response(undefined, undefined, rows(["FIELD", "ENUM_VALUE", "ENUM_LABEL"], [["status", 1, "启用"], ["status", "1", "禁用"], ["status", "2", "结束"], ["status", null, "未知"]])));
    expect(sqlEnumSuggestions(m, "status", "NUMBER").map(s => s.insertText)).toEqual(["2"]);
  });

  it("业务条件只依据现存字段，组织参数不复用字面值", () => {
    expect(sqlConditionSuggestions(sources[0], [], "plsql")).toEqual([]);
    expect(sqlConditionSuggestions(sources[0], [{ name: "dr", type: "VARCHAR2" }], "plsql")).toEqual([]);
    const cols = [{ name: "DR", type: "NUMBER(1)" }, { name: "pk_org" }];
    expect(sqlConditionSuggestions(sources[0], cols, "plsql").map(s => s.insertText)).toEqual(["nvl(o.DR, 0) = 0", "o.pk_org = ${1::pk_org}"]);
    expect(sqlConditionSuggestions(sources[0], cols, "tsql")[0].insertText).toBe("isnull(o.DR, 0) = 0");
    expect(sqlConditionSuggestions(sources[0], cols, "postgresql")[0].insertText).toBe("coalesce(o.DR, 0) = 0");
  });
});

describe("补全元数据缓存", () => {
  it("并发合并且固定使用 isolatedOnly，scope 和连接隔离", async () => {
    h.invoke.mockResolvedValue(response());
    const a = readSqlBusinessMetadata("c", "s", "orders");
    expect(readSqlBusinessMetadata("c", "s", "ORDERS")).toBe(a);
    await a;
    expect(h.invoke).toHaveBeenCalledWith("db_relations", { id: "c", table: "orders", isolatedOnly: true });
    await readSqlBusinessMetadata("c", "other", "orders"); await readSqlBusinessMetadata("d", "s", "orders");
    expect(h.invoke).toHaveBeenCalledTimes(3);
    expect(await readSqlBusinessMetadata("c", "s", "OTHER.orders")).toBeNull();
    expect(h.invoke).toHaveBeenCalledTimes(3);
  });

  it("同步异常、异步失败、主会话回退可再次尝试，TTL 后刷新", async () => {
    h.invoke.mockImplementationOnce(() => { throw new Error("sync"); }).mockRejectedValueOnce(new Error("async")).mockResolvedValueOnce({ ...response(), sharedSession: true }).mockResolvedValue(response());
    for (let i = 0; i < 3; i++) expect(await readSqlBusinessMetadata("c", "s", "orders")).toBeNull();
    expect(await readSqlBusinessMetadata("c", "s", "orders")).not.toBeNull();
    expect(h.invoke).toHaveBeenCalledTimes(4);
    vi.advanceTimersByTime(5 * 60000); await readSqlBusinessMetadata("c", "s", "orders");
    expect(h.invoke).toHaveBeenCalledTimes(5);
  });

  it("最多同时两次读取，队列满不残留 null 缓存，清理使旧队列失效", async () => {
    const releases: ((value: ReturnType<typeof response>) => void)[] = [];
    h.invoke.mockImplementation(() => new Promise(resolve => releases.push(resolve)));
    const requests = Array.from({ length: 18 }, (_, i) => readSqlBusinessMetadata("c", "s", `t${i}`)); await tick();
    expect(h.invoke).toHaveBeenCalledTimes(2);
    expect(await readSqlBusinessMetadata("c", "s", "overflow")).toBeNull();
    clearSqlBusinessCache();
    expect(await Promise.all(requests.slice(2))).toEqual(Array(16).fill(null));
    releases.splice(0).forEach(resolve => resolve(response())); await Promise.all(requests.slice(0, 2)); await tick();
    h.invoke.mockResolvedValue(response());
    expect(await readSqlBusinessMetadata("c", "s", "overflow")).not.toBeNull();
    expect(h.invoke).toHaveBeenCalledTimes(3);
  });

  it("过时请求不进入队列，排队时过期不会发命令且后续有效项仍继续", async () => {
    const releases: ((value: ReturnType<typeof response>) => void)[] = [];
    h.invoke.mockImplementation(() => new Promise(resolve => releases.push(resolve)));
    expect(await readSqlBusinessMetadata("c", "s", "no_read", () => false)).toBeNull();
    expect(h.invoke).not.toHaveBeenCalled();
    const first = readSqlBusinessMetadata("c", "s", "first"), second = readSqlBusinessMetadata("c", "s", "second");
    let current = true;
    const obsolete = readSqlBusinessMetadata("c", "s", "obsolete", () => current);
    const last = readSqlBusinessMetadata("c", "s", "last", () => true);
    await tick(); current = false; releases.shift()!(response()); await first; await tick();
    expect(await obsolete).toBeNull();
    expect(h.invoke.mock.calls.map(call => call[1].table)).toEqual(["first", "second", "last"]);
    releases.splice(0).forEach(resolve => resolve(response())); await Promise.all([second, last]);
  });

  it("读取期间过期会丢弃响应且允许重新读取，过时调用不复用缓存", async () => {
    let release!: (value: ReturnType<typeof response>) => void;
    h.invoke.mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValue(response());
    let current = true;
    const pending = readSqlBusinessMetadata("c", "s", "orders", () => current);
    await tick(); current = false; release(response());
    expect(await pending).toBeNull();
    expect(await readSqlBusinessMetadata("c", "s", "orders", () => true)).not.toBeNull();
    expect(h.invoke).toHaveBeenCalledTimes(2);
    expect(await readSqlBusinessMetadata("c", "s", "orders", () => false)).toBeNull();
    expect(h.invoke).toHaveBeenCalledTimes(2);
  });
});
