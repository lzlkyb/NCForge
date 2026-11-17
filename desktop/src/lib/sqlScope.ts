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

/** 光标处的通配投影（`SELECT *` 或 `SELECT m.*`）。 */
export interface SqlWildcard {
  /** `*` 在 token 表里的下标。 */
  token: number;
  /** `别名.*` 里的别名原文。 */
  qualifier?: string;
  /** 展开后该去哪张表取字段；多表无别名时为 undefined。 */
  source?: SqlSource;
}

/**
 * 某个 `*` token 是不是一个**可展开**的通配投影。
 *
 * 抽出来的原因：同一个判据现在有三处消费方——右键动作 `ncforge.sql.expandStar`、
 * 表名旁的 chip（都走 `sqlWildcardAt`），以及补全列表的关键词直搜
 * （`sqlWildcardInScope`）。三处标准一旦分叉，就会出现「列表给了动作、
 * 点了却提示请把光标放在 * 上」这种自相矛盾。
 *
 * `m.* / 2` 这种乘法、`SELECT a, * FROM` 之外的半截投影都不算：展开会改坏语句。
 */
function wildcardOf(analysis: SqlAnalysis, token: number): SqlWildcard | undefined {
  const hit = analysis.tokens[token];
  if (!hit || hit.text !== "*") return undefined;
  // 取 token 自身的起点当锚点：判据只看 token 落在哪个 scope、前后邻居是谁，
  // 与光标相距多远无关。用 token.start 而不是外部传入的 offset，是为了让
  // 「光标压在 * 上」和「* 在光标所在语句里」两条路径走完全相同的判定。
  const offset = hit.start;
  const scope = sqlScopeAt(analysis, offset);
  if (!scope || !scope.indices.includes(token)) return undefined;
  if (upper(analysis.tokens[scope.select]) !== "SELECT") return undefined;
  // 投影区里的 `*` 不会出现在 FROM 之后；出现就是别的东西。
  if (scope.indices.some(i => i < token && upper(analysis.tokens[i]) === "FROM")) return undefined;
  const ids = scope.indices, at = ids.indexOf(token);
  const dot = analysis.tokens[ids[at - 1]], alias = analysis.tokens[ids[at - 2]];
  const qualified = dot?.text === "." && isSqlName(alias);
  const before = analysis.tokens[ids[at - (qualified ? 3 : 1)]], after = analysis.tokens[ids[at + 1]];
  // 通配符必须占满整个投影项：前面是 SELECT/DISTINCT/ALL/逗号，后面是 FROM/逗号/分号。
  if (!["SELECT", "DISTINCT", "ALL", ","].includes(upper(before))) return undefined;
  if (after && !["FROM", ",", ";"].includes(after.text.toUpperCase())) return undefined;
  const source = qualified ? resolveSqlQualifier(analysis, offset, sqlName(alias), alias.text)
    : scope.sources.length === 1 ? scope.sources[0] : undefined;
  return { token, qualifier: qualified ? alias.text : undefined, source };
}

/**
 * 光标是否压在一个**可展开**的 `*` 上：`SELECT *` / `SELECT m.*`，且独占一个投影项。
 */
export function sqlWildcardAt(analysis: SqlAnalysis, offset: number): SqlWildcard | undefined {
  const token = analysis.tokens.findIndex(t => t.text === "*" && t.start <= offset && t.end >= offset);
  return token < 0 ? undefined : wildcardOf(analysis, token);
}

/**
 * 光标所在语句里那个**唯一**的可展开 `*`。
 *
 * 补全列表的关键词直搜（打 `exp`）走这里：用户站在 WHERE 里想「把上面那个 `*`
 * 展开」，光标不可能同时压在 `*` 上。**多个 `*` 就不猜**——猜错一次要撤销一整段投影，
 * 而多表语句里 `*` 各展开成哪张表的字段，位置信息根本判不出来。
 */
export function sqlWildcardInScope(analysis: SqlAnalysis, offset: number): SqlWildcard | undefined {
  const scope = sqlScopeAt(analysis, offset);
  if (!scope) return undefined;
  let found: SqlWildcard | undefined;
  for (const index of scope.indices) {
    if (analysis.tokens[index].text !== "*") continue;
    const wildcard = wildcardOf(analysis, index);
    if (!wildcard) continue;
    if (found) return undefined;
    found = wildcard;
  }
  return found;
}
