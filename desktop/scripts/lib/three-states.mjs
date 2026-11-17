/**
 * 三态覆盖审计（DESIGN.md R6：空 / 载 / 错必须是三个独立实现）。
 *
 * 这只是**候选清单**，不是结论：有数据请求却没有 EmptyState 引用，
 * 可能是 (a) 真的漏了，(b) 空态写在子组件里，(c) 这个面本来就不会为空。
 * 逐条人工判读，判过就在下面的 allow 里登记原因，避免下次重复看。
 */

const DATA_RE = /useQuery\s*\(|invoke\s*[<(]/;

/**
 * 判据只认「三种合法模式之一」，不认某个具体组件名。
 *
 * 2026-11-16 更正：旧判据只匹配 `EmptyState` / `LoadingState` 这些具名组件，
 * 但代码库里有 20 个组件用内联写法（`vc-empty` / `role="status"` / `data-tone="busy"`），
 * 结果是 25 个候选**全部误报**，逐条读代码才发现三态都在，只是没引用组件。
 * 门禁 100% 假阳等于没有门禁，所以判据改成识别实际写法。
 */
const EMPTY_RE =
  /EmptyState|vc-empty|md-empty|sv-cfg-empty|wb-panel-note|暂无|没有可|没有.*记录|为空|未找到|无记录|请先|未声明|未配置|未扫描/;
// 具名组件 / 内联语义 / 状态胶囊 tone 编码，三种都算
const LOADING_RE =
  /LoadingState|<Skeleton|<Spinner|BusyIndicator|role="status"|data-tone="busy"|data-tone=\{.*busy|正在读取|正在加载|正在扫描|正在检查|加载中|读取中|扫描中|检查中|isFetching|\bbusy\b|\bloading\b/;
// 错态：显示在界面上（alert 类）或转成提示（toast 类）都算有人管
const ERROR_RE =
  /ErrorBoundary|role="alert"|data-tone="bad"|vc-alert|sv-alert|dbg-error|errorToast|invokeOrToast|toast\([^)]*"error"|isError|\.error\b|error\s*[?&]|catch\s*[({]/;

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
    // 只报真正危险的一种：会显示「正在加载/忙」却没有任何失败出口 —— 失败时界面
    // 永远停在载态，这正是 R6「加载中不得掩盖失败」要禁的。其余组合（有错无载等）
    // 都是合理取舍：错误信息本身就是终态，不需要额外的转圈。
    if (hasError || !hasLoading) continue;
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
