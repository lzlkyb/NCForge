/**
 * 改动块归属（按需求审查 P2）：当前文件的每个改动块是哪几次写入带进来的。纯函数，不碰 Tauri。
 *
 * 原料：cc-bridge 变更日志里每次 AI 写入前的内容（后端 `req_file_versions` 从备份还原）与写入前后的 sha256。
 * 算法：
 * 1. 串版本链：第 i 次写入后的内容 = 第 i+1 次写入前的内容（哈希对得上时），最后一次对当前内容。
 *    对不上的地方是「空档」：两次写入之间有人手改 / 别的工具改过，归给空档里的触达（没有就是来源不明）。
 * 2. 逐步做行级 diff，把「这一行是哪一步带进来的」传到下一版；被删掉的行留一个「墓碑」挂在行间，
 *    这样纯删除的改动块也知道是谁删的。
 * 3. 对当前文件相对 SVN BASE 的每个改动块，收集块内行与行间墓碑的来源。
 *
 * 口径：
 * - 版本链起点（第一次有内容的写入之前）就已经和 BASE 不同的行，归给更早的触达，没有就是来源不明。
 * - 只有空白 / 括号之类的行不参与归属（除非整块都是这种行）：LCS 对孤零零的 `}` 对齐方式不唯一，
 *   会把一个 AI 块误拉上「来源不明」。
 * - 任何一步超过 diff 上限、或一个还原得出的版本都没有：退回文件级（整个文件的触达算每个块的来源）。
 */
import { diffLines } from "./textDiff";
import { normalizeEol, type ChangedBlock } from "./changedLines";
import type { FileReqs, Touch } from "./requirements";

/** 后端 `req_file_versions` 的返回。 */
export interface FileVersions {
  workingSha: string | null;
  versions: { seq: number; text: string | null }[];
  /** NCForge 本地历史里哈希对得上的内容（保存前归档 = 上一次 AI 写入后的内容）。 */
  known?: { sha: string; text: string }[];
}

/** 一个改动块的来源：带进这些行的触达；`unknown` = 有行说不清是谁改的。 */
export interface BlockOrigin {
  touches: Touch[];
  unknown: boolean;
  /** true = 退回了文件级（没能逐行归属）。 */
  fileLevel: boolean;
}

interface Owner { touches: Touch[] }
interface Step { text: string; owner: number }
export interface Chain { start: string; startOwner: number; steps: Step[]; owners: Owner[] }

const sameSha = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * 串版本链。`working` 是当前内容（与对比右侧同一份）。一个还原得出的版本都没有返回 null。
 */
export function buildChain(touches: readonly Touch[], fv: FileVersions, working: string): Chain | null {
  const textOf = new Map(fv.versions.map((v) => [v.seq, v.text]));
  const ai = touches.filter((t) => t.source === "ai").sort((a, b) => a.seq - b.seq);
  const chain = ai.filter((t) => textOf.get(t.seq) != null);
  if (!chain.length) return null;
  const inChain = new Set(chain);
  const owners: Owner[] = [];
  const own = (list: Touch[]) => { owners.push({ touches: list }); return owners.length - 1; };
  /** 两个链上节点之间（不含端点）的其它触达：AI 按序号、手改按时间。 */
  const between = (a: Touch | null, b: Touch | null) => touches.filter((t) => {
    if (inChain.has(t)) return false;
    if (t.source === "ai") return (!a || t.seq > a.seq) && (!b || t.seq < b.seq);
    return (!a || t.atMs >= a.atMs) && (!b || t.atMs <= b.atMs);
  });
  const work = normalizeEol(working);
  const textAt = (t: Touch) => normalizeEol(textOf.get(t.seq) ?? "");
  const steps: Step[] = [];
  chain.forEach((t, i) => {
    const next = chain[i + 1] ?? null;
    const target = next ? textAt(next) : work;
    const gap = between(t, next);
    let after: string | null = null;
    if (next && sameSha(t.afterSha, next.beforeSha)) after = target;
    else if (!next && sameSha(t.afterSha, fv.workingSha)) after = work;
    else {
      // 中间被手改过：在 NCForge 里保存时，保存前的内容（= 这次写入后）进了本地历史
      const hit = fv.known?.find((k) => sameSha(k.sha, t.afterSha));
      if (hit) after = normalizeEol(hit.text);
    }
    if (after === null) {
      // 写入后的内容还原不出来：这次写入与空档里的改动合成一步，来源两边都算。
      steps.push({ text: target, owner: own([t, ...gap]) });
      return;
    }
    steps.push({ text: after, owner: own([t]) });
    if (after !== target) steps.push({ text: target, owner: own(gap) });
  });
  return { start: textAt(chain[0]), startOwner: own(between(null, chain[0])), steps, owners };
}

