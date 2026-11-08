import { useEffect, useId, useState } from "react";
import { Icon } from "../ui/icon";
import { ConnPicker } from "./ConnPicker";
import { ContextMenu, type ContextMenuItem } from "../workspace/ContextMenu";
import { switchConn } from "../../lib/dbActions";
import { useConnOf, useConnRt, type SqlTab } from "../../lib/dbStore";
import { useDbReadOnly } from "../../lib/dbReadOnly";
import { useOperations } from "../../lib/operations";
import { TransactionMenu, TxBar, useDbTransaction } from "./TxBar";
import { DbContextBar } from "./DbContextBar";
import type { SqlExecutionScope } from "./SqlEditor";
import type { SqlConsoleFocus } from "../../hooks/useSqlConsoleSplit";

/** 连接上下文与执行工具条共用事务切换锁，切换模式时不能换库。 */
export function SqlToolbar({ tab, scope, onRun, onStop, onExplain, onFormat, onExport, onValueSearch, onScriptReplay, historyOpen, onHistory, snipsOpen, onSnips, sessionsOpen, onSessions, focusMode = "split", onFocusChange }: {
  tab: SqlTab;
  scope: SqlExecutionScope | null;
  focusMode?: SqlConsoleFocus;
  onFocusChange?: (mode: SqlConsoleFocus) => void;
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
  const scopeId = useId();
  const currentScope = scope?.tabId === tab.id ? scope : null;
  const statements = currentScope?.statements ?? [];
  const runLabel = currentScope?.selected ? "执行选中 SQL" : "执行当前语句";
  const first = statements[0], last = statements[statements.length - 1];
  const range = first && last?.endLine !== undefined
    ? `${first.startLine === last.endLine ? `第 ${first.startLine} 行` : `第 ${first.startLine}–${last.endLine} 行`} · ${statements.length} 条`
    : statements.length ? `${statements.length} 条语句`
    : !currentScope ? "正在读取执行范围…" : currentScope.selected ? "选中内容没有可执行 SQL" : "光标处没有可执行 SQL";
  const disabledReason = !conn ? "请先选择数据库连接" : transaction.lost ? "事务结果待核对，请先核对当前会话"
    : transaction.active ? "正在处理事务，等待数据库确认" : operation && !tab.running ? "正在等待上次操作结束" : null;
  useEffect(() => { setMenu(null); }, [tab.id]);

  const popup = (el: HTMLElement, items: ContextMenuItem[]) => {
    const r = el.getBoundingClientRect();
    setMenu({ x: r.left, y: r.bottom + 4, items });
  };

  return (
    <>
    <div className="dbx-command-header dbx-execution-bar">
    <div className="dbx-sqlbar dbx-execution-primary">
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
          {stopping ? "等待数据库停止…" : "停止"}
        </button>
      ) : (
        <div className="dbx-runsplit">
          <button type="button" className="dbx-btn pri dbx-run-action" disabled={!conn || locked || !!operation || !statements.length} aria-describedby={scopeId} onClick={() => onRun("current")} title={`${runLabel} · Ctrl+Enter`}>
            <Icon name="play" size={12} />
            {runLabel}
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
                { label: "执行计划（不真正执行）", icon: "activity", disabled: !statements.length, onSelect: onExplain },
                { label: "回放 .sql 文件", icon: "upload", onSelect: onScriptReplay },
              ])
            }
          >
            <Icon name="chevronDown" size={12} />
          </button>
        </div>
      )}
      </div>
      <span id={scopeId} className="dbx-scope" aria-live="polite">
        <span>{range}</span>
        {disabledReason && <span className="dbx-run-reason">{disabledReason}</span>}
      </span>
    </div>
    <DbContextBar connId={tab.connId} independent={!!tab.slot} transactionMode={transaction.mode}
      sessionControl={<TransactionMenu key={tab.id} transaction={transaction} />}
      connectionControl={<ConnPicker connId={tab.connId} compact disabled={!!transaction.active || tab.running || !!operation} onPick={(id) => void switchConn(tab.id, id)} />} />
    <div className="dbx-execution-aux">
      <button
        type="button"
        className="dbx-btn ghost dbx-history-action"
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
        className="dbx-btn ghost dbx-snippet-action"
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
        className="dbx-btn ghost dbx-tools-action"
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
      {onFocusChange && <div className="dbx-focus-controls">
        <button type="button" className="dbx-btn ghost" onClick={() => onFocusChange(focusMode === "split" ? "results" : "split")}>
          <Icon name={focusMode === "split" ? "maximize" : "restore"} size={14} />
          {focusMode === "split" ? "专注结果" : "还原布局"}
        </button>
        <button type="button" className="dbx-ibtn" aria-label="编辑器与结果布局" aria-haspopup="menu" onClick={event => popup(event.currentTarget, [
          { label: "专注结果", icon: "database", disabled: focusMode === "results", onSelect: () => onFocusChange("results") },
          { label: "专注编辑器", icon: "code", disabled: focusMode === "editor", onSelect: () => onFocusChange("editor") },
          { label: "还原布局", icon: "restore", disabled: focusMode === "split", onSelect: () => onFocusChange("split") },
        ])}><Icon name="chevronDown" size={12} /></button>
      </div>}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
    </div>
    <TxBar transaction={transaction} actions />
    </>
  );
}
