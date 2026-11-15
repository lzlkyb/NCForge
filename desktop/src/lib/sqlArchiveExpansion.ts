import type { ColumnInfo } from "./dbApi";
import type { SqlBusinessMetadata, SqlBusinessRelation } from "./sqlBusiness";
import { isSqlName, scanSql, sqlName, sqlReferenceKey, type SqlToken } from "./sqlLex";
import { resolveSqlQualifier, sqlScopeAt, type SqlAnalysis, type SqlSource } from "./sqlScope";
import { sqlIdentifier } from "./sqlCompletionContext";

const plain = (name: string) => /^[a-z_][\w$#]*$/i.test(name) && (name === name.toUpperCase() || name === name.toLowerCase());
const usable = (name: string) => plain(name) && sqlIdentifier(name.toLowerCase(), "plsql") === name.toLowerCase();
const upper = (token?: SqlToken) => token?.text.toUpperCase();
const qualifier = (source: SqlSource) => source.aliasRef ?? source.nameRef ?? source.alias ?? source.name;
const boundary = new Set(["WHERE", "ORDER", "FETCH", "LIMIT", "OFFSET", "FOR"]);

export interface ArchiveProjection { start: number; end: number; joinAt: number }
export interface ArchiveExpansion { insertText: string; join?: { offset: number; text: string }; target: string; code: string; name: string }

function simpleProjection(tokens: SqlToken[]): boolean {
  const as = tokens.findIndex(t => upper(t) === "AS");
  const refs = as < 0 ? tokens : tokens.slice(0, as);
  if (as >= 0 && (as !== tokens.length - 2 || !isSqlName(tokens[as + 1]))) return false;
  return refs.length > 0 && refs.length % 2 === 1 && refs.every((t, i) => i % 2 === 0 ? isSqlName(t) || t.text === "*" && i === refs.length - 1 : t.text === ".");
}

/** Only a whole, direct SELECT operand can be expanded; expressions and grouped results stay intact. */
export function archiveProjectionAt(analysis: SqlAnalysis, start: number, end: number, source: SqlSource): ArchiveProjection | undefined {
  const scope = sqlScopeAt(analysis, start), tokens = analysis.tokens;
  // Nested SELECTs may be scalar / IN / quantified subqueries with a fixed output arity.
  if (!scope || scope.region.parent || upper(tokens[scope.select]) !== "SELECT" || !scope.sources.includes(source) || source.quoted || !source.table
    || !["SELECT", "WITH"].includes(upper(tokens[scope.region.indices[0]]) ?? "") || scope.region.scopes.some(s => upper(tokens[s.select]) !== "SELECT")) return;
  const ids = scope.indices, from = ids.findIndex(i => upper(tokens[i]) === "FROM");
  if (from < 0 || ids.slice(from).some(i => ["GROUP", "HAVING", "CONNECT", "START", "MODEL", "MATCH_RECOGNIZE", "PIVOT", "UNPIVOT"].includes(upper(tokens[i]) ?? ""))
    || scope.region.indices.some(i => ["UNION", "MINUS", "EXCEPT", "INTERSECT"].includes(upper(tokens[i]) ?? ""))) return;
  const items: SqlToken[][] = [[]];
  for (const i of ids.slice(1, from)) {
    if (tokens[i].text === ",") items.push([]); else items[items.length - 1].push(tokens[i]);
  }
  if (!items.every(simpleProjection)) return;
  const item = items.find(ts => ts.some(t => t.start === start && t.end === end));
  if (!item || ![1, 3].includes(item.length) || !isSqlName(item[item.length - 1]) || item[item.length - 1].start !== start) return;
  if (item.length === 3 && (item[1].text !== "." || resolveSqlQualifier(analysis, start, sqlName(item[0]), item[0].text) !== source)) return;
  const stop = ids.slice(from + 1).find(i => boundary.has(upper(tokens[i]) ?? ""));
  const joinAt = stop === undefined ? scope.end : tokens[stop].start;
  // A comma join and table hints have different binding rules; do not append a JOIN to them.
  if (ids.slice(from + 1).some(i => tokens[i].start < joinAt && (tokens[i].text === "," || ["WITH", "USING", "NATURAL", "APPLY", "TABLESAMPLE"].includes(upper(tokens[i]) ?? "")))) return;
  return { start: item[0].start, end: item[item.length - 1].end, joinAt };
}

/** Relation evidence must be outgoing and every physical object must be in the current inventory. */
export function archiveRelations(source: SqlSource, field: string, available: readonly string[], metadata: SqlBusinessMetadata | null): SqlBusinessRelation[] {
  if (!source.table || !usable(source.table) || !metadata || metadata.sharedSession || metadata.table.toLowerCase() !== source.table.toLowerCase()) return [];
  const known = (table: string) => available.filter(t => usable(t) && t.toLowerCase() === table.toLowerCase()).length === 1
    && available.some(t => t === t.toUpperCase() && t.toLowerCase() === table.toLowerCase());
  if (!known(source.table)) return [];
  const seen = new Set<string>();
  return metadata.relations.filter(r => {
    if (![r.source, r.target, ...r.from, ...r.to].every(usable) || r.source.toLowerCase() !== source.table!.toLowerCase() || !known(r.target)
      || !r.from.length || r.from.length !== r.to.length || !r.from.some(c => c.toLowerCase() === field.toLowerCase())
      || new Set(r.from.map(c => c.toLowerCase())).size !== r.from.length || new Set(r.to.map(c => c.toLowerCase())).size !== r.to.length) return false;
    const key = JSON.stringify([r.target.toLowerCase(), r.from.map((c, i) => [c.toLowerCase(), r.to[i].toLowerCase()]).sort()]);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

function displayColumn(columns: readonly ColumnInfo[], role: "code" | "name"): ColumnInfo | undefined {
  const suffix = role === "code" ? "编码" : "名称";
  const described = columns.filter(c => [c.zh, c.comment].some(text => text?.trim().endsWith(suffix)));
  // Use actual metadata descriptions first, then conventional exact names; multiple matches are ambiguous.
  const candidates = described.length ? described : columns.filter(c => (role === "code" ? ["code", "vcode"] : ["name", "vname"]).includes(c.name.toLowerCase()));
  return candidates.length === 1 && usable(candidates[0].name) ? candidates[0] : undefined;
}

const canonical = (ts: SqlToken[]) => ts.map(t => isSqlName(t) ? sqlReferenceKey(sqlName(t), t.text, "plsql") : t.text.toUpperCase()).join(" ");
function existingJoin(analysis: SqlAnalysis, at: number, source: SqlSource, relation: SqlBusinessRelation): SqlSource | undefined {
  const scope = sqlScopeAt(analysis, at)!;
  return scope.sources.find(s => {
    if (s === source || s.quoted || s.schema !== source.schema || s.table?.toLowerCase() !== relation.target.toLowerCase()) return false;
    const p = scope.indices.indexOf(s.declaration), ts = scope.indices.map(i => analysis.tokens[i]);
    if (upper(ts[p - 1]) !== "JOIN" || !(["LEFT"].includes(upper(ts[p - 2]) ?? "") || upper(ts[p - 2]) === "OUTER" && upper(ts[p - 3]) === "LEFT")) return false;
    const on = ts.findIndex((t, i) => i > p && upper(t) === "ON"), next = ts.findIndex((t, i) => i > p && ["JOIN", "LEFT", "RIGHT", "FULL", "INNER", "CROSS", ...boundary].includes(upper(t) ?? ""));
    if (on < 0 || next >= 0 && on >= next) return false;
    const actual = ts.slice(on + 1, next < 0 ? undefined : next);
    const condition = relation.from.map((c, i) => `${qualifier(source)}.${c.toLowerCase()} = ${qualifier(s)}.${relation.to[i].toLowerCase()}`).join(" AND ");
    return canonical(actual) === canonical(scanSql(condition, "plsql").tokens.filter(t => t.kind !== "space"));
  });
}

export function archiveExpansion(analysis: SqlAnalysis, projection: ArchiveProjection, source: SqlSource, field: ColumnInfo, sourceColumns: readonly ColumnInfo[], relation: SqlBusinessRelation, targetColumns: readonly ColumnInfo[], keywordUpper: boolean): ArchiveExpansion | undefined {
  // Oracle dictionary case distinguishes normal uppercase columns from quoted lowercase objects.
  const has = (columns: readonly ColumnInfo[], name: string) => {
    const matches = columns.filter(c => c.name.toLowerCase() === name.toLowerCase());
    return matches.length === 1 && usable(matches[0].name) && matches[0].name === matches[0].name.toUpperCase();
  };
  if (field.name !== field.name.toUpperCase() || !has(sourceColumns, field.name) || !relation.from.some(c => c.toLowerCase() === field.name.toLowerCase())) return;
  const keys = targetColumns.filter(c => c.pk);
  // Complete declared PK coverage proves at most one target row; a partial composite key cannot do that.
  if (!keys.length || keys.length !== relation.to.length || !keys.every(c => relation.to.some(key => key.toLowerCase() === c.name.toLowerCase()))
    || !relation.from.every((c, i) => has(sourceColumns, c) && has(targetColumns, relation.to[i]))) return;
  const code = displayColumn(targetColumns, "code"), name = displayColumn(targetColumns, "name");
  if (!code || !name || code === name || code.name !== code.name.toUpperCase() || name.name !== name.name.toUpperCase() || !has(targetColumns, code.name) || !has(targetColumns, name.name)) return;
  const used = new Set(analysis.scopes.flatMap(s => s.sources.map(v => sqlReferenceKey(v.alias ?? v.name, v.aliasRef ?? v.nameRef, "plsql"))));
  const existing = existingJoin(analysis, projection.start, source, relation);
  let alias = existing ? qualifier(existing) : "ref1", n = 1;
  while (!existing && used.has(sqlReferenceKey(alias, undefined, "plsql"))) alias = `ref${++n}`;
  const outputNames = new Set([...sqlScopeAt(analysis, projection.start)!.columns, ...sourceColumns.map(c => c.name)].map(n => n.toLowerCase()));
  const output = (role: string) => {
    const base = `${field.name.toLowerCase()}_${role}`;
    let result = base, n = 1;
    while (outputNames.has(result)) result = `${base}_${++n}`;
    outputNames.add(result); return result;
  };
  const kw = (s: string) => keywordUpper ? s : s.toLowerCase();
  const insertText = `${qualifier(source)}.${field.name.toLowerCase()},\n    ${alias}.${code.name.toLowerCase()} ${kw("AS")} ${output("code")},\n    ${alias}.${name.name.toLowerCase()} ${kw("AS")} ${output("name")}`;
  const join = existing ? undefined : { offset: projection.joinAt, text: `\n${kw("LEFT JOIN")} ${relation.target.toLowerCase()} ${alias}\n    ${kw("ON")} ${relation.from.map((c, i) => `${qualifier(source)}.${c.toLowerCase()} = ${alias}.${relation.to[i].toLowerCase()}`).join(` ${kw("AND")} `)}\n` };
  return { insertText, join, target: relation.target.toLowerCase(), code: code.name.toLowerCase(), name: name.name.toLowerCase() };
}
