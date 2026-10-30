import type { PlanRow } from "../../lib/dbApi";
import { thousands } from "../../lib/db";

/** 执行计划：树形缩进 + 成本条。大表全表扫描标黄——NC 二开里最常见的慢 SQL 原因。 */
export function PlanView({ plan }: { plan: { sql: string; rows: PlanRow[]; error?: string } }) {
  if (plan.error) return <div className="dbx-err">{plan.error}</div>;
  const max = Math.max(1, ...plan.rows.map((r) => r.cost ?? 0));
  return (
    <div className="dbx-plan">
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
          {plan.rows.map((r, i) => {
            const full = /TABLE ACCESS FULL/i.test(r.operation) && (r.rows ?? 0) >= 1000;
            return (
              <tr key={i} data-full={full || undefined} title={full ? "大表全表扫描：看看条件列上有没有索引" : undefined}>
                <td className="op">{"  ".repeat(r.depth) + r.operation}</td>
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
