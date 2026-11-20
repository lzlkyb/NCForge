import { scanSql } from "./sqlLex";
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

export function showSqlPreviewCode(code: HTMLElement, text: string, highlights: readonly { start: number; end: number }[] = []) {
  const doc = code.ownerDocument, content = doc.createDocumentFragment();
  for (const token of scanSql(text).tokens) {
    const highlighted = highlights.some(range => token.start < range.end && token.end > range.start);
    const colored = ["keyword", "number", "string", "comment"].includes(token.kind);
    if (!colored && !highlighted) {
      content.append(token.text);
      continue;
    }
    const span = doc.createElement("span");
    if (colored) span.dataset.sqlToken = token.kind;
    if (highlighted) span.dataset.sqlChanged = "";
    span.textContent = token.text;
    content.append(span);
  }
  code.replaceChildren(content);
}
