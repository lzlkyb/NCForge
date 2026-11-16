/**
 * 三态覆盖审计（DESIGN.md R6：空 / 载 / 错必须是三个独立实现）。
 *
 * 这只是**候选清单**，不是结论：有数据请求却没有 EmptyState 引用，
 * 可能是 (a) 真的漏了，(b) 空态写在子组件里，(c) 这个面本来就不会为空。
 * 逐条人工判读，判过就在下面的 allow 里登记原因，避免下次重复看。
 */

const DATA_RE = /useQuery\s*\(|invoke\s*[<(]/;
const EMPTY_RE = /EmptyState/;
const LOADING_RE = /LoadingState|Skeleton|BusyIndicator|Spinner/;
const ERROR_RE = /ErrorBoundary|errorState|error\s*&&|catch\s*\(/;

/** 已判读为「不需要」的文件 → 理由。新增条目要写清为什么。 */
export const ALLOW = {
  "src/components/ui/Skeleton.tsx": "它本身就是载态实现",
  "src/components/ui/Spinner.tsx": "它本身就是载态实现",
  "src/components/ui/LoadingState.tsx": "它本身就是载态实现",
  "src/components/ui/EmptyState.tsx": "它本身就是空态实现",
};

export function audit(files) {
  const rows = [];
  for (const file of files) {
    if (!DATA_RE.test(file.text)) continue;
    // hooks 不直接渲染，三态由调用方负责；把它们算进来只会制造噪音。
    if (file.path.includes("/hooks/")) continue;
    if (file.path in ALLOW) continue;
    const hasEmpty = EMPTY_RE.test(file.text);
    const hasLoading = LOADING_RE.test(file.text);
    const hasError = ERROR_RE.test(file.text);
    if (hasEmpty && hasLoading && hasError) continue;
    const missing = [];
    if (!hasEmpty) missing.push("空");
    if (!hasLoading) missing.push("载");
    if (!hasError) missing.push("错");
    rows.push({ path: file.path, missing });
  }
  return rows.sort((a, b) => b.missing.length - a.missing.length || a.path.localeCompare(b.path));
}

export function formatReport(rows) {
  if (!rows.length) return "所有含数据请求的组件都具备空/载/错三态。";
  const lines = [`待判读 ${rows.length} 个文件（缺态越多越靠前）：`];
  for (const row of rows) lines.push(`  - ${row.path}  缺：${row.missing.join(" / ")}`);
  lines.push("", "判读后：真缺就补；不需要就登记到 ALLOW 并写明理由。");
  return lines.join("\n");
}
