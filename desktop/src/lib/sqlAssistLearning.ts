import { connOf, rtOf, sqlColumnEpoch } from "./dbStore";
import { sqlAssistColumns } from "./sqlAssistColumns";
import { connectionKey, type ResultExecutionContext } from "./dbResultContext";
import { sqlLanguageOf } from "./sqlFormat";
import { isSqlName, scanSql, sqlName, sqlReferenceKey, type SqlToken } from "./sqlLex";
import { analyzeSql, resolveSqlQualifier, sqlScopeAt, type SqlAnalysis, type SqlSource } from "./sqlScope";
import { sqlClauseKeyword, type SqlClause } from "./sqlCompletionContext";
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
  if (!conn || !getSqlUsageEnabled() || connectionKey(conn) !== identity.connectionKey || liveSchema(identity.connId) !== identity.schema) return;
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
  if (verifiedSources.length && analysis.tokens.length <= 20000) {
    // Metadata learning runs independently from the query result and reuses the editor's column cache.
    void learnFieldsAndJoins(identity, scope, verifiedSources, analysis, joinGeneration ?? sqlJoinHistoryGeneration(scope), eventToken);
  }
}

interface FieldCandidate { token: SqlToken; clause: SqlClause; sources: VerifiedSqlSource[] }

function executionFields(analysis: SqlAnalysis, sources: VerifiedSqlSource[]): FieldCandidate[] {
  const verified = new Map(sources.filter(s => !s.quoted).map(s => [s.declaration, s]));
  const significant = analysis.tokens.flatMap((token, index) => ["space", "comment", "hint"].includes(token.kind) ? [] : [index]);
  const contexts = new Map(analysis.scopes.map(query => [query, { clause: "other" as SqlClause, cursor: 0, aliases: new Set<string>() }]));
  const candidates: FieldCandidate[] = [];
  for (let p = 0; p < significant.length; p++) {
    const index = significant[p], token = analysis.tokens[index], role = analysis.roles.get(index);
    if (!isSqlName(token) || role && role !== "column") continue;
    const query = sqlScopeAt(analysis, token.start);
    if (!query) continue;
    const state = contexts.get(query)!;
    while (query.indices[state.cursor] < index) {
      const word = analysis.tokens[query.indices[state.cursor++]].text;
      state.clause = sqlClauseKeyword(word) ?? state.clause;
    }
    const clause = state.clause;
    if (clause === "other" || clause === "insert") continue;
    const previous = analysis.tokens[significant[p - 1]], next = analysis.tokens[significant[p + 1]];
    const asAlias = previous?.text.toUpperCase() === "AS";
    const implicitAlias = previous && (isSqlName(previous) || ["string", "number", "parameter"].includes(previous.kind)
      || [")", "END", "NULL", "TRUE", "FALSE"].includes(previous.text.toUpperCase()));
    const reference = sqlReferenceKey(sqlName(token), token.text, analysis.dialect);
    if (clause === "select" && query.indices[state.cursor] === index && (asAlias || implicitAlias)) {
      state.aliases.add(reference);
      continue;
    }
    if (next?.text === "." || asAlias || previous?.text === "::") continue;
    if (previous?.text === ".") {
      const qualifier = analysis.tokens[significant[p - 2]], owner = analysis.tokens[significant[p - 3]];
      if (!isSqlName(qualifier) || owner?.text === ".") continue;
      const source = resolveSqlQualifier(analysis, token.start, sqlName(qualifier), qualifier.text);
      const physical = source && verified.get(source.declaration);
      if (physical) candidates.push({ token, clause, sources: [physical] });
    } else {
      if ((clause === "order" || clause === "group") && state.aliases.has(reference)) continue;
      // An unqualified field is safe only when all sources can be checked for ambiguity.
      const physical = query.sources.flatMap(source => verified.get(source.declaration) ?? []);
      if (physical.length && physical.length === query.sources.length) candidates.push({ token, clause, sources: physical });
    }
  }
  return candidates;
}

async function learnFieldsAndJoins(identity: ResultExecutionContext, scope: string, sources: VerifiedSqlSource[], analysis: SqlAnalysis, generation: number, eventToken: string): Promise<void> {
  const unique = [...new Map(sources.map(s => [s.tableRef, s])).values()];
  if (unique.length > 64) return;
  const learnJoins = unique.length >= 2 && unique.every(s => !s.quoted) && analysis.scopes.some(s => s.sources.length > 1);
  const fields = executionFields(analysis, sources);
  const needed = new Set(fields.flatMap(field => field.sources.map(s => s.tableRef)));
  const requested = learnJoins ? unique : unique.filter(s => needed.has(s.tableRef));
  if (!requested.length) return;
  const epoch = sqlColumnEpoch(identity.connId);
  const stillCurrent = () => sqlColumnEpoch(identity.connId) === epoch && connectionKey(connOf(identity.connId)) === identity.connectionKey && liveSchema(identity.connId) === identity.schema && sqlJoinHistoryGeneration(scope) === generation && getSqlUsageEnabled();
  const columns: Record<string, SqlBusinessColumn[]> = Object.create(null);
  let index = 0;
  async function worker() {
    while (index < requested.length && stillCurrent()) {
      const source = requested[index++];
      try { columns[source.tableRef] = await sqlAssistColumns(identity.connId, source.tableRef, stillCurrent); }
      catch { /* A missing column list prevents verification for that source. */ }
    }
  }
  await Promise.all([worker(), worker()]);
  if (!stillCurrent() || !sources.every(s => verifiedSqlSource(identity.connId, s, identity.schema))) return;
  if (learnJoins && unique.every(s => columns[s.tableRef]?.length)) {
    recordVerifiedSqlJoins(scope, sources, columns, analysis, eventToken, generation);
  }
  const keys = new Set<string>();
  const checked = new Set<string>();
  for (const { token, clause, sources: candidates } of fields) {
    // Very wide generated queries should leave room for intentional choices in the memory store.
    if (keys.size >= 128) break;
    if (candidates.some(s => !columns[s.tableRef]?.length)) continue;
    const name = sqlName(token);
    const identity = JSON.stringify([token.kind, name, clause, candidates.map(source => source.tableRef)]);
    if (checked.has(identity)) continue;
    checked.add(identity);
    const matches = (column: string) => token.kind === "quoted" || analysis.dialect === "postgresql" ? column === name
      : analysis.dialect === "plsql" ? column === name.toUpperCase() : column.toLowerCase() === name.toLowerCase();
    const resolved = candidates.flatMap(source => columns[source.tableRef].filter(c => matches(c.name)).map(c => ({ source, name: c.name })));
    if (resolved.length !== 1) continue;
    const field = resolved[0], mixed = /[a-z]/.test(field.name) && /[A-Z]/.test(field.name);
    if (analysis.dialect === "plsql" && token.kind === "quoted" && !mixed && field.name !== field.name.toUpperCase()) continue;
    keys.add(sqlUsageKey(field.source.table, mixed ? field.name : field.name.toLowerCase(), clause));
  }
  for (const key of keys) recordSqlUsage(scope, key, "execute", eventToken);
}
