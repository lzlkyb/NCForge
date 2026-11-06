import type { CSSProperties } from "react";
import { Icon } from "../ui/icon";
import { logRaw, logsRaw, type LogRecord } from "../../lib/serverLog";
import { stackLocation } from "../../lib/serviceLogSource";
import type { ServiceLogRow } from "../../lib/serviceLogRows";
import { ServiceLogSourceLink } from "./ServiceLogSourceLink";

export function LogHighlight({ text, query }: { text: string; query: string }) {
  const q = query.trim(); if (!q) return <>{text}</>;
  const parts = [], lower = text.toLowerCase(), needle = q.toLowerCase(); let offset = 0, at;
  while ((at = lower.indexOf(needle, offset)) >= 0) { parts.push(text.slice(offset, at), <mark key={at}>{text.slice(at, at + q.length)}</mark>); offset = at + q.length; }
  parts.push(text.slice(offset)); return <>{parts}</>;
}

interface Props {
  row: ServiceLogRow; top: number; rowRef: (key: string, node: HTMLDivElement | null) => void;
  query: string; currentMatch: number | null; expanded: ReadonlySet<number>;
  toggle: (id: number) => void; copy: (text: string, label: string) => void; details: (record: LogRecord) => void;
}
export function ServiceLogRowView({ row, top, rowRef, query, currentMatch, expanded, toggle, copy, details }: Props) {
  const { line, kind, record } = row;
  const highlighted = (text: string) => <LogHighlight text={text} query={query} />;
  const structured = !!(line.structured ?? (line.time || line.thread));
  const location = kind === "stack" ? stackLocation(line.text) : null;
  const locationText = location ? `${location.file}:${location.line}` : "";
  const locationAt = location ? line.text.indexOf(locationText) : -1;
  const style: CSSProperties = { top };
  return <div ref={node => rowRef(row.key, node)} data-row-key={row.key} data-line-id={line.id}
    className={`sc-log-row ${kind} ${line.level} ${currentMatch === line.id ? "current-match" : ""}`} style={style}>
    {kind === "actions" ? <div className="sc-log-stack-actions"><button type="button" className="sc-log-button" onClick={() => details(record!)}><Icon name="info" size={12} />完整异常</button><button type="button" className="sc-log-button" onClick={() => copy(logsRaw([record!.line, ...record!.stack]), "异常原文")}><Icon name="copy" size={12} />复制异常</button></div>
      : kind === "command" ? <button type="button" className="sc-log-command" aria-expanded={expanded.has(line.id) || !!query.trim()} onClick={() => toggle(line.id)}><Icon name="chevronRight" size={12} />启动命令 · java · 展开完整内容</button>
      : kind === "commandText" ? <div className="sc-log-raw">{highlighted(logRaw(line))}<button className="sc-log-button" type="button" onClick={() => copy(logRaw(line), "完整启动命令")}><Icon name="copy" size={12} />复制完整命令</button></div>
      : kind === "stack" ? <div className="sc-log-stack">{location ? <>{highlighted(line.text.slice(0, locationAt))}<ServiceLogSourceLink text={line.text}>{highlighted(locationText)}</ServiceLogSourceLink>{highlighted(line.text.slice(locationAt + locationText.length))}</> : highlighted(line.text)}</div>
      : <div className={structured ? "sc-log-structured" : "sc-log-raw"}>
        {structured && <><span className="sc-log-time">{line.time}</span><span className="sc-log-level">{line.level.toUpperCase()}</span></>}
        <div className="sc-log-message">{kind === "exception" ? <button className="sc-log-exception" type="button" aria-expanded={expanded.has(line.id) || (!!query.trim() && record!.stack.some(l => logRaw(l).toLowerCase().includes(query.toLowerCase())))} onClick={() => toggle(line.id)}><Icon name="chevronRight" size={12} />{highlighted([line.thread && `[${line.thread}]`, line.logger && `${line.logger} -`, line.text].filter(Boolean).join(" "))}<span className="sc-log-stack-count"> · {record!.stack.length} 行堆栈</span>{record!.rootCause && <span className="sc-log-root">{highlighted(record!.rootCause)}</span>}</button>
          : highlighted(structured ? [line.thread && `[${line.thread}]`, line.logger && `${line.logger} -`, line.text].filter(Boolean).join(" ") : logRaw(line))}</div>
      </div>}
  </div>;
}
