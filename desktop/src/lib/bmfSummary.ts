import type { BmfIssue } from "./bmf";

/** 按严重级统计校验结果。标题栏与校验面板共用，避免两处各写一份口径。 */
export function severityCounts(issues: BmfIssue[]): { error: number; warn: number; info: number } {
  const c = { error: 0, warn: 0, info: 0 };
  for (const i of issues) {
    if (i.severity in c) c[i.severity as keyof typeof c]++;
  }
  return c;
}
