import type { SqlLanguage } from "sql-formatter";
import type { BusinessSuggestion, SqlBusinessColumn, SqlBusinessSource } from "./sqlBusiness";
import { isSqlName, sqlName, sqlReferenceKey, sqlWordKind, type SqlToken } from "./sqlLex";
import { resolveSqlQualifier, sqlScopeAt, type SqlAnalysis, type SqlSource } from "./sqlScope";
import { getSqlUsageEnabled } from "./sqlUsage";

type Columns = Record<string, SqlBusinessColumn[]>;
interface JoinEntry { left: string; right: string; from: string[]; to: string[]; count: number; score: number; lastUsed: number }
interface Store { version: 1; scopes: Record<string, JoinEntry[]> }
const STORAGE_KEY = "ncforge-sql-join-history", DAY = 86400000, HALF_LIFE = 14 * DAY, MAX_AGE = 180 * DAY;
const MAX_PER_SCOPE = 50, MAX_TOTAL = 500;
let cache: Store | null = null;
const seen = new Map<string, number>(), generations = new Map<string, number>();
const validScope = (scope: string) => scope.length > 0 && scope.length <= 512 && !["__proto__", "constructor", "prototype"].includes(scope);
const validName = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256;
const keyOf = (entry: Pick<JoinEntry, "left" | "right" | "from" | "to">) => JSON.stringify([entry.left, entry.right, entry.from, entry.to]);
const decay = (entry: JoinEntry, now: number) => entry.score * Math.pow(.5, Math.max(0, now - entry.lastUsed) / HALF_LIFE);

