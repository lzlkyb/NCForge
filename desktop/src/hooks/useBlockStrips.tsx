/**
 * 一个文件对比里的改动块标注条 + 「只看新改动」的左侧文本（按需求审查 P2）。
 *
 * 「审查改动」右侧（DiffPane）与「按需求审查」的文件分节（ReqFileSection）共用。
 * 块的身份始终是「SVN BASE → 当前」的改动块（已审标记按它存）；「只看新改动」只换左侧显示的文本。
 */
import { useMemo, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { BlockStrip, STRIP_PX, miniHeight, miniRows } from "../components/svn/BlockStrip";
import { computeChanged } from "../lib/changedLines";
import { blockOrigins } from "../lib/blockOwners";
import { blockInfos, rememberOrigins, stripState, type BlockInfo } from "../lib/blockState";
import { reviewedBase } from "../lib/reviewedBase";
import { fileIndex, reqName } from "../lib/reqGroups";
import { claimFiles } from "../lib/reqActions";
import { useRequirements, type Touch } from "../lib/requirements";
import { getReviewState, isBlockReviewed, markBlockReviewed, reviewedKey, subscribeReviewSession } from "../lib/reviewSession";
import { keyOf } from "../lib/svn";
import { useSvnDiffPrefs } from "../lib/svnDiffPrefs";
import { svnSession } from "../lib/svnSession";
import { workspaceEpoch } from "../lib/workspaceEpoch";
import { fileVersionsQuery } from "./useReqBlocks";
import type { StripSpec } from "./useDiffStrips";

const NO_TOUCHES: readonly Touch[] = [];

export interface BlockStripsResult {
  /** 对比左侧要显示的文本（开了「只看新改动」时 = BASE + 已审的块）。 */
  original: string;
  strips: StripSpec[];
  infos: BlockInfo[];
}

export function useBlockStrips({ root, path, base, working, ctxReq, disabled = false, onAllReviewed }: {
  root: string;
  path: string;
  base: string;
  working: string;
  /** 在哪个需求里审（null = 不分需求，"-" = 未认领）。 */
  ctxReq: string | null;
  disabled?: boolean;
  /** 点标注条改了已审之后：本文件是否全部块都审了（调用方据此同步文件级已审）。 */
  onAllReviewed?: (all: boolean) => void;
}): BlockStripsResult {
  const prefs = useSvnDiffPrefs(root), reqs = useRequirements(), epoch = workspaceEpoch();
  const review = useSyncExternalStore(subscribeReviewSession, getReviewState, getReviewState);
  const [mini, setMini] = useState<string | null>(null);
  const file = useMemo(() => fileIndex(reqs.view).get(keyOf(path)), [reqs.view, path]);
  const touches = file?.touches ?? NO_TOUCHES;
  const blocks = useMemo(() => { const s = computeChanged(base, working); return s.tooBig ? [] : s.blocks; }, [base, working]);
  const fv = useQuery(fileVersionsQuery(root, epoch, path, touches));
  const origins = useMemo(() => {
    const o = blockOrigins(blocks, touches, fv.data, working);
    rememberOrigins(path, blocks, o);
    return o;
  }, [blocks, touches, fv.data, working, path]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- review.reviewed 变化要重算已审 / 需重审
  const infos = useMemo(() => blockInfos(path, blocks, origins, file), [path, blocks, origins, file, review.reviewed]);
  const original = useMemo(
    () => (prefs.onlyNew ? reviewedBase(base, blocks, (b) => isBlockReviewed(path, b)) : base),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- review.reviewed 变化要重新合并已审的块
    [prefs.onlyNew, base, blocks, path, review.reviewed],
  );
  const strips = useMemo(() => {
    if (!prefs.blockStrips) return [];
    const openReqs = reqs.view.reqs.filter((r) => r.status === "open");
    const toggle = (info: BlockInfo) => {
      const next = markBlockReviewed(path, info.block);
      onAllReviewed?.(infos.every((x) => (x === info ? next : x.reviewed)));
    };
    return infos.flatMap((info): StripSpec[] => {
      if (prefs.onlyNew && info.reviewed) return [];
      const key = reviewedKey(path, info.block);
      const state = stripState(info, ctxReq);
      const open = mini === key && state === "redo";
      const node = <BlockStrip info={info} state={state} journal={reqs.view.journal.found} ctxReq={ctxReq} openReqs={openReqs}
        reqName={(id) => reqName(reqs.view, id)} miniOpen={open} disabled={disabled}
        onToggle={() => toggle(info)} onMini={() => setMini(open ? null : key)}
        onJumpReq={(id) => svnSession.set({ page: "req", reqId: id })}
        onClaim={(id) => void claimFiles([path], id)} />;
      return [{ key, afterLine: Math.max(0, info.block.startLine - 1), height: STRIP_PX + (open ? miniHeight(miniRows(info)) : 0), node }];
    });
  }, [prefs.blockStrips, prefs.onlyNew, infos, ctxReq, mini, reqs.view, path, disabled, onAllReviewed]);
  return { original, strips, infos };
}
