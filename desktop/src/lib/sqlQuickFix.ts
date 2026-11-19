import { similarTo } from "./db";
import { sqlIdentifier } from "./sqlCompletionContext";
import { oraHint } from "./oraErrorHint";
import { analyzeSql, resolveSqlQualifier, sqlSourcesAt } from "./sqlScope";
import { sqlName } from "./sqlLex";

export interface SqlQuickFix { start: number; end: number; text: string }

export async function sqlQuickFixes(error: string, sql: string, tables: string[], columns: (table: string) => Promise<string[]>): Promise<SqlQuickFix[]> {
  const hint = oraHint(error, sql);
  const analysis = analyzeSql(sql, "plsql");
  const tokens = analysis.tokens.filter(t => !["space", "comment", "hint"].includes(t.kind));
  const format = (name: string) => sqlIdentifier(name === name.toUpperCase() ? name.toLowerCase() : name, "plsql");
  const local = (source: ReturnType<typeof sqlSourcesAt>[number]) =>
    !!source.table && !source.quoted && !source.schema && tables.some(name => name.toLowerCase() === source.table);
  if (/ORA-00918\b/.test(error)) {
    const scope = analysis.scopes[0], sources = scope?.sources ?? [];
    if (analysis.scopes.length !== 1 || sources.length < 2 || sources.length > 8 || !sources.every(local)) return [];
    const names = await Promise.all(sources.map(source => columns(source.table!)));
    const ambiguous = tokens.flatMap((token, i) => {
      if (token.kind !== "identifier" || token.start < analysis.tokens[scope.select].end ||
          tokens[i - 1]?.text === "." || tokens[i - 1]?.text.toUpperCase() === "AS" || tokens[i + 1]?.text === "." ||
          analysis.roles.has(analysis.tokens.indexOf(token))) return [];
      const matches = sources.filter((_, index) => names[index].some(name => name.toLowerCase() === sqlName(token)));
      return matches.length > 1 ? [{ token, matches }] : [];
    });
    if (ambiguous.length !== 1) return [];
    const [{ token, matches }] = ambiguous;
    return matches.map(source => ({
      start: token.start, end: token.end, text: `${source.aliasRef ?? source.nameRef}.${token.text}`,
    }));
  }
  if (/ORA-00942\b/.test(error)) {
    const unknown = analysis.tokens.filter((t, i) => t.kind === "identifier" && analysis.roles.get(i) === "table" &&
      !tables.some(name => name.toLowerCase() === sqlName(t)));
    if (unknown.length !== 1) return [];
    const [token] = unknown;
    const i = tokens.indexOf(token);
    if (tokens[i - 1]?.text === "." || tokens[i + 1]?.text === "@") return [];
    return similarTo(sqlName(token), tables).map(name => ({ start: token.start, end: token.end, text: format(name) }));
  }
  if (!hint?.location) return [];
  // ORA-00904 报的是「这个名字不存在」：语句里每一处同名裸标识符都同样错，
  // 全部给出修复（其余错误码的位置线索只有一处，仍要求唯一出现）。
  const multi = hint.code === "ORA-00904";
  if (!multi && hint.location.occurrences !== 1) return [];
  const targets = tokens.filter(t => (t.kind === "identifier" || t.kind === "quoted") &&
    (t.kind === "quoted" ? sqlName(t) : t.text).toUpperCase() === hint.location!.ident.toUpperCase());
  const fixes: SqlQuickFix[] = [];
  // 候选封顶：每处最多 3 个相似名，长脚本里几十处错列名会把错误框按钮堆爆。
  // 截断后剩下的 occurrence 重新执行一次会再报再修，不会静默丢失。
  const MAX_FIXES = 12;
  for (const token of targets) {
    if (fixes.length >= MAX_FIXES) break;
    const at = tokens.indexOf(token);
    const role = analysis.roles.get(analysis.tokens.indexOf(token));
    if (role && role !== "column" || tokens[at + 1]?.text === ".") continue;
    const sources = sqlSourcesAt(analysis, token.start);
    const qualifier = tokens[at - 2];
    const source = tokens[at - 1]?.text === "." && qualifier
      ? resolveSqlQualifier(analysis, token.start, sqlName(qualifier), qualifier.text)
      : sources.length === 1 ? sources[0] : undefined;
    if (!source || !local(source)) continue;
    const names = await columns(source.table!);
    if (names.some(name => name.toLowerCase() === sqlName(token))) continue;
    fixes.push(...similarTo(sqlName(token), names).map(name => ({ start: token.start, end: token.end, text: format(name) })));
    if (!multi) break;
  }
  return fixes;
}
