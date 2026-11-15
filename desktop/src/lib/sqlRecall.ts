import { historyHits, type HistoryEntry } from "./dbHistory";
import { analyzeSql } from "./sqlScope";
import { queryParameters } from "./sqlQueryParameters";
import type { Snippet } from "./dbSnippets";

export type SqlRecallHit =
  | { kind: "history"; connId: string; entry: HistoryEntry; sql: string }
  | { kind: "snippet" | "template"; connId: string | null; entry: Snippet; sql: string };

export function recallSql(
  history: Readonly<Record<string, HistoryEntry[]>>, snippets: Snippet[],
  options: { connId: string; schema?: string; all: boolean; failed: boolean; query: string; names: Record<string, string> },
): SqlRecallHit[] {
  const { connId, schema, all, failed, query, names } = options;
  const hits: SqlRecallHit[] = historyHits(history, connId, all).filter(hit => !failed || !hit.entry.ok)
    .map(hit => ({ ...hit, kind: "history", sql: hit.entry.sql }));
  if (!failed) for (const entry of snippets) hits.push({
    kind: queryParameters(entry.sql).length ? "template" : "snippet", connId: entry.connId, entry, sql: entry.sql,
  });
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const businessWords = new Set(words.filter(word => Object.values(names).some(name => name.toLowerCase().includes(word))));
  const scope = (hit: SqlRecallHit) => hit.connId === connId
    ? hit.entry.schema !== undefined && hit.entry.schema !== schema ? 1 : 0
    : hit.connId === null ? 2 : 3;
  const priority = (hit: SqlRecallHit) => hit.kind === "history" ? hit.entry.pinned ? 0 : hit.entry.ok ? 2 : 3 : 1;
  return hits.filter(hit => {
    if (!words.length) return true;
    const title = hit.kind === "history" ? hit.entry.summary : hit.entry.name;
    const searchable = `${title}\n${hit.sql}`.toLowerCase();
    const missing = words.filter(word => !searchable.includes(word));
    if (!missing.length) return true;
    if (scope(hit) !== 0 || !missing.every(word => businessWords.has(word))) return false;
    const analysis = analyzeSql(hit.sql, "plsql");
    const businessNames = analysis.scopes.flatMap(s => s.sources).flatMap(source =>
      source.table && !source.quoted && (!source.schema || source.schema.toLowerCase() === schema?.toLowerCase())
        ? [names[source.table.toLowerCase()] ?? ""] : []).join(" ").toLowerCase();
    return missing.every(word => businessNames.includes(word));
  }).sort((a, b) => scope(a) - scope(b) || priority(a) - priority(b) || b.entry.at - a.entry.at);
}
