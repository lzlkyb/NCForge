import { dbApi, type Cell, type ColumnInfo, type ExecResult } from "./dbApi";
import { columnsOf, rtOf } from "./dbStore";
import { sqlReferenceKey, sqlWordKind } from "./sqlLex";
import type { SqlLanguage } from "sql-formatter";
import { snippetEscape } from "./sqlTemplates";
import { sqlPredicates } from "./sqlPredicates";

export interface SqlBusinessSource { table: string; alias?: string; aliasRef?: string; name?: string; nameRef?: string; schema?: string; tableRef?: string; quoted?: boolean; declaration?: number }
export interface SqlBusinessColumn { name: string; type?: string }
export interface SqlBusinessRelation { id: string; source: string; target: string; from: string[]; to: string[]; kind: "外键" | "NC类引用" | "主子表" }
export interface SqlBusinessEnum { field: string; value: string | number; label: string }
export interface SqlBusinessMetadata { table: string; schema?: string; relations: SqlBusinessRelation[]; enums: SqlBusinessEnum[]; partial: boolean; sharedSession: boolean }
export interface BusinessSuggestion { label: string; insertText: string; documentation: string; reason: string; source: string; snippet?: boolean }
type Response = Awaited<ReturnType<typeof dbApi.relations>>;
const EMPTY = new Map<string, Promise<SqlBusinessMetadata | null>>();
/**
 * 已解析结果的同步副本。
 *
 * 补全列表里要给表名标一句「有没有关联」，这个判断必须**当场回答**——`EMPTY`
 * 里存的是 Promise，取不到值，而在补全里 await 一次关系查询会把 120ms 预算吃光。
 * 所以另存一份解析完成的快照，只读、不发起请求。
 */
const done = new Map<string, { value: SqlBusinessMetadata; at: number }>();
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
      void Promise.resolve().then(() => current && !current() ? null : dbApi.relations(connId, table, true)).then(async value => {
        const meta = !value || value.sharedSession || current && !current() ? null : sqlBusinessMetadata(table, value);
        finish(meta ? await withBodyRelations(connId, meta, (rtOf(connId).tables ?? []).map(t => t.name)) : null);
      }, () => finish(null)).finally(() => {
        active--; waiting.shift()?.run();
      });
    };
    if (active < 2) run();
    else if (waiting.length < MAX_QUEUE) waiting.push({ run, skip: () => finish(null) });
    else finish(null);
  });
  EMPTY.set(key, cached); ages.set(key, Date.now());
  // A full queue resolves synchronously, before the cache entry has been installed.
  void cached.then(value => {
    if (!value) { if (EMPTY.get(key) === cached) { EMPTY.delete(key); ages.delete(key); } return; }
    done.set(key, { value, at: Date.now() });
    while (done.size > MAX_CACHE) done.delete(done.keys().next().value!);
  });
  while (EMPTY.size > MAX_CACHE) { const oldest = EMPTY.keys().next().value!; EMPTY.delete(oldest); ages.delete(oldest); }
  return cached;
}

/**
 * 同步读**已解析**的业务元数据。只用于补全列表里的一句说明：
 * 没读到就返回 null，绝不在这里发起请求或等待。
 */
export function peekSqlBusinessMetadata(connId: string, scopeKey: string, table: string): SqlBusinessMetadata | null {
  const hit = done.get(JSON.stringify([connId, scopeKey, table.toLowerCase()]));
  return hit && Date.now() - hit.at < CACHE_TTL ? hit.value : null;
}

