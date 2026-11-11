import { useId, type ReactNode } from "react";
import { Icon } from "../ui/icon";
import { FreshnessBadge } from "../ui/FreshnessBadge";
import { LogSourcePicker } from "./LogSourcePicker";
import {
  TIME_RANGES,
  type RangeKey,
  type SourceInfo,
} from "../../lib/ncLog";

/**
 * 日志页顶部：结论覆盖面 + 过滤条 + logger 切换。
 *
 * 常用来源及已选项直接展示，其余来源通过带搜索的菜单多选。
 * 「全部」是默认态，点任意 chip 就变成白名单。
 */
export function LogToolbar({
  advanced,
  onToggleAdvanced,
  sources,
  loggers,
  range,
  onlyProblems,
  slowMs,
  busy,
  summary,
  updatedAt,
  error,
  searchMode = false,
  onToggleLogger,
  onClearLoggers,
  onRange,
  onOnlyProblems,
  onSlowMs,
  onRefresh,
  children,
  onClose,
}: {
  advanced: boolean;
  onToggleAdvanced: () => void;
  sources: SourceInfo | undefined;
  loggers: string[];
  range: RangeKey;
  onlyProblems: boolean;
  slowMs: number;
  busy: boolean;
  summary: string;
  /** 上次成功读取的时间；null = 还没读到过。 */
  updatedAt: number | null;
  error: boolean;
  searchMode?: boolean;
  onToggleLogger: (name: string) => void;
  onClearLoggers: () => void;
  onRange: (range: RangeKey) => void;
  onOnlyProblems: (value: boolean) => void;
  onSlowMs: (ms: number) => void;
  onRefresh: () => void;
  /** 检索条等：放在同一个头部容器里，才不会多出一条多余的边框。 */
  children?: ReactNode;
  onClose?: () => void;
}) {
  const groups = sources?.loggers ?? [];
  const advancedId = useId();
  const filterHint = [loggers.length ? `${loggers.length} 个来源` : "", !onlyProblems ? "含普通记录" : "", slowMs !== 1000 ? `慢 SQL ≥ ${slowMs}ms` : ""].filter(Boolean).join(" · ");
  return (
    <div className="lg-head-wrap">
      <div className="lg-head">
        <h1>日志排查</h1>
        <span className="lg-sub" title={summary}>{summary}</span>
        <FreshnessBadge
          state={busy ? "loading" : error ? "error" : "live"}
          at={updatedAt}
          label={searchMode ? "检索结果" : "日志"}
          staleAfterMs={120_000}
          onRefresh={onRefresh}
        />
        <span className="lg-sp" />
        <label className="lg-field">
          <span>时间</span>
          <select value={range} onChange={(e) => onRange(e.target.value as RangeKey)}>
            {TIME_RANGES.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="lg-btn" aria-expanded={advanced} aria-controls={advancedId}
          onClick={onToggleAdvanced} title={filterHint || "来源、慢 SQL 阈值与原始记录"}>
          高级筛选{filterHint && <span> · 已设置</span>}<Icon name="chevronDown" size={12} />
        </button>
        <button type="button" className="lg-btn" onClick={onRefresh} disabled={busy}>
          <Icon name="refresh" size={14} className={busy ? "lg-spin" : undefined} />
          {searchMode ? "重新检索" : "刷新"}
        </button>
        {onClose && <button type="button" className="lg-btn" aria-label="关闭日志排查" title="关闭日志排查" onClick={onClose}><Icon name="close" size={13}/></button>}
      </div>

      <div className="lg-filter-summary" role="status">
        {searchMode ? "检索范围" : "当前筛选"}：{TIME_RANGES.find(r => r.key === range)?.label} · {loggers.length ? loggers.join("、") : "全部来源"}
        {!searchMode && <> · {onlyProblems ? "仅问题与慢 SQL" : "包含普通记录"} · 慢 SQL ≥ {slowMs}ms</>}
      </div>

      <div id={advancedId} hidden={!advanced}>
      <div className="lg-head">
        <label className="lg-field" title="warningsql 里 NC 自己登记的耗时超过这个值才算慢 SQL">
          <span>慢 SQL ≥</span>
          <input
            type="number"
            min={0}
            step={100}
            value={slowMs}
            onChange={(e) => onSlowMs(Math.max(0, Number(e.target.value) || 0))}
          />
          <span className="lg-unit">ms</span>
        </label>
        <label className="lg-check" title="只显示归因命中的记录（含慢 SQL），过滤掉普通信息">
          <input
            type="checkbox"
            checked={onlyProblems}
            onChange={(e) => onOnlyProblems(e.target.checked)}
          />
          <span>仅问题与慢 SQL</span>
        </label>
      </div>

      <LogSourcePicker groups={groups} loggers={loggers} onToggle={onToggleLogger} onClear={onClearLoggers} />
      </div>

      {children}
    </div>
  );
}
