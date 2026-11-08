import type { TransferPlan } from "../../lib/transferPlan";

/**
 * 列映射一览：搬哪些、不搬哪些、目标多哪些。
 *
 * 只读表格，不做手工改列——按名字配不上就别搬，先对比结构。手工映射听起来灵活，
 * 但「把 A 列塞进 B 列」这种错误在搬完之后根本看不出来。
 */
export function TransferPlanView({ plan }: { plan: TransferPlan }) {
  return (
    <div className="dbx-diff" style={{ marginTop: 6 }}>
      <div className="dbx-meta">
        <table>
          <thead>
            <tr>
              <th style={{ width: 240 }}>源列</th>
              <th style={{ width: 240 }}>目标列</th>
              <th>目标类型</th>
            </tr>
          </thead>
          <tbody>
            {plan.pairs.map((p) => (
              <tr key={p.from}>
                <td className="mono">{p.from}</td>
                <td className="mono">{p.to}</td>
                <td className="mono">{p.ty}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {plan.skipped.length > 0 && (
        <div className="dbx-diff-note" data-tone="warn">
          目标表没有这些列，不会搬：{plan.skipped.join("、")}
        </div>
      )}
      {plan.extra.length > 0 && (
        <div className="dbx-diff-note">
          目标表多出这些列，写入 NULL：{plan.extra.join("、")}
        </div>
      )}
    </div>
  );
}
