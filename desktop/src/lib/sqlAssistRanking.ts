import { sqlUsageRank } from "./sqlUsage";

/** Match tiers dominate preference: a frequent fuzzy match must never displace an exact name. */
export function sqlMatchQuality(prefix: string, name: string, zh = ""): number {
  const p = prefix.toLowerCase(), n = name.toLowerCase(), z = zh.toLowerCase();
  if (!p) return 0;
  if (n === p) return 0;
  if (n.startsWith(p)) return 1;
  if (z === p || z.startsWith(p)) return 2;
  if (z.includes(p)) return 3;
  if (n.includes(p)) return 4;
  let at = 0;
  for (const char of n) if (char === p[at]) at++;
  return at === p.length ? 5 : 9;
}
export function sqlAssistSort(quality: number, group: number, name: string, scope?: string | null, key?: string, lower = false): string {
  const score = scope && key ? sqlUsageRank(scope, key) : 0;
  return `${quality}${lower ? 8 : group}${String(999999999999999 - Math.min(999999999999999, Math.round(score * 100))).padStart(15, "0")}${name.toLowerCase()}`;
}
/** Saved SQL is literal unless it contains explicit {{parameter}} slots. Escape Monaco metacharacters. */
export function sqlSnippetText(sql: string): string {
  let index = 0;
  return sql.split(/(\{\{[\p{L}\p{N}_]+\}\})/u).map(part => /^\{\{/.test(part)
    ? `\${${++index}:${part.slice(2, -2)}}`
    : part.replace(/[\\$}]/g, "\\$&")).join("");
}
