import { useCallback, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  clientCommandLine,
  clientRevealLog,
  clientStart,
  clientStatus,
  clientStop,
  type ClientPreview,
  type ClientStatus,
} from "../lib/client";
import type { ServerState } from "../lib/server";
import { toast } from "../components/ui/toast";
import { failureText } from "../lib/friendlyError";
import { readClientDebugModePref, writeClientDebugModePref } from "../lib/debugKeys";

type Busy = "start" | "stop" | "restart" | null;

interface Options {
  /** 面板可见：不可见时不轮询（与中间件状态同一条约定）。 */
  visible: boolean;
  appHidden: boolean;
}

/**
 * 客户端的状态轮询 + 起停命令。
 *
 * 和 `useServiceCommands` 分开而不是塞进同一个 hook：两个进程各有自己的 busy 锁，
 * 一边启动时不应该把另一边按钮也锁住。共享的只有「同帧同步锁防连点」这个模式。
 */
export function useClientService({ visible, appHidden }: Options) {
  /** 下次启动是否带 JDWP：与中间件的开关分开存（两个独立 JVM）。 */
  const [debugMode, setDebugMode] = useState(readClientDebugModePref);
  /** 每次启动 +1，让日志面板换一代（后端启动时把旧日志轮转成 .1）。 */
  const [generation, setGeneration] = useState(0);
  const bumpGeneration = useCallback(() => setGeneration((g) => g + 1), []);
  const toggleDebugMode = useCallback(() => {
    setDebugMode((prev) => {
      const next = !prev;
      writeClientDebugModePref(next);
      return next;
    });
  }, []);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["client-status"],
    queryFn: clientStatus,
    refetchInterval: appHidden || !visible ? false : 1000,
    retry: false,
  });
  const { refetch, isError, error } = query;

  const patchState = useCallback(
    (next: ServerState) => {
      queryClient.setQueryData<ClientStatus>(["client-status"], (old) =>
        old ? { ...old, state: next } : old,
      );
    },
    [queryClient],
  );

  const [busy, setBusy] = useState<Busy>(null);
  const lock = useRef(false);

  const start = useCallback(async () => {
    if (lock.current) return;
    lock.current = true;
    setBusy("start");
    try {
      await clientStart(debugMode);
      bumpGeneration();
      patchState("starting");
      toast("客户端启动请求已接受，正在准备 classpath", "success");
    } catch (e) {
      toast(failureText("启动客户端", e), "error");
      // 失败原因写进了日志：换一代才看得到（与中间件同一条处理）
      bumpGeneration();
    } finally {
      lock.current = false;
      setBusy(null);
      void refetch();
    }
  }, [bumpGeneration, debugMode, patchState, refetch]);

  const stop = useCallback(async () => {
    if (lock.current) return;
    lock.current = true;
    setBusy("stop");
    try {
      const outcome = await clientStop();
      if (outcome === "stopped") {
        patchState("stopped");
        toast("客户端已停止", "success");
      } else if (outcome === "cancelling") {
        toast("正在取消客户端启动…", "info");
      } else {
        toast("客户端没有在运行", "info");
      }
    } catch (e) {
      toast(failureText("停止客户端", e), "error");
    } finally {
      lock.current = false;
      setBusy(null);
      void refetch();
    }
  }, [patchState, refetch]);

  const restart = useCallback(async () => {
    if (lock.current) return;
    lock.current = true;
    setBusy("restart");
    try {
      const outcome = await clientStop();
      if (outcome === "cancelling") {
        toast("正在取消上一次启动，等一秒再点重启", "warning");
        return;
      }
      await clientStart(debugMode);
      bumpGeneration();
      patchState("starting");
      toast(
        outcome === "idle" ? "客户端先前已退出，本次启动请求已接受" : "重启请求已接受，正在启动客户端",
        "success",
      );
    } catch (e) {
      toast(failureText("重启客户端", e), "error");
      bumpGeneration();
    } finally {
      lock.current = false;
      setBusy(null);
      void refetch();
    }
  }, [bumpGeneration, debugMode, patchState, refetch]);

  const [preview, setPreview] = useState<ClientPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const showCommandLine = useCallback(async () => {
    setPreviewing(true);
    try {
      setPreview(await clientCommandLine());
    } catch (e) {
      toast(failureText("生成客户端命令行", e), "error");
    } finally {
      setPreviewing(false);
    }
  }, []);

  const revealLog = useCallback(() => {
    void clientRevealLog().catch((e) => toast(failureText("打开客户端日志位置", e), "error"));
  }, []);

  return {
    status: query.data ?? null,
    isError,
    error,
    refetch,
    busy,
    start,
    stop,
    restart,
    preview,
    previewing,
    showCommandLine,
    closePreview: () => setPreview(null),
    revealLog,
    debugMode,
    toggleDebugMode,
    generation,
  };
}
