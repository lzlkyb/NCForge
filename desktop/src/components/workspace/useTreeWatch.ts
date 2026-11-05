import { useEffect } from "react";
import { listen } from "../../lib/tauri";

/** Directory rows refresh immediately. Package indexing coalesces bursts of file events. */
export function useTreeWatch(
  refreshDirs: (paths: string[], rescan: boolean) => void,
  invalidate: (paths: string[], rescan: boolean, eager: boolean) => void,
  packageView: boolean,
) {
  // 订阅后端的文件监听。注册是异步的，组件可能在它回来前就卸载：
  // 用 disposed 兜住，否则监听会挂在已卸载的组件上。
  useEffect(() => {
    let disposed = false;
    let off: (() => void) | undefined;
    let indexRefresh: ReturnType<typeof setTimeout> | undefined;
    const changed = new Set<string>();
    let rescan = false;
    void listen<{ dirs?: string[]; rescan?: boolean }>("fs-changed", (p) => {
      refreshDirs(p?.dirs ?? [], p?.rescan === true);
      for (const dir of p?.dirs ?? []) changed.add(dir);
      rescan ||= p?.rescan === true;
      clearTimeout(indexRefresh);
      indexRefresh = setTimeout(() => {
        invalidate([...changed], rescan, packageView);
        changed.clear();
        rescan = false;
      }, 180);
    })
      .then((u) => {
        if (disposed) u();
        else off = u;
      })
      .catch(() => {
        // 注册失败（如纯浏览器调试）：退化为手动刷新，不影响树本身
      });
    return () => {
      disposed = true;
      clearTimeout(indexRefresh);
      off?.();
    };
  }, [refreshDirs, invalidate, packageView]);
}
