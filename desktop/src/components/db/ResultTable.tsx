import { useRef, useState, type ReactNode } from "react";
import { useResultOrder } from "../../hooks/useResultOrder";
import { selectionBounds } from "../../lib/gridViewport";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { ContextMenu, type ContextMenuItem } from "../workspace/ContextMenu";
import { ResultGrid, type GridEdit, type ResultGridApi } from "./ResultGrid";
import { CellDetail } from "./CellDetail";
import { thousands } from "../../lib/db";
import type { Cell, ColumnMeta } from "../../lib/dbApi";
import { ResultTransfer } from "./ResultTransfer";
import { freezeTransferFrame, type TransferFrame, type TransferSource } from "../../lib/resultTransferContext";
import { quickCopyTransfer } from "../../lib/resultTransferQuick";
import { nextSort, type SortState } from "../../lib/resultView";
import { serverSortLabel } from "../../lib/serverSort";

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

export function ResultTable({ columns, rows, meta, table, edit, zh, tools, foot, tabs, subbar, settings, running, onServerSort, transferSource, layoutKey, snapshot, onRelated }: {
  columns: ColumnMeta[];
  layoutKey?:string; snapshot?:ResultSnapshot; connId?:string|null; onRelated?:(row:Cell[])=>void;
  rows: Cell[][];
  /** 结果条左侧的说明：行数 / 耗时。 */
  meta: ReactNode;
  /** 复制为 INSERT 时用的表名。 */
  table: string;
  edit?: GridEdit;
  zh?: Record<string, string>;
  /** 结果条右侧额外的按钮（表页的保存 / 预览 SQL）。 */
  tools?: ReactNode;
  foot?: ReactNode | ((selection: ReactNode) => ReactNode);
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
}) {
  const [filter, setFilter] = useState("");
  const gridApi = useRef<ResultGridApi | null>(null);
  const filterInput = useRef<HTMLInputElement>(null);

  const [sort, setSort] = useState<SortState | null>(null);
  const [selection,setSelection] = useState<Selection|null>(null);
  const sel=selection?.end ?? null;
  const [layout,setLayout] = useState(()=>loadLayout(layoutKey));

  const visible=gridColumns(columns,layout);
  const setColumns=(value:GridLayout)=>{setLayout(value);setSelection(null);try{saveLayout(layoutKey,value);}catch{toast("列布局未能保存，当前布局仍可使用","error");}};
  const select=(p:{r:number;c:number},extend=false)=>setSelection(current=>({anchor:extend && current ? current.anchor : p,end:p}));
  const [ui,setUi] = useState<{filterOpen:boolean;columnOpen:boolean;detail:boolean;menu:{x:number;y:number;items:ContextMenuItem[]}|null;head:{x:number;y:number;col:number}|null}>({filterOpen:false,columnOpen:false,detail:false,menu:null,head:null});
  const {filterOpen,columnOpen,detail,menu,head}=ui;
  const setFilterOpen=(value:boolean|((v:boolean)=>boolean))=>setUi(v=>({...v,filterOpen:typeof value==="function"?value(v.filterOpen):value}));
  const setColumnOpen=(columnOpen:boolean)=>setUi(v=>({...v,columnOpen}));
  const setDetail=(detail:boolean)=>setUi(v=>({...v,detail}));
  const setMenu=(menu:typeof ui.menu)=>setUi(v=>({...v,menu}));
  const setHead=(head:typeof ui.head)=>setUi(v=>({...v,head}));
  const { order, pending, error: orderError, retry } = useResultOrder(rows, columns, filter, sort);
  const bounds = selectionBounds(order,visible,selection);

  const valueAt=(r:number,c:number)=>edit?.changed.has(`${r}:${c}`) ? edit.changed.get(`${r}:${c}`)! : rows[r][c];
  const frame: TransferFrame = { data: { columns, rows }, order, visible, selection,
    labels: columns.map(c => zh?.[c.name.toLowerCase()] || c.name),
    source: transferSource ?? { connId: null, resultId: layoutKey || "result", sql: snapshot?.sql ?? "", source: snapshot?.source ?? "当前结果", complete: snapshot?.complete ?? true, table, canRequery: false } };
  const copySelection = () => void quickCopyTransfer(freezeTransferFrame(frame,valueAt));
  const cellMenu = (r:number,c:number,x:number,y:number) => {
    const frozen = freezeTransferFrame({...frame,selection:{anchor:{r,c},end:{r,c}}},valueAt);
    const column = {...frozen,selection:null,visible:[c]};
    setMenu({x,y,items:[
      {label:"复制原始值",icon:"copy",onSelect:()=>void quickCopyTransfer(frozen,"tsv",true)},
      {label:"复制列名",onSelect:()=>void navigator.clipboard.writeText(columns[c].name).then(()=>toast("列名已复制","success"),e=>toast(`复制失败：${String(e)}`,"error"))},
      {label:"复制唯一值（当前筛选列）",onSelect:()=>{const seen=new Set<string>();const order=column.order.filter(i=>{const key=JSON.stringify([typeof valueAt(i,c),valueAt(i,c)]);if(seen.has(key)) return false;seen.add(key);return true;});void quickCopyTransfer({...column,order},"tsv");}},
      {label:"复制为 IN 条件（当前筛选列）",icon:"code",onSelect:()=>void quickCopyTransfer(column,"where")},
    ]});
  };

  const selValue = sel ? valueAt(sel.r,sel.c) : undefined;
  const selectionSummary = bounds && <span className="dbx-selection-summary">选区 {bounds.rowEnd-bounds.rowStart+1} 行 × {bounds.colEnd-bounds.colStart+1} 列</span>;

  return (
    <div className="dbx-result-table" onKeyDown={event=>{
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase()==="f" &&
        event.target instanceof HTMLElement && event.target.closest('[role="grid"]') && !event.target.closest('input,textarea,[contenteditable="true"]')) {
        event.preventDefault();setFilterOpen(true);requestAnimationFrame(()=>filterInput.current?.focus());
      }
    }}>
      {tabs && <div className="dbx-result-head">{tabs}</div>}
      <div className="dbx-rbar dbx-result-tools">
        <button type="button" className="dbx-btn ghost dbx-filter-trigger" data-on={filterOpen || filter || undefined}
          title="筛选已加载数据 · 网格中 Ctrl+F" aria-label="筛选结果" aria-expanded={filterOpen || !!filter}
          onClick={()=>setFilterOpen(v=>!v)}><Icon name="search" size={14} /><span>筛选已加载数据</span></button>
        {(filterOpen || filter) && <input ref={filterInput} className="dbx-inp sm dbx-result-filter" value={filter}
          placeholder="输入关键字" aria-label="在结果中筛选" onChange={e=>setFilter(e.target.value)} autoFocus={filterOpen}
          onKeyDown={e=>{if(e.key==="Escape"){e.preventDefault();setFilter("");setFilterOpen(false);gridApi.current?.focusActive();}}} />}
        <button type="button" className="dbx-btn ghost" title="显示、隐藏、冻结列与恢复布局" aria-label="结果列布局" onClick={()=>setColumnOpen(true)}><Icon name="sliders" size={14} /><span className="dbx-action-label">显示列 {visible.length} / {columns.length}</span></button>
        {snapshot && <ResultCompare snapshot={snapshot} related={onRelated ? {label:"关联记录",icon:"external",disabled:!sel,onSelect:()=>sel && onRelated(rows[sel.r])} : undefined} />}
        {!snapshot && onRelated && <button type="button" className="dbx-btn ghost" disabled={!sel} onClick={()=>sel && onRelated(rows[sel.r])}>关联记录</button>}
        <span className="dbx-sp" />
        {!snapshot && <span className="meta">{meta}</span>}
        {typeof foot !== "function" && selectionSummary}
        {tools}
        {(running || pending) && <span className="dbx-busy" role="status"><Icon name="spinner" size={12} />{running ? "执行中…" : "正在整理结果…"}</span>}
        <ResultTransfer frame={frame} valueAt={valueAt} />
        <button type="button" className="dbx-ibtn" data-on={detail || undefined} title="单元格详情" aria-label="单元格详情" aria-pressed={detail} onClick={()=>setDetail(!detail)}><Icon name="info" size={14} /></button>
        {snapshot && <ResultSource snapshot={snapshot} meta={meta} />}
        {settings}
      </div>
      {(sort || filter) && <div className="dbx-result-view-state" role="status">
        {filter && <span>筛出 <b>{thousands(order.length)}</b> 行</span>}
          <span
            className="dbx-localhint"
            title={
              onServerSort
                ? "表头排序与筛选只作用于已经取到的行；要整表有序：右键表头 →「重排并重查」"
                : "表头排序与筛选只作用于已经取到的行"
            }
          >
            仅作用于已取的 {thousands(rows.length)} 行{onServerSort ? " · 右键表头可整表重排" : ""}
          </span>
        <button type="button" className="dbx-lk" onClick={()=>{setFilter("");setSort(null);}}>清除筛选与排序</button>
      </div>}
      {orderError && <div role="alert">{orderError}<button type="button" onClick={retry}>重试计算</button><button type="button" onClick={()=>{setFilter("");setSort(null);}}>清除筛选与排序</button></div>}
      {subbar && <div className="dbx-rsub">{subbar}</div>}
      <div className="dbx-rbody">
        <ResultGrid
          apiRef={gridApi}
          columns={columns}
          rows={rows}
          empty={pending ? "正在计算结果…" : orderError ? "结果计算失败" : <><strong>{filter ? "筛选后没有匹配的行" : "没有匹配的行"}</strong><span>{filter ? "结果筛选只作用于已读取的数据。" : "可调整查询条件后重新执行。"}</span>{filter && <button type="button" className="dbx-btn ghost" onClick={()=>setFilter("")}>清除结果筛选</button>}</>}
          order={order}
          sort={sort}
          onSort={(c) => setSort(nextSort(sort, c))}
          onHeaderMenu={(c, x, y) => setHead({ x, y, col: c })}
          sel={sel}
          onSel={select}
          selection={selection}
          onCopy={copySelection}
          onCellMenu={cellMenu}
          visible={visible}
          frozen={layout.frozen}
          widthOverrides={layout.widths}
          onWidths={w=>setColumns({...layout,widths:Object.fromEntries(columns.map((c,i)=>[c.name,w[i]]))})}
          onOpen={() => setDetail(true)}
          edit={edit}
          zh={zh}
        />
        {detail && (
          <CellDetail
            column={sel ? columns[sel.c] : null}
            zh={sel ? zh?.[columns[sel.c]?.name.toLowerCase()] : undefined}
            row={sel ? sel.r + 1 : null}
            value={selValue === undefined ? null : selValue}
            empty={!sel}
            onClose={() => {setDetail(false);requestAnimationFrame(()=>gridApi.current?.focusActive());}}
          />
        )}
      </div>
      {foot && <div className="dbx-result-footer">{typeof foot === "function" ? foot(selectionSummary) : foot}</div>}
      {columnOpen && <GridColumns columns={columns} layout={layout} onChange={setColumns} onClose={()=>setColumnOpen(false)} />}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {head && (
        <ContextMenu
          x={head.x}
          y={head.y}
          onClose={() => setHead(null)}
          items={[
            { label: "本地升序（只排已取的行）", onSelect: () => setSort({ col: head.col, dir: "asc" }) },
            { label: "本地降序（只排已取的行）", onSelect: () => setSort({ col: head.col, dir: "desc" }) },
            {
              label: onServerSort ? serverSortLabel(columns[head.col]?.name ?? "", "asc") : "重排并重查（这条结果不支持）",
              disabled: !onServerSort,
              onSelect: () => onServerSort?.(head.col, "asc"),
            },
            {
              label: onServerSort ? serverSortLabel(columns[head.col]?.name ?? "", "desc") : "重排并重查（这条结果不支持）",
              disabled: !onServerSort,
              onSelect: () => onServerSort?.(head.col, "desc"),
            },
          ]}
        />
      )}
    </div>
  );
}
