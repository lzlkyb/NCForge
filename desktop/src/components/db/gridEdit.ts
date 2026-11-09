import type { Cell } from "../../lib/dbApi";

/** 单元格位置：`r` 是原始行号（rows 下标），不是排序/筛选后的显示顺序。 */
export interface CellPos {
  r: number;
  c: number;
}

/**
 * 网格的编辑能力。表页（可写回）提供，SQL 控制台不提供。
 *
 * 行级增删只影响**显示**（行底色 + 行号标记）：`order`、`rows` 与复制/导出语义
 * 始终按真实行来，否则「看到的行」和「写回的行」会错位。
 */
export interface GridEdit {
  /**
   * 这一格能不能编辑。`row` 是原始行号：新增草稿行要允许填主键列，
   * 已有行的主键列则不能改（改了定位不到原行）。
   */
  canEdit: (col: number, row?: number) => boolean;
  /** 改过的格子：`行:列` → 新值。 */
  changed: Map<string, Cell>;
  onEdit: (row: number, col: number, value: Cell) => void;
  /**
   * 撤回这一格的改动，回到库里的原值（Esc / 右键「撤销本格改动」）。
   * 不传 = 这个结果不支持单格撤销。
   */
  onResetCell?: (row: number, col: number) => void;
  /** 一次改多格：粘贴一块、批量赋值。不传 = 只能逐格改。 */
  onEditMany?: (cells: { row: number; col: number; value: Cell }[]) => void;
  /** 复制这一行（克隆成新增行）。不传 = 这个结果不支持。 */
  onCloneRow?: (row: number) => void;
  /** 行级状态：新增草稿 / 待删除。 */
  rowState?: (row: number) => "added" | "deleted" | undefined;
  /** 右键「删除此行 / 恢复此行」。不传 = 这个结果不支持行级删除（表页无主键 / 只读）。 */
  onDeleteRow?: (row: number) => void;
  onRestoreRow?: (row: number) => void;
  /** 新增行草稿：草稿行不能删（还没进库），只能撤销。 */
  isDraftRow?: (row: number) => boolean;
}

/** 网格对外暴露的命令式入口（目前只有「焦点回到活动单元格」）。 */
export interface ResultGridApi { focusActive: () => void }
