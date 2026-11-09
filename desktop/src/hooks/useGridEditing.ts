import { useRef, useState, type RefObject } from "react";
import { sameCell } from "../lib/db";
import type { Cell } from "../lib/dbApi";
import type { CellPos, GridEdit } from "../components/db/gridEdit";

/**
 * 网格的编辑态：进入编辑、提交（可带移动方向）、取消、以及「这一格回原值」。
 *
 * 从 `ResultGrid` 抽出来的原因有两个：那个组件已经贴着 300 行红线；而且这套
 * 语义在表页和 SQL 结果页要完全一致（Enter 下移、Tab 右移、Esc 取消），不能各写一份。
 *
 * `commit(move)` 里的 `move` 是 [行方向, 列方向]。到底之后夹在边界上不动，
 * 不做「自动新增一行」——那会让「按了 Enter 却多出一行」比停在原地更难解释。
 */
export function useGridEditing({ rows, order, visible, edit, onSel, reveal, boxRef }: {
  rows: Cell[][];
  order: number[];
  visible: number[];
  edit?: GridEdit;
  onSel: (pos: CellPos) => void;
  reveal: (col: number, rowIndex?: number) => void;
  boxRef: RefObject<HTMLDivElement | null>;
}) {
  const [editing, setEditing] = useState<{ pos: CellPos; value: string } | null>(null);
  /** Esc 退出编辑：`setEditing(null)` 卸掉 input 后的 blur 不能再提交一次。 */
  const cancelRef = useRef(false);

  const valueAt = (r: number, c: number): Cell =>
    edit?.changed.has(`${r}:${c}`) ? edit.changed.get(`${r}:${c}`)! : rows[r][c];

  const focusAt = (pos: CellPos) => {
    const index = order.indexOf(pos.r);
    if (index < 0) return;
    reveal(pos.c, index);
    requestAnimationFrame(() => {
      boxRef.current?.querySelector<HTMLElement>(`#dbx-cell-${pos.r}-${pos.c}`)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      boxRef.current?.focus({ preventScroll: true });
    });
  };

  /** 进入编辑；这一格不可编辑时返回 false，调用方据此改走「打开详情」。 */
  const startEdit = (pos: CellPos): boolean => {
    if (!edit?.canEdit(pos.c, pos.r)) return false;
    const v = valueAt(pos.r, pos.c);
    setEditing({ pos, value: v === null ? "" : String(v) });
    return true;
  };

  const commit = (move?: [number, number]) => {
    if (cancelRef.current) { cancelRef.current = false; return; }
    const current = editing;
    setEditing(null);
    if (!current) { boxRef.current?.focus(); return; }
    const { r, c } = current.pos;
    // Oracle 里空串就是 NULL，直接记成 NULL，预览 SQL 才不会误导
    const v: Cell = current.value === "" ? null : current.value;
    if (!sameCell(v, rows[r][c]) || edit?.changed.has(`${r}:${c}`)) edit?.onEdit(r, c, v);
    const next = move ? step(order, visible, current.pos, move[0], move[1]) : null;
    if (next) { onSel(next); focusAt(next); } else boxRef.current?.focus();
  };

  const cancel = () => { cancelRef.current = true; setEditing(null); boxRef.current?.focus(); };
  const setValue = (value: string) => setEditing(current => (current ? { ...current, value } : current));

  return { editing, valueAt, startEdit, setValue, commit, cancel };
}

/** 按显示顺序走一步；出界就夹在边上，不动时返回 null（调用方只需聚焦当前格）。 */
export function step(order: number[], visible: number[], pos: CellPos, dr: number, dc: number): CellPos | null {
  const ri = order.indexOf(pos.r), ci = visible.indexOf(pos.c);
  if (ri < 0 || ci < 0) return null;
  const r = order[Math.max(0, Math.min(order.length - 1, ri + dr))];
  const c = visible[Math.max(0, Math.min(visible.length - 1, ci + dc))];
  return r === pos.r && c === pos.c ? null : { r, c };
}
