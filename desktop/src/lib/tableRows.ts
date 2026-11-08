import type { Cell, ColumnInfo, ColumnMeta } from "./dbApi";

/**
 * 表页里「还没写回数据库」的新增行。
 *
 * 新增行不塞进 `page.rows`：那个数组是查询结果，翻页 / 重查会被整份替换，
 * 而且它的下标同时被 `changed` 的 `行:列` 键和原值校验当作行身份用。
 * 草稿用独立数组 + 虚拟行号（>= page.rows.length）与已有行共存。
 */
export interface DraftRow {
  /** 稳定 id：行下标会随删除/重排变，React key 不能用下标。 */
  id: number;
  /** 列下标 → 用户填过的值。没进 map 的列 = 交给数据库默认值。 */
  values: Map<number, Cell>;
}

let seq = 0;
export function newDraftRow(): DraftRow {
  seq += 1;
  return { id: seq, values: new Map() };
}

/** 草稿行渲染成一行单元格：没填的列是 NULL（只影响显示，写回时不落 SQL）。 */
export function draftCells(columnCount: number, draft: DraftRow): Cell[] {
  return Array.from({ length: columnCount }, (_, c) => draft.values.has(c) ? draft.values.get(c)! : null);
}

/**
 * 新增行的必填校验。
 *
 * 判据是「非空 + 没有默认值 + 用户没填」：NC 的表大量列有 `sysdate` / `'~'` 之类的默认值，
 * 把这些列一起报成必填会让新增行根本提交不了。
 *
 * 名字按大小写对齐（`page.columns` 来自结果集，`info` 来自 `user_tab_columns`，两边大小写不一定一致）。
 */
export function missingRequired(pageColumns: ColumnMeta[], info: ColumnInfo[], values: Map<number, Cell>): string[] {
  if (!info.length) return [];
  const filled = new Set([...values.keys()].filter(i => values.get(i) !== null));
  const out: string[] = [];
  pageColumns.forEach((column, index) => {
    if (filled.has(index)) return;
    const meta = info.find(c => c.name.toUpperCase() === column.name.toUpperCase());
    if (!meta) return;
    // `default` 是 Oracle 侧的表达式原文（可能是 `'~'` / `sysdate`），有值就让数据库自己填。
    if (!meta.nullable && (meta.default === null || meta.default === undefined || meta.default === "")) out.push(column.name);
  });
  return out;
}

/** 显示用行集：查询结果后面接草稿行。 */
export function rowsWithDrafts(rows: Cell[][], drafts: DraftRow[], columnCount: number): Cell[][] {
  if (!drafts.length) return rows;
  return [...rows, ...drafts.map(d => draftCells(columnCount, d))];
}
