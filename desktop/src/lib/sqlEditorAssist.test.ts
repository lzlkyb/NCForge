// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { monaco } from "./monacoSetup";
import type { DbConn } from "./dbApi";
import type { ConnRuntime } from "./dbStore";

const h = vi.hoisted(() => ({
  conn: null as DbConn | null, rt: { status: "connected" } as ConnRuntime, epoch: 0,
  commands: new Map<string, (...args: unknown[]) => void>(), columns: vi.fn(), toast: vi.fn(),
  relations: vi.fn(),
}));
vi.mock("./monacoSetup", () => ({ monaco: { editor: {
  EditorOption: { quickSuggestions: 90 },
  ShowLightbulbIconMode: { Off: "off", OnCode: "onCode", On: "on" },
  registerCommand: (id: string, fn: (...args: unknown[]) => void) => { h.commands.set(id, fn); return { dispose: () => h.commands.delete(id) }; },
} } }));
vi.mock("./dbStore", () => ({ connOf: () => h.conn, rtOf: () => h.rt, sqlColumnEpoch: () => h.epoch, sqlTabOf: (id: string) => ({ id, connId: "conn" }), columnsOf: h.columns }));
vi.mock("./sqlModels", () => ({ tabIdOfModel: (m: { id: string }) => m.id }));
vi.mock("./sqlFormat", () => ({ sqlLanguageOf: () => "plsql" }));
vi.mock("./monacoSql", async () => { const { analyzeSql } = await import("./sqlScope"); return { dialectOfSqlModel: () => "plsql", sqlAnalysisOf: (model: { getValue: () => string }) => analyzeSql(model.getValue(), "plsql") }; });
vi.mock("./sqlFormatPrefs", () => ({ getSqlFormatPrefs: () => ({ keywordCase: "upper" }) }));
vi.mock("../components/ui/toast", () => ({ toast: h.toast }));
vi.mock("./sqlJoinMeaningAssist", () => ({ wireSqlJoinMeaningAssist: () => ({ dispose() {} }) }));
vi.mock("./sqlBillAssist", () => ({ wireSqlBillAssist: () => ({ dispose() {} }) }));
vi.mock("./sqlSelectionAssist", () => ({ wireSqlSelectionAssist: () => ({ dispose() {} }) }));
vi.mock("./sqlAssistGhost", () => ({ wireSqlAssistGhost: () => ({ dispose() {} }) }));
vi.mock("./sqlBusiness", async importOriginal => ({
  ...await importOriginal<typeof import("./sqlBusiness")>(),
  peekSqlBusinessMetadata: () => null, readSqlBusinessMetadata: h.relations,
}));
const cleanups: (() => void)[] = [];

beforeEach(() => {
  vi.resetModules(); localStorage.clear(); h.commands.clear(); h.columns.mockReset(); h.toast.mockReset();
  h.epoch = 0;
  h.relations.mockReset().mockResolvedValue(null);
  h.conn = { id: "conn", name: "测试", source: "manual", url: "jdbc:oracle:thin:@host", user: "NC", engine: "java", propDs: "", autoCommit: true } as DbConn;
  h.rt = { status: "connected", currentSchema: "NC", tables: [{ name: "BD_MATERIAL", kind: "TABLE" }, { name: "BD_ORG", kind: "TABLE" }, { name: "Item", kind: "TABLE" }] };
  h.columns.mockResolvedValue([{ name: "CODE" }, { name: "NAME" }]);
});
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); vi.restoreAllMocks(); });

