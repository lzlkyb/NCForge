/**
 * 「这一轮」的基线文本：复用本地历史的归档点（原字节、GBK 安全），不新增快照引擎。
 *
 * 修 P1-1 / P1-3：
 * - 选中一轮后，代码面色条改成 diff(该轮前原文, 当前模型)，而不是 diff(SVN BASE, 当前模型)；
 * - 「比较选中两点」真的取两点各自的原文，取不到就明确标注退化为 SVN 基线 / 磁盘当前内容，
 *   不再让文案承诺「这之间的改动」而实际和单条「比较」完全一样。
 *
 * 本地历史版本是「写盘前」归档的，所以 ts < ev.at 的最近一版 ≈ 这一轮开始前的样子。
 * 精确到「轮边界」要靠事件与归档同批打点，这里取近似并在 UI 上说清口径。
 */
import { listLocalHistory, readLocalHistory } from "./localHistory";
import { normalizeEol } from "./changedLines";
import type { ChangeEvent } from "./changeTimeline";

async function readVersion(path: string, id: string): Promise<string | null> {
  try {
    const v = await readLocalHistory(path, id);
    return v.text === null ? null : normalizeEol(v.text);
  } catch { return null; }
}

async function findVersion(path: string, at: number, inclusive: boolean): Promise<string | null> {
  try {
    const list = await listLocalHistory(path);
    const hit = list.find((v) => inclusive ? v.ts <= at : v.ts < at);
    return hit ? await readVersion(path, hit.id) : null;
  } catch { return null; }
}

/** 该轮之前的原文。归档轮自带版本 id 时优先用它（更准）。 */
export async function roundBaseText(path: string, ev: ChangeEvent): Promise<string | null> {
  const id = ev.versions?.[path];
  if (id) {
    const text = await readVersion(path, id);
    if (text !== null) return text;
  }
  return findVersion(path, ev.at, false);
}

/** 一轮涉及的所有文件 → 轮前原文。取不到的路径不进 Map，那些文件继续用 SVN BASE。 */
export async function loadRoundBaseTexts(ev: ChangeEvent): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const path of ev.paths) {
    const text = await roundBaseText(path, ev);
    if (text !== null) out.set(path, text);
  }
  return out;
}

export interface RoundPair {
  /** A 点原文；null = 没有归档点，退化为 SVN BASE。 */
  original: string | null;
  /** B 点原文；null = 不比较两点，用磁盘当前内容。 */
  modified: string | null;
  originalLabel: string;
  /** 有任何一侧取不到归档点，UI 必须提示，别假装真的比较了两点。 */
  degraded: boolean;
}

/** 两点比较：A 点之前 ↔ B 点当时。只有 endEvent 存在才算「比较两点」。 */
export async function resolveRoundPair(
  path: string,
  from: ChangeEvent | null,
  to: ChangeEvent | null,
): Promise<RoundPair> {
  const original = from ? await roundBaseText(path, from) : null;
  let modified: string | null = null;
  if (to) {
    const id = to.versions?.[path];
    modified = id
      ? await readVersion(path, id)
      : await findVersion(path, to.at, true);
  }
  return {
    original,
    modified,
    originalLabel: original !== null ? "选中时间点之前" : "SVN 基线（该轮前无归档点）",
    degraded: (from !== null && original === null) || (to !== null && modified === null),
  };
}
