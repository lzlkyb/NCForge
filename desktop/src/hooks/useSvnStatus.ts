import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  keyOf,
  onSvnScanProgress,
  reviewedSet,
  svnInfo,
  svnReviewMark,
  svnStatus,
  type StatusResult,
} from "../lib/svn";

/**
 * 版本控制页的状态源。
 *
 * **不轮询**：一次 `svn status` 在这个工作副本上要 7.6s（12757 个条目，只报改动），
 * 5～8 秒一轮等于让桥进程永远在扫盘，用户点任何东西都在排队。
 * 改为「进页面扫一次 + 手动刷新 + 更新/提交/撤销后自动重扫」。
 *
 *   已审标记用「服务端有效标记 + 本地覆盖」两层合成：
 * 勾一个文件不能顺手 invalidate 整条 status 查询——那会把 7.6s 的扫描又跑一遍。
 *
 * 但覆盖层只能活在「下一次扫描结果还没回来」这个窗口里：后端 `valid_marks` 会按
 * mtime/size 把已被外部修改的文件剔出有效标记（`svn_review.rs` 的原话是「比不标更
 * 危险」），前端若让覆盖层跨刷新长期有效，Eclipse 改过的文件回工作台点「刷新」仍
 * 显示「已审」，用户据此跳过审查直接提交。因此每次扫描结果一到就清空覆盖层。
 */
export function useSvnStatus() {
  const [overrides, setOverrides] = useState<Map<string, boolean>>(() => new Map());
  /** 本次扫描已走过的条目数（桥每 300 条推一次）；null = 没有进行中的扫描。 */
  const [scanProgress, setScanProgress] = useState<number | null>(null);

  const info = useQuery({
    queryKey: ["svn-info"],
    queryFn: svnInfo,
    staleTime: 30_000,
    retry: false,
  });

  const status = useQuery({
    queryKey: ["svn-status"],
    queryFn: svnStatus,
    retry: false,
  });

  /** 每次新扫描结果落地就作废覆盖层，让后端标记成为唯一真相。 */
  const scannedAt = status.dataUpdatedAt;
  useEffect(() => {
    setOverrides(new Map());
  }, [scannedAt]);

  const reviewed = useMemo(() => {
    const set = reviewedSet(status.data);
    for (const [k, on] of overrides) {
      if (on) set.add(k);
      else set.delete(k);
    }
    return set;
  }, [status.data, overrides]);

  const mark = useCallback(async (path: string, revision: number, next: boolean) => {
    await svnReviewMark(path, revision, next);
    setOverrides((prev) => {
      const m = new Map(prev);
      m.set(keyOf(path), next);
      return m;
    });
  }, []);

  /**
   * 重扫。**返回新数据**：更新/提交之后要拿这次扫描的结论判断「有没有冲突」，
   * 以前只能再单独扫一遍（等于同一件事做两遍，多等 7.6 秒）。
   */
  const refresh = useCallback(async (): Promise<StatusResult | undefined> => {
    const [, s] = await Promise.all([info.refetch(), status.refetch()]);
    return s.data;
  }, [status, info]);

  // 扫描进度：只在扫描进行中订阅（扫完就退订，桥那边不再推）。
  // 7.6 秒里界面只有一个转圈图标时，用户分不清「在跑」和「卡死」。
  useEffect(() => {
    if (!status.isFetching) {
      setScanProgress(null);
      return;
    }
    let gone = false;
    let un: (() => void) | undefined;
    void onSvnScanProgress((n) => setScanProgress(n))
      .then((fn) => {
        // 订阅回来之前扫描可能已经结束了，此时立刻退订，别把监听留在窗口上
        if (gone) fn();
        else un = fn;
      })
      .catch(() => {
        /* 非 Tauri 环境（浏览器里跑 vite dev）没有事件通道，忽略 */
      });
    return () => {
      gone = true;
      un?.();
    };
  }, [status.isFetching]);

  return { info, status, reviewed, mark, refresh, scanProgress };
}
