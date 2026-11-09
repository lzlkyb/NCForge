import { useEffect, useId, useMemo, useLayoutEffect, useRef, useState, useSyncExternalStore, type ClipboardEvent, type CSSProperties, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { columnViewport, selectionBounds } from "../../lib/gridViewport";
import { gridCodec } from "../../lib/cellCodec";
import type { Cell, ColumnMeta } from "../../lib/dbApi";
import { isNumericType } from "../../lib/resultExport";
import { fitWidth, initialWidths, rowNumberWidth, type SortState } from "../../lib/resultView";
import { copyText } from "../../lib/utils";
import { toast } from "../ui/toast";
import { ResultGridHeader } from "./ResultGridHeader";
import { GridTextEditor } from "./GridTextEditor";
import { GridRows } from "./GridRows";
import { useResultGridNavigation } from "../../hooks/useResultGridNavigation";
import { useGridEditing } from "../../hooks/useGridEditing";
import { useGridRowLayout } from "../../hooks/useGridRowLayout";
import { useGridTyping } from "../../hooks/useGridTyping";
import { useGridDensityScroll } from "../../hooks/useGridDensityScroll";
import { shouldLoadMore } from "../../lib/gridLoadMore";
import { parseClipboardGrid, pasteTargets } from "../../lib/gridPaste";
import { getUiDensity, subscribeUiDensity } from "../../lib/uiDensity";
import { selectionText, type Selection } from "../../lib/dbResultTools";
import "../../db-grid-inspector.css";

const OVERSCAN = 12; // 可视区上下多渲染的行数，滚得快时不露白
/** 距底部还有多少 px 就当作「滚到底」：一屏的 1/4，手指一拨就能续取。 */
const LOAD_MORE_MARGIN = 96;

export type { CellPos, GridEdit, ResultGridApi } from "./gridEdit";
import type { CellPos, GridEdit, ResultGridApi } from "./gridEdit";

/**
 * 结果表：手写虚拟滚动（只渲染可视行）、表头排序、拖/双击自适应列宽、单元格选择与编辑。
 *
 * 排序 / 筛选的结果由父组件以 `order` 传入（复制 / 导出要用同一个顺序）。
 * NULL 斜体灰字与空串区分；数字右对齐。
 */
export function ResultGrid({ columns, rows, order, sort, onSort, onHeaderMenu, sel, onSel, onDetail, edit, blockedHint, zh, visible, frozen, widthOverrides, onWidths, selection, empty, onCopy, onCellMenu, apiRef, decoded, wrap: wrapProp, hasMore, loadingMore, onLoadMore }: {
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
  /** 打开单元格详情（F4 / 右键「查看完整值」/ 工具栏按钮）。双击不触发。 */
  onDetail?: () => void;
  edit?: GridEdit;
  /** 不能编辑的原因；`edit` 缺失或这格不可改时双击会先提示一次。 */
  blockedHint?: string;
  /** 列名（小写）→ NC 中文名，表头悬停显示。 */
  zh?: Record<string, string>;
  /** 自动换行：长文本按列宽折行，行高随之变高（几何走 `useGridRowLayout`）。 */
  wrap?: boolean;
  /** 还有更多行没取（续取入口出现的原因）。 */
  hasMore?: boolean;
  loadingMore?: boolean;
  /** 滚到底时自动续取；不传 = 这个结果不支持（表页分页 / 已取完）。 */
  onLoadMore?: () => void;
}) {
  const density = useSyncExternalStore(subscribeUiDensity, getUiDensity);
  const ROW_H = density === "comfortable" ? 30 : 26;
  const HEAD_H = density === "comfortable" ? 44 : 40;
  const wrap = !!wrapProp;
  const boxRef = useRef<HTMLDivElement>(null);
  const helpId = useId();
  const preciseTop = useRef(0);
  /** 拖拽中的清理函数：组件卸载（切标签、结果清空）时也要摘掉 window 上的监听。 */
  const dragCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanup.current?.(), []);
  const widthRef=useRef<number[]>([]);
  /** 续取过的行数：滚到底触发一次后要等新行真的到达才会再触发。 */
  const loadedAt = useRef(rows.length);
  const [widths, setWidths] = useState<number[]>(() => initialWidths(columns, rows));
  const [scroll, setScroll] = useState({ top: 0, h: 400, left: 0, w: 800 });

  const colKey = columns.map((c) => c.name).join("|");
  const colKeyRef = useRef(colKey);

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScroll(s => s.h === el.clientHeight && s.w === el.clientWidth ? s : ({ ...s, h: el.clientHeight, w: el.clientWidth })));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 新结果的第一帧里 effect 还没重算列宽：先按新列现算一份，避免宽度对不上
  const ws = widths.length === columns.length ? widths : initialWidths(columns, rows);
  // 换行时行高不固定：行高按 rows 下标测、偏移按 order 累加（见 useGridRowLayout）。
  const layout = useGridRowLayout({ rows, columns, widths: ws, order, wrap, rowH: ROW_H });
  // 切密度保留当前首行：按总高比例换算 scrollTop（依赖数组在渲染时求值，必须放在 layout 之后）。
  useGridDensityScroll({ boxRef, rowH: ROW_H, total: layout.total, preciseTop,
    onScrollTop: (top, h) => setScroll(s => ({ ...s, top, h })) });
  const codec = useMemo(() => gridCodec(columns, rows, order, decoded ?? []), [columns, rows, order, decoded]);
  const numeric = columns.map((c) => isNumericType(c.type));
  const rnW = rowNumberWidth(rows.length);
  const total = rnW + visible.reduce((n,c)=>n+ws[c],0);
  const bounds = useMemo(() => selectionBounds(order,visible,selection), [order,visible,selection]);
  const viewport = columnViewport(visible,ws,new Set(visible.filter(c=>frozen.includes(columns[c].name))),scroll.left,scroll.w,rnW);
  const viewportByColumn = new Map(viewport.map(col => [col.column, col]));
  const cellStyle = (c:number) => { const col=viewportByColumn.get(c)!; return {width:col.width,position:col.frozen ? "sticky" as const : "absolute" as const,left:col.frozen ? col.sticky : col.left,...(col.frozen ? {zIndex:2} : {})}; };
  const range = layout.range(scroll.top, scroll.h, OVERSCAN);
  const { first, last } = range;
  const selIndex = sel ? order.indexOf(sel.r) : -1;
  // 活动格滚出可视区时 aria-activedescendant 会指向不存在的 id
  const activeCell = sel && viewport.some(c=>c.column===sel.c) && selIndex >= first && selIndex < last ? `dbx-cell-${sel.r}-${sel.c}` : undefined;

  const syncScroll = () => {
    const el = boxRef.current;
    if (!el) return;
    preciseTop.current=el.scrollTop;
    const top=Math.floor(el.scrollTop/ROW_H)*ROW_H, left=Math.floor(el.scrollLeft/100)*100;
    setScroll(s=>s.top===top && s.left===left && s.h===el.clientHeight && s.w===el.clientWidth ? s : {...s,top,left,h:el.clientHeight,w:el.clientWidth});
    // 续取：离底部不到 `LOAD_MORE_MARGIN` 就算「滚到底」。`loadedAt` 记住上次触发时的
    // 行数，新行没到之前不重复发——否则一次滚动能连发十几次请求（判据见 gridLoadMore）。
    if (onLoadMore && shouldLoadMore(el, { hasMore: !!hasMore, loading: !!loadingMore, rowsChanged: rows.length !== loadedAt.current, margin: LOAD_MORE_MARGIN })) {
      loadedAt.current = rows.length;
      onLoadMore();
    }
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
      // 行高不固定：用累计偏移定位，`行号 × 行高` 在换行模式下会滚错行。
      // 偏移按显示顺序（`rowIndex`）取，行高按 `rows` 下标取——两者在排序/筛选后不同。
      const y = layout.offsetAt(rowIndex);
      const h = layout.heights[order[rowIndex]] ?? ROW_H;
      if (y < el.scrollTop) el.scrollTop=y;
      else if (y+h > el.scrollTop+height-HEAD_H) el.scrollTop=y+h-height+HEAD_H;
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

  // 编辑态（进入 / 提交并移动 / 取消）抽到 hook：表页与 SQL 结果页共用同一套键盘语义。
  const { editing, valueAt, startEdit: beginEdit, setValue, commit: commitEdit, cancel: cancelEdit } =
    useGridEditing({ rows, order, visible, edit, onSel, reveal, boxRef });
  /**
   * 不可编辑时只说明原因，**不顺带打开详情**：双击是「编辑」手势，不该产生第二种结果。
   * 看完整值走明确入口——F4、右键「查看完整值」、工具栏详情按钮。
   */
  const blockedTipAt = useRef(0);
  const startEdit = (pos: CellPos) => {
    if (beginEdit(pos)) return;
    if (blockedHint && Date.now() - blockedTipAt.current > 4000) {
      blockedTipAt.current = Date.now();
      toast(onDetail ? `${blockedHint}；完整值按 F4 查看` : blockedHint);
    }
  };
  /**
   * 选区批量赋值与 Shift+Enter 大文本编辑框（口径说明见 `useGridTyping`）。
   * 弹层开着的时候不再渲染网格里的编辑 input（`GridRows`），autoFocus 不会互相抢。
   */
  const [textOpen, setTextOpen] = useState(false);
  const { typeInto, openTextEditor } = useGridTyping({ sel, edit, bounds, order, visible, beginEdit, startEdit });
  const openText = () => { if (openTextEditor()) setTextOpen(true); };

  const copySelection = () => {
    if (!sel) return;
    if (onCopy) { onCopy(); return; }
    const text=selection ? selectionText(rows,order,visible,selection,valueAt) : String(valueAt(sel.r,sel.c) ?? "");
    void copyText(text, () => toast("已复制选区", "success"), (e) => toast(`复制失败：${e}`, "error"));
  };
  const navigation=useResultGridNavigation({boxRef,sel,visible,order,reveal,onSel,onSort,onHeaderMenu,onCellMenu,
    editing:!!editing,onOpen:startEdit,onCopy:copySelection,apiRef});
  /**
   * 非编辑态的网格快捷键：Esc 撤回本格原值（DBeaver 的语义），F4 看完整值。
   * F4 而不是 Enter/F2：那两个是「进入编辑」，两者不该混在一起。
   */
  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!editing && sel && edit?.onResetCell && e.key === "Escape") { e.preventDefault(); edit.onResetCell(sel.r, sel.c); return; }
    if (e.key === "F4" && onDetail) { e.preventDefault(); onDetail(); return; }
    // 可打印字符（长度 1、不带修饰键）直接进入编辑：有选区先批量赋值。
    // 放在 navigation 之前：方向键、Home/End 这些 length>1，天然不会撞上。
    // `Enter` 也要排除——它 length 也是 1，但语义是「进入 / 提交」，
    // Shift+Enter 还要打开大文本编辑框，被这里捕获就再也到不了那一分支。
    if (!editing && sel && edit && e.key.length === 1 && e.key !== "Enter" && !e.ctrlKey && !e.metaKey && !e.altKey
      && edit.canEdit(sel.c, sel.r)) { e.preventDefault(); typeInto(e.key); return; }
    if (!editing && sel && edit && e.key === "Enter" && (e.shiftKey || e.altKey) && edit.canEdit(sel.c, sel.r)) {
      e.preventDefault(); openText(); return;
    }
    navigation.onKey(e);
  };
  /** Ctrl+V：把剪贴板里那一块从活动格铺开；只粘一个值时铺满当前选区。 */
  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    if (!edit?.onEditMany || !sel) return;
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    e.preventDefault();
    const cells = pasteTargets(parseClipboardGrid(text), sel, bounds, order, visible, (c, r) => edit.canEdit(c, r));
    if (cells.length) edit.onEditMany(cells);
  };
  // 只有列变了才回顶并结束编辑；拖列宽也会换 widthOverrides 引用，无差别重置会丢滚动位置和编辑中的值
  useEffect(() => {
    setWidths(initialWidths(columns, rows).map((w, c) => widthOverrides[columns[c].name] ?? w));
    if (colKeyRef.current === colKey) return;
    colKeyRef.current = colKey; cancelEdit(); boxRef.current?.scrollTo({ top: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colKey, widthOverrides]);

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
      onKeyDown={onGridKey}
      onPaste={onPaste}
      onScroll={syncScroll}
    >
      <span id={helpId} className="dbx-grid-instructions">方向键移动，Shift 扩选，Ctrl+C 复制。Alt+上箭头进入表头；表头左右键换列，Enter 排序，{onHeaderMenu && "Shift+F10 或菜单键打开菜单，"}下箭头返回数据，Esc 返回原活动格。</span>
      <div className="dbx-grid-inner" style={{ width: total, height: HEAD_H + layout.total }}>
        <ResultGridHeader columns={columns} sort={sort} zh={zh} order={order} visible={visible} viewport={viewport}
          bounds={bounds} total={total} rnW={rnW} cellStyle={cellStyle} navigation={navigation}
          onSel={onSel} onSort={onSort} onHeaderMenu={onHeaderMenu} resize={resize} fit={fit} codec={codec} />
        <GridRows
          order={order}
          first={first}
          last={last}
          layout={layout}
          rowH={ROW_H}
          headH={HEAD_H}
          total={total}
          rnW={rnW}
          viewport={viewport}
          visible={visible}
          bounds={bounds}
          sel={sel}
          editing={editing}
          textOpen={textOpen}
          numeric={numeric}
          wrap={wrap}
          valueAt={valueAt}
          cellStyle={cellStyle}
          edit={edit}
          codec={codec}
          onSel={onSel}
          onCellMenu={onCellMenu}
          startEdit={startEdit}
          boxRef={boxRef}
          onCellEditor={{ onChange: setValue, onCommit: () => commitEdit(), onCancel: cancelEdit, onCommitMove: (dr, dc) => commitEdit([dr, dc]), onExpand: () => setTextOpen(true) }}
        />
      </div>
      {order.length === 0 && <div className="dbx-grid-empty" role="status" style={{top:HEAD_H}}>{empty ?? "没有匹配的行"}</div>}
      {textOpen && editing && (
        <GridTextEditor
          column={columns[editing.pos.c]?.name ?? ""}
          value={editing.value}
          onChange={setValue}
          onClose={() => { setTextOpen(false); boxRef.current?.focus({ preventScroll: true }); }}
        />
      )}
    </div>
  );
}
