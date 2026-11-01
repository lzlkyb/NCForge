import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import "../../log.css";
import { Icon } from "../ui/icon";
import { toast } from "../ui/toast";
import { LogToolbar } from "../log/LogToolbar";
import { LogList } from "../log/LogList";
import { LogDetail } from "../log/LogDetail";
import { failureText } from "../../lib/friendlyError";
import {
  entryKey,
  logSources,
  queryLogs,
  sinceOf,
  traceCall,
  type LogEntry,
  type RangeKey,
  type TraceResult,
} from "../../lib/ncLog";

/** 一次最多回多少条。再多人也看不过来，而且 IPC 负载会明显变大。 */
const LIMIT = 300;

interface Filter {
  loggers: string[];
  range: RangeKey;
  onlyProblems: boolean;
  slowMs: number;
}

/**
 * 默认 7 天而不是「最近 1 小时」：NC 开发机上的日志经常是上次启动（可能前两天）
 * 留下的，一进来空列表会让人以为功能坏了。慢 SQL 阈值 1000ms 是 NC 自己
 * warningsql 里常见量级（实测 7~1274ms），太低会全是噪音。
 */
const DEFAULT_FILTER: Filter = { loggers: [], range: "7d", onlyProblems: true, slowMs: 1000 };

/**
 * NC 日志页：把 `nclogs/` 里的记录**归因**成「这是什么问题 + 该看哪里」。
 *
 * 与「NC 服务」页底部那块日志面板的区别：那块抓的是我们启动中间件时的 stdout，
 * 是给人看进程活没活的；这一页读的是 NC 自己按 logger 写的 `nclogs/`，
 * 用来定位现场故障。两个不是一回事，所以是独立页签。
 *
 * 为什么不在这里做「全文检索」：工程搜索已经覆盖源码，日志检索的价值在**结论**，
 * 不在把 5MB 原文铺出来。所以列表里只有命中的条目，没命中的要看就关掉过滤。
 */
export function LogTab() {
  const [filter, setFilter] = useState<Filter>(DEFAULT_FILTER);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [trace, setTrace] = useState<TraceResult | null>(null);
  const [tracing, setTracing] = useState(false);
  /** 手动刷新计数：进 queryKey 触发重查，比 invalidate 更好读。 */
  const [nonce, setNonce] = useState(0);

  const args = useMemo(
    () => ({
      loggers: filter.loggers.length > 0 ? filter.loggers : null,
      sinceTs: sinceOf(filter.range),
      onlyProblems: filter.onlyProblems,
      minCostMs: filter.slowMs,
      limit: LIMIT,
    }),
    [filter],
  );

  const sourcesQ = useQuery({
    queryKey: ["nc-log-sources"],
    queryFn: logSources,
    staleTime: 60_000,
    retry: false,
  });

  const listQ = useQuery({
    queryKey: ["nc-log", args, nonce],
    queryFn: () => queryLogs(args),
    refetchOnWindowFocus: false,
    retry: false,
  });

  const entries = listQ.data?.entries ?? [];
  // 选中项按 `文件:行号` 存：刷新后还能定位回同一条，换成下标会指错。
  // 依赖写 `listQ.data` 而不是 `entries`：后者是 `?? []` 造出来的新数组，
  // 每次渲染都换引用，写进依赖会让这个 useMemo 每拍重算（eslint 也会报）。
  const selected = useMemo(
    () => (listQ.data?.entries ?? []).find((e) => entryKey(e) === selectedKey) ?? null,
    [listQ.data, selectedKey],
  );

  const onSelect = (entry: LogEntry) => setSelectedKey(entryKey(entry));

  const onTrace = async (callId: string) => {
    setTracing(true);
    try {
      setTrace(await traceCall(callId));
    } catch (e) {
      toast(failureText("追踪这次请求", e), "error");
    } finally {
      setTracing(false);
    }
  };

  const summary = (() => {
    if (listQ.isError) return "读取失败";
    if (!listQ.data) return "正在读取日志…";
    const d = listQ.data;
    const parts = [
      `扫了 ${d.scannedFiles.length} 个文件`,
      `${d.recordsScanned} 条记录`,
      `命中 ${d.entries.length} 条`,
      `${d.elapsedMs}ms`,
    ];
    if (d.truncatedFiles > 0) parts.push(`${d.truncatedFiles} 个文件只读了尾部`);
    if (d.stoppedEarly) parts.push("已达条数上限");
    return parts.join(" · ");
  })();

  return (
    <div className="lg-page">
      <LogToolbar
        sources={sourcesQ.data}
        loggers={filter.loggers}
        range={filter.range}
        onlyProblems={filter.onlyProblems}
        slowMs={filter.slowMs}
        busy={listQ.isFetching}
        summary={summary}
        onToggleLogger={(name) =>
          setFilter((f) => ({
            ...f,
            loggers: f.loggers.includes(name)
              ? f.loggers.filter((n) => n !== name)
              : [...f.loggers, name],
          }))
        }
        onClearLoggers={() => setFilter((f) => ({ ...f, loggers: [] }))}
        onRange={(range) => setFilter((f) => ({ ...f, range }))}
        onOnlyProblems={(onlyProblems) => setFilter((f) => ({ ...f, onlyProblems }))}
        onSlowMs={(slowMs) => setFilter((f) => ({ ...f, slowMs }))}
        onRefresh={() => setNonce((n) => n + 1)}
      />

      {sourcesQ.data && !sourcesQ.data.fromConfig && (
        <div className="lg-note">
          <Icon name="alert" size={13} />
          没读到 {sourcesQ.data.configPath}，下面的文件名是按目录猜的。换版本后建议核对一下。
        </div>
      )}

      <div className="lg-body">
        <div className="lg-left">
          {listQ.isError ? (
            <div className="lg-error">
              <Icon name="alertTriangle" size={16} />
              <p>{failureText("读取 NC 日志", listQ.error)}</p>
              <p className="lg-empty-hint">
                日志目录：{sourcesQ.data?.logsRoot ?? "(未定位)"}；解析配置：
                {sourcesQ.data?.configPath ?? "(未定位)"}
              </p>
            </div>
          ) : listQ.isLoading ? (
            <div className="lg-empty">
              <Icon name="spinner" size={16} className="lg-spin" />
              <p>正在读取日志…</p>
            </div>
          ) : (
            <LogList entries={entries} selectedKey={selectedKey} onSelect={onSelect} />
          )}
        </div>
        <LogDetail
          entry={selected}
          trace={trace}
          tracing={tracing}
          onTrace={(id) => void onTrace(id)}
          onSelectTrace={onSelect}
          onClearTrace={() => setTrace(null)}
        />
      </div>
    </div>
  );
}
