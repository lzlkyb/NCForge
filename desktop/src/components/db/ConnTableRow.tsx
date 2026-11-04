import { useState } from "react";
import { Icon } from "../ui/icon";
import type { ColumnInfo, TableInfo } from "../../lib/dbApi";
import { openTable } from "../../lib/dbActions";
import { columnsOf, useDbSelector } from "../../lib/dbStore";

/** 表/视图一行：点开数据，箭头展开字段。 */
export function TableRow({ connId, table, zh, fav, onToggleFav, onMenu }: {
  connId: string;
  table: TableInfo;
  zh: string | undefined;
  fav: boolean;
  onToggleFav: () => void;
  onMenu: (t: TableInfo, x: number, y: number) => void;
}) {
  const [cols, setCols] = useState<ColumnInfo[] | "loading" | null>(null);
  // 只订阅「自己是不是当前打开的那张表」这一个布尔值：几百行表各自订阅整库的话，
  // 任何连接状态、查询结果的变化都会把整棵对象树重画一遍
  const active = useDbSelector((s) => {
    const cur = s.tabs.find((t) => t.id === s.active);
    return cur?.kind === "table" && cur.connId === connId && cur.table === table.name.toUpperCase();
  });
  const expand = () => {
    if (cols) return setCols(null);
    setCols("loading");
    columnsOf(connId, table.name).then(setCols, () => setCols(null));
  };
  return (
    <>
      <button
        type="button"
        className="dbx-trow"
        data-active={active || undefined}
        aria-label={`${table.name.toLowerCase()}${zh ? ` ${zh}` : ""}${fav ? "，已收藏" : ""}`}
        title={zh ? `${table.name.toLowerCase()} · ${zh}` : table.name.toLowerCase()}
        onClick={() => void openTable(connId, table.name)}
        onContextMenu={(e) => {
          e.preventDefault();
          onMenu(table, e.clientX, e.clientY);
        }}
        onKeyDown={(e) => {
          if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          onMenu(table, r.left + 12, r.bottom);
        }}
      >
        <span
          role="button"
          tabIndex={-1}
          aria-label="展开字段"
          onClick={(e) => {
            e.stopPropagation();
            expand();
          }}
          style={{ display: "inline-flex" }}
        >
          <Icon name={cols ? "chevronDown" : "chevronRight"} size={11} />
        </span>
        <Icon name={table.kind === "VIEW" ? "eye" : "database"} size={12} />
        <span className="nm">{table.name.toLowerCase()}</span>
        {zh && <span className="zh">{zh}</span>}
        <FavStar fav={fav} name={table.name.toLowerCase()} onToggle={onToggleFav} />
      </button>
      {cols === "loading" && <p className="dbx-tree-note" style={{ paddingLeft: 28 }}>读取字段…</p>}
      {Array.isArray(cols) &&
        cols.map((c) => (
          <div key={c.name} className="dbx-trow" style={{ paddingLeft: 28 }} title={c.comment ?? c.zh ?? ""}>
            {c.pk ? <Icon name="key" size={11} /> : <span style={{ width: 11 }} />}
            <span className="nm">{c.name.toLowerCase()}</span>
            {c.zh && <span className="zh">{c.zh}</span>}
            <span className="ty">{c.full}</span>
          </div>
        ))}
    </>
  );
}

/** 行内星标：默认只给悬停看，已收藏时常驻金色。
 *  它嵌在整行的 `<button>` 里，所以不能自己再当按钮（嵌套交互元素会让
 *  键盘出现两个焦点、读屏语义也会打架）；收藏/取消收藏的键盘路径是
 *  行上的右键菜单（Shift+F10）与收藏区的 Delete。 */
export function FavStar({ fav, name, onToggle }: { fav: boolean; name: string; onToggle: () => void }) {
  return (
    <span
      className="dbx-favbtn"
      data-on={fav || undefined}
      aria-hidden="true"
      title={fav ? `取消收藏 ${name}` : `收藏 ${name}`}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      <Icon name="star" size={12} />
    </span>
  );
}
