import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { cellText, sameCell } from "../../lib/db";
import type { Cell, ColumnMeta } from "../../lib/dbApi";
import { isNumericType } from "../../lib/resultExport";
import { initialWidths, type SortState } from "../../lib/resultView";
import { copyText } from "../../lib/utils";
import { toast } from "../ui/toast";

const ROW_H = 24;
const HEAD_H = 36;
/** 可视区上下多渲染的行数，滚得快时不露白。 */
const OVERSCAN = 12;

export interface CellPos {
  /** 原始行号（rows 下标），不是显示顺序。 */
  r: number;
  c: number;
}

export interface GridEdit {
  canEdit: (col: number) => boolean;
  /** 改过的格子：`行:列` → 新值。 */
  changed: Map<string, Cell>;
  onEdit: (row: number, col: number, value: Cell) => void;
}

/**
 * 结果表：手写虚拟滚动（只渲染可视行）、表头排序、拖列宽、单元格选择与编辑。
 *
 * 排序 / 筛选的结果由父组件以 `order` 传入（复制 / 导出要用同一个顺序）。
 * NULL 斜体灰字与空串区分；数字右对齐。
 */
export function ResultGrid({ columns, rows, order, sort, onSort, onHeaderMenu, sel, onSel, onOpen, edit, zh }: {
  columns: ColumnMeta[];
  rows: Cell[][];
  order: number[];
  sort: SortState | null;
  onSort: (col: number) => void;
  /** 表头右键（A3：让数据库重排整表）。不传就没有这个入口。 */
  onHeaderMenu?: (col: number, x: number, y: number) => void;
  sel: CellPos | null;
  onSel: (p: CellPos) => void;
  /** 双击不可编辑的格子：打开详情。 */
  onOpen?: () => void;
  edit?: GridEdit;
  /** 列名（小写）→ NC 中文名，表头悬停显示。 */
  zh?: Record<string, string>;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  /** 拖拽中的清理函数：组件卸载（切标签、结果清空）时也要摘掉 window 上的监听。 */
  const dragCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanup.current?.(), []);
  /** Esc 退出编辑：`setEditing(null)` 会把 input 卸掉，紧随其后的 blur 不能再提交一次。 */
  const cancelEdit = useRef(false);
  const [widths, setWidths] = useState<number[]>(() => initialWidths(columns, rows));
  const [scroll, setScroll] = useState({ top: 0, h: 400 });
  const [editing, setEditing] = useState<{ pos: CellPos; value: string } | null>(null);

  // 列变了（新的一次查询）才重算列宽；加载更多行不动用户拖过的宽度
  const colKey = columns.map((c) => c.name).join("|");
  useEffect(() => {
    setWidths(initialWidths(columns, rows));
    setEditing(null);
    boxRef.current?.scrollTo({ top: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colKey]);

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScroll((s) => ({ ...s, h: el.clientHeight })));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 兜底：编辑框被别的原因卸掉（结果刷新）时，标记不能留到下一轮
  useEffect(() => {
    if (!editing) cancelEdit.current = false;
  }, [editing]);

  // 新结果的第一帧里 effect 还没重算列宽：先按新列现算一份，避免宽度对不上
  const ws = widths.length === columns.length ? widths : initialWidths(columns, rows);
  const numeric = columns.map((c) => isNumericType(c.type));
  const rnW = Math.max(40, String(rows.length).length * 8 + 18);
  const total = rnW + ws.reduce((a, b) => a + b, 0);
  const first = Math.max(0, Math.floor(scroll.top / ROW_H) - OVERSCAN);
  const last = Math.min(order.length, Math.ceil((scroll.top + scroll.h) / ROW_H) + OVERSCAN);
  const selIndex = sel ? order.indexOf(sel.r) : -1;
  // 虚拟滚动只渲染可视行：活动单元格一旦滚出可视区，aria-activedescendant 会指向不存在的 id
  const activeCell = sel && selIndex >= first && selIndex < last ? `dbx-cell-${sel.r}-${sel.c}` : undefined;

  const resize = (k: number, startX: number) => {
    const start = widths[k];
    dragCleanup.current?.();
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      dragCleanup.current = null;
    };
    const move = (e: PointerEvent) => {
      // 指针被系统取消（Alt+Tab、触控笔离开、拖出窗口）时 pointerup 不触发；
      // buttons 归零是最后一道兜底，否则「手早松了，鼠标再动列宽还在变」。
      if (e.buttons === 0) return finish();
      setWidths((w) => w.map((x, i) => (i === k ? Math.max(40, Math.min(900, start + e.clientX - startX)) : x)));
    };
    dragCleanup.current = finish;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("pointercancel", finish, { once: true });
  };

  const valueAt = (r: number, c: number): Cell => {
    const key = `${r}:${c}`;
    return edit?.changed.has(key) ? edit.changed.get(key)! : rows[r][c];
  };

  const startEdit = (pos: CellPos) => {
    if (!edit?.canEdit(pos.c)) return onOpen?.();
    const v = valueAt(pos.r, pos.c);
    setEditing({ pos, value: v === null ? "" : String(v) });
  };

  const commitEdit = () => {
    if (cancelEdit.current) {
      cancelEdit.current = false;
      return;
    }
    if (!editing || !edit) return;
    const { r, c } = editing.pos;
    // Oracle 里空串就是 NULL，直接记成 NULL，预览 SQL 才不会误导
    const v: Cell = editing.value === "" ? null : editing.value;
    if (!sameCell(v, rows[r][c]) || edit.changed.has(`${r}:${c}`)) edit.onEdit(r, c, v);
    setEditing(null);
    boxRef.current?.focus();
  };

  const move = (dr: number, dc: number) => {
    if (order.length === 0 || columns.length === 0) return;
    const i = Math.max(0, Math.min(order.length - 1, (selIndex < 0 ? 0 : selIndex) + dr));
    const c = Math.max(0, Math.min(columns.length - 1, (sel?.c ?? 0) + dc));
    onSel({ r: order[i], c });
    const el = boxRef.current;
    if (el) {
      const y = i * ROW_H;
      if (y < el.scrollTop) el.scrollTop = y;
      else if (y + ROW_H > el.scrollTop + el.clientHeight - HEAD_H) el.scrollTop = y + ROW_H - el.clientHeight + HEAD_H;
    }
  };

  const onKey = (e: KeyboardEvent) => {
    if (editing) return;
    const step: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], PageUp: [-20, 0], PageDown: [20, 0] };
    if (step[e.key]) {
      e.preventDefault();
      move(...step[e.key]);
    } else if (sel && (e.key === "Enter" || e.key === "F2")) {
      e.preventDefault();
      startEdit(sel);
    } else if (sel && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && !window.getSelection()?.toString()) {
      e.preventDefault();
      const v = valueAt(sel.r, sel.c);
      void copyText(v === null ? "" : String(v), () => toast("已复制单元格", "success"), (e) => toast(`复制失败：${e}`, "error"));
    }
  };

  return (
    <div
      ref={boxRef}
      className="dbx-grid"
      tabIndex={0}
      role="grid"
      aria-label="查询结果"
      aria-rowcount={order.length}
      aria-colcount={columns.length}
      aria-activedescendant={activeCell}
      onKeyDown={onKey}
      onScroll={(e) => setScroll({ top: e.currentTarget.scrollTop, h: e.currentTarget.clientHeight })}
    >
      <div className="dbx-grid-inner" style={{ width: total, height: HEAD_H + order.length * ROW_H }}>
        <div className="dbx-ghead" style={{ width: total }} role="row" aria-rowindex={1}>
          <div className="dbx-gh rn" style={{ width: rnW }} role="columnheader" aria-colindex={1} />
          {columns.map((c, k) => (
            <div
              key={k}
              className="dbx-gh"
              style={{ width: ws[k] }}
              role="columnheader"
              aria-colindex={k + 2}
              aria-sort={sort?.col === k ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
              title={[c.name.toLowerCase(), zh?.[c.name.toLowerCase()], c.type].filter(Boolean).join(" · ")}
              onClick={() => onSort(k)}
              onContextMenu={(e) => {
                if (!onHeaderMenu) return;
                e.preventDefault();
                onHeaderMenu(k, e.clientX, e.clientY);
              }}
            >
              <span className="nm">{c.name.toLowerCase()}</span>
              {sort?.col === k && <span className="so">{sort.dir === "asc" ? "▲" : "▼"}</span>}
              <span className="t">{zh?.[c.name.toLowerCase()] ?? c.type}</span>
              <span className="rz" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); resize(k, e.clientX); }} />
            </div>
          ))}
        </div>
        {order.slice(first, last).map((r, j) => {
          const i = first + j;
          return (
            <div key={r} className="dbx-grow" style={{ top: HEAD_H + i * ROW_H, width: total }} data-sel={sel?.r === r || undefined} role="row" aria-rowindex={i + 2}>
              <div className="dbx-gc rn" style={{ width: rnW }} role="gridcell" aria-colindex={1}>{r + 1}</div>
              {columns.map((_, k) => {
                const v = valueAt(r, k);
                const isSel = sel?.r === r && sel.c === k;
                if (isSel && editing && editing.pos.r === r && editing.pos.c === k) {
                  return (
                    <div key={k} id={`dbx-cell-${r}-${k}`} className="dbx-gc" data-cell role="gridcell" aria-colindex={k + 2} aria-selected style={{ width: ws[k], padding: 0 }}>
                      <input
                        className="dbx-gedit"
                        autoFocus
                        value={editing.value}
                        onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                        onBlur={commitEdit}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitEdit();
                          if (e.key === "Escape") {
                            cancelEdit.current = true;
                            setEditing(null);
                            boxRef.current?.focus();
                          }
                        }}
                      />
                    </div>
                  );
                }
                const cls = ["dbx-gc", numeric[k] && "n", v === null && "null", edit?.changed.has(`${r}:${k}`) && "chg"].filter(Boolean).join(" ");
                return (
                  <div
                    key={k}
                    id={`dbx-cell-${r}-${k}`}
                    className={cls}
                    style={{ width: ws[k] }}
                    role="gridcell"
                    aria-colindex={k + 2}
                    aria-selected={isSel || undefined}
                    data-cell={isSel || undefined}
                    onMouseDown={() => onSel({ r, c: k })}
                    onDoubleClick={() => startEdit({ r, c: k })}
                  >
                    {cellText(v, 300)}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
