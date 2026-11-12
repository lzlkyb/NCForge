import { trackOperation, updateOperation } from "../lib/operations";
import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getSession, useWorkspaceRoot } from "../lib/workspaceSession";
import { workspaceEpoch } from "../lib/workspaceEpoch";
import { getReviewedPaths, initReviewMarks, markReviewed, reviewMarksVersion, subscribeReviewMarks, syncReviewMarks } from "../lib/reviewMarks";
import {
  onSvnScanProgress,
  onSvnScanUnit,
  svnInfo,
  svnStatus,
  type ScanProgress,
  type StatusResult,
} from "../lib/svn";
import { emptyStream, reduceStream } from "../lib/svnStream";
import { syncRequirementsWithScan } from "../lib/requirements";

/** 扫描结果的说明文案：增量时把「只扫了几个模块」写出来，免得用户以为漏扫了。 */
export function describeScan(result: StatusResult | undefined): string {
  if (!result) return "扫描完成";
  if (result.incremental && result.modulesScanned === 0) return "没有模块变化，沿用上次扫描结果";
  const base = `扫描 ${result.scanned} 个条目`;
  return result.incremental ? `${base}（增量：${result.modulesScanned} 个模块）` : base;
}

/**
 * 版本控制页的状态源。
 *
 * **不轮询**：一次 `svn status` 在这个工作副本上要 7.6s（12757 个条目，只报改动），
 * 5～8 秒一轮等于让桥进程永远在扫盘，用户点任何东西都在排队。
 * 改为「进页面扫一次 + 手动刷新 + 更新/提交/撤销后自动重扫」。
 *
 */
