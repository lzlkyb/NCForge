import { useEffect, useId, useMemo, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode, type Ref } from "react";
import { columnViewport, selectionBounds } from "../../lib/gridViewport";
import { gridSelectionCell, gridSelectionHeading } from "../../lib/gridSelection";
import { isLobPreview, sameCell } from "../../lib/db";
import { gridCodec } from "../../lib/cellCodec";
import type { Cell, ColumnMeta } from "../../lib/dbApi";
import { isNumericType } from "../../lib/resultExport";
import { fitWidth, initialWidths, rowNumberWidth, type SortState } from "../../lib/resultView";
import { copyText } from "../../lib/utils";
import { toast } from "../ui/toast";
import { ResultGridHeader } from "./ResultGridHeader";
import { useResultGridNavigation } from "../../hooks/useResultGridNavigation";
import { getUiDensity, subscribeUiDensity } from "../../lib/uiDensity";
import { selectionText, type Selection } from "../../lib/dbResultTools";
import "../../db-grid-inspector.css";

const OVERSCAN = 12; // 可视区上下多渲染的行数，滚得快时不露白

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

export interface ResultGridApi { focusActive: () => void }

/**
 * 结果表：手写虚拟滚动（只渲染可视行）、表头排序、拖/双击自适应列宽、单元格选择与编辑。
 *
 * 排序 / 筛选的结果由父组件以 `order` 传入（复制 / 导出要用同一个顺序）。
 * NULL 斜体灰字与空串区分；数字右对齐。
 */