function validEntry(value: unknown): value is JoinEntry {
  if (!value || typeof value !== "object") return false;
  const e = value as JoinEntry;
  return validName(e.left) && validName(e.right) && e.left !== e.right && Array.isArray(e.from) && Array.isArray(e.to)
    && e.from.length > 0 && e.from.length <= 16 && e.from.length === e.to.length && e.from.every(validName) && e.to.every(validName)
    && Number.isInteger(e.count) && e.count > 0 && e.count <= 1000000 && Number.isFinite(e.score) && e.score > 0 && e.score <= 10000
    && Number.isFinite(e.lastUsed) && e.lastUsed > 0 && e.lastUsed <= Date.now() + DAY;
}
function trim(store: Store): Store {
  const now = Date.now(), records = Object.entries(store.scopes).flatMap(([scope, entries]) => entries.filter(e => now - e.lastUsed < MAX_AGE).map(entry => ({ scope, entry })));
  records.sort((a, b) => decay(b.entry, now) - decay(a.entry, now) || b.entry.lastUsed - a.entry.lastUsed);
  const scopes: Record<string, JoinEntry[]> = {};
  let kept = 0;
  for (const { scope, entry } of records) {
    if (kept >= MAX_TOTAL) break;
    const list = scopes[scope] ??= [];
    if (list.length >= MAX_PER_SCOPE || list.some(old => keyOf(old) === keyOf(entry))) continue;
    list.push(entry); kept++;
  }
  return { version: 1, scopes };
}
function read(): Store {
  if (cache) return cache = trim(cache);
  cache = { version: 1, scopes: {} };
  try {
    const data: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!data || typeof data !== "object" || (data as Store).version !== 1) return cache;
    const scopes = (data as Store).scopes;
    if (!scopes || typeof scopes !== "object" || Array.isArray(scopes)) return cache;
    cache = trim({ version: 1, scopes: Object.fromEntries(Object.entries(scopes).filter(([scope, values]) => validScope(scope) && Array.isArray(values)).map(([scope, values]) => [scope, values.filter(validEntry).map(e => ({ left: e.left, right: e.right, from: e.from, to: e.to, count: e.count, score: e.score, lastUsed: e.lastUsed }))])) });
  } catch { /* Preference corruption must not interrupt SQL editing. */ }
  return cache;
}
function save(store: Store): boolean {
  cache = trim(store);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cache)); return true; }
  catch { return false; }
}
function schemaOfScope(scope: string): string {
  try { const value: unknown = JSON.parse(scope); return Array.isArray(value) && typeof value[1] === "string" ? value[1].toLowerCase() : ""; }
  catch { return ""; }
}
function physical(source: SqlBusinessSource, scope: string): string {
  if (source.quoted) return source.tableRef ?? source.table;
  const table = source.tableRef ?? source.table;
  return (table.includes(".") ? table : `${source.schema ?? schemaOfScope(scope)}.${table}`).toLowerCase();
}
function columnList(source: SqlBusinessSource, sources: SqlBusinessSource[], columns: Columns, scope: string): SqlBusinessColumn[] {
  const full = physical(source, scope), base = source.table.split(".").pop()!;
  const names = [source.tableRef, full, source.table];
  if (new Set(sources.filter(s => s.table.split(".").pop()!.toLowerCase() === base.toLowerCase()).map(s => physical(s, scope))).size === 1) names.push(base);
  // Qualified and unqualified identities never share a basename cache across owners.
  for (const name of names) if (name && Object.prototype.hasOwnProperty.call(columns, name)) {
    if (name === base && !name.includes(".") && new Set(sources.filter(s => s.table.split(".").pop()!.toLowerCase() === base.toLowerCase()).map(s => physical(s, scope))).size > 1) continue;
    return columns[name];
  }
  return [];
}
function fieldOf(token: SqlToken, columns: SqlBusinessColumn[]): string | undefined {
  const name = sqlName(token), matches = columns.filter(c => token.kind === "quoted" ? c.name === name : c.name.toLowerCase() === name.toLowerCase());
  return matches.length === 1 ? matches[0].name : undefined;
}
function verifiedSource(resolved: SqlSource, sources: SqlBusinessSource[], scope: string): SqlBusinessSource | undefined {
  if (!resolved.table) return undefined;
  const candidates = sources.filter(s => physical(s, scope) === physical({ ...resolved, table: resolved.table! }, scope)
    && (s.declaration !== undefined ? s.declaration === resolved.declaration : (s.alias ?? s.name ?? s.table) === (resolved.alias ?? resolved.name)));
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** Only invoke after a successful execution, using that execution's frozen scope and metadata. */
export function recordVerifiedSqlJoins(scopeKey: string, sources: SqlBusinessSource[], columnsByTable: Columns, analysis: SqlAnalysis, eventToken?: string, expectedGeneration?: number): number {
  if (!getSqlUsageEnabled() || !validScope(scopeKey) || expectedGeneration !== undefined && expectedGeneration !== sqlJoinHistoryGeneration(scopeKey)) return 0;
  // Learning is optional; unusually large scripts must not slow successful execution feedback.
  if (analysis.tokens.length > 20000) return 0;
  const tokens = analysis.tokens.filter(t => !["space", "comment", "hint"].includes(t.kind));
  const groups = new Map<string, { left: string; right: string; pairs: Map<string, [string, string]>; valid: boolean }>();
  let comparisons = 0;
  for (let p = 0; p + 6 < tokens.length; p++) {
    const [a, dotA, fieldA, eq, b, dotB, fieldB] = tokens.slice(p, p + 7);
    if (!isSqlName(a) || dotA.text !== "." || !isSqlName(fieldA) || eq.text !== "=" || !isSqlName(b) || dotB.text !== "." || !isSqlName(fieldB)) continue;
    if (++comparisons > 256) return 0;
    if (tokens[p - 1]?.text === "." || tokens[p + 7]?.kind === "operator" && ![")", ";", ","].includes(tokens[p + 7].text) || ["+", "-", "*", "/", "||", "::"].includes(tokens[p - 1]?.text)) continue;
    const query = sqlScopeAt(analysis, eq.start);
    if (!query) continue;
    const before = query.indices.map(i => analysis.tokens[i]).filter(t => t.start < eq.start);
    const clause = [...before].reverse().find(t => ["ON", "WHERE", "HAVING", "SELECT", "FROM", "JOIN", "SET"].includes(t.text.toUpperCase()));
    if (!clause || !["ON", "WHERE"].includes(clause.text.toUpperCase())) continue;
    const end = query.indices.map(i => analysis.tokens[i]).find(t => t.start > clause.start && ["ON", "WHERE", "HAVING", "GROUP", "ORDER", "JOIN"].includes(t.text.toUpperCase()))?.start ?? query.end;
    if (tokens.some(t => t.start >= clause.start && t.start < end && t.kind === "keyword" && ["OR", "NOT", "CASE", "WHEN", "FALSE"].includes(t.text.toUpperCase()))) continue;
    const resolvedA = resolveSqlQualifier(analysis, eq.start, sqlName(a), a.text), resolvedB = resolveSqlQualifier(analysis, eq.start, sqlName(b), b.text);
    if (!resolvedA || !resolvedB || resolvedA === resolvedB) continue;
    let sourceA = verifiedSource(resolvedA, sources, scopeKey), sourceB = verifiedSource(resolvedB, sources, scopeKey);
    if (!sourceA || !sourceB || physical(sourceA, scopeKey) === physical(sourceB, scopeKey)) continue;
    let columnA = fieldOf(fieldA, columnList(sourceA, sources, columnsByTable, scopeKey)), columnB = fieldOf(fieldB, columnList(sourceB, sources, columnsByTable, scopeKey));
    if (physical(sourceA, scopeKey) > physical(sourceB, scopeKey)) { [sourceA, sourceB] = [sourceB, sourceA]; [columnA, columnB] = [columnB, columnA]; }
    const left = physical(sourceA, scopeKey), right = physical(sourceB, scopeKey);
    const groupKey = JSON.stringify([clause.start, sourceA.declaration ?? sourceA.alias, sourceB.declaration ?? sourceB.alias, left, right]);
    const group = groups.get(groupKey) ?? { left, right, pairs: new Map(), valid: true };
    // An incompletely verified composite association must not become a smaller association.
    if (!columnA || !columnB) group.valid = false;
    else group.pairs.set(JSON.stringify([columnA, columnB]), [columnA, columnB]);
    groups.set(groupKey, group);
  }
  const store = read(), entries = [...(store.scopes[scopeKey] ?? [])], now = Date.now();
  let learned = 0;
  for (const group of groups.values()) {
    if (!group.valid || !group.pairs.size || group.pairs.size > 16) continue;
    const pairs = [...group.pairs.values()].sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
    const identity = { left: group.left, right: group.right, from: pairs.map(p => p[0]), to: pairs.map(p => p[1]) };
    const key = keyOf(identity), stamp = JSON.stringify([scopeKey, key, eventToken ?? ""]), prior = seen.get(stamp);
    if (prior !== undefined && (eventToken !== undefined || now - prior < 30000)) continue;
    seen.set(stamp, now); while (seen.size > 1000) seen.delete(seen.keys().next().value!);
    const index = entries.findIndex(e => keyOf(e) === key), old = entries[index];
    const entry = { ...identity, count: Math.min(1000000, (old?.count ?? 0) + 1), score: Math.min(10000, (old ? decay(old, now) : 0) + 1), lastUsed: now };
    if (index >= 0) entries[index] = entry; else entries.push(entry);
    learned++;
  }
  if (learned) save({ ...store, scopes: { ...store.scopes, [scopeKey]: entries } });
  return learned;
}
function ident(value: string, dialect: SqlLanguage): string {
  if (/^[\p{L}_][\p{L}\p{N}_$#]*$/u.test(value) && value === value.toLowerCase() && sqlWordKind(value, dialect) === "identifier") return value;
  return dialect === "mysql" || dialect === "mariadb" ? `\`${value.replace(/`/g, "``")}\`` : dialect === "tsql" ? `[${value.replace(/]/g, "]]")}]` : `"${value.replace(/"/g, '""')}"`;
}
export function sqlHistoricalJoinSuggestions(scopeKey: string, sources: SqlBusinessSource[], columnsByTable: Columns, dialect: SqlLanguage = "plsql"): BusinessSuggestion[] {
  if (!validScope(scopeKey) || !getSqlUsageEnabled()) return [];
  const now = Date.now(), out: BusinessSuggestion[] = [];
  for (const entry of [...(read().scopes[scopeKey] ?? [])].filter(e => e.count >= 2).sort((a, b) => decay(b, now) - decay(a, now))) {
    const left = sources.filter(s => physical(s, scopeKey) === entry.left), right = sources.filter(s => physical(s, scopeKey) === entry.right);
    if (left.length !== 1 || right.length !== 1) continue;
    const aliasA = left[0].alias ?? left[0].name ?? left[0].table.split(".").pop()!, aliasB = right[0].alias ?? right[0].name ?? right[0].table.split(".").pop()!;
    const key = (s: SqlBusinessSource) => sqlReferenceKey(s.alias ?? s.name ?? s.table.split(".").pop()!, s.aliasRef ?? s.nameRef, dialect);
    if (sources.filter(s => key(s) === key(left[0])).length !== 1 || sources.filter(s => key(s) === key(right[0])).length !== 1) continue;
    const colsA = columnList(left[0], sources, columnsByTable, scopeKey), colsB = columnList(right[0], sources, columnsByTable, scopeKey);
    if (!entry.from.every(name => colsA.some(c => c.name === name)) || !entry.to.every(name => colsB.some(c => c.name === name))) continue;
    const qualifierA = left[0].aliasRef ?? (left[0].alias ? ident(aliasA, dialect) : left[0].nameRef ?? ident(aliasA, dialect));
    const qualifierB = right[0].aliasRef ?? (right[0].alias ? ident(aliasB, dialect) : right[0].nameRef ?? ident(aliasB, dialect));
    const insertText = entry.from.map((name, i) => `${qualifierA}.${ident(name, dialect)} = ${qualifierB}.${ident(entry.to[i], dialect)}`).join(" and ");
    if (out.some(s => s.insertText === insertText)) continue;
    out.push({ label: `${aliasA} ↔ ${aliasB} · 历史写法`, insertText, reason: "历史写法", source: `本机成功执行 ${entry.count} 次 · 字段已复核`, documentation: `你在当前数据库和 schema 的成功查询中重复使用过此关联。\n这是历史写法，请确认业务含义后接受。\n\n${insertText}` });
    if (out.length >= 10) break;
  }
  return out;
}
export function sqlJoinHistoryGeneration(scopeKey: string): number { return generations.get(scopeKey) ?? 0; }
export function snapshotSqlJoinHistory(scopeKey: string): () => boolean {
  const snapshot = read().scopes[scopeKey] ?? [];
  return () => {
    const store = read();
    const current = store.scopes[scopeKey] ?? [];
    const keys = new Set(current.map(keyOf));
    return save({ ...store, scopes: { ...store.scopes, [scopeKey]: [...current, ...snapshot.filter(entry => !keys.has(keyOf(entry)))] } });
  };
}
export function clearSqlJoinHistory(scopeKey: string): boolean {
  if (!validScope(scopeKey)) return false;
  generations.set(scopeKey, sqlJoinHistoryGeneration(scopeKey) + 1);
  const store = read(), scopes = { ...store.scopes }; delete scopes[scopeKey];
  for (const stamp of [...seen.keys()]) if ((JSON.parse(stamp) as string[])[0] === scopeKey) seen.delete(stamp);
  return save({ version: 1, scopes });
}
