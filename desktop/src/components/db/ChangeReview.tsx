import type { Cell, ColumnMeta } from "../../lib/dbApi";
import type { RowChange } from "../../lib/dbOptimisticEdit";

/**
 * 写回前的变更复核：新增 / 修改 / 删除三类一起列出来。
 *
 * 新增行没有主键值可显示，删除行没有字段级差异——两者都用一行摘要，
 * 免得表格里出现一堆空白格让人以为「没勾上」。
 */
export function ChangeReview({ changes, columns, rows, pk, disabled, onUndo }: {
  changes: RowChange[];
  columns: ColumnMeta[];
  rows: Cell[][];
  pk: string[];
  disabled?: boolean;
  onUndo: (change: RowChange) => void;
}) {
  const text = (v: Cell) => v === null ? "NULL" : String(v);
  const keyText = (change: RowChange) => {
    if (change.kind === "insert") return "（新增行）";
    const row = rows[change.row] ?? [];
    return pk.map(n => {
      const c = columns.findIndex(col => col.name.toUpperCase() === n.toUpperCase());
      return `${n}=${text(c >= 0 ? row[c] : null)}`;
    }).join(" · ");
  };
  const kindLabel = { insert: "新增", update: "修改", delete: "删除" } as const;

  return <section className="dbx-change-review" aria-label="数据修改复核">
    <h3>待写回 {changes.length} 条 · 按「删 → 改 → 增」执行，冲突时停止</h3>
    <table><thead><tr><th>记录主键</th><th>类型</th><th>字段</th><th>原值</th><th>新值</th><th>操作</th></tr></thead><tbody>
      {changes.flatMap(change => {
        const head = <tr key={`${change.kind}:${change.row}`}>
          <td>{keyText(change)}</td>
          <td>{kindLabel[change.kind]}</td>
          <td colSpan={3} className="dbx-change-scope">
            {change.kind === "delete" ? "整行删除" : change.kind === "insert" ? `写入 ${change.cells.length} 个列` : `${change.cells.length} 个字段`}
          </td>
          <td rowSpan={change.kind === "update" ? change.cells.length : 1}>
            <button type="button" className="dbx-btn" disabled={disabled} onClick={() => onUndo(change)}>撤销此项</button>
          </td>
        </tr>;
        if (change.kind !== "update") return [head];
        return [head, ...change.cells.map(c => <tr key={`${change.kind}:${change.row}:${c.column}`}>
          <td aria-hidden="true" />
          <td aria-hidden="true" />
          <td>{columns[c.column].name}</td>
          <td>{text(c.before)}</td>
          <td>{text(c.after)}</td>
        </tr>)];
      })}
    </tbody></table>
  </section>;
}
