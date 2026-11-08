import { servicePollInterval } from "../lib/servicePolling";
import { useMemo } from "react";
import { useCallback, useState } from "react";
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
import { errorToast } from "../lib/errorToast";
import { readClientDebugModePref, writeClientDebugModePref } from "../lib/debugKeys";

import { useServiceActions } from "./useServiceActions";

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
  const pollInterval = useMemo(servicePollInterval, []);
  const query = useQuery({
    queryKey: ["client-status"],
    queryFn: clientStatus,
    refetchInterval: appHidden || !visible ? false : pollInterval,
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

  const { busy, start, stop, restart } = useServiceActions({
    name: "客户端", debugMode, startRequest: clientStart, stopRequest: clientStop,
    refetch, patchState, onGeneration: bumpGeneration,
  });
  const [preview, setPreview] = useState<ClientPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const showCommandLine = useCallback(async () => {
    setPreviewing(true);
    try {
      setPreview(await clientCommandLine());
    } catch (e) {
      errorToast("生成客户端命令行", e);
    } finally {
      setPreviewing(false);
    }
  }, []);

  const revealLog = useCallback((previous = false) => {
    void clientRevealLog(previous).catch((e) => errorToast("打开客户端日志位置", e));
  }, []);

  return {
    status: query.data ?? null,
    isError,
    error,
    refetch,
    busy,
    start: (forceDebug?: boolean) => {
      if (forceDebug !== undefined) { setDebugMode(forceDebug); writeClientDebugModePref(forceDebug); }
      return start(forceDebug);
    },
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
