import { beforeEach, expect, it, vi } from "vitest";
import type * as Monaco from "monaco-editor";
const h = vi.hoisted(() => ({ completions: new Map<string, Monaco.languages.CompletionItemProvider>(), signatures: vi.fn(), links: vi.fn(), hovers: vi.fn(), columns: vi.fn(), runtime: { status: "connected", currentSchema: "APP", tables: [{ name: "BD_MATERIAL", kind: "TABLE" }, { name: "BD_PROJECT", kind: "TABLE" }], ncNames: { bd_material: "物料", bd_project: "项目" }, tablesAt: 1 }, business: vi.fn(), joins: vi.fn(), peek: vi.fn() }));
vi.mock("./monacoSetup", () => ({ monaco: {
  Range: class { constructor(readonly startLineNumber: number, readonly startColumn: number, readonly endLineNumber: number, readonly endColumn: number) {} static fromPositions(a: Monaco.Position, b: Monaco.Position) { return { startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: b.lineNumber, endColumn: b.column }; } },
  languages: { CompletionTriggerKind: { Invoke: 0 }, CompletionItemInsertTextRule: { InsertAsSnippet: 4 }, CompletionItemKind: { Field: 1, Property: 2, Keyword: 3, Struct: 4, Interface: 5, Snippet: 6, Function: 7, Variable: 8 }, registerCompletionItemProvider: (id: string, provider: Monaco.languages.CompletionItemProvider) => h.completions.set(id, provider), registerSignatureHelpProvider: h.signatures, registerLinkProvider: h.links, registerHoverProvider: h.hovers },
  editor: { registerLinkOpener: vi.fn() },
} }));
vi.mock("./sqlModels", () => ({ tabIdOfModel: () => "t" }));
vi.mock("./dbStore", () => ({ sqlColumnEpoch: () => 0, sqlTabOf: () => ({ connId: "c" }), columnsOf: h.columns, rtOf: () => h.runtime, connOf: () => ({ id: "c", url: "jdbc:oracle:thin:@test", user: "APP" }) }));
vi.mock("./sqlBusiness", async importOriginal => ({ ...await importOriginal<typeof import("./sqlBusiness")>(), clearSqlBusinessCache: vi.fn(), readSqlBusinessMetadata: h.business, peekSqlBusinessMetadata: h.peek, sqlEnumSuggestions: () => [], sqlJoinSuggestions: h.joins }));
vi.mock("./dbActions", () => ({ openTable: vi.fn() }));
vi.mock("./sqlProcArgs", () => ({ procArguments: vi.fn() }));
import { registerSqlProviders } from "./sqlProviders";
import { setSqlTemplatesEnabled } from "./sqlTemplates";
import { clearSqlUsage, recordSqlUsage, sqlUsageKey, sqlUsageScope } from "./sqlUsage";
import { connectionKey } from "./dbResultContext";
registerSqlProviders();
beforeEach(() => { h.runtime.tablesAt++; h.business.mockReset().mockResolvedValue(null); h.joins.mockReset().mockReturnValue([]); h.peek.mockReset().mockReturnValue(null); h.columns.mockReset().mockImplementation(async (_conn: string, table: string) => [{ name: `${table}_id`, full: "NUMBER", zh: null, pk: false }]); });
async function complete(text: string, cursor: number = text.length, cancelled = false) {
  const position = { lineNumber: 1, column: cursor + 1 };
  const prefix = /[\p{L}\p{N}_$#]*$/u.exec(text.slice(0, cursor))![0];
  const model = { getValue: () => text, getValueInRange: (r: { startColumn: number; endColumn: number }) => text.slice(r.startColumn - 1, r.endColumn - 1), getValueLength: () => text.length, getVersionId: () => 1, isDisposed: () => false, getLanguageId: () => "ncforge-sql-plsql", getOffsetAt: () => cursor, getPositionAt: (offset: number) => ({ lineNumber: 1, column: offset + 1 }), getWordUntilPosition: () => ({ startColumn: cursor - prefix.length + 1, endColumn: cursor + 1 }) } as unknown as Monaco.editor.ITextModel;
  return await h.completions.get("ncforge-sql-plsql")!.provideCompletionItems(model, position as Monaco.Position, {} as Monaco.languages.CompletionContext, { isCancellationRequested: cancelled } as Monaco.CancellationToken) as Monaco.languages.CompletionList;
}
it("所有方言保留补全、签名和DDL链接", () => {
  expect([...h.completions.keys()]).toHaveLength(8); expect(h.signatures).toHaveBeenCalledTimes(8); expect(h.links).toHaveBeenCalledTimes(8);
  expect(h.hovers).toHaveBeenCalledTimes(8);
});
it("没连库且表清单还没加载时，空列表说明原因而不是一片空白", async () => {
  const tables = h.runtime.tables; h.runtime.status = "connecting"; h.runtime.tables = [];
  try {
    const items = (await complete("select * from ")).suggestions;
    expect(items).toHaveLength(1);
    expect(items[0].label).toMatchObject({ label: expect.stringContaining("正在连接") });
  } finally { h.runtime.status = "connected"; h.runtime.tables = tables; }
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
it("字段角色按真实表与外键方向识别，同等匹配优先键字段", async () => {
  const column = (name: string, pk = false) => ({ name, full: "NUMBER", pk });
  h.columns.mockImplementation(async (_conn: string, table: string) => table === "bd_material"
    ? [column("AAA"), column("ZZ_LINE", true), column("ZZ_PARENT", true), column("ZPARENT_ALT"), column("ZP"), column("NC_REF")]
    : [column("ZZ_PARENT")]);
  h.peek.mockImplementation((_conn, _scope, table) => ({ table, relations: [
    { source: "BD_MATERIAL", target: "BD_PROJECT", kind: "外键", from: ["ZZ_PARENT", "ZPARENT_ALT"], to: ["ID", "ALT_ID"] },
    { source: "BD_MATERIAL", target: "BD_PROJECT", kind: "NC类引用", from: ["NC_REF"], to: ["ID"] },
    { source: "BD_PROJECT", target: "BD_MATERIAL", kind: "外键", from: ["OTHER"], to: ["AAA"] },
  ] }));
  const sql = "SELECT m. FROM bd_material m JOIN bd_project p ON 1=1";
  const items = (await complete(sql, 9)).suggestions.sort((a, b) => a.sortText!.localeCompare(b.sortText!));
  expect(items.slice(0, 4).map(item => item.insertText)).toEqual(["zz_line", "zz_parent", "zparent_alt", "aaa"]);
  expect(items[1]).toMatchObject({ ncforgeColumnKeys: { primary: true, foreign: true, detail: "联合主键 · ZZ_LINE + ZZ_PARENT\n外键（1/2） · ZZ_PARENT → BD_PROJECT.ID" } });
  expect(items[2]).toMatchObject({ ncforgeColumnKeys: { primary: false, foreign: true } });
  expect(items[3]).not.toMatchObject({ ncforgeColumnKeys: expect.anything() });
  expect(items.find(item => item.insertText === "nc_ref")).toMatchObject({ ncforgeColumnKeys: undefined,
    documentation: { value: expect.stringContaining("NC类引用 · NC_REF → BD_PROJECT.ID") } });
  const other = (await complete(sql.replace("m.", "p."), 9)).suggestions;
  expect(other[0]).toMatchObject({ insertText: "zz_parent", ncforgeColumnKeys: undefined });
  const exact = (await complete(sql.replace("m.", "m.zp"), 11)).suggestions.sort((a, b) => a.sortText!.localeCompare(b.sortText!));
  expect(exact[0].insertText).toBe("zp");
});
it("schema限定读取完整身份，跨schema表列表不借用当前schema", async () => {
  const sql = "select a. from other.table1 a";
  await complete(sql, 9); expect(h.columns).toHaveBeenLastCalledWith("c", "other.table1");
  // 空列表换成一句说明：跨 schema 前缀必然没候选，白屏等于说「这个库没表」。
  const other = (await complete("select * from other.")).suggestions;
  expect(other.some(s => s.insertText)).toBe(false);
  expect(String((other[0].label as { label: string }).label)).toContain("只补全当前 schema");
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
// 最常见写法是 `SELECT * FROM po_order`，而联查模板只在裸表名起手时进列表。
// 所以这条路径必须先读一次关系，表名项的说明行才标得出「支持主子表联查」。
const billMeta = {
  table: "bd_material", schema: "APP",
  relations: [{ id: "外键 · FK_MATERIAL_PROJECT", source: "bd_project", target: "bd_material", from: ["pk_project"], to: ["pk_project"], kind: "外键" }],
  enums: [], partial: false, sharedSession: false,
};
it("FROM 后打全表名时预读关系，表名项说明里标出主子表联查", async () => {
  h.business.mockResolvedValue(billMeta);
  h.peek.mockReturnValue(billMeta);
  const r = await complete("select * from bd_material");
  expect(h.business.mock.calls[0].slice(0, 3)).toEqual(["c", expect.any(String), "bd_material"]);
  const item = r.suggestions.find(s => s.insertText === "bd_material");
  expect(item?.label).toMatchObject({ description: expect.stringContaining("支持主子表联查") });
  // 光有说明却点不出来等于没做：表名末尾要能直接接上子表。
  expect(h.peek).toHaveBeenCalled();
  expect(r.suggestions.map(s => s.insertText)).toContain("bd_material LEFT JOIN bd_project ON bd_project.pk_project = bd_material.pk_project");
});
// 说明行写着「支持主子表联查」但用户点不动，等于没做：动作本身也要进列表，
// 按 Ctrl+空格 就能看见「这儿还能做什么」，不必记 Ctrl+. 或去行号旁找灯泡。
it("表位置的动作以补全项出现，选中后唤起同一个 CodeAction 菜单", async () => {
  h.business.mockResolvedValue(billMeta);
  h.peek.mockReturnValue(billMeta);
  const actions = (await complete("select * from bd_material")).suggestions
    .filter(s => (s.command as { id?: string } | undefined)?.id === "ncforge.sql.quickFix");
  // 已经在语句里：只能追加，替换整条会抹掉用户写的 SELECT。
  expect(actions.map(s => (s.label as { label: string }).label)).toEqual(["查看全部关联"]);
  // 不插任何字符：空 range + 空 insertText，只负责唤起菜单。
  expect(actions.every(s => s.insertText === "")).toBe(true);
});
// 光标压在 `*` 上：这条动作必须排在所有候选之前。31 个字段的名字会让它永远看不见。
it("光标压在 * 上时「展开 *」置顶，并且直接执行 editor action", async () => {
  const items = (await complete("select * from bd_material", 7)).suggestions;
  const action = items.find(s => (s.command as { id?: string } | undefined)?.id === "ncforge.sql.runAction");
  expect(action).toBeTruthy();
  expect(action!.label).toMatchObject({ label: "展开 * 为字段列表" });
  expect(action!.command).toMatchObject({ arguments: ["ncforge.sql.expandStar"] });
  // `\u0000` 前缀比表名的 `!` 与关键字的数字都小，所以它一定是第一行。
  expect(String(action!.sortText).startsWith("\u0000")).toBe(true);
  expect(items.every(s => String(s.sortText) >= String(action!.sortText))).toBe(true);
});
// B 的入口：不在 `*` 上，靠打出来的词把动作搜出来。
it("打 exp 能搜到「展开 *」，并按关键词删掉已输入的词", async () => {
  const items = (await complete("select * from bd_material where exp")).suggestions;
  const action = items.find(s => (s.command as { id?: string } | undefined)?.id === "ncforge.sql.runAction");
  expect(action).toBeTruthy();
  // label 必须以关键词打头：Monaco 拿 filterText 去套 label 算高亮，两者不等长会涂错字。
  expect(action!.label).toMatchObject({ label: "exp" });
  expect((action!.label as { detail?: string }).detail).toContain("展开 * 为字段列表");
  expect(action!.filterText).toBe("exp");
  expect(action!.range).toMatchObject({ startColumn: 33, endColumn: 36 });
});
// 裸表名起手：整条联查（要挑子表，走菜单）与 INSERT 模板（单值，直接执行）同时出现。
it("裸表名起手时同时给出整条联查与 INSERT 模板", async () => {
  h.business.mockResolvedValue(billMeta);
  h.peek.mockReturnValue(billMeta);
  const ids = (await complete("bd_material")).suggestions
    .map(s => (s.command as { id?: string } | undefined)?.id).filter(Boolean);
  expect(ids).toContain("ncforge.sql.quickFix");
  expect(ids).toContain("ncforge.sql.runAction");
});
it("词中光标不预读关系；联查候选整词锚定，JOIN 不塞进词中间", async () => {
  h.peek.mockReturnValue(billMeta);
  const r = await complete("select * from bd_material", 20);
  expect(h.business).not.toHaveBeenCalled();
  const join = r.suggestions.find(s => String(s.insertText).startsWith("bd_material LEFT JOIN"));
  expect(join).toBeTruthy();
  expect(join!.range).toMatchObject({ startColumn: 15, endColumn: 26 });
  expect(r.suggestions.some(s => String(s.insertText).startsWith(" LEFT JOIN"))).toBe(false);
  // 词中也有「查看全部关联」动作项：Ctrl+空格 不必记键位就能唤起菜单。
  expect(r.suggestions.some(s => (s.command as { id?: string } | undefined)?.id === "ncforge.sql.quickFix")).toBe(true);
});
it("元数据未完成时返回已有字段快照", async () => {
  h.business.mockImplementation(() => new Promise(() => {}));
  const result = await complete("select * from a a1 join b b1 on ");
  expect(result.suggestions.map(s => s.insertText)).toContain("a1.a_id = $0");
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
it("冷缓存提示加载，刷新后提供字段", async () => {
  let finish: (columns: unknown[]) => void = () => {};
  h.columns.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const sql = "select a. from a";
  const first = await complete(sql, 9);
  expect(first.suggestions).toEqual([expect.objectContaining({
    label: expect.objectContaining({ label: "字段加载中" }),
    insertText: "",
    range: expect.objectContaining({ startColumn: 10, endColumn: 10 }),
  })]);
  finish([{ name: "id", full: "NUMBER", zh: null, pk: true }]);
  expect((await complete(sql, 9)).suggestions.map(item => item.insertText)).toEqual(["id"]);
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
it("语句还没开始就打了字：表名之外，每张表都带一条整条查询", async () => {
  const result = await complete("bd_");
  expect(result.suggestions.map(s => s.insertText)).toEqual([
    "bd_material", "bd_project",
    "SELECT * FROM bd_material;$0", "SELECT * FROM bd_project;$0",
  ]);
  // 这个位置不该再请求字段：没有来源表可言
  expect(h.columns).not.toHaveBeenCalled();
});
it("表名前缀唯一命中时，默认选中整条查询并保留表名和计数候选", async () => {
  const items = (await complete("bd_mat")).suggestions;
  const inserts = items.map(s => s.insertText);
  expect(inserts[0]).toBe("bd_material");
  expect(inserts).toContain("SELECT * FROM bd_material;$0");
  expect(inserts).toContain("SELECT COUNT(*) FROM bd_material;$0");
  const table = items.find(s => s.insertText === "bd_material")!;
  const template = items.find(s => s.insertText === "SELECT * FROM bd_material;$0")!;
  expect(template.sortText! < table.sortText!).toBe(true);
  expect(template).toMatchObject({ preselect: true, filterText: "bd_mat", range: { startColumn: 1, endColumn: 7 } });
});
it("NC 中文名前缀唯一命中时，Monaco 可用原输入过滤整条查询候选", async () => {
  expect((await complete("物")).suggestions).toContainEqual(expect.objectContaining({
    insertText: "SELECT * FROM bd_material;$0", filterText: "物", preselect: true,
  }));
});
it("支持分号后新语句，保留输入中已有的分号", async () => {
  const sql = "select 1 from dual; bd_mat;";
  expect((await complete(sql, sql.length - 1)).suggestions.map(s => s.insertText)).toContain("SELECT * FROM bd_material$0");
});
it("不在其他语句中间扩写，也不改写已有的语句内容", async () => {
  for (const sql of ["delete bd_mat", "bd_mat where id = 1", "select * from a join bd_mat"]) {
    expect((await complete(sql, sql.indexOf("bd_mat") + 6)).suggestions.some(s => s.preselect)).toBe(false);
  }
});
// 2026-11-17 推翻原设计（原断言是「多命中一条模板都不给」）。那条规则把能力锁死在
// 「用户已经知道表名」上——打 `po_` 命中 po_order / po_praybill 时反而什么都没有，
// 用户只会读成「这功能不存在」。现在的取舍是：每条命中都给整条查询，但只给第一条。
it("多条前缀命中时每张表各给一条整条查询，只给第一条且都不预选", async () => {
  const items = (await complete("bd_")).suggestions;
  const queries = items.filter(s => s.insertText.startsWith("SELECT "));
  expect(queries.map(s => s.insertText)).toEqual([
    "SELECT * FROM bd_material;$0", "SELECT * FROM bd_project;$0",
  ]);
  // COUNT / FOR UPDATE 与字段模板要逐表读字段，只在唯一命中时给
  expect(queries.some(s => s.insertText.startsWith("SELECT COUNT"))).toBe(false);
  // 多命中时预选哪一条都是猜：Enter 会插一张用户没选的表
  expect(items.every(s => !s.preselect)).toBe(true);
});
it("多条前缀命中时整条查询排在所有表名之后", async () => {
  const items = (await complete("bd_")).suggestions;
  const tables = items.filter(s => !s.insertText.startsWith("SELECT ")).map(s => s.sortText!);
  const queries = items.filter(s => s.insertText.startsWith("SELECT ")).map(s => s.sortText!);
  expect(tables.length && queries.length).toBeTruthy();
  expect(tables.every(t => queries.every(q => t < q))).toBe(true);
});
it("新语句开头什么都没打：给一条 SELECT * FROM 骨架并预选", async () => {
  const items = (await complete("")).suggestions;
  const skeleton = items.find(s => s.insertText === "SELECT * FROM ");
  expect(skeleton).toMatchObject({ preselect: true, insertTextRules: 4 });
  expect(skeleton!.sortText).toBe("!");
  // 骨架不顶掉表名：想知道表叫什么的人直接往下选
  expect(items.map(s => s.insertText)).toContain("bd_material");
});
it("表名补全提供有来源的关联查询，保留默认单表查询", async () => {
  h.business.mockResolvedValue({ table: "bd_material", relations: [{ id: "NC类引用:ref1", kind: "NC类引用",
    source: "bd_project", target: "bd_material", from: ["material_id", "org"], to: ["id", "org"] }] });
  const items = (await complete("物料")).suggestions;
  expect(items).toContainEqual(expect.objectContaining({ preselect: true, insertText: "SELECT * FROM bd_material;$0" }));
  expect(items).toContainEqual(expect.objectContaining({
    label: { label: "关联查询 · 物料 + 项目", description: "NC类引用" },
    documentation: { value: expect.stringContaining("NC类引用 · ref1") },
    insertText: "SELECT a.*, b.*\nFROM bd_material a\nJOIN bd_project b ON b.material_id = a.id and b.org = a.org;",
  }));
});
it("已经在 from 后面时不出模板，只给表名", async () => {
  expect((await complete("select * from bd_mat")).suggestions.map(s => s.insertText)).toEqual(["bd_material"]);
  expect((await complete("update bd_mat")).suggestions.map(s => s.insertText)).toEqual(["bd_material"]);
});
it("上一句没写分号时那个词是别名，不算语句起点", async () => {
  const inserts = (await complete("select 1 from dual bd_mat")).suggestions.map(s => s.insertText);
  expect(inserts.some(text => text.startsWith("SELECT "))).toBe(false);
});
it("关掉模板开关后只剩表名", async () => {
  setSqlTemplatesEnabled(false);
  try {
    expect((await complete("bd_mat")).suggestions.map(s => s.insertText)).toEqual(["bd_material"]);
  } finally {
    setSqlTemplatesEnabled(true);
  }
});

async function billSchema(check: () => Promise<void>, root = "po_order", body = "po_order_b", rootKey = "pk_order", bodyKey = rootKey) {
  const tables = h.runtime.tables, names = { ...h.runtime.ncNames };
  h.runtime.tablesAt++;
  h.runtime.tables = [{ name: root.toUpperCase(), kind: "TABLE" }, { name: body.toUpperCase(), kind: "TABLE" }];
  Object.assign(h.runtime.ncNames, { [root]: "采购订单", [body]: "采购订单子表" });
  h.columns.mockImplementation(async (_conn: string, table: string) =>
    (table === root ? ["VBILLCODE", rootKey.toUpperCase()] : [bodyKey.toUpperCase()]).map(name => ({ name, full: "VARCHAR2(20)", zh: null, pk: false })));
  h.business.mockResolvedValue({ table: root, relations: [{ id: "NC类引用:body_head", kind: "NC类引用", source: body, target: root, from: [bodyKey], to: [rootKey] }], enums: [], partial: false, sharedSession: false });
  try { await check(); }
  finally { h.runtime.tables = tables; h.runtime.ncNames = names; }
}

it("依据 NC 类引用提供采购主子表模板，插入空引号落点", async () => {
  await billSchema(async () => {
    const items = (await complete("po_order")).suggestions;
    const bill = items.find(s => typeof s.label !== "string" && s.label.label === "采购订单 · 按单号关联 采购订单子表")!;
    expect(bill).toMatchObject({ insertText: "SELECT a.*, b.*\nFROM po_order a\nLEFT JOIN po_order_b b\n    ON a.pk_order = b.pk_order\nWHERE a.vbillcode = '$0';", insertTextRules: 4, filterText: "po_order",
      label: { description: "NC类引用" }, documentation: { value: expect.stringContaining("NC类引用 · body_head · a.pk_order = b.pk_order") },
      ncforgePreview: { text: expect.stringMatching(/LEFT JOIN po_order_b[\s\S]*WHERE a\.vbillcode = '';$/) } });
    expect(h.columns.mock.calls.map(call => call[1])).toEqual(["po_order", "po_order_b"]);
    expect(items.map(s => s.insertText)).toContain("SELECT * FROM po_order;$0");
  });
});

it("中文名精确匹配主表，不被同前缀的子表中文名阻止", async () => {
  await billSchema(async () => {
    const items = (await complete("采购订单")).suggestions;
    expect(items).toContainEqual(expect.objectContaining({ filterText: "采购订单", insertText: expect.stringContaining("LEFT JOIN po_order_b") }));
    expect((await complete("采购")).suggestions.some(s => s.insertText.includes("LEFT JOIN"))).toBe(false);
  });
});

it("采购模板保留已有分号，不在 FROM 或字符串中扩写", async () => {
  await billSchema(async () => {
    const sql = "select 1 from dual; po_order;";
    const template = (await complete(sql, sql.length - 1)).suggestions.find(s => s.insertText.includes("LEFT JOIN po_order_b") && s.insertText.includes("vbillcode"))!;
    expect(template.insertText).toMatch(/WHERE a.vbillcode = '\$0'$/);
    expect((await complete("select * from po_order")).suggestions.map(s => s.insertText)).toEqual(["po_order", "po_order_b"]);
    expect((await complete("select 'po_order'", 16)).suggestions).toEqual([]);
  });
});

it("子表缺失时只给主表模板，字段查询失败时保留普通表名补全", async () => {
  await billSchema(async () => {
    h.runtime.tables = h.runtime.tables.slice(0, 1);
    const items = (await complete("po_order")).suggestions;
    expect(items.some(s => s.insertText.includes("LEFT JOIN"))).toBe(false);
    expect(items.some(s => s.insertText.includes("a.vbillcode = '$0'"))).toBe(true);
    h.runtime.tablesAt++; h.columns.mockRejectedValue(new Error("字段不可读"));
    const unavailable = (await complete("po_order")).suggestions;
    expect(unavailable.map(s => s.insertText)).toContain("po_order");
    expect(unavailable.some(s => s.insertText.includes("vbillcode"))).toBe(false);
  });
});

it("查询字段过程中切换 schema，不接受旧 schema 的采购模板", async () => {
  await billSchema(async () => {
    const schema = h.runtime.currentSchema;
    h.columns.mockImplementation(async () => { h.runtime.currentSchema = "OTHER"; return [{ name: "VBILLCODE", full: "VARCHAR2(20)", pk: false }]; });
    try { expect((await complete("po_order")).suggestions).toEqual([]); }
    finally { h.runtime.currentSchema = schema; }
  });
});

it("需要引号的物理表保留原有模板，不从折叠字段缓存生成单号模板", async () => {
  await billSchema(async () => {
    h.runtime.tables = [{ name: "SELECT", kind: "TABLE" }];
    const items = (await complete("sel")).suggestions;
    expect(items.map(s => s.insertText)).toContain('SELECT * FROM "SELECT";$0');
    expect(items.some(s => s.insertText.includes("vbillcode"))).toBe(false);
    expect(h.columns).not.toHaveBeenCalled();
  });
});

it("不同单据和不规则子表名称均使用元数据关联字段", async () => {
  for (const [root, body, rootKey, bodyKey] of [["so_sale", "sale_details", "sale_id", "parent_id"], ["ic_receipt", "warehouse_rows", "receipt_id", "bill_ref"], ["custom_bill", "custom_line", "id", "header_id"]]) {
    await billSchema(async () => {
      const items = (await complete(root)).suggestions;
      expect(items).toContainEqual(expect.objectContaining({ insertText: `SELECT a.*, b.*\nFROM ${root} a\nLEFT JOIN ${body} b\n    ON a.${rootKey} = b.${bodyKey}\nWHERE a.vbillcode = '$0';` }));
    }, root, body, rootKey, bodyKey);
  }
});

it("多个子表分别列出带表名的候选", async () => {
  await billSchema(async () => {
    h.runtime.tables.push({ name: "TAX_ROWS", kind: "TABLE" });
    h.business.mockResolvedValue({ table: "po_order", relations: [
      { id: "外键:line", kind: "外键", source: "po_order_b", target: "po_order", from: ["pk_order"], to: ["pk_order"] },
      { id: "NC类引用:tax", kind: "NC类引用", source: "tax_rows", target: "po_order", from: ["pk_order"], to: ["pk_order"] },
    ] });
    const bills = (await complete("po_order")).suggestions.filter(s => s.insertText.includes("LEFT JOIN") && s.insertText.includes("vbillcode"));
    expect(bills).toHaveLength(2);
    expect(bills.every(s => s.insertText.split("LEFT JOIN").length === 2)).toBe(true);
    expect(bills.map(s => s.label)).toContainEqual(expect.objectContaining({ label: "采购订单 · 按单号关联 tax_rows" }));
  });
});

it("关系为空、不可用和字段不可读时不猜采购关联", async () => {
  await billSchema(async () => {
    h.business.mockResolvedValue(null);
    let items = (await complete("po_order")).suggestions;
    expect(items.some(s => s.insertText.includes("LEFT JOIN"))).toBe(false);
    expect(items.some(s => s.insertText.includes("a.vbillcode = '$0'"))).toBe(true);
    expect(h.columns.mock.calls.map(c => c[1])).toEqual(["po_order"]);
    h.business.mockResolvedValue({ table: "po_order", relations: [{ id: "外键:child", kind: "外键", source: "po_order_b", target: "po_order", from: ["missing_field"], to: ["pk_order"] }] });
    items = (await complete("po_order")).suggestions;
    expect(items.some(s => s.insertText.includes("LEFT JOIN"))).toBe(false);
  });
});

it("关系延迟后刷新可用，读取中切 schema 不继续查询子表", async () => {
  await billSchema(async () => {
    const value = await h.business();
    let resolve: (metadata: typeof value) => void = () => {};
    h.business.mockImplementation(() => new Promise(r => { resolve = r; }));
    expect((await complete("po_order")).suggestions.some(s => s.insertText.includes("LEFT JOIN"))).toBe(false);
    resolve(value); h.business.mockResolvedValue(value);
    expect((await complete("po_order")).suggestions.some(s => s.insertText.includes("LEFT JOIN"))).toBe(true);
    const schema = h.runtime.currentSchema;
    h.runtime.tablesAt++; h.columns.mockClear();
    h.business.mockImplementation(async () => { h.runtime.currentSchema = "OTHER"; return value; });
    try { expect((await complete("po_order")).suggestions).toEqual([]); }
    finally { h.runtime.currentSchema = schema; }
    expect(h.columns.mock.calls.some(c => c[1] === "po_order_b")).toBe(false);
  });
});

it("没有单号字段仍可生成通用关联查询，接受后触发字段选择", async () => {
  await billSchema(async () => {
    h.columns.mockResolvedValue([{ name: "PK_ORDER", full: "VARCHAR2(20)", pk: true }]);
    const items = (await complete("po_order")).suggestions;
    expect(items).toContainEqual(expect.objectContaining({ insertText: "SELECT a.*, b.*\nFROM po_order a\nLEFT JOIN po_order_b b\n    ON a.pk_order = b.pk_order\nWHERE $0;", command: { id: "editor.action.triggerSuggest", title: "选择条件字段" } }));
    expect(items.some(s => s.insertText.includes("vbillcode"))).toBe(false);
    expect(items.some(s => s.insertText === "SELECT a.*\nFROM po_order a\nWHERE $0;")).toBe(true);
  });
});

it("整单模板把筛选光标限定在内层x字段，保留外层全部明细", async () => {
  await billSchema(async () => {
    const sql = "select 1 from dual; po_order;";
    const item = (await complete(sql, sql.length - 1)).suggestions.find(s => s.insertText.includes("WHERE EXISTS"))!;
    expect(item.insertText).toContain("WHERE x.pk_order = a.pk_order\n      AND (x.$0)\n)");
    expect(item.insertText.endsWith(";")).toBe(false);
    expect(item.command?.id).toBe("editor.action.triggerSuggest");
    h.runtime.tablesAt++;
    h.columns.mockImplementation(async (_conn: string, table: string) => [{ name: table === "po_order_b" ? "PK_MATERIAL" : "VBILLCODE", full: "VARCHAR2(20)", pk: false }]);
    const inner = "SELECT a.*, b.* FROM po_order a LEFT JOIN po_order_b b ON a.pk_order=b.pk_order WHERE EXISTS (SELECT 1 FROM po_order_b x WHERE x.pk_order=a.pk_order AND x.);";
    const fields = (await complete(inner, inner.indexOf("AND x.") + 6)).suggestions;
    expect(fields.map(s => s.insertText)).toContain("pk_material = '$0'");
    expect(fields.map(s => s.insertText).some(text => text.includes("vbillcode"))).toBe(false);
  });
});
it("表名补全提供缺关联、孤立记录和明细计数模板，复合关系使用实际字段", async () => {
  await billSchema(async () => {
    h.columns.mockImplementation(async (_conn: string, table: string) => [{ name: "PK_ORDER", type: "VARCHAR2", full: "VARCHAR2(20)", pk: table === "po_order" }]);
    const items = (await complete("po_order")).suggestions;
    expect(items.some(s => typeof s.label !== "string" && s.label.label.includes("没有关联行"))).toBe(true);
    expect(items.some(s => s.insertText.includes("b.PK_ORDER IS NOT NULL"))).toBe(true);
    expect(items.some(s => s.insertText.includes("NVL(d.DETAIL_COUNT, 0)") && s.insertText.includes("GROUP BY c.PK_ORDER"))).toBe(true);
  });
});
it("实际日期字段可选择四类动态时间条件，完整字段重复引用，字符日期不提供", async () => {
  conditionFields();
  const items = (await complete(conditionSql + "a.created")).suggestions;
  expect(items.map(s => s.insertText)).toContain("created >= CAST(TRUNC(CURRENT_DATE) AS DATE) AND a.created < CAST(TRUNC(CURRENT_DATE) + 1 AS DATE)$0");
  expect(items.filter(s => { const label = s.label; return typeof label !== "string" && ["今天", "本月", "上月", "近七天"].some(name => label.label.endsWith(name)); })).toHaveLength(4);
  expect((await complete(conditionSql + "a.dbilldate")).suggestions.some(s => s.insertText.includes("CURRENT_DATE"))).toBe(false);
  const operator = (await complete(conditionSql + "a.created 本月")).suggestions;
  expect(operator).toHaveLength(1); expect(operator[0].insertText).toContain("AND a.created <");
  expect(typeof operator[0].label !== "string" && operator[0].label.label).toBe("时间快捷 · 本月");
  expect(operator[0]).toMatchObject({ ncforgePreview: { title: "条件模板", text: expect.stringContaining("AND a.created <") } });
});
it("直接NOT时隐藏四种复合时间快捷，显式分组时可以选", async () => {
  conditionFields();
  expect((await complete(conditionSql + "NOT a.created")).suggestions.some(s => s.insertText.includes("CURRENT_DATE"))).toBe(false);
  const sql = conditionSql + "NOT (a.created)";
  expect((await complete(sql, sql.length - 1)).suggestions.some(s => s.insertText.includes("CURRENT_DATE"))).toBe(true);
});

async function archiveSchema(check: () => Promise<void>) {
  const tables = h.runtime.tables;
  h.runtime.tables = [{ name: "ORDER_LINES", kind: "TABLE" }, { name: "ITEM_CATALOG", kind: "TABLE" }];
  h.columns.mockImplementation(async (_conn: string, table: string) => (table === "order_lines" ? [{ name: "PK_ITEM", zh: "物料", pk: false }] :
    [{ name: "ITEM_ID", zh: null, pk: true }, { name: "ITEM_NUMBER", zh: "物料编码", pk: false }, { name: "ITEM_TITLE", zh: "物料名称", pk: false }]).map(c => ({ ...c, full: "VARCHAR2(30)" })));
  h.business.mockResolvedValue({ table: "order_lines", relations: [{ id: "外键:item", kind: "外键", source: "ORDER_LINES", target: "ITEM_CATALOG", from: ["PK_ITEM"], to: ["ITEM_ID"] }], enums: [], partial: false, sharedSession: false });
  try { await check(); } finally { h.runtime.tables = tables; }
}
it("SELECT引用字段补全同时替换完整限定字段和增加档案LEFT JOIN", async () => {
  await archiveSchema(async () => {
    const sql = "SELECT a.pk_item FROM order_lines a WHERE 1=1;";
    const items = (await complete(sql, sql.indexOf("pk_item") + 7)).suggestions;
    const item = items.find(s => typeof s.label !== "string" && s.label.label.includes("展开档案"))!;
    expect(item.insertText).toContain("a.pk_item,\n    ref1.item_number AS pk_item_code");
    expect(item.range).toMatchObject({ startColumn: 8, endColumn: 17 });
    expect(item.additionalTextEdits?.[0]).toMatchObject({ range: { startColumn: sql.indexOf("WHERE") + 1, endColumn: sql.indexOf("WHERE") + 1 }, text: expect.stringContaining("LEFT JOIN item_catalog ref1") });
    expect(item).toMatchObject({ ncforgePreview: { text: expect.stringMatching(/^SELECT a\.pk_item,[\s\S]*LEFT JOIN item_catalog ref1[\s\S]*WHERE 1=1;$/),
      highlights: [expect.any(Object), expect.any(Object)] } });
    expect(item.insertTextRules).toBeUndefined();
    expect(item.filterText).toBe("a.pk_item");
    expect(items.map(s => s.insertText)).toContain("pk_item");
    expect((await complete("SELECT 物料 FROM order_lines a", 9)).suggestions.some(s => s.insertText.includes("item_number"))).toBe(true);
  });
});
it("档案展开不用于WHERE、表达式、DISTINCT、跨schema和关闭的模板", async () => {
  await archiveSchema(async () => {
    for (const sql of ["SELECT * FROM order_lines a WHERE a.pk_item", "SELECT DISTINCT a.pk_item FROM order_lines a", "SELECT sum(a.pk_item) FROM order_lines a", "SELECT a.pk_item FROM other.order_lines a"]) {
      const items = (await complete(sql, sql.indexOf("pk_item") + 7)).suggestions;
      expect(items.some(s => s.insertText.includes("item_number")), sql).toBe(false);
    }
    setSqlTemplatesEnabled(false);
    try { expect((await complete("SELECT a.pk_item FROM order_lines a", 16)).suggestions.map(s => s.insertText)).toEqual(["pk_item"]); }
    finally { setSqlTemplatesEnabled(true); }
  });
});
it("档案元数据读取时schema变化，旧SELECT编辑计划不会返回", async () => {
  await archiveSchema(async () => {
    const schema = h.runtime.currentSchema;
    h.business.mockImplementation(async () => { h.runtime.currentSchema = "OTHER"; return null; });
    try { expect((await complete("SELECT a.pk_item FROM order_lines a", 16)).suggestions).toEqual([]); }
    finally { h.runtime.currentSchema = schema; }
  });
});

function conditionFields() {
  h.columns.mockImplementation(async (_conn: string, table: string) => (table === "lines" ?
    [{ name: "QTY", full: "NUMBER(20,8)", zh: "数量" }, { name: "MATERIAL", full: "VARCHAR2(20)", zh: "物料" }] :
    [{ name: "PK_ORG", full: "VARCHAR2(20)", zh: "组织" }, { name: "CREATED", full: "DATE", zh: "创建日期" }, { name: "DBILLDATE", full: "CHAR(19)", zh: "单据日期" }])
    .map(c => ({ ...c, pk: false })));
}
const conditionSql = "SELECT a.*, b.* FROM orders a LEFT JOIN lines b ON a.id=b.head_id WHERE ";
it("WHERE 和 AND 位置中文搜索字段直接补条件，主子表别名明确", async () => {
  conditionFields();
  expect((await complete(conditionSql + "组织")).suggestions).toContainEqual(expect.objectContaining({ insertText: "a.pk_org = '$0'", insertTextRules: 4 }));
  const items = (await complete(conditionSql + "a.pk_org='x' AND 数量")).suggestions;
  expect(items.map(s => s.insertText)).toContain("b.qty = $0");
  expect(items.map(s => s.insertText)).toContain("b.qty > $0");
  expect(items.map(s => s.insertText)).toContain("b.qty BETWEEN ${1} AND ${2}$0");
});
it("别名点号后补条件不重复别名，日期使用真实类型", async () => {
  conditionFields();
  const inserts = (await complete(conditionSql + "a.")).suggestions.map(s => s.insertText);
  expect(inserts).toContain("created = DATE '$0'");
  expect(inserts).toContain("dbilldate = '$0'");
  expect(inserts.some(s => s.startsWith("a."))).toBe(false);
  expect((await complete(conditionSql + "a.created")).suggestions.map(s => s.insertText)).toContain("created >= DATE '${1}' AND a.created < DATE '${2}'$0");
});
it("已输入字段后可选择运算符，替换范围只覆盖运算符前缀", async () => {
  conditionFields();
  const sql = conditionSql + "b.qty BE";
  expect((await complete(sql)).suggestions).toContainEqual(expect.objectContaining({ insertText: "BETWEEN ${1} AND ${2}$0", range: expect.objectContaining({ startColumn: sql.length - 1, endColumn: sql.length + 1 }) }));
  expect((await complete(conditionSql + "a.created ")).suggestions.map(s => s.insertText)).toContain(">= DATE '${1}' AND a.created < DATE '${2}'$0");
});
it("SELECT、已有比较式、函数参数和模板关闭时保留纯字段补全", async () => {
  conditionFields();
  for (const [sql, at] of [["SELECT a. FROM orders a", 9], [conditionSql + "a.pk_o = 'x'", conditionSql.length + 6], [conditionSql + "coalesce(a., 1)=1", conditionSql.length + 11]] as const) {
    const items = (await complete(sql, at)).suggestions;
    expect(items.map(s => s.insertText)).toContain("pk_org");
    expect(items.some(s => s.insertText.includes("$0"))).toBe(false);
  }
  setSqlTemplatesEnabled(false);
  try { expect((await complete(conditionSql + "a.")).suggestions.map(s => s.insertText)).toContain("pk_org"); }
  finally { setSqlTemplatesEnabled(true); }
});

it("业务条件不进入函数参数，直接 NOT 后不插入未分组的复合范围", async () => {
  conditionFields();
  const sql = "SELECT * FROM orders a WHERE COALESCE(pk_org, '')='x'";
  expect((await complete(sql, sql.indexOf("pk_org") + 6)).suggestions.some(s => s.insertText.includes("pk_org ="))).toBe(false);
  for (const suffix of ["NOT a.created", "NOT a.created "]) {
    expect((await complete(conditionSql + suffix)).suggestions.some(s => s.insertText.includes(" AND "))).toBe(false);
  }
  expect((await complete(conditionSql + "NOT (a.created)", conditionSql.length + 14)).suggestions.some(s => s.insertText.includes(" AND a.created <"))).toBe(true);
  h.business.mockResolvedValue({ table: "lines", relations: [], enums: [] });
  h.joins.mockReturnValue([{ label: "复合关联", insertText: "a.id=b.id AND a.org=b.org", reason: "外键", source: "复合键", documentation: "" }]);
  await complete("SELECT * FROM orders a JOIN lines b ON NOT ");
  expect(h.joins).not.toHaveBeenCalled();
});
