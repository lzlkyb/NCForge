import { dbApi, type Cell, type ExecResult } from "./dbApi";
import { sqlReferenceKey, sqlWordKind } from "./sqlLex";
import type { SqlLanguage } from "sql-formatter";

export interface SqlBusinessSource { table: string; alias?: string; aliasRef?: string; name?: string; nameRef?: string; schema?: string; tableRef?: string; quoted?: boolean; declaration?: number }
export interface SqlBusinessColumn { name: string; type?: string }
export interface SqlBusinessRelation { id: string; source: string; target: string; from: string[]; to: string[]; kind: "外键" | "NC类引用" }
export interface SqlBusinessEnum { field: string; value: string | number; label: string }
export interface SqlBusinessMetadata { table: string; schema?: string; relations: SqlBusinessRelation[]; enums: SqlBusinessEnum[]; partial: boolean; sharedSession: boolean }
export interface BusinessSuggestion { label: string; insertText: string; documentation: string; reason: string; source: string; snippet?: boolean }
type Response = Awaited<ReturnType<typeof dbApi.relations>>;
const EMPTY = new Map<string, Promise<SqlBusinessMetadata | null>>();
const CACHE_TTL = 5 * 60_000, MAX_CACHE = 64, MAX_ROWS = 1000, MAX_QUEUE = 16;
const ages = new Map<string, number>();
const waiting: { run: () => void; skip: () => void }[] = [];
let active = 0;

