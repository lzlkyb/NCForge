import type { FlatSymbol } from "./symbols";

const kinds = { endpoint: 201, component: 202, node: 203 };
const labels: Record<number, string> = { 201: "端点", 202: "组件", 203: "节点" };
export const ncDeclarationLabel = (kind: number): string | undefined => labels[kind];

export function isNcDeclaration(path: string): boolean {
  return /\.(?:rest|upm)$/i.test(path);
}

// Scan tags only. Comments, CDATA, quoted > signs and DOCTYPE subsets must not create phantom rows.
const markup = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE(?:[^"'[>]|"[^"]*"|'[^']*'|\[(?:[^\]"']|"[^"]*"|'[^']*')*\])*>|<\/?[\p{L}_][\p{L}\p{N}_.:-]*(?:[^"'<>]|"[^"]*"|'[^']*')*>/gu;

export function ncDeclarationOutline(text: string): FlatSymbol[] {
  if (!text.trimStart().startsWith("<")) return [];
  const nodes: FlatSymbol[] = [];
  const open: { tag: string; symbol?: FlatSymbol }[] = [];
  const ancestors: FlatSymbol[] = [];
  let offset = 0;
  let line = 1;
  let lineStart = 0;
  for (const match of text.matchAll(markup)) {
    while (offset < match.index) {
      if (text[offset++] === "\n") { line++; lineStart = offset; }
    }
    const token = match[0];
    const tag = /^<(\/?)([\p{L}_][\p{L}\p{N}_.:-]*)/u.exec(token);
    if (!tag) continue;
    const [, closing, qualified] = tag;
    if (closing) {
      const frame = open[open.length - 1];
      if (frame?.tag === qualified) {
        open.pop();
        if (frame.symbol) {
          frame.symbol.endLine = line;
          ancestors.pop();
        }
      }
      continue;
    }
    const local = qualified.slice(qualified.lastIndexOf(":") + 1);
    const kind = /^(?:rest)?endpoint$/i.test(local) ? kinds.endpoint
      : /^(?:upm)?component$/i.test(local) ? kinds.component : kinds.node;
    const attrs = new Map(Array.from(token.matchAll(/\s([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g),
      ([, key, double, single]) => [key.toLowerCase(), double ?? single]));
    const name = ["id", "xml:id", "name", "path", "uri", "service", "code"].map(key => attrs.get(key)?.trim()).find(Boolean);
    const symbol: FlatSymbol | undefined = !open.length || name || kind !== kinds.node
      ? { name: name || local, kind, depth: ancestors.length, container: ancestors.map(s => s.name).join("."),
          line, column: match.index - lineStart + 1, startLine: line, endLine: line }
      : undefined;
    if (symbol) nodes.push(symbol);
    if (!token.endsWith("/>")) {
      open.push({ tag: qualified, symbol });
      if (symbol) ancestors.push(symbol);
    } else if (symbol) {
      symbol.endLine += token.split("\n").length - 1;
    }
  }
  return nodes;
}