/** Invalidation also removes queued requests, avoiding obsolete schema reads on a later session. */
export function clearSqlBusinessCache(): void {
  EMPTY.clear(); ages.clear(); done.clear(); for (const queued of waiting.splice(0)) queued.skip();
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
/**
 * 第三类关系证据：主子表约定。NC 的表体（`_b`/`_body`/`_detail`/`_line`）是聚合关系，
 * 既没有声明外键也不是 md 类引用——只认前两类时真库上「主子表联查」永远空组，
 * 菜单标题承诺了却给不出。命名本身不是证据（约定可能撞名），**表体含主表全部主键列**
 * 才是：列名来自库的字段元数据，逐列核对后才合成关系。
 */
export async function withBodyRelations(connId: string, meta: SqlBusinessMetadata, available: readonly string[],
  read: (table: string) => Promise<ColumnInfo[]> = table => columnsOf(connId, table)): Promise<SqlBusinessMetadata> {
  const root = meta.table.toLowerCase();
  const candidates = available.map(t => t.toLowerCase())
    .filter(t => t.startsWith(root + "_") && /^(?:b\d*|body|details?|lines?)$/.test(t.slice(root.length + 1)))
    .slice(0, 4);
  if (!candidates.length) return meta;
  const rootColumns = await read(meta.table).catch(() => [] as ColumnInfo[]);
  const pk = rootColumns.filter(c => c.pk).map(c => c.name.toLowerCase());
  if (!pk.length) return meta;
  const extra: SqlBusinessRelation[] = [];
  const columnSets = await Promise.all(candidates.map(async t => [t, new Set((await read(t).catch(() => [] as ColumnInfo[])).map(c => c.name.toLowerCase()))] as const));
  for (const [candidate, names] of columnSets) {
    if (meta.relations.some(r => (r.source.toLowerCase() === candidate && r.target.toLowerCase() === root) || (r.source.toLowerCase() === root && r.target.toLowerCase() === candidate))) continue;
    if (!pk.every(p => names.has(p))) continue;
    extra.push({ id: `主子表:${candidate}`, source: candidate, target: root, from: pk, to: pk, kind: "主子表" });
  }
  return extra.length ? { ...meta, relations: [...extra, ...meta.relations] } : meta;
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

export function sqlRelatedQueries(metadata: SqlBusinessMetadata, names: Record<string, string>, upper: boolean, dialect: SqlLanguage): BusinessSuggestion[] {
  const root = metadata.table.toLowerCase();
  const kw = (text: string) => upper ? text : text.toLowerCase();
  const suggestions: BusinessSuggestion[] = [];
  for (const relation of metadata.relations) {
    const from = relation.source.toLowerCase(), to = relation.target.toLowerCase();
    const other = from === root ? to : to === root ? from : "";
    if (!other || other === root) continue;
    const sources = [{ table: root, alias: "a" }, { table: other, alias: "b" }];
    const [condition] = sqlJoinSuggestions({ ...metadata, relations: [relation] }, sources, "b", dialect);
    if (!condition) continue;
    const name = (table: string) => names[table] || table;
    const insertText = `${kw("SELECT")} a.*, b.*\n${kw("FROM")} ${ident(root, dialect)} a\n${kw("JOIN")} ${ident(other, dialect)} b ${kw("ON")} ${condition.insertText};`;
    if (suggestions.some(item => item.insertText === insertText)) continue;
    suggestions.push({ ...condition, label: `关联查询 · ${name(root)} + ${name(other)}`, insertText });
    if (suggestions.length === 5) break;
  }
  return suggestions;
}
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
  const bill = columns.find(c => same(c.name, "vbillcode"));
  if (bill) out.push({ label: "单据号过滤 · 填写单号", insertText: `${snippetEscape(`${q}.${ident(bill.name, dialect)}`)} = '$0'`, snippet: true,
    reason: "条件片段", source: `${source.table}.${bill.name} · 已读取字段`, documentation: "当前表已确认存在单据号字段。接受后直接在 SQL 的空引号中手工填写单号。" });
  const dr = columns.find(c => same(c.name, "dr") && c.type && numeric(c.type));
  if (dr) {
    const fn = dialect === "plsql" ? "nvl" : dialect === "tsql" ? "isnull" : "coalesce";
    const insertText = `${fn}(${q}.${ident(dr.name, dialect)}, 0) = 0`;
    out.push({ label: "有效数据 · 逻辑删除过滤", insertText, reason: "条件片段", source: `${source.table}.${dr.name} · 已读取字段`, documentation: `当前表已确认存在数值型 ${dr.name} 字段。\n请确认此表采用 0 表示有效的业务约定后接受。\n\n${insertText}` });
  }
  const org = columns.find(c => same(c.name, "pk_org"));
  const orgPredicate = org && sqlPredicates(`${q}.${ident(org.name, dialect)}`, org.type ?? "", dialect, false).find(p => p.operator === "=");
  if (org && orgPredicate) out.push({ label: "组织过滤 · 填写组织主键", insertText: orgPredicate.insertText, snippet: true, reason: "条件片段", source: `${source.table}.${org.name} · 已读取字段`, documentation: "当前表已确认存在组织字段。接受后直接在 SQL 中手工填写组织主键。" });
  return out;
}
