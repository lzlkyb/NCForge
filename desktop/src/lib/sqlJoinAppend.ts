import { isSqlName, sqlName, sqlReferenceKey, type SqlToken } from "./sqlLex";
import { sqlScopeAt, type SqlAnalysis, type SqlSource } from "./sqlScope";
import type { BillJoinSpec } from "./sqlBillJoin";

type Scope = NonNullable<ReturnType<typeof sqlScopeAt>>;
const afterFrom = /^(WHERE|GROUP|HAVING|ORDER|CONNECT|START|MODEL|MATCH_RECOGNIZE|UNION|INTERSECT|MINUS|EXCEPT|FETCH|OFFSET|FOR)$/i;
const trivia = (token: SqlToken) => ["space", "comment", "hint"].includes(token.kind);
const word = (token?: SqlToken) => token?.text.toUpperCase();
const refKey = (token: SqlToken) => sqlReferenceKey(sqlName(token), token.text, "plsql");
const qualifierKey = (source: SqlSource) => sqlReferenceKey(source.alias ?? source.name, source.aliasRef ?? source.nameRef, "plsql");
const pairKey = (root: string, other: string) => JSON.stringify([root, other]);

export function sqlJoinInsertion(analysis: SqlAnalysis, scope: Scope, sql: string) {
  const tokens = scope.indices.map(i => analysis.tokens[i]);
  const from = tokens.find(t => word(t) === "FROM");
  if (!from || word(analysis.tokens[scope.select]) !== "SELECT") return;
  const after = tokens.find(t => t.start >= from.end && t.start < scope.end && t.kind === "keyword" && afterFrom.test(t.text))
    ?? analysis.tokens.find(t => t.start === scope.end && t.kind === "keyword" && afterFrom.test(t.text));
  const boundary = after?.start ?? scope.end;
  const chain = tokens.filter(t => t.start >= from.end && t.start < boundary);
  const all = analysis.tokens.filter(t => t.start >= from.end && t.end <= boundary && t.kind !== "space");
  const tail = all[all.length - 1], syntax = chain[chain.length - 1];
  if (!tail || !syntax || ["JOIN", "ON", "USING", "APPLY", "AND", "OR", ","].includes(word(syntax) ?? "")
    || (tail.kind === "operator" && tail.text !== ")")) return;
  const lineStart = sql.lastIndexOf("\n", from.start - 1) + 1;
  const indent = /^[\t ]*/.exec(sql.slice(lineStart, from.start))?.[0] ?? "";
  const end = /^--/.test(tail.text) && sql[tail.end - 1] === "\r" ? tail.end - 1 : tail.end;
  return { end, clause: word(after), chain, all, indent,
    multiline: /^--/.test(tail.text) || /[\r\n]/.test(sql.slice(scope.start, boundary)),
    inlineClause: !!after && !/[\r\n]/.test(sql.slice(end, boundary)),
    needsSeparator: /^[\p{L}\p{N}_$#"]/u.test(sql.charAt(end)) };
}

type Insertion = NonNullable<ReturnType<typeof sqlJoinInsertion>>;

/** Compare ON column pairs per query and source alias. OR and partial composite conditions don't establish equality. */
function existingJoins(analysis: SqlAnalysis, scope: Scope, insertion: Insertion, root: SqlSource, schema: string) {
  const groups = new Set<string>(), rootKey = qualifierKey(root);
  const { chain, all } = insertion;
  for (let i = 0; i < chain.length; i++) {
    if (word(chain[i]) !== "ON") continue;
    const join = chain.slice(0, i).reverse().find(t => word(t) === "JOIN" || t.text === ",");
    if (!join || word(join) !== "JOIN") continue;
    const joined = scope.sources.find(source => {
      const offset = analysis.tokens[source.declaration].start;
      return offset >= join.end && offset < chain[i].start;
    });
    if (!joined) continue;
    const next = chain.slice(i + 1).find(t => word(t) === "JOIN" || t.text === ",");
    const tokens = all.filter(t => t.start >= chain[i].end && t.end <= (next?.start ?? insertion.end) && !trivia(t));
    if (tokens.some(t => t.kind === "keyword" && ["OR", "NOT", "CASE"].includes(t.text.toUpperCase()))) continue;
    const matches = new Map<SqlSource, Set<string>>();
    for (let p = 0; p + 6 < tokens.length; p++) {
      const [a, dotA, colA, eq, b, dotB, colB] = tokens.slice(p, p + 7);
      if (!isSqlName(a) || dotA.text !== "." || !isSqlName(colA) || eq.text !== "=" || !isSqlName(b) || dotB.text !== "." || !isSqlName(colB)) continue;
      const before = tokens[p - 1], after = tokens[p + 7];
      if (before && !["(", "AND"].includes(word(before)!) || after && ![")", "AND", "LEFT", "RIGHT", "INNER", "FULL", "OUTER", "CROSS", "NATURAL"].includes(word(after)!)) continue;
      if (sqlScopeAt(analysis, eq.start) !== scope) continue;
      const left = refKey(a) === rootKey, right = refKey(b) === rootKey;
      if (left === right) continue;
      const other = refKey(left ? b : a);
      const sources = scope.sources.filter(source => qualifierKey(source) === other);
      if (sources.length !== 1) continue;
      const source = sources[0];
      // An ON predicate on a later join may compare two earlier aliases without joining them.
      if (source !== joined && root !== joined) continue;
      if (!source.table || source.quoted || source.schema && source.schema.toLowerCase() !== schema.toLowerCase()) continue;
      const pairs = matches.get(source) ?? new Set<string>();
      pairs.add(pairKey(refKey(left ? colA : colB), refKey(left ? colB : colA)));
      matches.set(source, pairs);
    }
    for (const [source, pairs] of matches) groups.add(JSON.stringify([source.table!.toLowerCase(), [...pairs].sort()]));
  }
  return groups;
}

export function sqlJoinAppendChoices(analysis: SqlAnalysis, scope: Scope, insertion: Insertion,
  root: SqlSource, schema: string, specs: readonly BillJoinSpec[]) {
  const existing = existingJoins(analysis, scope, insertion, root, schema);
  const visible = [...scope.sources];
  for (let region = scope.region; region.parent && !region.isolated; region = region.parent) {
    const outer = region.parent.scopes.find(candidate => candidate.start <= scope.start && scope.end <= candidate.end);
    if (outer) visible.push(...outer.sources);
  }
  const used = new Set(visible.flatMap(source => [qualifierKey(source), source.table?.toUpperCase() ?? ""]));
  const count = new Map<string, number>();
  for (const spec of specs) count.set(spec.table, (count.get(spec.table) ?? 0) + 1);
  const qualifier = root.aliasRef ?? root.nameRef ?? root.name;
  const prefix = root.schema && root.tableRef ? root.tableRef.slice(0, root.tableRef.lastIndexOf(".") + 1) : "";
  return specs.map(spec => {
    const pairs = spec.rootColumns.map((field, i) => pairKey(field.toUpperCase(), spec.otherColumns[i].toUpperCase())).sort();
    const added = existing.has(JSON.stringify([spec.table, pairs]));
    if (added) return { spec, added, sql: "" };
    let alias = spec.table;
    if (used.has(alias.toUpperCase()) || (count.get(alias) ?? 0) > 1) {
      // Keep room for a suffix within Oracle's identifier limit.
      const stem = (spec.table + "_" + spec.rootColumns[0]).slice(0, 30);
      alias = stem;
      for (let n = 2; used.has(alias.toUpperCase()); n++) {
        const suffix = "_" + n;
        alias = stem.slice(0, 30 - suffix.length) + suffix;
      }
    }
    used.add(alias.toUpperCase());
    const on = spec.otherColumns.map((field, i) => alias + "." + field + " = " + qualifier + "." + spec.rootColumns[i]).join(" AND ");
    return { spec, added, sql: "LEFT JOIN " + prefix + spec.table + (alias === spec.table ? "" : " " + alias) + " ON " + on };
  });
}

export function sqlJoinAppendText(insertion: Insertion, joins: readonly string[]) {
  const lines = insertion.multiline || joins.length > 1;
  const preview = lines ? joins.map(sql => insertion.indent + sql.replace(" ON ", "\n" + insertion.indent + "  ON ")).join("\n") : joins[0] ?? "";
  const block = (lines ? "\n" : " ") + preview;
  const separator = lines && insertion.inlineClause ? "\n" + insertion.indent : insertion.needsSeparator ? " " : "";
  return { preview, block, text: block + separator };
}
