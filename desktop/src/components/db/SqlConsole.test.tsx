// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SqlTab } from "../../lib/dbStore";
import type { RunStmt, SqlEditorApi, SqlExecutionScope } from "./SqlEditor";
import type { SqlConsoleFocus } from "../../hooks/useSqlConsoleSplit";
const mocks = vi.hoisted(() => ({
  run: vi.fn(), explain: vi.fn(), cancel: vi.fn(), cancelOperation: vi.fn(), reveal: vi.fn(), focus: vi.fn(), toast: vi.fn(),
  mounts: 0, unmounts: 0,
  targets: {} as Record<string, Record<"current" | "script", RunStmt[]>>,
  publish: null as ((scope: SqlExecutionScope) => void) | null,
}));
vi.mock("../../lib/dbActions", () => ({ runStatements: mocks.run, explain: mocks.explain }));
vi.mock("../../lib/dbApi", () => ({ dbApi: { cancel: mocks.cancel } }));
vi.mock("../../lib/db", () => ({ friendlyDbError: (error: unknown) => String(error) }));
vi.mock("../../lib/operations", () => ({ cancelOperation: mocks.cancelOperation, getOperations: () => [] }));
vi.mock("../../lib/resultExport", () => ({ guessTable: () => "DUAL" }));
vi.mock("../../lib/dbStore", () => ({ useDbSelector: (selector: (state: { sessionPanel: null }) => unknown) => selector({ sessionPanel: null }), closeSessionPanel: () => {}, openSessionPanel: () => {}, sqlTabOf: () => ({}) }));
vi.mock("../ui/toast", () => ({ toast: mocks.toast }));
vi.mock("./HistoryDrawer", () => ({ HistoryDrawer: () => null }));
vi.mock("./SnippetDrawer", () => ({ SnippetDrawer: () => null }));
vi.mock("./SessionDrawer", () => ({ SessionDrawer: () => null }));
vi.mock("./InsertExportDialog", () => ({ InsertExportDialog: () => null }));
vi.mock("./ValueSearchDialog", () => ({ ValueSearchDialog: () => null }));
vi.mock("./ScriptReplayDialog", () => ({ ScriptReplayDialog: () => null }));
vi.mock("./SqlToolbar", () => ({ SqlToolbar: ({ scope, onRun, onStop, focusMode, onFocusChange }: {
  scope: SqlExecutionScope | null; onRun: (mode: "current" | "script", collectStats?: boolean) => void; onStop: () => void; focusMode: SqlConsoleFocus; onFocusChange: (mode: SqlConsoleFocus) => void;
}) => <div data-scope={JSON.stringify(scope)} data-focus-mode={focusMode}>
  <button onClick={() => onRun("current")}>执行当前</button><button onClick={() => onRun("script")}>执行脚本</button><button onClick={onStop}>停止</button>
  <button onClick={() => onRun("current", true)}>执行并采集统计</button>
  <button onClick={() => onFocusChange("results")}>专注结果</button><button onClick={() => onFocusChange("editor")}>专注编辑器</button><button onClick={() => onFocusChange("split")}>还原布局</button>
</div> }));
vi.mock("./SqlEditor", async () => {
  const { useLayoutEffect } = await import("react");
  return { SqlEditor: ({ tabId, initial, visible, apiRef, onScope }: { tabId: string; initial: string; visible: boolean; apiRef: { current: SqlEditorApi | null }; onScope: (scope: SqlExecutionScope) => void }) => {
    useLayoutEffect(() => { mocks.mounts++; return () => { mocks.unmounts++; }; }, []);
    useLayoutEffect(() => {
      const api: SqlEditorApi = { target: mode => mocks.targets[tabId][mode], reveal: line => mocks.reveal(tabId, line), focus: () => mocks.focus(tabId), format: () => {}, insert: () => {}, setText: () => {} };
      apiRef.current = api; mocks.publish = onScope;
      onScope({ tabId, selected: false, statements: api.target("current") });
      return () => { apiRef.current = null; };
    }, [tabId, apiRef, onScope]);
    return <div className="dbx-editor" hidden={!visible}><textarea defaultValue={initial} /></div>;
  } };
});
vi.mock("./ResultPanel", () => ({ ResultPanel: ({ height }: { height: number }) => <div className="dbx-res" role="grid" tabIndex={0} data-height={height} /> }));
import { SqlConsole } from "./SqlConsole";
import { ViewActivityContext } from "../../lib/viewActivity";
const base: SqlTab = { id: "a", kind: "sql", title: "SQL 1", connId: "c1", sql: "select 1 from dual;", maxRows: 200, timeoutSec: 30, results: [], output: [], plan: null, view: null, running: false, slot: "1" };
let root: Root, host: HTMLDivElement, frames: FrameRequestCallback[];
beforeEach(() => {
  vi.clearAllMocks(); mocks.mounts = 0; mocks.unmounts = 0; mocks.publish = null;
  const first = { text: "select 1 from dual", startLine: 2, endLine: 4 };
  mocks.targets = { a: { current: [first], script: [first, { text: "select 2 from dual", startLine: 6, endLine: 6 }] }, b: { current: [{ text: "select 3 from dual", startLine: 1, endLine: 1 }], script: [] } };
  mocks.run.mockReset().mockResolvedValue({}); mocks.cancel.mockResolvedValue({});
  frames = []; localStorage.clear(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const render = (tab: SqlTab = base, active = true) => act(() => root.render(<ViewActivityContext.Provider value={active}><SqlConsole tab={tab} /></ViewActivityContext.Provider>));
const click = (label: string) => act(() => [...host.querySelectorAll("button")].find(button => button.textContent === label)!.click());
const shown = () => JSON.parse(host.querySelector("[data-scope]")!.getAttribute("data-scope")!) as SqlExecutionScope | null;

it("工具条范围与实际交给执行器的目标一致", async () => {
  render(); expect(shown()?.statements).toEqual(mocks.targets.a.current);
  await act(async () => click("执行当前"));
  expect(mocks.run).toHaveBeenCalledExactlyOnceWith("a", mocks.targets.a.current, { collectStats: false });
});

it("诊断执行将采集选项传入执行器", async () => {
  render();
  await act(async () => click("执行并采集统计"));
  expect(mocks.run).toHaveBeenCalledExactlyOnceWith("a", mocks.targets.a.current, { collectStats: true });
});

it("脚本执行中冻结实际执行范围，随后修改编辑器不会把范围改成下一条 SQL", async () => {
  let finish!: (value: object) => void;
  mocks.run.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(); click("执行脚本"); render({ ...base, running: true });
  expect(shown()?.statements).toEqual(mocks.targets.a.script);
  act(() => mocks.publish!({ tabId: "a", selected: true, statements: [{ text: "select 99", startLine: 20, endLine: 20 }] }));
  expect(shown()?.statements).toEqual(mocks.targets.a.script);
  await act(async () => finish({}));
  render(); expect(shown()?.statements[0].text).toBe("select 99");
});

it("专注布局保持编辑器实例、草稿与选区，标签间独立保存模式", () => {
  render(); const editor = host.querySelector("textarea")!;
  editor.value = "select draft"; editor.setSelectionRange(2, 8); editor.scrollTop = 48;
  click("专注结果"); act(() => { frames.splice(0).forEach(callback => callback(0)); });
  expect(host.querySelector<HTMLDivElement>(".dbx-editor")?.hidden).toBe(true);
  expect(host.querySelector(".dbx-res")?.getAttribute("data-height")).toBe("600");
  render({ ...base, id: "b" }); expect(host.querySelector(".dbx-console-main")?.getAttribute("data-focus")).toBe("split");
  render(); expect(host.querySelector(".dbx-console-main")?.getAttribute("data-focus")).toBe("results");
  click("专注编辑器"); click("还原布局");
  expect(host.querySelector("textarea")).toBe(editor); expect(editor.value).toBe("select draft");
  expect(editor.selectionStart).toBe(2); expect(editor.selectionEnd).toBe(8); expect(editor.scrollTop).toBe(48);
  expect(mocks.mounts).toBe(1); expect(mocks.unmounts).toBe(0); expect(mocks.run).not.toHaveBeenCalled();
});

it("旧标签的异步执行失败不会定位到新标签或抢走光标", async () => {
  let finish!: (value: { failLine: number }) => void;
  mocks.run.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(); click("执行当前"); render({ ...base, id: "b" });
  expect(shown()?.tabId).toBe("b");
  await act(async () => finish({ failLine: 8 }));
  expect(mocks.reveal).not.toHaveBeenCalled();
});

it("进入比对后后台查询失败仍保留原编辑器光标与实例", async () => {
  let finish!: (value: { failLine: number }) => void;
  mocks.run.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(); const editor = host.querySelector("textarea")!;
  editor.setSelectionRange(3, 9); click("执行当前"); render(base, false);
  expect(host.querySelector<HTMLDivElement>(".dbx-editor")?.hidden).toBe(true);
  await act(async () => finish({ failLine: 8 }));
  expect(mocks.reveal).not.toHaveBeenCalled();
  render(); expect(host.querySelector("textarea")).toBe(editor);
  expect(editor.selectionStart).toBe(3); expect(editor.selectionEnd).toBe(9);
  expect(mocks.mounts).toBe(1); expect(mocks.unmounts).toBe(0);
});

it("停止仍使用当前标签的独立会话槽", async () => {
  render({ ...base, running: true });
  await act(async () => click("停止"));
  expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith("c1", "1");
});