/** Opaque scope includes connection identity and schema; callers discard stale model responses. */
export function readSqlBusinessMetadata(connId: string, scopeKey: string, table: string, current?: () => boolean): Promise<SqlBusinessMetadata | null> {
  // The endpoint operates on the current schema. Never silently strip a different owner.
  if (!/^[a-z_][\w$#]*$/i.test(table) || current && !current()) return Promise.resolve(null);
  const key = JSON.stringify([connId, scopeKey, table.toLowerCase()]);
  const old = EMPTY.get(key);
  if (old && Date.now() - (ages.get(key) ?? 0) < CACHE_TTL) return current ? old.then(value => current() ? value : null) : old;
  EMPTY.delete(key); ages.delete(key);
  const cached = new Promise<SqlBusinessMetadata | null>(resolve => {
    const finish = (value: SqlBusinessMetadata | null) => resolve(value);
    const run = () => {
      // A queued request still targets its original scope; don't query a switched session.
      if (current && !current()) { finish(null); waiting.shift()?.run(); return; }
      active++;
      // The isolated-only flag prevents completion from consuming the user's result cursor.
      void Promise.resolve().then(() => current && !current() ? null : dbApi.relations(connId, table, true)).then(value => finish(!value || value.sharedSession || current && !current() ? null : sqlBusinessMetadata(table, value)), () => finish(null)).finally(() => {
        active--; waiting.shift()?.run();
      });
    };
    if (active < 2) run();
    else if (waiting.length < MAX_QUEUE) waiting.push({ run, skip: () => finish(null) });
    else finish(null);
  });
  EMPTY.set(key, cached); ages.set(key, Date.now());
  // A full queue resolves synchronously, before the cache entry has been installed.
  void cached.then(value => { if (!value && EMPTY.get(key) === cached) { EMPTY.delete(key); ages.delete(key); } });
  while (EMPTY.size > MAX_CACHE) { const oldest = EMPTY.keys().next().value!; EMPTY.delete(oldest); ages.delete(oldest); }
  return cached;
}

/** Invalidation also removes queued requests, avoiding obsolete schema reads on a later session. */
export function clearSqlBusinessCache(): void {
  EMPTY.clear(); ages.clear(); for (const queued of waiting.splice(0)) queued.skip();
}

function cells(result?: ExecResult): { columns: string[]; rows: Cell[][] } | null {
  return result?.kind === "rows" && !result.hasMore && result.rows.length <= MAX_ROWS ? { columns: result.columns.map(c => c.name.toUpperCase()), rows: result.rows } : null;
}
function relations(result: ExecResult, kind: SqlBusinessRelation["kind"]): SqlBusinessRelation[] {
  const data = cells(result); if (!data) return [];
  const indices = ["RELATION", "SOURCE_TABLE", "SOURCE_COLUMN", "TARGET_TABLE", "TARGET_COLUMN", "POSITION"].map(n => data.columns.indexOf(n));
  if (indices.some(i => i < 0)) return [];
  const groups = new Map<string, { relation: SqlBusinessRelation; pairs: Map<number, [string, string]>; valid: boolean }>();
  for (const row of data.rows) {
    const [id, source, from, target, to] = indices.slice(0, 5).map(i => String(row[i] ?? ""));
    if (!id || !source || !target) continue;
    const key = JSON.stringify([id, source, target]);
    const g = groups.get(key) ?? { relation: { id: `${kind}:${id}`, source, target, from: [], to: [], kind }, pairs: new Map(), valid: true };
    const position = Number(row[indices[5]]), old = g.pairs.get(position);
    if (!from || !to || !Number.isInteger(position) || position < 1 || (old && (old[0] !== from || old[1] !== to))) g.valid = false;
    else g.pairs.set(position, [from, to]);
    groups.set(key, g);
  }
  return [...groups.values()].flatMap(g => {
    const pairs = [...g.pairs].sort((a, b) => a[0] - b[0]);
    if (!g.valid || !pairs.length || pairs.some(([position], i) => position !== i + 1)) return [];
    return [{ ...g.relation, from: pairs.map(p => p[1][0]), to: pairs.map(p => p[1][1]) }];
  });
}
export function sqlBusinessMetadata(table: string, value: Response): SqlBusinessMetadata {
  const data = cells(value.enums), enums: SqlBusinessEnum[] = [];
  const indices = ["FIELD", "ENUM_VALUE", "ENUM_LABEL"].map(n => data?.columns.indexOf(n) ?? -1);
  if (data && indices.every(i => i >= 0)) {
    for (const row of data.rows) {
      const field = row[indices[0]], val = row[indices[1]], label = row[indices[2]];
      if (typeof field === "string" && field && (typeof val === "string" || typeof val === "number") && typeof label === "string" && label) enums.push({ field, value: val, label });
    }
  }
  return { table, relations: [...relations(value.foreign, "外键"), ...relations(value.references, "NC类引用")], enums, partial: value.partial === true, sharedSession: value.sharedSession === true };
}
function ident(value: string, dialect: SqlLanguage): string {
  if (/^[\p{L}_][\p{L}\p{N}_$#]*$/u.test(value) && sqlWordKind(value, dialect) === "identifier") return value;
  return dialect === "mysql" || dialect === "mariadb" ? `\`${value.replace(/`/g, "``")}\`` : dialect === "tsql" ? `[${value.replace(/]/g, "]]")}]` : `"${value.replace(/"/g, '""')}"`;
}
function same(a: string, b: string): boolean { return a.toLowerCase() === b.toLowerCase(); }
function alias(source: SqlBusinessSource): string { return source.alias ?? source.name ?? source.table.split(".").pop()!; }
function qualifier(source: SqlBusinessSource, dialect: SqlLanguage): string { return source.aliasRef ?? (source.alias ? ident(source.alias, dialect) : source.nameRef ?? ident(alias(source), dialect)); }
function matches(source: SqlBusinessSource, table: string, metadata: SqlBusinessMetadata): boolean {
  const parts = source.table.split("."), owner = source.schema ?? (parts.length > 1 ? parts.slice(0, -1).join(".") : undefined);
  return (!owner || (!!metadata.schema && same(owner, metadata.schema))) && same(parts[parts.length - 1], table);
}

/** Multiple table instances require the newly joined alias, otherwise no relationship is guessed. */
export function sqlJoinSuggestions(metadata: SqlBusinessMetadata, sources: SqlBusinessSource[], joinedAlias?: string, dialect: SqlLanguage = "plsql"): BusinessSuggestion[] {
  if (metadata.sharedSession) return [];
  const key = (s: SqlBusinessSource) => sqlReferenceKey(alias(s), s.aliasRef ?? s.nameRef, dialect);
  const duplicates = new Set(sources.filter((s, i) => sources.some((other, n) => n !== i && key(s) === key(other))).map(key));
  const out: BusinessSuggestion[] = [];
  for (const r of metadata.relations) {
    const left = sources.filter(s => matches(s, r.source, metadata) && !duplicates.has(key(s)));
    const right = sources.filter(s => matches(s, r.target, metadata) && !duplicates.has(key(s)));
    const pairs = left.flatMap(a => right.filter(b => a !== b && (!joinedAlias || same(alias(a), joinedAlias) || same(alias(b), joinedAlias))).map(b => [a, b] as const));
    if (pairs.length !== 1 || !r.from.length || r.from.length !== r.to.length) continue;
    const [a, b] = pairs[0];
    const insertText = r.from.map((column, i) => `${qualifier(a, dialect)}.${ident(column, dialect)} = ${qualifier(b, dialect)}.${ident(r.to[i], dialect)}`).join(" and ");
    if (out.some(item => item.insertText === insertText)) continue;
    out.push({ label: `${alias(a)} → ${alias(b)} · ${r.kind}`, insertText, reason: r.kind, source: `${r.kind} · ${r.id.slice(r.kind.length + 1)}`, documentation: `${r.source} → ${r.target}\n${r.kind}明确声明 ${r.from.length} 个关联字段。\n\n${insertText}` });
  }
  return out;
}
const numeric = (type: string) => /^(?:NUMBER|NUMERIC|DECIMAL|INTEGER|INT|SMALLINT|BIGINT|TINYINT|FLOAT|DOUBLE|REAL|BINARY_FLOAT|BINARY_DOUBLE)(?:\b|\()/i.test(type.trim());
export function sqlEnumSuggestions(metadata: SqlBusinessMetadata, field: string, columnType: string): BusinessSuggestion[] {
  if (metadata.sharedSession || !columnType) return [];
  const entries = metadata.enums.filter(e => same(e.field, field));
  const out: BusinessSuggestion[] = [];
  for (const e of entries) {
    // Conflicting labels are not evidence for one unambiguous business value.
    if (entries.some(other => String(other.value) === String(e.value) && other.label !== e.label)) continue;
    const raw = String(e.value), insertText = numeric(columnType) ? /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw) ? raw : null : `'${raw.replace(/'/g, "''")}'`;
    if (insertText === null || out.some(item => item.insertText === insertText)) continue;
    out.push({ label: `${raw} · ${e.label}`, insertText, reason: "NC 枚举", source: `${metadata.table}.${e.field} · NC 枚举映射`, documentation: `${metadata.table}.${e.field}\n${e.label}（数据库值：${raw}）\n\n只插入当前值，不改变比较条件。` });
  }
  return out;
}
export function sqlConditionSuggestions(source: SqlBusinessSource, columns: SqlBusinessColumn[], dialect: SqlLanguage): BusinessSuggestion[] {
  const q = qualifier(source, dialect), out: BusinessSuggestion[] = [];
  const dr = columns.find(c => same(c.name, "dr") && c.type && numeric(c.type));
  if (dr) {
    const fn = dialect === "plsql" ? "nvl" : dialect === "tsql" ? "isnull" : "coalesce";
    const insertText = `${fn}(${q}.${ident(dr.name, dialect)}, 0) = 0`;
    out.push({ label: "有效数据 · 逻辑删除过滤", insertText, reason: "条件片段", source: `${source.table}.${dr.name} · 已读取字段`, documentation: `当前表已确认存在数值型 ${dr.name} 字段。\n请确认此表采用 0 表示有效的业务约定后接受。\n\n${insertText}` });
  }
  const org = columns.find(c => same(c.name, "pk_org"));
  if (org) out.push({ label: "组织过滤 · 填写组织主键", insertText: `${q}.${ident(org.name, dialect)} = \${1::pk_org}`, snippet: true, reason: "条件片段", source: `${source.table}.${org.name} · 已读取字段`, documentation: "当前表已确认存在组织字段。接受后填写组织主键参数，不沿用旧查询的组织值。" });
  return out;
}
