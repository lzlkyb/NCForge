/**
 * 按需求分组时文件行的「已审块 / 全部块」。
 *
 * 与右侧对比共用同一份 react-query 缓存（key 与 RightPane 完全一致），所以点开文件不会再拉一遍。
 * 只算传进来的文件（需求分组里的），并设上限，避免几千个改动时一次起几千个 svn diff。
 *
 * P2：混改文件（属于多个需求、没人工认领）再取版本链，按块算归属；单需求文件不用取（每块都是它）。
 * 每个文件返回逐块信息（归属 / 已审 / 需重审），界面按「当前需求」用 `statsIn` 数块。
 */
import { useMemo, useSyncExternalStore } from "react";
import { useQueries, type QueryClient } from "@tanstack/react-query";
import { computeChanged, type ChangedBlock } from "../lib/changedLines";
import { blockOrigins, fileLevelOrigins } from "../lib/blockOwners";
import { blockInfos, rememberOrigins, type BlockInfo } from "../lib/blockState";
import { fileIndex } from "../lib/reqGroups";
import { reqFileVersions, useRequirements, type FileReqs, type Touch } from "../lib/requirements";
import { getReviewState, subscribeReviewSession } from "../lib/reviewSession";
import { keyOf, svnDiff, type ChangeItem, type DiffResult } from "../lib/svn";
import { readFile, type FileContent } from "../lib/workspace";
import { workspaceEpoch } from "../lib/workspaceEpoch";

/** 一次最多预取多少个文件的对比；超出的文件行不显示块数（仍可点开审）。 */
export const REQ_BLOCKS_PREFETCH_LIMIT = 60;

export interface FileBlocks {
  blocks: ChangedBlock[];
  /** 与 blocks 一一对应。 */
  infos: BlockInfo[];
  /** 全文件已审块数（不分需求）。 */
  done: number;
}

/** 可以按块审的文件：目录、冲突、缺失都没有可对比的内容。 */
function blockable(it: ChangeItem): boolean {
  return !it.isDir && it.letter !== "C" && it.letter !== "!";
}
const isNewFile = (it: ChangeItem) => it.letter === "?" || it.letter === "A";

/** 版本链查询：触达一变（又有新写入 / 手改）就重取。没有 AI 触达的文件不取。 */
export function fileVersionsQuery(root: string, epoch: number, path: string, touches: readonly Touch[]) {
  return {
    queryKey: ["req-file-versions", root, epoch, path, touches.map((t) => `${t.seq}:${t.atMs}`).join(",")],
    queryFn: () => reqFileVersions(path),
    enabled: touches.some((t) => t.source === "ai"),
    retry: false,
    staleTime: 60_000,
  };
}

/** 这个文件是否要按块算归属。 */
export const needsBlockOrigins = (f: FileReqs | undefined): f is FileReqs =>
  !!f && !f.claimed && f.reqs.length > 1 && f.touches.some((t) => t.source === "ai");

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
  const reqs = useRequirements();
  const index = useMemo(() => fileIndex(reqs.view), [reqs.view]);
  const targets = useMemo(() => items.filter(blockable).slice(0, REQ_BLOCKS_PREFETCH_LIMIT), [items]);
  const results = useQueries({
    queries: targets.map((it) => isNewFile(it)
      ? { queryKey: ["svn-new-file", root, epoch, it.path, it.letter, it.mtimeMs], queryFn: () => readFile(it.path), retry: false }
      : { queryKey: ["svn-diff", root, epoch, it.path], queryFn: () => svnDiff(it.path), retry: false }),
  });
  const mixed = useMemo(() => targets.filter((it) => needsBlockOrigins(index.get(keyOf(it.path)))), [targets, index]);
  const versions = useQueries({ queries: mixed.map((it) => fileVersionsQuery(root, epoch, it.path, index.get(keyOf(it.path))?.touches ?? [])) });
  const review = useSyncExternalStore(subscribeReviewSession, getReviewState, getReviewState);
  // 只在对比内容变化时重算块；review 变化只重算已审 / 需重审。
  const dataKey = results.map((r) => r.dataUpdatedAt).join(",");
  const versionKey = versions.map((r) => r.dataUpdatedAt).join(",");
  const computed = useMemo(() => {
    const out = new Map<string, { blocks: ChangedBlock[]; working: string }>();
    targets.forEach((it, i) => {
      const data = results[i]?.data;
      if (data === undefined) return;
      const working = "baseText" in data ? data.workingText : data.text;
      const snap = "baseText" in data ? computeChanged(data.baseText, working) : computeChanged("", working);
      if (!snap.tooBig) out.set(keyOf(it.path), { blocks: snap.blocks, working });
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- results 每次渲染都是新数组，用 dataKey 代表内容变化
  }, [targets, dataKey]);
  const origins = useMemo(() => {
    const out = new Map<string, ReturnType<typeof fileLevelOrigins>>();
    const fvOf = new Map(mixed.map((it, i) => [keyOf(it.path), versions[i]?.data]));
    for (const it of targets) {
      const key = keyOf(it.path), c = computed.get(key);
      if (!c) continue;
      const touches = index.get(key)?.touches ?? [];
      const o = fvOf.has(key) ? blockOrigins(c.blocks, touches, fvOf.get(key), c.working) : fileLevelOrigins(c.blocks, touches);
      rememberOrigins(it.path, c.blocks, o);
      out.set(key, o);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- versions 每次渲染都是新数组，用 versionKey 代表内容变化
  }, [targets, computed, mixed, versionKey, index]);
  return useMemo(() => {
    const out = new Map<string, FileBlocks>();
    for (const it of targets) {
      const key = keyOf(it.path), c = computed.get(key);
      if (!c) continue;
      const infos = blockInfos(it.path, c.blocks, origins.get(key) ?? [], index.get(key));
      out.set(key, { blocks: c.blocks, infos, done: infos.filter((x) => x.reviewed).length });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- review.reviewed 变化要重数
  }, [targets, computed, origins, index, review.reviewed]);
}
