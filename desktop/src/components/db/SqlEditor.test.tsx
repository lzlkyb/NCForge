// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SqlEditorApi, SqlExecutionScope } from "./SqlEditor";

type ActionDesc = { id: string; label: string; keybindings?: number[]; contextMenuGroupId?: string; contextMenuOrder?: number; run?: () => void };
type Position = { lineNumber: number; column: number };
type Selection = { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
type TestModel = {
  id: string; getValue: () => string; getVersionId: () => number; getValueLength: () => number;
  getOffsetAt: (position: Position) => number; getPositionAt: (offset: number) => Position;
  getValueInRange: (range: Selection) => string; getFullModelRange: () => Selection; setValue: (value: string) => void;
};
const mocks = vi.hoisted(() => ({
  actions: [] as ActionDesc[],
  models: new Map<string, TestModel>(),
  model: null as TestModel | null,
  position: { lineNumber: 1, column: 1 },
  selection: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
  scrollTop: 0,
  listeners: {} as Record<string, () => void>,
  create: vi.fn(), dispose: vi.fn(), focus: vi.fn(), layout: vi.fn(), draft: vi.fn(),
  undoStop: vi.fn(), format: vi.fn(), language: vi.fn((_url: string) => "plsql"), toast: vi.fn(),
}));

vi.mock("../../lib/monacoSetup", () => {
  const editor = {
    addAction: (action: ActionDesc) => { mocks.actions.push(action); return { dispose: () => {} }; },
    addCommand: () => { throw new Error("SQL 动作必须保留编辑器右键菜单"); },
    createDecorationsCollection: () => ({ set: () => {}, clear: () => {} }),
    onDidChangeCursorPosition: (callback: () => void) => { mocks.listeners.position = callback; return { dispose: () => {} }; },
    onDidChangeCursorSelection: (callback: () => void) => { mocks.listeners.selection = callback; return { dispose: () => {} }; },
    onDidChangeModelContent: (callback: () => void) => { mocks.listeners.content = callback; return { dispose: () => {} }; },
    getSelection: () => ({ ...mocks.selection, isEmpty: () => mocks.selection.startLineNumber === mocks.selection.endLineNumber && mocks.selection.startColumn === mocks.selection.endColumn, getStartPosition: () => ({ lineNumber: mocks.selection.startLineNumber, column: mocks.selection.startColumn }) }),
    getPosition: () => mocks.position,
    getModel: () => mocks.model,
    setModel: (model: TestModel) => {
      mocks.model = model; mocks.position = { lineNumber: 1, column: 1 };
      mocks.selection = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }; mocks.scrollTop = 0;
    },
    saveViewState: () => mocks.model ? { position: { ...mocks.position }, selection: { ...mocks.selection }, scrollTop: mocks.scrollTop } : null,
    restoreViewState: (view: { position: Position; selection: Selection; scrollTop: number }) => {
      mocks.position = { ...view.position }; mocks.selection = { ...view.selection }; mocks.scrollTop = view.scrollTop;
    },
    pushUndoStop: mocks.undoStop,
    executeEdits: (_source: string, edits: { range?: Selection; text: string }[]) => {
      const model = mocks.model!;
      // 按偏移从后往前替换，才能正确处理同一次批量里的多条编辑
      const spans = edits.map((edit) => {
        const range = edit.range as Selection;
        return {
          start: model.getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn }),
          end: model.getOffsetAt({ lineNumber: range.endLineNumber, column: range.endColumn }),
          text: edit.text,
        };
      }).sort((a, b) => b.start - a.start);
      let value = model.getValue();
      for (const span of spans) value = value.slice(0, span.start) + span.text + value.slice(span.end);
      model.setValue(value);
      mocks.listeners.content?.();
    },
    revealLineInCenter: () => {},
    setPosition: (position: Position) => {
      mocks.position = position;
      mocks.selection = { startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: position.lineNumber, endColumn: position.column };
      mocks.listeners.position?.();
    },
    layout: mocks.layout, focus: mocks.focus, dispose: mocks.dispose,
  };
  mocks.create.mockImplementation(() => editor);
  return {
    initMonaco: () => {},
    monaco: {
      KeyMod: { CtrlCmd: 2048, Alt: 512, Shift: 1024 }, KeyCode: { Enter: 3, KeyX: 88, KeyF: 70 },
      Range: class {
        constructor(readonly startLineNumber: number, readonly startColumn: number, readonly endLineNumber: number, readonly endColumn: number) {}
      },
      editor: { create: mocks.create },
    },
  };
});
vi.mock("../../lib/sqlModels", () => ({
  sqlModel: (id: string, initial: string) => {
    const previous = mocks.models.get(id);
    if (previous) return previous;
    let text = initial, version = 1;
    const offsetAt = (position: Position) => text.split("\n").slice(0, position.lineNumber - 1).reduce((sum, line) => sum + line.length + 1, 0) + position.column - 1;
    const positionAt = (offset: number) => { const lines = text.slice(0, offset).split("\n"); return { lineNumber: lines.length, column: lines[lines.length - 1].length + 1 }; };
    const model: TestModel = {
      id, getValue: () => text, getVersionId: () => version, getValueLength: () => text.length,
      getOffsetAt: offsetAt, getPositionAt: positionAt,
      getValueInRange: range => text.slice(offsetAt({ lineNumber: range.startLineNumber, column: range.startColumn }), offsetAt({ lineNumber: range.endLineNumber, column: range.endColumn })),
      getFullModelRange: () => { const end = positionAt(text.length); return { startLineNumber: 1, startColumn: 1, endLineNumber: end.lineNumber, endColumn: end.column }; },
      setValue: value => { text = value; version++; },
    };
    mocks.models.set(id, model); return model;
  },
  tabIdOfModel: (model: TestModel) => model.id,
}));
vi.mock("../../lib/sqlProviders", () => ({ registerSqlProviders: () => {} }));
vi.mock("../../lib/sqlFormat", () => ({ formatSql: (sql: string, lang: string) => mocks.format(sql, lang), sqlLanguageOf: (url: string) => mocks.language(url) }));
vi.mock("../../lib/dbStore", () => ({ setSqlDraft: mocks.draft, sqlTabOf: () => ({ connId: "c1" }), connOf: () => ({ url: "jdbc:oracle:thin:@h:1521/x" }) }));
vi.mock("../ui/toast", () => ({ toast: mocks.toast }));
import { SqlEditor } from "./SqlEditor";

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks(); mocks.format.mockReset(); mocks.format.mockImplementation(async (sql: string) => sql);
  mocks.actions.length = 0; mocks.models.clear(); mocks.model = null; mocks.listeners = {};
  mocks.position = { lineNumber: 1, column: 1 };
  mocks.selection = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }; mocks.scrollTop = 0;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", () => 1); vi.stubGlobal("cancelAnimationFrame", () => {});
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
function mount(initial = "", onRun = vi.fn()) {
  const apiRef: { current: SqlEditorApi | null } = { current: null };
  const onScope = vi.fn<(scope: SqlExecutionScope) => void>();
  const render = (tabId = "t1", visible = true, sql = initial) => act(() => root.render(<SqlEditor tabId={tabId} initial={sql} visible={visible} onRun={onRun} apiRef={apiRef} onScope={onScope} />));
  render();
  return { apiRef, onScope, render };
}
function select(range: Selection) {
  mocks.selection = range; mocks.position = { lineNumber: range.endLineNumber, column: range.endColumn };
  act(() => mocks.listeners.selection());
}

