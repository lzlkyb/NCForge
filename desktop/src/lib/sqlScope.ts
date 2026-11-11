import type { SqlLanguage } from "sql-formatter";
import { isSqlName, scanSql, sqlName, sqlReferenceKey, type SqlToken } from "./sqlLex";

export type SqlRole = "table" | "column" | "alias" | "cte" | "function";
export interface SqlSource { name: string; nameRef?: string; alias?: string; aliasRef?: string; table?: string; tableRef?: string; schema?: string; quoted?: boolean; columns?: string[]; declaration: number }
interface Cte { name: string; source: SqlSource; body: Region; visible: number; recursive: boolean }
interface Region { start: number; end: number; parent?: Region; indices: number[]; scopes: Scope[]; ctes: Cte[]; isolated: boolean }
interface Scope { start: number; end: number; select: number; indices: number[]; region: Region; sources: SqlSource[]; columns: string[] }
export interface SqlAnalysis { tokens: SqlToken[]; roles: Map<number, SqlRole>; scopes: Scope[]; regions: Region[]; dialect?: SqlLanguage }
const upper = (token?: SqlToken) => token?.text.toUpperCase() ?? "";
const QUERY = new Set(["SELECT", "UPDATE", "DELETE", "INSERT", "MERGE"]);
const STOP_FROM = new Set(["WHERE", "GROUP", "ORDER", "HAVING", "CONNECT", "START", "UNION", "MINUS", "INTERSECT", "EXCEPT", "SET", "VALUES", "RETURNING", "FETCH", "LIMIT", "OFFSET"]);
export const SQL_ANALYSIS_LIMIT = 200_000;
const SQL_SCOPE_LIMIT = 512;

/** Local, conservative query scopes. Unknown wildcard outputs stay unknown; no schema is guessed. */
export function analyzeSql(sql: string, dialect: SqlLanguage = "sql"): SqlAnalysis {
  const tokens = scanSql(sql, dialect).tokens, roles = new Map<number, SqlRole>();
  if (sql.length > SQL_ANALYSIS_LIMIT) return { tokens, roles, scopes: [], regions: [], dialect };
  const regions = regionsOf(tokens, sql.length), scopes: Scope[] = [];
  if (regions.reduce((count, region) => count + region.indices.filter(i => QUERY.has(upper(tokens[i]))).length, 0) > SQL_SCOPE_LIMIT) return { tokens, roles, scopes, regions: [], dialect };
  for (const region of regions) {
    const starts = region.indices.filter(i => QUERY.has(upper(tokens[i])));
    for (let n = 0; n < starts.length; n++) {
      const select = starts[n], next = starts[n + 1];
      // INSERT ... SELECT shares a region, but SELECT owns its FROM and projection.
      const end = next === undefined ? region.end : tokens[next].start;
      const indices = region.indices.filter(i => i >= select && (next === undefined || i < next));
      const branch = indices.find(i => ["UNION", "INTERSECT", "EXCEPT", "MINUS"].includes(upper(tokens[i])));
      const scope: Scope = { start: n === 0 ? region.start : tokens[select].start, end: branch === undefined ? end : tokens[branch].start, select, indices, region, sources: [], columns: [] };
      region.scopes.push(scope); scopes.push(scope);
    }
    readCtes(region, tokens, regions, roles);
  }
  // Inner outputs must exist before a derived table's outer projection is resolved.
  for (const scope of [...scopes].reverse()) {
    scope.columns = projectionOf(scope, tokens);
    scope.sources = sourcesOf(scope, tokens, regions, roles, dialect);
  }
  const analysis = { tokens, roles, scopes, regions, dialect };
  classifyReferences(analysis);
  return analysis;
}

function regionsOf(tokens: SqlToken[], length: number): Region[] {
  const make = (start: number, parent?: Region): Region => ({ start, end: length, parent, indices: [], scopes: [], ctes: [], isolated: false });
  let root = make(0), current = root;
  const regions = [root];
  tokens.forEach((token, i) => {
    if (["space", "string", "comment", "hint"].includes(token.kind)) return;
    if (token.text === ";") {
      if (current === root) { root.end = token.start; root = make(token.end); regions.push(root); current = root; }
      return;
    }
    if (token.text === ")" && current.parent) { current.end = token.start; current = current.parent; current.indices.push(i); return; }
    current.indices.push(i);
    if (token.text === "(") { current = make(token.end, current); regions.push(current); }
  });
  return regions;
}

