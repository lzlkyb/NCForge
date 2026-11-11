import { useEffect } from "react";
import { listen } from "../../lib/tauri";
import { handleExternalJavaChanges } from "../../lib/externalJavaChanges";
import { invalidateFileIndex } from "../../lib/fileIndex";

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
    void listen<{
      dirs?: string[];
      rescan?: boolean;
      javaChanged?: string[];
      javaOverflow?: boolean;
      reviewChanged?: string[];
      reviewOverflow?: boolean;
      filesChanged?: boolean;
    }>("fs-changed", (p) => {
      refreshDirs(p?.dirs ?? [], p?.rescan === true);
      // 外部新建 / 删除 / 改名了会进清单的文件：让「转到文件」的索引作废并后台重取
      // （SVN 更新、AI、手工拷贝产生的文件）。编译写 .class 不会走到这里。
      if (p?.filesChanged === true) invalidateFileIndex();
      for (const dir of p?.dirs ?? []) changed.add(dir);
      rescan ||= p?.rescan === true;
      // 审查通道：所有外部改动的文本文件（.java/.xml/.sql/.js…）都进时间线 / 色条 / 已审角标。
      // 老后端没有 reviewChanged 时退化成 javaChanged，行为不变。
      const reviewChanged = p?.reviewChanged ?? p?.javaChanged ?? [];
      // 编译通道：外部 .java 改动走保存同一条自动编译队列（内部会挡掉本应用刚保存的文件）。
      handleExternalJavaChanges(
        p?.javaChanged ?? [],
        p?.javaOverflow === true,
        reviewChanged,
        p?.reviewOverflow === true,
      );
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
