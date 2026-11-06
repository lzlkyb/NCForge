import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { parseLogLink } from "../../lib/logLink";
import "../../diagnostic-workspace.css";

const ROW_HEIGHT = 22;
export function BuildRawLog({ log, root, onOpenAt }: { log: string[]; root: string; onOpenAt: (path: string, line: number) => void }) {
  const host = useRef<HTMLDivElement>(null), following = useRef(true);
  const [viewport, setViewport] = useState({ top: 0, height: 240 });
  const links = useMemo(() => log.map(line => parseLogLink(line, root)), [log, root]);
  useLayoutEffect(() => {
    const element = host.current; if (!element) return;
    const refresh = () => setViewport({ top: element.scrollTop, height: element.clientHeight || 240 });
    if (typeof ResizeObserver === "undefined") { refresh(); return; }
    const observer = new ResizeObserver(refresh); observer.observe(element); refresh(); return () => observer.disconnect();
  }, []);
  const previous = useRef(log);
  useLayoutEffect(() => {
    const element = host.current; if (!element) return;
    const height = element.clientHeight || viewport.height;
    const maxTop = Math.max(0, log.length * ROW_HEIGHT - height);
    let top = element.scrollTop;
    if (following.current) top = maxTop;
    else if (previous.current.length && (log[0] !== previous.current[0] || log[1] !== previous.current[1])) {
      // A capped stream drops old rows. Retain the first visible row when it still exists.
      const removed = log[0] === previous.current[0] ? previous.current.indexOf(log[1], 1) - 1 : previous.current.indexOf(log[0]);
      top = removed > 0 ? Math.max(0, top - removed * ROW_HEIGHT) : 0;
    }
    previous.current = log;
    element.scrollTop = Math.min(top, maxTop);
    setViewport(value => ({ top: element.scrollTop, height: element.clientHeight || value.height }));
  }, [log, viewport.height]);
  const start = Math.max(0, Math.floor(viewport.top / ROW_HEIGHT) - 8), end = Math.min(log.length, Math.ceil((viewport.top + viewport.height) / ROW_HEIGHT) + 8);
  return <div className="dw-build-raw" aria-label="编译原始输出" ref={host} tabIndex={0} onScroll={event => { const el = event.currentTarget; following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; setViewport({ top: el.scrollTop, height: el.clientHeight || 240 }); }}>
    {!log.length ? <div className="wb-panel-note">还没有编译输出</div> : <div className="dw-build-virtual" style={{ height: log.length * ROW_HEIGHT }}>{log.slice(start, end).map((text, local) => { const index = start + local, link = links[index], style = { top: index * ROW_HEIGHT, height: ROW_HEIGHT }; return link ? <button type="button" key={index} className="dw-build-log-line wb-log-link" style={style} title={`${link.path}:${link.line}\n${text}`} onClick={() => onOpenAt(link.path, link.line)}>{text || " "}</button> : <div className="dw-build-log-line" key={index} style={style} title={text}>{text || " "}</div>; })}</div>}
  </div>;
}
