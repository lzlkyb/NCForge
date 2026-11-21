import type { ContextMenuItem } from "../components/workspace/ContextMenu";
import type { Cell, ColumnMeta } from "./dbApi";
import type { GridEdit } from "../components/db/gridEdit";
import { selectionBounds } from "./gridViewport";
import { selectedEditableCells } from "./gridSelection";
import { quickCopyTransfer } from "./resultTransferQuick";
import { cellBrief, type ValueFilter } from "./resultView";
import { rowActionItems } from "./dbRowActions";
import type { ResultFilterMatch } from "./dbResultFollowup";
import type { TransferFrame } from "./resultTransferContext";
import { toast } from "../components/ui/toast";

export interface CellMenuDeps {
  r: number; c: number;
  /** 整表帧（当前筛选 / 排序 / 列序），「复制原始值」等按它取数。 */
  frame: TransferFrame;
  /** 当前选区的可视边界；没有选区时点哪格就把菜单缩到哪格。 */
  bounds: { rowStart: number; rowEnd: number; colStart: number; colEnd: number } | null;
  order: number[]; visible: number[];
  rows: Cell[][]; columns: ColumnMeta[];
  edit?: GridEdit;
  /** 网格当前显示值（含未写回的编辑草稿）。 */
  valueAt: (r: number, c: number) => Cell;
  /** 「按此值重新查询」（表页 / 支持重查的结果才有）。 */
  requery?: (match: ResultFilterMatch) => void;
  select: (p: { r: number; c: number }, extend?: boolean) => void;
  setDetail: (detail: boolean) => void;
  setValueFilter: (value: (ValueFilter & { original?: Cell }) | null) => void;
  /** 点在选区外时先把选区落到这一格（原 ResultTable 口径：菜单动作作用于「即将选中」的格）。 */
  onFocusCell: () => void;
}

/**
 * 单元格右键菜单项。从 `ResultTable` 抽出来只为守住 300 行体量红线，口径原样搬走。
 *
 * 菜单分四组，顺序即优先级：查看 / 筛选 / 复制 / 编辑。编辑相关只在这一格真能改时
 * 出现（主键列、只读类型、视图都没有）；删除是「对着这一行」的动作，走 `rowActionItems`
 * 而不是按会漂移的选中态定位。
 */
export function cellMenuItems(d: CellMenuDeps): ContextMenuItem[] {
  const { r, c, frame, bounds, order, visible, rows, columns, edit, valueAt, requery } = d;
  const cell = { ...frame, selection: { anchor: { r, c }, end: { r, c } } };
  const column = { ...cell, selection: null, visible: [c] };
  const rowIndex = order.indexOf(r), colIndex = visible.indexOf(c);
  const inside = !!bounds && rowIndex >= bounds.rowStart && rowIndex <= bounds.rowEnd && colIndex >= bounds.colStart && colIndex <= bounds.colEnd;
  const menuFrame = inside ? frame : cell;
  const menuBounds = selectionBounds(order, visible, menuFrame.selection);
  if (!inside) d.onFocusCell();
  const cellCount = menuBounds ? (menuBounds.rowEnd - menuBounds.rowStart + 1) * (menuBounds.colEnd - menuBounds.colStart + 1) : 1;
  const selectedCells = () => edit && menuBounds ? selectedEditableCells(menuBounds, order, visible, edit.canEdit) : [];
  return [
    // 双击只负责编辑，看完整值要有明确入口：右键第一项 + F4 + 工具栏详情按钮。
    { label: "查看完整值", icon: "eye", hint: "F4", onSelect: () => { d.select({ r, c }); d.setDetail(true); } },
    // 「以此值筛选」读的是 `rows` 里的原值，不是未写回的编辑草稿：本地筛选只作用于
    // 已取到的数据，拿编辑后的值去筛会立刻筛出 0 行。
    { label: (() => { const v = rows[r]?.[c] ?? null; return v === null ? "只看这一列为空" : `只看「${cellBrief(v)}」`; })(),
      icon: "filter", hint: columns[c]?.name, onSelect: () => { const v = rows[r]?.[c] ?? null; d.setValueFilter({ col: c, original: v, value: v === null ? null : String(v) }); } },
    ...(requery && rows[r]?.[c] !== undefined && !edit?.isDraftRow?.(r) ? [{ label: "按此值重新查询", icon: "database" as const, onSelect: () => requery({ column: c, value: rows[r][c] }) }] : []),
    { label: "复制原始值", icon: "copy", separator: true, onSelect: () => void quickCopyTransfer(cell, "tsv", true, edit?.changed) },
    ...(cellCount > 1 ? [{ label: `复制 ${cellCount} 个单元格`, icon: "copy" as const, onSelect: () => void quickCopyTransfer(menuFrame, "tsv", false, edit?.changed) }] : []),
    { label: "复制列名", onSelect: () => void navigator.clipboard.writeText(columns[c].name).then(() => toast("列名已复制", "success"), e => toast(`复制失败：${String(e)}`, "error")) },
    { label: "复制唯一值（当前筛选列）", onSelect: () => { const seen = new Set<Cell>(); const order = column.order.filter(i => { const key = valueAt(i, c); if (seen.has(key)) return false; seen.add(key); return true; }); void quickCopyTransfer({ ...column, order }, "tsv", false, edit?.changed); } },
    { label: "复制为 IN 条件（当前筛选列）", icon: "code", onSelect: () => void quickCopyTransfer(column, "where", false, edit?.changed) },
    // 编辑相关动作只在「这一格真能改」时出现：主键列、只读类型、视图都没有这些项。
    ...(edit?.canEdit(c, r) ? [
      // 选中一列再置空是最常用的批量动作：有选区就作用整个选区，没选区就是这一格。
      { label: selectedCells().length > 1 ? `选区设为 NULL（${selectedCells().length} 格）` : "设为 NULL",
        hint: "写回时这些列置空",
        onSelect: () => {
          const cells = selectedCells();
          if (edit.onEditMany && cells.length > 1) edit.onEditMany(cells.map(cell => ({ ...cell, value: null })));
          else cells.forEach(cell => edit.onEdit(cell.row, cell.col, null));
        } },
      ...(edit.changed.has(`${r}:${c}`) && edit.onResetCell
        ? [{ label: "撤销本格改动", icon: "restore" as const, separator: true,
            onSelect: () => {
              const cells = selectedCells();
              if (cells.length > 1) cells.forEach(cell => edit.onResetCell!(cell.row, cell.col));
              else edit.onResetCell!(r, c);
            } }]
        : []),
    ] : []),
    ...(edit?.onCloneRow ? [{ label: "复制此行（新增）", icon: "copy" as const, hint: "主键列留空", onSelect: () => edit.onCloneRow!(r) }] : []),
    ...rowActionItems(edit, r),
  ];
}
