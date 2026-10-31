import { useEffect, useState } from "react";
import type { PlanRow } from "../../lib/dbApi";
import { thousands } from "../../lib/db";
import {
  buildPlanTree,
  diffPlans,
  diffSummary,
  nodeKey,
  savedPlanKey,
  type PlanNode,
  type SavedPlan,
} from "../../lib/planTree";
import { Icon } from "../ui/icon";

/**
 * 执行计划：树形缩进 + 成本条（A5），外加「保存对照 / 与上次对比」。
 *
 * 平表渲染（后端给的是 `depth` 拍平的数组）要人数空格认父子关系；这里按 depth 折成树。
 * 大表全表扫描标黄——NC 二开里最常见的慢 SQL 原因。
 *
 * 对比的用法是「加索引前后各查一次」：先「保存为对照」，改完再查一次，顶部直接给出
 * 总成本变化与新增/消失的步骤。
 */
export function PlanView({ plan, connId }: {
  plan: { sql: string; rows: PlanRow[]; error?: string };
  /** 对照计划按连接分开存（两个库的同一条 SQL 不该互相覆盖）。 */
  connId?: string | null;
}) {
  const [saved, setSaved] = useState<SavedPlan | null>(null);
  const [compare, setCompare] = useState(true);

  // 换了 SQL（同一个标签里又查了另一条计划）要换对照，否则会拿 A 的计划比 B
  useEffect(() => {
    setSaved(loadPlan(connId, plan.sql));
  }, [connId, plan.sql]);

  if (plan.error) return <div className="dbx-err">{plan.error}</div>;
  const tree = buildPlanTree(plan.rows);
  const flat = flatten(tree);
  const max = Math.max(1, ...plan.rows.map((r) => r.cost ?? 0));
  const diff = saved && compare ? diffPlans(saved.rows, plan.rows) : null;
  const addedKeys = new Set(diff?.added.map(nodeKey) ?? []);
  const removedKeys = new Set(diff?.removed.map(nodeKey) ?? []);

  const save = () => {
    const entry: SavedPlan = { at: Date.now(), sql: plan.sql, rows: plan.rows };
    try {
      localStorage.setItem(savedPlanKey(connId, plan.sql), JSON.stringify(entry));
    } catch {
      // 存不下（隐私模式 / 配额满）：本次会话内仍然可用
    }
    setSaved(entry);
  };

  return (
    <div className="dbx-plan">
      <div className="dbx-planbar">
        <span className="dbx-muted">
          {plan.rows.length} 个步骤
          {saved && <> · 对照保存于 {new Date(saved.at).toLocaleString("zh-CN")}</>}
        </span>
        <span className="dbx-sp" />
        <button type="button" className="dbx-btn ghost" onClick={save} title="把当前计划存为对照（同一连接、同一条 SQL 只留最后一次）">
          <Icon name="check" size={12} />
          保存为对照
        </button>
        <button
          type="button"
          className="dbx-btn ghost"
          data-on={(compare && !!saved) || undefined}
          disabled={!saved}
          title={saved ? "显示与保存的那次计划的差异" : "还没有对照：先「保存为对照」"}
          onClick={() => setCompare(!compare)}
        >
          <Icon name="activity" size={12} />
          与上次对比
        </button>
      </div>
      {diff && <div className="dbx-plandiff" data-worse={(diff.costAfter ?? 0) > (diff.costBefore ?? 0) || undefined}>{diffSummary(diff)}</div>}
      <table>
        <thead>
          <tr>
            <th>操作</th>
            <th>对象</th>
            <th>成本</th>
            <th>估算行数</th>
            <th>谓词</th>
          </tr>
        </thead>
        <tbody>
          {flat.map((n, i) => {
            const r = n.row;
            const full = /TABLE ACCESS FULL/i.test(r.operation) && (r.rows ?? 0) >= 1000;
            const key = nodeKey(r);
            const tag = addedKeys.has(key) ? "new" : removedKeys.has(key) ? "gone" : undefined;
            return (
              <tr
                key={i}
                data-full={full || undefined}
                data-diff={tag}
                title={full ? "大表全表扫描：看看条件列上有没有索引" : undefined}
              >
                <td className="op" style={{ paddingLeft: 8 + n.depth * 18 }}>
                  {n.depth > 0 && <span className="dbx-planline">└ </span>}
                  {r.operation}
                  {tag === "new" && <span className="dbx-planbadge">新增</span>}
                  {tag === "gone" && <span className="dbx-planbadge gone">消失</span>}
                </td>
                <td className="dbx-mono">{r.object.toLowerCase()}</td>
                <td>
                  {r.cost !== null && (
                    <>
                      <span className="bar" style={{ width: Math.max(2, Math.round((60 * r.cost) / max)) }} />
                      {thousands(r.cost)}
                    </>
                  )}
                </td>
                <td>{r.rows !== null ? thousands(r.rows) : ""}</td>
                <td className="pred">
                  {r.access && <div>access: {r.access}</div>}
                  {r.filter && <div>filter: {r.filter}</div>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** 树 → 行序（父在前，子按原顺序）。渲染仍然是表格，缩进靠 depth。 */
function flatten(nodes: PlanNode[]): PlanNode[] {
  const out: PlanNode[] = [];
  const walk = (ns: PlanNode[]) => {
    for (const n of ns) {
      out.push(n);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

function loadPlan(connId: string | null | undefined, sql: string): SavedPlan | null {
  try {
    const raw = localStorage.getItem(savedPlanKey(connId, sql));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<SavedPlan>;
    if (!Array.isArray(v.rows)) return null;
    return { at: v.at ?? 0, sql: v.sql ?? sql, rows: v.rows as PlanRow[] };
  } catch {
    return null;
  }
}
