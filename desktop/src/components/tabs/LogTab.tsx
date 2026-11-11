import { trackOperation } from "../../lib/operations";
import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import "../../log.css";
import { Icon } from "../ui/icon";
import { LogToolbar } from "../log/LogToolbar";
import { LogSearchBar } from "../log/LogSearchBar";
import { LogList } from "../log/LogList";
import { LogDetail } from "../log/LogDetail";
import { LogContextBar } from "../log/LogContextBar";
import { DockRegion, useWorkbenchDock } from "../workspace/WorkbenchDock";
import { useViewActive } from "../../lib/viewActivity";
import { failureText } from "../../lib/friendlyError";
import { useLogSelection } from "../../hooks/useLogSelection";
import { exportSearchResult, scopeKey, useLogSearch, type SearchForm } from "../../lib/logSearch";
import {
  entryKey,
  logSources,
  queryLogs,
  sinceOf,
  type RangeKey,
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
 * 用来定位现场故障，通过应用菜单按需打开，不占主导航。
 *
 * 全文检索（`nc_log_search`）是另一个入口：按原文匹配、不看归因。两条数据源共用
 * 同一个列表与详情 —— 检索结果也是记录，选中后同样能看结论、跳源码、追 callid。
 */
export function LogTab() {
  const [filter, setFilter] = useState<Filter>(DEFAULT_FILTER);
  const selection = useLogSelection();
  const [advanced, setAdvanced] = useState(false);
  const [searchChosen, setSearchChosen] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const active = useViewActive();
  const dock = useWorkbenchDock();
  const visibleDocument = active && (dock?.documentOpen ?? true);

  const search = useLogSearch();
  const found = search.result;
  const searchMode = searchChosen || search.state.phase !== "idle";
  // 归因开关和慢 SQL 阈值不参与全文检索，不应顺带改变它的时间边界。
  const sinceTs = useMemo(() => sinceOf(filter.range), [filter.range]);

  const args = useMemo(
    () => ({
      loggers: filter.loggers.length > 0 ? filter.loggers : null,
      sinceTs,
      onlyProblems: filter.onlyProblems,
      minCostMs: filter.slowMs,
      limit: LIMIT,
    }),
    [filter, sinceTs],
  );

  /** 检索后改了时间范围 / logger：结果还在，但要提示重搜（不自动重跑，读盘不便宜）。 */
  const stale = found
    ? found.key !== scopeKey({ loggers: args.loggers, sinceTs: args.sinceTs })
    : false;

  const sourcesQ = useQuery({
    queryKey: ["nc-log-sources"],
    queryFn: logSources,
    enabled: visibleDocument,
    refetchOnWindowFocus: false,
    staleTime: 60_000,
    retry: false,
  });

  const listQ = useQuery({
    queryKey: ["nc-log", args],
    queryFn: () => queryLogs(args),
    enabled: visibleDocument && !found,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const refresh = () => void trackOperation({ key: `log.refresh:${JSON.stringify(args)}`, label: "重新读取日志", page: "logs", phase: "扫描选定的日志来源与时间范围" }, () => listQ.refetch({ cancelRefetch: false }), r => ({ state: r.error ? "failed" : "success", detail: r.error ? "日志读取失败，请查看日志页错误详情" : `扫描 ${r.data?.scannedFiles.length ?? 0} 个文件${r.data?.stoppedEarly || r.data?.truncatedFiles ? "；按上限读取，结果不完整" : ""}` })).catch(() => {});

  /** 检索结果优先：有结果时列表与详情都看命中项，清除后回到归因列表。 */
  const visible = useMemo(
    () => (found ? found.result.entries : (listQ.data?.entries ?? [])),
    [found, listQ.data],
  );
  const selectedKey = selection.entry ? entryKey(selection.entry) : null;
  const entryOutsideList = !!selection.entry && !visible.some((entry) => entryKey(entry) === selectedKey);

  const summary = (() => {
    if (found) return `检索「${found.form.query}」：命中 ${found.result.entries.length} 条`;
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

  const runSearch = (submitted?: SearchForm) => {
    void search.run({ loggers: args.loggers, sinceTs: args.sinceTs }, submitted);
  };

  return (
    <DockRegion region="document">
    <div className="lg-page">
      <LogContextBar searchMode={searchMode} onMode={value => { setSearchChosen(value); if (value) searchInput.current?.focus(); else search.clear(); }} />
      <LogToolbar
        onClose={dock?.toolTab?.onClose}
        advanced={advanced}
        onToggleAdvanced={() => setAdvanced((value) => !value)}
        sources={sourcesQ.data}
        loggers={filter.loggers}
        range={filter.range}
        onlyProblems={filter.onlyProblems}
        slowMs={filter.slowMs}
        searchMode={searchMode}
        busy={searchMode ? search.state.phase === "running" : listQ.isFetching}
        summary={summary}
        updatedAt={searchMode ? found?.updatedAt ?? null : listQ.data ? listQ.dataUpdatedAt : null}
        error={searchMode ? search.state.phase === "error" : listQ.isError}
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
        onRefresh={() => searchMode ? runSearch(found?.form) : refresh()}
      >
        <LogSearchBar
          inputRef={searchInput}
          advanced={advanced}
          form={search.form}
          state={search.state}
          stale={stale}
          onPatch={search.patch}
          onRun={() => runSearch()}
          onClear={() => { setSearchChosen(false); search.clear(); }}
          onExport={() => found && exportSearchResult(found.result, found.form)}
        />
      </LogToolbar>

      {sourcesQ.data && !sourcesQ.data.fromConfig && (
        <div className="lg-note">
          <Icon name="alert" size={13} />
          没读到 {sourcesQ.data.configPath}，下面的文件名是按目录猜的。换版本后建议核对一下。
        </div>
      )}

      <div className="lg-body">
        <div className="lg-left">
          {listQ.isError && !found ? (
            <div className="lg-error">
              <Icon name="alertTriangle" size={16} />
              <p>{failureText("读取 NC 日志", listQ.error)}</p>
              <p className="lg-empty-hint">
                日志目录：{sourcesQ.data?.logsRoot ?? "(未定位)"}；解析配置：
                {sourcesQ.data?.configPath ?? "(未定位)"}
              </p>
            </div>
          ) : listQ.isLoading && !found ? (
            <div className="lg-empty">
              <Icon name="spinner" size={16} className="lg-spin" />
              <p>正在读取日志…</p>
            </div>
          ) : (
            <LogList
              entries={visible}
              selectedKey={selectedKey}
              onSelect={selection.select}
              emptyTitle={found ? "没有记录匹配这个检索词" : undefined}
              emptyHint={
                found
                  ? "换个词、关掉「区分大小写」，或放宽时间范围和来源再试；正则模式请先确认写法后端能编译。"
                  : undefined
              }
            />
          )}
        </div>
        <LogDetail
          entry={selection.entry}
          entryOutsideList={entryOutsideList}
          trace={selection.trace}
          tracing={selection.tracing}
          onTrace={(id) => void selection.runTrace(id)}
          onSelectTrace={selection.select}
          onClearTrace={selection.clearTrace}
        />
      </div>
    </div>
    </DockRegion>
  );
}