function readCtes(region: Region, tokens: SqlToken[], regions: Region[], roles: Map<number, SqlRole>) {
  const ids = region.indices;
  let p = ids.findIndex(i => upper(tokens[i]) === "WITH");
  if (p < 0) return;
  p++;
  const recursive = upper(tokens[ids[p]]) === "RECURSIVE";
  if (recursive) p++;
  while (p < ids.length && isSqlName(tokens[ids[p]])) {
    const declaration = ids[p++], name = sqlName(tokens[declaration]);
    let columns: string[] | undefined;
    if (tokens[ids[p]]?.text === "(") {
      const list = regions.find(r => r.start === tokens[ids[p]].end);
      columns = list?.indices.filter(i => isSqlName(tokens[i])).map(i => sqlName(tokens[i]));
      p += 2;
    }
    if (upper(tokens[ids[p]]) !== "AS") break;
    p++;
    if (upper(tokens[ids[p]]) === "NOT") p++;
    if (upper(tokens[ids[p]]) === "MATERIALIZED") p++;
    const body = regions.find(r => r.start === tokens[ids[p]]?.end);
    if (!body) break;
    body.isolated = true;
    region.ctes.push({ name, body, recursive, visible: body.end, source: { name, nameRef: tokens[declaration].text, columns, declaration } });
    roles.set(declaration, "cte");
    p += 2;
    if (tokens[ids[p]]?.text !== ",") break;
    p++;
  }
}

function cteOf(region: Region, name: string, at: number, reference: string | undefined, dialect: SqlLanguage = "sql"): Cte | undefined {
  const key = sqlReferenceKey(name, reference, dialect);
  for (let r: Region | undefined = region; r; r = r.parent) {
    const cte = r.ctes.find(c => sqlReferenceKey(c.name, c.source.nameRef, dialect) === key && (at > c.visible || (c.recursive && at >= c.body.start && at <= c.body.end)));
    if (cte) return cte;
  }
  return undefined;
}

function projectionOf(scope: Scope, tokens: SqlToken[]): string[] {
  if (upper(tokens[scope.select]) !== "SELECT") return [];
  const items: number[][] = [[]];
  for (const i of scope.indices.slice(1)) {
    const token = tokens[i], word = upper(token);
    if (word === "FROM" || STOP_FROM.has(word)) break;
    if (word === "DISTINCT" || word === "ALL") continue;
    if (token.text === ",") items.push([]); else items[items.length - 1].push(i);
  }
  return [...new Set(items.flatMap(item => {
    const last = tokens[item[item.length - 1]], before = tokens[item[item.length - 2]];
    if (!isSqlName(last)) return [];
    const simple = item.every((i, n) => n % 2 === 0 ? isSqlName(tokens[i]) : tokens[i].text === ".");
    if (simple || upper(before) === "AS" || (before && (isSqlName(before) || before.text === ")" || before.kind === "number" || upper(before) === "END"))) return [sqlName(last)];
    return [];
  }))];
}

function sourcesOf(scope: Scope, tokens: SqlToken[], regions: Region[], roles: Map<number, SqlRole>, dialect: SqlLanguage): SqlSource[] {
  const sources: SqlSource[] = [], ids = scope.indices;
  let inFrom = false, expectSource = false, sourceClause = "";
  for (let p = 0; p < ids.length; p++) {
    const token = tokens[ids[p]], word = upper(token);
    if (STOP_FROM.has(word)) inFrom = false;
    if (["FROM", "JOIN", "UPDATE", "INTO"].includes(word)) { inFrom = word === "FROM" || inFrom; sourceClause = word; expectSource = true; continue; }
    if (inFrom && token.text === ",") { sourceClause = "FROM"; expectSource = true; continue; }
    if (!expectSource) continue;
    expectSource = false;
    let source: SqlSource;
    if (token.text === "(") {
      const body = regions.find(r => r.start === token.end);
      if (!body?.scopes.length) continue;
      body.isolated = true;
      source = { name: "", columns: body.scopes[0].columns, declaration: ids[p] };
      p++;
    } else if (isSqlName(token) || word === "DUAL") {
      let name = sqlName(token), declaration = ids[p], qualified = false;
      const parts = [token];
      while (tokens[ids[p + 1]]?.text === "." && isSqlName(tokens[ids[p + 2]])) { qualified = true; p += 2; parts.push(tokens[ids[p]]); name = sqlName(tokens[ids[p]]); declaration = ids[p]; }
      // Table-valued functions have unknown columns; don't request a physical table named like the function.
      if (["FROM", "JOIN"].includes(sourceClause) && tokens[ids[p + 1]]?.text === "(") { roles.set(declaration, "function"); p += 2; source = { name, columns: [], declaration }; }
      else {
        const cte = qualified ? undefined : cteOf(scope.region, name, token.start, token.text, dialect);
        source = cte ? { ...cte.source, columns: cte.source.columns ?? cte.body.scopes[0]?.columns ?? [], declaration } : { name, nameRef: tokens[declaration].text, table: name, tableRef: parts.map(t => t.kind === "quoted" ? t.text : sqlName(t)).join("."), schema: qualified ? sqlName(parts[parts.length - 2]) : undefined, quoted: parts.some(t => t.kind === "quoted"), declaration };
        roles.set(declaration, cte ? "cte" : "table");
      }
    } else continue;
    if (upper(tokens[ids[p + 1]]) === "AS") p++;
    if (isSqlName(tokens[ids[p + 1]])) { source.alias = sqlName(tokens[ids[++p]]); source.aliasRef = tokens[ids[p]].text; roles.set(ids[p], "alias"); }
    sources.push(source);
  }
  return sources;
}