function fakeEditor(sql: string) {
  type Change = { rangeOffset: number; rangeLength: number; text: string };
  const handlers = new Map<string, (event?: unknown) => void>();
  const actions = new Map<string, { run: () => unknown }>();
  let offset = sql.length, value = sql, version = 1, focus = true;
  let selection: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number; isEmpty?: () => boolean } | null = null;
  const model = {
    id: "tab", getValue: () => value, getVersionId: () => version, isDisposed: () => false,
    getPositionAt: (at: number) => { const lines = value.slice(0, at).split("\n"); return { lineNumber: lines.length, column: lines[lines.length - 1].length + 1 }; },
    getOffsetAt: (p: { lineNumber: number; column: number }) => value.split("\n").slice(0, p.lineNumber - 1).reduce((n, line) => n + line.length + 1, 0) + p.column - 1,
    getValueInRange: (r: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }) =>
      value.slice(model.getOffsetAt({ lineNumber: r.startLineNumber, column: r.startColumn }), model.getOffsetAt({ lineNumber: r.endLineNumber, column: r.endColumn })),
  };
  const listen = (id: string) => (fn: (event?: unknown) => void) => { handlers.set(id, fn); return { dispose: () => handlers.delete(id) }; };
  const snippet = { insert: vi.fn() }, executeEdits = vi.fn();
  const editor = {
    getModel: () => model, getPosition: () => model.getPositionAt(offset), hasTextFocus: () => focus,
    getSelection: () => selection,
    onDidChangeModel: listen("model"), onDidChangeModelContent: listen("content"), onDidChangeCursorPosition: listen("cursor"),
    onDidChangeCursorSelection: listen("selection"),
    onKeyDown: listen("keyDown"),
    onDidCompositionStart: listen("composeStart"), onDidCompositionEnd: listen("composeEnd"),
    getOption: () => ({ other: "on", comments: "off", strings: "off" }), updateOptions: vi.fn(), trigger: vi.fn(),
    addAction: (a: { id: string; run: () => unknown }) => { actions.set(a.id, a); return { dispose: () => actions.delete(a.id) }; },
    addCommand: () => { throw new Error("must use addAction"); },
    setPosition: (p: { lineNumber: number; column: number }) => { offset = model.getOffsetAt(p); }, setSelection: vi.fn(),
    getContribution: () => snippet, pushUndoStop: vi.fn(), executeEdits, focus: vi.fn(),
  };
  return {
    editor: editor as unknown as monaco.editor.IStandaloneCodeEditor, spy: editor, model, actions, handlers, snippet, executeEdits,
    focus: (f: boolean) => { focus = f; },
    select: (r: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number } | null) => {
      selection = r ? { ...r, isEmpty: () => r.startLineNumber === r.endLineNumber && r.startColumn === r.endColumn } : null;
      handlers.get("selection")?.();
    },
    move: (at: number) => { offset = at; handlers.get("cursor")?.(); },
    change: (start: number, length: number, text: string, undo = false) => {
      const change: Change = { rangeOffset: start, rangeLength: length, text };
      value = value.slice(0, start) + text + value.slice(start + length); version++; offset = start + text.length;
      handlers.get("content")?.({ changes: [change], isUndoing: undo, isRedoing: false }); handlers.get("cursor")?.();
    },
  };
}
async function wire(fake: ReturnType<typeof fakeEditor>) {
  const { wireSqlEditorAssist } = await import("./sqlEditorAssist");
  const handle = wireSqlEditorAssist(fake.editor); cleanups.push(() => handle.dispose()); return handle;
}
async function accept(table = "bd_material") {
  const l = await import("./sqlAssistLearning"), u = await import("./sqlUsage");
  const scope = l.sqlAssistScope("conn")!, key = u.sqlUsageKey(table);
  h.commands.get("ncforge.sql.accept")!(null, { scope, key }); return { u, scope, key };
}

