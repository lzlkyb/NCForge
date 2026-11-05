import { javaTreeMembers } from "./javaTreeMembers";
import { isNcDeclaration, ncDeclarationOutline } from "./ncDeclarationOutline";
import type { FlatSymbol } from "./symbols";

const MAX_OUTLINE_CHARS = 512 * 1024;

export function localDocumentOutline(path: string, text: string): FlatSymbol[] {
  if (text.length > MAX_OUTLINE_CHARS) return [];
  if (isNcDeclaration(path)) return ncDeclarationOutline(text);
  if (!/\.java$/i.test(path)) return [];

  const containers = new Map<string, string>();
  return javaTreeMembers(path, text).map(row => {
    const container = containers.get(row.parent) ?? "";
    containers.set(row.id, container ? `${container}.${row.name}` : row.name);
    return { ...row, container, startLine: row.line };
  });
}
