import { Icon } from "../ui/icon";
import {
  TIME_RANGES,
  formatSize,
  type RangeKey,
  type SourceInfo,
} from "../../lib/ncLog";

/**
 * 日志页顶部：结论覆盖面 + 过滤条 + logger 切换。
 *
 * logger 用横向滚动的 chip 而不是下拉多选：NC 有 49 个 logger，但真正有人看的就那几个
 * （nc / warningsql / metadata / pfxx），chip 上还能直接看到「最最近写过」的顺序。
 * 「全部」是默认态，点任意 chip 就变成白名单。
 */
export function LogToolbar({
  sources,
  loggers,
  range,
  onlyProblems,
  slowMs,
  busy,
  summary,
  onToggleLogger,
  onClearLoggers,
  onRange,
  onOnlyProblems,
  onSlowMs,
  onRefresh,
}: {
  sources: SourceInfo | undefined;
  loggers: string[];
  range: RangeKey;
  onlyProblems: boolean;
  slowMs: number;
  busy: boolean;
  summary: string;
  onToggleLogger: (name: string) => void;
  onClearLoggers: () => void;
  onRange: (range: RangeKey) => void;
  onOnlyProblems: (value: boolean) => void;
  onSlowMs: (ms: number) => void;
  onRefresh: () => void;
}) {
  const groups = sources?.loggers ?? [];
  return (
    <div className="lg-head-wrap">
      <div className="lg-head">
        <h1>NC 日志</h1>
        <span className="lg-sub">{summary}</span>
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
          <span>只看有结论的</span>
        </label>
        <button type="button" className="lg-btn" onClick={onRefresh} disabled={busy}>
          <Icon name="refresh" size={14} className={busy ? "lg-spin" : undefined} />
          刷新
        </button>
      </div>

      <div className="lg-chips" role="group" aria-label="日志来源">
        <button
          type="button"
          className="lg-chip"
          data-on={loggers.length === 0 || undefined}
          onClick={onClearLoggers}
        >
          全部
          <span className="lg-chip-n">{groups.length}</span>
        </button>
        {groups.map((g) => (
          <button
            key={g.name}
            type="button"
            className="lg-chip"
            data-on={loggers.includes(g.name) || undefined}
            data-idle={g.newestMs === 0 || undefined}
            title={`${g.files.length} 个文件 · ${formatSize(g.totalSize)}${
              g.level ? ` · 门限 ${g.level}` : ""
            }`}
            onClick={() => onToggleLogger(g.name)}
          >
            {g.name}
            <span className="lg-chip-n">{g.files.length}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