describe("SQL 编辑器动作与真实执行目标", () => {
  it("三条动作保留右键菜单、命令面板与原有快捷键", () => {
    const onRun = vi.fn(); mount("", onRun);
    expect(mocks.actions.map(action => action.id)).toEqual(["ncforge.sql.runCurrent", "ncforge.sql.runScript", "ncforge.sql.format"]);
    for (const action of mocks.actions) { expect(action.contextMenuGroupId).toBeTruthy(); expect(action.label.length).toBeGreaterThan(0); }
    const [current, script, format] = mocks.actions;
    expect(current.keybindings).toEqual([2048 | 3]); expect(script.keybindings).toEqual([512 | 88]); expect(format.keybindings).toEqual([2048 | 1024 | 70]);
    act(() => current.run?.()); expect(onRun).toHaveBeenCalledWith("current");
    act(() => script.run?.()); expect(onRun).toHaveBeenCalledWith("script");
  });

  it("选区范围复用 target()，字符串中的分号不会被统计为额外语句", () => {
    const { apiRef, onScope } = mount("-- 标题\nselect ';' AS txt\nfrom dual;\n\nselect 2 from dual;");
    select({ startLineNumber: 2, startColumn: 1, endLineNumber: 5, endColumn: 20 });
    const target = apiRef.current!.target("current");
    const shown = onScope.mock.lastCall![0];
    expect(shown).toEqual({ tabId: "t1", selected: true, statements: target });
    expect(target).toHaveLength(2);
    expect(target[0].startLine).toBe(2); expect(target[1].endLine).toBe(5);
    expect(apiRef.current!.target("script")).toHaveLength(2);
  });

  it("PL/SQL 的内部语句仍作为一个真实执行目标", () => {
    const { apiRef, onScope } = mount("begin\n  null;\n  null;\nend;\n/");
    expect(apiRef.current!.target("current")).toHaveLength(1);
    expect(onScope.mock.lastCall![0].statements).toEqual(apiRef.current!.target("current"));
  });

  it("初始化、清空和只剩注释时立即报告没有可执行语句", () => {
    const { apiRef, onScope } = mount(" \n -- 备注");
    expect(onScope.mock.lastCall![0]).toEqual({ tabId: "t1", selected: false, statements: [] });
    act(() => apiRef.current!.setText(""));
    expect(onScope.mock.lastCall![0].statements).toEqual([]);
    expect(mocks.draft).toHaveBeenCalledWith("t1", "");
  });

  it("选区 provenance 使用编辑器绝对偏移，保留同一模型的 SQL 与版本", () => {
    const sql = "-- note\nselect 1;\n\nselect 2;";
    const { apiRef } = mount(sql);
    select({ startLineNumber: 2, startColumn: 1, endLineNumber: 4, endColumn: 10 });
    const selected = apiRef.current!.target("current");
    expect(selected.map(stmt => [stmt.startOffset, stmt.endOffset])).toEqual([
      [sql.indexOf("select 1"), sql.indexOf("select 1") + "select 1;".length],
      [sql.indexOf("select 2"), sql.length],
    ]);
    for (const stmt of selected) { expect(stmt.editorVersion).toBe(1); expect(stmt.editorSql).toBe(sql); }
    const script = apiRef.current!.target("script");
    expect(script[0].startOffset).toBe(0);
    expect(script[script.length - 1].endOffset).toBe(sql.length);
  });

  it("不相关语句编辑不会重发相同范围，但真正执行目标取得最新编辑版本", () => {
    const { apiRef, onScope } = mount("select 1;\nselect 2;");
    const before = onScope.mock.calls.length;
    act(() => { mocks.model!.setValue("select 1;\nselect 3;"); mocks.listeners.content(); });
    expect(onScope).toHaveBeenCalledTimes(before);
    const current = apiRef.current!.target("current")[0];
    expect(current.text).toBe("select 1");
    expect(current.editorVersion).toBe(2);
    expect(current.editorSql).toBe("select 1;\nselect 3;");
  });
});