describe("SQL 编辑器习惯与辅助操作", () => {
  // 从候选列表点选表名后补全框会关闭，用户就看不到「N 个关联表」和 JOIN 片段了。
  // 选完立刻重唤一次，等价于「打完表名再看一眼」。
  it("选完表名立刻重弹补全，不用再按一次 Ctrl+空格", async () => {
    const fake = fakeEditor("SELECT * FROM bd_material"); await wire(fake);
    vi.useFakeTimers();
    try {
      await accept("bd_material");
      expect(fake.spy.trigger).not.toHaveBeenCalled();
      vi.runAllTimers();
      expect(fake.spy.trigger).toHaveBeenCalledWith("sql-assist", "editor.action.triggerSuggest", {});
    } finally { vi.useRealTimers(); }
  });
  it("选完字段不重弹补全", async () => {
    const fake = fakeEditor("SELECT * FROM bd_material"); await wire(fake);
    vi.useFakeTimers();
    try {
      const u = await import("./sqlUsage"), l = await import("./sqlAssistLearning");
      h.commands.get("ncforge.sql.accept")!(null, { scope: l.sqlAssistScope("conn")!, key: u.sqlUsageKey("bd_material", "code") });
      vi.runAllTimers();
      expect(fake.spy.trigger).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it("关闭使用习惯记忆后，接受条件字段仍然提示运算符", async () => {
    const fake = fakeEditor("SELECT * FROM bd_material WHERE code "); await wire(fake);
    const usage = await import("./sqlUsage"), learning = await import("./sqlAssistLearning");
    usage.setSqlUsageEnabled(false);
    vi.useFakeTimers();
    try {
      const scope = learning.sqlAssistScope("conn")!;
      h.commands.get("ncforge.sql.accept")!(null, { scope, key: usage.sqlUsageKey("bd_material", "code"), followOperator: true });
      vi.runAllTimers();
      expect(fake.spy.trigger).toHaveBeenCalledWith("sql-assist", "editor.action.triggerSuggest", {});
      expect(usage.usageSnapshot(scope)).toEqual({});
    } finally { vi.useRealTimers(); }
  });
  it("光标已经离开表名末尾时不重弹", async () => {
    const fake = fakeEditor("SELECT * FROM bd_material WHERE code = 'x'"); await wire(fake);
    vi.useFakeTimers();
    try {
      await accept("bd_material");
      vi.runAllTimers();
      expect(fake.spy.trigger).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  // 灯泡是 CodeAction 唯一的可见入口，而 Monaco 的灯泡是 glyphMargin 装饰、ESM 版默认关掉了那条槽。
  it("建编辑器时打开 glyphMargin 与灯泡，否则四个 CodeAction 能力没有入口", async () => {
    const fake = fakeEditor("SELECT 1 FROM dual"); await wire(fake);
    expect(fake.spy.updateOptions).toHaveBeenCalledWith(expect.objectContaining({
      glyphMargin: true, lightbulb: { enabled: "on" },
    }));
  });
  // 空格曾经是补全触发字符：WHERE 里每敲一个空格都开面板，用户被训成「看见就 Esc」。
  it("只在表名或条件还需要输入时由空格唤起补全", async () => {
    const from = fakeEditor("SELECT * FROM "); await wire(from);
    vi.useFakeTimers();
    try {
      from.spy.trigger.mockClear();
      from.change(from.model.getValue().length, 0, " ");
      vi.runAllTimers();
      expect(from.spy.trigger).toHaveBeenCalledWith("sql-assist", "editor.action.triggerSuggest", {});
    } finally { vi.useRealTimers(); }

    const where = fakeEditor("SELECT * FROM bd_material WHERE"); await wire(where);
    vi.useFakeTimers();
    try {
      where.spy.trigger.mockClear();
      where.change(where.model.getValue().length, 0, " ");
      vi.runAllTimers();
      expect(where.spy.trigger).toHaveBeenCalledWith("sql-assist", "editor.action.triggerSuggest", {});
      where.change(where.model.getValue().length, 0, "code = 'x'");
      where.spy.trigger.mockClear();
      where.change(where.model.getValue().length, 0, " ");
      vi.runAllTimers();
      expect(where.spy.trigger).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("Esc 取消待打开的补全，下次输入仍可以打开", async () => {
    const fake = fakeEditor("SELECT * FROM bd_material WHERE"); await wire(fake);
    vi.useFakeTimers();
    try {
      fake.change(fake.model.getValue().length, 0, " ");
      fake.handlers.get("keyDown")?.({ browserEvent: { key: "Escape" } });
      vi.runAllTimers();
      expect(fake.spy.trigger).not.toHaveBeenCalledWith("sql-assist", "editor.action.triggerSuggest", {});
      fake.change(fake.model.getValue().length, 0, "code");
      fake.change(fake.model.getValue().length, 0, " ");
      vi.runAllTimers();
      expect(fake.spy.trigger).toHaveBeenCalledWith("sql-assist", "editor.action.triggerSuggest", {});
    } finally { vi.useRealTimers(); }
  });

  it.each([false, true])("晚到的关联只在当前输入未被关闭时更新（Esc=%s）", async dismiss => {
    const fake = fakeEditor("SELECT * FROM bd_materia"); await wire(fake);
    vi.useFakeTimers();
    try {
      h.relations.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve({ relations: [{}] }), 600)));
      fake.change(fake.model.getValue().length, 0, "l");
      await vi.advanceTimersByTimeAsync(300);
      expect(h.relations).toHaveBeenCalledTimes(1);
      if (dismiss) fake.handlers.get("keyDown")?.({ browserEvent: { key: "Escape" } });
      await vi.runAllTimersAsync();
      expect(fake.spy.trigger.mock.calls.filter(([, command]) => command === "editor.action.triggerSuggest")).toHaveLength(dismiss ? 0 : 1);
    } finally { vi.useRealTimers(); }
  });

  it("初始加载、只移动光标和换模型不学习", async () => {
    const fake = fakeEditor("SELECT * FROM bd_material "); await wire(fake);
    fake.move(0); fake.move(fake.model.getValue().length); fake.handlers.get("model")?.(); fake.move(8);
    fake.handlers.get("content")?.({ isFlush: true, changes: [{ rangeOffset: 0, rangeLength: 0, text: fake.model.getValue() }] }); fake.move(0);
    const l = await import("./sqlAssistLearning"), u = await import("./sqlUsage");
    expect(Object.keys(u.usageSnapshot(l.sqlAssistScope("conn")!))).toHaveLength(0);
  });

  it("完整手输表名离开标识符后学习，未完成名称不学习", async () => {
    const fake = fakeEditor("SELECT * FROM bd_mat"); await wire(fake);
    fake.change(fake.model.getValue().length, 0, "erial");
    const l = await import("./sqlAssistLearning"), u = await import("./sqlUsage"), scope = l.sqlAssistScope("conn")!;
    expect(Object.keys(u.usageSnapshot(scope))).toHaveLength(0);
    fake.change(fake.model.getValue().length, 0, " ");
    expect(u.usageSnapshot(scope)[u.sqlUsageKey("bd_material")].type).toBe(1);
  });

  it("补全接受只奖励一次，立即撤销或删除接受字符会撤回奖励", async () => {
    const fake = fakeEditor("SELECT * FROM bd_material"); await wire(fake);
    const { u, scope, key } = await accept(); expect(u.usageSnapshot(scope)[key].accept).toBe(1);
    fake.change(14, 11, "", true); expect(u.usageSnapshot(scope)[key]).toBeUndefined();
    fake.change(14, 0, "bd_material"); await accept();
    fake.change(fake.model.getValue().length - 1, 1, ""); expect(u.usageSnapshot(scope)[key]).toBeUndefined();
  });

  it("补全接受后的空格不重复计作手输，过期连接作用域的接受无效", async () => {
    const fake = fakeEditor("SELECT * FROM bd_material"); await wire(fake);
    const { u, scope, key } = await accept(); fake.change(fake.model.getValue().length, 0, " ");
    expect(u.usageSnapshot(scope)[key].type).toBe(0);
    h.rt.currentSchema = "OTHER"; h.commands.get("ncforge.sql.accept")!(null, { scope, key });
    expect(u.usageSnapshot(scope)[key].accept).toBe(1);
  });

  it("连续接受两个表再连续撤销，两次接受的排序奖励都撤回", async () => {
    const fake = fakeEditor("SELECT * FROM bd_material"); await wire(fake);
    const first = await accept(); fake.change(fake.model.getValue().length, 0, " JOIN bd_org");
    const second = await accept("bd_org");
    fake.change(fake.model.getValue().lastIndexOf("bd_org"), 6, "", true);
    fake.change(14, 11, "", true);
    expect(first.u.usageSnapshot(first.scope)[first.key]).toBeUndefined();
    expect(second.u.usageSnapshot(second.scope)[second.key]).toBeUndefined();
  });

  it("接受后追加无关内容再删除表名仍撤回，撤销无关字符不撤回接受", async () => {
    const fake = fakeEditor("SELECT * FROM bd_material"); await wire(fake);
    const { u, scope, key } = await accept();
    fake.change(fake.model.getValue().length, 0, " "); fake.change(fake.model.getValue().length - 1, 1, "", true);
    expect(u.usageSnapshot(scope)[key].accept).toBe(1);
    fake.change(fake.model.getValue().length, 0, " WHERE 1=1"); fake.change(14, 11, "");
    expect(u.usageSnapshot(scope)[key]).toBeUndefined();
  });

  it("中文输入法收起建议并暂时关闭自动提示，结束和销毁恢复原配置", async () => {
    const fake = fakeEditor("SELECT * FROM "), handle = await wire(fake);
    fake.handlers.get("composeStart")?.();
    expect(fake.spy.trigger).toHaveBeenCalledWith("sql-assist", "hideSuggestWidget", {});
    expect(fake.spy.updateOptions).toHaveBeenLastCalledWith({ quickSuggestions: false });
    fake.handlers.get("composeEnd")?.();
    expect(fake.spy.updateOptions).toHaveBeenLastCalledWith({ quickSuggestions: { other: "on", comments: "off", strings: "off" } });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(fake.spy.trigger).toHaveBeenLastCalledWith("sql-assist", "editor.action.triggerSuggest", {});
    fake.handlers.get("composeStart")?.(); handle.dispose();
    expect(fake.spy.updateOptions).toHaveBeenLastCalledWith({ quickSuggestions: { other: "on", comments: "off", strings: "off" } });
    expect(fake.handlers.size).toBe(0); expect(fake.actions.size).toBe(0); expect(h.commands.size).toBe(0);
  });

  it("通过 addAction 注册真实右键操作，限定 * 展开保留别名", async () => {
    const fake = fakeEditor("SELECT m.* FROM nc.bd_material m"); await wire(fake); fake.move(9);
    expect(fake.actions.has("ncforge.sql.batchIn")).toBe(true);
    await fake.actions.get("ncforge.sql.expandStar")!.run();
    expect(h.columns).toHaveBeenCalledWith("conn", "nc.bd_material");
    expect(fake.executeEdits).toHaveBeenCalledWith("sql-assist", [{ range: { startLineNumber: 1, startColumn: 10, endLineNumber: 1, endColumn: 11 }, text: 'code, m.name' }]);
  });

  it("字段异步读取过程中编辑内容或移动光标，放弃迟到编辑", async () => {
    let resolve!: (cols: { name: string }[]) => void;
    h.columns.mockImplementation(() => new Promise(r => { resolve = r; }));
    const fake = fakeEditor("SELECT * FROM bd_material"); await wire(fake); fake.move(7);
    const pending = fake.actions.get("ncforge.sql.expandStar")!.run(); fake.change(0, 0, " ");
    resolve([{ name: "CODE" }]); await pending; expect(fake.executeEdits).not.toHaveBeenCalled();
    fake.move(8); const next = fake.actions.get("ncforge.sql.expandStar")!.run(); fake.move(0);
    resolve([{ name: "CODE" }]); await next; expect(fake.executeEdits).not.toHaveBeenCalled();
  });

  it.each(["ncforge.sql.expandStar", "ncforge.sql.insertTemplate"])("%s 在同库同 schema 刷新结构后不使用迟到字段", async action => {
    let resolve!: (cols: { name: string }[]) => void;
    h.columns.mockImplementation(() => new Promise(r => { resolve = r; }));
    const fake = fakeEditor("SELECT * FROM bd_material"); await wire(fake); fake.move(7);
    const pending = fake.actions.get(action)!.run();
    h.epoch++;
    resolve([{ name: "OLD_COLUMN" }]); await pending;
    expect(fake.executeEdits).not.toHaveBeenCalled(); expect(fake.snippet.insert).not.toHaveBeenCalled();
  });

  it("函数 * 和带引号表的缓存不安全场景不触发字段读取", async () => {
    const fake = fakeEditor("SELECT count(*) FROM bd_material"); await wire(fake); fake.move(13);
    await fake.actions.get("ncforge.sql.expandStar")!.run(); expect(h.columns).not.toHaveBeenCalled();
    const quoted = fakeEditor('SELECT * FROM "Item"'); await wire(quoted); quoted.move(7);
    await quoted.actions.get("ncforge.sql.expandStar")!.run(); expect(h.columns).not.toHaveBeenCalled();
  });

  it("SELECT 乘法及通配符后追加表达式不能误展开，完整独立投影项可以展开", async () => {
    for (const sql of ["SELECT price * quantity FROM bd_material", "SELECT * + price FROM bd_material", "SELECT m.* * quantity FROM bd_material m"]) {
      const fake = fakeEditor(sql); await wire(fake); fake.move(sql.indexOf("*"));
      await fake.actions.get("ncforge.sql.expandStar")!.run();
    }
    expect(h.columns).not.toHaveBeenCalled();
    const sql = "SELECT DISTINCT *, price FROM bd_material", fake = fakeEditor(sql); await wire(fake); fake.move(sql.indexOf("*"));
    await fake.actions.get("ncforge.sql.expandStar")!.run(); expect(h.columns).toHaveBeenCalledTimes(1); expect(fake.executeEdits.mock.calls[0][1][0].text).toBe("code, name");
  });

  it("展开带引号别名的通配符保持原始引号与大小写", async () => {
    const sql = 'SELECT "M".* FROM bd_material "M"', fake = fakeEditor(sql); await wire(fake); fake.move(sql.indexOf("*"));
    await fake.actions.get("ncforge.sql.expandStar")!.run(); expect(fake.executeEdits.mock.calls[0][1][0].text).toBe('code, "M".name');
  });

  it("INSERT 模板使用完整表身份和可跳转占位符，插入到完整外层语句之后", async () => {
    const sql = "SELECT * FROM (SELECT * FROM nc.bd_material) t; SELECT 1 FROM dual;";
    const fake = fakeEditor(sql); await wire(fake); fake.move(sql.indexOf("bd_material") + 5);
    await fake.actions.get("ncforge.sql.insertTemplate")!.run();
    expect(fake.snippet.insert).toHaveBeenCalledWith('\n\nINSERT INTO nc.bd_material (code, name)\nVALUES (${1:CODE}, ${2:NAME});$0');
    expect(fake.spy.setSelection).toHaveBeenCalledWith({ startLineNumber: 1, startColumn: sql.indexOf(";") + 2, endLineNumber: 1, endColumn: sql.indexOf(";") + 2 });
  });

  it("固定和忘记采用与执行学习一致的当前 schema 对象身份", async () => {
    const fake = fakeEditor("SELECT * FROM nc.bd_material"); await wire(fake);
    const l = await import("./sqlAssistLearning"), u = await import("./sqlUsage"), scope = l.sqlAssistScope("conn")!, key = u.sqlUsageKey("bd_material");
    await fake.actions.get("ncforge.sql.pinTable")!.run(); expect(u.usageSnapshot(scope)[key].pinned).toBe(true);
    await fake.actions.get("ncforge.sql.pinTable")!.run(); expect(u.usageSnapshot(scope)[key].pinned).toBe(false);
    await fake.actions.get("ncforge.sql.forgetTable")!.run(); expect(u.usageSnapshot(scope)[key]).toBeUndefined();
  });

  it("多个编辑器共用接受命令，各自的主表选择命令随编辑器注销", async () => {
    const first = fakeEditor("SELECT * FROM bd_material"), second = fakeEditor("SELECT * FROM bd_material");
    const a = await wire(first), b = await wire(second); first.focus(false);
    expect(h.commands.has("ncforge.sql.accept")).toBe(true);
    expect(h.commands.has("ncforge.sql.quickFix")).toBe(true);
    // 补全列表里的单值动作（展开 * / INSERT 模板）走这条，落到同一个 editor action。
    expect(h.commands.has("ncforge.sql.runAction")).toBe(true);
    expect([...h.commands.keys()].filter(id => id.startsWith("ncforge.sql.chooseSummary."))).toHaveLength(2);
    const { u, scope, key } = await accept();
    // 共用命令（accept / quickFix / runAction）留到最后一个编辑器注销；每个编辑器自己的选择命令先走。
    expect(u.usageSnapshot(scope)[key].accept).toBe(1); a.dispose(); expect(h.commands.size).toBe(4);
    b.dispose(); expect(h.commands.size).toBe(0);
  });

  it("保存为 SQL 片段：无选区存光标所在语句，有选区存选区，空内容只提示不存", async () => {
    const sql = "SELECT code, name FROM bd_material WHERE dr = 0;\nSELECT 1 FROM dual;";
    const fake = fakeEditor(sql);
    await wire(fake);
    const { listSnippets } = await import("./dbSnippets");
    // 光标默认在文尾（第二条语句里）→ 存第二条（splitStatements 的文本不含分号）
    await fake.actions.get("ncforge.sql.saveSnippet")!.run();
    expect(listSnippets("conn").map(s => s.sql)).toEqual(["SELECT 1 FROM dual"]);
    expect(h.toast).toHaveBeenLastCalledWith(expect.stringContaining("已保存到 SQL 片段"), "success");
    // 选中第一段 → 存选区原样（两端空白修掉；选中的分号保留，与语句路径不同）
    fake.select({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 49 });
    await fake.actions.get("ncforge.sql.saveSnippet")!.run();
    expect(listSnippets("conn").map(s => s.sql)).toEqual(["SELECT code, name FROM bd_material WHERE dr = 0;", "SELECT 1 FROM dual"]);
    // 光标挪到两条语句之间的空白处（第 1 行行尾的分号后）也不炸，落到相邻语句
    fake.move(sql.indexOf(";") + 1);
    await fake.actions.get("ncforge.sql.saveSnippet")!.run();
    expect(listSnippets("conn")).toHaveLength(3);
    // 空编辑器：没有可保存的内容，只提示
    const blank = fakeEditor("   \n  ");
    await wire(blank);
    await blank.actions.get("ncforge.sql.saveSnippet")!.run();
    expect(h.toast).toHaveBeenLastCalledWith(expect.stringContaining("没有可保存的 SQL"), "info");
    expect(listSnippets("conn")).toHaveLength(3);
  });
});
