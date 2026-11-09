import { useCallback, useMemo, useState } from "react";
import type { Cell } from "../lib/dbApi";
import { draftCells, newDraftRow, type DraftRow } from "../lib/tableRows";

/**
 * 表页的「行级增删」草稿状态。
 *
 * 两种草稿共用一套虚拟行号：`page.rows.length + i` 是第 i 条新增行，
 * `deleted` 里放的是真实行号。显示行 = 查询结果 + 新增行，删除只做标记
 * （写回时才真的删），这样排序、复制、原值校验拿到的仍然是真实行。
 */
export function useRowDrafts(pageRows: Cell[][]|null, columnCount: number) {
  const base = pageRows?.length ?? 0;
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [deleted, setDeleted] = useState<number[]>([]);

  const reset = useCallback(() => { setDrafts([]); setDeleted([]); }, []);
  /** `values` 用于「复制此行」：克隆出来的新增行直接带上原行的值。 */
  const add = useCallback((values?: Map<number, Cell>) => {
    // 这个函数经常被直接当 onClick 传下去，那时第一个参数是事件对象 —— 不能当成值用。
    const seed = values instanceof Map ? values : undefined;
    setDrafts(list => [...list, seed ? { ...newDraftRow(), values: seed } : newDraftRow()]);
  }, []);

  const setCell = useCallback((row: number, col: number, value: Cell) => {
    const index = row - base;
    setDrafts(list => list.map((d, i) => {
      if (i !== index) return d;
      const values = new Map(d.values);
      // 与已有行的口径一致：值改回 NULL 就当作「没填」，交给数据库默认值。
      if (value === null) values.delete(col); else values.set(col, value);
      return { ...d, values };
    }));
  }, [base]);

  const removeRow = useCallback((row: number) => {
    if (row >= base) { setDrafts(list => list.filter((_, i) => i !== row - base)); return; }
    setDeleted(list => list.includes(row) ? list : [...list, row]);
  }, [base]);

  const restoreRow = useCallback((row: number) => {
    if (row >= base) { setDrafts(list => list.filter((_, i) => i !== row - base)); return; }
    setDeleted(list => list.filter(r => r !== row));
  }, [base]);

  const status = useCallback((row: number): "added" | "deleted" | undefined =>
    row >= base ? "added" : deleted.includes(row) ? "deleted" : undefined, [base, deleted]);

  const rows = useMemo(() =>
    pageRows && drafts.length ? [...pageRows, ...drafts.map(d => draftCells(columnCount, d))] : pageRows,
  [pageRows, drafts, columnCount]);

  return {
    /** 显示用行集（查询结果 + 新增行）。 */
    rows,
    drafts,
    deleted,
    base,
    pending: drafts.length + deleted.length,
    add,
    setCell,
    removeRow,
    restoreRow,
    status,
    reset,
  };
}
