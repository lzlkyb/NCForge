// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { monaco } from "./monacoSetup";
import type { ColumnInfo, DbConn } from "./dbApi";
import type { ConnRuntime } from "./dbStore";

const h = vi.hoisted(() => ({
  conn: null as DbConn | null, rt: {} as ConnRuntime, epoch: 0, tabConn: "conn", dialect: "plsql",
  columns: vi.fn(), toast: vi.fn(),
}));
vi.mock("./dbStore", () => ({ connOf: () => h.conn, rtOf: () => h.rt, sqlColumnEpoch: () => h.epoch,
  sqlTabOf: () => ({ connId: h.tabConn }), columnsOf: h.columns }));
vi.mock("./sqlModels", () => ({ tabIdOfModel: () => "tab" }));
vi.mock("./sqlFormat", () => ({ sqlLanguageOf: () => h.dialect }));
vi.mock("./monacoSql", () => ({ dialectOfSqlModel: () => h.dialect }));
vi.mock("./monacoSetup", () => ({ monaco: { languages: { CompletionItemKind: { Snippet: 1 } }, Range: { fromPositions: (start: unknown, end: unknown) => [start, end] } } }));
vi.mock("./sqlFormatPrefs", () => ({ getSqlFormatPrefs: () => ({ keywordCase: "upper" }) }));
vi.mock("../components/ui/toast", () => ({ toast: h.toast }));
const cleanups: (() => void)[] = [];

beforeEach(() => {
  vi.resetModules(); localStorage.clear(); h.columns.mockReset(); h.toast.mockReset();
  h.conn = { id: "conn", url: "jdbc:oracle:thin:@host", user: "NC", engine: "java", source: "manual", propDs: "" } as DbConn;
  h.rt = { status: "connected", currentSchema: "NC", tables: [{ name: "BD_MATERIAL", kind: "TABLE" }, { name: "BD_ORG", kind: "TABLE" }] };
  h.epoch = 0; h.tabConn = "conn"; h.dialect = "plsql";
  h.columns.mockResolvedValue([{ name: "CODE", type: "VARCHAR2" }]);
});
afterEach(() => { cleanups.splice(0).forEach(dispose => dispose()); vi.restoreAllMocks(); });

function fakeEditor(before = "SELECT * FROM bd_material a WHERE a.code IN (", selected = "001\nO'Reilly\n001", after = ") AND a.dr=0") {
  let sql = before + selected + after, version = 1, disposed = false, start = before.length, end = start + selected.length, offset = end;
  const actions = new Map<string, { run: () => Promise<void> }>();
  let onSelection: (() => void) | undefined;
  const model = {
    getValue: () => sql, getVersionId: () => version, isDisposed: () => disposed,
    getPositionAt: (at: number) => { const lines = sql.slice(0, at).split("\n"); return { lineNumber: lines.length, column: lines[lines.length - 1].length + 1 }; },
    getOffsetAt: (p: { lineNumber: number; column: number }) => sql.split("\n").slice(0, p.lineNumber - 1).reduce((n, line) => n + line.length + 1, 0) + p.column - 1,
  };
  const getModel = vi.fn(() => model), executeEdits = vi.fn();
  const editor = {
    getModel, getPosition: () => model.getPositionAt(offset),
    getSelection: () => { const a = model.getPositionAt(start), b = model.getPositionAt(end); return { startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: b.lineNumber, endColumn: b.column }; },
    onDidChangeCursorSelection: (listener: () => void) => { onSelection = listener; return { dispose() { onSelection = undefined; } }; },
    addAction: (action: { id: string; run: () => Promise<void> }) => { actions.set(action.id, action); return { dispose: () => actions.delete(action.id) }; },
    executeEdits, pushUndoStop: vi.fn(), focus: vi.fn(), trigger: vi.fn(),
  };
  return { editor: editor as unknown as monaco.editor.IStandaloneCodeEditor, spy: editor, model, actions, executeEdits,
    change: () => { sql += " "; version++; }, disposeModel: () => { disposed = true; },
    moveCursor: () => { offset = 0; },
    moveSelection: () => { const original = { start, end }; start = 0; end = 1; onSelection?.(); start = original.start; end = original.end; onSelection?.(); },
    clearSelection: () => { start = end; onSelection?.(); },
  };
}
async function wire(fake: ReturnType<typeof fakeEditor>) {
  const { wireSqlBatchAssist } = await import("./sqlBatchAssist");
  const { sqlAssistPickerChoices } = await import("./sqlAssistPicker");
  const handle = wireSqlBatchAssist(fake.editor); cleanups.push(() => handle.dispose());
  const choice = () => sqlAssistPickerChoices(fake.editor.getModel()!, fake.editor.getPosition()!)?.suggestions[0];
  return { handle, run: () => fake.actions.get("ncforge.sql.batchIn")!.run(), choice, apply: () => choice()?.ncforgeApply?.(fake.editor) };
}

