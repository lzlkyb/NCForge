/**
 * 按需求分组时文件行的「已审块 / 全部块」。
 *
 * 与右侧对比共用同一份 react-query 缓存（key 与 RightPane 完全一致），所以点开文件不会再拉一遍。
 * 只算传进来的文件（需求分组里的），并设上限，避免几千个改动时一次起几千个 svn diff。
 */
import { useMemo, useSyncExternalStore } from "react";
import { useQueries, type QueryClient } from "@tanstack/react-query";
import { computeChanged, type ChangedBlock } from "../lib/changedLines";
import { getReviewState, reviewedCount, subscribeReviewSession } from "../lib/reviewSession";
import { keyOf, svnDiff, type ChangeItem, type DiffResult } from "../lib/svn";
import { readFile, type FileContent } from "../lib/workspace";
import { workspaceEpoch } from "../lib/workspaceEpoch";

/** 一次最多预取多少个文件的对比；超出的文件行不显示块数（仍可点开审）。 */
export const REQ_BLOCKS_PREFETCH_LIMIT = 60;

export interface FileBlocks { blocks: ChangedBlock[]; done: number }

/** 可以按块审的文件：目录、冲突、缺失都没有可对比的内容。 */
function blockable(it: ChangeItem): boolean {
  return !it.isDir && it.letter !== "C" && it.letter !== "!";
}
const isNewFile = (it: ChangeItem) => it.letter === "?" || it.letter === "A";

/**
 * 从缓存里取一个文件的改动块（「已审并看下一项」用：右侧刚显示过对比，缓存一定在）。
 * 缓存里没有就返回空数组——只是不写块级标记，文件级已审照常。
 */
export function cachedBlocks(qc: QueryClient, root: string, it: ChangeItem): ChangedBlock[] {
  if (!blockable(it)) return [];
  const epoch = workspaceEpoch();
  const snap = isNewFile(it)
    ? (() => { const d = qc.getQueryData<FileContent>(["svn-new-file", root, epoch, it.path, it.letter, it.mtimeMs]); return d && computeChanged("", d.text); })()
    : (() => { const d = qc.getQueryData<DiffResult>(["svn-diff", root, epoch, it.path]); return d && computeChanged(d.baseText, d.workingText); })();
  return snap && !snap.tooBig ? snap.blocks : [];
}

export function useReqBlocks(root: string, items: readonly ChangeItem[]): Map<string, FileBlocks> {
  const epoch = workspaceEpoch();
  const targets = useMemo(() => items.filter(blockable).slice(0, REQ_BLOCKS_PREFETCH_LIMIT), [items]);
  const results = useQueries({
    queries: targets.map((it) => isNewFile(it)
      ? { queryKey: ["svn-new-file", root, epoch, it.path, it.letter, it.mtimeMs], queryFn: () => readFile(it.path), retry: false }
      : { queryKey: ["svn-diff", root, epoch, it.path], queryFn: () => svnDiff(it.path), retry: false }),
  });
  const review = useSyncExternalStore(subscribeReviewSession, getReviewState, getReviewState);
  // 只在对比内容变化时重算块；review 变化只重数已审数。
  const dataKey = results.map((r) => r.dataUpdatedAt).join(",");
  const blocks = useMemo(() => {
    const out = new Map<string, ChangedBlock[]>();
    targets.forEach((it, i) => {
      const data = results[i]?.data;
      if (data === undefined) return;
      const snap = "baseText" in data ? computeChanged(data.baseText, data.workingText) : computeChanged("", data.text);
      if (!snap.tooBig) out.set(keyOf(it.path), snap.blocks);
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- results 每次渲染都是新数组，用 dataKey 代表内容变化
  }, [targets, dataKey]);
  return useMemo(() => {
    const out = new Map<string, FileBlocks>();
    for (const it of targets) {
      const b = blocks.get(keyOf(it.path));
      if (b) out.set(keyOf(it.path), { blocks: b, done: reviewedCount(it.path, b) });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- review.reviewed 变化要重数
  }, [targets, blocks, review.reviewed]);
}
