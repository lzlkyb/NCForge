import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { cellText } from "../../lib/db";
import type { Cell, ColumnMeta } from "../../lib/dbApi";
import { isNumericType } from "../../lib/resultExport";
import { initialWidths, type SortState } from "../../lib/resultView";

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
export function ResultGrid({ columns, rows, order, sort, onSort, sel, onSel, onOpen, edit, zh }: {
  columns: ColumnMeta[];
  rows: Cell[][];
  order: number[];
  sort: SortState | null;
  onSort: (col: number) => void;
  sel: CellPos | null;
  onSel: (p: CellPos) => void;
  /** 双击不可编辑的格子：打开详情。 */
  onOpen?: () => void;
  edit?: GridEdit;
  /** 列名（小写）→ NC 中文名，表头悬停显示。 */
  zh?: Record<string, string>;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
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

  // 新结果的第一帧里 effect 还没重算列宽：先按新列现算一份，避免宽度对不上
  const ws = widths.length === columns.length ? widths : initialWidths(columns, rows);
  const numeric = columns.map((c) => isNumericType(c.type));
  const rnW = Math.max(40, String(rows.length).length * 8 + 18);
  const total = rnW + ws.reduce((a, b) => a + b, 0);
  const first = Math.max(0, Math.floor(scroll.top / ROW_H) - OVERSCAN);
  const last = Math.min(order.length, Math.ceil((scroll.top + scroll.h) / ROW_H) + OVERSCAN);
  const selIndex = sel ? order.indexOf(sel.r) : -1;

  const resize = (k: number, startX: number) => {
    const start = widths[k];
    const move = (e: PointerEvent) =>
      setWidths((w) => w.map((x, i) => (i === k ? Math.max(40, Math.min(900, start + e.clientX - startX)) : x)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
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
    if (!editing || !edit) return;
    const { r, c } = editing.pos;
    // Oracle 里空串就是 NULL，直接记成 NULL，预览 SQL 才不会误导
    const v: Cell = editing.value === "" ? null : editing.value;
    if (v !== rows[r][c] || edit.changed.has(`${r}:${c}`)) edit.onEdit(r, c, v);
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
      void navigator.clipboard.writeText(v === null ? "" : String(v));
    }
  };

  return (
    <div
      ref={boxRef}
      className="dbx-grid"
      tabIndex={0}
      onKeyDown={onKey}
      onScroll={(e) => setScroll({ top: e.currentTarget.scrollTop, h: e.currentTarget.clientHeight })}
    >
      <div className="dbx-grid-inner" style={{ width: total, height: HEAD_H + order.length * ROW_H }}>
        <div className="dbx-ghead" style={{ width: total }}>
          <div className="dbx-gh rn" style={{ width: rnW }} />
          {columns.map((c, k) => (
            <div
              key={k}
              className="dbx-gh"
              style={{ width: ws[k] }}
              title={[c.name.toLowerCase(), zh?.[c.name.toLowerCase()], c.type].filter(Boolean).join(" · ")}
              onClick={() => onSort(k)}
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
            <div key={r} className="dbx-grow" style={{ top: HEAD_H + i * ROW_H, width: total }} data-sel={sel?.r === r || undefined}>
              <div className="dbx-gc rn" style={{ width: rnW }}>{r + 1}</div>
              {columns.map((_, k) => {
                const v = valueAt(r, k);
                const isSel = sel?.r === r && sel.c === k;
                if (isSel && editing && editing.pos.r === r && editing.pos.c === k) {
                  return (
                    <div key={k} className="dbx-gc" data-cell style={{ width: ws[k], padding: 0 }}>
                      <input
                        className="dbx-gedit"
                        autoFocus
                        value={editing.value}
                        onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                        onBlur={commitEdit}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitEdit();
                          if (e.key === "Escape") {
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
                    className={cls}
                    style={{ width: ws[k] }}
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
