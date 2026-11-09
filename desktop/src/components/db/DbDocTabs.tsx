import { useEffect, useRef, useState, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Icon } from "../ui/icon";
import { DockRegion, useWorkbenchDock } from "../workspace/WorkbenchDock";
import { newConsole, requestCloseTab } from "../../lib/dbActions";
import {
  activateTab, clearRecentlyClosed, connOf, getDb, moveDbTab, restoreClosedTab,
  useDbConns, useDbSelector,
} from "../../lib/dbStore";
import { getKeymap, isReopenTabKey } from "../../lib/keymap";
import { useViewActive } from "../../lib/viewActivity";
import { ENV_LABEL } from "../../lib/dbApi";
import { dbPanelId, dbTabId, dbTabLabel } from "../../lib/dbPendingSessions";
import { DbAllTabsMenu, DbClosedTabsMenu } from "./DbTabMenus";

/**
 * 数据库的文档标签（SQL 控制台 / 表页），停靠在**文档面自己的标签条**（`doctabs`）里。
 *
 * 以前它停进文件标签条的同一条 flex 行，于是数据库页里「查询 1 / 数据字典」和一堆
 * `.java` 标签并列，看着像两套文档混在一起。现在文档面和代码面互斥显示，数据库标签
 * 只可能出现在数据库页。选中统一深青，环境使用文字；中键关闭；「+」新开控制台。
 *
 * 标签一多会被裁掉，所以标签本体放进 `.wb-tabs-scroll`，右侧的「所有标签 / 最近关闭」
 * 两个入口始终留在可操作区。拖拽排序插到目标前，拖到空白或「+」则落到末尾。
 */
export function DbDocTabs() {
  // 标签栏要标签清单、活动标签和连接名（connOf 读的就是订阅的这份）；连接运行态变化不重画
  useDbConns();
  const db = { tabs: useDbSelector((s) => s.tabs), active: useDbSelector((s) => s.active) };
  const dock = useWorkbenchDock();
  const docOpen = dock?.documentOpen ?? true;
  const viewActive = useViewActive();
  const refs = useRef(new Map<string, HTMLDivElement>());
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const showDoc = useRef(dock?.showDocument);
  showDoc.current = dock?.showDocument;
  const dragFrom = useRef<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const rovingIndex = Math.max(0, db.tabs.findIndex((t) => t.id === db.active));
  const show = (id: string) => {
    activateTab(id);
    dock?.showDocument();
  };
  useEffect(() => {
    const el = refs.current.get(db.active ?? "");
    const strip = scrollRef.current;
    if (!el || !strip) return;
    const left = el.offsetLeft, right = left + el.offsetWidth;
    if (left < strip.scrollLeft) strip.scrollLeft = Math.max(0, left - 8);
    else if (right > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = right - strip.clientWidth + 8;
  }, [db.active, db.tabs.length]);

  // 文件页的 Ctrl+Shift+T 只管文件标签（且文档面显示时直接跳过）。数据库页要自己接管
  // 同一个恢复键，否则关掉 SQL 草稿后按恢复键毫无反应。只在「文档面 + 本页活动」时挂。
  useEffect(() => {
    if (!dock?.documentOpen || !viewActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || !isReopenTabKey(e, getKeymap())) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"], dialog[open]')) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (target?.isContentEditable) return;
      e.preventDefault();
      e.stopPropagation();
      if (restoreClosedTab()) showDoc.current?.();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dock?.documentOpen, viewActive]);

  const close = async (id: string) => {
    const ownedFocus = refs.current.get(id)?.contains(document.activeElement);
    await requestCloseTab(id);
    if (ownedFocus) requestAnimationFrame(() => {
      if (!getDb().tabs.some((t) => t.id === id)) refs.current.get(getDb().active ?? "")?.focus();
    });
  };
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>, i: number, id: string) => {
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

  const endDrag = () => { dragFrom.current = null; setDropTarget(null); };
  const startDrag = (e: ReactDragEvent<HTMLDivElement>, id: string) => {
    dragFrom.current = id;
    const dt = e.dataTransfer;
    if (dt) {
      dt.effectAllowed = "move";
      // 某些 WebView 里不设数据的话拖拽不会启动
      dt.setData("text/plain", id);
    }
  };
  const overTab = (e: ReactDragEvent<HTMLDivElement>, id: string) => {
    if (!dragFrom.current || dragFrom.current === id) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    if (dropTarget !== id) setDropTarget(id);
  };
  const dropOnTab = (e: ReactDragEvent<HTMLDivElement>, id: string) => {
    if (!dragFrom.current) return;
    e.preventDefault();
    e.stopPropagation(); // 根节点把空白落点当「末尾」，不能重复排一次
    const from = dragFrom.current;
    endDrag();
    if (from !== id) moveDbTab(from, id);
  };
  const dropAtEnd = (e: ReactDragEvent<HTMLDivElement>) => {
    if (!dragFrom.current) return;
    e.preventDefault();
    const from = dragFrom.current;
    endDrag();
    moveDbTab(from, null);
  };

  return (
    <DockRegion region="doctabs">
      <div
        className="wb-tabs dbx-doctabs"
        role="tablist"
        onDragOver={(e) => { if (dragFrom.current) e.preventDefault(); }}
        onDrop={dropAtEnd}
      >
        <div className="wb-tabs-scroll" ref={scrollRef}>
          {db.tabs.map((t, i) => {
            const c = connOf(t.connId);
            const label = dbTabLabel(t);
            const sameName = t.kind === "table" && db.tabs.some((other) => other.id !== t.id && other.kind === "table" && other.table.toUpperCase() === t.table.toUpperCase());
            const shortConn = c && c.name.length > 12 ? `${c.name.slice(0, 11)}…` : c?.name;
            const icon = t.kind === "sql" ? "terminal" : t.kind === "dict" ? "clipboard" : t.kind === "compare" ? "layers" : "database";
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
                data-drop-target={dropTarget === t.id || undefined}
                draggable
                title={t.kind === "compare" ? `${label} · A ${t.before.source} → B ${t.after.source}` : c ? `${label} · ${c.name} · ${ENV_LABEL[c.env]}（${c.user}）` : label}
                onClick={() => show(t.id)}
                onAuxClick={(e) => e.button === 1 && void close(t.id)}
                onKeyDown={(e) => onKey(e, i, t.id)}
                onDragStart={(e) => startDrag(e, t.id)}
                onDragOver={(e) => overTab(e, t.id)}
                onDrop={(e) => dropOnTab(e, t.id)}
                onDragEnd={endDrag}
              >
                <Icon name={icon} size={13} />
                <span className="wb-tab-name">
                  {label}
                  <span className="dbx-muted">
                    {t.kind !== "compare" && (t.kind !== "table" || sameName) && ` · ${shortConn ?? "未选连接"}`}
                    {c && ` · ${ENV_LABEL[c.env]}`}
                  </span>
                </span>
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
        </div>
        <DbAllTabsMenu onPick={show} />
        <DbClosedTabsMenu
          onRestore={(id) => { if (restoreClosedTab(id)) dock?.showDocument(); }}
          onRestoreLast={() => { if (restoreClosedTab()) dock?.showDocument(); }}
          onClear={clearRecentlyClosed}
        />
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
      </div>
    </DockRegion>
  );
}
