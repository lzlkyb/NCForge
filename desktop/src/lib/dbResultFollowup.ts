import type { BoundCell, Cell, ColumnMeta } from "./dbApi";
import { isLobPreview, qualifyTable } from "./db";
import { identifier } from "./dbConditions";
import { bindRowValue } from "./dbOptimisticEdit";
import { relationQuery, type Relation } from "./dbRelations";
import { scanSql } from "./sqlLex";
import { analyzeSql, type QuerySource } from "./sqlSource";
import { quoteIdent } from "./serverSort";

export interface ResultFollowup {
  title: string;
  sql: string;
  params: BoundCell[];
  /** Complex projections can still offer a predicate for the user to apply in the editor. */
  executable: boolean;
}
export type ResultFilterMatch = { keyword: string } | { column: number; value: Cell; keyword?: string };

export function readQueryBody(sql: string): string | null {
  const scanned = scanSql(sql, "plsql");
  if (scanned.state.mode !== "plain") return null;
  const tokens = scanned.tokens.filter(token => !["space", "comment", "hint"].includes(token.kind));
  const word = (index: number) => tokens[index]?.kind === "keyword" || tokens[index]?.kind === "identifier" ? tokens[index].text.toUpperCase() : "";
  if (!["SELECT", "WITH"].includes(word(0))) return null;
  // Runtime submission is limited to SELECTs without explicit locking or inline PL/SQL.
  if (tokens.some((token, index) => token.text === ";" && index !== tokens.length - 1 || word(index) === "FOR" && word(index + 1) === "UPDATE"
    || token.kind === "parameter" || word(0) === "WITH" && ["FUNCTION", "PROCEDURE", "UPDATE", "DELETE", "INSERT", "MERGE"].includes(word(index)))) return null;
  const last = tokens[tokens.length - 1];
  return sql.slice(0, last.text === ";" ? last.start : last.end).trim();
}

function comparisonType(column: ColumnMeta, value: Cell): boolean {
  return value === null || !isLobPreview(value) && /^(NUMBER|INTEGER|FLOAT|DECIMAL|DOUBLE|N?VARCHAR2?|N?CHAR|DATE|TIMESTAMP)\b/i.test(column.type)
    && !/TIME ZONE/i.test(column.type);
}

function physicalColumn(source: QuerySource, name: string): string | null {
  const key = name.toUpperCase();
  return source.mapping.has(key) ? source.mapping.get(key) ?? null : source.star && /^[A-Z][A-Z0-9_$#]*$/.test(name) ? name : null;
}

export function resultFilterQuery(sql: string, columns: ColumnMeta[], match: ResultFilterMatch, bound = false): (ResultFollowup & { predicate: string }) | null {
  const body = readQueryBody(sql);
  const source = analyzeSql(sql);
  const counts = new Map<string, number>();
  for (const column of columns) counts.set(column.name, (counts.get(column.name) ?? 0) + 1);
  const unique = (column: ColumnMeta) => !!column.name.trim() && counts.get(column.name) === 1;
  const params: BoundCell[] = [];
  const clauses: string[] = [];
  let verified = true;
  if ("column" in match) {
    const column = columns[match.column];
    if (!column || !unique(column) || !comparisonType(column, match.value)) return null;
    const name = quoteIdent(column.name);
    clauses.push(match.value === null ? `${name} IS NULL` : `${name} = ${bindRowValue(match.value, column, params)}`);
    verified = !!physicalColumn(source, column.name);
  }
  const text = match.keyword?.trim();
  if (text) {
    const candidates = columns.filter(column => unique(column) && /^(N?VARCHAR2?|N?CHAR)\b/i.test(column.type));
    if (!candidates.length) return null;
    const offset = params.length;
    const terms = candidates.map((column, index) => `INSTR(LOWER(${quoteIdent(column.name)}), LOWER(:${offset + index + 1})) > 0`);
    clauses.push(clauses.length && terms.length > 1 ? `(${terms.join("\n   OR ")})` : terms.join("\n   OR "));
    params.push(...candidates.map(() => text));
    verified &&= candidates.every(column => !!physicalColumn(source, column.name));
  }
  if (!clauses.length) return null;
  const predicate = clauses.join("\n  AND ");
  const executable = !bound && !!body && !!source.table && verified;
  return { title: "按条件重新查询", sql: executable ? `SELECT * FROM (\n${body}\n)\nWHERE ${predicate}` : `WHERE ${predicate}`, predicate, params, executable };
}

export function resultRelationQuery(relation: Relation, source: QuerySource, schema: string | undefined,
  columns: ColumnMeta[], row: Cell[]): ResultFollowup {
  const parts = source.table?.split(".") ?? [];
  const table = parts[parts.length - 1];
  if (!table || parts.length > 1 && parts[0].toUpperCase() !== schema?.toUpperCase()
    || ![relation.source, relation.target].some(name => name.toUpperCase() === table.toUpperCase())) {
    throw new Error("无法确认此关联属于当前结果的 Schema。");
  }
  const physical = columns.flatMap((column, index) => {
    const name = physicalColumn(source, column.name);
    const value = row[index];
    return name && value !== undefined && comparisonType(column, value) ? [{ column: { ...column, name }, value }] : [];
  });
  const query = relationQuery(relation, table, physical.map(item => item.column), physical.map(item => item.value));
  return { title: `追查 ${query.table}`, sql: `SELECT * FROM ${identifier(qualifyTable(schema, query.table))}\nWHERE ${query.where}`,
    params: query.params, executable: true };
}