describe("批量条件的右键动作", () => {
  it("通过 addAction 接入选区并读取当前表字段，仅执行可撤销编辑", async () => {
    const fake = fakeEditor(), { run, choice, apply } = await wire(fake); await run();
    expect(h.columns).toHaveBeenCalledWith("conn", "bd_material");
    expect(fake.executeEdits).not.toHaveBeenCalled();
    expect(choice()?.ncforgePreview).toMatchObject({ text: "a.code IN ('001', 'O''Reilly')", note: "2 个不同的值" });
    apply();
    expect(fake.executeEdits).toHaveBeenCalledTimes(1);
    const [origin, edits] = fake.executeEdits.mock.calls[0];
    expect(origin).toBe("sql-batch-in"); expect(edits[0].text).toBe("a.code IN ('001', 'O''Reilly')");
    const range = edits[0].range;
    expect(fake.model.getValue().slice(fake.model.getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn }),
      fake.model.getOffsetAt({ lineNumber: range.endLineNumber, column: range.endColumn }))).toBe("a.code IN (001\nO'Reilly\n001)");
    expect(fake.spy.pushUndoStop).toHaveBeenCalledTimes(2); expect(fake.spy.focus).toHaveBeenCalledOnce();
  });

  it("无别名单来源字段也能生成完整表达式", async () => {
    const fake = fakeEditor("SELECT * FROM bd_material WHERE code ", "001\n002", " ORDER BY code"), { run, apply } = await wire(fake);
    await run(); apply(); expect(fake.executeEdits.mock.calls[0][1][0].text).toBe("code IN ('001', '002')");
  });

  it("空选区、断开连接、未知表和不明确字段均不读取元数据", async () => {
    const empty = fakeEditor(), first = await wire(empty); empty.clearSelection(); await first.run();
    const disconnected = fakeEditor(), second = await wire(disconnected); h.rt.status = "idle"; await second.run(); h.rt.status = "connected";
    const unknown = fakeEditor("SELECT * FROM unknown_table WHERE code ", "001", ""), third = await wire(unknown); await third.run();
    const ambiguous = fakeEditor("SELECT * FROM bd_material a JOIN bd_org b ON a.pk_org=b.pk_org WHERE code ", "001", ""), fourth = await wire(ambiguous); await fourth.run();
    expect(h.columns).not.toHaveBeenCalled();
    for (const fake of [empty, disconnected, unknown, ambiguous]) expect(fake.executeEdits).not.toHaveBeenCalled();
  });

  it.each([
    [{ name: "CODE" }, "字段类型"],
    [{ name: "CODE", type: "DATE" }, "字段类型"],
    [{ name: "OTHER", type: "VARCHAR2" }, "无法确认字段"],
    [{ name: "CODE", type: "NUMBER" }, "无效数字"],
  ])("元数据不足或值不符合类型时保留原 SQL：%j", async (column, hint) => {
    h.columns.mockResolvedValue([column]); const fake = fakeEditor(), { run, choice } = await wire(fake); await run();
    expect(fake.executeEdits).not.toHaveBeenCalled(); expect(choice()?.ncforgePreview).toMatchObject({ status: "error", text: expect.stringContaining(hint) });
  });

  it("带引号字段严格匹配元数据大小写", async () => {
    const fake = fakeEditor('SELECT * FROM bd_material WHERE "code" ', "001", ""), { run, apply } = await wire(fake);
    await run(); expect(fake.executeEdits).not.toHaveBeenCalled();
    h.columns.mockResolvedValue([{ name: "code", type: "VARCHAR2" }]); await run(); apply();
    expect(fake.executeEdits.mock.calls[0][1][0].text).toBe('"code" IN (\'001\')');
  });

  it.each(["schema", "连接身份", "结构刷新", "tab连接", "断开", "方言", "模型内容", "模型销毁", "模型切换", "光标移动", "选区移开再移回", "动作销毁"])("读取期间%s使迟到转换失效", async change => {
    let resolve!: (columns: ColumnInfo[]) => void;
    h.columns.mockImplementation(() => new Promise(r => { resolve = r; }));
    const fake = fakeEditor(), { handle, run } = await wire(fake), pending = run();
    expect(h.columns).toHaveBeenCalledTimes(1);
    switch (change) {
      case "schema": h.rt.currentSchema = "OTHER"; break;
      case "连接身份": h.conn!.url = "jdbc:oracle:thin:@other"; break;
      case "结构刷新": h.epoch++; break;
      case "tab连接": h.tabConn = "other"; break;
      case "断开": h.rt.status = "idle"; break;
      case "方言": h.dialect = "postgresql"; break;
      case "模型内容": fake.change(); break;
      case "模型销毁": fake.disposeModel(); break;
      case "模型切换": fake.spy.getModel.mockReturnValue({ ...fake.model }); break;
      case "光标移动": fake.moveCursor(); break;
      case "选区移开再移回": fake.moveSelection(); break;
      case "动作销毁": handle.dispose(); break;
    }
    resolve([{ name: "CODE", type: "VARCHAR2" }] as ColumnInfo[]); await pending;
    expect(fake.executeEdits).not.toHaveBeenCalled(); expect(h.toast).not.toHaveBeenCalled();
  });

  it("读取失败给简短提示，销毁时注销右键动作", async () => {
    h.columns.mockRejectedValue(new Error("backend trace")); const fake = fakeEditor(), { handle, run, choice } = await wire(fake);
    await run(); expect(choice()?.ncforgePreview).toMatchObject({ status: "error", text: "暂时无法读取字段，请刷新表结构后重试" });
    expect(fake.executeEdits).not.toHaveBeenCalled(); handle.dispose(); expect(fake.actions.size).toBe(0);
  });
});
