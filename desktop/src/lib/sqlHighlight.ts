import type { SqlLanguage } from "sql-formatter";
import { analyzeSql, type SqlAnalysis } from "./sqlScope";

export const SQL_HIGHLIGHT_KINDS = ["identifier", "keyword", "type", "number", "string", "comment", "hint", "parameter", "operator", "table", "column", "alias", "cte", "function"] as const;
export type SqlHighlightKind = typeof SQL_HIGHLIGHT_KINDS[number];
export const sqlTokenStyle = (kind: SqlHighlightKind) => `nc-sql-${kind}`;
export function sqlHighlightKind(analysis: SqlAnalysis, index: number): SqlHighlightKind | "space" {
  const kind = analysis.roles.get(index) ?? analysis.tokens[index].kind;
  return kind === "quoted" ? "identifier" : kind;
}
/** Both React previews and Monaco semantic tokens consume this analysis. SQL stays plain text. */
export function highlightedSql(sql: string, dialect: SqlLanguage = "sql") {
  const analysis = analyzeSql(sql, dialect);
  return analysis.tokens.map((token, i) => ({ ...token, kind: sqlHighlightKind(analysis, i) }));
}
