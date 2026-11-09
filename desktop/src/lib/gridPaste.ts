import type { Cell } from "./dbApi";

/**
 * 把剪贴板文本解析成二维单元格（从 Excel / 文本编辑器粘进来的那一块）。
 *
 * 口径与 Excel 的复制格式一致：格子之间是 `\t`，行之间是换行；字段被 `"` 包住时，
 * 里面的 `\t`、换行都是值的一部分，`""` 表示一个字面双引号。Excel 复制含换行的
 * 单元格时就是这个形态，所以不能简单按 `\t`/`\n` 切。
 *
 * 空字段给 `null` 而不是空串：Oracle 里空串就是 NULL，网格显示与写回 SQL 都按
 * NULL 走（与 `commitEdit` 的既有口径一致）。
 */
export function parseClipboardGrid(text: string): Cell[][] {
  const src = text.replace(/\r\n?/g, "\n");
  if (!src) return [];
  const rows: Cell[][] = [];
  let row: Cell[] = [];
  let field = "";
  let quoted = false;
  let fieldStart = true;
  const endField = () => { row.push(field === "" ? null : field); field = ""; fieldStart = true; };
  const endRow = () => { endField(); rows.push(row); row = []; };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch !== '"') { field += ch; continue; }
      if (src[i + 1] === '"') { field += '"'; i++; continue; }
      quoted = false;
      continue;
    }
    if (ch === '"' && fieldStart) { quoted = true; fieldStart = false; continue; }
    if (ch === "\t") { endField(); continue; }
    if (ch === "\n") { endRow(); continue; }
    field += ch;
    fieldStart = false;
  }
  endRow();
  // Excel 复制整块时常带一个尾部换行，那不是用户想粘的一整行空值。
  const last = rows[rows.length - 1];
  if (rows.length > 1 && last.length === 1 && last[0] === null) rows.pop();
  return rows;
}

/**
 * 粘贴落点：从 `start` 起按行列铺开，返回要改的格子。
 *
 * 三种来源混在一起时按 Excel 直觉处理：
 * - 只粘了一格 → 铺满整个选区（DataGrip 的「选中一列，粘一个值」）；
 * - 粘了多格 → 从活动格开始按块铺开，超出行/列范围的部分静默丢弃；
 * - 目标格不可编辑（主键列、只读类型）→ 跳过那一格，不打断整块。
 */
export function pasteTargets(
  grid: Cell[][],
  start: { r: number; c: number },
  bounds: { rowStart: number; rowEnd: number; colStart: number; colEnd: number } | null,
  order: number[],
  visible: number[],
  canEdit: (col: number, row: number) => boolean,
): { row: number; col: number; value: Cell }[] {
  if (!grid.length) return [];
  const out: { row: number; col: number; value: Cell }[] = [];
  const single = grid.length === 1 && grid[0].length === 1;
  if (single && bounds) {
    for (let i = bounds.rowStart; i <= bounds.rowEnd; i++) {
      for (let j = bounds.colStart; j <= bounds.colEnd; j++) {
        const row = order[i], col = visible[j];
        if (row === undefined || col === undefined || !canEdit(col, row)) continue;
        out.push({ row, col, value: grid[0][0] });
      }
    }
    return out;
  }
  const r0 = order.indexOf(start.r), c0 = visible.indexOf(start.c);
  if (r0 < 0 || c0 < 0) return [];
  grid.forEach((line, dr) => line.forEach((value, dc) => {
    const row = order[r0 + dr], col = visible[c0 + dc];
    if (row === undefined || col === undefined || !canEdit(col, row)) return;
    out.push({ row, col, value });
  }));
  return out;
}
