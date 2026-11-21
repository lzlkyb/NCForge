import { useCallback, useEffect, useRef, useState } from "react";
import { treeRowId } from "../lib/treeNav";
import { REVEAL_IN_TREE_EVENT } from "../lib/revealInTree";
import { prefersReducedMotion } from "../lib/motionPreference";
import { MOTION } from "../lib/motion";
import { isAppHidden } from "../lib/appVisibility";

/** 自动定位的防抖：连着点标签时不要每个都展开一遍。 */
const REVEAL_DELAY_MS = 120;

/**
 * 「打开文件 → 左边展开并滚到那一行」。
 *
 * 两条入口共用：自动定位（受标题栏开关控制）与显式的「在文件树中显示」事件
 * （不受开关影响——用户主动要求定位时说「你关了自动所以不给你定位」是耍赖）。
 */
export function useTreeLocate(
  reveal: (path: string, explicit: boolean, signal: AbortSignal) => Promise<string | null>,
  activePath: string | null,
  enabled: boolean,
  clearFilter: () => void,
) {
  const pending = useRef<AbortController>();
  const pausedFor = useRef<string | null>(null);
  const [scrollRequest, setScrollRequest] = useState<{ path: string; signal: AbortSignal }>();

  const pauseUntilFileChanges = useCallback(() => {
    pending.current?.abort();
    pausedFor.current = activePath;
  }, [activePath]);

  const locate = useCallback(
    (path: string, explicit: boolean) => {
      pending.current?.abort();
      const request = new AbortController();
      pending.current = request;
      const { signal } = request;
      const run = async () => {
        if (!path || signal.aborted || path.includes("://")) return;
        clearFilter();
        const rowPath = await reveal(path, explicit, signal);
        if (rowPath && !signal.aborted) setScrollRequest({ path: rowPath, signal });
      };
      const timer = explicit ? undefined : window.setTimeout(() => void run(), REVEAL_DELAY_MS);
      if (explicit) void run();
      return () => {
        window.clearTimeout(timer);
        request.abort();
      };
    },
    [reveal, clearFilter],
  );

  useEffect(() => {
    // 索引就绪也会更新 reveal 的引用。收起后，只有换文件或重新打开自动定位才恢复自动展开。
    if (pausedFor.current !== activePath || !enabled) pausedFor.current = null;
    if (pausedFor.current === activePath) return;
    if (!activePath || !enabled) return;
    return locate(activePath, false);
  }, [activePath, enabled, locate]);

  useEffect(() => {
    const h = (e: Event) => void locate((e as CustomEvent<string>).detail, true);
    window.addEventListener(REVEAL_IN_TREE_EVENT, h);
    return () => window.removeEventListener(REVEAL_IN_TREE_EVENT, h);
  }, [locate]);

  useEffect(() => () => pending.current?.abort(), []);

  useEffect(() => {
    // 树行提交且筛选视图恢复滚动位置后，才滚到目标行。
    if (scrollRequest && !scrollRequest.signal.aborted) {
      const row = document.getElementById(treeRowId(scrollRequest.path));
      row?.scrollIntoView({ block: "nearest" });
      if (!row || prefersReducedMotion() || isAppHidden()) return;
      row.dataset.located = "true";
      const clear = () => { window.clearTimeout(timer); delete row.dataset.located; scrollRequest.signal.removeEventListener("abort", clear); };
      const timer = window.setTimeout(clear, MOTION.enter);
      scrollRequest.signal.addEventListener("abort", clear, { once: true });
      return clear;
    }
  }, [scrollRequest]);

  return pauseUntilFileChanges;
}
