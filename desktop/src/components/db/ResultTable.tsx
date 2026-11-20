import { useMemo, useRef, useState, type ReactNode } from "react";
import { useResultOrder } from "../../hooks/useResultOrder";
import { selectionBounds } from "../../lib/gridViewport";
import { selectedEditableCells } from "../../lib/gridSelection";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { ContextMenu, type ContextMenuItem } from "../workspace/ContextMenu";
import { ResultGrid, type GridEdit, type ResultGridApi } from "./ResultGrid";
import { CellDetail } from "./CellDetail";
import { binaryColumn, decodeCell } from "../../lib/cellCodec";
import type { Cell, ColumnMeta } from "../../lib/dbApi";
import { lobLoaderFor } from "../../lib/lobLoader";
import { ResultTransfer } from "./ResultTransfer";
import type { TransferFrame, TransferSource } from "../../lib/resultTransferContext";
import { quickCopyTransfer } from "../../lib/resultTransferQuick";
import { fitWidth, nextSort, cellBrief, type SortState, type ValueFilter } from "../../lib/resultView";
import { headMenuItems } from "../../lib/resultHeadMenu";
import { ResultViewState } from "./ResultViewState";

/**
 * 结果表 + 工具条（筛选 / 复制为… / 导出 / 详情）+ 底栏。SQL 控制台与表页共用。
 *
 * 复制与导出都按「当前显示顺序」（筛选、排序之后的），所见即所得。
 *
 * **排序口径**（A3）：表头点击的排序与筛选都只作用于**已经取到的行**。一旦真的排了
 * 或筛了，结果条上就出现「仅作用于已取的 N 行」；要让数据库重排整表，走表头右键的
 * 「重排并重查」（`onServerSort`）。
 */
import { GridColumns } from "./GridColumns";
import { ResultCompare } from "./ResultCompare";
import { ResultSource } from "./ResultSource";
import { loadLayout, saveLayout, gridColumns, type Selection, type GridLayout, type ResultSnapshot } from "../../lib/dbResultTools";
import { rowActionItems } from "../../lib/dbRowActions";

import { thousands } from "../../lib/db";
import type { ResultFilterMatch } from "../../lib/dbResultFollowup";
/**
 * 取大文本完整值需要的上下文。结果集只带 8K 预览，用户点「加载完整值」时
 * 后端按 `sql` 重查第 `row_index` 行、取 `column` 那一列。
 *
 * `slot` 必须与执行这条 SQL 时是同一条会话，否则默认 schema / 事务上下文对不上。
 */
