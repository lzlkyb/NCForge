import { useCallback, useEffect, useRef, useState } from "react";
import { errorToast } from "../lib/errorToast";
import { traceCall, type LogEntry, type TraceResult } from "../lib/ncLog";

/** 详情保留记录快照；追踪响应必须仍属于当前选中的请求。 */
export function useLogSelection() {
  const [entry, setEntry] = useState<LogEntry | null>(null);
  const [trace, setTrace] = useState<TraceResult | null>(null);
  const [tracing, setTracing] = useState(false);
  const selectedRef = useRef<LogEntry | null>(null);
  const sequence = useRef(0);

  useEffect(() => () => { sequence.current += 1; }, []);

  const clearTrace = useCallback(() => {
    sequence.current += 1;
    setTrace(null);
    setTracing(false);
  }, []);

  const select = useCallback((next: LogEntry) => {
    // 同一 callid 内跳转保留时间线；换请求时立即作废进行中的旧响应。
    if (selectedRef.current?.callId !== next.callId) clearTrace();
    selectedRef.current = next;
    setEntry(next);
  }, [clearTrace]);

  const runTrace = useCallback(async (callId: string) => {
    if (selectedRef.current?.callId !== callId) return;
    const mine = ++sequence.current;
    setTrace(null);
    setTracing(true);
    try {
      const result = await traceCall(callId);
      if (mine !== sequence.current || selectedRef.current?.callId !== callId) return;
      setTrace(result);
    } catch (error) {
      if (mine === sequence.current) errorToast("追踪这次请求", error);
    } finally {
      if (mine === sequence.current) setTracing(false);
    }
  }, []);

  return { entry, trace, tracing, select, runTrace, clearTrace };
}