export function ResultGrid({ columns, rows, order, sort, onSort, onHeaderMenu, sel, onSel, onOpen, edit, zh, visible, frozen, widthOverrides, onWidths, selection, empty, onCopy, onCellMenu, apiRef, decoded }: {
  apiRef?: Ref<ResultGridApi>;
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
  decoded?: string[]; // 已开启「按编码解码显示」的列名，开关在列头右键菜单
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
  const helpId = useId();
  const previousRowHeight = useRef(ROW_H), preciseTop = useRef(0);
  /** 拖拽中的清理函数：组件卸载（切标签、结果清空）时也要摘掉 window 上的监听。 */
  const dragCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanup.current?.(), []);
  /** Esc 退出编辑：`setEditing(null)` 会把 input 卸掉，紧随其后的 blur 不能再提交一次。 */
  const cancelEdit = useRef(false);
  const widthRef=useRef<number[]>([]);
  const [widths, setWidths] = useState<number[]>(() => initialWidths(columns, rows));
  const [scroll, setScroll] = useState({ top: 0, h: 400, left: 0, w: 800 });
  const [editing, setEditing] = useState<{ pos: CellPos; value: string } | null>(null);

  // 切密度保留当前首行；CSS 与虚拟滚动共用几何，不能只把可见行拉高。
  useLayoutEffect(() => {
    const el = boxRef.current;
    // DOM 高度缩短时浏览器会先夹紧 scrollTop；用上一帧状态避免再缩短一次。
    if (el && previousRowHeight.current !== ROW_H) {
      el.scrollTop = preciseTop.current / previousRowHeight.current * ROW_H; preciseTop.current=el.scrollTop;
      setScroll(s => ({ ...s, top: el.scrollTop, h: el.clientHeight }));
    }
    previousRowHeight.current = ROW_H;
  }, [ROW_H, scroll.top]);

  const colKey = columns.map((c) => c.name).join("|");
  const colKeyRef = useRef(colKey);
  // 只有列变了才回顶并结束编辑；拖列宽也会换 widthOverrides 引用，无差别重置会丢滚动位置和编辑中的值
  useEffect(() => {
    setWidths(initialWidths(columns, rows).map((w, c) => widthOverrides[columns[c].name] ?? w));
    if (colKeyRef.current === colKey) return;
    colKeyRef.current = colKey; setEditing(null); boxRef.current?.scrollTo({ top: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colKey, widthOverrides]);

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScroll(s => s.h === el.clientHeight && s.w === el.clientWidth ? s : ({ ...s, h: el.clientHeight, w: el.clientWidth })));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => { if (!editing) cancelEdit.current = false; }, [editing]);

  // 新结果的第一帧里 effect 还没重算列宽：先按新列现算一份，避免宽度对不上
  const ws = widths.length === columns.length ? widths : initialWidths(columns, rows);
  const codec = useMemo(() => gridCodec(columns, rows, order, decoded ?? []), [columns, rows, order, decoded]);
  const numeric = columns.map((c) => isNumericType(c.type));
  const rnW = rowNumberWidth(rows.length);
  const total = rnW + visible.reduce((n,c)=>n+ws[c],0);
  const bounds = useMemo(() => selectionBounds(order,visible,selection), [order,visible,selection]);
  const viewport = columnViewport(visible,ws,new Set(visible.filter(c=>frozen.includes(columns[c].name))),scroll.left,scroll.w,rnW);
  const viewportByColumn = new Map(viewport.map(col => [col.column, col]));
  const cellStyle = (c:number) => { const col=viewportByColumn.get(c)!; return {width:col.width,position:col.frozen ? "sticky" as const : "absolute" as const,left:col.frozen ? col.sticky : col.left,...(col.frozen ? {zIndex:2} : {})}; };
  const first = Math.max(0, Math.floor(scroll.top / ROW_H) - OVERSCAN);
  const last = Math.min(order.length, Math.ceil((scroll.top + scroll.h) / ROW_H) + OVERSCAN);
  const selIndex = sel ? order.indexOf(sel.r) : -1;
  // 活动格滚出可视区时 aria-activedescendant 会指向不存在的 id
  const activeCell = sel && viewport.some(c=>c.column===sel.c) && selIndex >= first && selIndex < last ? `dbx-cell-${sel.r}-${sel.c}` : undefined;

  const syncScroll = () => {
    const el = boxRef.current;
    if (!el) return;
    preciseTop.current=el.scrollTop;
    const top=Math.floor(el.scrollTop/ROW_H)*ROW_H, left=Math.floor(el.scrollLeft/100)*100;
    setScroll(s=>s.top===top && s.left===left && s.h===el.clientHeight && s.w===el.clientWidth ? s : {...s,top,left,h:el.clientHeight,w:el.clientWidth});
  };
  const reveal = (c: number, rowIndex?: number) => {
    const el = boxRef.current, ci = visible.indexOf(c);
    if (!el || ci < 0) return;
    const width=el.clientWidth || scroll.w, height=el.clientHeight || scroll.h;
    const x=rnW+visible.slice(0,ci).reduce((n,k)=>n+ws[k],0);
    const frozenWidth=rnW+visible.filter(k=>frozen.includes(columns[k].name)).reduce((n,k)=>n+ws[k],0);
    if (!frozen.includes(columns[c].name)) {
      if (x < el.scrollLeft+frozenWidth) el.scrollLeft=Math.max(0,x-frozenWidth);
      else if (x+ws[c] > el.scrollLeft+width) el.scrollLeft=x+ws[c]-width;
    }
    if (rowIndex !== undefined) {
      const y=rowIndex*ROW_H;
      if (y < el.scrollTop) el.scrollTop=y;
      else if (y+ROW_H > el.scrollTop+height-HEAD_H) el.scrollTop=y+ROW_H-height+HEAD_H;
    }
    // Programmatic focus can cross a virtual row/column boundary before the scroll event arrives.
    syncScroll();
  };
  const resize = (k: number, startX: number) => {
    const start = widths[k];
    dragCleanup.current?.();
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      dragCleanup.current = null;
      // 宽度没变（误点、双击 fit 的第一下）就别写布局，否则自动宽度会被固化成手调值。
      if (widthRef.current.length && widthRef.current[k] !== start) onWidths(widthRef.current);
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
  /** 双击列分隔线 = 本列贴到内容（列名优先），顺手记成手调宽度。 */
  const fit = (k: number) => { if (!columns[k]) return; const next = ws.map((w, i) => (i === k ? fitWidth(columns[k], rows, k) : w)); setWidths(next); onWidths(next); };

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

  const copySelection = () => {
    if (!sel) return;
    if (onCopy) { onCopy(); return; }
    const text=selection ? selectionText(rows,order,visible,selection,valueAt) : String(valueAt(sel.r,sel.c) ?? "");
    void copyText(text, () => toast("已复制选区", "success"), (e) => toast(`复制失败：${e}`, "error"));
  };
  const navigation=useResultGridNavigation({boxRef,sel,visible,order,reveal,onSel,onSort,onHeaderMenu,onCellMenu,
    editing:!!editing,onOpen:startEdit,onCopy:copySelection,apiRef});

  return (
    <div
      ref={boxRef}
      className="dbx-grid"
      style={{ "--dbx-row-h": `${ROW_H}px`, "--dbx-head-h": `${HEAD_H}px` } as CSSProperties}
      tabIndex={0}
      role="grid"
      aria-multiselectable
      aria-label="查询结果"
      aria-describedby={helpId}
      aria-keyshortcuts={onCellMenu ? "Alt+ArrowUp Shift+F10" : "Alt+ArrowUp"}
      aria-rowcount={order.length+1}
      aria-colcount={visible.length+1}
      aria-activedescendant={activeCell}
      onKeyDown={navigation.onKey}
      onScroll={syncScroll}
    >
      <span id={helpId} className="dbx-grid-instructions">方向键移动，Shift 扩选，Ctrl+C 复制。Alt+上箭头进入表头；表头左右键换列，Enter 排序，{onHeaderMenu && "Shift+F10 或菜单键打开菜单，"}下箭头返回数据，Esc 返回原活动格。</span>
      <div className="dbx-grid-inner" style={{ width: total, height: HEAD_H + order.length * ROW_H }}>
        <ResultGridHeader columns={columns} sort={sort} zh={zh} order={order} visible={visible} viewport={viewport}
          bounds={bounds} total={total} rnW={rnW} cellStyle={cellStyle} navigation={navigation}
          onSel={onSel} onSort={onSort} onHeaderMenu={onHeaderMenu} resize={resize} fit={fit} codec={codec} />
        {order.slice(first, last).map((r, j) => {
          const i = first + j;
          return (
            <div
              key={r}
              className="dbx-grow"
              style={{ top: HEAD_H + i * ROW_H, width: total }}
              data-odd={i % 2 === 1 || undefined}
              role="row"
              aria-rowindex={i + 2}
            >
              <div className="dbx-gc rn" data-range-heading={gridSelectionHeading(bounds,i,"row")} style={{ width: rnW }} role="rowheader" aria-colindex={1} onMouseDown={()=> {if(visible.length) {onSel({r,c:visible[0]});onSel({r,c:visible[visible.length-1]},true);}}}>{i + 1}</div>
              {viewport.map(({column:k,index:vi,width}) => {
                const v = valueAt(r, k);
                const selected = gridSelectionCell(bounds,i,vi,sel?.r===r && sel?.c===k), isSel=!!selected["data-cell"];
                if (isSel && editing && editing.pos.r === r && editing.pos.c === k) {
                  return (
                    <div key={k} id={`dbx-cell-${r}-${k}`} className={`dbx-gc${edit?.changed.has(`${r}:${k}`) ? " chg" : ""}`} {...selected} data-editing data-focus-container role="gridcell" aria-colindex={vi + 2} style={{...cellStyle(k),padding:0}}>
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
                const valueKind=v===null ? "null" : v==="" ? "empty" : typeof v==="string" && !/\S/.test(v) ? "whitespace" : undefined;
                // 大文本（>4K 或后端标了预览）在网格里只露开头：给角标提示「双击看完整值」
                const longText = typeof v === "string" && (v.length >= 4096 || isLobPreview(v));
                return (
                  <div
                    key={k}
                    id={`dbx-cell-${r}-${k}`}
                    className={cls}
                    style={cellStyle(k)}
                    role="gridcell"
                    aria-colindex={vi + 2}
                    data-value-kind={valueKind}
                    title={codec.title(v, k, width)}
                    aria-label={valueKind==="null" ? "NULL，数据库空值" : valueKind==="empty" ? "空字符串，0 字符" : valueKind==="whitespace" ? `仅空白字符，${String(v).length} 字符` : undefined}
                    {...selected}
                    onMouseDown={e=>{e.preventDefault();boxRef.current?.focus();onSel({r,c:k},e.shiftKey);}}
                    onMouseEnter={e=>{if(e.buttons===1 && !editing) onSel({r,c:k},true);}}
                    onDoubleClick={() => startEdit({ r, c: k })}
                    onContextMenu={e=>{if(onCellMenu){e.preventDefault();onCellMenu(r,k,e.clientX,e.clientY);}}}
                  >
                    {(valueKind==="empty" || valueKind==="whitespace") && <span className="dbx-value-placeholder" data-placeholder={valueKind==="empty" ? "空字符串" : "空白"} aria-hidden="true" />}
                    {longText && <span className="dbx-lob-mark" aria-hidden="true" />}
                    {codec.text(v, k, 300)}
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