export interface LineOrigins {
  /** 当前每一行（0 基）的来源编号。 */
  lines: number[];
  /** 行间墓碑：gaps[k] = 第 k 行之前（0 基）被删掉的行的来源；gaps[行数] 在文件尾。 */
  gaps: number[][];
}

const uniq = (a: number[]) => (a.length > 1 ? [...new Set(a)] : a);

/** 逐步传递每行的来源。任何一步 diff 超限返回 null。 */
export function lineOrigins(chain: Chain): LineOrigins | null {
  let tags = chain.start.split("\n").map(() => chain.startOwner);
  let gaps: number[][] = Array.from({ length: tags.length + 1 }, () => []);
  let prev = chain.start;
  for (const step of chain.steps) {
    if (step.text === prev) continue;
    const r = diffLines(prev, step.text);
    if (r.tooBig) return null;
    const nt: number[] = [], ng: number[][] = [];
    let pending: number[] = [];
    for (const row of r.rows) {
      if (row.op === "add") { ng.push(uniq(pending)); pending = []; nt.push(step.owner); continue; }
      const o = (row.oldLine ?? 1) - 1;
      pending.push(...gaps[o]);
      if (row.op === "del") { pending.push(step.owner); continue; }
      ng.push(uniq(pending)); pending = []; nt.push(tags[o]);
    }
    pending.push(...gaps[tags.length]);
    ng.push(uniq(pending));
    tags = nt; gaps = ng; prev = step.text;
  }
  return { lines: tags, gaps };
}

const TRIVIAL = /^[\s{}()[\];,]*$/;

/** 把行级来源映射到改动块上。 */
export function originsOfBlocks(blocks: readonly ChangedBlock[], chain: Chain, lo: LineOrigins): BlockOrigin[] {
  return blocks.map((b) => {
    const meaningful: number[] = [], trivial: number[] = [];
    for (let line = b.startLine; line <= b.endLine; line++) {
      const tag = lo.lines[line - 1];
      if (tag === undefined) continue;
      (TRIVIAL.test(b.currentLines[line - b.startLine] ?? "") ? trivial : meaningful).push(tag);
    }
    if (b.removed > 0) {
      for (let g = b.startLine - 1; g <= Math.max(b.endLine, b.startLine - 1); g++) meaningful.push(...(lo.gaps[g] ?? []));
    }
    const tags = new Set(meaningful.length ? meaningful : trivial);
    const touches: Touch[] = [];
    let unknown = tags.size === 0;
    for (const tag of tags) {
      const list = chain.owners[tag]?.touches ?? [];
      if (!list.length) unknown = true;
      for (const t of list) if (!touches.includes(t)) touches.push(t);
    }
    return { touches, unknown, fileLevel: false };
  });
}

/** 退回文件级：整个文件的触达都算每个块的来源。 */
export function fileLevelOrigins(blocks: readonly ChangedBlock[], touches: readonly Touch[]): BlockOrigin[] {
  return blocks.map(() => ({ touches: [...touches], unknown: touches.length === 0, fileLevel: true }));
}

/** 一步到位：有版本就逐行归属，否则退回文件级。 */
export function blockOrigins(blocks: readonly ChangedBlock[], touches: readonly Touch[], fv: FileVersions | null | undefined, working: string): BlockOrigin[] {
  if (!blocks.length) return [];
  const chain = fv ? buildChain(touches, fv, working) : null;
  const lo = chain && lineOrigins(chain);
  return chain && lo ? originsOfBlocks(blocks, chain, lo) : fileLevelOrigins(blocks, touches);
}

/**
 * 这个块是否算在需求 `reqId` 里审。
 * - 人工认领的文件：整个文件都算认领的需求。
 * - 块的来源里有本文件所属的需求：只算这些需求。
 * - 说不清（来源不明 / AI 未声明 / 归属需求已关闭）：本文件的每个需求里都算，宁可多审一遍也不漏。
 */
export function blockReqs(origin: BlockOrigin, file: FileReqs | undefined): string[] {
  const fileReqs = file?.reqs ?? [];
  if (file?.claimed) return fileReqs;
  const ids = [...new Set(origin.touches.map((t) => t.req).filter((id): id is string => !!id && fileReqs.includes(id)))];
  return ids.length ? ids : fileReqs;
}
export function blockInReq(origin: BlockOrigin, file: FileReqs | undefined, reqId: string): boolean {
  const ids = blockReqs(origin, file);
  return !ids.length || ids.includes(reqId);
}

/** 标注条展示用：来源里最近的一次触达。 */
export function latestTouch(origin: BlockOrigin): Touch | null {
  return origin.touches.reduce<Touch | null>((m, t) => (!m || t.atMs >= m.atMs ? t : m), null);
}
