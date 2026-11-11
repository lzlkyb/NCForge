import type * as Monaco from "monaco-editor";
import type { SqlLanguage } from "sql-formatter";
import { initialSqlState, scanSql, type SqlLexState } from "./sqlLex";
import { analyzeSql, SQL_ANALYSIS_LIMIT, type SqlAnalysis } from "./sqlScope";
import { SQL_HIGHLIGHT_KINDS, sqlHighlightKind, sqlTokenStyle } from "./sqlHighlight";
import "./sql-highlight.css";

const DIALECTS: SqlLanguage[] = ["sql", "plsql", "mysql", "mariadb", "postgresql", "tsql", "db2", "sqlite"];
export const sqlLanguageId = (dialect: SqlLanguage) => dialect === "sql" ? "sql" : `ncforge-sql-${dialect}`;
export const SQL_LANGUAGE_IDS = DIALECTS.map(sqlLanguageId);
export const dialectOfSqlModel = (model: Monaco.editor.ITextModel): SqlLanguage => DIALECTS.find(d => sqlLanguageId(d) === model.getLanguageId()) ?? "sql";
const cache = new WeakMap<Monaco.editor.ITextModel, { version: number; dialect: SqlLanguage; analysis: SqlAnalysis }>();

export function sqlAnalysisOf(model: Monaco.editor.ITextModel): SqlAnalysis {
  const version = model.getVersionId(), dialect = dialectOfSqlModel(model), previous = cache.get(model);
  if (previous?.version === version && previous.dialect === dialect) return previous.analysis;
  // Monaco still tokenizes visible lines; large scripts skip full-document completion/link analysis.
  const analysis = analyzeSql(model.getValueLength() > SQL_ANALYSIS_LIMIT ? "" : model.getValue(), dialect);
  cache.set(model, { version, dialect, analysis });
  return analysis;
}

class SqlState implements Monaco.languages.IState {
  constructor(readonly value = initialSqlState()) {}
  clone() { return new SqlState({ ...this.value }); }
  equals(other: Monaco.languages.IState) {
    return other instanceof SqlState && (Object.keys(this.value) as (keyof SqlLexState)[]).every(key => this.value[key] === other.value[key]);
  }
}

export function sqlTokensProvider(dialect: SqlLanguage): Monaco.languages.TokensProvider {
  return {
    getInitialState: () => new SqlState(),
    tokenize: (line, state) => {
      const result = scanSql(line, dialect, (state as SqlState).value);
      return { endState: new SqlState(result.state), tokens: result.tokens.map(token => ({ startIndex: token.start, scopes: token.kind === "space" ? "" : sqlTokenStyle(token.kind === "quoted" ? "identifier" : token.kind) })) };
    },
  };
}

export function sqlSemanticProvider(): Monaco.languages.DocumentSemanticTokensProvider {
  return {
    getLegend: () => ({ tokenTypes: SQL_HIGHLIGHT_KINDS.map(sqlTokenStyle), tokenModifiers: [] }),
    provideDocumentSemanticTokens: (model, _lastResultId, cancel) => {
      if (cancel.isCancellationRequested || model.isDisposed() || model.getValueLength() > SQL_ANALYSIS_LIMIT) return null;
      const analysis = sqlAnalysisOf(model), data: number[] = [];
      let lastLine = 0, lastColumn = 0;
      for (const [i] of [...analysis.roles].sort(([a], [b]) => a - b)) {
        const token = analysis.tokens[i], kind = sqlHighlightKind(analysis, i);
        if (kind === "space") continue;
        let offset = token.start;
        // Quoted identifiers can span lines; Monaco tokens cannot.
        for (const line of token.text.split("\n")) {
          const position = model.getPositionAt(offset), currentLine = position.lineNumber - 1, column = position.column - 1;
          if (line.length) {
            data.push(currentLine - lastLine, currentLine === lastLine ? column - lastColumn : column, line.length, SQL_HIGHLIGHT_KINDS.indexOf(kind), 0);
            lastLine = currentLine; lastColumn = column;
          }
          offset += line.length + 1;
        }
      }
      return cancel.isCancellationRequested ? null : { resultId: String(model.getVersionId()), data: new Uint32Array(data) };
    },
    // The cache belongs to the model WeakMap; result IDs hold no external resources.
    releaseDocumentSemanticTokens: () => {},
  };
}

let wired = false;
export function registerSqlLanguages(monaco: typeof Monaco) {
  if (wired) return;
  wired = true;
  for (const dialect of DIALECTS) {
    const id = sqlLanguageId(dialect);
    monaco.languages.register({ id, ...(id === "sql" ? { extensions: [".sql"], aliases: ["SQL"] } : {}) });
    monaco.languages.setLanguageConfiguration(id, {
      comments: { lineComment: "--", blockComment: ["/*", "*/"] },
      brackets: [["(", ")"]], autoClosingPairs: [{ open: "(", close: ")" }, { open: "'", close: "'", notIn: ["string", "comment"] }, { open: '"', close: '"', notIn: ["string", "comment"] }],
      surroundingPairs: [{ open: "(", close: ")" }, { open: "'", close: "'" }, { open: '"', close: '"' }],
      wordPattern: /[\p{L}_][\p{L}\p{N}_$#]*/u,
    });
    monaco.languages.setTokensProvider(id, sqlTokensProvider(dialect));
    monaco.languages.registerDocumentSemanticTokensProvider(id, sqlSemanticProvider());
  }
}

export function sqlThemeRules() {
  const style = getComputedStyle(document.documentElement);
  return SQL_HIGHLIGHT_KINDS.map(kind => ({ token: sqlTokenStyle(kind), foreground: style.getPropertyValue(`--sql-${kind}-color`).trim().replace(/^#/, "") || "808080", ...(kind === "comment" ? { fontStyle: "italic" } : {}) }));
}
