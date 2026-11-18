import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { Cell } from "../lib/dbApi";
import type { RowChange } from "../lib/dbOptimisticEdit";
import { useRowDrafts } from "./useRowDrafts";

/**
 * 结果页的行级草稿操作：空白新增、逐项撤回、全部撤回的原料。
 *
 * 从 `useResultSetEdit` 抽出来守住体量门禁。写回预览弹窗要的
 * 「+ 新增行 / 撤销此项」与工具条的「撤销改动」是同一组动作的三个面，
 * 放在一起才不会两边口径走偏。
 */
export function useResultSetDrafts(rows: Cell[][], columnCount: number, setChanged: Dispatch<SetStateAction<Map<string, Cell>>>) {
  const drafts = useRowDrafts(rows, columnCount);
  /** 空白新增行：与表页「+ 新增行」同口径，主键列留空由用户填。 */
  const addRow = useCallback(() => drafts.add(), [drafts]);
  /**
   * 撤回单条待写回变更（写回预览弹窗里逐项撤销）。
   * update 清掉改动格子即可（显示行回落到快照原值）；insert 是虚拟行号的
   * 草稿行、delete 是真实行号上的标记，`drafts` 各自认得，走同一条 restoreRow。
   */
  const undoChange = useCallback((change: RowChange) => {
    if (change.kind === "update") {
      setChanged(current => {
        const next = new Map(current);
        change.cells.forEach(x => next.delete(`${change.row}:${x.column}`));
        return next;
      });
      return;
    }
    drafts.restoreRow(change.row);
  }, [drafts, setChanged]);
  return { drafts, addRow, undoChange };
}
