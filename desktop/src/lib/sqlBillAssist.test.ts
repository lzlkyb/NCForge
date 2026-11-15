// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { monaco } from "./monacoSetup";

const h = vi.hoisted(() => ({
  enabled: true,
  providers: new Set<monaco.languages.CodeActionProvider>(),
  scope: undefined as unknown,
  analysis: { tokens: [{ kind: "identifier", text: "po_order", start: 0, end: 8 }], roles: new Map(), scopes: [], regions: [] } as Record<string, unknown>,
  columns: {
    po_order: [{ name: "vbillcode", full: "VARCHAR2(40)", pk: false }, { name: "pk_order", full: "CHAR(20)", pk: true }],
    po_order_b: [{ name: "pk_order", full: "CHAR(20)", pk: false }],
  } as Record<string, { name: string; full: string; pk: boolean }[]>,
  meta: {
    table: "po_order", schema: "nc65", partial: false, sharedSession: false, enums: [],
    relations: [{ id: "外键 · FK_ORDER_B", source: "po_order_b", target: "po_order", from: ["pk_order"], to: ["pk_order"], kind: "外键" }],
  } as null | Record<string, unknown>,
}));

vi.mock("./monacoSetup", () => ({ monaco: {
  MarkerSeverity: { Info: 2 },
  Range: { fromPositions: (a: { lineNumber: number; column: number }, b: { lineNumber: number; column: number }) =>
    ({ startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: b.lineNumber, endColumn: b.column }) },
  languages: { registerCodeActionProvider: (_: string, p: monaco.languages.CodeActionProvider) => { h.providers.add(p); return { dispose: () => h.providers.delete(p) }; } },
} }));
vi.mock("./monacoSql", () => ({
  dialectOfSqlModel: () => "plsql", SQL_LANGUAGE_IDS: ["sql"],
  sqlAnalysisOf: () => h.analysis,
}));
vi.mock("./sqlTemplates", async (orig) => ({ ...(await orig<typeof import("./sqlTemplates")>()), getSqlTemplatesEnabled: () => h.enabled }));
vi.mock("./sqlScope", () => ({ sqlScopeAt: () => h.scope }));
vi.mock("./sqlUsage", () => ({ sqlUsageScope: () => "scope" }));
vi.mock("./dbResultContext", () => ({ connectionKey: () => "id" }));
vi.mock("./sqlModels", () => ({ tabIdOfModel: () => "t1" }));
vi.mock("./sqlFormatPrefs", () => ({ getSqlFormatPrefs: () => ({ keywordCase: "upper" }) }));
vi.mock("./sqlBusiness", () => ({ peekSqlBusinessMetadata: () => h.meta, readSqlBusinessMetadata: async () => h.meta }));
vi.mock("./sqlAssistColumns", () => ({ sqlAssistColumns: async (_c: string, table: string) => h.columns[table] ?? [] }));
vi.mock("./dbStore", () => ({
  connOf: () => ({ id: "c1" }), sqlTabOf: () => ({ connId: "c1" }), sqlColumnEpoch: () => 1,
  rtOf: () => ({ status: "connected", currentSchema: "nc65", info: { schema: "nc65" },
    tables: [{ name: "po_order" }, { name: "po_order_b" }], ncNames: { po_order: "采购订单", po_order_b: "采购订单明细" } }),
}));

import { clearBillActionCache, wireSqlBillAssist } from "./sqlBillAssist";

const cleanups: (() => void)[] = [];
beforeEach(() => {
  h.enabled = true; h.scope = undefined;
  h.analysis = { tokens: [{ kind: "identifier", text: "po_order", start: 0, end: 8 }], roles: new Map(), scopes: [], regions: [] };
  h.meta = { ...h.meta, relations: [{ id: "外键 · FK_ORDER_B", source: "po_order_b", target: "po_order", from: ["pk_order"], to: ["pk_order"], kind: "外键" }] } as never;
  h.providers.clear(); clearBillActionCache();
});
afterEach(() => { cleanups.splice(0).forEach(d => d()); });

function fake(sql = "po_order") {
  const model = { uri: { path: "/sql" }, getVersionId: () => 1, isDisposed: () => false, getValue: () => sql,
    getPositionAt: (offset: number) => ({ lineNumber: 1, column: offset + 1 }), getOffsetAt: (p: { column: number }) => p.column - 1 };
  const editor = { getModel: () => model };
  const handle = wireSqlBillAssist(editor as unknown as monaco.editor.IStandaloneCodeEditor);
  cleanups.push(() => handle.dispose());
  return model as unknown as monaco.editor.ITextModel;
}

