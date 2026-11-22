import { useSyncExternalStore } from "react";
import { keyOf, type ChangeItem, type CommitResult } from "./svn";

export interface SvnCommitSnapshot { message: string; paths: string[]; }
interface SvnCommitReceipt {
  revision: number;
  count: number;
  message: string;
  requirements?: Record<string,string[]>;
}
export interface SvnDraft {
  message: string;
  picked: Set<string>;
  known: Set<string>;
  initialized: boolean;
  selectionUndo?: Set<string>;
  unknown: (SvnCommitSnapshot & { at: number; error: string }) | null;
  lastCommit: SvnCommitReceipt | null;
}
const empty = (): SvnDraft => ({ message: "", picked: new Set(), known: new Set(), initialized: false, unknown: null, lastCommit: null });
const noRoot = empty();
const drafts = new Map<string, SvnDraft>();
const available = new Map<string, ChangeItem[]>();
const listeners = new Set<() => void>();
const storageKey = (root: string) => `ncforge.svn.draft:${keyOf(root)}`;
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

export function isSvnCommittable(item: ChangeItem): boolean {
  return !item.isDir && !item.ignored && !["C", "!", "~"].includes(item.letter);
}
/**
 * picked 里存的是原始路径，比较要按 keyOf 归一。归一后的集合按 Set 实例缓存：
 * 草稿每次发布都换新 Set，渲染几千行时只归一一次，而不是每行展开一遍。
 * 顺带记 size，调用方就地增删过的 Set 会重算。
 */
const keySets = new WeakMap<ReadonlySet<string>, { size: number; keys: Set<string> }>();
export function svnKeySet(paths: ReadonlySet<string>): ReadonlySet<string> {
  const hit = keySets.get(paths);
  if (hit && hit.size === paths.size) return hit.keys;
  const keys = new Set([...paths].map(keyOf));
  keySets.set(paths, { size: paths.size, keys });
  return keys;
}
export const isSvnPicked = (picked: ReadonlySet<string>, path: string) => svnKeySet(picked).has(keyOf(path));

export function getSvnDraft(root: string | null | undefined): SvnDraft {
  if (!root) return noRoot;
  const key = keyOf(root);
  const existing = drafts.get(key);
  if (existing) return existing;
  let draft = empty();
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(root)) ?? "null");
    if (saved && typeof saved.message === "string") {
      draft = { ...draft, message: saved.message, picked: new Set(strings(saved.picked)), known: new Set(strings(saved.known)), initialized: saved.initialized === true };
      if (saved.unknown && typeof saved.unknown.message === "string" && typeof saved.unknown.error === "string" && typeof saved.unknown.at === "number") {
        draft.unknown = { message: saved.unknown.message, paths: strings(saved.unknown.paths), at: saved.unknown.at, error: saved.unknown.error };
      }
      const receipt = saved.lastCommit;
      if (receipt && Number.isSafeInteger(receipt.revision) && receipt.revision > 0 && Number.isSafeInteger(receipt.count) && typeof receipt.message === "string") {
        const requirements = receipt.requirements && typeof receipt.requirements === "object" ? Object.fromEntries(
          Object.entries(receipt.requirements).map(([path,names]) => [path,strings(names)])
        ) : undefined;
        draft.lastCommit = { revision:receipt.revision, count:receipt.count, message:receipt.message, requirements };
      }
    }
  } catch { /* 本机存储不可用时，本次会话仍保留草稿。 */ }
  drafts.set(key, draft);
  return draft;
}

function publish(root: string, draft: SvnDraft) {
  drafts.set(keyOf(root), draft);
  try {
    localStorage.setItem(storageKey(root), JSON.stringify({ ...draft, selectionUndo: undefined, picked: [...draft.picked], known: [...draft.known] }));
  } catch { /* 隐私模式/存储满不影响当前会话。 */ }
  listeners.forEach(listener => listener());
}

export function useSvnDraft(root: string | null | undefined): SvnDraft {
  return useSyncExternalStore(subscribe, () => getSvnDraft(root), () => getSvnDraft(root));
}

/** 只有第一次有效扫描默认全选。后续刷新绝不能悄悄扩大本次提交范围。 */
export function syncSvnDraft(root: string, items: ChangeItem[]): void {
  const before = getSvnDraft(root);
  available.set(keyOf(root), items);
  const picked = new Set(items.filter(isSvnCommittable).filter(item => !before.initialized || isSvnPicked(before.picked, item.path)).map(item => item.path));
  const known = new Set([...before.known, ...items.map(item => item.path)]);
  const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every(v => b.has(v));
  if (before.initialized && same(picked, before.picked) && same(known, before.known)) return;
  publish(root, { ...before, picked, known, initialized: true });
}

export function setSvnMessage(root: string, message: string): void {
  const draft = getSvnDraft(root);
  if (message !== draft.message) publish(root, { ...draft, message });
}

export function selectSvnPaths(root: string, paths: readonly string[], reversible = false): void {
  const draft = getSvnDraft(root);
  if (!root || draft.unknown) return;
  const wanted = new Set(paths.map(keyOf));
  const picked = new Set((available.get(keyOf(root)) ?? []).filter(isSvnCommittable).filter(item => wanted.has(keyOf(item.path))).map(item => item.path));
  if (picked.size === draft.picked.size && [...picked].every(path => isSvnPicked(draft.picked,path))) return;
  publish(root, { ...draft, picked, selectionUndo: reversible ? draft.picked : undefined });
}

export function toggleSvnPicked(root: string, path: string): void {
  const draft = getSvnDraft(root);
  const selected = [...draft.picked].filter(p => keyOf(p) !== keyOf(path));
  if (!isSvnPicked(draft.picked, path)) selected.push(path);
  selectSvnPaths(root, selected);
}

export const clearSvnPicked = (root: string) => selectSvnPaths(root, [], true);
export function selectSvnReviewed(root: string, reviewed: ReadonlySet<string>): void {
  const paths = (available.get(keyOf(root)) ?? []).filter(item => isSvnCommittable(item) && reviewed.has(keyOf(item.path))).map(item => item.path);
  if (paths.length) selectSvnPaths(root, paths, true);
}
export function undoSvnSelection(root: string): void {
  const draft = getSvnDraft(root);
  if (!draft.selectionUndo || draft.unknown) return;
  const previous = [...draft.selectionUndo];
  publish(root, { ...draft, selectionUndo: undefined });
  selectSvnPaths(root, previous);
}

export function completeSvnDraft(root: string, snapshot: SvnCommitSnapshot, result: CommitResult, requirements?: Record<string,string[]>): void {
  const draft = getSvnDraft(root);
  const sent = new Set(snapshot.paths.map(keyOf));
  publish(root, { ...draft, selectionUndo: undefined, picked: new Set([...draft.picked].filter(path => !sent.has(keyOf(path)))), message: draft.message.trim() === snapshot.message ? "" : draft.message, unknown: null, lastCommit: { revision: result.revision, count: snapshot.paths.length, message: snapshot.message, requirements } });
}

export function markSvnUnknown(root: string, snapshot: SvnCommitSnapshot, error: string): void {
  publish(root, { ...getSvnDraft(root), unknown: { ...snapshot, paths: [...snapshot.paths], error, at: Date.now() } });
}

/** 仅供用户核实服务器记录后的显式确认；刷新与导航不能自动解除。 */
export function acknowledgeSvnUnknown(root: string): void {
  publish(root, { ...getSvnDraft(root), unknown: null });
}
