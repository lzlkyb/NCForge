import type { SqlLanguage } from "sql-formatter";
import { isSqlName, sqlName, sqlWordKind } from "./sqlLex";
import { resolveSqlQualifier, sqlCompletionAt, sqlScopeAt, sqlSourcesAt, type SqlAnalysis, type SqlSource } from "./sqlScope";

export type SqlClause = "select" | "where" | "on" | "group" | "order" | "set" | "insert" | "other";
export interface AssistContext {
  kind: "column" | "table" | "any" | "none" | "schema" | "value";
  clause: SqlClause; qualifier?: string; qualifierRef?: string; schema?: string;
  field?: string; valueSource?: SqlSource; valueStart?: number; valueEnd?: number;
  assigned: string[]; projections: string[];
}
const clauses: Record<string, SqlClause> = { SELECT: "select", WHERE: "where", HAVING: "where", ON: "on", GROUP: "group", ORDER: "order", SET: "set", INSERT: "insert", INTO: "insert", FROM: "other", JOIN: "other", VALUES: "other", RETURNING: "select" };

/** Same scope and lexer as highlighting; nested query clauses cannot leak into the outer query. */
export function completionContext(analysis: SqlAnalysis, offset: number, dialect: SqlLanguage = "sql"): AssistContext {
  const base = sqlCompletionAt(analysis, offset), scope = sqlScopeAt(analysis, offset);
  const ids = scope?.indices.filter(i => analysis.tokens[i].start < offset) ?? [];
  const tokens = ids.map(i => analysis.tokens[i]);
  const clause = [...tokens].reverse().map(t => clauses[t.text.toUpperCase()]).find(Boolean) ?? "other";
  const result: AssistContext = { ...base, clause, assigned: [], projections: [] };
  const hit = analysis.tokens.find(t => t.start < offset && t.end >= offset);
  const before = analysis.tokens.filter(t => t.start < offset && !["space", "comment", "hint"].includes(t.kind));
  const last = (back: number) => before[before.length - back];
  if (hit && (isSqlName(hit) || hit.kind === "string" || hit.kind === "number")) before.pop();
  // Literal completion is permitted only immediately after a verified field comparison.
  if (["where", "on"].includes(clause) && last(1)?.text === "=" && (!hit || !["comment", "hint", "parameter"].includes(hit.kind))) {
    const field = last(2), dot = last(3), qualifier = last(4);
    if (isSqlName(field)) {
      const sources = sqlSourcesAt(analysis, offset);
      const source = dot?.text === "." && isSqlName(qualifier) ? resolveSqlQualifier(analysis, offset, sqlName(qualifier), qualifier.text) : sources.length === 1 ? sources[0] : undefined;
      if (source?.table) Object.assign(result, { kind: "value", field: sqlName(field), valueSource: source, valueStart: hit && ["string", "number", "identifier"].includes(hit.kind) ? hit.start : offset, valueEnd: hit?.end ?? offset });
    }
  }
  if (base.kind === "column") {
    const dot = last(1), owner = last(2), lead = last(3);
    if (dot?.text === "." && isSqlName(owner) && ["FROM", "JOIN", "UPDATE", "INTO", "TABLE", ","].includes(lead?.text.toUpperCase() ?? "")) Object.assign(result, { kind: "schema", schema: sqlName(owner) });
  }
  if (clause === "set") {
    const start = tokens.map(t => t.text.toUpperCase()).lastIndexOf("SET");
    result.assigned = tokens.slice(start + 1).flatMap((t, i, ts) => isSqlName(t) && ts[i + 1]?.text === "=" ? [sqlName(t)] : []);
  }
  // Oracle only permits SELECT aliases in ORDER BY; other supported engines allow GROUP BY aliases.
  if (clause === "order" || clause === "group" && ["mysql", "mariadb", "postgresql", "sqlite"].includes(dialect)) result.projections = scope?.columns ?? [];
  return result;
}

export function sqlIdentifier(name: string, dialect: SqlLanguage = "sql"): string {
  if (/^[a-z_][\w$#]*$/.test(name) && sqlWordKind(name, dialect) === "identifier") return name;
  if (["mysql", "mariadb"].includes(dialect)) return `\`${name.replace(/`/g, "``")}\``;
  if (dialect === "tsql") return `[${name.replace(/]/g, "]]")}]`;
  return `"${name.replace(/"/g, '""')}"`;
}
