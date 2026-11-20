// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { monaco } from "./monacoSetup";
import type { ColumnInfo } from "./dbApi";
const h = vi.hoisted(() => ({ epoch: 0, conn: { id: "c", url: "jdbc:oracle:thin:@host", user: "NC" }, schema: "NC", connected: true, dialect: "plsql", tables: ["LINES", "HEAD", "ALT_HEAD"], columns: vi.fn(), metadata: vi.fn(), toast: vi.fn(), commands: new Map<string, (...args: unknown[]) => void>() }));
vi.mock("./monacoSetup", () => ({ monaco: { Range: class { constructor(readonly startLineNumber: number, readonly startColumn: number, readonly endLineNumber: number, readonly endColumn: number) {} static fromPositions(a: { lineNumber: number; column: number }, b: { lineNumber: number; column: number }) { return new this(a.lineNumber, a.column, b.lineNumber, b.column); } }, languages: { CompletionItemKind: { Snippet: 1 }, CompletionItemInsertTextRule: { InsertAsSnippet: 4 } }, editor: { registerCommand: (id: string, command: (...args: unknown[]) => void) => { h.commands.set(id, command); return { dispose: () => h.commands.delete(id) }; } } } }));
vi.mock("./dbStore", () => ({ connOf: () => h.conn, rtOf: () => ({ status: h.connected ? "connected" : "idle", currentSchema: h.schema, tables: h.tables.map(name => ({ name })) }), sqlColumnEpoch: () => h.epoch, sqlTabOf: () => ({ connId: "c" }) }));
vi.mock("./sqlModels", () => ({ tabIdOfModel: () => "tab" }));
vi.mock("./sqlAssistColumns", () => ({ sqlAssistColumns: h.columns }));
vi.mock("./sqlBusiness", () => ({ readSqlBusinessMetadata: h.metadata }));
vi.mock("./monacoSql", () => ({ dialectOfSqlModel: () => h.dialect }));
vi.mock("./sqlFormat", () => ({ sqlLanguageOf: () => h.dialect }));
vi.mock("./sqlFormatPrefs", () => ({ getSqlFormatPrefs: () => ({ keywordCase: "upper" }) }));
vi.mock("../components/ui/toast", () => ({ toast: h.toast }));
import { wireSqlQueryCheckAssist } from "./sqlQueryCheckAssist";
import { dismissSqlAssistPicker, markSqlAssistPickerShown, sqlAssistPickerChoices } from "./sqlAssistPicker";
import { splitStatements } from "./sqlSplit";
const cleanups: (() => void)[] = [];
const col = (name: string, type = "VARCHAR2", pk = false) => ({ name, type, full: type, pk } as ColumnInfo);
beforeEach(() => {
  h.epoch = 0; h.schema = "NC"; h.connected = true; h.dialect = "plsql"; h.tables = ["LINES", "HEAD", "ALT_HEAD"]; h.conn.url = "jdbc:oracle:thin:@host";
  h.toast.mockReset(); h.columns.mockReset().mockImplementation(async (_: string, table: string) => table === "lines" ? [col("ORG"), col("CODE"), col("QTY", "NUMBER"), col("PARENT_ID")] : [col("ID", "VARCHAR2", true)]);
  h.metadata.mockReset().mockResolvedValue({ table: "lines", relations: [{ id: "外键:parent", kind: "外键", source: "LINES", target: "HEAD", from: ["PARENT_ID"], to: ["ID"] }], enums: [], sharedSession: false, partial: false });
});
afterEach(() => cleanups.splice(0).forEach(d => d()));
function fake(sql = "SELECT b.ORG, b.CODE FROM LINES b WHERE b.QTY>10;", selected = "b.ORG, b.CODE", eol = "\n") {
  let value = sql, version = 1, start = sql.indexOf(selected), end = start + selected.length, caret = end;
  const actions = new Map<string, { run: () => Promise<void> }>(), listeners = new Map<string, Set<() => void>>();
  const listen = (kind: string) => (fn: () => void) => { if (!listeners.has(kind)) listeners.set(kind, new Set()); listeners.get(kind)!.add(fn); return { dispose: () => listeners.get(kind)!.delete(fn) }; };
  const emit = (kind: string) => listeners.get(kind)?.forEach(f => f());
  const model = { getValue: () => value, getVersionId: () => version, isDisposed: () => false,
    getPositionAt: (offset: number) => { const lines = value.slice(0, offset).split("\n"); return { lineNumber: lines.length, column: lines[lines.length - 1].length + 1 }; },
    getOffsetAt: (p: { lineNumber: number; column: number }) => value.split("\n").slice(0, p.lineNumber - 1).reduce((n, line) => n + line.length + 1, 0) + p.column - 1 };
  const editor = { getModel: () => model, getPosition: () => model.getPositionAt(caret), getSelection: () => ({ getStartPosition: () => model.getPositionAt(start), getEndPosition: () => model.getPositionAt(end) }),
    onDidChangeModel: listen("model"), onDidChangeCursorSelection: listen("selection"), onDidChangeModelContent: listen("content"),
    addAction: (a: { id: string; run: () => Promise<void> }) => { actions.set(a.id, a); return { dispose: () => actions.delete(a.id) }; },
    executeEdits: vi.fn((_origin: string, edits: { range: monaco.IRange; text: string }[]) => { const e = edits[0], at = model.getOffsetAt({ lineNumber: e.range.startLineNumber, column: e.range.startColumn }); value = value.slice(0, at) + e.text.replace(/\r?\n/g, eol) + value.slice(at); version++; emit("content"); }),
    setPosition: (p: { lineNumber: number; column: number }) => { caret = model.getOffsetAt(p); start = end = caret; emit("selection"); },
    trigger: vi.fn(), focus: vi.fn(), pushUndoStop: vi.fn() };
  const handle = wireSqlQueryCheckAssist(editor as unknown as monaco.editor.IStandaloneCodeEditor); cleanups.push(() => handle.dispose());
  const items = () => sqlAssistPickerChoices(model as unknown as monaco.editor.ITextModel, editor.getPosition() as monaco.Position)?.suggestions;
  return { model: model as unknown as monaco.editor.ITextModel, spy: editor, handle, run: (summary = false) => actions.get(summary ? "ncforge.sql.detailSummary" : "ncforge.sql.checkDuplicates")!.run(),
    items, apply: (index = 0) => items()?.[index].ncforgeApply?.(editor as unknown as monaco.editor.IStandaloneCodeEditor),
    moveAwayBack() { emit("selection"); emit("selection"); }, change() { value += " "; version++; emit("content"); }, actions };
}
describe("检查与汇总选区动作", () => {
  it("追加全表重复检查，保留原WHERE，两个撤销边界", async () => {
    const original = "SELECT b.ORG, b.CODE FROM LINES b WHERE b.QTY>10;", f = fake(original); await f.run();
    expect(f.model.getValue()).toBe(original); expect(f.items()?.[0].ncforgePreview).toMatchObject({ note: "全表范围 · 不带入原 WHERE 条件" });
    f.apply();
    expect(f.model.getValue().startsWith(original + "\n\n-- ")).toBe(true);
    expect(f.model.getValue()).toContain("GROUP BY a.ORG, a.CODE\nHAVING COUNT(*) > 1;");
    expect(f.spy.pushUndoStop).toHaveBeenCalledTimes(2); expect(h.toast).toHaveBeenLastCalledWith(expect.stringContaining("全表"), "success");
  });
  it("选中数字明细字段，生成父表预聚合汇总，无明细为0", async () => {
    const f = fake("SELECT b.QTY FROM LINES b;", "b.QTY"); await f.run(true);
    f.apply();
    expect(f.model.getValue()).toContain("SUM(c.QTY)"); expect(f.model.getValue()).toContain("NVL(d.DETAIL_COUNT, 0)");
    expect(f.model.getValue()).toContain("FROM HEAD p"); expect(f.model.getValue()).toContain("GROUP BY c.PARENT_ID");
  });
  it.each([" -- keep", " -- keep;", "\n/", "\n/   ", "\n/   \n", "\n/\nSELECT 1 FROM dual;"])("原查询以注释或斜杠结束仍分成独立查询：%s", async suffix => {
    const original = "SELECT b.ORG, b.CODE FROM LINES b" + suffix, f = fake(original); await f.run();
    f.apply();
    const all = splitStatements(f.model.getValue());
    expect(all).toHaveLength(suffix.includes("SELECT 1") ? 3 : 2);
    expect(all[0].text).toContain("SELECT b.ORG, b.CODE FROM LINES b");
    expect(all[0].text).not.toContain("GROUP BY");
    expect(all[0].text).not.toMatch(/\n\/[; ]/);
    expect(all[1].text).toContain("HAVING COUNT(*) > 1");
  });
  it("八条入向明细关系不占用读取主表的预算", async () => {
    const metadata = await h.metadata();
    const children = Array.from({ length: 8 }, (_, i) => `CHILD_${i}`); h.tables.push(...children);
    metadata.relations.unshift(...children.map(source => ({ ...metadata.relations[0], source, target: "LINES", id: `外键:${source}` })));
    h.metadata.mockResolvedValue(metadata);
    const f = fake("SELECT b.QTY FROM LINES b;", "b.QTY"); await f.run(true);
    f.apply();
    expect(f.model.getValue()).toContain("FROM HEAD p");
    expect(h.columns.mock.calls.map(call => call[1])).toEqual(["lines", "head"]);
  });
  it.each(["\n", "\r\n"])("多主表选择在模型换行符%s下从新行插入，光标落在末尾", async eol => {
    const metadata = await h.metadata(); metadata.relations.push({ ...metadata.relations[0], id: "外键:other", target: "ALT_HEAD" });
    h.metadata.mockResolvedValue(metadata);
    const f = fake("SELECT b.QTY FROM LINES b;", "b.QTY", eol); await f.run(true);
    const items = f.items()!;
    expect(items).toHaveLength(2); expect(items.every(t => t.insertText === "")).toBe(true);
    expect(f.spy.executeEdits).not.toHaveBeenCalled();
    f.apply(1);
    expect(f.model.getValue()).toContain("FROM ALT_HEAD p");
    expect(f.model.getValue()).toContain(eol + "SELECT p.*,");
    expect(f.model.getOffsetAt(f.spy.getPosition() as monaco.Position)).toBe(f.model.getValue().length);
    expect(f.spy.trigger).toHaveBeenCalledWith("sql-assist", "editor.action.triggerSuggest", {});
    f.moveAwayBack(); expect(f.items()).toBeUndefined();
  });
  it.each(["schema", "epoch", "connection", "disconnect", "dialect"])("候选展示后%s单独变化不允许插入旧候选", async kind => {
    const metadata = await h.metadata(); metadata.relations.push({ ...metadata.relations[0], id: "外键:other", target: "ALT_HEAD" }); h.metadata.mockResolvedValue(metadata);
    const f = fake("SELECT b.QTY FROM LINES b;", "b.QTY"); await f.run(true);
    const items = f.items()!, old = items[1].ncforgeApply!;
    expect(items).toHaveLength(2); const original = f.model.getValue();
    if (kind === "schema") h.schema = "OTHER";
    if (kind === "epoch") h.epoch++;
    if (kind === "connection") h.conn.url = "jdbc:oracle:thin:@other";
    if (kind === "disconnect") h.connected = false;
    if (kind === "dialect") h.dialect = "tsql";
    old(f.spy as unknown as monaco.editor.IStandaloneCodeEditor);
    expect(f.model.getValue()).toBe(original); expect(f.spy.executeEdits).not.toHaveBeenCalled();
    expect(f.items()).toBeUndefined();
  });
  it("关闭加载中的汇总选择后，迟到的数据不会重新打开弹框", async () => {
    let finish!: (value: ColumnInfo[]) => void;
    h.columns.mockImplementation(() => new Promise(r => { finish = r; }));
    const f = fake(), pending = f.run();
    expect(f.items()?.[0].ncforgePreview).toMatchObject({ status: "loading" });
    markSqlAssistPickerShown(f.model);
    dismissSqlAssistPicker(f.model);
    finish([col("ORG"), col("CODE")]); await pending;
    expect(f.items()).toBeUndefined(); expect(f.spy.executeEdits).not.toHaveBeenCalled();
  });
  it.each(["schema", "epoch", "model", "selection", "connection", "dispose", "disconnect", "dialect"])("读取期间%s变化不追加旧查询", async kind => {
    let finish!: (value: ColumnInfo[]) => void;
    h.columns.mockImplementation(() => new Promise(r => { finish = r; }));
    const f = fake(), pending = f.run();
    if (kind === "schema") h.schema = "OTHER";
    if (kind === "epoch") h.epoch++;
    if (kind === "model") f.change();
    if (kind === "selection") f.moveAwayBack();
    if (kind === "connection") h.conn.url = "jdbc:oracle:thin:@other";
    if (kind === "dispose") f.handle.dispose();
    if (kind === "disconnect") h.connected = false;
    if (kind === "dialect") h.dialect = "tsql";
    finish([col("ORG"), col("CODE")]); await pending;
    expect(f.spy.executeEdits).not.toHaveBeenCalled(); expect(h.toast).not.toHaveBeenCalled();
  });
  it("局部字段、未知类型、非Oracle和无完整主键都保留原SQL", async () => {
    const part = fake("SELECT b.CODE FROM LINES b;", "CODE"); await part.run(); expect(h.columns).not.toHaveBeenCalled();
    h.columns.mockResolvedValue([col("ORG", "CLOB"), col("CODE")]); const unknown = fake(); await unknown.run(); expect(unknown.spy.executeEdits).not.toHaveBeenCalled();
    h.dialect = "postgresql"; const pg = fake(); await pg.run(); expect(pg.spy.executeEdits).not.toHaveBeenCalled();
  });
});
