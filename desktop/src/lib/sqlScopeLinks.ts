import { isSqlName, sqlName } from "./sqlLex";
import { resolveSqlQualifier, sqlSourcesAt, type SqlAnalysis } from "./sqlScope";
import type { TableLink } from "./sqlLinks";

/** Table navigation shares scopes with completion; strings, CTEs and ambiguous aliases never open physical tables. */
export function scopedTableLinks(analysis: SqlAnalysis): TableLink[] {
  const ids = analysis.tokens.flatMap((token, i) => ["space", "string", "comment", "hint"].includes(token.kind) ? [] : [i]);
  return ids.flatMap((i, p) => {
    const token = analysis.tokens[i], role = analysis.roles.get(i);
    if (!isSqlName(token) && token.text.toUpperCase() !== "DUAL") return [];
    if (analysis.tokens[ids[p + 1]]?.text === ".") return [];
    const sources = sqlSourcesAt(analysis, token.start);
    let table: string | undefined;
    if (role === "table") table = sources.find(s => s.declaration === i)?.table;
    if (role === "alias") {
      table = resolveSqlQualifier(analysis, token.start, sqlName(token), token.text)?.table;
    }
    let previous = p - 1;
    while (analysis.tokens[ids[previous]]?.text === "." && isSqlName(analysis.tokens[ids[previous - 1]])) previous -= 2;
    if (!table && ["TABLE", "TRUNCATE"].includes(analysis.tokens[ids[previous]]?.text.toUpperCase() ?? "")) table = sqlName(token);
    return table ? [{ start: token.start, end: token.end, table }] : [];
  });
}
