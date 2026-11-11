import { useMemo, useRef, useState, type ReactNode } from "react";
import { useResultOrder } from "../../hooks/useResultOrder";
import { selectionBounds } from "../../lib/gridViewport";
import { selectedEditableCells } from "../../lib/gridSelection";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { ContextMenu, type ContextMenuItem } from "../workspace/ContextMenu";
import { ResultGrid, type GridEdit, type ResultGridApi } from "./ResultGrid";
import { CellDetail } from "./CellDetail";
import { thousands } from "../../lib/db";
import { binaryColumn, decodeCell } from "../../lib/cellCodec";
import type { Cell, ColumnMeta } from "../../lib/dbApi";
import { lobLoaderFor } from "../../lib/lobLoader";
import { ResultTransfer } from "./ResultTransfer";
import { freezeTransferFrame, type TransferFrame, type TransferSource } from "../../lib/resultTransferContext";
import { quickCopyTransfer } from "../../lib/resultTransferQuick";
import { fitWidth, nextSort, type SortState } from "../../lib/resultView";
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
import { rowActionItems } from "../../lib/dbRowActions";

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

export function ResultTable({ columns, rows, meta, table, edit, blockedHint, zh, tools, foot, tabs, subbar, settings, running, onServerSort, transferSource, layoutKey, snapshot, onRelated, lob, hasMore, loadingMore, onLoadMore, editOwner }: {
  columns: ColumnMeta[];
  layoutKey?:string; snapshot?:ResultSnapshot; connId?:string|null; onRelated?:(row:Cell[])=>void; editOwner?:string;
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
  const [selection,setSelection] = useState<Selection|null>(null);
  const sel=selection?.end ?? null;
  const [layout,setLayout] = useState(()=>loadLayout(layoutKey));

  const visible=gridColumns(columns,layout);
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
  const { order, pending, error: orderError, retry } = useResultOrder(rows, columns, filter, sort);
  const bounds = selectionBounds(order,visible,selection);

  const valueAt=(r:number,c:number)=>edit?.changed.has(`${r}:${c}`) ? edit.changed.get(`${r}:${c}`)! : rows[r][c];
  const frame: TransferFrame = { data: { columns, rows }, order, visible, selection,
    labels: columns.map(c => zh?.[c.name.toLowerCase()] || c.name),
    source: transferSource ?? { connId: null, resultId: layoutKey || "result", sql: snapshot?.sql ?? "", source: snapshot?.source ?? "当前结果", complete: snapshot?.complete ?? true, table, canRequery: false } };
  const copySelection = () => void quickCopyTransfer(freezeTransferFrame(frame,valueAt));
  /** 选区里的可编辑格；没有选区就是当前格。 */
  const selectedCells = () => edit && bounds ? selectedEditableCells(bounds, order, visible, edit.canEdit) : [];
  const cellMenu = (r:number,c:number,x:number,y:number) => {
    const frozen = freezeTransferFrame({...frame,selection:{anchor:{r,c},end:{r,c}}},valueAt);
    const column = {...frozen,selection:null,visible:[c]};
    setMenu({x,y,items:[
      // 双击只负责编辑，看完整值要有明确入口：右键第一项 + F4 + 工具栏详情按钮。
      {label:"查看完整值",icon:"eye",hint:"F4",onSelect:()=>setDetail(true)},
      {label:"复制原始值",icon:"copy",separator:true,onSelect:()=>void quickCopyTransfer(frozen,"tsv",true)},
      {label:"复制列名",onSelect:()=>void navigator.clipboard.writeText(columns[c].name).then(()=>toast("列名已复制","success"),e=>toast(`复制失败：${String(e)}`,"error"))},
      {label:"复制唯一值（当前筛选列）",onSelect:()=>{const seen=new Set<string>();const order=column.order.filter(i=>{const key=JSON.stringify([typeof valueAt(i,c),valueAt(i,c)]);if(seen.has(key)) return false;seen.add(key);return true;});void quickCopyTransfer({...column,order},"tsv");}},
      {label:"复制为 IN 条件（当前筛选列）",icon:"code",onSelect:()=>void quickCopyTransfer(column,"where")},
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
        <button type="button" className="dbx-btn ghost dbx-filter-trigger" data-on={filterOpen || filter || undefined}
          title="筛选已加载数据 · 网格中 Ctrl+F" aria-label="筛选结果" aria-expanded={filterOpen || !!filter}
          onClick={()=>setFilterOpen(v=>!v)}><Icon name="search" size={14} /><span>筛选</span></button>
        {(filterOpen || filter) && <input ref={filterInput} className="dbx-inp sm dbx-result-filter" value={filter}
          placeholder="输入关键字" aria-label="在结果中筛选" onChange={e=>setFilter(e.target.value)} autoFocus={filterOpen}
          onKeyDown={e=>{if(e.key==="Escape"){e.preventDefault();setFilter("");setFilterOpen(false);gridApi.current?.focusActive();}}} />}
        <button type="button" className="dbx-ibtn" title={`显示、隐藏和冻结列 · 已显示 ${visible.length} / ${columns.length} 列`} aria-label="结果列布局" onClick={()=>setColumnOpen(true)}><Icon name="visibleColumns" size={14} /></button>
        <button type="button" className="dbx-ibtn" title="长文本自动换行 · 行高随内容增减" aria-label="长文本自动换行" aria-pressed={layout.wrap} data-on={layout.wrap || undefined} onClick={()=>setLayoutOnly({...layout,wrap:!layout.wrap})}><Icon name="wrapText" size={14} /></button>
        <button type="button" className="dbx-ibtn" title="按内容自适应全部列宽" aria-label="自适应列宽" onClick={fitAll}><Icon name="fitColumns" size={14} /></button>
        {snapshot && <ResultCompare snapshot={snapshot} related={onRelated ? {label:"关联记录",icon:"external",disabled:!sel,onSelect:()=>sel && onRelated(rows[sel.r])} : undefined} />}
        {!snapshot && onRelated && <button type="button" className="dbx-btn ghost" disabled={!sel} onClick={()=>sel && onRelated(rows[sel.r])}>关联记录</button>}
        <span className="dbx-sp" />
        {!snapshot && <span className="meta">{meta}</span>}
        {tools}
        {(running || pending) && <span className="dbx-busy" role="status"><Icon name="spinner" size={12} />{running ? "执行中…" : "正在整理结果…"}</span>}
        <ResultTransfer frame={frame} valueAt={valueAt} />
        <button type="button" className="dbx-ibtn" data-on={detail || undefined} title="单元格详情 · F4" aria-label="单元格详情" aria-pressed={detail} onClick={()=>setDetail(!detail)}><Icon name="cellInspect" size={14} /></button>
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
          apiRef={gridApi} idPrefix={transferSource ? `dbx-cell-${transferSource.resultId.replace(/[^\w-]/g,"_")}` : undefined}
          columns={columns}
          rows={rows}
          empty={pending ? "正在计算结果…" : orderError ? "结果计算失败" : <><strong>{filter ? "筛选后没有匹配的行" : "没有匹配的行"}</strong><span>{filter ? "结果筛选只作用于已读取的数据。" : "可调整查询条件后重新执行。"}</span>{filter && <button type="button" className="dbx-btn ghost" onClick={()=>setFilter("")}>清除结果筛选</button>}</>}
          order={order}
          sort={sort}
          onSort={(c) => setSort(nextSort(sort, c))}
          onHeaderMenu={(c, x, y) => setHead({ x, y, col: c })}
          sel={sel}
          // 详情是「看一眼就走」的检查器：点到别的格子就收起，不守着 340px 等手动关。
          onSel={(p, extend) => { if (detail && (!sel || sel.r !== p.r || sel.c !== p.c)) setDetail(false); select(p, extend); }}
          selection={selection}
          onCopy={copySelection}
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
          items={[
            { label: "本地升序（只排已取的行）", onSelect: () => setSort({ col: head.col, dir: "asc" }) },
            { label: "本地降序（只排已取的行）", onSelect: () => setSort({ col: head.col, dir: "desc" }) },
            { label: "本列自适应宽度", onSelect: () => fitOne(head.col) },
            { label: "全部列自适应宽度", onSelect: fitAll },
            ...(binaryColumn(columns[head.col]?.type) ? (["auto", "text", "raw"] as const).map(mode => ({
              label: `二进制显示：${mode === "auto" ? "自动识别" : mode === "text" ? "文本" : "原始 Hex"}`,
              checked: binaryMode === mode,
              onSelect: () => setBinaryMode(mode),
            })) : [{
              label: headDecoded ? "恢复原始值（关闭解码）" : "显示解码后的值（Hex / Base64）",
              disabled: !headDecoded && !headDecodable,
              onSelect: () => toggleDecode(head.col),
            }]),
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