it("专注模式不卸载编辑器，返回时恢复草稿、选区和滚动", () => {
  const sql = "select 1;\nselect 2;\nselect 3;\nselect 4;";
  const { render, apiRef } = mount(sql);
  const editorHost = host.querySelector(".wb-editor-host");
  select({ startLineNumber: 2, startColumn: 1, endLineNumber: 3, endColumn: 9 }); mocks.scrollTop = 180;
  const target = apiRef.current!.target("current");
  render("t1", false);
  expect(host.querySelector<HTMLDivElement>(".dbx-editor")?.hidden).toBe(true);
  mocks.scrollTop = 0;
  render("t1", true);
  expect(host.querySelector(".wb-editor-host")).toBe(editorHost);
  expect(mocks.create).toHaveBeenCalledOnce(); expect(mocks.dispose).not.toHaveBeenCalled();
  expect(mocks.model!.getValue()).toBe(sql); expect(mocks.scrollTop).toBe(180);
  expect(apiRef.current!.target("current")).toEqual(target);
});

it("切标签恢复各自视图，并立即替换执行范围，隐藏的旧视图不覆盖已保存滚动", () => {
  const { render, onScope, apiRef } = mount("select 1;\nselect 2;\nselect 3;");
  select({ startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 10 }); mocks.scrollTop = 120;
  const firstTarget = apiRef.current!.target("current");
  render("t1", false); mocks.scrollTop = 0;
  render("t2", true, "select 4;");
  expect(onScope.mock.lastCall![0].tabId).toBe("t2");
  expect(onScope.mock.lastCall![0].selected).toBe(false);
  expect(mocks.scrollTop).toBe(0);
  render("t1", false); render("t1", true);
  expect(onScope.mock.lastCall![0]).toEqual({ tabId: "t1", selected: true, statements: firstTarget });
  expect(mocks.scrollTop).toBe(120);
});

describe("SQL 格式化接线", () => {
  const runFormat = () => mocks.actions.find((a) => a.id === "ncforge.sql.format")!.run!() as unknown as Promise<void>;

  it("按连接方言排版并应用结果；PL/SQL 块不再被跳过", async () => {
    mocks.format.mockResolvedValue("begin\n  null;\nend;");
    mount("begin null; end;");
    await act(async () => { await runFormat(); });
    expect(mocks.language).toHaveBeenCalledWith("jdbc:oracle:thin:@h:1521/x");
    expect(mocks.format).toHaveBeenCalledWith(expect.any(String), "plsql");
    expect(mocks.model!.getValue()).toBe("begin\n  null;\nend;");
  });

  it("懒加载期间内容被改动则放弃，不拿旧范围覆盖新内容", async () => {
    let resolveFmt!: (v: string) => void;
    mocks.format.mockImplementation(() => new Promise<string>((r) => { resolveFmt = r; }));
    mount("select 1 from dual");
    const pending = runFormat();
    act(() => { mocks.model!.setValue("select 2 from dual"); mocks.listeners.content(); });
    resolveFmt("select\n  1\nfrom\n  dual");
    await pending;
    expect(mocks.model!.getValue()).toBe("select 2 from dual");
  });

  it("格式化失败给出可见提示，原文不动", async () => {
    mocks.format.mockRejectedValue(new Error("解析失败"));
    mount("select 1 from dual");
    await act(async () => { await runFormat(); });
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("格式化失败"), "warning");
    expect(mocks.model!.getValue()).toBe("select 1 from dual");
  });
});

