import { useMemo, useState, type ReactNode } from "react";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { ContextMenu, type ContextMenuItem } from "../workspace/ContextMenu";
import { ResultGrid, type GridEdit } from "./ResultGrid";
import { CellDetail } from "./CellDetail";
import { thousands } from "../../lib/db";
import type { Cell, ColumnMeta } from "../../lib/dbApi";
import { downloadText, toCsv, toInList, toInsert, toMarkdown, toTsv } from "../../lib/resultExport";
import { nextSort, viewOrder, type SortState } from "../../lib/resultView";
import { serverSortLabel } from "../../lib/serverSort";

/** 流式导出的三种格式（A4）。 */
export type ExportFormat = "csv" | "tsv" | "insert";

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
import { loadLayout, saveLayout, gridColumns, selectedRows, selectedCols, selectionText, type Selection, type GridLayout, type ResultSnapshot } from "../../lib/dbResultTools";

export function ResultTable({ columns, rows, meta, table, edit, zh, tools, foot, tabs, subbar, settings, running, onServerSort, onExportFile, layoutKey, snapshot, onRelated }: {
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
  /** 后端流式导出整条查询；不传 = 只提供「导出当前显示的行」。 */
  onExportFile?: (format: ExportFormat) => void;
}) {
  const [filter, setFilter] = useState("");

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
  const order = useMemo(() => viewOrder(rows, columns, filter, sort), [rows, columns, filter, sort]);

  const valueAt=(r:number,c:number)=>edit?.changed.has(`${r}:${c}`) ? edit.changed.get(`${r}:${c}`)! : rows[r][c];
  const shown = () => order.map(i=>visible.map(c=>valueAt(i,c)));
  const shownColumns=visible.map(c=>columns[c]);
  const copySelection=()=>{if(selection) void copy("选区",selectionText(rows,order,visible,selection,valueAt),selectedRows(order,selection).length);};
  const copy = (label: string, text: string, count=order.length) =>
    navigator.clipboard.writeText(text).then(
      () => toast(`已复制为 ${label}（${thousands(count)} 行）`, "success"),
      (e) => toast(`复制失败：${e}`, "error"),
    );

  const copyMenu = (x: number, y: number) => {
    const col = Math.max(0,visible.indexOf(sel?.c ?? visible[0]));
    setMenu({
      x,
      y,
      items: [
        {label:"复制选区（无表头）",icon:"copy",disabled:!selection,onSelect:copySelection},
        { label: "当前显示 · TSV（贴 Excel）", icon: "copy", onSelect: () => void copy("TSV", toTsv(shownColumns, shown())) },
        { label: "CSV", icon: "copy", onSelect: () => void copy("CSV", toCsv(shownColumns, shown())) },
        { label: `INSERT 语句（${table || "表名"}）`, icon: "copy", onSelect: () => void copy("INSERT", toInsert(table || "table_name", shownColumns, shown())) },
        { label: `in (…) 列表（${shownColumns[col]?.name.toLowerCase() ?? ""}）`, icon: "copy", disabled: columns.length === 0, onSelect: () => void copy("in 列表", toInList(shownColumns, shown(), col)) },
        { label: "Markdown 表格", icon: "copy", onSelect: () => void copy("Markdown", toMarkdown(shownColumns, shown())) },
      ],
    });
  };

  const selValue = sel ? valueAt(sel.r,sel.c) : undefined;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div className="dbx-rbar">
        {tabs}
        <span className="meta">{meta}</span>
        {filter && order.length !== rows.length && <span className="meta">筛出 <b>{thousands(order.length)}</b> 行</span>}
        {(sort || filter) && (
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
        )}
        <span className="dbx-sp" />
        {selection && <span className="meta">选区 {selectedRows(order,selection).length} 行 × {selectedCols(visible,selection).length} 列</span>}
        {tools}
        {snapshot && <ResultCompare snapshot={snapshot} />}
        {onRelated && <button type="button" className="dbx-btn" disabled={!sel} onClick={()=>sel && onRelated(rows[sel.r])}>关联记录</button>}
        <button type="button" className="dbx-btn" aria-label="结果列布局" onClick={()=>setColumnOpen(true)}>列布局</button>
        {running && (
          <span className="dbx-busy">
            <Icon name="spinner" size={12} />
            执行中…
          </span>
        )}
        <button
          type="button"
          className="dbx-ibtn"
          data-on={filterOpen || filter ? "" : undefined}
          title="在结果中筛选"
          aria-label="筛选结果"
          aria-expanded={filterOpen || !!filter}
          onClick={() => setFilterOpen((v) => !v)}
        >
          <Icon name="search" size={14} />
        </button>
        {(filterOpen || filter) && (
          <input
            className="dbx-inp sm"
            value={filter}
            placeholder="在结果中筛选"
            aria-label="在结果中筛选"
            autoFocus={filterOpen}
            onChange={(e) => setFilter(e.target.value)}
          />
        )}
        <button
          type="button"
          className="dbx-ibtn"
          title="复制为…"
          aria-label="复制为"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            copyMenu(r.left, r.bottom + 4);
          }}
        >
          <Icon name="copy" size={14} />
        </button>
        <button
          type="button"
          className="dbx-ibtn"
          title="导出：默认「全部」由后端流式写文件（内存只占一页），当前页是浏览器下载"
          aria-label="导出"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const items: ContextMenuItem[] = [
              {
                label: "CSV（全部，后端流式）",
                icon: "download",
                disabled: !onExportFile,
                onSelect: () => onExportFile?.("csv"),
              },
              {
                label: "TSV（全部，后端流式）",
                icon: "download",
                disabled: !onExportFile,
                onSelect: () => onExportFile?.("tsv"),
              },
              {
                label: "INSERT 脚本（全部，后端流式）",
                icon: "download",
                disabled: !onExportFile,
                onSelect: () => onExportFile?.("insert"),
              },
              {
                label: `CSV（当前显示 ${thousands(order.length)} 行）`,
                icon: "copy",
                onSelect: () => downloadText(`${table || "result"}.csv`, toCsv(shownColumns, shown())),
              },
            ];
            setMenu({ x: r.left, y: r.bottom + 4, items });
          }}
        >
          <Icon name="download" size={14} />
        </button>
        <button
          type="button"
          className="dbx-ibtn"
          data-on={detail || undefined}
          title="单元格详情"
          aria-label="单元格详情"
          aria-pressed={detail}
          onClick={() => setDetail(!detail)}
        >
          <Icon name="info" size={14} />
        </button>
        {settings}
      </div>
      {subbar && <div className="dbx-rsub">{subbar}</div>}
      <div className="dbx-rbody">
        <ResultGrid
          columns={columns}
          rows={rows}
          order={order}
          sort={sort}
          onSort={(c) => setSort(nextSort(sort, c))}
          onHeaderMenu={(c, x, y) => setHead({ x, y, col: c })}
          sel={sel}
          onSel={select}
          selection={selection}
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
            onClose={() => setDetail(false)}
          />
        )}
      </div>
      {snapshot && <div className="dbx-read-status" title={snapshot.sql}>{snapshot.source} · {new Date(snapshot.at).toLocaleString()} · {snapshot.complete ? "完整查询结果" : "已读取部分数据"}</div>}
      {foot}
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
