import { analyzeSql, resolveSqlQualifier, type SqlAnalysis, type SqlSource } from "./sqlScope";
import { isSqlName, sqlName, type SqlToken } from "./sqlLex";
import type { SqlLanguage } from "sql-formatter";

export interface MeaningEdit { start: number; end: number; text: string }
export interface JoinMeaning { start: number; end: number; message: string; inner?: MeaningEdit; move?: MeaningEdit[] }
const word = (t?: SqlToken) => t?.text.toUpperCase() ?? "";
const ends = new Set(["GROUP", "HAVING", "ORDER", "FETCH", "LIMIT", "OFFSET", "FOR", "UNION", "MINUS", "INTERSECT", "EXCEPT"]);
interface Atom { tokens: SqlToken[]; start: number; end: number; before?: SqlToken; after?: SqlToken }
function atomsOf(tokens: SqlToken[]): Atom[] {
  const groups: Atom[] = [], pending: SqlToken[] = [];
  let depth = 0, between = false, before: SqlToken | undefined;
  const finish = (after?: SqlToken) => {
    if (pending.length) groups.push({ tokens: pending.splice(0), start: tokensOfStart, end: tokensOfEnd, before, after });
  };
  let tokensOfStart = 0, tokensOfEnd = 0;
  for (const token of tokens) {
    if (token.text === "(") depth++;
    if (token.text === ")") depth--;
    if (depth < 0) return [];
    if (depth === 0 && word(token) === "AND" && !between) { finish(token); before = token; continue; }
    if (!pending.length) tokensOfStart = token.start;
    tokensOfEnd = token.end; pending.push(token);
    if (depth === 0 && word(token) === "BETWEEN") between = true;
    else if (depth === 0 && word(token) === "AND" && between) between = false;
  }
  if (depth) return [];
  finish(); return groups;
}
function operand(tokens: SqlToken[]): SqlToken[] {
  let ts = tokens;
  while (ts[0]?.text === "(" && ts[ts.length - 1]?.text === ")") {
    let depth = 0, wraps = true;
    ts.forEach((t, i) => { if (t.text === "(") depth++; if (t.text === ")") depth--; if (depth === 0 && i < ts.length - 1) wraps = false; });
    if (!wraps) break;
    ts = ts.slice(1, -1);
  }
  return ts;
}

/** Only proven null-rejecting AND operands get a notice; OR/NOT/functions are not guessed. */
export function sqlJoinMeanings(sql: string, dialect: SqlLanguage = "plsql"): JoinMeaning[] {
  return sqlJoinMeaningsOf(sql, analyzeSql(sql, dialect));
}

