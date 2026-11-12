/**
 * 按需求分组（纯函数，不碰 Tauri）：把 SVN 改动文件按需求表里的归属分组。
 *
 * - 改动全集 = 传进来的 SVN 条目；需求表里有、SVN 里没有的文件不显示（已提交 / 已还原）。
 * - 一个文件属于多个需求 = 混改：在每个需求下各出现一次。
 * - 不属于任何未关闭需求的文件进「未认领」。
 */
import { keyOf, type ChangeItem } from "./svn";
import type { FileReqs, ReqView, Requirement, Touch } from "./requirements";

export interface ReqGroup {
  req: Requirement;
  items: ChangeItem[];
  /** 本组里同时属于别的需求的文件（key）→ 另外那些需求的 id。 */
  mixed: Map<string, string[]>;
  /** 本组文件最近一次改动时间（排序用）。 */
  lastAtMs: number;
}

export interface ReqGrouping {
  groups: ReqGroup[];
  unclaimed: ChangeItem[];
}

/** 文件归属索引：key → FileReqs。 */
export function fileIndex(view: ReqView): Map<string, FileReqs> {
  return new Map(view.files.map((f) => [keyOf(f.path), f]));
}

export function groupByRequirement(items: readonly ChangeItem[], view: ReqView): ReqGrouping {
  const index = fileIndex(view);
  const open = view.reqs.filter((r) => r.status === "open");
  const byId = new Map<string, ReqGroup>(
    open.map((req) => [req.id, { req, items: [], mixed: new Map(), lastAtMs: req.createdMs }]),
  );
  const unclaimed: ChangeItem[] = [];
  for (const it of items) {
    const f = index.get(keyOf(it.path));
    const ids = (f?.reqs ?? []).filter((id) => byId.has(id));
    if (!ids.length) { unclaimed.push(it); continue; }
    for (const id of ids) {
      const g = byId.get(id)!;
      g.items.push(it);
      if (ids.length > 1) g.mixed.set(keyOf(it.path), ids.filter((x) => x !== id));
      const last = (f?.touches ?? []).filter((t) => t.req === id).reduce((m, t) => Math.max(m, t.atMs), 0);
      g.lastAtMs = Math.max(g.lastAtMs, last);
    }
  }
  const groups = [...byId.values()]
    .filter((g) => g.items.length > 0)
    .sort((a, b) => b.lastAtMs - a.lastAtMs);
  return { groups, unclaimed };
}

/** 未认领文件的来源：AI 改的但没声明需求 / 在 NCForge 里手改 / 变更日志里没有（来源不明）。 */
export type FileSource = "ai" | "manual" | "unknown";
export function fileSource(view: ReqView, path: string): FileSource {
  const touches = fileIndex(view).get(keyOf(path))?.touches ?? [];
  const last: Touch | undefined = touches[touches.length - 1];
  return last ? last.source : "unknown";
}
export const FILE_SOURCE_LABEL: Record<FileSource, string> = {
  ai: "AI · 未声明需求",
  manual: "你改的 · 未选当前需求",
  unknown: "来源不明",
};

/** 出过包之后又改了几个文件；没出过包返回 null。 */
export function changedSincePackage(group: ReqGroup, view: ReqView): number | null {
  const lastPack = group.req.packages.reduce((m, p) => Math.max(m, p.atMs), 0);
  if (!lastPack) return null;
  const index = fileIndex(view);
  return group.items.filter((it) =>
    (index.get(keyOf(it.path))?.touches ?? []).some((t) => t.req === group.req.id && t.atMs > lastPack),
  ).length;
}

/**
 * 要不要提示「去 cc-bridge 开启变更日志」。
 * - `off`：日志目录不存在（cc-bridge 没装，或从没开过变更日志）。
 * - `empty`：目录在，但从没读到过本工作区的记录（可能开了但还没改过，或开关又关了）。
 * 只在已经读到需求表时判断，避免启动瞬间闪一下。
 */
export type JournalHint = "off" | "empty" | null;
export function journalHint(view: ReqView, loaded: boolean): JournalHint {
  if (!loaded) return null;
  if (!view.journal.found) return "off";
  return view.journal.lastAtMs === 0 ? "empty" : null;
}

export function reqName(view: ReqView, id: string): string {
  return view.reqs.find((r) => r.id === id)?.name ?? "（已删除的需求）";
}
