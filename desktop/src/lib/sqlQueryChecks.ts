import type { ColumnInfo } from "./dbApi";
import type { BillQueryRelation } from "./sqlBillTemplates";
import type { SqlBusinessMetadata, SqlBusinessRelation } from "./sqlBusiness";
import { isSqlName, scanSql, sqlName, sqlWordKind, type SqlToken } from "./sqlLex";
import { analyzeSql, resolveSqlQualifier, type SqlSource } from "./sqlScope";
import { isPlsql, splitStatements } from "./sqlSplit";

export interface SqlQueryCheckContext {
  tables: readonly string[];
  columns: Readonly<Partial<Record<string, readonly ColumnInfo[]>>>;
  names?: Readonly<Record<string, string>>;
  schema?: string;
  upper?: boolean;
}
export interface SqlQueryCheckTemplate {
  label: string;
  hint: string;
  sql: string;
  scope: "whole-table";
  kind: "missing-related" | "orphan-related" | "duplicate-combination" | "detail-summary" | "detail-count";
  root: string;
  related?: string;
  hadWhere?: boolean;
}
export interface SelectedQueryFields {
  source: SqlSource;
  table: string;
  start: number;
  end: number;
  fieldNames: string[];
  fieldRefs: string[];
  hadWhere: boolean;
}
interface TableColumns { table: string; columns: readonly ColumnInfo[] }
interface VerifiedRelation { root: TableColumns; other: TableColumns; rootColumns: string[]; otherColumns: string[]; source: string }
const upper = (token?: SqlToken) => token?.text.toUpperCase() ?? "";
const normal = (name: string) => /^[a-z_][\w$#]*$/i.test(name) && (name === name.toUpperCase() || name === name.toLowerCase()) && sqlWordKind(name, "plsql") === "identifier";
const same = (a: string, b: string) => a.toUpperCase() === b.toUpperCase();
const keyword = (context: SqlQueryCheckContext) => (text: string) => context.upper === false ? text.toLowerCase() : text;
const display = (table: string, context: SqlQueryCheckContext) => context.names?.[table.toLowerCase()] ?? context.names?.[table] ?? table;
const physicalType = (column: ColumnInfo) => (column.full || column.type || "").trim();
const numericType = (type: string) => /^(?:NUMBER|FLOAT|BINARY_FLOAT|BINARY_DOUBLE)(?:\s*\(|$)/i.test(type);
const groupableType = (type: string) => numericType(type)
  || /^(?:CHAR|NCHAR|VARCHAR2|NVARCHAR2)(?:\s*\(|$)|^DATE$|^TIMESTAMP(?:\s*\(\d+\))?(?:\s+WITH(?:\s+LOCAL)?\s+TIME\s+ZONE)?$/i.test(type);
const fieldHint = "请在普通 SELECT 中选中同一物理表的完整字段，多个字段用逗号分隔";

/** Parse before fetching metadata, but do not infer real column names from SQL spelling. */
export function selectedQueryFields(sql: string, start: number, end: number): SelectedQueryFields {
  if (start < 0 || end > sql.length || start >= end) throw new Error(fieldHint);
  const statement = splitStatements(sql).find(s => s.start <= start && s.end >= end);
  if (!statement || isPlsql(statement.text)) throw new Error(fieldHint);
  const text = sql.slice(statement.start, statement.end), scanned = scanSql(text, "plsql");
  if (scanned.state.mode !== "plain") throw new Error(fieldHint);
  const analysis = analyzeSql(text, "plsql"), scope = analysis.scopes.find(s => !s.region.parent);
  const tokens = analysis.tokens, significant = scanned.tokens.filter(t => !["space", "comment", "hint"].includes(t.kind));
  if (!scope || upper(significant[0]) !== "SELECT" || upper(tokens[scope.select]) !== "SELECT"
    || scope.region.ctes.length || scope.region.scopes.length !== 1
    || scope.indices.some(i => ["DISTINCT", "ALL", "GROUP", "HAVING", "UNION", "INTERSECT", "EXCEPT", "MINUS", "CONNECT", "START", "PIVOT", "UNPIVOT", "MODEL", "INTO"].includes(upper(tokens[i])))) throw new Error(fieldHint);
  const from = scope.indices.findIndex(i => upper(tokens[i]) === "FROM");
  if (from < 0 || !scope.sources.length) throw new Error(fieldHint);
  const items: SqlToken[][] = [[]];
  for (const i of scope.indices.slice(1, from)) {
    if (tokens[i].text === ",") items.push([]); else items[items.length - 1].push(tokens[i]);
  }
  const trimmedStart = start + (sql.slice(start, end).match(/^\s*/)?.[0].length ?? 0);
  const trimmedEnd = end - (sql.slice(start, end).match(/\s*$/)?.[0].length ?? 0);
  const localStart = trimmedStart - statement.start, localEnd = trimmedEnd - statement.start;
  const selected = items.filter(item => item.length && item[0].start >= localStart && item[item.length - 1].end <= localEnd);
  // A projection item includes its qualifier, expression and alias; selecting only a piece is unsafe.
  const last = selected[selected.length - 1];
  if (!selected.length || selected[0][0].start !== localStart || last[last.length - 1]?.end !== localEnd) throw new Error(fieldHint);
  const selectionTokens = tokens.filter(t => t.start >= localStart && t.end <= localEnd && !["space", "comment", "hint"].includes(t.kind));
  if (selectionTokens.length !== selected.reduce((n, item) => n + item.length, selected.length - 1)) throw new Error(fieldHint);
  let source: SqlSource | undefined;
  const fields: SqlToken[] = [];
  for (const item of selected) {
    if (!(item.length === 1 && item[0].kind === "identifier")
      && !(item.length === 3 && isSqlName(item[0]) && item[1].text === "." && item[2].kind === "identifier")) throw new Error(fieldHint);
    const column = item[item.length - 1];
    const resolved = item.length === 3 ? resolveSqlQualifier(analysis, column.start, sqlName(item[0]), item[0].text)
      : scope.sources.length === 1 ? scope.sources[0] : undefined;
    if (!resolved?.table || resolved.quoted || !normal(resolved.table) || source && source !== resolved) throw new Error(fieldHint);
    source = resolved; fields.push(column);
  }
  return { source: source!, table: source!.table!, start: trimmedStart, end: trimmedEnd,
    fieldNames: fields.map(sqlName), fieldRefs: selected.map(item => text.slice(item[0].start, item[item.length - 1].end)),
    hadWhere: scope.indices.some(i => upper(tokens[i]) === "WHERE") };
}

function actualTable(table: string, context: SqlQueryCheckContext): TableColumns | undefined {
  if (!normal(table)) return undefined;
  const matches = context.tables.filter(t => same(t, table));
  if (matches.length !== 1 || matches[0] !== matches[0].toUpperCase() || !normal(matches[0])) return undefined;
  const keys = Object.keys(context.columns).filter(k => same(k, table));
  const columns = keys.length === 1 ? context.columns[keys[0]] : undefined;
  return columns?.length ? { table: matches[0], columns } : undefined;
}
function actualColumn(table: TableColumns, field: string): ColumnInfo | undefined {
  if (!normal(field)) return undefined;
  const matches = table.columns.filter(c => same(c.name, field));
  return matches.length === 1 && matches[0].name === matches[0].name.toUpperCase() && normal(matches[0].name) ? matches[0] : undefined;
}
function selectedActual(sql: string, start: number, end: number, context: SqlQueryCheckContext): { selection: SelectedQueryFields; table: TableColumns; fields: ColumnInfo[] } {
  const selection = selectedQueryFields(sql, start, end), table = actualTable(selection.table, context);
  if (selection.source.schema && (!context.schema || !normal(selection.source.schema) || !same(selection.source.schema, context.schema))) throw new Error("请使用当前 schema 中已确认的物理表字段");
  const fields = table && selection.fieldNames.map(name => actualColumn(table, name));
  if (!table || !fields || fields.some(c => !c)) throw new Error("缺少唯一的大写 Oracle 表或字段元数据，请先加载表结构");
  if (new Set(fields.map(c => c!.name)).size !== fields.length) throw new Error("选中的字段组合有重复字段，请每个字段只保留一次");
  return { selection, table, fields: fields as ColumnInfo[] };
}
function verifiedRelation(root: string, relation: BillQueryRelation, context: SqlQueryCheckContext): VerifiedRelation | undefined {
  const a = actualTable(root, context), b = actualTable(relation.table, context);
  if (!a || !b || !relation.rootColumns.length || relation.rootColumns.length !== relation.otherColumns.length) return undefined;
  const rootFields = relation.rootColumns.map(c => actualColumn(a, c)), otherFields = relation.otherColumns.map(c => actualColumn(b, c));
  // NC references can name large objects: require scalar keys for Oracle equality and grouping.
  if ([...rootFields, ...otherFields].some(c => !c || !groupableType(physicalType(c)))) return undefined;
  const rootColumns = rootFields.map(c => c!.name), otherColumns = otherFields.map(c => c!.name);
  if (new Set(rootColumns).size !== rootColumns.length || new Set(otherColumns).size !== otherColumns.length) return undefined;
  return { root: a, other: b, rootColumns, otherColumns, source: relation.source };
}
function uniqueAlias(base: string, occupied: Set<string>): string {
  let name = base.slice(0, 30), suffix = 2;
  while (occupied.has(name)) { const tail = `_${suffix++}`; name = base.slice(0, 30 - tail.length) + tail; }
  occupied.add(name); return name;
}

export function buildBillRelationChecks(root: string, relations: readonly BillQueryRelation[], context: SqlQueryCheckContext): SqlQueryCheckTemplate[] {
  const kw = keyword(context), out: SqlQueryCheckTemplate[] = [], seen = new Set<string>();
  for (const relation of relations) {
    const r = verifiedRelation(root, relation, context);
    if (!r) continue;
    const pairs = r.rootColumns.map((c, i) => `b.${r.otherColumns[i]} = a.${c}`).join(` ${kw("AND")} `);
    if (seen.has(`${r.other.table}:${pairs}`)) continue;
    seen.add(`${r.other.table}:${pairs}`);
    const rootName = display(r.root.table, context), otherName = display(r.other.table, context);
    out.push({ label: `${rootName} · 没有关联行 ${otherName}（全表）`, hint: `${r.source} · 全表检查主表没有任何匹配关联行的记录`, scope: "whole-table", kind: "missing-related", root: r.root.table, related: r.other.table,
      sql: `${kw("SELECT")} a.*\n${kw("FROM")} ${r.root.table} a\n${kw("WHERE NOT EXISTS")} (\n    ${kw("SELECT")} 1\n    ${kw("FROM")} ${r.other.table} b\n    ${kw("WHERE")} ${pairs}\n);` });
    const notNull = r.otherColumns.map(c => `b.${c} ${kw("IS NOT NULL")}`).join(` ${kw("AND")} `);
    out.push({ label: `${otherName} · 找不到 ${rootName}（全表，关联键非 NULL）`, hint: `${r.source} · 全表检查关联记录；排除任一关联键为 NULL 的行`, scope: "whole-table", kind: "orphan-related", root: r.root.table, related: r.other.table,
      sql: `${kw("SELECT")} b.*\n${kw("FROM")} ${r.other.table} b\n${kw("WHERE")} ${notNull}\n  ${kw("AND NOT EXISTS")} (\n    ${kw("SELECT")} 1\n    ${kw("FROM")} ${r.root.table} a\n    ${kw("WHERE")} ${pairs}\n);` });
  }
  return out;
}

export function buildDuplicateCombinationCheck(sql: string, start: number, end: number, context: SqlQueryCheckContext): SqlQueryCheckTemplate {
  const { selection, table, fields } = selectedActual(sql, start, end, context), kw = keyword(context);
  if (fields.some(c => !groupableType(physicalType(c)))) throw new Error("重复组合检查只支持已确认可分组的 Oracle 字符、数值、DATE 或 TIMESTAMP 字段；大对象、二进制、对象或未知类型暂不支持");
  const refs = fields.map(c => `a.${c.name}`).join(", "), count = uniqueAlias("DUPLICATE_COUNT", new Set(fields.map(c => c.name)));
  return { label: `${display(table.table, context)} · 检查字段组合重复（全表）`, hint: `全表按 ${fields.map(c => c.name).join(" + ")} 分组；原 SELECT 的 WHERE 条件不带入`,
    scope: "whole-table", kind: "duplicate-combination", root: table.table, hadWhere: selection.hadWhere,
    sql: `${kw("SELECT")} ${refs}, ${kw("COUNT")}(*) ${kw("AS")} ${count}\n${kw("FROM")} ${table.table} a\n${kw("GROUP BY")} ${refs}\n${kw("HAVING COUNT")}(*) > 1;` };
}

function directedRelations(root: string, metadata: SqlBusinessMetadata | null, context: SqlQueryCheckContext, incoming: boolean): VerifiedRelation[] {
  if (!metadata || metadata.sharedSession || !normal(metadata.table) || !same(metadata.table, root)) return [];
  if (metadata.schema && (!context.schema || !same(metadata.schema, context.schema))) return [];
  return metadata.relations.flatMap((r: SqlBusinessRelation) => {
    if (![r.source, r.target].every(normal) || !same(incoming ? r.target : r.source, root)) return [];
    const parent = incoming ? root : r.target, child = incoming ? r.source : root;
    const relation = verifiedRelation(parent, { table: child, rootColumns: r.to, otherColumns: r.from, source: `${r.kind} · ${r.id.slice(r.kind.length + 1)}` }, context);
    if (!relation) return [];
    // Only a complete declared parent PK proves that each child group matches one parent row.
    const pk = relation.root.columns.filter(c => c.pk);
    return pk.length && pk.length === relation.rootColumns.length && pk.every(c => actualColumn(relation.root, c.name) && relation.rootColumns.includes(c.name)) ? [relation] : [];
  });
}
function summaryTemplate(r: VerifiedRelation, fields: readonly ColumnInfo[], context: SqlQueryCheckContext, hadWhere?: boolean): SqlQueryCheckTemplate {
  const kw = keyword(context), occupied = new Set([...r.root.columns.map(c => c.name), ...r.otherColumns]);
  const count = uniqueAlias("DETAIL_COUNT", occupied), sums = fields.map(c => uniqueAlias(`SUM_${c.name}`, occupied));
  const metrics = [count, ...sums], inner = [`${kw("COUNT")}(*) ${kw("AS")} ${count}`, ...fields.map((c, i) => `${kw("SUM")}(c.${c.name}) ${kw("AS")} ${sums[i]}`)];
  const group = r.otherColumns.map(c => `c.${c}`).join(", "), pairs = r.rootColumns.map((c, i) => `d.${r.otherColumns[i]} = p.${c}`).join(` ${kw("AND")} `);
  const label = `${display(r.root.table, context)} · ${fields.length ? "汇总明细" : "明细行数"} ${display(r.other.table, context)}（全表）`;
  return { label, hint: `${r.source} · 完整主键 ${r.rootColumns.join(" + ")}；明细先聚合，每张主表一行，无明细为 0；原 WHERE 条件不带入`,
    scope: "whole-table", kind: fields.length ? "detail-summary" : "detail-count", root: r.root.table, related: r.other.table, hadWhere,
    sql: `${kw("SELECT")} p.*,\n       ${metrics.map(c => `${kw("NVL")}(d.${c}, 0) ${kw("AS")} ${c}`).join(",\n       ")}\n${kw("FROM")} ${r.root.table} p\n${kw("LEFT JOIN")} (\n    ${kw("SELECT")} ${group},\n           ${inner.join(",\n           ")}\n    ${kw("FROM")} ${r.other.table} c\n    ${kw("GROUP BY")} ${group}\n) d\n    ${kw("ON")} ${pairs};` };
}
function uniqueSummaries(relations: VerifiedRelation[], fields: readonly ColumnInfo[], context: SqlQueryCheckContext, hadWhere?: boolean): SqlQueryCheckTemplate[] {
  const seen = new Set<string>();
  return relations.flatMap(r => {
    const key = JSON.stringify([r.root.table, r.other.table, r.rootColumns.map((c, i) => [c, r.otherColumns[i]]).sort()]);
    if (seen.has(key)) return [];
    seen.add(key); return [summaryTemplate(r, fields, context, hadWhere)];
  }).slice(0, 8);
}

export function buildDetailSummaryChecks(sql: string, start: number, end: number, metadata: SqlBusinessMetadata | null, context: SqlQueryCheckContext): SqlQueryCheckTemplate[] {
  const { selection, table, fields } = selectedActual(sql, start, end, context);
  if (fields.some(c => !numericType(physicalType(c)))) throw new Error("明细汇总只支持已确认的 Oracle 数值字段");
  return uniqueSummaries(directedRelations(table.table, metadata, context, false), fields, context, selection.hadWhere);
}

export function buildIncomingDetailCountChecks(root: string, metadata: SqlBusinessMetadata | null, context: SqlQueryCheckContext): SqlQueryCheckTemplate[] {
  return uniqueSummaries(directedRelations(root, metadata, context, true), [], context);
}
