import { useEffect, useRef } from "react";
import "../../db-console.css";
import "../../db-workbench.css";
import { DbObjectFinder } from "../db/DbObjectFinder";
import { DockRegion } from "../workspace/WorkbenchDock";
import { Icon } from "../ui/icon";
import { EmptyState } from "../ui/EmptyState";
import { ConnTree } from "../db/ConnTree";
import { ConnDialog } from "../db/ConnDialog";
import { DbDocTabs } from "../db/DbDocTabs";
import { DictWorkspace } from "../md/DictWorkspace";
import { SqlConsole } from "../db/SqlConsole";
import { TablePage } from "../db/TablePage";
import { newConsole } from "../../lib/dbActions";
import { showObjectFinder, defaultConnId, loadConns, openConnDialog, openDictTab, openSqlTab, useActiveDbTab, useDbSelector } from "../../lib/dbStore";
import { dbPanelId, dbTabId } from "../../lib/dbPendingSessions";

/**
 * 数据库页（多连接 SQL 客户端 + 数据字典文档）。
 *
 * 布局照 design/NCForge-数据库升级-设计稿-2026-10-30.html：侧栏连接树、主标签条里的文档标签、
 * 文档区放 SQL 控制台、表页或数据字典。读写权限由数据库账号决定，这里只负责让人看清连的是哪个库。
 *
 * 数据字典是这一页的一种文档标签（见 `DictWorkspace`），不再单独占主导航位：
 * 它读的就是这个库的 `md_*` 元数据，跟连接树/连接选择是同一件事；单独成页时
 * 用户还得在两边各自确认「这是哪个库」。
 */
export function DbTab() {
  // 整页只跟着「当前标签」和几个计数走：别的标签跑查询、连接状态变化不重画整页
  const tab = useActiveDbTab();
  const db = {
    loaded: useDbSelector((s) => s.loaded),
    tabs: { length: useDbSelector((s) => s.tabs.length) },
    conns: { length: useDbSelector((s) => s.conns.length) },
    objectFinder: useDbSelector((s) => s.objectFinder),
  };

  useEffect(() => {
    if (!db.loaded) void loadConns();
  }, [db.loaded]);

  // 第一次进来有连接但没有任何标签：先给一个控制台，省一次点击（不自动连库，等第一次执行再连）。
  // 只在**首次**自动建：以前依赖 `empty` 做条件，关掉最后一个标签会立刻又冒出一个 `SQL 1`，
  // × 看起来点了没用，刚关掉那份草稿也没了入口。现在空态由下面的按钮接手。
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current) return;
    if (!db.loaded || db.tabs.length > 0 || db.conns.length === 0) return;
    seeded.current = true;
    openSqlTab(defaultConnId());
  }, [db.loaded, db.tabs.length, db.conns.length]);

  return (
    <>
      {tab?.kind === "dict" ? (
        // 字典标签的选表器在侧栏、文档在右侧，两块都由它自己停靠——
        // 这一页的侧栏此时让位给「选哪几张表」，而不是再叠一棵连接树。
        <DictWorkspace tabId={tab.id} />
      ) : (
        <>
          <DockRegion region="sidebar">
<div className="dbx-finder-entry"><button type="button" className="dbx-btn" onClick={()=>showObjectFinder()}>查找数据库对象</button></div>
            <ConnTree />
          </DockRegion>
          <DockRegion region="document">
            <div className="dbx-page" role="tabpanel" id={tab ? dbPanelId(tab.id) : "dbx-panel-empty"} aria-labelledby={tab ? dbTabId(tab.id) : "dbx-tab-empty"}>
              {tab?.kind === "sql" && <SqlConsole tab={tab} />}
              {tab?.kind === "table" && <TablePage key={tab.id} tab={tab} />}
              {!tab && (
                <EmptyState
                  icon="database"
                  className="dbx-empty"
                  description={
                    db.conns.length === 0
                      ? "还没有数据库连接。可以从 NC prop.xml 导入，或手动填写 / 导入 .properties。"
                      : "选一个连接开始写 SQL，或直接查数据字典。"
                  }
                  action={
                    <div className="flex items-center gap-2">
                      {db.conns.length === 0 ? (
                        <button type="button" className="dbx-btn pri" onClick={() => openConnDialog(null)}>
                          <Icon name="plus" size={12} />
                          新建连接
                        </button>
                      ) : (
                        <>
                          <button type="button" className="dbx-btn pri" onClick={() => void newConsole()}>
                            <Icon name="terminal" size={12} />
                            新建 SQL 控制台
                          </button>
                          <button type="button" className="dbx-btn" onClick={() => openDictTab(defaultConnId())}>
                            <Icon name="clipboard" size={12} />
                            数据字典
                          </button>
                        </>
                      )}
                    </div>
                  }
                />
              )}
            </div>
          </DockRegion>
        </>
      )}
      <DbDocTabs />
      <ConnDialog />
      {db.objectFinder && <DbObjectFinder connId={defaultConnId()} onClose={()=>showObjectFinder(false)} />}
    </>
  );
}
