import type { DbState, DbTabItem } from "./dbStore";

export interface PendingDbSession {
  slot: string | null;
  tabId: string | null;
  label: string;
  statements: number;
}

/** primary 与 SQL 槽各是一条事务；多个标签引用同一槽时只提醒一次。 */
export function pendingDbSessions(db: Pick<DbState, "tabs" | "rt" | "active">, connId: string): PendingDbSession[] {
  const tabs = db.tabs.filter((t) => t.connId === connId);
  const sessions = new Map<string | null, PendingDbSession>();
  const primary = db.rt[connId]?.tx;
  if (primary && !primary.autoCommit && primary.statements > 0) {
    const owner = tabs.find((t) => t.kind === "table") ?? tabs.find((t) => t.kind === "sql" && !t.slot);
    sessions.set(null, { slot: null, tabId: owner?.id ?? null, label: "主会话", statements: primary.statements });
  }
  for (const t of tabs) {
    if (t.kind !== "sql" || !t.slot || !t.tx || t.tx.autoCommit || t.tx.statements <= 0) continue;
    if (!sessions.has(t.slot) || t.id === db.active) {
      sessions.set(t.slot, { slot: t.slot, tabId: t.id, label: `${t.title} · 独立会话 ${t.slot}`, statements: t.tx.statements });
    }
  }
  return [...sessions.values()];
}

export const dbTabId = (id: string) => `dbx-tab-${id}`;
export const dbPanelId = (id: string) => `dbx-panel-${id}`;
export const dbTabLabel = (tab: DbTabItem) => tab.kind === "table" ? tab.table.toLowerCase() : tab.title;