describe("SQL 格式化范围", () => {
  it("current 只取光标处语句", async () => {
    mocks.format.mockResolvedValue("select\n  2");
    const { apiRef } = mount("select 1;\nselect 2;");
    mocks.position = { lineNumber: 2, column: 1 };
    await act(async () => { await apiRef.current!.format("current"); });
    expect(mocks.format).toHaveBeenCalledWith("select 2", "plsql");
  });

  it("script 忽略选区，排版整个脚本", async () => {
    const { apiRef } = mount("select 1;\nselect 2;");
    select({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 9 });
    await act(async () => { await apiRef.current!.format("script"); });
    expect(mocks.format).toHaveBeenCalledWith("select 1;\nselect 2;", "plsql");
  });

  it("current 有选中时仍只排光标所在语句", async () => {
    mocks.format.mockResolvedValue("select\n  2");
    const { apiRef } = mount("select 1;\nselect 2;");
    select({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 9 });
    mocks.position = { lineNumber: 2, column: 1 };
    await act(async () => { await apiRef.current!.format("current"); });
    expect(mocks.format).toHaveBeenCalledWith("select 2", "plsql");
  });

  it("auto 有选区时只排版选区（原行为）", async () => {
    const { apiRef } = mount("select 1;\nselect 2;");
    select({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 9 });
    await act(async () => { await apiRef.current!.format("auto"); });
    expect(mocks.format).toHaveBeenCalledWith("select 1", "plsql");
  });
});

it("无选区美化整个编辑器，并隔离撤销边界", async () => {
  mocks.format.mockResolvedValue("SELECT 1;\nSELECT 2;");
  const { apiRef } = mount("select 1; select 2;");
  await act(async () => { await apiRef.current!.format(); });
  expect(mocks.format).toHaveBeenCalledWith("select 1; select 2;", "plsql");
  expect(mocks.undoStop).toHaveBeenCalledTimes(2);
});
it("存在选区时仅将选中内容交给美化器", async () => {
  mocks.format.mockResolvedValue("SELECT 2");
  const { apiRef } = mount("select 1;\nselect 2");
  select({startLineNumber:2,startColumn:1,endLineNumber:2,endColumn:9});
  await act(async () => { await apiRef.current!.format(); });
  expect(mocks.format).toHaveBeenCalledWith("select 2", "plsql");
});

describe("整篇格式化兜底", () => {
  // 模拟解析器：括号没闭合就整条报错，其余原样返回（大写以便区分是否真的排过）
  const parseLoose = async (sql: string) => {
    if (sql.includes("(") && !sql.includes(")")) throw new Error("Parse error: unmatched (");
    return sql.toUpperCase();
  };

  it("整篇解析失败时逐条排版，只跳过写了一半的语句", async () => {
    mocks.format.mockImplementation(parseLoose);
    const { apiRef } = mount("select a;\nselect * from t where id in (1, 2;\nselect c;");
    await act(async () => { await apiRef.current!.format("script"); });
    expect(mocks.model!.getValue()).toBe("SELECT A;\nselect * from t where id in (1, 2;\nSELECT C;");
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("跳过 1 条"), "warning");
    expect(mocks.undoStop).toHaveBeenCalledTimes(2);
  });

  it("每条都解析不了时提示失败且原文不动", async () => {
    mocks.format.mockRejectedValue(new Error("Parse error"));
    const { apiRef } = mount("select 1;\nselect 2;");
    await act(async () => { await apiRef.current!.format("script"); });
    expect(mocks.model!.getValue()).toBe("select 1;\nselect 2;");
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("格式化失败"), "warning");
  });

  it("语句范围解析失败不兜底，直接提示", async () => {
    mocks.format.mockRejectedValue(new Error("Parse error"));
    const { apiRef } = mount("select 1;");
    await act(async () => { await apiRef.current!.format("current"); });
    expect(mocks.format).toHaveBeenCalledTimes(1);
    expect(mocks.model!.getValue()).toBe("select 1;");
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("格式化失败"), "warning");
  });
});
