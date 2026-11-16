import type { SqlClause } from "./sqlCompletionContext";
import { isSqlName, sqlName } from "./sqlLex";
import { resolveSqlQualifier, sqlScopeAt, sqlSourcesAt, type SqlAnalysis, type SqlSource } from "./sqlScope";

export type PredicateContext = ({ kind: "field" } | { kind: "operator"; field: string; fieldRef: string; source: SqlSource; start: number; end: number }) & { negated: boolean };
const ignored = new Set(["space", "comment", "hint"]);
const boundary = new Set(["AND", "OR", ")", ";", "GROUP", "ORDER", "HAVING", "JOIN", "LEFT", "RIGHT", "INNER", "FULL", "WHERE", "UNION", "LIMIT", "FETCH"]);

/** Only a whole boolean operand can safely become `field = value`; arithmetic and BETWEEN operands cannot. */
export function sqlPredicateContext(analysis: SqlAnalysis, offset: number, clause: SqlClause): PredicateContext | undefined {
  if (clause !== "where" && clause !== "on") return;
  const hit = analysis.tokens.find(t => t.start < offset && t.end >= offset);
  if (hit && ["string", "comment", "hint", "parameter"].includes(hit.kind)) return;
  const scope = sqlScopeAt(analysis, offset);
  const start = scope?.indices.filter(i => analysis.tokens[i].start < offset).reverse().find(i => analysis.tokens[i].text.toUpperCase() === clause.toUpperCase());
  if (start === undefined) return;
  const tokens = analysis.tokens.filter(t => t.start >= analysis.tokens[start].end && t.start < offset && !ignored.has(t.kind));
  const stack = [{ boolean: true, between: false, negated: false, start: 0 }];
  let cases = 0;
  for (let i = 0; i < tokens.length; i++) {
    const word = tokens[i].text.toUpperCase(), frame = stack[stack.length - 1];
    if (word === "CASE") cases++;
    if (word === "END" && cases) { cases--; continue; }
    if (cases) continue;
    // 🔴 **括号一律重置 negated，这是有意设计，别改成继承 frame.negated**（2026-11-16 复核）。
    // `NOT a.created` 直接插入复合范围会破坏 NOT 的作用域，所以要拦；
    // 而 `NOT (a.created)` 用户已经**显式分组**，插进去的复合范围自带括号、
    // 整体落在 NOT 里面（`NOT (a.created BETWEEN x AND y)`），语义正确，应当放行。
    // 两处测试钉住这条语义：`sqlProviders.test.ts:417`「显式分组时可以选」、`:507`。
    if (word === "(") stack.push({ boolean: frame.boolean && i === frame.start, between: false, negated: false, start: i + 1 });
    else if (word === ")") { if (stack.length === 1) return; stack.pop(); }
    else if (frame.boolean) {
      if (word === "BETWEEN") frame.between = true;
      else if (word === "AND" && frame.between) frame.between = false;
      else if (word === "AND" || word === "OR") { frame.start = i + 1; frame.negated = false; }
      else if (word === "NOT" && i === frame.start) { frame.start = i + 1; frame.negated = true; }
    }
  }
  const frame = stack[stack.length - 1];
  if (!frame.boolean || cases) return;
  const end = hit && isSqlName(hit) ? hit.end : offset;
  const after = analysis.tokens.filter(t => t.start >= end && !ignored.has(t.kind));
  // Parentheses can wrap a scalar expression; inspect its following operator too.
  // Stop at the current query boundary, since an outer query owns what follows it.
  while (after[0]?.text === ")" && after[0].start < scope!.end) after.shift();
  const next = after[0];
  // Editing the left side of an existing predicate must preserve its operator and value.
  if (next && !boundary.has(next.text.toUpperCase())) return;
  const part = tokens.slice(frame.start);
  const qualified = isSqlName(part[0]) && part[1]?.text === ".";
  if (!part.length || qualified && part.length === 2) return { kind: "field", negated: frame.negated };
  const fieldIndex = qualified ? 2 : 0, field = part[fieldIndex];
  if (!isSqlName(field)) return;
  if (part.length === fieldIndex + 1 && field.end >= offset) return { kind: "field", negated: frame.negated };
  const op = part[fieldIndex + 1];
  if (part.length > fieldIndex + 2 || op && (!/^[\p{L}]+$/u.test(op.text) || op.end < offset)) return;
  const sources = sqlSourcesAt(analysis, offset).filter(s => clause !== "on" || analysis.tokens[s.declaration].start < offset);
  const source = qualified ? resolveSqlQualifier(analysis, offset, sqlName(part[0]), part[0].text) : sources.length === 1 ? sources[0] : undefined;
  if (!source?.table || clause === "on" && !sources.includes(source)) return;
  return { kind: "operator", source, field: sqlName(field), fieldRef: field.text, start: op?.start ?? offset, end: op?.end ?? offset, negated: frame.negated };
}
