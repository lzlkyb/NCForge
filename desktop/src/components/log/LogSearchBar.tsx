import { Icon } from "../ui/icon";
import type { LogSearchState, SearchForm } from "../../lib/logSearch";

/**
 * 日志检索条：在当前时间范围 / logger 里按原文找文本。
 *
 * 与上方的归因过滤刻意分开：「仅问题与慢 SQL」筛的是**结论**，检索筛的是**原文** ——
 * 想找一段报错但规则还没覆盖时，检索是唯一入口，所以它不受归因过滤影响。
 */
export function LogSearchBar({
  advanced = false,
  form,
  state,
  stale,
  onPatch,
  onRun,
  onClear,
  onExport,
}: {
  advanced?: boolean;
  form: SearchForm;
  state: LogSearchState;
  /** 检索后改了时间范围 / logger：结果还在，但要提示重搜。 */
  stale: boolean;
  onPatch: <K extends keyof SearchForm>(key: K, value: SearchForm[K]) => void;
  onRun: () => void;
  onClear: () => void;
  onExport: () => void;
}) {
  const running = state.phase === "running";
  const done = state.phase === "done" ? state : null;
  const bad = state.phase === "error" ? state.message : null;
  const hasHits = (done?.result.entries.length ?? 0) > 0;

  return (
    <div className="lg-search">
      <div className="lg-search-row">
        <Icon name="search" size={13} className="lg-search-icon" />
        <input
          className="lg-search-inp"
          value={form.query}
          placeholder="搜索报错、类名或请求编号"
          aria-label="日志检索关键词"
          spellCheck={false}
          onChange={(e) => onPatch("query", e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229 && !running && form.query.trim()) onRun();
          }}
        />
        <label hidden={!advanced} className="lg-check" title="按正则解释检索词；不合法会直接报错，不会悄悄退回字面量">
          <input
            type="checkbox"
            checked={form.regex}
            onChange={(e) => onPatch("regex", e.target.checked)}
          />
          <span>正则</span>
        </label>
        <label hidden={!advanced} className="lg-check" title="中文没有大小写，这一项只影响英文">
          <input
            type="checkbox"
            checked={form.caseSensitive}
            onChange={(e) => onPatch("caseSensitive", e.target.checked)}
          />
          <span>区分大小写</span>
        </label>
        <button
          type="button"
          className="lg-btn"
          onClick={onRun}
          disabled={running || !form.query.trim()}
        >
          <Icon name="search" size={13} className={running ? "lg-spin" : undefined} />
          检索
        </button>
        {state.phase !== "idle" && (
          <button type="button" className="lg-btn" onClick={onClear}>
            清除
          </button>
        )}
        {hasHits && (
          <button type="button" className="lg-btn" onClick={onExport}>
            <Icon name="download" size={13} />
            导出结果
          </button>
        )}
      </div>

      {bad && (
        <div className="lg-search-info" data-tone="bad" role="alert">
          <Icon name="alert" size={12} />
          {bad}
        </div>
      )}
      {done && (advanced || stale || done.result.truncatedFiles > 0 || done.result.stoppedEarly) && (
        <div className="lg-search-info" data-tone={stale ? "warn" : undefined}>
          <Icon name="search" size={12} />
          命中 {done.result.entries.length} 条 · 扫了 {done.result.scannedFiles.length} 个文件 /{" "}
          {done.result.recordsScanned} 条记录 · {done.result.elapsedMs}ms
          {done.result.truncatedFiles > 0 && ` · ${done.result.truncatedFiles} 个文件只读了尾部`}
          {done.result.stoppedEarly && " · 已达条数上限"}
          {stale && " · 时间范围或来源已变，点「检索」重搜"}
        </div>
      )}
      {!advanced && (form.regex || form.caseSensitive) && <div className="lg-search-hint">
        检索选项：{[form.regex ? "正则" : "", form.caseSensitive ? "区分大小写" : ""].filter(Boolean).join(" · ")}（可在高级筛选中调整）
      </div>}
      <div className="lg-search-hint" hidden={!advanced}>
        全文检索按原文匹配；检索期间「仅问题与慢 SQL」和「慢 SQL ≥」不筛选检索结果。时间与来源参与检索，修改后需重新检索。
      </div>
    </div>
  );
}
