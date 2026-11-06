import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "../components/ui/toast";
import { failureText } from "../lib/friendlyError";
import { useWorkspaceSelector } from "../lib/workspaceSession";
import type { ServerState, StopOutcome } from "../lib/server";

type Busy = "start" | "stop" | "restart" | null;
interface Options {
  name: string; debugMode: boolean;
  startRequest: (debug: boolean) => Promise<unknown>;
  stopRequest: () => Promise<StopOutcome>;
  refetch: () => Promise<unknown>;
  patchState: (next: ServerState) => void;
  onGeneration: () => void;
  onClearConfirm?: () => void;
  blocked?: () => boolean;
}

/** 启动与取消使用独立同步锁：准备 classpath 时仍能停止，晚到的启动答复不能回写启动中。 */
export function useServiceActions({ name, debugMode, startRequest, stopRequest, refetch, patchState, onGeneration, onClearConfirm, blocked }: Options) {
  const [busy, setBusy] = useState<Busy>(null);
  const startLock = useRef(false), stopLock = useRef(false), cancelled = useRef(false);
  const context = useRef(0), alive = useRef(true);
  const root = useWorkspaceSelector(s => s.root);
  const invalidateContext = useCallback(() => { context.current++; }, []);
  useEffect(() => { alive.current = true; invalidateContext(); setBusy(null); return () => { alive.current = false; invalidateContext(); }; }, [root, invalidateContext]);
  const run = useCallback(async (kind: "start" | "restart", debug = debugMode) => {
    if (startLock.current || stopLock.current || blocked?.()) return;
    startLock.current = true; cancelled.current = false;
    const generation = context.current;
    const valid = () => alive.current && context.current === generation;
    setBusy(kind); onClearConfirm?.();
    try {
      if (kind === "restart") {
        const outcome = await stopRequest();
        if (outcome === "cancelling") { toast("正在取消上一次启动，完成后可重新启动", "info"); return; }
      }
      if (cancelled.current || !valid()) return;
      onGeneration();
      await startRequest(debug);
      if (!valid() || cancelled.current) return;
      patchState("starting");
      toast(`${name}${kind === "restart" ? "重启" : "启动"}请求已接受，正在等待运行状态`, "info");
    } catch (e) {
      if (valid()) toast(cancelled.current || String(e).includes("CANCELLED:") ? `${name}启动已取消` : failureText(`${kind === "restart" ? "重启" : "启动"}${name}`, e), cancelled.current ? "info" : "error");
    } finally {
      startLock.current = false;
      if (valid()) { setBusy(stopLock.current ? "stop" : null); void refetch(); }
    }
  }, [blocked, debugMode, name, onClearConfirm, onGeneration, patchState, refetch, startRequest, stopRequest]);
  const stop = useCallback(async () => {
    if (stopLock.current) return;
    stopLock.current = true; cancelled.current = true;
    const generation = context.current;
    setBusy("stop"); onClearConfirm?.();
    try {
      const outcome = await stopRequest();
      if (!alive.current || context.current !== generation) return;
      if (outcome === "stopped") patchState("stopped");
      toast(outcome === "cancelling" ? `正在取消${name}启动…` : outcome === "idle" ? `${name}没有在运行` : `${name}已停止`, "info");
    } catch (e) {
      if (alive.current && context.current === generation) toast(failureText(`停止${name}`, e), "error");
    } finally {
      stopLock.current = false;
      if (alive.current && context.current === generation) { setBusy(startLock.current ? "stop" : null); void refetch(); }
    }
  }, [name, onClearConfirm, patchState, refetch, stopRequest]);
  return { busy, isPending: () => startLock.current || stopLock.current, start: (debug?: boolean) => run("start", debug), stop, restart: () => run("restart") };
}
