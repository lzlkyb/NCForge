import type { DbState, DbTabItem } from "./dbStore";
import { txPending } from "./txState";

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
  // 判据统一走 `txPending`：后端核对过（`tx.active`）就以 `v$transaction` 为准，
  // 本地 `statements` 只是 DML 计数，手写 COMMIT / PL/SQL 内部提交不会让它归零。
  if (primary && txPending(primary).pending) {
    const owner = tabs.find((t) => t.kind === "table") ?? tabs.find((t) => t.kind === "sql" && !t.slot);
    sessions.set(null, { slot: null, tabId: owner?.id ?? null, label: "主会话", statements: primary.statements });
  }
  for (const t of tabs) {
    if (t.kind !== "sql" || !t.slot || !txPending(t.tx).pending) continue;
    if (!sessions.has(t.slot) || t.id === db.active) {
      sessions.set(t.slot, { slot: t.slot, tabId: t.id, label: `${t.title} · 独立会话 ${t.slot}`, statements: t.tx?.statements ?? 0 });
    }
  }
  return [...sessions.values()];
}

export const dbTabId = (id: string) => `dbx-tab-${id}`;
export const dbPanelId = (id: string) => `dbx-panel-${id}`;
export const dbTabLabel = (tab: DbTabItem) => tab.kind === "table" ? tab.table.toLowerCase() : tab.title;
