import { Icon } from "../ui/icon";
import { formatBytes } from "../../lib/serverLog";

interface Props {
  count: number; size: number; previous: boolean; onPrevious: (previous: boolean) => void;
  start: number; end: number; historical: boolean; updatedAt: number | null; active: boolean;
  hasOlder: boolean; readingOlder: boolean; onOlder: () => void; onLatest: () => void; onReveal: () => void;
}
export function ServiceLogFooter({ count, size, previous, onPrevious, start, end, historical, updatedAt, active, hasOlder, readingOlder, onOlder, onLatest, onReveal }: Props) {
  const freshness = historical ? '回看历史片段' : previous ? '上次运行 · 不跟随' : !active ? '本次运行已结束' : updatedAt ? `最新输出 ${Math.max(0, Math.floor((Date.now() - updatedAt) / 1000))} 秒前` : '等待输出';
  return <div className="sc-log-footer">
    <span title={`已加载 ${count} 行；缓存最多4000行/约8MiB文本。当前读取字节范围 ${start}–${end}，完整内容在磁盘日志文件中。`}>已加载 {count} 行</span>
    <button type="button" className="sc-log-file-size" title={previous ? "打开上次运行日志位置" : "打开本次运行日志位置"} onClick={onReveal}>文件 {formatBytes(size)}</button>
    <select aria-label="选择运行日志" value={previous ? 'previous' : 'current'} onChange={event => onPrevious(event.target.value === 'previous')}><option value="current">本次运行</option><option value="previous">上次运行</option></select>
    {hasOlder && <button type="button" className="sc-log-button" disabled={readingOlder} onClick={onOlder}>{readingOlder ? <Icon name="spinner" size={11} className="animate-spin" /> : <Icon name="arrowUp" size={11} />}{readingOlder ? '读取中' : '更早'}</button>}
    {historical && <button type="button" className="sc-log-button" onClick={onLatest}>回到最新</button>}
    <span className="sc-log-spacer" /><span className="sc-log-freshness" title={freshness}>{freshness}</span>
  </div>;
}
