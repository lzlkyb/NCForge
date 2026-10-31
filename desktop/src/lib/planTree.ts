import type { PlanRow } from "./dbApi";

/**
 * 执行计划的树形化与两次对比（A5）。
 *
 * 后端给的是 `depth` 拍平的数组（`start with id=0 connect by prior id=parent_id`），
 * 平表渲染会让人靠缩进数空格去认父子关系。这里把它折成树，另外把「同一条 SQL
 * 加索引前后的两次计划」对比出来——这才是 `explain` 的实际用法。
 */

export interface PlanNode {
  row: PlanRow;
  depth: number;
  children: PlanNode[];
}

/**
 * 按 `depth` 折成树。`depth` 跳级（比如 0 → 2）时按父子直连处理：
 * 计划表偶尔会因为 `order siblings by` 与实际父子关系不一致出现跳级，
 * 这时候插空节点比丢掉整棵子树好。
 */
export function buildPlanTree(rows: PlanRow[]): PlanNode[] {
  const roots: PlanNode[] = [];
  const stack: PlanNode[] = [];
  for (const row of rows) {
    const node: PlanNode = { row, depth: row.depth, children: [] };
    while (stack.length > 0 && stack[stack.length - 1].depth >= node.depth) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else roots.push(node);
    stack.push(node);
  }
  return roots;
}

/** 节点身份：同一 `operation + object` 在两次计划里视为同一个节点（成本可比）。 */
export function nodeKey(row: PlanRow): string {
  const obj = (row.object ?? "").trim().toUpperCase();
  return `${(row.operation ?? "").trim().toUpperCase()}|${obj}`;
}

/** 整条计划的成本：Oracle 的计划成本是累计值，根节点就是总数。 */
export function totalCost(rows: PlanRow[]): number | null {
  const root = rows.find((r) => r.depth === 0) ?? rows[0];
  return root?.cost ?? null;
}

export interface PlanDiff {
  /** 新增的节点（上次没有、这次有）。 */
  added: PlanRow[];
  /** 消失的节点。 */
  removed: PlanRow[];
  /** 同一个节点成本变了。 */
  changed: { key: string; before: number; after: number }[];
  costBefore: number | null;
  costAfter: number | null;
  /** 总成本变化百分比；任一侧读不到成本时为 null（**不写 0%**）。 */
  costDelta: number | null;
}

/** 两次计划对比。`before` 是存下来的那次，`after` 是刚查出来的这次。 */
export function diffPlans(before: PlanRow[], after: PlanRow[]): PlanDiff {
  const beforeMap = new Map(before.map((r) => [nodeKey(r), r]));
  const afterMap = new Map(after.map((r) => [nodeKey(r), r]));
  const added = after.filter((r) => !beforeMap.has(nodeKey(r)));
  const removed = before.filter((r) => !afterMap.has(nodeKey(r)));
  const changed: PlanDiff["changed"] = [];
  for (const [key, b] of beforeMap) {
    const a = afterMap.get(key);
    if (!a || b.cost === null || a.cost === null) continue;
    if (a.cost !== b.cost) changed.push({ key, before: b.cost, after: a.cost });
  }
  const costBefore = totalCost(before);
  const costAfter = totalCost(after);
  let costDelta: number | null = null;
  if (costBefore !== null && costAfter !== null) {
    // 成本从 0 涨到非 0 时百分比没有意义，直接给 null，界面上只显示绝对值
    costDelta = costBefore > 0 ? Math.round(((costAfter - costBefore) / costBefore) * 1000) / 10 : null;
  }
  return { added, removed, changed, costBefore, costAfter, costDelta };
}

/** 对比结论的一句话（界面顶部那行）。没有变化时明确说「没有变化」。 */
export function diffSummary(d: PlanDiff): string {
  const parts: string[] = [];
  if (d.costBefore !== null && d.costAfter !== null) {
    const sign = d.costAfter - d.costBefore;
    const dir = sign === 0 ? "持平" : sign > 0 ? "变差" : "变好";
    const pct = d.costDelta === null ? "" : `（${d.costDelta > 0 ? "+" : ""}${d.costDelta}%）`;
    parts.push(`总成本 ${d.costBefore} → ${d.costAfter}${pct}：${dir}`);
  }
  if (d.added.length > 0) parts.push(`新增 ${d.added.length} 个步骤`);
  if (d.removed.length > 0) parts.push(`减少 ${d.removed.length} 个步骤`);
  if (d.changed.length > 0) parts.push(`${d.changed.length} 个步骤成本变化`);
  return parts.length === 0 ? "与上次计划没有变化" : parts.join("；");
}

/** 本地保存的对照计划（键里带连接，避免两个库同一条 SQL 互相覆盖）。 */
export interface SavedPlan {
  at: number;
  sql: string;
  rows: PlanRow[];
}

export function savedPlanKey(connId: string | null | undefined, sql: string): string {
  // 只做「稳定短键」：不需要抗碰撞，同一连接同一条 SQL 落在同一个键上就够
  let h = 0;
  for (let i = 0; i < sql.length; i++) h = (h * 31 + sql.charCodeAt(i)) | 0;
  return `ncforge-db-plan:${connId ?? "none"}:${(h >>> 0).toString(36)}`;
}
