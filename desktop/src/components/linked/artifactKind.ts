import type { CompileDiagnostic } from "../../lib/compile";

/**
 * 工程级产物诊断的短标签。
 *
 * 依赖链行内徽章与检查结果列表**共用**这一份：两处各写一套文案，改一处漏另一处时
 * 用户会看到「徽章说无产物、列表说产物旧」这种自相矛盾。
 */
const LABELS: Record<string, string> = {
  stale: "产物旧",
  "no-output": "无产物",
};

export const artifactLabel = (kind: string) => LABELS[kind] ?? kind;

/** 徽章配色：`warn` 用 warning、`bad` 用 destructive（见 linked.css 的 data-kind）。 */
export const artifactTone = (kind: string) => (kind === "no-output" ? "bad" : "warn");

/** 工程名 → 该工程的产物结论（一个工程最多一条：要么整树旧、要么整树没产物）。 */
export function artifactMarks(list: CompileDiagnostic[] | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of list ?? []) out[d.project] = d.kind;
  return out;
}
