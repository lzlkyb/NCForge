import { Icon } from "../ui/icon";
import { DockRegion, useWorkbenchDock } from "../workspace/WorkbenchDock";
import { newConsole, requestCloseTab } from "../../lib/dbActions";
import { activateTab, connOf, useDb } from "../../lib/dbStore";

/**
 * 数据库的文档标签（SQL 控制台 / 表页），停靠到主标签条里、文件标签后面。
 * 标签底边是连接的环境色；中键关闭；「+」新开控制台。
 */
export function DbDocTabs() {
  const db = useDb();
  const dock = useWorkbenchDock();
  const docOpen = dock?.documentOpen ?? true;
  const show = (id: string) => {
    activateTab(id);
    dock?.showDocument();
  };
  return (
    <DockRegion region="tabs">
      {db.tabs.map((t) => {
        const c = connOf(t.connId);
        const label = t.kind === "sql" ? t.title : t.table.toLowerCase();
        const on = docOpen && db.active === t.id;
        return (
          <div
            key={t.id}
            role="tab"
            tabIndex={0}
            aria-selected={on}
            className={`wb-tab dbx-doctab${c ? ` e-${c.env}` : ""}`}
            data-active={on || undefined}
            title={c ? `${label} · ${c.name}（${c.user}）` : label}
            onClick={() => show(t.id)}
            onAuxClick={(e) => e.button === 1 && void requestCloseTab(t.id)}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && show(t.id)}
          >
            <Icon name={t.kind === "sql" ? "terminal" : "database"} size={13} />
            <span className="wb-tab-name">
              {label}
              {t.kind === "sql" && <span className="dbx-muted"> · {c?.name ?? "未选连接"}</span>}
            </span>
            {c && <span className={`dbx-edot e-${c.env}`} />}
            <button
              type="button"
              className="wb-tab-x"
              aria-label="关闭标签"
              onClick={(e) => {
                e.stopPropagation();
                void requestCloseTab(t.id);
              }}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        );
      })}
      {db.tabs.length === 0 && (
        <div role="tab" tabIndex={0} aria-selected={docOpen} className="wb-tab" data-active={docOpen || undefined} onClick={() => dock?.showDocument()}>
          <Icon name="database" size={13} />
          <span className="wb-tab-name">数据库</span>
        </div>
      )}
      <button
        type="button"
        className="dbx-tabadd"
        title="新建 SQL 控制台"
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
