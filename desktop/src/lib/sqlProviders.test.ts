import { beforeEach, expect, it, vi } from "vitest";
import type * as Monaco from "monaco-editor";
const h = vi.hoisted(() => ({ completions: new Map<string, Monaco.languages.CompletionItemProvider>(), signatures: vi.fn(), links: vi.fn(), columns: vi.fn(), runtime: { status: "connected", currentSchema: "APP", tables: [{ name: "BD_MATERIAL", kind: "TABLE" }, { name: "BD_PROJECT", kind: "TABLE" }], ncNames: { bd_material: "物料", bd_project: "项目" }, tablesAt: 1 }, business: vi.fn(), joins: vi.fn() }));
vi.mock("./monacoSetup", () => ({ monaco: {
  Range: class { constructor(readonly startLineNumber: number, readonly startColumn: number, readonly endLineNumber: number, readonly endColumn: number) {} static fromPositions(a: Monaco.Position, b: Monaco.Position) { return { startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: b.lineNumber, endColumn: b.column }; } },
  languages: { CompletionItemInsertTextRule: { InsertAsSnippet: 4 }, CompletionItemKind: { Field: 1, Property: 2, Keyword: 3, Struct: 4, Interface: 5, Snippet: 6, Function: 7, Variable: 8 }, registerCompletionItemProvider: (id: string, provider: Monaco.languages.CompletionItemProvider) => h.completions.set(id, provider), registerSignatureHelpProvider: h.signatures, registerLinkProvider: h.links },
  editor: { registerLinkOpener: vi.fn() },
} }));
vi.mock("./sqlModels", () => ({ tabIdOfModel: () => "t" }));
vi.mock("./dbStore", () => ({ sqlColumnEpoch: () => 0, sqlTabOf: () => ({ connId: "c" }), columnsOf: h.columns, rtOf: () => h.runtime, connOf: () => ({ id: "c", url: "jdbc:oracle:thin:@test", user: "APP" }) }));
vi.mock("./sqlBusiness", () => ({ clearSqlBusinessCache: vi.fn(), readSqlBusinessMetadata: h.business, sqlConditionSuggestions: () => [], sqlEnumSuggestions: () => [], sqlJoinSuggestions: h.joins }));
vi.mock("./dbActions", () => ({ openTable: vi.fn() }));
vi.mock("./sqlProcArgs", () => ({ procArguments: vi.fn() }));
import { registerSqlProviders } from "./sqlProviders";
import { clearSqlUsage, recordSqlUsage, sqlUsageKey, sqlUsageScope } from "./sqlUsage";
import { connectionKey } from "./dbResultContext";
registerSqlProviders();
beforeEach(() => { h.runtime.tablesAt++; h.business.mockReset().mockResolvedValue(null); h.joins.mockReset().mockReturnValue([]); h.columns.mockReset().mockImplementation(async (_conn: string, table: string) => [{ name: `${table}_id`, full: "NUMBER", zh: null, pk: false }]); });
async function complete(text: string, cursor: number = text.length, cancelled = false) {
  const position = { lineNumber: 1, column: cursor + 1 };
  const prefix = /[\p{L}\p{N}_$#]*$/u.exec(text.slice(0, cursor))![0];
  const model = { getValue: () => text, getValueLength: () => text.length, getVersionId: () => 1, isDisposed: () => false, getLanguageId: () => "ncforge-sql-plsql", getOffsetAt: () => cursor, getPositionAt: (offset: number) => ({ lineNumber: 1, column: offset + 1 }), getWordUntilPosition: () => ({ startColumn: cursor - prefix.length + 1, endColumn: cursor + 1 }) } as unknown as Monaco.editor.ITextModel;
  return await h.completions.get("ncforge-sql-plsql")!.provideCompletionItems(model, position as Monaco.Position, {} as Monaco.languages.CompletionContext, { isCancellationRequested: cancelled } as Monaco.CancellationToken) as Monaco.languages.CompletionList;
}
it("所有方言保留补全、签名和DDL链接", () => {
  expect([...h.completions.keys()]).toHaveLength(8); expect(h.signatures).toHaveBeenCalledTimes(8); expect(h.links).toHaveBeenCalledTimes(8);
});
it("中文命中后插入真实标识符，范围覆盖完整输入词", async () => {
  const result = await complete("select * from 物料");
  expect(result.suggestions.map(s => s.insertText)).toEqual(["bd_material"]);
  expect(result.suggestions[0].filterText).toBe("物料");
  expect(result.suggestions[0].range).toMatchObject({ startColumn: 15, endColumn: 17 });
});
it("同匹配内使用记忆前移且明确前缀不受热门表干扰", async () => {
  const scope = sqlUsageScope(connectionKey({ id: "c", url: "jdbc:oracle:thin:@test", user: "APP" } as never), "APP");
  clearSqlUsage(scope); recordSqlUsage(scope, sqlUsageKey("bd_project"), "accept");
  const result = await complete("select * from bd_");
  expect(result.suggestions.sort((a,b) => a.sortText!.localeCompare(b.sortText!))[0].insertText).toBe("bd_project");
  expect((await complete("select * from bd_mat")).suggestions.map(s => s.insertText)).toEqual(["bd_material"]);
});
it("四表来源全部提供字段，重名风险使用来源别名限定", async () => {
  const sql = "select  from a a1 join b b1 on 1=1 join c c1 on 1=1 join d d1 on 1=1";
  const result = await complete(sql, 7);
  expect(result.suggestions.map(s => s.insertText)).toContain("d1.d_id");
  expect(h.columns).toHaveBeenCalledTimes(4);
});
it("schema限定读取完整身份，跨schema表列表不借用当前schema", async () => {
  const sql = "select a. from other.table1 a";
  await complete(sql, 9); expect(h.columns).toHaveBeenLastCalledWith("c", "other.table1");
  expect((await complete("select * from other.")).suggestions).toEqual([]);
});
it("取消请求无建议且不启动元数据读取", async () => {
  expect((await complete("select a. from a", 9, true)).suggestions).toEqual([]); expect(h.columns).not.toHaveBeenCalled();
});
it("部分词中间接受替换完整标识符，保留字别名自动引用", async () => {
  const r = await complete("select * from bd_material", 20);
  expect(r.suggestions.find(s => s.insertText === "bd_material")?.range).toMatchObject({ startColumn: 15, endColumn: 26 });
  const sql = 'select  from bd_material "select" join bd_project p on 1=1';
  expect((await complete(sql, 7)).suggestions.map(s => s.insertText)).toContain('"select".bd_material_id');
});
it("元数据未完成时返回已有字段快照", async () => {
  h.business.mockImplementation(() => new Promise(() => {}));
  const result = await complete("select * from a a1 join b b1 on ");
  expect(result.suggestions.map(s => s.insertText)).toContain("a1.a_id");
});
it("编辑前一个 ON 时只按已出现的 JOIN 来源推荐关联", async () => {
  h.business.mockResolvedValue({ table: "b" });
  const sql = "select * from a aa join b bb on  join c cc on bb.id=cc.id";
  await complete(sql, sql.indexOf("on ") + 3);
  expect(h.business.mock.calls.map(args => args[2])).toEqual(["b"]);
  expect(h.joins.mock.calls[0][1].map((source: { table: string }) => source.table)).toEqual(["a", "b"]);
  expect(h.joins.mock.calls[0][2]).toBe("bb");
});
it("读取中切schema丢弃过时字段", async () => {
  let resolve: (value: unknown[]) => void = () => {};
  h.columns.mockImplementation(() => new Promise(r => { resolve = r; }));
  const promise = complete("select a. from a", 9);
  h.runtime.currentSchema = "OTHER"; resolve([]);
  expect((await promise).suggestions).toEqual([]);
  h.runtime.currentSchema = "APP";
});
it("普通引号别名保留原文，重复别名不生成歧义字段", async () => {
  const sql = 'select  from a "a" join b "bMixed" on 1=1';
  expect((await complete(sql,7)).suggestions.map(s=>s.insertText)).toContain('"a".a_id');
  expect((await complete(sql,7)).suggestions.map(s=>s.insertText)).toContain('"bMixed".b_id');
  const duplicate = 'select  from a x join b x on 1=1';
  expect((await complete(duplicate,7)).suggestions.map(s=>s.insertText).filter(t=>t.startsWith('x.'))).toEqual([]);
});
it("Oracle 字段提示区分 m 和引用小写 m，引用大写 M 与 m 视为重复", async () => {
  let sql = 'select m. from a m join b "m" on 1=1';
  await complete(sql, sql.indexOf("m.") + 2); expect(h.columns).toHaveBeenLastCalledWith("c", "a");
  sql = 'select "m". from a m join b "m" on 1=1';
  await complete(sql, sql.indexOf('"m".') + 4); expect(h.columns).toHaveBeenLastCalledWith("c", "b");
  h.columns.mockClear(); sql = 'select m. from a m join b "M" on 1=1';
  expect((await complete(sql, sql.indexOf("m.") + 2)).suggestions).toEqual([]);
  expect(h.columns).not.toHaveBeenCalled();
  sql = 'select  from a m join b "M" on 1=1';
  expect((await complete(sql, 7)).suggestions.filter(s => s.insertText === "m" || s.insertText === '"M"' || /^(m|"M")\./.test(s.insertText))).toEqual([]);
});
it("内层同名别名读取内层表，外层读取外层表", async () => {
  const sql = "select e. from outer_table e where exists (select e. from inner_table e)";
  await complete(sql, sql.indexOf("e.") + 2); expect(h.columns).toHaveBeenLastCalledWith("c", "outer_table");
  await complete(sql, sql.lastIndexOf("e.") + 2); expect(h.columns).toHaveBeenLastCalledWith("c", "inner_table");
});
it("CTE和派生表提供已知列，不请求不存在的物理表", async () => {
  const sql = "with x as (select id, name as title from actual_table) select x. from x";
  const result = await complete(sql, sql.indexOf("x.") + 2);
  expect(result.suggestions.map(item => item.insertText)).toEqual(["id", "title"]); expect(h.columns).not.toHaveBeenCalled();
});
it("CTE 表名遮蔽按 Oracle 引用语义区分身份", async () => {
  let sql = 'with "bd_material" as (select 1 from dual) select * from ';
  let suggestions = (await complete(sql)).suggestions.filter(s => s.insertText === "bd_material");
  expect(suggestions).toHaveLength(1); expect(suggestions[0].kind).toBe(4);
  sql = 'with "BD_MATERIAL" as (select 1 from dual) select * from ';
  suggestions = (await complete(sql)).suggestions.filter(s => s.insertText === "bd_material");
  expect(suggestions).toHaveLength(0);
});
it("字符串、注释、重复别名和未知别名不触发字段查询", async () => {
  for (const sql of ["select q'[it's from e.", "select 1 -- e.", "select e. from a e join b e on 1=1", "select missing. from a e"]) {
    const at = sql.indexOf("e. from") >= 0 ? sql.indexOf("e.") + 2 : sql.includes("missing.") ? sql.indexOf("missing.") + 8 : sql.length;
    expect((await complete(sql, at)).suggestions).toEqual([]);
  }
  expect(h.columns).not.toHaveBeenCalled();
});
