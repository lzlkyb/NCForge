import type { SqlLanguage } from "sql-formatter";
import { highlightedSql } from "./sqlHighlight";
import { SQL_ANALYSIS_LIMIT } from "./sqlScope";
// @ts-expect-error Monaco exposes the parser at runtime but ships no declaration for this module.
import { SnippetParser } from "monaco-editor/esm/vs/editor/contrib/snippet/browser/snippetParser.js";

export function sqlPreviewSnippet(snippet: string): string {
  return new SnippetParser().parse(snippet).toString();
}

export function sqlPreviewEdits(sql: string, start: number, end: number, edits: readonly { start: number; end: number; text: string }[]) {
  let offset = start, text = "";
  const highlights: { start: number; end: number }[] = [];
  for (const edit of [...edits].sort((a, b) => a.start - b.start)) {
    text += sql.slice(offset, edit.start);
    highlights.push({ start: text.length, end: text.length + edit.text.length });
    text += edit.text;
    offset = edit.end;
  }
  return { text: text + sql.slice(offset, end), highlights };
}

export function showSqlPreviewCode(code: HTMLElement, text: string, highlights: readonly { start: number; end: number }[] = [], dialect: SqlLanguage = "sql") {
  if (text.length > SQL_ANALYSIS_LIMIT) { code.textContent = text; return; }
  const doc = code.ownerDocument, content = doc.createDocumentFragment();
  for (const token of highlightedSql(text, dialect)) {
    const highlighted = highlights.some(range => token.start < range.end && token.end > range.start);
    const colored = token.kind !== "space" && token.kind !== "identifier";
    if (!colored && !highlighted) {
      content.append(token.text);
      continue;
    }
    const span = doc.createElement("span");
    if (colored) {
      span.dataset.sqlToken = token.kind;
      span.className = token.kind === "comment" ? "sql-token sql-comment" : "sql-token";
      span.style.setProperty("--sql-color", `var(--sql-${token.kind}-color)`);
    }
    if (highlighted) span.dataset.sqlChanged = "";
    span.textContent = token.text;
    content.append(span);
  }
  code.replaceChildren(content);
}
