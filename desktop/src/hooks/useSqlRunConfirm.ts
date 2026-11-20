/**
 * SQL 控制台「执行前确认」的两个弹框状态：危险语句确认、绑定参数输入。
 *
 * 从 SqlConsole 拆出（2026-11-13）：两者同一个生命周期——切标签 / 换连接就必须一起丢掉，
 * 否则点头确认后语句会跑到新连接上（「拿 A 库的 DELETE 删 B 库」）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { DangerItem } from "../components/db/SqlDangerDialog";
import type { RunStmt, SqlRunMode } from "../lib/sqlEditorTarget";
import type { BoundCell } from "../lib/dbApi";
import type { Snippet } from "../lib/dbSnippets";

/** 用户确认后要跑的那一次（语句已从编辑器取出，不能等确认时再取一遍）。 */
export interface PendingRun { tabId: string; mode: SqlRunMode; stmts: RunStmt[]; collectStats: boolean }
export interface ParameterRequest { names: string[]; target: string; snippet?: Snippet; submit: (values: Map<string, BoundCell>) => void }

export function useSqlRunConfirm(tabId: string, connId: string | null | undefined) {
  /** 待确认的危险语句；非空即弹框。 */
  const [danger, setDanger] = useState<{ items: DangerItem[]; total: number } | null>(null);
  const [parameters, setParameters] = useState<ParameterRequest | null>(null);
  const pending = useRef<PendingRun | null>(null);
  // 切标签就丢掉待确认的弹框：这些语句属于上一个标签的连接。
  useEffect(() => { setDanger(null); pending.current = null; setParameters(null); }, [tabId, connId]);
  /** 拦下一次执行，弹危险语句确认框。 */
  const askDanger = useCallback((run: PendingRun, items: DangerItem[], total: number) => {
    pending.current = run;
    setDanger({ items, total });
  }, []);
  /** 用户点了「仍要执行」：取出被拦下的那一次并关框。 */
  const takeDanger = (): PendingRun | null => {
    const p = pending.current;
    pending.current = null;
    setDanger(null);
    return p;
  };
  const cancelDanger = () => { pending.current = null; setDanger(null); };
  return { danger, askDanger, takeDanger, cancelDanger, parameters, setParameters };
}
