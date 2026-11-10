import { CodePreview } from "./CodePreview";
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
  const [query,setQuery]=useState("");
  const [collapsed,setCollapsed]=useState<Set<PlanNode["row"]>>(new Set());
  useEffect(()=>{setCollapsed(new Set());setQuery("");},[plan]);

  // 换了 SQL（同一个标签里又查了另一条计划）要换对照，否则会拿 A 的计划比 B
  useEffect(() => {
    setSaved(loadPlan(connId, plan.sql));
  }, [connId, plan.sql]);

  if (plan.error) return <div className="dbx-err">{plan.error}</div>;
  const tree = buildPlanTree(plan.rows);
  const needle=query.trim().toLocaleLowerCase();
  const matches=(node:PlanNode):boolean=>[node.row.operation,node.row.object,node.row.access,node.row.filter].some(value=>value?.toLocaleLowerCase().includes(needle)) || node.children.some(matches);
  const flat:PlanNode[]=[];
  const visit=(nodes:PlanNode[])=>nodes.forEach(node=>{if(needle && !matches(node))return;flat.push(node);if(needle || !collapsed.has(node.row))visit(node.children);});
  visit(tree);
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
      <div className="dbx-reading-tools"><input aria-label="搜索执行计划" placeholder="对象 / 操作 / 谓词" value={query} onChange={e=>setQuery(e.target.value)}/><button type="button" className="dbx-btn" onClick={()=>setCollapsed(new Set())}>展开全部</button><button type="button" className="dbx-btn" disabled={!!needle} title={needle ? "搜索时保留匹配节点及其上级，清空搜索后可收起" : "收起所有子节点"} onClick={()=>setCollapsed(new Set(plan.rows))}>收起全部</button></div>
      <p className="dbx-plan-note">成本与行数为优化器估算，不代表实际耗时。搜索时显示匹配节点及其上级。</p>
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
          {flat.length === 0 && <tr><td colSpan={5}>{needle ? "没有匹配的计划节点，请调整关键词。" : "没有可显示的执行计划。"}</td></tr>}
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
                  {n.children.length ? <button type="button" className="dbx-plan-toggle" aria-expanded={!!needle || !collapsed.has(r)} aria-label={`${collapsed.has(r) ? "展开" : "收起"} ${r.operation}`} disabled={!!needle} onClick={()=>setCollapsed(before=>{const next=new Set(before);if(next.has(r))next.delete(r);else next.add(r);return next;})}><Icon name={collapsed.has(r) && !needle ? "chevronRight" : "chevronDown"} size={12}/>{r.operation}</button> : r.operation}
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
                  {r.access && <details><summary>访问谓词</summary><CodePreview text={r.access} label="访问谓词"/></details>}
                  {r.filter && <details><summary>过滤谓词</summary><CodePreview text={r.filter} label="过滤谓词"/></details>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
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
