import { useState } from "react";
import { Icon } from "../ui/icon";
import { ConnPicker } from "./ConnPicker";
import { ContextMenu, type ContextMenuItem } from "../workspace/ContextMenu";
import { switchConn } from "../../lib/dbActions";
import { useConnOf, useConnRt, type SqlTab } from "../../lib/dbStore";
import { useDbReadOnly } from "../../lib/dbReadOnly";
import { useOperations } from "../../lib/operations";
import { TransactionButtons, TxBar, useDbTransaction } from "./TxBar";
import { DbContextBar } from "./DbContextBar";

/** 连接上下文与执行工具条共用事务切换锁，切换模式时不能换库。 */
export function SqlToolbar({ tab, scope = "执行当前语句", onRun, onStop, onExplain, onFormat, onExport, onValueSearch, onScriptReplay, historyOpen, onHistory, snipsOpen, onSnips, sessionsOpen, onSessions }: {
  tab: SqlTab;
  scope?: string;
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
  const conn = useConnOf(tab.connId);
  const rt = useConnRt(tab.connId);
  const readonly=useDbReadOnly(tab.connId);
  const operation = useOperations().find(o => o.key === 'db.sql:' + tab.id && o.endedAt === undefined);
  const stopping = operation?.state === "cancelling";
  const transaction = useDbTransaction({connId:tab.connId, tabId:tab.id, slot:tab.slot, tx:tab.tx, notice:tab.txNotice,
    blocked:tab.running || !!operation, readOnly:readonly});
  const locked = !!transaction.active || transaction.lost;
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);

  const popup = (el: HTMLElement, items: ContextMenuItem[]) => {
    const r = el.getBoundingClientRect();
    setMenu({ x: r.left, y: r.bottom + 4, items });
  };

  return (
    <>
    <DbContextBar connId={tab.connId} independent={!!tab.slot} transactionMode={transaction.mode} connectionControl={<ConnPicker connId={tab.connId} compact disabled={!!transaction.active || tab.running || !!operation} onPick={(id) => void switchConn(tab.id, id)} />} />
    <div className="dbx-sqlbar">
      <div className="dbx-run-controls">
      {tab.running ? (
        // 执行中把「执行」换成「停止」：以前只能干等 30 秒超时，或者杀掉整个应用。
        // 能不能停按 `Caps.cancel` 决定（两个引擎现在都支持，但要留出按能力降级的路）：
        // 让它可点再报错，用户会以为语句已经在库里停了。
        <button
          type="button"
          className="dbx-btn dbx-run-action" data-running
          disabled={stopping || (rt.caps ? !rt.caps.cancel : false)}
          onClick={onStop}
          title={
            rt.caps && !rt.caps.cancel
              ? "这个连接用不了语句中断，只能等它自己跑完或超时"
              : "取消正在执行的语句（数据库侧会收到 ORA-01013）"
          }
        >
          <Icon name={stopping ? "spinner" : "stop"} size={12} />
          {stopping ? "等待停止返回…" : "停止"}
        </button>
      ) : (
        <div className="dbx-runsplit">
          <button type="button" className="dbx-btn pri dbx-run-action" disabled={!conn || locked || !!operation} onClick={() => onRun("current")} title="执行光标所在的语句（有选中则执行选中部分）">
            <Icon name="play" size={12} />
            执行 <span className="k">Ctrl+Enter</span>
          </button>
          <button
            type="button"
            className="dbx-btn pri"
            disabled={!conn || locked || !!operation}
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
      </div>
      <TransactionButtons transaction={transaction} />
      <span className="dbx-scope" aria-live="polite" title="Ctrl+Enter 执行当前语句或选中 SQL；Alt+X 执行整个脚本">{scope.replace(/^执行/, "")}</span>
      <span className="dbx-sp" />
      <button
        type="button"
        className="dbx-btn ghost"
        data-on={historyOpen ? "" : undefined}
        onClick={onHistory}
        disabled={!tab.connId}
        title="执行历史"
        aria-label="执行历史"
        aria-pressed={historyOpen}
      >
        <Icon name="history" size={15} />
        <span className="dbx-action-label">历史</span>
      </button>
      <button
        type="button"
        className="dbx-btn ghost"
        data-on={snipsOpen ? "" : undefined}
        onClick={onSnips}
        disabled={!tab.connId}
        title="常用 SQL 片段（本机保存，不上传）"
        aria-label="SQL 片段"
        aria-pressed={snipsOpen}
      >
        <Icon name="code" size={15} />
        <span className="dbx-action-label">片段</span>
      </button>
      <button
        type="button"
        className="dbx-btn ghost"
        disabled={!tab.connId}
        aria-label="更多数据库操作"
        title="更多：格式化 / 导出 INSERT / 按值反查 / 会话与锁"
        onClick={(e) =>
          popup(e.currentTarget, [
            { label: "格式化 SQL", icon: "paintbrush", hint: "Ctrl+Shift+F", onSelect: onFormat },
            {
              label: "导出 INSERT（光标处查询）",
              icon: "download",
              disabled: tab.running || locked || !!operation || !conn,
              onSelect: onExport,
            },
            {
              label: "按值反查（只读）",
              icon: "search",
              disabled: tab.running || locked || !!operation || !conn,
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
        <span className="dbx-action-label">工具</span>
      </button>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
    <TxBar transaction={transaction} />
    </>
  );
}