export interface LobSource {
  connId: string;
  slot?: string | null;
  sql: string;
  timeoutSec?: number;
  /**
   * 这一行自己的定位 SQL（表页按主键定位，返回 `select * from 表 where 主键 = ...`）。
   * 返回 `null` = 这一行没有可用的定位条件（新增草稿行 / 没主键且语句带绑定），
   * 详情面板就不显示「加载完整值」，而不是拿错行。
   */
  sqlForRow?: (row: number) => string | null;
  binarySqlForRow?: (row: number, column: number) => string | null;
}
export function ResultTable({ columns, rows, meta, table, edit, blockedHint, zh, tools, foot, tabs, subbar, settings, running, onServerSort, transferSource, layoutKey, templateLayoutKey, snapshot, onRelated, lob, hasMore, loadingMore, onLoadMore, editOwner, requery }: {
  columns: ColumnMeta[];
  layoutKey?:string; snapshot?:ResultSnapshot; connId?:string|null; onRelated?:(row:Cell[])=>void; editOwner?:string;
  templateLayoutKey?: string;
  requery?: (match: ResultFilterMatch) => void;
  /** 大文本「加载完整值」的上下文；不传 = 这个结果不支持（表页 / 非查询结果）。 */
  lob?: LobSource;
  rows: Cell[][];
  /** 结果条左侧的说明：行数 / 耗时。 */
  meta: ReactNode;
  /** 复制为 INSERT 时用的表名。 */
  table: string;
  edit?: GridEdit;
  /** 结果不可编辑的原因：双击时提示一次，不让人对着「没反应」猜。 */
  blockedHint?: string;
  zh?: Record<string, string>;
  /** 结果条右侧额外的按钮（表页的保存 / 预览 SQL）。 */
  tools?: ReactNode;
  foot?: ReactNode;
  /** 结果标签（SQL 控制台传；表页没有），放在结果条最左边。 */
  tabs?: ReactNode;
  /** 条件出现的副条：多结果集 / 导出进度。 */
  subbar?: ReactNode;
  /** 结果条最右侧的设置入口（查询设置齿轮）。 */
  settings?: ReactNode;
  /** 执行中：结果条右侧转圈。 */
  running?: boolean;
  /** 让数据库重排整表并重查；不传 = 这个结果不支持（表页 / 非 SELECT）。 */
  onServerSort?: (col: number, dir: "asc" | "desc") => void;
  transferSource?: TransferSource;
  /** 还有更多行没取（分页结果）：滚到底自动续取，工具条显示加载态。 */
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
}) {
  const [filter, setFilter] = useState("");
  const gridApi = useRef<ResultGridApi | null>(null);
  const filterInput = useRef<HTMLInputElement>(null);

  const [sort, setSort] = useState<SortState | null>(null);
  /** 「以此值筛选」：只在一列里做整值相等，和关键字筛选可以叠加。 */
  const [valueFilter, setValueFilter] = useState<(ValueFilter & { original?: Cell }) | null>(null);
  /** 关键字筛选 / 排序 / 值筛选一起清掉：状态条与「计算失败」两处都要，别写成两份。 */
  const clearView = () => { setFilter(""); setSort(null); setValueFilter(null); };
  const [selection,setSelection] = useState<Selection|null>(null);
  const sel=selection?.end ?? null;
  const singleCell = sel && selection?.anchor.r === sel.r && selection.anchor.c === sel.c ? sel : null;
  const chosenValue = singleCell && !edit?.isDraftRow?.(singleCell.r) ? rows[singleCell.r]?.[singleCell.c] : undefined;
  const currentMatch = valueFilter?.original !== undefined ? { column: valueFilter.col, value: valueFilter.original, keyword: filter }
    : filter.trim() ? { keyword: filter } : singleCell && chosenValue !== undefined ? { column: singleCell.c, value: chosenValue } : null;
  const [layout,setLayout] = useState(()=>loadLayout(templateLayoutKey, layoutKey));
  const visible=useMemo(() => gridColumns(columns,layout), [columns,layout]);
  const setColumns=(value:GridLayout)=>{setLayout(value);setSelection(null);try{saveLayout(layoutKey,value);}catch{toast("列布局未能保存，当前布局仍可使用","error");}};
  // 宽度 / 换行 / 解码只影响显示，不该把用户正选着的区域扔掉——于是不走 `setColumns`。
  const setLayoutOnly=(value:GridLayout)=>{setLayout(value);try{saveLayout(layoutKey,value);}catch{toast("列布局未能保存，当前布局仍可使用","error");}};
  const select=(p:{r:number;c:number},extend=false)=>setSelection(current=>({anchor:extend && current ? current.anchor : p,end:p}));
  // 自适应列宽：全部 = 清空手调值，回到 `fitWidth` 的测量结果；
  // 单列 = 只把这一列记成手调宽度，其余列保持用户已经调好的样子。
  const fitAll=()=>setLayoutOnly({...layout,widths:{}});
  const fitOne=(c:number)=>{const name=columns[c]?.name; if(name) setLayoutOnly({...layout,widths:{...layout.widths,[name]:fitWidth(columns[c],rows,c)}});};
  const [ui,setUi] = useState<{filterOpen:boolean;columnOpen:boolean;detail:boolean;menu:{x:number;y:number;items:ContextMenuItem[]}|null;head:{x:number;y:number;col:number}|null}>({filterOpen:false,columnOpen:false,detail:false,menu:null,head:null});
  const {filterOpen,columnOpen,detail,menu,head}=ui;
  const setFilterOpen=(value:boolean|((v:boolean)=>boolean))=>setUi(v=>({...v,filterOpen:typeof value==="function"?value(v.filterOpen):value}));
  const setColumnOpen=(columnOpen:boolean)=>setUi(v=>({...v,columnOpen}));
  const setDetail=(detail:boolean)=>setUi(v=>({...v,detail}));
  const setMenu=(menu:typeof ui.menu)=>setUi(v=>({...v,menu}));
  const setHead=(head:typeof ui.head)=>setUi(v=>({...v,head}));
  const { order, pending, error: orderError, retry } = useResultOrder(rows, columns, filter, sort, valueFilter);
  const bounds = selectionBounds(order,visible,selection);
  const valueAt=(r:number,c:number)=>edit?.changed.has(`${r}:${c}`) ? edit.changed.get(`${r}:${c}`)! : rows[r][c];
  const frame: TransferFrame = { data: { columns, rows }, order, visible, selection,
    labels: columns.map(c => zh?.[c.name.toLowerCase()] || c.name),
    source: transferSource ?? { connId: null, resultId: layoutKey || "result", sql: snapshot?.sql ?? "", source: snapshot?.source ?? "当前结果", complete: snapshot?.complete ?? true, table, canRequery: false } };
  /** 选区里的可编辑格；没有选区就是当前格。 */
  const selectedCells = () => edit && bounds ? selectedEditableCells(bounds, order, visible, edit.canEdit) : [];
  const cellMenu = (r:number,c:number,x:number,y:number) => {
    const cell = {...frame,selection:{anchor:{r,c},end:{r,c}}};
    const column = {...cell,selection:null,visible:[c]};
    setMenu({x,y,items:[
      // 双击只负责编辑，看完整值要有明确入口：右键第一项 + F4 + 工具栏详情按钮。
      {label:"查看完整值",icon:"eye",hint:"F4",onSelect:()=>setDetail(true)},
      // 「以此值筛选」读的是 `rows` 里的原值，不是未写回的编辑草稿：本地筛选只作用于
      // 已取到的数据，拿编辑后的值去筛会立刻筛出 0 行。
      {label: (() => { const v = rows[r]?.[c] ?? null; return v === null ? "只看这一列为空" : `只看「${cellBrief(v)}」`; })(),
        icon:"filter", hint: columns[c]?.name, onSelect: () => { const v = rows[r]?.[c] ?? null; setValueFilter({ col: c, original: v, value: v === null ? null : String(v) }); }},
      ...(requery && rows[r]?.[c] !== undefined && !edit?.isDraftRow?.(r) ? [{ label: "按此值重新查询", icon: "database" as const, onSelect: () => requery({ column: c, value: rows[r][c] }) }] : []),
      {label:"复制原始值",icon:"copy",separator:true,onSelect:()=>void quickCopyTransfer(cell,"tsv",true,edit?.changed)},
      {label:"复制列名",onSelect:()=>void navigator.clipboard.writeText(columns[c].name).then(()=>toast("列名已复制","success"),e=>toast(`复制失败：${String(e)}`,"error"))},
      {label:"复制唯一值（当前筛选列）",onSelect:()=>{const seen=new Set<Cell>();const order=column.order.filter(i=>{const key=valueAt(i,c);if(seen.has(key)) return false;seen.add(key);return true;});void quickCopyTransfer({...column,order},"tsv",false,edit?.changed);}},
      {label:"复制为 IN 条件（当前筛选列）",icon:"code",onSelect:()=>void quickCopyTransfer(column,"where",false,edit?.changed)},
      // 编辑相关动作只在「这一格真能改」时出现：主键列、只读类型、视图都没有这些项。
      ...(edit?.canEdit(c, r) ? [
        // 选中一列再置空是最常用的批量动作：有选区就作用整个选区，没选区就是这一格。
        { label: selectedCells().length > 1 ? `选区设为 NULL（${selectedCells().length} 格）` : "设为 NULL",
          hint: "写回时这些列置空",
          onSelect: () => {
            const cells = selectedCells();
            if (edit.onEditMany && cells.length > 1) edit.onEditMany(cells.map(cell => ({ ...cell, value: null })));
            else edit.onEdit(r, c, null);
          } },
        ...(edit.changed.has(`${r}:${c}`) && edit.onResetCell
          ? [{ label: "撤销本格改动", icon: "restore" as const, separator: true,
              onSelect: () => {
                const cells = selectedCells();
                if (cells.length > 1) cells.forEach(cell => edit.onResetCell!(cell.row, cell.col));
                else edit.onResetCell!(r, c);
              } }]
          : []),
      ] : []),
      ...(edit?.onCloneRow ? [{ label: "复制此行（新增）", icon: "copy" as const, hint: "主键列留空", onSelect: () => edit.onCloneRow!(r) }] : []),
      // 行级增删只挂在能定位唯一行的结果上（表页有主键、且不是只读）。
      // 放在单元格右键而不是工具条：删除是「对着这一行」的动作，选中态会随排序/筛选漂移。
      ...rowActionItems(edit, r),
    ]});
  };

  const selValue = sel ? valueAt(sel.r,sel.c) : undefined;
  // 详情面板要显示网格里那个「第 N 行」（排序/筛选后的显示序号）。
  // 直接用 `sel.r + 1` 是原始下标，筛选后会和网格对不上。
  const selRowNo = sel ? (order.indexOf(sel.r) >= 0 ? order.indexOf(sel.r) + 1 : sel.r + 1) : null;
  // 详情面板的「加载完整值」：行号用 `sel.r`（`rows` 下标，不是显示顺序），
  // 列名用原始列名——后端要靠它在定位 SQL 里取这一格。
  const lobLoader = lobLoaderFor(lob, sel?.r ?? null, sel ? columns[sel.c]?.name ?? "" : "", sel && binaryColumn(columns[sel.c]?.type) ? sel.c : undefined);
  // 解码开关按列名存进布局：下次查同一张表同一列还是这个状态。
  const toggleDecode=(c:number)=>{
    const name=columns[c]?.name; if(!name) return;
    const decoded=layout.decoded.includes(name)?layout.decoded.filter(n=>n!==name):[...layout.decoded,name];
    setLayoutOnly({...layout,decoded});
  };
  // 右键菜单要提前知道「这列能不能解」，否则点了没反应。只抽前 50 行，够判断也不拖慢渲染。
  const headName = head ? columns[head.col]?.name ?? "" : "";
  const headDecoded = layout.decoded.includes(headName);
  const binaryMode = layout.raw?.includes(headName) ? "raw" : headDecoded ? "text" : "auto";
  const setBinaryMode = (mode: "auto" | "text" | "raw") => setLayoutOnly({
    ...layout,
    decoded: [...layout.decoded.filter(name => name !== headName), ...(mode === "text" ? [headName] : [])],
    raw: [...(layout.raw ?? []).filter(name => name !== headName), ...(mode === "raw" ? [headName] : [])],
  });
  const headDecodable = useMemo(() => head ? rows.slice(0,50).some(r=>decodeCell(r[head.col],{auto:true})) : false, [head, rows]);
  return (
    <div className="dbx-result-table" data-result-edit-owner={editOwner} onKeyDown={event=>{
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase()==="f" &&
        event.target instanceof HTMLElement && event.target.closest('[role="grid"]') && !event.target.closest('input,textarea,[contenteditable="true"]')) {
        event.preventDefault();setFilterOpen(true);requestAnimationFrame(()=>filterInput.current?.focus());
      }
    }}>
      {tabs && <div className="dbx-result-head">{tabs}</div>}
      <div className="dbx-rbar dbx-result-tools">
        <button type="button" className="dbx-btn ghost dbx-filter-trigger" data-on={filterOpen || !!filter || !!valueFilter || undefined}
          title="筛选已加载行 · 网格中 Ctrl+F" aria-label="筛选已加载行" aria-expanded={filterOpen || !!filter}
          onClick={()=>setFilterOpen(v=>!v)}><Icon name="search" size={14} /><span>筛选已加载行</span></button>
        {requery && currentMatch && <button type="button" className="dbx-btn ghost" onClick={() => requery(currentMatch)}>数据库重查</button>}
        {(filterOpen || filter) && <input ref={filterInput} className="dbx-inp sm dbx-result-filter" value={filter}
          placeholder="输入关键字" aria-label="在结果中筛选" onChange={e=>{setFilter(e.target.value);setValueFilter(null);}} autoFocus={filterOpen}
          onKeyDown={e=>{if(e.key==="Escape"){e.preventDefault();setFilter("");setFilterOpen(false);gridApi.current?.focusActive();}}} />}
        <button type="button" className="dbx-btn ghost" aria-label="显示选项" aria-haspopup="menu" onClick={event => {
          const box = event.currentTarget.getBoundingClientRect();
          setMenu({ x: box.left, y: box.bottom + 4, items: [
            { label: "结果列布局", icon: "visibleColumns", hint: `${visible.length} / ${columns.length} 列`, onSelect: () => setColumnOpen(true) },
            ...(templateLayoutKey ? [{ label: "保存布局到查询模板", icon: "pin" as const, onSelect: () => {
              try { saveLayout(templateLayoutKey, layout); toast("列布局已保存到查询模板", "success"); }
              catch { toast("列布局未能保存，当前布局仍可使用", "error"); }
            } }] : []),
            { label: "长文本自动换行", icon: "wrapText", checked: layout.wrap, onSelect: () => setLayoutOnly({...layout,wrap:!layout.wrap}) },
            { label: "自适应列宽", icon: "fitColumns", onSelect: fitAll },
          ] });
        }}><Icon name="visibleColumns" size={14} /><span className="dbx-action-label">显示</span><Icon name="chevronDown" size={12} /></button>
        {snapshot && <ResultCompare snapshot={snapshot} related={onRelated && !requery ? {label:"关联记录",icon:"external",disabled:!sel,onSelect:()=>sel && onRelated(rows[sel.r])} : undefined} />}
        {onRelated && (requery || !snapshot) && <button type="button" className="dbx-btn ghost" disabled={!sel || !!edit?.isDraftRow?.(sel.r)}
          onClick={() => sel && onRelated(rows[sel.r])}>关联记录</button>}
        <span className="dbx-sp" />
        {!snapshot && <span className="meta">{meta}</span>}
        {tools}
        {(running || pending) && <span className="dbx-busy" role="status"><Icon name="spinner" size={12} />{running ? "执行中…" : "正在整理结果…"}</span>}
        <ResultTransfer frame={frame} edits={edit?.changed} />
        <button type="button" className="dbx-ibtn" data-on={detail || undefined} title="单元格详情 · F4" aria-label="单元格详情" aria-pressed={detail} onClick={()=>setDetail(!detail)}><Icon name="cellInspect" size={14} /></button>
        {snapshot && <ResultSource snapshot={snapshot} meta={meta} />}
        {settings}
      </div>
      <ResultViewState filter={filter} sort={sort} valueFilter={valueFilter} columns={columns}
        visibleCount={order.length} loadedCount={rows.length} pending={pending}
        serverSort={!!onServerSort} onClear={clearView} />
      {orderError && <div role="alert">{orderError}<button type="button" onClick={retry}>重试计算</button><button type="button" onClick={clearView}>清除筛选与排序</button></div>}
      {subbar && <div className="dbx-rsub">{subbar}</div>}
      <div className="dbx-rbody">
        <ResultGrid
          apiRef={gridApi} idPrefix={transferSource ? `dbx-cell-${transferSource.resultId.replace(/[^\w-]/g,"_")}` : undefined}
          columns={columns}
          rows={rows}
          empty={pending ? "正在计算结果…" : orderError ? "结果计算失败" : <><strong>{filter || valueFilter ? "筛选后没有匹配的行" : "没有匹配的行"}</strong><span>{filter || valueFilter ? `已读取 ${thousands(rows.length)} 行，当前范围无匹配。` : "可调整查询条件后重新执行。"}</span>{(filter || valueFilter) && <button type="button" className="dbx-btn ghost" onClick={()=>{setFilter("");setValueFilter(null);}}>清除结果筛选</button>}</>}
          order={order}
          sort={sort}
          onSort={(c) => setSort(nextSort(sort, c))}
          onHeaderMenu={(c, x, y) => setHead({ x, y, col: c })}
          sel={sel}
          // 详情是「看一眼就走」的检查器：点到别的格子就收起，不守着 340px 等手动关。
          onSel={(p, extend) => { if (detail && (!sel || sel.r !== p.r || sel.c !== p.c)) setDetail(false); select(p, extend); }}
          selection={selection}
          onCopy={() => void quickCopyTransfer(frame,"tsv",false,edit?.changed)}
          onCellMenu={cellMenu}
          visible={visible}
          frozen={layout.frozen}
          widthOverrides={layout.widths}
          decoded={layout.decoded}
          raw={layout.raw}
          wrap={layout.wrap}
          hasMore={hasMore}
          loadingMore={loadingMore}
          onLoadMore={onLoadMore}
          onWidths={(k,w)=>{const name=columns[k]?.name; if(name) setLayoutOnly({...layout,widths:{...layout.widths,[name]:w}});}}
          onDetail={() => setDetail(true)}
          edit={edit}
          blockedHint={blockedHint}
          zh={zh}
        />
        {detail && (
          <CellDetail
            column={sel ? columns[sel.c] : null}
            zh={sel ? zh?.[columns[sel.c]?.name.toLowerCase()] : undefined}
            row={selRowNo}
            value={selValue === undefined ? null : selValue}
            empty={!sel}
            lob={lobLoader}
            sql={lob?.sql ?? snapshot?.sql}
            onClose={() => {setDetail(false);requestAnimationFrame(()=>gridApi.current?.focusActive());}}
          />
        )}
      </div>
      {foot && <div className="dbx-result-footer">{foot}</div>}
      {columnOpen && <GridColumns columns={columns} layout={layout} onChange={setColumns} onClose={()=>setColumnOpen(false)} />}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {head && (
        <ContextMenu
          x={head.x}
          y={head.y}
          onClose={() => setHead(null)}
          items={headMenuItems({
            col: head.col, columns, binaryMode, decoded: headDecoded, decodable: headDecodable,
            onServerSort, setSort, fitOne, fitAll, setBinaryMode, toggleDecode,
          })}
        />
      )}
    </div>
  );
}
