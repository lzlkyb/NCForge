import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { monaco } from "./monacoSetup";
const h = vi.hoisted(() => ({ enabled: true, subscriptions: new Set<() => void>(), markers: vi.fn(), providers: new Set<monaco.languages.CodeActionProvider>() }));
vi.mock("./monacoSetup", () => ({ monaco: { MarkerSeverity: { Info: 2 }, Range: { fromPositions: (a: { lineNumber: number; column: number }, b: { lineNumber: number; column: number }) => ({ startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: b.lineNumber, endColumn: b.column }) }, editor: { setModelMarkers: h.markers }, languages: { registerCodeActionProvider: (_: string, p: monaco.languages.CodeActionProvider) => { h.providers.add(p); return { dispose: () => h.providers.delete(p) }; } } } }));
vi.mock("./monacoSql", async () => {
  const { analyzeSql } = await import("./sqlScope");
  return { sqlAnalysisOf: (model: monaco.editor.ITextModel) => analyzeSql(model.getValue(), "plsql"), SQL_LANGUAGE_IDS: ["sql"] };
});
vi.mock("./sqlTemplates", () => ({ getSqlTemplatesEnabled: () => h.enabled, subscribeSqlTemplates: (fn: () => void) => { h.subscriptions.add(fn); return () => h.subscriptions.delete(fn); } }));
import { wireSqlJoinMeaningAssist } from "./sqlJoinMeaningAssist";
const cleanups: (() => void)[] = [];
beforeEach(() => { h.enabled = true; h.markers.mockReset(); vi.useFakeTimers(); });
afterEach(() => { cleanups.splice(0).forEach(d => d()); vi.useRealTimers(); });
function fake(sql = "SELECT * FROM head a LEFT JOIN lines b ON a.id=b.parent_id WHERE b.qty>1") {
  let value = sql, version = 1;
  const listeners = new Map<string, () => void>(), model = { uri: { path: "/sql" }, getValue: () => value, getVersionId: () => version, isDisposed: () => false,
    getPositionAt: (offset: number) => ({ lineNumber: 1, column: offset + 1 }), getOffsetAt: (p: { column: number }) => p.column - 1 };
  const listen = (key: string) => (fn: () => void) => { listeners.set(key, fn); return { dispose: () => listeners.delete(key) }; };
  let current = model;
  const editor = { getModel: () => current, onDidChangeModelContent: listen("content"), onDidChangeModel: listen("model") };
  const handle = wireSqlJoinMeaningAssist(editor as unknown as monaco.editor.IStandaloneCodeEditor); cleanups.push(() => handle.dispose());
  return { model: model as unknown as monaco.editor.ITextModel, handle, change(text: string) { value = text; version++; listeners.get("content")?.(); },
    switch() { current = { ...model, uri: { path: "/new" }, getValue: () => "SELECT 1 FROM dual" }; listeners.get("model")?.(); }, listeners };
}
it("只发布含义提示，不自动修改，修正操作包含明确版本与完整编辑", async () => {
  const f = fake(), marker = h.markers.mock.lastCall![2][0];
  expect(marker.source).toBe("查询条件含义"); expect(marker.code).toBe("left-join-where");
  const provider = [...h.providers][0], range = { startLineNumber: 1, endLineNumber: 1, startColumn: marker.startColumn, endColumn: marker.endColumn };
  const result = await provider.provideCodeActions(f.model, range as monaco.Range, {} as monaco.languages.CodeActionContext, { isCancellationRequested: false } as monaco.CancellationToken);
  expect(result?.actions).toHaveLength(2);
  expect(result?.actions[0].title).toContain("移入 ON"); expect(result?.actions[0].edit?.edits).toHaveLength(2);
  expect(result?.actions[0].edit?.edits[0]).toMatchObject({ versionId: 1, resource: f.model.uri });
});
it("编辑后先清旧提示，有限延迟只分析最新内容；关闭开关立即清理", () => {
  const f = fake(); f.change("SELECT 1 FROM dual"); f.change("SELECT * FROM head a LEFT JOIN lines b ON 1=1 WHERE b.qty IS NULL");
  vi.advanceTimersByTime(250); expect(h.markers.mock.lastCall![2]).toEqual([]);
  h.enabled = false; h.subscriptions.forEach(fn => fn()); expect(h.markers.mock.lastCall![2]).toEqual([]);
  f.handle.dispose(); expect(h.providers.size).toBe(0); expect(h.subscriptions.size).toBe(0); expect(f.listeners.size).toBe(0);
});
it("切换模型清理旧标记，取消请求不返回修改", async () => {
  const f = fake(), provider = [...h.providers][0]; f.switch(); vi.advanceTimersByTime(250);
  expect(h.markers.mock.calls.some(c => c[0] === f.model && c[2].length === 0)).toBe(true);
  const result = await provider.provideCodeActions(f.model, {} as monaco.Range, {} as monaco.languages.CodeActionContext, { isCancellationRequested: true } as monaco.CancellationToken);
  expect(result?.actions).toEqual([]);
});
