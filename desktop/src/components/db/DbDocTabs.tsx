import { useEffect, useRef, type KeyboardEvent } from "react";
import { Icon } from "../ui/icon";
import { DockRegion, useWorkbenchDock } from "../workspace/WorkbenchDock";
import { newConsole, requestCloseTab } from "../../lib/dbActions";
import { activateTab, connOf, getDb, useDbConns, useDbSelector } from "../../lib/dbStore";
import { ENV_LABEL } from "../../lib/dbApi";
import { dbPanelId, dbTabId, dbTabLabel } from "../../lib/dbPendingSessions";

/**
 * 数据库的文档标签（SQL 控制台 / 表页），停靠到主标签条里、文件标签后面。
 * 标签底边是连接的环境色；中键关闭；「+」新开控制台。
 */
export function DbDocTabs() {
  // 标签栏要标签清单、活动标签和连接名（connOf 读的就是订阅的这份）；连接运行态变化不重画
  useDbConns();
  const db = { tabs: useDbSelector((s) => s.tabs), active: useDbSelector((s) => s.active) };
  const dock = useWorkbenchDock();
  const docOpen = dock?.documentOpen ?? true;
  const refs = useRef(new Map<string, HTMLDivElement>());
  const rovingIndex = Math.max(0, db.tabs.findIndex((t) => t.id === db.active));
  const show = (id: string) => {
    activateTab(id);
    dock?.showDocument();
  };
  useEffect(() => {
    refs.current.get(db.active ?? "")?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [db.active, db.tabs.length]);
  const close = async (id: string) => {
    const ownedFocus = refs.current.get(id)?.contains(document.activeElement);
    await requestCloseTab(id);
    if (ownedFocus) requestAnimationFrame(() => {
      if (!getDb().tabs.some((t) => t.id === id)) refs.current.get(getDb().active ?? "")?.focus();
    });
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>, i: number, id: string) => {
    // 关闭按钮有自己的 Enter/Space，不能冒泡成激活标签。
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); show(id); return; }
    if (e.key === "Delete") { e.preventDefault(); void close(id); return; }
    const last = db.tabs.length - 1;
    const next = e.key === "Home" ? 0 : e.key === "End" ? last : e.key === "ArrowRight" ? (i + 1) % db.tabs.length : e.key === "ArrowLeft" ? (i + last) % db.tabs.length : -1;
    if (next < 0) return;
    e.preventDefault();
    const target = db.tabs[next];
    show(target.id);
    refs.current.get(target.id)?.focus();
  };
  return (
    <DockRegion region="tabs">
      {db.tabs.map((t, i) => {
        const c = connOf(t.connId);
        const label = dbTabLabel(t);
        const sameName = t.kind === "table" && db.tabs.some((other) => other.id !== t.id && other.kind === "table" && other.table.toUpperCase() === t.table.toUpperCase());
        const shortConn = c && c.name.length > 12 ? `${c.name.slice(0, 11)}…` : c?.name;
        const icon = t.kind === "sql" ? "terminal" : t.kind === "dict" ? "clipboard" : "database";
        const on = docOpen && db.active === t.id;
        return (
          <div
            key={t.id}
            id={dbTabId(t.id)}
            ref={(node) => { if (node) refs.current.set(t.id, node); else refs.current.delete(t.id); }}
            role="tab"
            tabIndex={i === rovingIndex ? 0 : -1}
            aria-selected={on}
            aria-controls={dbPanelId(t.id)}
            className={`wb-tab dbx-doctab${c ? ` e-${c.env}` : ""}`}
            data-active={on || undefined}
            title={c ? `${label} · ${c.name} · ${ENV_LABEL[c.env]}（${c.user}）` : label}
            onClick={() => show(t.id)}
            onAuxClick={(e) => e.button === 1 && void close(t.id)}
            onKeyDown={(e) => onKey(e, i, t.id)}
          >
            <Icon name={icon} size={13} />
            <span className="wb-tab-name">
              {label}
              <span className="dbx-muted">
                {(t.kind !== "table" || sameName) && ` · ${shortConn ?? "未选连接"}`}
                {c && ` · ${ENV_LABEL[c.env]}`}
              </span>
            </span>
            {c && <span className={`dbx-edot e-${c.env}`} />}
            <button
              type="button"
              className="wb-tab-x"
              aria-label={`关闭 ${label} 标签${c ? ` · ${c.name}` : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                void close(t.id);
              }}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        );
      })}
      {db.tabs.length === 0 && (
        <div id="dbx-tab-empty" role="tab" tabIndex={0} aria-selected={docOpen} aria-controls="dbx-panel-empty" className="wb-tab" data-active={docOpen || undefined} onClick={() => dock?.showDocument()} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); dock?.showDocument(); } }}>
          <Icon name="database" size={13} />
          <span className="wb-tab-name">数据库</span>
        </div>
      )}
      <button
        type="button"
        className="dbx-tabadd"
        title="新建 SQL 控制台"
        aria-label="新建 SQL 控制台"
        onClick={() => {
          void newConsole();
          dock?.showDocument();
        }}
      >
        <Icon name="plus" size={14} />
      </button>
    </DockRegion>
  );
}
