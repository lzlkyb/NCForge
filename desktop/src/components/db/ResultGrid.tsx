import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { cellText, sameCell } from "../../lib/db";
import type { Cell, ColumnMeta } from "../../lib/dbApi";
import { isNumericType } from "../../lib/resultExport";
import { initialWidths, type SortState } from "../../lib/resultView";
import { copyText } from "../../lib/utils";
import { toast } from "../ui/toast";
import { getUiDensity, subscribeUiDensity } from "../../lib/uiDensity";

/** 可视区上下多渲染的行数，滚得快时不露白。 */
const OVERSCAN = 12;
import { selectedRows, selectedCols, selectionText, type Selection } from "../../lib/dbResultTools";

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
export function ResultGrid({ columns, rows, order, sort, onSort, onHeaderMenu, sel, onSel, onOpen, edit, zh, visible, frozen, widthOverrides, onWidths, selection, empty, onCopy, onCellMenu }: {
  columns: ColumnMeta[];
  rows: Cell[][];
  order: number[];
  sort: SortState | null;
  empty?: ReactNode; onCopy?: () => void; onCellMenu?: (r:number,c:number,x:number,y:number) => void;
  onSort: (col: number) => void;
  /** 表头右键（A3：让数据库重排整表）。不传就没有这个入口。 */
  onHeaderMenu?: (col: number, x: number, y: number) => void;
  sel: CellPos | null;
  onSel: (p: CellPos, extend?:boolean) => void;
  visible: number[]; frozen: string[]; widthOverrides: Record<string,number>; onWidths: (w:number[])=>void; selection:Selection|null;
  /** 双击不可编辑的格子：打开详情。 */
  onOpen?: () => void;
  edit?: GridEdit;
  /** 列名（小写）→ NC 中文名，表头悬停显示。 */
  zh?: Record<string, string>;
}) {
  const density = useSyncExternalStore(subscribeUiDensity, getUiDensity);
  const ROW_H = density === "comfortable" ? 30 : 26;
  const HEAD_H = density === "comfortable" ? 44 : 40;
  const boxRef = useRef<HTMLDivElement>(null);
  const previousRowHeight = useRef(ROW_H);
  /** 拖拽中的清理函数：组件卸载（切标签、结果清空）时也要摘掉 window 上的监听。 */
  const dragCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanup.current?.(), []);
  /** Esc 退出编辑：`setEditing(null)` 会把 input 卸掉，紧随其后的 blur 不能再提交一次。 */
  const cancelEdit = useRef(false);
  const widthRef=useRef<number[]>([]);
  const [widths, setWidths] = useState<number[]>(() => initialWidths(columns, rows));
  const [scroll, setScroll] = useState({ top: 0, h: 400 });
  const [editing, setEditing] = useState<{ pos: CellPos; value: string } | null>(null);

  // 切密度保留当前首行；CSS 与虚拟滚动共用几何，不能只把可见行拉高。
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (el && previousRowHeight.current !== ROW_H) {
      // DOM 高度缩短时浏览器会先夹紧 scrollTop；用上一帧状态避免再缩短一次。
      el.scrollTop = scroll.top / previousRowHeight.current * ROW_H;
      setScroll({ top: el.scrollTop, h: el.clientHeight });
    }
    previousRowHeight.current = ROW_H;
  }, [ROW_H, scroll.top]);

  // 列变了（新的一次查询）才重算列宽；加载更多行不动用户拖过的宽度
  const colKey = columns.map((c) => c.name).join("|");
  useEffect(() => {
    setWidths(initialWidths(columns,rows).map((w,c)=>widthOverrides[columns[c].name] ?? w));
    setEditing(null);
    boxRef.current?.scrollTo({ top: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colKey, widthOverrides]);

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
  const total = rnW + visible.reduce((n,c)=>n+ws[c],0);
  const rangeRows = new Set(selection ? selectedRows(order,selection) : []);
  const rangeCols = new Set(selection ? selectedCols(visible,selection) : []);
  const cellStyle = (c:number) => ({width:ws[c], ...(frozen.includes(columns[c].name) ? {position:"sticky" as const,left:rnW+visible.slice(0,visible.indexOf(c)).reduce((n,k)=>n+ws[k],0),zIndex:2,background:"hsl(var(--card))"} : {})});
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
      if(widthRef.current.length) onWidths(widthRef.current);
    };
    const move = (e: PointerEvent) => {
      // 指针被系统取消（Alt+Tab、触控笔离开、拖出窗口）时 pointerup 不触发；
      // buttons 归零是最后一道兜底，否则「手早松了，鼠标再动列宽还在变」。
      if (e.buttons === 0) return finish();
      setWidths(w=> {const next=w.map((x,i)=>i===k?Math.max(40,Math.min(900,start+e.clientX-startX)):x);widthRef.current=next;return next;});
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

  const move = (dr: number, dc: number, extend=false) => {
    if (order.length === 0 || visible.length === 0) return;
    const i = Math.max(0, Math.min(order.length - 1, (selIndex < 0 ? 0 : selIndex) + dr));
    const ci=Math.max(0,Math.min(visible.length-1,Math.max(0,visible.indexOf(sel?.c ?? visible[0]))+dc));
    const c=visible[ci]; onSel({r:order[i],c},extend);
    const el = boxRef.current;
    if (el) {
      const x=rnW+visible.slice(0,ci).reduce((n,k)=>n+ws[k],0);
      if(!frozen.includes(columns[c].name)) {if(x<el.scrollLeft) el.scrollLeft=x;else if(x+ws[c]>el.scrollLeft+el.clientWidth) el.scrollLeft=x+ws[c]-el.clientWidth;}
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
      move(...step[e.key],e.shiftKey);
    } else if (sel && (e.key === "Enter" || e.key === "F2")) {
      e.preventDefault();
      startEdit(sel);
    } else if (sel && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && !window.getSelection()?.toString()) {
      e.preventDefault();
      if (onCopy) { onCopy(); return; }
      const text=selection ? selectionText(rows,order,visible,selection,valueAt) : String(valueAt(sel.r,sel.c) ?? "");
      void copyText(text, () => toast("已复制选区", "success"), (e) => toast(`复制失败：${e}`, "error"));
    }
  };

  return (
    <div
      ref={boxRef}
      className="dbx-grid"
      style={{ "--dbx-row-h": `${ROW_H}px`, "--dbx-head-h": `${HEAD_H}px` } as CSSProperties}
      tabIndex={0}
      role="grid"
      aria-multiselectable
      aria-label="查询结果"
      aria-rowcount={order.length+1}
      aria-colcount={visible.length+1}
      aria-activedescendant={activeCell}
      onKeyDown={onKey}
      onScroll={(e) => setScroll({ top: e.currentTarget.scrollTop, h: e.currentTarget.clientHeight })}
    >
      <div className="dbx-grid-inner" style={{ width: total, height: HEAD_H + order.length * ROW_H }}>
        <div className="dbx-ghead" style={{ width: total }} role="row" aria-rowindex={1}>
          <div className="dbx-gh rn" style={{ width: rnW }} role="columnheader" aria-colindex={1} title="选择全部" onClick={()=>{if(order.length && visible.length) {onSel({r:order[0],c:visible[0]});onSel({r:order[order.length-1],c:visible[visible.length-1]},true);}}} />
          {visible.map((k,vi) => { const c=columns[k]; return (
            <div
              key={k}
              className="dbx-gh"
              data-description={!!zh?.[c.name.toLowerCase()] || undefined}
              style={cellStyle(k)}
              role="columnheader"
              aria-colindex={vi + 2}
              aria-sort={sort?.col === k ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
              title={[c.name.toLowerCase(), zh?.[c.name.toLowerCase()], c.type].filter(Boolean).join(" · ")}
              onClick={e => {if(e.shiftKey && order.length){onSel({r:order[0],c:k});onSel({r:order[order.length-1],c:k},true);}else onSort(k);}}
              onContextMenu={(e) => {
                if (!onHeaderMenu) return;
                e.preventDefault();
                onHeaderMenu(k, e.clientX, e.clientY);
              }}
            >
              <span className="nm">{c.name.toLowerCase()}</span>
              {sort?.col === k && <span className="so">{sort.dir === "asc" ? "▲" : "▼"}</span>}
              {zh?.[c.name.toLowerCase()] && <span className="t">{zh[c.name.toLowerCase()]}</span>}
              <span className="rz" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); resize(k, e.clientX); }} />
            </div>
          );})}
        </div>
        {order.slice(first, last).map((r, j) => {
          const i = first + j;
          return (
            <div
              key={r}
              className="dbx-grow"
              style={{ top: HEAD_H + i * ROW_H, width: total }}
              data-odd={i % 2 === 1 || undefined}
              data-sel={sel?.r === r || undefined}
              role="row"
              aria-rowindex={i + 2}
            >
              <div className="dbx-gc rn" style={{ width: rnW }} role="rowheader" aria-colindex={1} onMouseDown={()=> {if(visible.length) {onSel({r,c:visible[0]});onSel({r,c:visible[visible.length-1]},true);}}}>{i + 1}</div>
              {visible.map((k,vi) => {
                const v = valueAt(r, k);
                const isSel = rangeRows.has(r) && rangeCols.has(k);
                if (isSel && editing && editing.pos.r === r && editing.pos.c === k) {
                  return (
                    <div key={k} id={`dbx-cell-${r}-${k}`} className="dbx-gc" data-cell data-focus-container role="gridcell" aria-colindex={vi + 2} aria-selected style={{...cellStyle(k),padding:0}}>
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
                    style={cellStyle(k)}
                    role="gridcell"
                    aria-colindex={vi + 2}
                    aria-selected={isSel || undefined}
                    data-cell={isSel || undefined}
                    onMouseDown={e=>{e.preventDefault();boxRef.current?.focus();onSel({r,c:k},e.shiftKey);}}
                    onMouseEnter={e=>{if(e.buttons===1 && !editing) onSel({r,c:k},true);}}
                    onDoubleClick={() => startEdit({ r, c: k })}
                    onContextMenu={e=>{if(onCellMenu){e.preventDefault();onCellMenu(r,k,e.clientX,e.clientY);}}}
                  >
                    {cellText(v, 300)}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      {order.length === 0 && <div className="dbx-grid-empty" role="status" style={{top:HEAD_H}}>{empty ?? "没有匹配的行"}</div>}
    </div>
  );
}
