import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Icon } from "../ui/icon";
import { countLevels, filterLines, logsRaw, type LogRecord } from "../../lib/serverLog";
import { getLogPanelStore, useLogPanelForm, type ServiceLogSource } from "../../lib/logPanelStore";
import { serviceLogMatches, serviceLogRows, isLaunchCommand } from "../../lib/serviceLogRows";
import { useViewActive } from "../../lib/viewActivity";
import { useServerLog } from "../../hooks/useServerLog";
import { useServiceLogVirtual } from "../../hooks/useServiceLogVirtual";
import { useServiceLogActions } from "../../hooks/useServiceLogActions";
import { ServiceLogToolbar } from "./ServiceLogToolbar";
import { ServiceLogFooter } from "./ServiceLogFooter";
import { ServiceLogRowView } from "./ServiceLogRows";
import { ServiceLogDetails } from "./ServiceLogDetails";
import "../../service-console-log.css";

interface Props {
  active: boolean; generation: number; appHidden: boolean; logPath: string; logSize: number;
  onReveal: (previous?: boolean) => void; onCleared: () => void; target?: ServiceLogSource;
  visible?: boolean; runId?: string | null; projectRoot?: string | null;
}
export function LogPanel({ active, generation, appHidden, logPath, logSize, onReveal, onCleared, target = "middleware", visible = true, runId, projectRoot }: Props) {
  const [previous, setPrevious] = useState(false);
  const [matchIndex, setMatchIndex] = useState(0);
  const [selected, setSelected] = useState("");
  const [details, setDetails] = useState<LogRecord | null>(null);
  const viewActive = useViewActive();
  const available = visible && !appHidden && viewActive;
  const reader = useServerLog(active, generation, !available, undefined, { target, previous, runId, projectRoot });
  const form = useLogPanelForm(target, previous), store = getLogPanelStore(target, previous);
  const filtered = useMemo(() => filterLines(reader.lines, form.level, form.keyword), [reader.lines, form.level, form.keyword]);
  const counts = useMemo(() => countLevels(reader.lines), [reader.lines]);
  const matches = useMemo(() => serviceLogMatches(filtered, form.query), [filtered, form.query]);
  const index = matches.length ? Math.min(matchIndex, matches.length - 1) : 0;
  const rows = useMemo(() => serviceLogRows(filtered, form.expanded, form.query), [filtered, form.expanded, form.query]);
  const body = useRef<HTMLDivElement>(null), find = useRef<HTMLInputElement>(null);
  const virtual = useServiceLogVirtual(rows, body, form.follow && !previous && !reader.historical, available, form.wrap, form.fontSize, form.scrollTop);
  const { jumpTo } = virtual;
  const actions = useServiceLogActions({ target, previous, fileId: reader.fileId, reset: reader.reset, onCleared });
  const search = useRef({ matches, rows, index }); search.current = { matches, rows, index };
  const moveMatch = (direction: number) => { store.set({ follow: false }); setMatchIndex(matches.length ? (index + direction + matches.length) % matches.length : 0); };
  const searchReady = matches.length > 0;
  useEffect(() => {
    if (!available || !form.query.trim() || !searchReady) return;
    const { matches, index, rows } = search.current, match = matches[index];
    if (!match) return;
    const row = rows.find(row => row.line.id === match.id);
    jumpTo(row && isLaunchCommand(row.line) ? `command-${match.id}` : String(match.id));
  }, [available, form.query, index, searchReady, jumpTo]);
  useEffect(() => {
    if (previous) return;
    if (form.follow || form.seen === null || reader.newestId < form.seen) store.set({ seen: reader.newestId });
  }, [previous, form.follow, form.seen, reader.newestId, store]);
  useEffect(() => {
    if (!available) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || document.querySelector('[role="dialog"][aria-modal="true"]:not([data-exiting])')) return;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "f") {
        if (document.activeElement?.closest(".monaco-editor")) return;
        event.preventDefault(); store.set({ findOpen: true }); requestAnimationFrame(() => { find.current?.focus(); find.current?.select(); });
      } else if (event.key === "F3" || (event.key === "Enter" && document.activeElement === find.current)) {
        if (!search.current.matches.length) return;
        event.preventDefault(); store.set({ follow: false });
        setMatchIndex(value => (value + (event.shiftKey ? -1 : 1) + search.current.matches.length) % search.current.matches.length);
      } else if (event.key === "Escape" && document.activeElement === find.current) {
        event.preventDefault(); store.set({ query: "", findOpen: false });
      }
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [available, store]);

  const followLatest = () => { reader.showLatest(); store.set({ follow: true, seen: reader.newestId }); };
  const toggle = (id: number) => { const expanded = new Set(form.expanded); if (expanded.has(id)) expanded.delete(id); else expanded.add(id); store.set({ expanded }); };
  const onScroll = () => {
    virtual.onScroll(); const element = body.current; if (!element) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 8;
    store.set({ scrollTop: element.scrollTop, ...(form.follow && !atBottom ? { follow: false } : {}) });
  };
  const captureSelection = () => {
    const selection = window.getSelection();
    setSelected(selection && body.current?.contains(selection.anchorNode) && body.current?.contains(selection.focusNode) ? selection.toString() : "");
  };
  const unseen = Math.max(0, reader.newestId - (form.seen ?? reader.newestId));
  const style = { "--sc-log-font": `${form.fontSize}px` } as CSSProperties;
  return <section className="sc-log" style={style} aria-label={`${target === 'client' ? '客户端' : '中间件'}控制台`}>
    <ServiceLogToolbar form={form} set={patch => { store.set(patch); if (patch.query !== undefined) setMatchIndex(0); }} counts={counts} matchedCount={filtered.length} matchIndex={index} matchCount={matches.length} onMatch={moveMatch} findRef={find} previous={previous} busy={actions.busy} selected={selected} target={target} logSize={reader.size || logSize}
      onCopy={() => actions.copy(logsRaw(filtered), `${filtered.length} 行已加载匹配日志`)} onCopySelection={() => actions.copy(selected, "日志选区")} onClear={actions.clear} onPurge={actions.purge}
      onExport={complete => actions.exportLog(complete ? undefined : logsRaw(filtered))} onReload={() => { reader.reset(); reader.retry(); }}
      onFollow={() => form.follow ? store.set({ follow: false }) : followLatest()} />
    {actions.busy && <div className="sc-log-operation" role="status"><Icon name="spinner" size={12} className="animate-spin" /><span>{actions.busy}中…</span>{actions.busy === '导出日志' && <button type="button" className="sc-log-button" onClick={actions.cancel}>取消</button>}</div>}
    {reader.error && <div className="sc-log-error" role="alert"><Icon name="alertTriangle" size={13} /><span>读取日志失败：{reader.error}。已加载内容仍可查看。</span><button type="button" className="sc-log-button" onClick={reader.retry}>重试</button></div>}
    {reader.truncated && <div className="sc-log-range-note">部分超长内容未加载，导出完整日志文件可保留全部原文。</div>}
    <div className="sc-log-container">
      <div ref={body} className="sc-log-body" data-wrap={form.wrap} onScroll={onScroll} onMouseUp={captureSelection} onKeyUp={captureSelection} tabIndex={0} aria-label="日志正文">
        {!reader.lines.length ? <div className="sc-log-empty"><strong>{reader.loading ? '正在读取日志…' : previous ? '没有上次运行日志' : '尚无控制台输出'}</strong><p>{reader.loading ? '正在读取当前日志的尾部片段。' : previous ? '首次启动前没有归档；启动新的运行后可在这里回看上一次输出。' : '启动后将显示准备过程和运行输出；清屏后新输出会继续显示。'}</p>{!reader.loading && <button type="button" className="sc-log-button" onClick={() => { reader.reset(); reader.retry(); }}>重新读取日志</button>}</div>
          : !filtered.length ? <div className="sc-log-empty"><strong>没有匹配的日志</strong><p>清除过滤可恢复上下文。</p><button type="button" className="sc-log-button" onClick={() => store.set({ level: 'all', keyword: '' })}>清除过滤</button></div>
          : <div className="sc-log-virtual" style={{ height: virtual.height }}>{rows.slice(virtual.start, virtual.end).map((row, offset) => <ServiceLogRowView key={row.key} row={row} top={virtual.offsets[virtual.start + offset]} rowRef={virtual.rowRef} query={form.query} currentMatch={matches[index]?.id ?? null} expanded={form.expanded} toggle={toggle} copy={actions.copy} details={setDetails} />)}</div>}
      </div>
      {!previous && !form.follow && <button className="sc-log-new" type="button" onClick={followLatest}><Icon name="stepInto" size={12} />{unseen ? `新增 ${unseen} 行 · ` : ''}回到最新</button>}
    </div>
    <ServiceLogFooter count={reader.lines.length} size={previous ? reader.size : reader.size || logSize} previous={previous} onPrevious={value => { setPrevious(value); setMatchIndex(0); setSelected(''); setDetails(null); }} start={reader.startOffset} end={reader.endOffset} historical={reader.historical} updatedAt={reader.updatedAt} active={active} hasOlder={reader.startOffset > 0} readingOlder={reader.readingOlder}
      onOlder={() => { store.set({ follow: false, scrollTop: 0 }); void reader.readOlder(); }} onLatest={followLatest} onReveal={() => onReveal(previous)} />
    <ServiceLogDetails record={details} onClose={() => setDetails(null)} onCopy={actions.copy} />
    <span className="sr-only">日志位置：{logPath}</span>
  </section>;
}
