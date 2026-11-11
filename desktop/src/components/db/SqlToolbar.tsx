import { QueryElapsed } from "./SqlExecutionFeedback";
import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "../ui/icon";
import { ConnPicker } from "./ConnPicker";
import { ContextMenu, type ContextMenuItem } from "../workspace/ContextMenu";
import { switchConn } from "../../lib/dbActions";
import { isRunning, useConnOf, useConnRt, type SqlTab } from "../../lib/dbStore";
import { useDbReadOnly } from "../../lib/dbReadOnly";
import { useActiveOperation } from "../../lib/operations";
import { TransactionButtons, TransactionMenu, TxBar, useDbTransaction } from "./TxBar";
import { DbContextBar } from "./DbContextBar";
import { setSqlFormatPrefs, useSqlFormatPrefs, type SqlLayout } from "../../lib/sqlFormatPrefs";
import { toast } from "../ui/toast";
import type { SqlExecutionScope, SqlFormatScope, SqlRunMode } from "./SqlEditor";
import type { SqlConsoleFocus } from "../../hooks/useSqlConsoleSplit";

/** 连接上下文与执行工具条共用事务切换锁，切换模式时不能换库。 */
export function SqlToolbar({ tab, scope, onRun, onStop, onExplain, onFormat, onExport, onValueSearch, onScriptReplay, historyOpen, onHistory, snipsOpen, onSnips, memoryOpen, onMemory, sessionsOpen, onSessions, focusMode = "split", onFocusChange }: {
  tab: SqlTab;
  scope: SqlExecutionScope | null;
  focusMode?: SqlConsoleFocus;
  onFocusChange?: (mode: SqlConsoleFocus) => void;
  onRun: (mode: SqlRunMode, collectStats?: boolean) => void;
  onStop: () => void;
  onExplain: () => void;
  onFormat: (scope?: SqlFormatScope) => void;
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
  memoryOpen?: boolean;
  onMemory?: () => void;
  /** 会话与锁抽屉是否打开（按钮高亮用）。 */
  sessionsOpen: boolean;
  onSessions: () => void;
}) {
  const formatPrefs = useSqlFormatPrefs();
  const chooseLayout = (layout: SqlLayout) => {
    if (!setSqlFormatPrefs({ layout })) toast("排版方式在本次会话已生效，但未保存到本机，请在设置中重试。", "warning");
  };
  const conn = useConnOf(tab.connId);
  const rt = useConnRt(tab.connId);
  const readonly=useDbReadOnly(tab.connId);
  const operation = useActiveOperation('db.sql:' + tab.id);
  /**
   * 「这个标签正在执行」的唯一定义，两个按钮共用。
   *
   * 一定要并上 `operation`：任务在点执行的那一刻就登记了（先于任何 IO），而标签上的
   * `run` 要落到 store 才算数。只看 `run`，在它落地之前那一段——建连接、等口令、
   * 申请独立会话——就会出现 **「执行」已经灰了、「停止」还是灰的**：用户以为整段执行
   * 都停不下来（v0.4.0 现场反馈就是这个窗口；那一版 `running` 更晚，在 `ensureConnected`
   * 与 `setTxNotice` 之后才置真，窗口长达整个连接过程）。
   */
  const running = isRunning(tab) || !!operation;
  const stopping = operation?.state === "cancelling";
  const transaction = useDbTransaction({connId:tab.connId, tabId:tab.id, slot:tab.slot, tx:tab.tx, notice:tab.txNotice,
    blocked:running, readOnly:readonly});
  const locked = !!transaction.active || transaction.lost;
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const scopeId = useId();
  const barRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const modifier = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
  useEffect(() => {
    if (!barRef.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setCompact(entry.contentRect.width < 850));
    observer.observe(barRef.current);
    return () => observer.disconnect();
  }, []);
  const currentScope = scope?.tabId === tab.id ? scope : null;
  const statements = currentScope?.statements ?? [];
  const runLabel = currentScope?.selected ? "执行选中 SQL" : "执行整个脚本";
  const first = statements[0], last = statements[statements.length - 1];
  const range = first && last?.endLine !== undefined
    ? `${first.startLine === last.endLine ? `第 ${first.startLine} 行` : `第 ${first.startLine}–${last.endLine} 行`}`
    : statements.length ? "执行整个脚本"
    : !currentScope ? "正在读取执行范围…" : currentScope.selected ? "选中内容没有可执行 SQL" : "编辑器里没有可执行 SQL";
  const disabledReason = !conn ? "请先选择数据库连接" : transaction.lost ? "事务结果待核对，请先核对当前会话"
    : transaction.active ? "正在处理事务，等待数据库确认" : null;
  useEffect(() => { setMenu(null); }, [tab.id]);

  const popup = (el: HTMLElement, items: ContextMenuItem[]) => {
    const r = el.getBoundingClientRect();
    setMenu({ x: r.left, y: r.bottom + 4, items });
  };

  const executionBlocked = !conn || locked || running;
  const historyItem: ContextMenuItem = { label: historyOpen ? "收起执行历史" : "执行历史", icon: "history", disabled: !tab.connId, onSelect: onHistory };
  const snippetsItem: ContextMenuItem = { label: snipsOpen ? "收起 SQL 片段" : "SQL 片段", icon: "sqlSnippet", disabled: !tab.connId, onSelect: onSnips };
  const planItem: ContextMenuItem = { label: "执行计划（不真正执行）", icon: "queryPlan", disabled: executionBlocked || !statements.length, onSelect: onExplain };
  const moreItems: ContextMenuItem[] = [
    ...(onMemory ? [{ label: memoryOpen ? "收起补全记忆" : "补全记忆", icon: "history" as const, disabled: !tab.connId, onSelect: onMemory }] : []),
    ...(compact ? [planItem, historyItem, snippetsItem] : []),
    { label: "回放 .sql 文件", icon: "upload", disabled: executionBlocked, onSelect: onScriptReplay },
    { label: "导出 INSERT（光标处查询）", icon: "download", disabled: executionBlocked || !statements.length, onSelect: onExport },
    { label: "按值反查（只读）", icon: "search", disabled: executionBlocked, onSelect: onValueSearch },
    { label: sessionsOpen ? "收起会话与锁" : "会话与锁", icon: "lock", separator: true, disabled: !tab.connId, onSelect: onSessions },
  ];
  const formatItems: ContextMenuItem[] = [
    { label: currentScope?.selected ? "格式化选中 SQL" : "格式化整个编辑器", icon: "sqlFormat", onSelect: () => onFormat("auto") },
    { label: "仅格式化当前语句", icon: "code", onSelect: () => onFormat("current") },
    { label: "格式化整个脚本", icon: "terminal", onSelect: () => onFormat("script") },
    { label: "排版：阅读优先", separator: true, hint: formatPrefs.layout === "reading" ? "当前" : undefined,
      onSelect: () => chooseLayout("reading") },
    { label: "排版：结构展开", hint: formatPrefs.layout === "expanded" ? "当前" : undefined,
      onSelect: () => chooseLayout("expanded") },
  ];
  return <>
    <div ref={barRef} className="dbx-command-header dbx-execution-bar" role="toolbar" aria-label="SQL 工具栏">
      <div className="dbx-sqlbar dbx-execution-primary">
        <div className="dbx-run-controls">
          <div className="dbx-runsplit">
            <button type="button" className="dbx-btn pri dbx-run-action" disabled={executionBlocked || !statements.length}
              aria-label="执行" aria-describedby={scopeId} onClick={() => onRun("auto")}
              title={`${runLabel} · ${range} · ${modifier}+Enter${disabledReason ? ` · ${disabledReason}` : ""}`}>
              <Icon name="play" size={16} />
              <span>执行</span>
            </button>
            <button type="button" className="dbx-btn pri dbx-run-menu" disabled={executionBlocked} aria-label="更多执行方式" title="更多执行方式" aria-haspopup="menu"
              onClick={event => popup(event.currentTarget, [
                { label: "执行当前语句", icon: "play", hint: `${modifier}+Shift+Enter`, disabled: !statements.length, onSelect: () => onRun("current") },
                { label: "执行整个脚本", icon: "terminal", hint: "Alt+X", onSelect: () => onRun("script") },
                { label: "执行当前语句并采集统计", icon: "activity", disabled: !statements.length, onSelect: () => onRun("current", true) },
              ])}><Icon name="chevronDown" size={12} /></button>
          </div>
          <button type="button" className="dbx-btn ghost dbx-stop-action" data-running={running || undefined}
            disabled={!running || stopping || (rt.caps ? !rt.caps.cancel : false)} onClick={onStop}
            aria-label={stopping ? "等待数据库停止确认" : "停止"} aria-busy={stopping}
            title={stopping ? "正在等待数据库停止确认" : rt.caps && !rt.caps.cancel ? "当前连接不支持中断语句" : "停止当前执行，等待数据库确认"}>
            <Icon name={stopping ? "spinner" : "stop"} size={15} />
          </button>
          <span className="dbx-query-clock">{operation && <QueryElapsed startedAt={operation.startedAt} />}</span>
        </div>
        <span id={scopeId} className="dbx-scope" aria-live="polite">{range}{disabledReason && <span className="dbx-run-reason"> · {disabledReason}</span>}</span>
      </div>
      <div className="dbx-execution-aux">
        <button type="button" className="dbx-btn ghost" aria-label="格式化 SQL" title={`格式化${currentScope?.selected ? "选中 SQL" : "整个编辑器"} · ${formatPrefs.layout === "reading" ? "阅读优先" : "结构展开"} · ${modifier}+Shift+F`} onClick={() => onFormat()}><Icon name="sqlFormat" size={16} /></button>
        <button type="button" className="dbx-btn ghost dbx-format-menu" aria-label="格式化选项" title="选择排版方式与格式化范围" aria-haspopup="menu" onClick={event => popup(event.currentTarget, formatItems)}><Icon name="chevronDown" size={12} /></button>
        {!compact && <>
          <button type="button" className="dbx-btn ghost" aria-label="执行计划" title={planItem.label} disabled={planItem.disabled} onClick={onExplain}><Icon name="queryPlan" size={16} /></button>
          <span className="dbx-tool-divider" />
          <button type="button" className="dbx-btn ghost" aria-label="执行历史" title="执行历史" disabled={!tab.connId} aria-pressed={historyOpen} data-on={historyOpen || undefined} onClick={onHistory}><Icon name="history" size={16} /></button>
          <button type="button" className="dbx-btn ghost" aria-label="SQL 片段" title="SQL 片段 · 本机保存" disabled={!tab.connId} aria-pressed={snipsOpen} data-on={snipsOpen || undefined} onClick={onSnips}><Icon name="sqlSnippet" size={16} /></button>
        </>}
        <button type="button" className="dbx-btn ghost" aria-label="更多数据库操作" title="更多数据库操作" aria-haspopup="menu" data-on={compact && (historyOpen || snipsOpen) || sessionsOpen || undefined} onClick={event => popup(event.currentTarget, moreItems)}><Icon name="more" size={16} /></button>
      </div>
      <DbContextBar compact connId={tab.connId} independent={!!tab.slot} transactionMode={transaction.mode}
        sessionControl={<><TransactionMenu key={tab.id} compact transaction={transaction} />{transaction.mode === "手动提交" && <TransactionButtons compact transaction={transaction} />}</>}
        connectionControl={<ConnPicker connId={tab.connId} compact disabled={!!transaction.active || running} onPick={id => void switchConn(tab.id, id)} />} />
      {onFocusChange && <button type="button" className="dbx-btn ghost dbx-layout-action" aria-label="编辑器与结果布局" title="编辑器与结果布局" aria-haspopup="menu" onClick={event => popup(event.currentTarget, [
        { label: "专注结果", icon: "database", disabled: focusMode === "results", onSelect: () => onFocusChange("results") },
        { label: "专注编辑器", icon: "code", disabled: focusMode === "editor", onSelect: () => onFocusChange("editor") },
        { label: "还原布局", icon: "restore", disabled: focusMode === "split", onSelect: () => onFocusChange("split") },
      ])}><Icon name={focusMode === "split" ? "layoutRows" : "restore"} size={16} /></button>}
    </div>
    {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    <TxBar transaction={transaction} />
  </>;
}