const at = (column: number) => ({ startLineNumber: 1, endLineNumber: 1, startColumn: column, endColumn: column }) as monaco.Range;
const ask = (model: monaco.editor.ITextModel, column = 5, cancelled = false) =>
  [...h.providers][0].provideCodeActions(model, at(column), {} as monaco.languages.CodeActionContext, { isCancellationRequested: cancelled } as monaco.CancellationToken);

it("光标停在裸表名上时给一条联查，替换的是表名本身", async () => {
  const model = fake(), result = await ask(model);
  expect(result?.actions).toHaveLength(1);
  expect(result?.actions[0].title).toBe("生成主子表联查：采购订单 + 采购订单明细");
  const edit = result?.actions[0].edit?.edits?.[0] as { versionId: number; textEdit: { range: { startColumn: number; endColumn: number }; text: string } };
  expect(edit.versionId).toBe(1);
  expect(edit.textEdit.range).toMatchObject({ startColumn: 1, endColumn: 9 });
  expect(edit.textEdit.text).toContain("LEFT JOIN po_order_b b");
  expect(edit.textEdit.text).toContain("a.pk_order = b.pk_order");
});

// 语句内的别名、字段、CTE 都推不出「要接哪张子表」，也不是表声明：不给，免得追加到词中间。
it("语句内非表声明的位置不给（别名、字段、CTE）", async () => {
  h.scope = { start: 0, end: 20 };
  expect((await ask(fake()))?.actions).toEqual([]);
});

// 🔴 这条是 2026-11-14 修的死入口：`SELECT * FROM po_order` 上的 chip 和补全列表里的
// 动作项都能点，但 CodeAction 原先在该位置返回空 → 点下去只是弹一个空菜单。
it("语句内的表名上只追加 JOIN，不动用户写好的 SELECT", async () => {
  h.scope = { start: 0, end: 20 };
  h.analysis = { tokens: [{ kind: "identifier", text: "po_order", start: 14, end: 22 }], roles: new Map(),
    scopes: [{ sources: [{ declaration: 0, table: "po_order" }] }], regions: [] };
  const result = await ask(fake("select * from po_order"), 19);
  expect(result?.actions).toHaveLength(1);
  expect(result?.actions[0].title).toBe("追加 LEFT JOIN：采购订单明细");
  const edit = result?.actions[0].edit?.edits?.[0] as { textEdit: { range: { startColumn: number; endColumn: number }; text: string } };
  // 插入点是表名末尾的空范围，不是整个表名——替换会连 `FROM` 后的内容一起吞掉。
  expect(edit.textEdit.range).toMatchObject({ startColumn: 23, endColumn: 23 });
  expect(edit.textEdit.text).toBe(" LEFT JOIN po_order_b ON po_order_b.pk_order = po_order.pk_order");
});

// 补全列表里的动作项按「光标前的词」判定；CodeAction 若只认「光标压着的词」，
// 用户打完表名多敲一个空格就会点出空菜单。
it("光标停在表名后的空格上也认", async () => {
  h.scope = { start: 0, end: 20 };
  h.analysis = { tokens: [{ kind: "identifier", text: "po_order", start: 14, end: 22 }], roles: new Map(),
    scopes: [{ sources: [{ declaration: 0, table: "po_order" }] }], regions: [] };
  const result = await ask(fake("select * from po_order "), 24);
  expect(result?.actions.map(a => a.title)).toEqual(["追加 LEFT JOIN：采购订单明细"]);
});

it("已经 JOIN 过这张子表时不再追加第二条", async () => {
  h.scope = { start: 0, end: 20 };
  h.analysis = { tokens: [{ kind: "identifier", text: "po_order", start: 14, end: 22 }], roles: new Map(),
    scopes: [{ sources: [{ declaration: 0, table: "po_order" }] }], regions: [] };
  expect((await ask(fake("select * from po_order left join po_order_b b on 1=1"), 19))?.actions).toEqual([]);
});

it("主表没有单号字段时不硬凑一条要用户自己补条件的 SQL", async () => {
  h.columns = { po_order: [{ name: "pk_order", full: "CHAR(20)", pk: true }], po_order_b: [{ name: "pk_order", full: "CHAR(20)", pk: false }] };
  expect((await ask(fake()))?.actions).toEqual([]);
  h.columns = { po_order: [{ name: "vbillcode", full: "VARCHAR2(40)", pk: false }, { name: "pk_order", full: "CHAR(20)", pk: true }], po_order_b: [{ name: "pk_order", full: "CHAR(20)", pk: false }] };
});

it("没读到关系、取消请求、模板开关关闭时都不出菜单", async () => {
  h.meta = null;
  expect((await ask(fake()))?.actions).toEqual([]);
  h.meta = { table: "po_order", schema: "nc65", partial: false, sharedSession: false, enums: [], relations: [] } as never;
  expect((await ask(fake()))?.actions).toEqual([]);
  h.enabled = false;
  expect((await ask(fake()))?.actions).toEqual([]);
});
