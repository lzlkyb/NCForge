import type { ContextMenuItem } from "../components/workspace/ContextMenu";
import type { GridEdit } from "../components/db/gridEdit";

/**
 * 行级增删的右键菜单项（单元格右键里「删除此行 / 恢复此行 / 撤销这行新增」）。
 *
 * 从 `ResultTable` 抽出来只为守住 300 行体量红线：三种状态的口径原样搬走。
 *
 * 挂在单元格右键而不是工具条：删除是「对着这一行」的动作，而选中态会随
 * 排序 / 筛选漂移——按当前行的原始行号定位才不会指错行。
 */
export function rowActionItems(edit: GridEdit | undefined, r: number): ContextMenuItem[] {
  if (!edit?.rowState) return [];
  if (edit.isDraftRow?.(r)) return [{ label: "撤销这行新增", icon: "restore", separator: true, onSelect: () => edit.onRestoreRow?.(r) }];
  if (edit.rowState(r) === "deleted") return [{ label: "恢复此行（取消删除）", icon: "restore", separator: true, onSelect: () => edit.onRestoreRow?.(r) }];
  if (!edit.onDeleteRow) return [];
  return [{ label: "删除此行", icon: "trash", danger: true, separator: true, hint: "写回时执行", onSelect: () => edit.onDeleteRow!(r) }];
}
