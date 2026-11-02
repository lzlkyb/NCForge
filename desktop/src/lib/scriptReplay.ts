import { useCallback, useState } from "react";
import { toast } from "../components/ui/toast";
import { dbApi } from "./dbApi";
import type { SqlTab } from "./dbStore";
import { runStatements, type RunOutcome, type ScriptFailure } from "./dbActions";
import { splitStatements, type Stmt } from "./sqlSplit";

/**
 * `.sql` 文件回放的状态与执行。
 *
 * 三件事不在这里做：切分（`sqlSplit`）、执行（`dbActions.runStatements`，
 * 与「执行脚本」共用生产库确认与事务状态）、落盘（导出用 `downloadText`）。
 * 这里只负责「读文件 → 定编码 → 切语句 → 逐条跑 → 记下失败」。
 *
 * 编码：UTF-8 严格解码失败才退回 GBK —— NC 现场导出的脚本多是 GBK，
 * 但用 GBK 去解 UTF-8 中文会变乱码而不报错，所以顺序必须是「先严 UTF-8」。
 */

/** 超过这个大小的脚本直接在入口拒掉：几十 MB 的文本切分 + 逐条 IPC 会卡住界面。 */
export const MAX_SCRIPT_BYTES = 10 * 1024 * 1024;

export interface ScriptFile {
  name: string;
  encoding: "UTF-8" | "GBK";
  bytes: number;
  stmts: Stmt[];
}

export interface ReplayProgress {
  /** 已完成条数。 */
  done: number;
  total: number;
  /** 正在执行的语句起始行。 */
  line: number;
  /** 正在执行的语句原文（只取首行显示）。 */
  text: string;
}

export type ReplayState =
  | { phase: "idle"; error: string | null }
  | { phase: "ready"; file: ScriptFile }
  | { phase: "running"; file: ScriptFile; progress: ReplayProgress }
  | { phase: "done"; file: ScriptFile; outcome: RunOutcome };

export function decodeScript(bytes: Uint8Array): { text: string; encoding: "UTF-8" | "GBK" } {
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  try {
    return { text: utf8.decode(bytes).replace(/^\uFEFF/, ""), encoding: "UTF-8" };
  } catch {
    return { text: new TextDecoder("gbk").decode(bytes).replace(/^\uFEFF/, ""), encoding: "GBK" };
  }
}

/** 失败语句导成可再次执行的 `.sql`：错误原因写成注释，语句本身原样保留。 */
export function failuresToSql(failures: ScriptFailure[], fileName: string): string {
  const head = `-- ${fileName}：执行失败的语句（${failures.length} 条）`;
  const blocks = failures.map((f) =>
    [
      "",
      `-- 第 ${f.index} 条（第 ${f.line} 行）：${f.error.replace(/\s+/g, " ")}`,
      `${f.text};`,
    ].join("\n"),
  );
  return `${[head, ...blocks].join("\n")}\n`;
}

export function useScriptReplay(tab: SqlTab) {
  const [state, setState] = useState<ReplayState>({ phase: "idle", error: null });
  /** 默认不忽略错误：迁移脚本里出错还继续，很容易把库改到半截状态而不自知。 */
  const [ignoreErrors, setIgnoreErrors] = useState(false);

  const pick = useCallback(async (file: File) => {
    if (file.size > MAX_SCRIPT_BYTES) {
      setState({ phase: "idle", error: `文件 ${(file.size / 1024 / 1024).toFixed(1)}MB，超过 10MB 上限` });
      return;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { text, encoding } = decodeScript(bytes);
      const stmts = splitStatements(text);
      if (stmts.length === 0) {
        setState({ phase: "idle", error: "文件里没有可执行的语句（空文件或只有注释）" });
        return;
      }
      setState({ phase: "ready", file: { name: file.name, encoding, bytes: file.size, stmts } });
    } catch (e) {
      setState({ phase: "idle", error: `读取文件失败：${String(e)}` });
    }
  }, []);

  const run = useCallback(async () => {
    if (state.phase !== "ready" && state.phase !== "done") return;
    const file = state.file;
    if (!tab.connId) {
      toast("先在工具条左边选一个连接", "warning");
      return;
    }
    setState({
      phase: "running",
      file,
      progress: { done: 0, total: file.stmts.length, line: file.stmts[0]?.startLine ?? 0, text: file.stmts[0]?.text ?? "" },
    });
    const outcome = await runStatements(
      tab.id,
      file.stmts.map((s) => ({ text: s.text, startLine: s.startLine })),
      {
        ignoreErrors,
        onProgress: (p) =>
          setState((s) => (s.phase === "running" ? { ...s, progress: p } : s)),
      },
    );
    setState({ phase: "done", file, outcome });
  }, [state, ignoreErrors, tab.id, tab.connId]);

  /** 停当前那条；后面的循环由「出错即停」收尾（忽略错误时用户可再点一次停止）。 */
  const cancel = useCallback(() => {
    if (!tab.connId) return;
    void dbApi
      .cancel(tab.connId, tab.slot)
      .catch((e) => toast(`取消失败：${String(e)}`, "error"));
  }, [tab.connId, tab.slot]);

  const reset = useCallback(() => setState({ phase: "idle", error: null }), []);

  return { state, ignoreErrors, setIgnoreErrors, pick, run, cancel, reset };
}
