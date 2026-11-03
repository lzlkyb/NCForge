import { useState } from "react";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { ConnPicker } from "./ConnPicker";
import { ContextMenu, type ContextMenuItem } from "../workspace/ContextMenu";
import { friendlyDbError } from "../../lib/db";
import { switchConn } from "../../lib/dbActions";
import { connOf, ensureSlot, patchTab, rtOf, txAction, useDb, type SqlTab } from "../../lib/dbStore";

/** SQL 控制台工具条：连接胶囊 · 执行 / 脚本 / 计划 / 格式化 · 事务模式 · 历史。生产库整条淡红。 */
export function SqlToolbar({ tab, onRun, onStop, onExplain, onFormat, onExport, onValueSearch, onScriptReplay, historyOpen, onHistory, snipsOpen, onSnips, sessionsOpen, onSessions }: {
  tab: SqlTab;
  onRun: (mode: "current" | "script") => void;
  onStop: () => void;
  onExplain: () => void;
  onFormat: () => void;
  /** 把光标处语句的结果导成 insert 脚本。 */
  onExport: () => void;
  /** 全库按值反查（只读）。 */
  onValueSearch: () => void;
  /** 选一个 .sql 文件逐条回放（现场迁移脚本）。 */
  onScriptReplay: () => void;
  historyOpen: boolean;
  onHistory: () => void;
  /** 片段抽屉是否打开（按钮高亮用）。 */
  snipsOpen: boolean;
  onSnips: () => void;
  /** 会话与锁抽屉是否打开（按钮高亮用）。 */
  sessionsOpen: boolean;
  onSessions: () => void;
}) {
  useDb();
  const conn = connOf(tab.connId);
  const rt = rtOf(tab.connId);
  const connected = rt.status === "connected";
  // 有槽看槽、没槽看 primary：SQL 标签执行一次之后所有语句都跑在独立槽里，
  // 只读 primary 会把「另一条会话」的模式显示成这个标签的模式。
  const tx = tab.slot ? tab.tx : rt.tx;
  const auto = tx?.autoCommit ?? conn?.autoCommit ?? false;
  const pending = (tx?.statements ?? 0) > 0;
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);

  const popup = (el: HTMLElement, items: ContextMenuItem[]) => {
    const r = el.getBoundingClientRect();
    setMenu({ x: r.left, y: r.bottom + 4, items });
  };

  const setMode = async (on: boolean) => {
    if (!tab.connId || !connected || on === auto) return;
    try {
      // 先拿到这条标签自己的会话：槽按连接保存的默认值创建，不会继承刚才对 primary
      // 的临时切换。不先 ensureSlot 就直接切 primary，等于切了一条这个标签不用的会话。
      const slot = await ensureSlot(tab.id, tab.connId);
      const next = await txAction(tab.connId, on ? "autocommit-on" : "autocommit-off", slot);
      if (slot) patchTab<SqlTab>(tab.id, { tx: next });
      // 切到自动提交时 JDBC 会把未提交的事务一并提交：给一句提示
      if (on && pending) toast("已切到自动提交，之前未提交的语句已一并提交", "warning");
    } catch (e) {
      toast(`切换失败：${friendlyDbError(e)}`, "error");
    }
  };

  return (
    <div className="dbx-sqlbar" data-prod={conn?.env === "prod" || undefined}>
      <ConnPicker connId={tab.connId} onPick={(id) => void switchConn(tab.id, id)} />
      {conn?.env === "prod" && (
        <span className="dbx-prodchip" title="生产环境：写操作会二次确认">
          生产
        </span>
      )}
      {tab.running ? (
        // 执行中把「执行」换成「停止」：以前只能干等 30 秒超时，或者杀掉整个应用。
        // 能不能停按 `Caps.cancel` 决定（两个引擎现在都支持，但要留出按能力降级的路）：
        // 让它可点再报错，用户会以为语句已经在库里停了。
        <button
          type="button"
          className="dbx-btn bad"
          disabled={rt.caps ? !rt.caps.cancel : false}
          onClick={onStop}
          title={
            rt.caps && !rt.caps.cancel
              ? "这个连接用不了语句中断，只能等它自己跑完或超时"
              : "取消正在执行的语句（数据库侧会收到 ORA-01013）"
          }
        >
          <Icon name="stop" size={12} />
          停止
        </button>
      ) : (
        <div className="dbx-runsplit">
          <button type="button" className="dbx-btn pri" disabled={!conn} onClick={() => onRun("current")} title="执行光标所在的语句（有选中则执行选中部分）">
            <Icon name="play" size={12} />
            执行 <span className="k">Ctrl+Enter</span>
          </button>
          <button
            type="button"
            className="dbx-btn pri"
            disabled={!conn}
            aria-label="更多执行方式"
            title="更多执行方式"
            onClick={(e) =>
              popup(e.currentTarget, [
                { label: "执行整个脚本", icon: "terminal", hint: "Alt+X", onSelect: () => onRun("script") },
                { label: "执行计划（不真正执行）", icon: "activity", onSelect: onExplain },
                { label: "回放 .sql 文件", icon: "upload", onSelect: onScriptReplay },
              ])
            }
          >
            <Icon name="chevronDown" size={12} />
          </button>
        </div>
      )}
      <button
        type="button"
        className="dbx-txchip"
        data-auto={auto || undefined}
        disabled={!connected}
        title={connected ? `事务模式：${auto ? "自动提交" : "手动提交"}（临时切换，默认值在连接设置里）` : "连上后可切换"}
        onClick={(e) =>
          popup(e.currentTarget, [
            { label: "手动提交", icon: "lock", onSelect: () => void setMode(false) },
            { label: "自动提交", icon: "check", onSelect: () => void setMode(true) },
          ])
        }
      >
        <span className="dot" />
        {auto ? "自动提交" : "手动提交"}
      </button>
      <span className="dbx-sp" />
      <button
        type="button"
        className="dbx-ibtn"
        data-on={historyOpen ? "" : undefined}
        onClick={onHistory}
        disabled={!tab.connId}
        title="执行历史"
        aria-label="执行历史"
        aria-pressed={historyOpen}
      >
        <Icon name="history" size={15} />
      </button>
      <button
        type="button"
        className="dbx-ibtn"
        data-on={snipsOpen ? "" : undefined}
        onClick={onSnips}
        disabled={!tab.connId}
        title="常用 SQL 片段（本机保存，不上传）"
        aria-label="SQL 片段"
        aria-pressed={snipsOpen}
      >
        <Icon name="code" size={15} />
      </button>
      <button
        type="button"
        className="dbx-ibtn"
        disabled={!tab.connId}
        aria-label="更多数据库操作"
        title="更多：格式化 / 导出 INSERT / 按值反查 / 会话与锁"
        onClick={(e) =>
          popup(e.currentTarget, [
            { label: "格式化 SQL", icon: "paintbrush", hint: "Ctrl+Shift+F", onSelect: onFormat },
            {
              label: "导出 INSERT（光标处查询）",
              icon: "download",
              disabled: tab.running || !conn,
              onSelect: onExport,
            },
            {
              label: "按值反查（只读）",
              icon: "search",
              disabled: tab.running || !conn,
              onSelect: onValueSearch,
            },
            {
              label: sessionsOpen ? "收起会话与锁" : "会话与锁",
              icon: "lock",
              separator: true,
              onSelect: onSessions,
            },
          ])
        }
      >
        <Icon name="more" size={15} />
      </button>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}