export function sqlScopeAt(analysis: SqlAnalysis, offset: number): Scope | undefined {
  let found: Scope | undefined;
  for (const scope of analysis.scopes) if (scope.start <= offset && scope.end >= offset && (!found || scope.start >= found.start && scope.end <= found.end)) found = scope;
  return found;
}

/** Nearest aliases shadow outer aliases. Duplicate declarations are ambiguous and resolve to nothing. */
export function resolveSqlQualifier(analysis: SqlAnalysis, offset: number, qualifier: string, qualifierRef?: string): SqlSource | undefined {
  let scope = sqlScopeAt(analysis, offset);
  const key = sqlReferenceKey(qualifier, qualifierRef, analysis.dialect);
  while (scope) {
    const matches = scope.sources.filter(s => sqlReferenceKey(s.alias ?? s.name, s.aliasRef ?? s.nameRef, analysis.dialect) === key);
    if (matches.length) return matches.length === 1 ? matches[0] : undefined;
    let region: Region | undefined = scope.region;
    let parent: Scope | undefined;
    while (region?.parent && !parent && !region.isolated) { region = region.parent; parent = region.scopes.find(s => s.start <= offset && s.end >= offset); }
    scope = parent;
  }
  return undefined;
}

export function sqlSourcesAt(analysis: SqlAnalysis, offset: number): SqlSource[] {
  return sqlScopeAt(analysis, offset)?.sources ?? [];
}

export function sqlCtesAt(analysis: SqlAnalysis, offset: number): SqlSource[] {
  const visible = new Map<string, SqlSource>();
  for (let region = sqlScopeAt(analysis, offset)?.region; region; region = region.parent) {
    for (const cte of region.ctes) {
      const key = sqlReferenceKey(cte.name, cte.source.nameRef, analysis.dialect);
      if (!visible.has(key) && cteOf(region, cte.name, offset, cte.source.nameRef, analysis.dialect) === cte) visible.set(key, cte.source);
    }
  }
  return [...visible.values()];
}

function classifyReferences(analysis: SqlAnalysis) {
  const ids = analysis.tokens.flatMap((token, i) => ["space", "comment", "hint", "string"].includes(token.kind) ? [] : [i]);
  for (let p = 0; p < ids.length; p++) {
    const i = ids[p], token = analysis.tokens[i];
    if (!isSqlName(token) || analysis.roles.has(i)) continue;
    const next = analysis.tokens[ids[p + 1]], previous = analysis.tokens[ids[p - 1]];
    if (next?.text === "(" && !["TABLE", "VIEW", "INDEX", "CONSTRAINT"].includes(upper(previous))) { analysis.roles.set(i, "function"); continue; }
    if (next?.text === ".") {
      const source = resolveSqlQualifier(analysis, token.start, sqlName(token), token.text);
      if (source) analysis.roles.set(i, source.alias ? "alias" : source.table ? "table" : "cte");
      if (source && isSqlName(analysis.tokens[ids[p + 2]])) analysis.roles.set(ids[p + 2], "column");
    } else if (previous?.text !== ".") {
      const scope = sqlScopeAt(analysis, token.start);
      if (scope && (scope.sources.length === 1 || upper(previous) === "AS")) analysis.roles.set(i, "column");
    }
  }
}

/** Completion context uses the same lexer, so dots and FROM inside strings/comments cannot trigger metadata reads. */
export function sqlCompletionAt(analysis: SqlAnalysis, offset: number): { kind: "column" | "table" | "any" | "none"; qualifier?: string; qualifierRef?: string } {
  const hit = analysis.tokens.find(t => t.start < offset && t.end >= offset);
  if (hit && ["string", "comment", "hint", "parameter"].includes(hit.kind)) return { kind: "none" };
  const before = analysis.tokens.filter(t => t.start < offset && !["space", "comment", "hint"].includes(t.kind));
  if (isSqlName(before[before.length - 1]) && before[before.length - 1].end >= offset) before.pop();
  if (before[before.length - 1]?.text === "." && isSqlName(before[before.length - 2])) return { kind: "column", qualifier: sqlName(before[before.length - 2]), qualifierRef: before[before.length - 2].text };
  if (["FROM", "JOIN", "UPDATE", "INTO", "TABLE"].includes(upper(before[before.length - 1]))) return { kind: "table" };
  if (before[before.length - 1]?.text === ",") {
    const scope = sqlScopeAt(analysis, offset);
    const ids = scope?.indices.filter(i => analysis.tokens[i].start < offset) ?? [];
    const clause = [...ids].reverse().find(i => upper(analysis.tokens[i]) === "FROM" || STOP_FROM.has(upper(analysis.tokens[i])));
    if (clause !== undefined && upper(analysis.tokens[clause]) === "FROM") return { kind: "table" };
  }
  return { kind: "any" };
}
