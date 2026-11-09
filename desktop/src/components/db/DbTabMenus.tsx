import { useState } from "react";
import { Menu, MenuItem } from "../ui/Menu";
import { Icon } from "../ui/icon";
import { dbTabLabel } from "../../lib/dbPendingSessions";
import { useDbSelector } from "../../lib/dbStore";

/**
 * 文档面标签条右侧的两个入口。
 *
 * 标签一多就会被 `.wb-tabs` 的 `overflow:hidden` 裁掉，鼠标滚不过去也点不到；
 * 「所有标签」给一条可搜索、键盘可达的直达路径。「最近关闭」则是关掉 SQL 草稿后
 * 唯一能把它找回来的地方（执行历史只记执行过的语句）。
 *
 * 两个组件都只订阅自己需要的切片，不静态引 `dbActions`（经 sqlModels 会拽进 Monaco）。
 */

const KIND_LABEL = { sql: "SQL 控制台", table: "表 / 对象", dict: "数据字典", compare: "结果比对" } as const;

function timeAgo(at: number): string {
  const sec = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (sec < 60) return "刚刚";
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时前`;
  return `${Math.floor(sec / 86400)} 天前`;
}

const menuLabel = (name: string, detail: string) => (
  <span className="wb-tabs-menu-label">
    <span className="wb-tabs-menu-name">{name}</span>
    <span className="wb-tabs-menu-detail">{detail}</span>
  </span>
);

export function DbAllTabsMenu({ onPick }: { onPick: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const tabs = useDbSelector((s) => s.tabs);
  const conns = useDbSelector((s) => s.conns);
  const active = useDbSelector((s) => s.active);
  const entries = tabs.map((t) => ({
    id: t.id,
    label: dbTabLabel(t),
    detail: [KIND_LABEL[t.kind], conns.find((c) => c.id === t.connId)?.name ?? "未选连接"].join(" · "),
  }));
  const q = query.trim().toLowerCase();
  const shown = q ? entries.filter((e) => `${e.label} ${e.detail}`.toLowerCase().includes(q)) : entries;
  return (
    <div className="wb-tabs-all-wrap">
      <Menu portal width="w-80" trigger={(open, toggle) => (
        <button
          type="button"
          className="wb-icon-btn"
          aria-label="所有数据库标签"
          aria-haspopup="menu"
          aria-expanded={open}
          title="所有数据库标签：按标签名、表名或连接搜索"
          disabled={!tabs.length}
          onClick={toggle}
        >
          <Icon name="chevronDown" size={16} />
        </button>
      )}>
        {(close) => <>
          <div className="wb-tabs-filter">
            <input
              autoFocus
              aria-label="搜索打开的数据库标签"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="标签名 / 表名 / 连接"
            />
            <div className="wb-tabs-filter-options"><span>{shown.length} / {tabs.length}</span></div>
          </div>
          {shown.length
            ? shown.map((e) => (
              <MenuItem key={e.id} label={menuLabel(e.label, e.detail)} active={e.id === active}
                onClick={() => { onPick(e.id); close(); }} />
            ))
            : <div className="wb-tabs-filter-empty">没有匹配的标签，请调整关键词。</div>}
        </>}
      </Menu>
    </div>
  );
}

export function DbClosedTabsMenu({
  onRestore, onRestoreLast, onClear,
}: {
  onRestore: (entryId: string) => void;
  onRestoreLast: () => void;
  onClear: () => void;
}) {
  const items = useDbSelector((s) => s.recentlyClosed);
  const conns = useDbSelector((s) => s.conns);
  const entries = items.map((e) => ({
    id: e.id,
    label: String(e.tab.title ?? e.tab.table ?? "数据库文档"),
    detail: [
      e.tab.kind === "sql" ? "SQL 控制台" : "表 / 对象",
      conns.find((c) => c.id === e.tab.connId)?.name ?? "未选连接",
      timeAgo(e.at),
    ].join(" · "),
  }));
  return (
    <div className="wb-tabs-all-wrap">
      <Menu portal width="w-80" trigger={(open, toggle) => (
        <button
          type="button"
          className="wb-icon-btn"
          aria-label="最近关闭的数据库标签"
          aria-haspopup="menu"
          aria-expanded={open}
          title="最近关闭的数据库标签：恢复草稿或清空记录（也可用标签恢复快捷键）"
          onClick={toggle}
        >
          <Icon name="history" size={15} />
        </button>
      )}>
        {(close) => <>
          <div className="wb-tabs-filter">
            <div className="wb-tabs-filter-options">
              <button type="button" disabled={!items.length} onClick={() => { onRestoreLast(); close(); }}>恢复最近关闭</button>
              <button type="button" disabled={!items.length} onClick={() => { onClear(); close(); }}>清空记录</button>
              <span>最多 20 条</span>
            </div>
          </div>
          {entries.length
            ? [...entries].reverse().map((e) => (
              <MenuItem key={e.id} label={menuLabel(e.label, e.detail)} onClick={() => { onRestore(e.id); close(); }} />
            ))
            : <div className="wb-tabs-filter-empty">还没有关闭过的标签。关掉 SQL 或表页后会在这里留一份草稿快照。</div>}
        </>}
      </Menu>
    </div>
  );
}
