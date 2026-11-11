// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type * as Monaco from "monaco-editor";
const h = vi.hoisted(() => ({ url: "jdbc:oracle:thin:@h:1521/x", dialect: "auto", language: "sql", setLanguage: vi.fn() }));
vi.mock("../lib/monacoSetup", () => ({ monaco: { editor: { setModelLanguage: h.setLanguage } } }));
vi.mock("../lib/dbStore", () => ({ useDbSelector: (select: (s: unknown) => unknown) => select({ tabs: [{ id: "tab", connId: "conn" }], rt: {}, conns: [{ id: "conn", url: h.url }] }) }));
vi.mock("../lib/sqlFormatPrefs", () => ({ useSqlFormatPrefs: () => ({ dialect: h.dialect }), getSqlFormatPrefs: () => ({ dialect: h.dialect }) }));
import { useSqlEditorDialect } from "./useSqlEditorDialect";
it("按连接和手动方言更新当前模型，保留同一编辑器实例", () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div"), root = createRoot(host), model = { getLanguageId: () => h.language };
  h.setLanguage.mockImplementation((_model, language: string) => { h.language = language; });
  const ref = { current: { getModel: () => model } as unknown as Monaco.editor.IStandaloneCodeEditor };
  function Test() { useSqlEditorDialect(ref, "tab"); return null; }
  act(() => root.render(<Test />)); expect(h.setLanguage).toHaveBeenLastCalledWith(model, "ncforge-sql-plsql");
  h.url = "jdbc:postgresql://h/db";
  act(() => root.render(<Test />)); expect(h.setLanguage).toHaveBeenLastCalledWith(model, "ncforge-sql-postgresql");
  h.dialect = "plsql";
  act(() => root.render(<Test />)); expect(h.setLanguage).toHaveBeenLastCalledWith(model, "ncforge-sql-plsql");
  const count = h.setLanguage.mock.calls.length;
  act(() => root.render(<Test />)); expect(h.setLanguage).toHaveBeenCalledTimes(count);
  act(() => root.unmount());
});
