import { connOf, rtOf, sqlColumnEpoch } from "./dbStore";
import { sqlAssistColumns } from "./sqlAssistColumns";
import { connectionKey, type ResultExecutionContext } from "./dbResultContext";
import { sqlLanguageOf } from "./sqlFormat";
import { scanSql, sqlName } from "./sqlLex";
import { analyzeSql, type SqlAnalysis, type SqlSource } from "./sqlScope";
import { getSqlUsageEnabled, recordSqlUsage, sqlUsageKey, sqlUsageScope } from "./sqlUsage";
import { recordVerifiedSqlJoins, sqlJoinHistoryGeneration } from "./sqlJoinHistory";
import type { SqlBusinessColumn } from "./sqlBusiness";

export type VerifiedSqlSource = SqlSource & { table: string; tableRef: string };
const liveSchema = (connId: string) => rtOf(connId).currentSchema ?? rtOf(connId).info?.schema;

/** Explicit current-schema qualification names the same object; quoted names retain their case. */
export function sqlAssistObjectKey(source: SqlSource, schema?: string): string {
  const ref = source.tableRef ?? source.table ?? source.name;
  if (!source.schema || schema === undefined || source.schema.toLowerCase() !== schema.toLowerCase()) return ref;
  return /(?:"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[(?:[^\]]|\]\])*\]|[^.]+)$/.exec(ref)?.[0] ?? ref;
}

export function sqlAssistScope(connId: string | null | undefined): string | null {
  const conn = connOf(connId);
  return conn ? sqlUsageScope(connectionKey(conn), liveSchema(conn.id)) : null;
}

/** Only current physical metadata is evidence; CTE names and inferred outputs are not tables. */
export function verifiedSqlSource(connId: string, source: SqlSource, schema = liveSchema(connId)): VerifiedSqlSource | null {
  const conn = connOf(connId), rt = rtOf(connId);
  if (!conn || !source.table || schema !== liveSchema(connId)) return null;
  const dialect = sqlLanguageOf(conn.url), ref = source.tableRef ?? source.table;
  const scanned = scanSql(ref, dialect), parts = scanned.tokens.filter(t => t.kind !== "space");
  if (scanned.state.mode !== "plain" || !parts.length || parts.length > 3 || parts.some((t, i) => i % 2 ? t.text !== "." : !["identifier", "quoted"].includes(t.kind) && t.text.toUpperCase() !== "DUAL")) return null;
  const tableToken = parts[parts.length - 1], owner = parts.length === 3 ? parts[0] : undefined;
  if (owner && (schema === undefined || (owner.kind === "quoted" ? sqlName(owner) !== schema : sqlName(owner).toLowerCase() !== schema.toLowerCase()))) return null;
  const table = sqlName(tableToken);
  const matches = (name: string) => {
    if (tableToken.kind === "quoted") return name === table;
    // PostgreSQL mixed-case objects require quotes, even when a case-insensitive lookup would match.
    if (dialect === "postgresql") return name === table;
    if (dialect === "plsql") return name === table.toUpperCase();
    return name.toLowerCase() === table.toLowerCase();
  };
  const known = rt.tables?.some(t => matches(t.name)) || (tableToken.kind !== "quoted" && dialect !== "postgresql" && Object.keys(rt.schema?.tables ?? {}).some(name => name.toLowerCase() === table.toLowerCase()));
  return known ? { ...source, table, tableRef: ref, quoted: parts.some(t => t.kind === "quoted") } : null;
}

/** A delayed result must never train a newly selected database or schema. */
export function recordSqlExecutionUsage(identity: ResultExecutionContext, joinGeneration?: number, eventToken = String(identity.startedAt)): void {
  const conn = connOf(identity.connId);
  if (!conn || connectionKey(conn) !== identity.connectionKey || liveSchema(identity.connId) !== identity.schema) return;
  const analysis = analyzeSql(identity.sql, sqlLanguageOf(conn.url));
  const scope = sqlUsageScope(identity.connectionKey, identity.schema), recorded = new Set<string>(), verifiedSources: VerifiedSqlSource[] = [];
  if (joinGeneration !== undefined && joinGeneration !== sqlJoinHistoryGeneration(scope)) return;
  for (const query of analysis.scopes) for (const source of query.sources) {
    let next = source.declaration + 1;
    while (next < analysis.tokens.length && ["space", "comment", "hint"].includes(analysis.tokens[next].kind)) next++;
    if (analysis.tokens[next]?.text === ".") continue;
    const verified = verifiedSqlSource(identity.connId, source, identity.schema);
    if (!verified) continue;
    verifiedSources.push(verified);
    const object = sqlAssistObjectKey(verified, identity.schema);
    if (recorded.has(object)) continue;
    recorded.add(object);
    recordSqlUsage(scope, sqlUsageKey(object), "execute", eventToken);
  }
  if (getSqlUsageEnabled() && analysis.tokens.length <= 20000 && analysis.scopes.some(s => s.sources.length > 1)) {
    // Optional history work never delays successful query feedback or reports a query failure.
    void learnJoins(identity, scope, verifiedSources, analysis, joinGeneration ?? sqlJoinHistoryGeneration(scope), eventToken);
  }
}

async function learnJoins(identity: ResultExecutionContext, scope: string, sources: VerifiedSqlSource[], analysis: SqlAnalysis, generation: number, eventToken: string): Promise<void> {
  const unique = [...new Map(sources.map(s => [s.tableRef, s])).values()];
  if (unique.length < 2 || unique.length > 64 || unique.some(s => s.quoted)) return;
  const epoch = sqlColumnEpoch(identity.connId);
  const stillCurrent = () => sqlColumnEpoch(identity.connId) === epoch && connectionKey(connOf(identity.connId)) === identity.connectionKey && liveSchema(identity.connId) === identity.schema && sqlJoinHistoryGeneration(scope) === generation && getSqlUsageEnabled();
  const columns: Record<string, SqlBusinessColumn[]> = Object.create(null);
  let index = 0, failed = false;
  async function worker() {
    while (index < unique.length && !failed && stillCurrent()) {
      const source = unique[index++];
      try { columns[source.tableRef] = await sqlAssistColumns(identity.connId, source.tableRef, stillCurrent); }
      catch { failed = true; }
    }
  }
  await Promise.all([worker(), worker()]);
  if (!failed && stillCurrent() && sources.every(s => verifiedSqlSource(identity.connId, s, identity.schema)) && unique.every(s => columns[s.tableRef]?.length)) {
    recordVerifiedSqlJoins(scope, sources, columns, analysis, eventToken, generation);
  }
}
