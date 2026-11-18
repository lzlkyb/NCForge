// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { monaco } from "./monacoSetup";

const h = vi.hoisted(() => ({
  rt: { status: "connected", currentSchema: "APP", tables: [{ name: "BD_MATERIAL", kind: "TABLE" }, { name: "BD_PROJECT", kind: "TABLE" }] } as Record<string, unknown>,
  peek: vi.fn(), read: vi.fn(), templates: true,
}));
vi.mock("./monacoSetup", () => ({ monaco: {
  Range: class { constructor(readonly a: number, readonly b: number, readonly c: number, readonly d: number) {} },
  editor: { ContentWidgetPositionPreference: { EXACT: 0 } },
} }));
vi.mock("./dbStore", () => ({ sqlTabOf: () => ({ connId: "c" }), rtOf: () => h.rt, connOf: () => ({ id: "c", url: "jdbc:oracle:thin:@host" }) }));
vi.mock("./dbResultContext", () => ({ connectionKey: () => "k" }));
vi.mock("./sqlModels", () => ({ tabIdOfModel: () => "t" }));
vi.mock("./sqlUsage", () => ({ sqlUsageScope: () => "s" }));
vi.mock("./monacoSql", async () => {
  const { analyzeSql } = await import("./sqlScope");
  return { dialectOfSqlModel: () => "plsql", sqlAnalysisOf: (model: { getValue: () => string }) => analyzeSql(model.getValue(), "plsql") };
});
vi.mock("./sqlBusiness", async importOriginal => ({
  ...await importOriginal<typeof import("./sqlBusiness")>(),
  peekSqlBusinessMetadata: h.peek, readSqlBusinessMetadata: h.read,
}));
vi.mock("./sqlTemplates", () => ({ getSqlTemplatesEnabled: () => h.templates }));

const billMeta = {
  table: "bd_material", schema: "APP",
  relations: [{ id: "外键 · FK_MATERIAL_PROJECT", source: "bd_project", target: "bd_material", from: ["pk_project"], to: ["pk_project"], kind: "外键" }],
  enums: [], partial: false, sharedSession: false,
};
const cleanups: { dispose(): void }[] = [];
beforeEach(() => { h.peek.mockReset(); h.read.mockReset().mockResolvedValue(null); h.templates = true; });
afterEach(() => { cleanups.splice(0).forEach(d => d.dispose()); });

function fakeEditor(sql: string) {
  let offset = 0;
  const handlers = new Map<string, () => void>();
  const model = {
    getValue: () => sql, getVersionId: () => 1, isDisposed: () => false,
    getPositionAt: (at: number) => { const lines = sql.slice(0, at).split("\n"); return { lineNumber: lines.length, column: lines[lines.length - 1].length + 1 }; },
    getOffsetAt: (p: { lineNumber: number; column: number }) => sql.split("\n").slice(0, p.lineNumber - 1).reduce((n, line) => n + line.length + 1, 0) + p.column - 1,
  };
  const listen = (id: string) => (fn: () => void) => { handlers.set(id, fn); return { dispose: () => handlers.delete(id) }; };
  let widget: monaco.editor.IContentWidget | null = null;
  const decorations: { options?: { after?: { content?: string } } }[] = [];
  const actions = new Map<string, () => void>();
  const editor = {
    getModel: () => model, getPosition: () => model.getPositionAt(offset),
    getSelection: () => null,
    setPosition: (p: { lineNumber: number; column: number }) => { offset = model.getOffsetAt(p); },
    focus: vi.fn(), trigger: vi.fn(), layoutContentWidget: vi.fn(), removeContentWidget: vi.fn(),
    getAction: (id: string) => { const run = actions.get(id); return run ? { run } : null; },
    addContentWidget: (w: monaco.editor.IContentWidget) => { widget = w; },
    createDecorationsCollection: () => ({ set: (d: typeof decorations) => { decorations.splice(0, decorations.length, ...d); }, clear: () => decorations.splice(0) }),
    onDidChangeCursorPosition: listen("cursor"), onDidChangeCursorSelection: listen("selection"), onDidChangeModelContent: listen("content"), onDidChangeModel: listen("model"),
  };
  return {
    editor: editor as unknown as monaco.editor.IStandaloneCodeEditor, spy: editor, model, decorations, actions,
    chip: () => (widget?.getDomNode() as HTMLButtonElement | undefined),
    position: () => widget?.getPosition() ?? null,
    move: (at: number) => { offset = at; handlers.get("cursor")?.(); },
    offset: () => offset,
  };
}
async function wire(fake: ReturnType<typeof fakeEditor>) {
  const { wireSqlAssistGhost } = await import("./sqlAssistGhost");
  cleanups.push(wireSqlAssistGhost(fake.editor));
  return fake;
}

