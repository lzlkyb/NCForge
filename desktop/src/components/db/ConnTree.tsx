import { useState } from "react";
import { Icon } from "../ui/icon";
import { ContextMenu, type ContextMenuItem } from "../workspace/ContextMenu";
import { EnvDot } from "./EnvChips";
import { ConnObjects } from "./ConnObjects";
import { dbNameOf, type DbConn } from "../../lib/dbApi";
import { ensureConnected } from "../../lib/dbConfirm";
import { deleteConn, disconnectConn, duplicateConn, moveConn, newConsole, refreshMeta } from "../../lib/dbActions";
import { loadConns, openConnDialog, rtOf, tabOf, useDb } from "../../lib/dbStore";

/**
 * 侧栏：连接列表 + 已连上连接下的对象（收藏 / 表 / 视图）。
 *
 * 单击连接 = 展开并连上；双击 = 在这个连接上新开 SQL 控制台；右键管理；拖动排序。
 * 筛选框同时筛连接名与表名（含 NC 中文名）。
 */
export function ConnTree() {
  const db = useDb();
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const [drag, setDrag] = useState<{ from: string; over: string | null } | null>(null);
  const activeConn = tabOf(db.active)?.connId ?? null;
  const q = filter.trim().toLowerCase();

  const toggle = (c: DbConn) => {
    const next = !open[c.id];
    setOpen({ ...open, [c.id]: next });
    if (next && rtOf(c.id).status !== "connected") void ensureConnected(c.id);
  };

  const connMenu = (c: DbConn, x: number, y: number) => {
    const on = rtOf(c.id).status === "connected";
    setMenu({
      x,
      y,
      items: [
        on
          ? { label: "断开", icon: "power", onSelect: () => void disconnectConn(c.id) }
          : { label: "连接", icon: "plug", onSelect: () => void ensureConnected(c.id) },
        { label: "新建 SQL 控制台", icon: "terminal", onSelect: () => void newConsole(c.id) },
        { label: "刷新对象", icon: "refresh", disabled: !on, onSelect: () => void refreshMeta(c.id) },
        { label: "编辑…", icon: "edit", separator: true, onSelect: () => openConnDialog(c.id) },
        { label: "复制", icon: "copy", onSelect: () => void duplicateConn(c.id) },
        { label: "删除", icon: "trash", danger: true, onSelect: () => void deleteConn(c.id) },
      ],
    });
  };

  const shown = db.conns.filter(
    (c) => !q || c.name.toLowerCase().includes(q) || c.url.toLowerCase().includes(q) || rtOf(c.id).status === "connected",
  );

  return (
    <div className="dbx-side">
      <div className="dbx-side-head">
        数据库连接
        <span className="dbx-sp" />
        <button type="button" className="dbx-ibtn" title="新建连接" onClick={() => openConnDialog(null)}>
          <Icon name="plus" size={14} />
        </button>
        <button type="button" className="dbx-ibtn" title="从 NC prop.xml 导入" onClick={() => openConnDialog(null, "prop")}>
          <Icon name="download" size={14} />
        </button>
        <button type="button" className="dbx-ibtn" title="刷新列表" onClick={() => void loadConns()}>
          <Icon name="refresh" size={14} />
        </button>
      </div>
      <input
        className="dbx-inp sm dbx-side-filter"
        value={filter}
        placeholder="筛选连接 / 表名 / 中文名"
        aria-label="筛选连接与表"
        spellCheck={false}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className="dbx-tree">
        {db.loadError && <p className="dbx-tree-note">{db.loadError}</p>}
        {db.loaded && db.conns.length === 0 && (
          <div className="dbx-tree-note">
            <p>还没有连接。</p>
            <button type="button" className="dbx-btn" style={{ marginTop: 8 }} onClick={() => openConnDialog(null)}>
              <Icon name="plus" size={12} />
              新建连接
            </button>
          </div>
        )}
        {shown.map((c) => {
          const rt = rtOf(c.id);
          const expanded = !!open[c.id] || (!!q && rt.status === "connected");
          return (
            <div key={c.id}>
              <button
                type="button"
                className="dbx-crow"
                data-active={activeConn === c.id || undefined}
                data-drop={drag?.over === c.id && drag.from !== c.id ? "" : undefined}
                title={`${c.user}@${c.url}${c.note ? `\n${c.note}` : ""}`}
                draggable
                onDragStart={() => setDrag({ from: c.id, over: null })}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (drag && drag.over !== c.id) setDrag({ ...drag, over: c.id });
                }}
                onDrop={() => {
                  if (drag) void moveConn(drag.from, c.id);
                  setDrag(null);
                }}
                onDragEnd={() => setDrag(null)}
                onClick={() => toggle(c)}
                onDoubleClick={() => void newConsole(c.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  connMenu(c, e.clientX, e.clientY);
                }}
              >
                <Icon name={expanded ? "chevronDown" : "chevronRight"} size={12} />
                <EnvDot env={c.env} />
                <b>{c.name}</b>
                <span className="u">
                  {c.user}@{dbNameOf(c.url)}
                </span>
                <ConnStatus status={rt.status} />
              </button>
              {expanded && rt.status === "connected" && <ConnObjects connId={c.id} filter={q} />}
              {expanded && rt.status === "error" && <p className="dbx-tree-note" style={{ color: "hsl(var(--destructive-ink))" }}>{rt.error}</p>}
            </div>
          );
        })}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

function ConnStatus({ status }: { status: string }) {
  if (status === "connected")
    return (
      <span className="st">
        <Icon name="check" size={11} />
        已连接
      </span>
    );
  if (status === "connecting")
    return (
      <span className="st off">
        <Icon name="spinner" size={11} />
        连接中
      </span>
    );
  if (status === "error") return <span className="st bad">失败</span>;
  return <span className="st off">未连接</span>;
}
