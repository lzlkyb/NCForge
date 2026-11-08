import type { DbTabItem } from "./dbStore";

export function persistentTab(tab: DbTabItem): Record<string, unknown> | null {
  if (tab.kind === "dict" || tab.kind === "compare") return null;
  if (tab.kind === "sql") {
    const { kind, id, title, connId, sql, maxRows, timeoutSec } = tab;
    return { kind, id, title, connId, sql, maxRows, timeoutSec };
  }
  const { query: _query, trail: _trail, ...saved } = tab;
  return saved;
}
export function persistentTabsChanged(before: DbTabItem[], after: DbTabItem[]): boolean {
  const a = before.filter(t => t.kind === "sql" || t.kind === "table"), b = after.filter(t => t.kind === "sql" || t.kind === "table");
  return a.length !== b.length || a.some((tab, i) => {
    if (tab === b[i]) return false;
    const x = persistentTab(tab)!, y = persistentTab(b[i])!;
    const keys = Object.keys(x);
    return keys.length !== Object.keys(y).length || keys.some(key => x[key] !== y[key]);
  });
}
