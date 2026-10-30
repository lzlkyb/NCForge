import { useEffect } from "react";
import "../../db-console.css";
import { DockRegion } from "../workspace/WorkbenchDock";
import { Icon } from "../ui/icon";
import { ConnTree } from "../db/ConnTree";
import { ConnDialog } from "../db/ConnDialog";
import { DbConfirmHost } from "../db/DbConfirmHost";
import { DbDocTabs } from "../db/DbDocTabs";
import { SqlConsole } from "../db/SqlConsole";
import { TablePage } from "../db/TablePage";
import { defaultConnId, newConsole } from "../../lib/dbActions";
import { loadConns, openConnDialog, openSqlTab, tabOf, useDb } from "../../lib/dbStore";

/**
 * 数据库页（多连接 SQL 客户端）。
 *
 * 布局照 design/NCForge-数据库升级-设计稿-2026-10-30.html：侧栏连接树、主标签条里的文档标签、
 * 文档区放 SQL 控制台或表页。读写权限由数据库账号决定，这里只负责让人看清连的是哪个库。
 */
export function DbTab() {
  const db = useDb();
  const tab = tabOf(db.active);

  useEffect(() => {
    if (!db.loaded) void loadConns();
  }, [db.loaded]);

  // 第一次进来有连接但没有任何标签：先给一个控制台，省一次点击（不自动连库，等第一次执行再连）
  const empty = db.loaded && db.tabs.length === 0 && db.conns.length > 0;
  useEffect(() => {
    if (empty) openSqlTab(defaultConnId());
  }, [empty]);

  return (
    <>
      <DockRegion region="sidebar">
        <ConnTree />
      </DockRegion>
      <DbDocTabs />
      <DockRegion region="document">
        <div className="dbx-page">
          {tab?.kind === "sql" && <SqlConsole tab={tab} />}
          {tab?.kind === "table" && <TablePage key={tab.id} tab={tab} />}
          {!tab && (
            <div className="dbx-empty">
              <Icon name="database" size={24} />
              {db.conns.length === 0 ? (
                <>
                  <span>还没有数据库连接。可以从 NC prop.xml 导入，或手动填写 / 导入 .properties。</span>
                  <button type="button" className="dbx-btn pri" onClick={() => openConnDialog(null)}>
                    <Icon name="plus" size={12} />
                    新建连接
                  </button>
                </>
              ) : (
                <button type="button" className="dbx-btn pri" onClick={() => void newConsole()}>
                  <Icon name="terminal" size={12} />
                  新建 SQL 控制台
                </button>
              )}
            </div>
          )}
        </div>
      </DockRegion>
      <ConnDialog />
      <DbConfirmHost />
    </>
  );
}
