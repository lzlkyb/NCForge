import type { Cell, ColumnMeta } from "../../lib/dbApi";
import type { RowChange } from "../../lib/dbOptimisticEdit";

export function ChangeReview({ changes, columns, rows, pk, disabled, onUndo }: { changes: RowChange[]; columns: ColumnMeta[]; rows: Cell[][]; pk: string[]; disabled?:boolean; onUndo: (key: string) => void }) {
  const text = (v: Cell) => v === null ? "NULL" : String(v);
  return <section className="dbx-change-review" aria-label="数据修改复核">
    <h3>待写回 {changes.length} 行 · 将校验原值，冲突时停止</h3>
    <table><thead><tr><th>记录主键</th><th>字段</th><th>原值</th><th>新值</th><th>操作</th></tr></thead><tbody>
      {changes.flatMap(r => r.cells.map(c => <tr key={`${r.row}:${c.column}`}>
        <td>{pk.map(n => `${n}=${text(rows[r.row][columns.findIndex(col => col.name.toUpperCase() === n.toUpperCase())])}`).join(" · ")}</td><td>{columns[c.column].name}</td><td>{text(c.before)}</td><td>{text(c.after)}</td><td><button type="button" className="dbx-btn" disabled={disabled} onClick={() => onUndo(`${r.row}:${c.column}`)}>撤销此项</button></td>
      </tr>))}
    </tbody></table>
  </section>;
}
