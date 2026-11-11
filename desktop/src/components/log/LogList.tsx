import { Icon } from "../ui/icon";
import { entryKey, entryTitle, severityMeta, type LogEntry } from "../../lib/ncLog";

/**
 * 归因条目列表。
 *
 * 每行三样东西：**结论**（而不是异常原文）、**时间 + 出处**、以及慢 SQL 的耗时。
 * 不显示 `debuglevel` 的颜色语义 —— NC 的 `$$debuglevel=ERROR` 是 logger 门限，
 * 实测后面能跟 `###udapte table success`，拿它染色会误导人。颜色只跟归因结论走。
 */
export function LogList({
  entries,
  selectedKey,
  onSelect,
  emptyTitle,
  emptyHint,
}: {
  entries: LogEntry[];
  selectedKey: string | null;
  onSelect: (entry: LogEntry) => void;
  /** 空态标题；检索模式下要换一种说法（不是「没有归因命中」而是「没匹配到」）。 */
  emptyTitle?: string;
  emptyHint?: string;
}) {
  const selectedIndex = entries.findIndex((entry) => entryKey(entry) === selectedKey);
  const tabIndex = selectedIndex < 0 ? 0 : selectedIndex;
  if (entries.length === 0) {
    return (
      <div className="lg-empty">
        <Icon name="check" size={18} />
        <p>{emptyTitle ?? "这个范围里没有命中归因的记录"}</p>
        <p className="lg-empty-hint">
          {emptyHint ??
            "在高级筛选中关闭「仅问题与慢 SQL」可以看全部原始记录；也可能是时间范围太窄，或者服务启动后还没写日志。"}
        </p>
      </div>
    );
  }

  return (
    <div className="lg-list" role="listbox" aria-label="日志记录" onKeyDown={(event) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]'));
      const current = rows.indexOf(event.target as HTMLButtonElement);
      if (current < 0) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1
        : Math.max(0, Math.min(rows.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)));
      if (next !== current) onSelect(entries[next]);
      rows[next].focus({ preventScroll: true });
      rows[next].scrollIntoView?.({ block: "nearest" });
    }}>
      {entries.map((entry, index) => {
        const key = entryKey(entry);
        const severity = entry.verdict?.severity;
        const meta = severity ? severityMeta(severity) : null;
        return (
          <button
            key={key}
            type="button"
            role="option"
            aria-selected={selectedKey === key}
            tabIndex={index === tabIndex ? 0 : -1}
            className="lg-row"
            data-sev={severity}
            data-active={selectedKey === key || undefined}
            onClick={() => onSelect(entry)}
          >
            <span className="lg-row-icon">
              {meta ? (
                <Icon name={meta.icon} size={13} />
              ) : (
                <span className="lg-row-dot" aria-hidden />
              )}
            </span>
            <span className="lg-row-main">
              <span className="lg-row-line">
                <span className="lg-row-title">{entryTitle(entry)}</span>
                {entry.costMs !== null && (
                  <span className="lg-row-cost" title="NC 自己在 warningsql 里登记的耗时">
                    {entry.costMs}ms
                  </span>
                )}
                <span className="lg-row-meta">
                  {entry.ts ?? "—"} · {entry.file}:{entry.lineNo}
                </span>
              </span>
              {entry.matchLine && (
                <span className="lg-row-match" title="命中的那一行">
                  {entry.matchLine}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
