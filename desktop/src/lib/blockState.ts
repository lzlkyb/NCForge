/**
 * 改动块的审查状态（按需求审查 P2）：把「归属」（blockOwners）与「已审 / 需重审」（reviewSession）合在一起。
 *
 * 标注条六种状态（设计稿第二节）：未审（AI）/ 已审 / 需重审 / 别的需求 / 人手改 / 来源不明。
 * 优先级：别的需求 > 已审 > 需重审 > 来源。「别的需求」排最前：那块不该在这里审，审没审都得先提醒。
 */
import type { ChangedBlock } from "./changedLines";
import { blockInReq, blockReqs, latestTouch, type BlockOrigin } from "./blockOwners";
import { isBlockReviewed, priorReview, reviewedKey, type BlockMark } from "./reviewSession";
import type { FileReqs } from "./requirements";

export type StripState = "ai" | "reviewed" | "redo" | "other" | "manual" | "unknown";

export interface BlockInfo {
  block: ChangedBlock;
  origin: BlockOrigin;
  reviewed: boolean;
  /** 同一段基线上曾经审过的那次（没审过为 null）。当前已审时也是 null。 */
  prior: BlockMark | null;
  /** 这个块算在哪些需求里（空 = 文件不属于任何需求）。 */
  reqs: string[];
}

/** `ctxReq` 为 null 或 `"-"`（未认领）时不分需求。 */
const scoped = (ctxReq: string | null): ctxReq is string => !!ctxReq && ctxReq !== "-";

export function blockInfos(path: string, blocks: readonly ChangedBlock[], origins: readonly BlockOrigin[], file: FileReqs | undefined): BlockInfo[] {
  return blocks.map((block, i) => {
    const origin = origins[i] ?? { touches: [], unknown: true, fileLevel: true };
    const reviewed = isBlockReviewed(path, block);
    return { block, origin, reviewed, prior: reviewed ? null : priorReview(path, block), reqs: blockReqs(origin, file) };
  });
}

export function inScope(info: BlockInfo, ctxReq: string | null): boolean {
  return !scoped(ctxReq) || !info.reqs.length || info.reqs.includes(ctxReq);
}

export function stripState(info: BlockInfo, ctxReq: string | null): StripState {
  if (!inScope(info, ctxReq)) return "other";
  if (info.reviewed) return "reviewed";
  if (info.prior) return "redo";
  const last = latestTouch(info.origin);
  if (!last) return "unknown";
  return last.source === "manual" ? "manual" : "ai";
}

export interface BlockStats { total: number; done: number; redo: number }
/** 在需求 `ctxReq` 里算的块：总数 / 已审 / 需重审。 */
export function statsIn(infos: readonly BlockInfo[], ctxReq: string | null): BlockStats {
  let total = 0, done = 0, redo = 0;
  for (const info of infos) {
    if (!inScope(info, ctxReq)) continue;
    total += 1;
    if (info.reviewed) done += 1;
    else if (info.prior) redo += 1;
  }
  return { total, done, redo };
}

/**
 * 最近一次算出的归属（按文件）。「已审并看下一项」「本需求全部标为已审」在列表 / 工具栏里，
 * 拿不到对比组件里的结果，从这里取。块对不上（文件又变了）就当没有。
 */
const originCache = new Map<string, { keys: string[]; origins: readonly BlockOrigin[] }>();
const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
export function rememberOrigins(path: string, blocks: readonly ChangedBlock[], origins: readonly BlockOrigin[]): void {
  originCache.set(norm(path), { keys: blocks.map((b) => reviewedKey(path, b)), origins });
  if (originCache.size > 500) originCache.delete(originCache.keys().next().value!);
}

/** 只取算在需求 `ctxReq` 里的块；不分需求或没有归属结果时返回全部。 */
export function blocksForReq(path: string, blocks: readonly ChangedBlock[], ctxReq: string | null, file: FileReqs | undefined): ChangedBlock[] {
  if (!scoped(ctxReq)) return [...blocks];
  const hit = originCache.get(norm(path));
  if (!hit || hit.keys.length !== blocks.length || blocks.some((b, i) => reviewedKey(path, b) !== hit.keys[i])) return [...blocks];
  return blocks.filter((_, i) => blockInReq(hit.origins[i], file, ctxReq));
}

/** 单测用。 */
export function resetBlockState(): void { originCache.clear(); }
