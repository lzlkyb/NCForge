import { useCallback, useRef, useState } from "react";
import { failureText } from "./friendlyError";
import { downloadText } from "./resultExport";
import { logStamp, searchLogs, type SearchArgs, type SearchResult } from "./ncLog";

/**
 * 日志全文检索的状态与导出。
 *
 * 抽成 hook 而不是留在 `LogTab` 里，一是 [组件体量门禁]（页签本身已经不小），
 * 二是导出要用**发起检索时的关键词**：用户检索完再改输入框，导出内容不该跟着变。
 */

/** 一次最多回多少条。与后端的 `clamp(1, 5000)` 对应，取 500 兼顾可读与 IPC 负载。 */
export const SEARCH_LIMIT = 500;

export interface SearchForm {
  query: string;
  regex: boolean;
  caseSensitive: boolean;
}

/** 检索范围（时间 + logger）。`onlyProblems` / 慢 SQL 阈值是结论浏览的过滤，不参与检索。 */
export interface SearchScope {
  loggers?: string[] | null;
  sinceTs?: string | null;
  untilTs?: string | null;
}

export type LogSearchState =
  | { phase: "idle" }
  | { phase: "running"; query: string }
  | { phase: "done"; result: SearchResult; form: SearchForm; key: string; updatedAt: number }
  | { phase: "error"; message: string };

/** 范围的稳定指纹：logger 顺序不影响结果，先排序再比。 */
export function scopeKey(scope: SearchScope): string {
  return JSON.stringify({
    loggers: scope.loggers?.length ? [...scope.loggers].sort() : null,
    sinceTs: scope.sinceTs ?? null,
    untilTs: scope.untilTs ?? null,
  });
}

export function useLogSearch() {
  const [form, setForm] = useState<SearchForm>({ query: "", regex: false, caseSensitive: false });
  const [state, setState] = useState<LogSearchState>({ phase: "idle" });
  // 重新检索/失败时保留最后成功结果，避免列表和更新时间退回普通查询。
  const [result, setResult] = useState<Extract<LogSearchState, { phase: "done" }> | null>(null);
  /** 连点两次「检索」时只认最后一次的响应（上次可能更慢）。 */
  const seq = useRef(0);

  const patch = useCallback(<K extends keyof SearchForm>(k: K, v: SearchForm[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
  }, []);

  const run = useCallback(
    async (scope: SearchScope, submitted: SearchForm = form) => {
      const query = submitted.query.trim();
      if (!query) {
        setState({ phase: "error", message: "检索词不能为空" });
        return;
      }
      const snapshot: SearchForm = { query, regex: submitted.regex, caseSensitive: submitted.caseSensitive };
      const args: SearchArgs = { ...scope, ...snapshot, limit: SEARCH_LIMIT };
      const mine = (seq.current += 1);
      setState({ phase: "running", query });
      try {
        const result = await searchLogs(args);
        if (seq.current !== mine) return;
        const completed: Extract<LogSearchState, { phase: "done" }> = { phase: "done", result, form: snapshot, key: scopeKey(scope), updatedAt: Date.now() };
        setResult(completed);
        setState(completed);
      } catch (e) {
        if (seq.current !== mine) return;
        setState({ phase: "error", message: failureText("检索日志", e) });
      }
    },
    [form],
  );

  const clear = useCallback(() => {
    seq.current += 1;
    setState({ phase: "idle" });
    setResult(null);
  }, []);

  return { form, patch, state, result, run, clear };
}

function stampFile(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 命中结果导成纯文本。
 *
 * 不导 TSV：日志的记录是多行（堆栈），塞进表格会被压成一行；现场更常做的是
 * 把整段贴进工单或发给同事，所以按「一条一块」分开。
 */
export function exportSearchResult(result: SearchResult, form: SearchForm): void {
  const head = [
    "# NC 日志检索结果",
    `# 检索词：${form.regex ? `/${form.query}/` : form.query}${
      form.caseSensitive ? "（区分大小写）" : "（忽略大小写）"
    }`,
    `# 覆盖：扫了 ${result.scannedFiles.length} 个文件、${result.recordsScanned} 条记录，命中 ${result.entries.length} 条，耗时 ${result.elapsedMs}ms`,
    ...(result.truncatedFiles > 0 ? [`# ${result.truncatedFiles} 个文件太大，只读了尾部`] : []),
    ...(result.stoppedEarly ? ["# 已达条数上限，还有文件没读"] : []),
    `# 导出时间：${logStamp(new Date())}`,
  ];
  const blocks = result.entries.map((e) =>
    [
      `## ${e.file}:${e.lineNo}  ${e.ts ?? "—"}  ${e.logger}${e.callId ? `  callid=${e.callId}` : ""}`,
      ...(e.verdict ? [`结论：${e.verdict.title}`] : []),
      e.msg,
      ...e.stack,
    ].join("\n"),
  );
  const text = [head.join("\n"), ...blocks].join("\n\n");
  downloadText(`nc-log-search-${stampFile(new Date())}.txt`, `${text}\n`, "text/plain", false);
}
