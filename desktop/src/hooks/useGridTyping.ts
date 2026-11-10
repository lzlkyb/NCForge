import { useCallback } from "react";
import { selectedEditableCells } from "../lib/gridSelection";
import { parseClipboardGrid, pasteTargets } from "../lib/gridPaste";
import type { CellPos, GridEdit } from "../components/db/gridEdit";

/**
 * 「打字即编辑」的两种入口，从 `ResultGrid` 抽出来只为守住 300 行体量红线。
 *
 * 1. **选区批量赋值**（DBeaver / Excel 的肌肉记忆）：选中一片格子直接打字，
 *    键入的字符填满整个选区，然后停在活动格里接着输入——再按 Enter 只会
 *    提交活动格（此时它的值已经是完整输入），其余格子保持刚才那一字。
 *    只有一格时就是普通的「打字即替换并进入编辑」。
 * 2. **Shift+Enter 大文本编辑框**：单元格只有几十 px 宽，在里面改长文本等于
 *    盲打，所以弹出 `GridTextEditor`；非编辑态也能用，带上原值进去改。
 */
export function useGridTyping({ sel, edit, bounds, order, visible, beginEdit, startEdit }: {
  sel: CellPos | null;
  edit?: GridEdit;
  bounds: Parameters<typeof selectedEditableCells>[0];
  order: number[];
  visible: number[];
  /** 进入编辑；带 seed 时用 seed 当初始值。返回 false = 这一格不能编辑。 */
  beginEdit: (pos: CellPos, seed?: string) => boolean;
  /** 不能编辑时给一次提示的包装版。 */
  startEdit: (pos: CellPos) => void;
}) {
  const typeInto = useCallback((ch: string) => {
    if (!sel || !edit?.canEdit(sel.c, sel.r)) return;
    const cells = selectedEditableCells(bounds, order, visible, edit.canEdit);
    if (cells.length > 1 && edit.onEditMany) edit.onEditMany(cells.map(cell => ({ ...cell, value: ch })));
    beginEdit(sel, ch);
  }, [sel, edit, bounds, order, visible, beginEdit]);

  /** Shift+Enter = 打开大文本编辑框。非编辑态也能用：带上原值进去改。 */
  const openTextEditor = useCallback(() => {
    if (!sel || !beginEdit(sel)) { startEdit(sel!); return; }
    return true;
  }, [sel, beginEdit, startEdit]);

  /**
   * Ctrl+V：把剪贴板里那一块从活动格铺开；只粘一个值时铺满当前选区。
   * 返回 true = 这个网格接了粘贴，调用方要 `preventDefault`（返回 false 时交给浏览器默认行为）。
   */
  const paste = useCallback((text: string) => {
    if (!edit?.onEditMany || !sel) return false;
    const cells = pasteTargets(parseClipboardGrid(text), sel, bounds, order, visible, (c, r) => edit.canEdit(c, r));
    if (cells.length) edit.onEditMany(cells);
    return true;
  }, [edit, sel, bounds, order, visible]);

  return { typeInto, openTextEditor, paste };
}
