import { useCallback, useEffect } from "react";
import { treeRowId } from "../lib/treeNav";

/** 自动定位的防抖：连着点标签时不要每个都展开一遍。 */
const REVEAL_DELAY_MS = 120;

/**
 * 「打开文件 → 左边展开并滚到那一行」。
 *
 * 两条入口共用：自动定位（受标题栏开关控制）与显式的「在文件树中显示」事件
 * （不受开关影响——用户主动要求定位时说「你关了自动所以不给你定位」是耍赖）。
 */
export function useTreeLocate(
  reveal: (path: string) => Promise<boolean>,
  activePath: string | null,
  enabled: boolean,
  clearFilter: () => void,
) {
  /**
   * 行是异步渲染出来的：两帧之后再滚，避免「滚到了还没出现的行」。
   * 被筛掉的行定位过去等于「看不见的成功」，所以先清筛选。
   */
  const locate = useCallback(
    async (path: string | null) => {
      if (!path) return;
      clearFilter();
      if (!(await reveal(path))) return;
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          document.getElementById(treeRowId(path))?.scrollIntoView({ block: "nearest" }),
        ),
      );
    },
    [reveal, clearFilter],
  );

  useEffect(() => {
    if (!activePath || !enabled) return;
    const t = window.setTimeout(() => void locate(activePath), REVEAL_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [activePath, enabled, locate]);

  useEffect(() => {
    const h = (e: Event) => void locate((e as CustomEvent<string>).detail);
    window.addEventListener("ncforge-reveal-in-tree", h);
    return () => window.removeEventListener("ncforge-reveal-in-tree", h);
  }, [locate]);
}
