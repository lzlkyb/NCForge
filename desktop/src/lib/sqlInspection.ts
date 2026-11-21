import type { SqlLanguage } from "sql-formatter";
import { similarTo } from "./db";
import { isSqlName, scanSql, sqlName, sqlReferenceKey, type SqlToken } from "./sqlLex";
import { analyzeSql, resolveSqlQualifier, SQL_ANALYSIS_LIMIT, type SqlAnalysis, type SqlSource } from "./sqlScope";
import { isPlsql, splitStatements } from "./sqlSplit";

interface Span { start: number; end: number }
export interface SqlInspectionIssue extends Span {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  fixes?: { label: string; text: string }[];
}
interface Reference extends Span { name: string; text: string; sources: number[]; checkMissing: boolean }
interface Source extends Span { id: number; object: SqlSource }
export interface SqlInspectionPlan {
  range: Span;
  sources: Source[];
  references: Reference[];
  issues: SqlInspectionIssue[];
  activeAnalysis?: SqlAnalysis;
}
export type SqlInspectionCatalog = Readonly<Record<number, { columns: readonly string[] } | { unconfirmed: true }>>;
export const SQL_INSPECTION_DOCUMENT_LIMIT = 4_000_000;
const STATEMENT_LIMIT = 64_000;
const ISSUE_LIMIT = 50;
const MAX_SOURCES = 8;
const upper = (token?: SqlToken) => token?.text.toUpperCase() ?? "";
const trivia = (token: SqlToken) => ["space", "comment", "hint"].includes(token.kind);
const simpleName = (name: string) => /^[A-Z_][A-Z0-9_$#]*$/.test(name);
const oracleSpelling = (name: string, original: string) =>
  simpleName(name) && scanSql(name, "plsql").tokens[0]?.kind === "identifier"
    ? original === original.toUpperCase() ? name : name.toLowerCase()
    : `"${name.replace(/"/g, '""')}"`;

export function inspectSqlStatement(document: string, offset: number, dialect: SqlLanguage): SqlInspectionPlan | null {
  if (document.length > SQL_INSPECTION_DOCUMENT_LIMIT) return null;
  // Oracle splitting honours quoted semicolons, slash terminators and PL/SQL blocks.
  // Other dialects get syntax checks on the document only when it is small.
  const statement = dialect === "plsql" ? splitStatements(document).find(s => s.start <= offset && offset <= s.end) : { text: document, start: 0, end: document.length };
  if (!statement || statement.text.length > STATEMENT_LIMIT) return null;
  const { text, start, end } = statement, { state, tokens } = scanSql(text, dialect);
  const span = (token: SqlToken): Span => ({ start: start + token.start, end: start + token.end });
  const plan: SqlInspectionPlan = { range: { start, end }, sources: [], references: [], issues: [] };
  const add = (token: SqlToken, code: string, message: string, severity: SqlInspectionIssue["severity"] = "error") =>
    plan.issues.push({ ...span(token), code, message, severity });
  const content = tokens.filter(token => !trivia(token));
  const last = tokens[tokens.length - 1], lastCode = content[content.length - 1];
  if (last && state.mode !== "plain") add(last, "unterminated", state.mode === "block" ? "块注释缺少结束符 */" : "字符串或引用标识符缺少结束引号");
  const parens: SqlToken[] = [];
  for (const token of content) {
    if (token.kind !== "operator") continue;
    if (token.text === "(") parens.push(token);
    if (token.text === ")" && !parens.pop()) add(token, "unexpected-parenthesis", "这个右括号没有对应的左括号");
    if (plan.issues.length >= ISSUE_LIMIT) return plan;
  }
  if (state.mode === "plain" && parens.length) add(parens[0], "unclosed-parenthesis", "这个左括号还缺少对应的右括号");
  if (dialect === "plsql" && lastCode && ["SELECT", "FROM", "JOIN", "WHERE", "ON", "HAVING"].includes(upper(lastCode))) {
    add(lastCode, "incomplete-clause", `${upper(lastCode)} 后面的内容还没有写完`, "info");
  }
  if (dialect === "plsql" && !isPlsql(text)) {
    for (let i = 1; i < content.length && plan.issues.length < ISSUE_LIMIT; i++) {
      const token = content[i];
      const previous = upper(content[i - 1]), beforePrevious = upper(content[i - 2]);
      if (upper(token) === "FROM" && (previous === "SELECT" || beforePrevious === "SELECT" && ["DISTINCT", "ALL"].includes(previous))) {
        add(token, "missing-projection", "SELECT 与 FROM 之间需要查询字段或表达式");
      }
    }
  }
  if (dialect !== "plsql" || plan.issues.length || isPlsql(text) || !["SELECT", "WITH", "MERGE"].includes(upper(content[0]))) return plan;

  const analysis = analyzeSql(text, dialect);
  for (const scope of analysis.scopes) {
    if (!["SELECT", "MERGE"].includes(upper(analysis.tokens[scope.select])) || !scope.sources.length || scope.sources.length > MAX_SOURCES) continue;
    // These constructs change the visible column set or make qualified names mean more than table.column.
    if (scope.indices.some(i => ["PIVOT", "UNPIVOT", "MODEL", "MATCH_RECOGNIZE", "LATERAL", "@", "JSON_TABLE", "XMLTABLE"].includes(upper(analysis.tokens[i])))) continue;
    const names = new Set<string>();
    for (const source of scope.sources) {
      const key = sqlReferenceKey(source.alias ?? source.name, source.aliasRef ?? source.nameRef, dialect);
      const token = analysis.tokens[source.declaration];
      // Alias declarations are tracked by the scope parser, including explicit AS.
      const aliasIndex = scope.indices.find(i => i > source.declaration && analysis.roles.get(i) === "alias");
      if (source.alias && names.has(key) && aliasIndex !== undefined) {
        add(analysis.tokens[aliasIndex], "duplicate-alias", `别名 ${source.aliasRef ?? source.alias} 在当前查询层重复声明`);
      }
      names.add(key);
      if ((source.table || source.declaredColumnKeys?.length) && upper(token) !== "DUAL" && plan.sources.length < MAX_SOURCES) {
        plan.sources.push({ ...span(token), id: source.declaration, object: source });
      }
    }
    const ids = scope.indices.filter(i => i > scope.select), from = ids.findIndex(i => upper(analysis.tokens[i]) === "FROM");
    const inProjection = from < 0 ? [] : ids.slice(0, from);
    const items: number[][] = [[]];
    for (const i of inProjection) {
      if (analysis.tokens[i].text === ",") items.push([]);
      else items[items.length - 1].push(i);
    }
    const natural = ids.some(i => ["NATURAL", "USING"].includes(upper(analysis.tokens[i])));
    for (const raw of items) {
      const item = raw.map(i => analysis.tokens[i]);
      if (["DISTINCT", "ALL"].includes(upper(item[0]))) item.shift();
      if (!item.length) continue;
      // Only direct projection expressions are checked without qualification, so function arguments,
      // ORDER BY aliases and USING/NATURAL merged columns cannot become false errors.
      if (item.length === 1 && !natural && isSqlName(item[0])) {
        plan.references.push({ ...span(item[0]), name: sqlName(item[0]), text: item[0].text, sources: scope.sources.map(s => s.declaration),
          checkMissing: !scope.region.parent });
      }
      if (item.length < 3 || !isSqlName(item[0]) || item[1].text !== "." || !isSqlName(item[2])
          || item[3]?.text === "." || item[3]?.text === "(" || ["NEXTVAL", "CURRVAL"].includes(upper(item[2]))) continue;
      const source = resolveSqlQualifier(analysis, item[0].start, sqlName(item[0]), item[0].text);
      if (!source && analysis.scopes.length === 1 && scope.sources.every(s => !!s.table) && names.size === scope.sources.length) {
        add(item[0], "unknown-qualifier", `当前查询里没有声明 ${item[0].text}`, "warning");
      }
    }
    const sourceDeclarations = new Set(scope.sources.map(source => source.declaration));
    for (let i = 0; i + 2 < ids.length && plan.references.length < ISSUE_LIMIT; i++) {
      const qualifier = analysis.tokens[ids[i]], column = analysis.tokens[ids[i + 2]];
      if (!isSqlName(qualifier) || analysis.tokens[ids[i + 1]].text !== "." || !isSqlName(column)
          || sourceDeclarations.has(ids[i + 2]) || analysis.tokens[ids[i - 1]]?.text === "."
          || [".", "("].includes(analysis.tokens[ids[i + 3]]?.text)
          || ["NEXTVAL", "CURRVAL"].includes(upper(column))) continue;
      const source = resolveSqlQualifier(analysis, qualifier.start, sqlName(qualifier), qualifier.text);
      if (source) plan.references.push({ ...span(column), name: sqlName(column), text: column.text, sources: [source.declaration], checkMissing: true });
    }
  }
  if (document.length > SQL_ANALYSIS_LIMIT) {
    // Keep local token indices and rebase offsets. Scope consumers can then use the same model coordinates.
    for (const token of analysis.tokens) { token.start += start; token.end += start; }
    for (const scope of analysis.scopes) { scope.start += start; scope.end += start; }
    for (const region of analysis.regions) {
      region.start += start; region.end += start;
      for (const cte of region.ctes) cte.visible += start;
    }
    plan.activeAnalysis = analysis;
  }
  return plan;
}

export function resolveSqlInspection(plan: SqlInspectionPlan, catalog: SqlInspectionCatalog): SqlInspectionIssue[] {
  const issues = [...plan.issues], sources = new Map(plan.sources.map(s => [s.id, s]));
  for (const source of plan.sources) {
    if (catalog[source.id] && "unconfirmed" in catalog[source.id]) issues.push({
      start: source.start, end: source.end, code: "unverified-object", severity: "info",
      message: `当前 Schema 中暂无法确认 ${source.object.tableRef ?? source.object.name} 的结构`,
    });
  }
  for (const ref of plan.references) {
    if (issues.length >= ISSUE_LIMIT) break;
    const entries = ref.sources.map(id => catalog[id]);
    if (!entries.length || !entries.every((entry): entry is { columns: readonly string[] } => !!entry && "columns" in entry && entry.columns.length > 0)) continue;
    const key = sqlReferenceKey(ref.name, ref.text, "plsql");
    const matches = entries.flatMap((entry, i) => entry.columns.includes(key) ? [sources.get(ref.sources[i])!] : []);
    if (matches.length === 1) continue;
    if (matches.length > 1) {
      issues.push({ start: ref.start, end: ref.end, code: "ambiguous-column", severity: "error", message: `${ref.text} 同时存在于多个来源，请指定所属表`,
        fixes: matches.flatMap(({ object }) => {
          const qualifier = object.aliasRef ?? object.nameRef;
          return qualifier ? [{ label: `使用 ${qualifier}.${ref.text}`, text: `${qualifier}.${ref.text}` }] : [];
        }) });
    } else if (entries.length === 1 && ref.checkMissing) {
      const table = sources.get(ref.sources[0])!.object;
      const columns = entries[0].columns;
      const fixes = similarTo(key, columns.filter(simpleName)).slice(0, 3).map(name => {
        const text = oracleSpelling(name, ref.text);
        return { label: `改为 ${text}`, text };
      });
      issues.push({ start: ref.start, end: ref.end, code: "unknown-column", severity: "error",
        message: `${table.tableRef ?? table.name} 中没有字段 ${ref.text}`, fixes });
    }
  }
  return issues.slice(0, ISSUE_LIMIT);
}
