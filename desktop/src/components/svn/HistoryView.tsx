import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../ui/icon";
import { EmptyState } from "../ui/EmptyState";
import { firstLine, friendlySvnError, formatRevTime, svnLog, type LogEntry } from "../../lib/svn";

const PAGE = 30;

/**
 * 历史（只读，不进审查流）。
 *
 * 分页靠 revision 游标而不是 offset：SVN 的 log 没有 offset 概念，
 * 传「上一页最后一条的 rN」继续往下翻，中途有人提交也不会错位重排。
 */
export function HistoryView({
  path,
  title,
  onBack,
}: {
  path: string;
  title: string;
  onBack: () => void;
}) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fromRef = useRef(0);
  const aliveRef = useRef(true);

  const load = useCallback(
    async (reset: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const page = await svnLog(path, PAGE, reset ? 0 : fromRef.current);
        if (!aliveRef.current) return;
        setEntries((prev) => {
          const merged = reset ? page : [...prev, ...page];
          const seen = new Set<number>();
          const out: LogEntry[] = [];
          for (const e of merged) {
            if (seen.has(e.revision)) continue;
            seen.add(e.revision);
            out.push(e);
          }
          return out;
        });
        if (page.length > 0) fromRef.current = page[page.length - 1].revision;
        setDone(page.length < PAGE);
      } catch (e) {
        if (aliveRef.current) setError(friendlySvnError(e));
      } finally {
        if (aliveRef.current) setLoading(false);
      }
    },
    [path],
  );

  useEffect(() => {
    aliveRef.current = true;
    fromRef.current = 0;
    setEntries([]);
    setDone(false);
    void load(true);
    return () => {
      aliveRef.current = false;
    };
  }, [load]);

  return (
    <section className="vc-main">
      <div className="vc-bar">
        <Icon name="history" size={14} />
        <b>历史</b>
        <span className="vc-path">{title}</span>
        <span className="vc-sp" />
        <button type="button" className="vc-btn vc-btn-sm" onClick={onBack}>
          回到差异
        </button>
        <button type="button" className="vc-btn vc-btn-sm" disabled={loading} onClick={() => void load(true)}>
          <Icon name="refresh" size={12} />
          刷新
        </button>
      </div>

      <div className="vc-log">
        {error && (
          <div style={{ padding: 12 }}>
            <div className="vc-alert" data-tone="bad">
              <Icon name="alert" size={13} />
              <span>{error}</span>
            </div>
          </div>
        )}

        {!error && entries.length === 0 && loading && (
          <div className="vc-empty">
            <Icon name="spinner" size={20} className="animate-spin" />
            <div>正在取历史…</div>
          </div>
        )}

        {!error && entries.length === 0 && !loading && (
          <EmptyState
            icon="history"
            description="这个路径还没有提交记录（新文件或未纳管目录）"
            bigIconSize={44}
            iconSize={20}
            className="py-6"
          />
        )}

        {entries.map((e) => (
          <div className="vc-log-it" key={e.revision}>
            <div className="vc-log-hd">
              <span className="vc-log-rev">r{e.revision}</span>
              <span>{e.author || "（无作者）"}</span>
              <span className="vc-hint">{formatRevTime(e.date)}</span>
            </div>
            <div className="vc-log-msg">{firstLine(e.message) || "（无提交说明）"}</div>
            {e.message.split("\n").length > 1 && (
              <details>
                <summary className="vc-hint" style={{ cursor: "pointer" }}>
                  展开完整说明
                </summary>
                <div className="vc-log-msg" style={{ marginTop: 4 }}>
                  {e.message}
                </div>
              </details>
            )}
          </div>
        ))}

        {entries.length > 0 && !done && (
          <div style={{ padding: 10, display: "flex", justifyContent: "center" }}>
            <button type="button" className="vc-btn vc-btn-sm" disabled={loading} onClick={() => void load(false)}>
              {loading ? "加载中…" : "加载更早的提交"}
            </button>
          </div>
        )}
        {entries.length > 0 && done && (
          <div className="vc-hint" style={{ padding: "10px 12px", textAlign: "center" }}>
            已经到最早一条了
          </div>
        )}
      </div>
    </section>
  );
}
