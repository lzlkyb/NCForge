import { useMemo, useState } from "react";
import { Icon } from "../ui/icon";
import { ContextMenu, type ContextMenuItem } from "../workspace/ContextMenu";
import { thousands } from "../../lib/db";
import type { ColumnInfo, TableInfo } from "../../lib/dbApi";
import { newConsole, openTable } from "../../lib/dbActions";
import { toggleFavorite, useFavorites } from "../../lib/dbFavorites";
import { columnsOf, rtOf, tabOf, useDb } from "../../lib/dbStore";
import { toast } from "../ui/toast";

/** 真实库里上万张表是常态，一次全铺会让侧栏卡死：每组只渲染前 N 条，靠筛选收敛。 */
const LIMIT = 200;
const NO_NAMES: Record<string, string> = {};

/** 一个已连上的连接下面的对象：收藏 / 表 / 视图。展开表看字段。 */
export function ConnObjects({ connId, filter }: { connId: string; filter: string }) {
  useDb();
  const rt = rtOf(connId);
  const favs = useFavorites(connId);
  const [groups, setGroups] = useState<Record<string, boolean>>({ fav: true, TABLE: true, VIEW: false });
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const names = rt.ncNames ?? NO_NAMES;

  const matched = useMemo(() => {
    const all = rt.tables ?? [];
    if (!filter) return all;
    return all.filter((t) => t.name.toLowerCase().includes(filter) || (names[t.name.toLowerCase()] ?? "").includes(filter));
  }, [rt.tables, filter, names]);

  if (rt.tablesLoading && !rt.tables) return <p className="dbx-tree-note">读取对象…</p>;

  const tableMenu = (t: TableInfo, x: number, y: number) => {
    const lower = t.name.toLowerCase();
    setMenu({
      x,
      y,
      items: [
        { label: "打开数据", icon: "database", onSelect: () => void openTable(connId, t.name, "data") },
        { label: "查看结构", icon: "info", onSelect: () => void openTable(connId, t.name, "struct") },
        { label: "查看 DDL", icon: "file", onSelect: () => void openTable(connId, t.name, "ddl") },
        { label: "新建查询", icon: "terminal", separator: true, onSelect: () => void newConsole(connId, `select * from ${lower} where rownum <= 100`) },
        { label: "复制表名", icon: "copy", onSelect: () => void navigator.clipboard.writeText(lower).then(() => toast(`已复制 ${lower}`, "success")) },
        { label: favs.includes(t.name) ? "取消收藏" : "收藏", icon: "sparkles", onSelect: () => toggleFavorite(connId, t.name) },
      ],
    });
  };

  const favTables = matched.filter((t) => favs.includes(t.name.toUpperCase()));
  const sections: { key: string; label: string; list: TableInfo[] }[] = [
    { key: "fav", label: "收藏", list: favTables },
    { key: "TABLE", label: "表", list: matched.filter((t) => t.kind === "TABLE") },
    { key: "VIEW", label: "视图", list: matched.filter((t) => t.kind === "VIEW") },
  ];

  return (
    <div style={{ paddingLeft: 10 }}>
      {sections.map((s) => {
        if (s.key === "fav" && s.list.length === 0) return null;
        const isOpen = groups[s.key] || (!!filter && s.list.length > 0);
        return (
          <div key={s.key}>
            <button type="button" className="dbx-sgroup" onClick={() => setGroups({ ...groups, [s.key]: !groups[s.key] })}>
              <Icon name={isOpen ? "chevronDown" : "chevronRight"} size={11} />
              {s.label}
              <span className="dbx-cnt">{thousands(s.list.length)}</span>
            </button>
            {isOpen && s.list.slice(0, LIMIT).map((t) => (
              <TableRow key={`${s.key}:${t.name}`} connId={connId} table={t} zh={names[t.name.toLowerCase()]} fav={favs.includes(t.name)} onMenu={tableMenu} />
            ))}
            {isOpen && s.list.length > LIMIT && <p className="dbx-tree-note">只显示前 {LIMIT} 张，继续输入关键字缩小范围</p>}
          </div>
        );
      })}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

function TableRow({ connId, table, zh, fav, onMenu }: {
  connId: string;
  table: TableInfo;
  zh: string | undefined;
  fav: boolean;
  onMenu: (t: TableInfo, x: number, y: number) => void;
}) {
  const [cols, setCols] = useState<ColumnInfo[] | "loading" | null>(null);
  const cur = tabOf(useDb().active);
  const active = cur?.kind === "table" && cur.connId === connId && cur.table === table.name.toUpperCase();
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
        title={zh ? `${table.name.toLowerCase()} · ${zh}` : table.name.toLowerCase()}
        onClick={() => void openTable(connId, table.name)}
        onContextMenu={(e) => {
          e.preventDefault();
          onMenu(table, e.clientX, e.clientY);
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
        {fav && <span className="star">★</span>}
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
