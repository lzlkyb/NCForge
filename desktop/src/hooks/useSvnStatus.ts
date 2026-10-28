import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { keyOf, reviewedSet, svnInfo, svnReviewMark, svnStatus } from "../lib/svn";

/**
 * 版本控制页的状态源。
 *
 * **不轮询**：一次 `svn status` 在这个工作副本上要 7.6s（12757 个条目，只报改动），
 * 5～8 秒一轮等于让桥进程永远在扫盘，用户点任何东西都在排队。
 * 改为「进页面扫一次 + 手动刷新 + 更新/提交/撤销后自动重扫」。
 *
 * 已审标记用「服务端有效标记 + 本地覆盖」两层合成：
 * 勾一个文件不能顺手 invalidate 整条 status 查询——那会把 7.6s 的扫描又跑一遍。
 */
export function useSvnStatus() {
  const [overrides, setOverrides] = useState<Map<string, boolean>>(() => new Map());

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

  const refresh = useCallback(() => {
    void status.refetch();
    void info.refetch();
  }, [status, info]);

  return { info, status, reviewed, mark, refresh };
}