describe("SQL 行内提示", () => {
  it("光标停在表名上且关系已知时，表名后挂出可点的联查 chip", async () => {
    h.peek.mockReturnValue(billMeta);
    const fake = await wire(fakeEditor("SELECT * FROM bd_material m"));
    expect(fake.position()).toBeNull();
    fake.move(14);
    expect(fake.position()).toEqual({ position: { lineNumber: 1, column: 26 }, preference: [0] });
    expect(fake.chip()!.hidden).toBe(false);
    expect(fake.chip()!.title).toContain("支持主子表联查");
  });
  // 只说「支持联查」却不给按钮等于没说；点 chip 要把光标放回表名末尾再开菜单。
  it("点 chip 把光标移到表名末尾并唤起 CodeAction 菜单", async () => {
    h.peek.mockReturnValue(billMeta);
    const fake = await wire(fakeEditor("SELECT * FROM bd_material m"));
    fake.move(14);
    fake.chip()!.click();
    expect(fake.offset()).toBe(25);
    expect(fake.spy.trigger).toHaveBeenCalledWith("sql-ghost", "editor.action.quickFix", {});
  });
  // 关系没读到之前不显示：说了「支持联查」却点不动，比不标更糟。
  it("关系还没读到时不显示 chip，光标停住后读一次，读到了自己补上", async () => {
    h.peek.mockReturnValue(null);
    const fake = await wire(fakeEditor("SELECT * FROM bd_material m"));
    vi.useFakeTimers();
    try {
      fake.move(14);
      expect(fake.position()).toBeNull();
      expect(h.read).not.toHaveBeenCalled();
      vi.advanceTimersByTime(400);
      expect(h.read).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it("光标在别名或字段上不挂 chip", async () => {
    h.peek.mockReturnValue(billMeta);
    const fake = await wire(fakeEditor("SELECT * FROM bd_material m"));
    fake.move(26);
    expect(fake.position()).toBeNull();
  });
  // 「展开 *」原先只在右键菜单里：光标停在 * 上时屏幕上没有任何提示。
  it("光标停在 SELECT 的 * 上时给出展开字段的入口，点击打开补全供确认", async () => {
    const fake = await wire(fakeEditor("SELECT * FROM bd_material"));
    fake.move(7);
    expect(fake.chip()!.hidden).toBe(false);
    expect(fake.chip()!.textContent).toBe("展开字段");
    fake.chip()!.click();
    expect(fake.spy.trigger).toHaveBeenCalledWith("sql-ghost", "editor.action.triggerSuggest", {});
  });
  // 乘法里的 * 不是通配投影，展开会改坏语句。
  it("乘法里的 * 上不挂展开 chip", async () => {
    const fake = await wire(fakeEditor("SELECT a.qty * 2 FROM lines a"));
    fake.move(13);
    expect(fake.position()).toBeNull();
  });
  it("LEFT JOIN 后的 WHERE 条件在光标所在行给出人话说明，换行就不挂", async () => {
    const sql = "SELECT a.* FROM head a LEFT JOIN lines b ON a.id=b.head_id WHERE b.qty > 1;\nSELECT 1 FROM dual";
    const fake = await wire(fakeEditor(sql));
    expect(fake.decorations).toHaveLength(1);
    expect(fake.decorations[0].options?.after?.content).toContain("排除无匹配主表行");
    fake.move(sql.indexOf("SELECT 1"));
    expect(fake.decorations).toHaveLength(0);
  });
  it("模板总开关关闭时不提供任何行内提示", async () => {
    h.templates = false; h.peek.mockReturnValue(billMeta);
    const fake = await wire(fakeEditor("SELECT * FROM bd_material m WHERE 1=1"));
    fake.move(14);
    expect(fake.position()).toBeNull();
  });
});
