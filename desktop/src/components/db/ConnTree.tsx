import { useState } from "react";
import { Icon } from "../ui/icon";
import { EmptyState } from "../ui/EmptyState";
import { ContextMenu, type ContextMenuItem } from "../workspace/ContextMenu";
import { useWorkbenchDock } from "../workspace/WorkbenchDock";
import { ConnObjects } from "./ConnObjects";
import { ConnectionStatus } from "./ConnectionStatus";
import { FavoriteSection } from "./FavoriteSection";
import { PasswordResetDialog } from "./PasswordResetDialog";
import { dbNameOf, ENV_LABEL, type DbConn } from "../../lib/dbApi";
import { ensureConnected } from "../../lib/dbConfirm";
import { deleteConn, disconnectConn, duplicateConn, moveConn, newConsole, refreshMeta } from "../../lib/dbActions";
import { defaultConnId, loadConns, openConnDialog, openDictTab, rtOf, useDbConns, useDbRt, useDbSelector } from "../../lib/dbStore";

/**
 * 侧栏：连接列表 + 已连上连接下的对象（收藏 / 表 / 视图）。
 *
 * 单击连接 = 展开并连上；双击 = 在这个连接上新开 SQL 控制台；右键管理；拖动排序。
 * 筛选框同时筛连接名与表名（含 NC 中文名）。
 */
export function ConnTree() {
  // 只订阅连接树用到的切片：SQL 执行、结果写回标签不再把整棵连接树重画。
  // rt 整表要订：每个连接行都显示自己的状态（下面用 rtOf 读的就是这一份）。
  useDbRt();
  const db = {
    conns: useDbConns(),
    loaded: useDbSelector((s) => s.loaded),
    loadError: useDbSelector((s) => s.loadError),
  };
  const dock = useWorkbenchDock();
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const [resetConn, setResetConn] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ from: string; over: string | null } | null>(null);
  const activeConn = useDbSelector((s) => s.tabs.find((t) => t.id === s.active)?.connId ?? null);
  const q = filter.trim().toLowerCase();

  const toggle = (c: DbConn) => {
    const next = !open[c.id];
    setOpen({ ...open, [c.id]: next });
    if (next && rtOf(c.id).status !== "connected") void ensureConnected(c.id);
  };

  /** 从收藏「在连接中定位」：清筛选、展开并滚到该连接。 */
  const locate = (connId: string) => {
    setFilter("");
    setOpen((prev) => ({ ...prev, [connId]: true }));
    if (rtOf(connId).status !== "connected") void ensureConnected(connId);
    requestAnimationFrame(() => {
      document.getElementById(`dbx-conn-${connId}`)?.scrollIntoView?.({ block: "nearest" });
    });
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
        {
          label: "数据字典",
          icon: "clipboard",
          onSelect: () => {
            openDictTab(c.id);
            dock?.showDocument();
          },
        },
        { label: "刷新对象", icon: "refresh", disabled: !on, onSelect: () => void refreshMeta(c.id) },
        {
          label: "重置操作员密码…",
          icon: "key",
          onSelect: () => void ensureConnected(c.id).then((ok) => ok && setResetConn(c.id)),
        },
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
        <button type="button" className="dbx-ibtn" title="新建连接" aria-label="新建连接" onClick={() => openConnDialog(null)}>
          <Icon name="plus" size={14} />
        </button>
        <button
          type="button"
          className="dbx-ibtn"
          title="更多"
          aria-label="更多连接操作"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({
              x: r.left,
              y: r.bottom + 4,
              items: [
                { label: "从 NC prop.xml 导入", icon: "download", onSelect: () => openConnDialog(null, "prop") },
                {
                  label: "数据字典",
                  icon: "clipboard",
                  onSelect: () => {
                    openDictTab(activeConn ?? defaultConnId());
                    dock?.showDocument();
                  },
                },
                { label: "刷新连接列表", icon: "refresh", onSelect: () => void loadConns() },
              ],
            });
          }}
        >
          <Icon name="more" size={14} />
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
        <FavoriteSection filter={q} onLocate={locate} />
        {db.loadError && <p className="dbx-tree-note">{db.loadError}</p>}
        {db.loaded && db.conns.length === 0 && (
          <EmptyState
            icon="database"
            description="还没有数据库连接。可从 NC prop.xml 导入，或手动填写。"
            className="py-8"
            bigIconSize={64}
            iconSize={22}
            action={
              <button type="button" className="dbx-btn" onClick={() => openConnDialog(null)}>
                <Icon name="plus" size={12} />
                新建连接
              </button>
            }
          />
        )}
        {shown.map((c) => {
          const rt = rtOf(c.id);
          const expanded = !!open[c.id] || (!!q && rt.status === "connected");
          return (
            <div key={c.id}>
              <button
                id={`dbx-conn-${c.id}`}
                type="button"
                className="dbx-crow"
                data-active={activeConn === c.id || undefined}
                aria-expanded={expanded}
                aria-controls={expanded ? `dbx-objects-${c.id}` : undefined}
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
                <span className="dbx-conn-label"><b>{c.name}</b><span className="u">{c.user}@{dbNameOf(c.url)}</span></span>
                <span className="dbx-conn-env" data-prod={c.env === "prod" || undefined}>{ENV_LABEL[c.env]}</span>
                <ConnectionStatus status={rt.status} />
              </button>
              {expanded && <div id={`dbx-objects-${c.id}`}>
                {rt.status === "connected" && <ConnObjects connId={c.id} filter={q} />}
                {rt.status === "error" && <p className="dbx-tree-note" style={{ color: "hsl(var(--destructive-ink))" }}>{rt.error}</p>}
              </div>}
            </div>
          );
        })}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {resetConn && <PasswordResetDialog connId={resetConn} onClose={() => setResetConn(null)} />}
    </div>
  );
}
