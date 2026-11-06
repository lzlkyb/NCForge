import type { CodeDiag } from "./diagStore";

const priority = { error: 0, warning: 1, info: 2 };
export function diagnosticSummaries(items: CodeDiag[], maximum = 300) {
  const lines = new Map<number, CodeDiag[]>();
  for (const item of items) { const group = lines.get(item.line) ?? []; group.push(item); lines.set(item.line, group); }
  return Array.from(lines.values()).slice(0, maximum).map(group => {
    const ordered = [...group].sort((a, b) => priority[a.severity] - priority[b.severity]);
    const first = ordered[0], short = first.message.replace(/\s+/g, " ").trim();
    return { ...first, summary: `${short.length > 96 ? `${short.slice(0, 96)}…` : short}${group.length > 1 ? `（另 ${group.length - 1} 项）` : ""}`, detail: ordered.map(item => item.message).join("\n\n") };
  });
}