export function sqlJoinMeaningsOf(sql: string, analysis: SqlAnalysis): JoinMeaning[] {
  const out: JoinMeaning[] = [], tokens = analysis.tokens;
  for (const scope of analysis.scopes) {
    if (word(tokens[scope.select]) !== "SELECT") continue;
    const ids = scope.indices, ts = ids.map(i => tokens[i]), where = ts.findIndex(t => word(t) === "WHERE");
    if (where < 0) continue;
    const stop = ts.find((t, i) => i > where && ends.has(word(t)))?.start ?? scope.end;
    const whereTokens = tokens.filter(t => t.start >= ts[where].end && t.end <= stop && !["space", "comment", "hint"].includes(t.kind));
    if (whereTokens.some((t, i) => ["OR", "SELECT", "CASE"].includes(word(t)) || word(t) === "NOT" && !(word(whereTokens[i - 1]) === "IS" && word(whereTokens[i + 1]) === "NULL")) || !whereTokens.length) continue;
    const atoms = atomsOf(whereTokens);
    if (!atoms.length) continue;
    const joins = new Map<SqlSource, { start: number; keywordEnd: number; onStart: number; onEnd: number }>();
    ts.forEach((t, p) => {
      if (word(t) !== "JOIN") return;
      const left = word(ts[p - 1]) === "LEFT" ? p - 1 : word(ts[p - 1]) === "OUTER" && word(ts[p - 2]) === "LEFT" ? p - 2 : -1;
      if (left < 0) return;
      const on = ts.findIndex((t, i) => i > p && ["ON", "JOIN", "WHERE", "USING"].includes(word(t)));
      if (on < 0 || word(ts[on]) !== "ON") return;
      const source = scope.sources.find(s => tokens[s.declaration].start > t.end && tokens[s.declaration].end < ts[on].start);
      if (!source) return;
      let end = where;
      for (let n = on + 1; n < where; n++) if (["JOIN", "LEFT", "RIGHT", "FULL", "INNER", "CROSS"].includes(word(ts[n]))) { end = n; break; }
      if (on + 1 >= end) return;
      joins.set(source, { start: ts[left].start, keywordEnd: t.start, onStart: ts[on].end, onEnd: ts[end].start });
    });
    for (const atom of atoms) {
      const part = operand(atom.tokens);
      if (!isSqlName(part[0]) || part[1]?.text !== "." || !isSqlName(part[2])) continue;
      let depth = 0, conjunctions = 0, truthTest = false;
      for (const [i, t] of part.entries()) { if (t.text === "(") depth++; if (t.text === ")") depth--; if (!depth && word(t) === "AND") conjunctions++; if (!depth && i > 3 && ["IS", "ISNULL", "NOTNULL"].includes(word(t))) truthTest = true; }
      // PostgreSQL can test the comparison itself: b.flag = TRUE IS NULL retains unmatched rows.
      if (truthTest) continue;
      if (conjunctions > (word(part[3]) === "BETWEEN" ? 1 : 0)) continue;
      const source = resolveSqlQualifier(analysis, part[0].start, sqlName(part[0]), part[0].text), join = source && joins.get(source);
      const notNull = word(part[3]) === "IS" && word(part[4]) === "NOT" && word(part[5]) === "NULL" && part.length === 6;
      if (!source || !join || !notNull && !["=", "<>", "!=", ">", ">=", "<", "<=", "LIKE", "IN", "BETWEEN"].includes(word(part[3]))) continue;
      if (part.length < 5 || part[part.length - 1]?.text === ".") continue;
      const alias = source.aliasRef ?? source.nameRef ?? source.name;
      const meaning: JoinMeaning = { start: part[0].start, end: part[2].end,
        message: `WHERE 中的 ${alias}.${part[2].text} 条件会排除没有匹配 ${alias} 记录的行。将条件放入 ON 可改变匹配范围；其他条件和关联仍会影响结果。` };
      const hasComments = tokens.some(t => t.start >= join.start && t.end <= stop && ["comment", "hint"].includes(t.kind));
      // A correlated/nested query or complex FROM can have additional binding/consumer rules.
      const from = ts.findIndex(t => word(t) === "FROM");
      const editable = !scope.region.parent && scope.region.scopes.length === 1 && ["SELECT", "WITH"].includes(word(tokens[scope.region.indices[0]]))
        && scope.sources.length === 2 && !ts.slice(from, where).some(t => ["RIGHT", "FULL", "CROSS", "NATURAL", "USING"].includes(word(t)) || t.text === ",") && !hasComments;
      if (editable) {
        const upper = word(ts.find(t => t.start === join.start)) === ts.find(t => t.start === join.start)?.text;
        const kw = (s: string) => upper ? s : s.toLowerCase();
        meaning.inner = { start: join.start, end: join.keywordEnd, text: kw("INNER") + " " };
        const predicate = sql.slice(atom.start, atom.end), onText = sql.slice(join.onStart, join.onEnd).trim();
        const removal = atoms.length === 1 ? { start: ts[where].start, end: atom.end, text: "" }
          : atom.before ? { start: atom.before.start, end: atom.end, text: "" } : { start: atom.start, end: atom.after!.end, text: "" };
        meaning.move = [{ start: join.onStart, end: join.onEnd, text: ` (${onText}) ${kw("AND")} (${predicate})\n` }, removal];
      }
      out.push(meaning);
      if (out.length >= 64) return out;
    }
  }
  return out;
}