export function useSvnStatus() {
  const root = useWorkspaceRoot() ?? "";
  const qc = useQueryClient();
  /** 本次扫描的进度（桥每扫完一个模块推一次）；null = 没有进行中的扫描。 */
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  /**
   * 流式上屏：扫描进行中陆续到达的条目（已按模块合并）。
   *
   * 只在 `status.isFetching` 期间订阅；最终结果一到就清空——之后的展示完全以
   * `status.data` 为准，流式数据绝不参与提交、草稿、冲突计数任何判断。
   */
  const [stream, reduceStreamBy] = useReducer(reduceStream, emptyStream);
  /** 已应用过的最大结果纪元：比它旧的单元事件是旧扫描的残余，直接丢。 */
  const lastResultEpoch = useRef(0);

  const info = useQuery({
    queryKey: ["svn-info", root],
    queryFn: svnInfo,
    staleTime: 30_000,
    retry: false,
    enabled: !!root,
  });

  const status = useQuery({
    queryKey: ["svn-status", root],
    queryFn: () => svnStatus(false),
    retry: false,
    enabled: !!root,
  });

  useSyncExternalStore(subscribeReviewMarks, reviewMarksVersion);
  // 需求归属跟着完整扫描走：清掉已不在改动里的文件，再同步 cc-bridge 变更日志。
  useEffect(() => { initReviewMarks(); syncReviewMarks(status.data); syncRequirementsWithScan(status.data); }, [status.data]);
  // 最终结果到达：记下纪元、清空流式缓冲区。之后的展示完全以 status.data 为准，
  // 流式数据只在扫描途中顶班（首扫时用户面对的不是空白，而是已扫到的模块）。
  useEffect(() => {
    const epoch = status.data?.epoch;
    if (typeof epoch === "number" && epoch > lastResultEpoch.current) lastResultEpoch.current = epoch;
    reduceStreamBy({ type: "reset" });
  }, [status.data]);
  const reviewed = getReviewedPaths();
  const mark = (path: string, revision: number, next: boolean) => markReviewed(path, next, revision);

  /**
   * 重扫。**返回新数据**：更新/提交之后要拿这次扫描的结论判断「有没有冲突」，
   * 以前只能再单独扫一遍（等于同一件事做两遍，多等 7.6 秒）。
   *
   * `force` = 全量。默认增量：写操作之后必须传 true——更新/提交/撤销落的是盘上的
   * 新状态，靠 watcher 标记去省这几秒，一旦漏标就是「界面显示已提交、实际没动」。
   */
  const refresh = useCallback(async (force = false): Promise<StatusResult | undefined> => {
    if (!root || getSession().root !== root) return undefined;
    const epoch = workspaceEpoch();
    // 增量/全量只是 queryFn 的参数差异，用 fetchQuery 才能带上 force；
    // refetch 永远复用缓存里的 queryFn（也就是 force=false 那一份）。
    const scan = () => force
      ? qc.fetchQuery({ queryKey: ["svn-status", root], queryFn: () => svnStatus(true), staleTime: 0, retry: false })
        .then(data => ({ data, error: null as unknown }))
        .catch((error: unknown) => ({ data: undefined, error }))
      : status.refetch({ cancelRefetch: false });
    const [, s] = await trackOperation({ key: `svn.scan:${root}`, label: "重新扫描 SVN 改动", scope: root, page: "svn", phase: "扫描工作副本条目" }, () => Promise.all([info.refetch(), scan()]), results => ({ state: results[1].error ? "failed" : "success", detail: results[1].error ? String(results[1].error) : `${describeScan(results[1].data)}${results[1].data?.hasConflict ? "；存在冲突待处理" : ""}` }));
    if (getSession().root !== root || workspaceEpoch() !== epoch) return undefined;
    // 更新 / 提交 / 撤销 / 解决冲突之后，右侧对比与追溯读的都是盘上的旧内容：
    // 不失效就会一直显示「改动前」的差异，用户以为动作没生效
    void qc.invalidateQueries({ queryKey: ["svn-diff"] });
    void qc.invalidateQueries({ queryKey: ["svn-blame"] });
    // 补丁清单读的是同一份工作副本。提交/撤销后不失效，30 秒内切到「打包补丁」
    // 还会看到已经提交掉的文件，打出来的包必然对不上这次发布。
    void qc.invalidateQueries({ queryKey: ["patch-changes"] });
    void qc.invalidateQueries({ queryKey: ["patch-scan"] });
    return s.error ? undefined : s.data;
  }, [status, info, qc, root]);

  // 扫描进度与流式条目：只在扫描进行中订阅（扫完就退订，桥那边不再推）。
  // 十几秒里界面只有一个转圈图标时，用户分不清「在跑」和「卡死」。
  useEffect(() => {
    if (!status.isFetching) {
      setScanProgress(null);
      return;
    }
    let gone = false;
    let un: (() => void) | undefined;
    const subs = [
      onSvnScanProgress((p) => { if (getSession().root !== root) return; setScanProgress(p); updateOperation(`svn.scan:${root}`, { progress: { done: p.done ?? p.scanned }, phase: p.total ? `扫描模块 ${p.done ?? 0}/${p.total}` : "扫描工作副本条目" }); }),
      // 流式上屏：一个模块的条目到了就并进视图。丢了不影响最终结果，只是那一模块
      // 要等扫描结束才出现，所以这里不做任何补偿处理。
      onSvnScanUnit((u) => { if (getSession().root !== root) return; reduceStreamBy({ type: "unit", unit: u, lastResultEpoch: lastResultEpoch.current }); }),
    ];
    void Promise.all(subs)
      .then((fns) => {
        // 订阅回来之前扫描可能已经结束了，此时立刻退订，别把监听留在窗口上
        if (gone) fns.forEach(fn => fn());
        else un = () => fns.forEach(fn => fn());
      })
      .catch(() => {
        /* 非 Tauri 环境（浏览器里跑 vite dev）没有事件通道，忽略 */
      });
    return () => {
      gone = true;
      un?.();
    };
  }, [status.isFetching, root]);

  return { info, status, reviewed, mark, refresh, scanProgress, streamed: stream.view };
}
