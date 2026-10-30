import { useMemo, useState, type ReactNode } from "react";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { ContextMenu, type ContextMenuItem } from "../workspace/ContextMenu";
import { ResultGrid, type CellPos, type GridEdit } from "./ResultGrid";
import { CellDetail } from "./CellDetail";
import { thousands } from "../../lib/db";
import type { Cell, ColumnMeta } from "../../lib/dbApi";
import { downloadText, toCsv, toInList, toInsert, toMarkdown, toTsv } from "../../lib/resultExport";
import { nextSort, viewOrder, type SortState } from "../../lib/resultView";

/**
 * 结果表 + 工具条（筛选 / 复制为… / 导出 / 详情）+ 底栏。SQL 控制台与表页共用。
 *
 * 复制与导出都按「当前显示顺序」（筛选、排序之后的），所见即所得。
 */
export function ResultTable({ columns, rows, meta, table, edit, zh, tools, foot }: {
  columns: ColumnMeta[];
  rows: Cell[][];
  /** 工具条左侧的说明：行数 / 耗时。 */
  meta: ReactNode;
  /** 复制为 INSERT 时用的表名。 */
  table: string;
  edit?: GridEdit;
  zh?: Record<string, string>;
  /** 工具条右侧额外的按钮（表页的保存 / 预览 SQL）。 */
  tools?: ReactNode;
  foot?: ReactNode;
}) {
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SortState | null>(null);
  const [sel, setSel] = useState<CellPos | null>(null);
  const [detail, setDetail] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const order = useMemo(() => viewOrder(rows, columns, filter, sort), [rows, columns, filter, sort]);

  const shown = () => order.map((i) => rows[i]);
  const copy = (label: string, text: string) =>
    navigator.clipboard.writeText(text).then(
      () => toast(`已复制为 ${label}（${thousands(order.length)} 行）`, "success"),
      (e) => toast(`复制失败：${e}`, "error"),
    );

  const copyMenu = (x: number, y: number) => {
    const col = sel?.c ?? 0;
    setMenu({
      x,
      y,
      items: [
        { label: "TSV（贴 Excel）", icon: "copy", onSelect: () => void copy("TSV", toTsv(columns, shown())) },
        { label: "CSV", icon: "copy", onSelect: () => void copy("CSV", toCsv(columns, shown())) },
        { label: `INSERT 语句（${table || "表名"}）`, icon: "copy", onSelect: () => void copy("INSERT", toInsert(table || "table_name", columns, shown())) },
        { label: `in (…) 列表（${columns[col]?.name.toLowerCase() ?? ""}）`, icon: "copy", disabled: columns.length === 0, onSelect: () => void copy("in 列表", toInList(columns, shown(), col)) },
        { label: "Markdown 表格", icon: "copy", onSelect: () => void copy("Markdown", toMarkdown(columns, shown())) },
      ],
    });
  };

  const selValue = sel ? (edit?.changed.get(`${sel.r}:${sel.c}`) ?? rows[sel.r]?.[sel.c]) : undefined;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div className="dbx-rtool">
        <span className="meta">{meta}</span>
        {filter && order.length !== rows.length && <span className="meta">筛出 <b>{thousands(order.length)}</b> 行</span>}
        <span className="dbx-sp" />
        {tools}
        <input className="dbx-inp sm" value={filter} placeholder="在结果中筛选" aria-label="在结果中筛选" onChange={(e) => setFilter(e.target.value)} />
        <button
          type="button"
          className="dbx-btn ghost"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            copyMenu(r.left, r.bottom + 4);
          }}
        >
          <Icon name="copy" size={12} />
          复制为…
        </button>
        <button
          type="button"
          className="dbx-btn ghost"
          title="导出 CSV（带 BOM，Excel 直接打开不乱码）"
          onClick={() => downloadText(`${table || "result"}.csv`, toCsv(columns, shown()))}
        >
          <Icon name="download" size={12} />
          导出
        </button>
        <button type="button" className="dbx-btn ghost" data-on={detail || undefined} onClick={() => setDetail(!detail)}>
          <Icon name="info" size={12} />
          详情
        </button>
      </div>
      <div className="dbx-rbody">
        <ResultGrid
          columns={columns}
          rows={rows}
          order={order}
          sort={sort}
          onSort={(c) => setSort(nextSort(sort, c))}
          sel={sel}
          onSel={setSel}
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
      {foot}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}
