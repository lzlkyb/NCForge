import { useMemo, useState } from "react";
import { Icon } from "../ui/icon";
import { formatRevTime } from "../../lib/svn";
import type { BlameSnapshot } from "../../lib/svnHistory";
const MAX_LINES = 4000;

/** 正文与归属来自同一固定 revision，禁止以磁盘正文拼接服务器行信息。 */
export function BlameView({ title, snapshot, loading, retrying, error, onShowDiff, onRetry, onShowRevision }: {
  title: string; snapshot: BlameSnapshot | undefined; loading: boolean; retrying: boolean; error: string | null;
  onShowDiff: () => void; onRetry: () => void; onShowRevision?: (revision: number) => void;
}) {
  const [author, setAuthor] = useState("");
  const rows = useMemo(() => {
    if (!snapshot) return [];
    const text = snapshot.text.split("\n");
    return snapshot.lines.map((info, index) => ({ info, code: text[index] ?? "", line: index + 1 }));
  }, [snapshot]);
  const visible = rows.filter(row => !author || row.info.author === author);
  return <section className="vc-main vc-blame-view">
    <div className="vc-bar"><Icon name="user" size={14} /><b>逐行追溯</b><span className="vc-path" title={title}>{title}</span><span className="vc-sp" /><button className="vc-btn" onClick={onShowDiff}>返回差异</button><button className="vc-btn" disabled={retrying} onClick={onRetry}><Icon name="refresh" size={12} className={retrying ? "animate-spin" : undefined} />重新读取</button></div>
    {snapshot && !loading && !error && <div className="vc-blame-strip"><b>正文与作者：r{snapshot.sourceRevision}</b><span>{snapshot.encoding}</span><span>{rows.length} 行</span><select aria-label="追溯作者" value={author} onChange={event => setAuthor(event.target.value)}><option value="">所有作者</option>{[...new Set(snapshot.lines.map(line => line.author))].map(name => <option key={name} value={name}>{name || "无作者"}</option>)}</select><span className="vc-hint">点击版本号查看对应提交</span></div>}
    <div className="vc-log">
      {loading && <div className="vc-empty"><Icon name="spinner" className="animate-spin" /><span>正在读取同版本正文与逐行归属…</span></div>}
      {!loading && error && <div className="vc-alert" data-tone="warn"><span>{error}</span><button className="vc-btn" disabled={retrying} onClick={onRetry}>重试</button></div>}
      {!loading && !error && !visible.length && <div className="vc-empty">{rows.length ? "当前作者没有匹配行" : "这个版本没有可追溯的正文行"}</div>}
      {!loading && !error && <div className="vc-blame">{visible.slice(0, MAX_LINES).map(row => <div className="vc-blame-row" key={row.line}><button className="vc-blame-rev vc-btn" disabled={!onShowRevision || row.info.revision < 1} onClick={() => onShowRevision?.(row.info.revision)} title={formatRevTime(row.info.date)}>r{row.info.revision}</button><span className="vc-blame-who" title={`${row.info.author} · ${formatRevTime(row.info.date)}`}>{row.info.author || "无作者"}</span><span className="vc-blame-ln">{row.line}</span><span className="vc-blame-tx">{row.code}</span></div>)}</div>}
      {!loading && !error && visible.length > MAX_LINES && <p className="vc-hint vc-history-more">显示前 {MAX_LINES} 行，共匹配 {visible.length} 行；可按作者缩小范围</p>}
    </div>
  </section>;
}
