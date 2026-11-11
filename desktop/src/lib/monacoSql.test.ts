import { expect, it, vi } from "vitest";
import { registerSqlLanguages, SQL_LANGUAGE_IDS, sqlAnalysisOf, sqlSemanticProvider, sqlTokensProvider } from "./monacoSql";
import { highlightedSql } from "./sqlHighlight";
import type * as Monaco from "monaco-editor";
function modelOf(text: string, dialect = "ncforge-sql-plsql") {
  let version = 1, language = dialect;
  return {
    getValue: () => text, getValueLength: () => text.length, getVersionId: () => version, getLanguageId: () => language, isDisposed: () => false,
    getPositionAt: (offset: number) => { const lines = text.slice(0, offset).split("\n"); return { lineNumber: lines.length, column: lines[lines.length - 1].length + 1 }; },
    edit: () => version++, dialect: (id: string) => { language = id; },
  };
}
it("注册所有应用方言的共用词法与语义服务且幂等", () => {
  const languages = { register: vi.fn(), setLanguageConfiguration: vi.fn(), setTokensProvider: vi.fn(), registerDocumentSemanticTokensProvider: vi.fn() };
  registerSqlLanguages({ languages } as unknown as typeof Monaco); registerSqlLanguages({ languages } as unknown as typeof Monaco);
  expect(languages.register.mock.calls.map(call => call[0].id)).toEqual(SQL_LANGUAGE_IDS);
  expect(languages.setTokensProvider).toHaveBeenCalledTimes(8); expect(languages.registerDocumentSemanticTokensProvider).toHaveBeenCalledTimes(8);
});
it("逐行高亮与预览词法一致，跨行状态可以复制且比较", () => {
  const provider = sqlTokensProvider("plsql"), state = provider.getInitialState();
  const first = provider.tokenize("select q'[it's", state);
  expect(first.endState.equals(first.endState.clone())).toBe(true); expect(first.endState.equals(state)).toBe(false);
  const second = provider.tokenize("from fake]' from dual", first.endState);
  expect(second.tokens[0].scopes).toBe("nc-sql-string");
  expect(provider.tokenize("select :id", state).tokens.map(t => t.scopes)).toEqual(highlightedSql("select :id", "plsql").map(t => t.kind === "space" ? "" : `nc-sql-${t.kind}`));
});
it("模型按版本和方言缓存，语义数据采用同一角色分类", () => {
  const model = modelOf("select a.id, nvl(a.name, :name)\nfrom physical a"), m = model as unknown as Monaco.editor.ITextModel;
  const first = sqlAnalysisOf(m); expect(sqlAnalysisOf(m)).toBe(first); model.edit(); expect(sqlAnalysisOf(m)).not.toBe(first);
  const second = sqlAnalysisOf(m); model.dialect("sql"); expect(sqlAnalysisOf(m)).not.toBe(second);
  const provider = sqlSemanticProvider();
  const result = provider.provideDocumentSemanticTokens(m, null, { isCancellationRequested: false } as Monaco.CancellationToken) as Monaco.languages.SemanticTokens;
  const types = provider.getLegend().tokenTypes;
  expect([...result.data].filter((_, i) => i % 5 === 3).map(i => types[i])).toContain("nc-sql-column");
  expect(provider.provideDocumentSemanticTokens(m, null, { isCancellationRequested: true } as Monaco.CancellationToken)).toBeNull();
  expect(provider.provideDocumentSemanticTokens(modelOf(" ".repeat(200_001)) as unknown as Monaco.editor.ITextModel, null, { isCancellationRequested: false } as Monaco.CancellationToken)).toBeNull();
});
