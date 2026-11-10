import { useCallback } from "react";
import { toast } from "../components/ui/toast";
import { isLobPreview, sameCell } from "../lib/db";
import type { Cell, ColumnMeta } from "../lib/dbApi";

/**
 * 表页的格子级编辑动作：改一格、撤回一格、一次改多格（粘贴）、复制整行。
 *
 * 抽出来的原因：`TableData` 已经贴着 300 行红线，而这些动作的判据必须集中在一处 ——
 * 「已有行」与「新增草稿行」的存储位置不同（前者在 `changed` 里、后者在 drafts 里），
 * 分散写迟早会有一条路径写错地方，写回时静默丢掉一处改动。
 */
export function useTableEdits({ base, rows, setChanged, drafts }: {
  /** 已有行的行数；`>= base` 就是新增草稿行的虚拟行号。 */
  base: number;
  rows: Cell[][] | null;
  setChanged: (update: (current: Map<string, Cell>) => Map<string, Cell>) => void;
  drafts: {
    setCell: (row: number, col: number, value: Cell) => void;
    add: (values?: Map<number, Cell>) => void;
  };
}) {
  const setCell = useCallback((row: number, col: number, value: Cell) => {
    if (row >= base) { drafts.setCell(row, col, value); return; }
    setChanged(current => {
      const next = new Map(current);
      // 改回原值就当没改过：避免「改 A→B→A」之后还留一条待写回。
      if (sameCell(value, rows?.[row]?.[col] ?? null)) next.delete(`${row}:${col}`);
      else next.set(`${row}:${col}`, value);
      return next;
    });
  }, [base, rows, setChanged, drafts]);

  /** 撤回这一格：草稿行清空该列，已有行从待写回集合里摘掉。 */
  const resetCell = useCallback((row: number, col: number) => {
    if (row >= base) { drafts.setCell(row, col, null); return; }
    setChanged(current => {
      if (!current.has(`${row}:${col}`)) return current;
      const next = new Map(current);
      next.delete(`${row}:${col}`);
      return next;
    });
  }, [base, setChanged, drafts]);

  /** 粘贴一块：草稿行走 drafts，已有行走 changed，一次 setState 落地。 */
  const setCells = useCallback((cells: { row: number; col: number; value: Cell }[]) => {
    const drafted = cells.filter(x => x.row >= base);
    for (const { row, col, value } of drafted) drafts.setCell(row, col, value);
    const existing = cells.filter(x => x.row < base);
    if (!existing.length) return;
    setChanged(current => {
      const next = new Map(current);
      for (const { row, col, value } of existing) {
        if (sameCell(value, rows?.[row]?.[col] ?? null)) next.delete(`${row}:${col}`);
        else next.set(`${row}:${col}`, value);
      }
      return next;
    });
  }, [base, rows, setChanged, drafts]);

  /**
   * 复制整行成新增行。主键列刻意留空：主键值照抄一定会撞唯一约束，
   * 留空让数据库默认值（序列 / SYS_GUID）或用户自己填。
   *
   * 大文本预览也不能照抄：那只是前 8K + 一段说明，插进去就是永久截断的数据。
   * 跳过该列并在提示里点名，让用户自己重新填或走 SQL。
   */
  const cloneRow = useCallback((row: number, pkCols: number[], columns?: ColumnMeta[]) => {
    const values = new Map<number, Cell>();
    const skipped: string[] = [];
    (rows?.[row] ?? []).forEach((value, col) => {
      if (pkCols.includes(col) || value === null) return;
      if (isLobPreview(value)) { skipped.push(columns?.[col]?.name ?? String(col + 1)); return; }
      values.set(col, value);
    });
    if (skipped.length) toast(`复制行时跳过了大文本列 ${skipped.join("、")}：网格里只有前 8K，请重新填写或改用 SQL`, "warning");
    drafts.add(values);
  }, [rows, drafts]);

  return { setCell, resetCell, setCells, cloneRow };
}
