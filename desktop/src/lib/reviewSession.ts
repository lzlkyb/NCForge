/**
 * 审查会话：以「轮」为主轴，让代码面与底部「改动」面板共用一份状态。
 *
 * 修的是 2026-11-11 审查里三条结构性缺陷：
 * - 面板的 view / 勾选 / 比较范围是组件局部 state，切页签就丢（P1-8）；
 * - 「核对」按钮靠 window 事件把 UI 状态传给一个可能还没挂载的组件（P0-1）；
 * - 代码面画「相对 SVN BASE 的全部改动」，与用户要审的「这一轮」无关（P1-1）。
 *
 * 依赖方向单向：本模块只调 changedLinesStore 的 setter，store 不反过来读这里。
 * 轮基线文本由 roundBaseline 从本地历史归档点读出后推进 store，不新增后端。
 */
import { getSession, setSession, subscribe } from "./workspaceSession";
import { revealWorkbenchPanel } from "./workbenchLayout";
import {
  getTimeline, initChangeTimeline, pushTimelineEvent, type ChangeEvent,
} from "./changeTimeline";
import { initReviewMarks } from "./reviewMarks";
import { listLocalHistory } from "./localHistory";
import { readTabSnapshot } from "./tabPersistence";
import { recomputeChanged, setRoundBaselines } from "./changedLinesStore";
import { loadRoundBaseTexts } from "./roundBaseline";
import { blockFingerprint, type ChangedBlock } from "./changedLines";
import { invoke } from "./tauri";

export type ReviewView = "timeline" | "diff" | "checklist";
export type BaselineMode = "svn" | "round";

export interface ReviewState {
  view: ReviewView;
  /** 当前聚焦的一轮；null = 不收敛，看全部相对 SVN BASE 的改动。 */
  round: ChangeEvent | null;
  baselineMode: BaselineMode;
  /** 时间线里勾选的事件 id（比较两点用）。 */
  selected: string[];
  diffPaths: string[];
  startEvent: ChangeEvent | null;
  endEvent: ChangeEvent | null;
  /** 块级「已审」：key = 归一路径 + 块内容指纹，文件再改天然失效。 */
  reviewed: ReadonlySet<string>;
}

const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();

let state: ReviewState = {
  view: "timeline",
  round: null,
  baselineMode: "svn",
  selected: [],
  diffPaths: [],
  startEvent: null,
  endEvent: null,
  reviewed: new Set<string>(),
};
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const patch = (p: Partial<ReviewState>) => { state = { ...state, ...p }; emit(); };

/** useSyncExternalStore 用：state 只在 patch 时换引用，不会每次读取都重渲染。 */
export function subscribeReviewSession(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
export function getReviewState(): ReviewState { return state; }

export function setReviewView(view: ReviewView): void { patch({ view }); }
export function setReviewSelected(selected: string[]): void { patch({ selected }); }
export function setDiffScope(diffPaths: string[], startEvent: ChangeEvent | null, endEvent: ChangeEvent | null = null): void {
  patch({ diffPaths, startEvent, endEvent, view: "diff" });
}

/**
 * 代码面按钮直调：不依赖任何组件挂载。
 * 先落 session（面板页签）、再展开底部面板、再回文件页、最后切目标视图。
 * 用 window 事件只做「跨页导航」这一件本来就是全局的事，UI 状态一律走 store；
 * 视图状态存在这里，所以底部面板还没挂载时点「核对」也不会丢（P0-1）。
 */
function openReviewPanel(view: ReviewView): void {
  setSession({ panelOpen: true, panelTab: "changes" });
  revealWorkbenchPanel("changes");
  // Tauri 里一定有 window；纯 node 环境（工具链 / 单测）不该因为一次导航就抛
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("ncforge-navigate", { detail: "files" }));
  }
  patch({ view });
}
export function openChecklist(): void { openReviewPanel("checklist"); }
export function openTimeline(): void { openReviewPanel("timeline"); }

/** 选中一轮：色条基线收敛到该轮之前，代码面滚到首处改动。 */
export async function selectRound(ev: ChangeEvent | null): Promise<void> {
  const seq = ++roundSeq;
  patch({ round: ev, baselineMode: ev ? "round" : "svn" });
  if (!ev) {
    setRoundBaselines(new Map());
    recomputeChanged();
    return;
  }
  const texts = await loadRoundBaseTexts(ev);
  if (seq !== roundSeq) return;
  setRoundBaselines(texts);
  recomputeChanged();
  jumpToRoundFirst();
}

/** 基线可切：本轮前（本地历史归档点）↔ SVN BASE。 */
export async function setBaselineMode(mode: BaselineMode): Promise<void> {
  const seq = ++roundSeq;
  patch({ baselineMode: mode });
  if (mode === "svn" || !state.round) {
    setRoundBaselines(new Map());
    recomputeChanged();
    return;
  }
  const texts = await loadRoundBaseTexts(state.round);
  if (seq !== roundSeq) return;
  setRoundBaselines(texts);
  recomputeChanged();
}

/**
 * 指纹含整块原文，直接当落盘 key 会把标记文件撑得很大；取 53 位哈希（cyrb53）。
 * 只在同一文件内比较，碰撞概率可以忽略。
 */
function hashFingerprint(s: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export function reviewedKey(path: string, block: ChangedBlock): string {
  return `${norm(path)}|${hashFingerprint(blockFingerprint(block))}`;
}

/**
 * 块级已审落盘（按需求审查 P1：重启不丢）。先改内存再异步写盘：写盘失败只影响重启后的记忆，
 * 不该让「点了已审却没反应」。块文本一并存下，供以后「只看这次改了什么」用。
 */
function persistBlocks(keys: string[], blocks: readonly ChangedBlock[], reviewed: boolean): void {
  if (!keys.length) return;
  const texts = reviewed ? blocks.map((b) => b.currentLines.join("\n")) : undefined;
  void invoke("review_blocks_set", { keys, texts, reviewed }).catch((e) => {
    console.warn("块级审查标记写盘失败（本次会话内仍有效）", e);
  });
}
export function isBlockReviewed(path: string, block: ChangedBlock): boolean {
  return state.reviewed.has(reviewedKey(path, block));
}
/** 返回切换后的状态；next 省略则取反。 */
export function markBlockReviewed(path: string, block: ChangedBlock, next?: boolean): boolean {
  const key = reviewedKey(path, block);
  const has = state.reviewed.has(key);
  const want = next ?? !has;
  if (want === has) return has;
  const updated = new Set(state.reviewed);
  if (want) updated.add(key); else updated.delete(key);
  patch({ reviewed: updated });
  persistBlocks([key], [block], want);
  return want;
}
/** 批量标记（「已审并看下一项」「本需求全部标为已审」）。只写状态真正变了的块。 */
export function markBlocksReviewed(path: string, blocks: readonly ChangedBlock[], next: boolean): void {
  const changed = blocks.filter((b) => state.reviewed.has(reviewedKey(path, b)) !== next);
  if (!changed.length) return;
  const keys = changed.map((b) => reviewedKey(path, b));
  const updated = new Set(state.reviewed);
  for (const k of keys) { if (next) updated.add(k); else updated.delete(k); }
  patch({ reviewed: updated });
  persistBlocks(keys, changed, next);
}
export function reviewedCount(path: string, blocks: readonly ChangedBlock[]): number {
  return blocks.filter((b) => isBlockReviewed(path, b)).length;
}

/** 点色条反查：当前聚焦的轮优先，否则取时间线里最近一条涉及该文件的轮。 */
export function roundForPath(path: string): ChangeEvent | null {
  const key = norm(path);
  const inRound = (e: ChangeEvent) => e.paths.some((p) => norm(p) === key);
  if (state.round && inRound(state.round)) return state.round;
  return getTimeline().find(inRound) ?? null;
}

/** 「滚到这一轮首处改动」由 Monaco 装饰层注册；摘要条不必静态 import monaco。 */
let jumpToFirst: (() => void) | null = null;
export function setJumpToRoundFirst(fn: () => void): void { jumpToFirst = fn; }
export function jumpToRoundFirst(): void { jumpToFirst?.(); }

/** 快速连点两轮时，只让最后一次请求生效，避免先返回的旧轮覆盖新轮。 */
let roundSeq = 0;

let started = false;
/** 回填只跑一次（外加标签恢复后补一次），不跟着每次切页签重打 IPC。 */
let seedTried = false;
let stopSeedWatch: (() => void) | null = null;
/** App 启动时调一次：事件采集必须早于用户第一次打开「改动」页签。 */
export function initReviewSession(): void {
  if (started) return;
  started = true;
  initChangeTimeline();
  initReviewMarks();
  void seedRoundsFromHistory();
  void loadPersistedBlocks();
}

/** 启动时读回落盘的块级已审，并入内存（不覆盖启动后已经点过的）。读不到就算了。 */
async function loadPersistedBlocks(): Promise<void> {
  try {
    const keys = await invoke<string[]>("review_blocks_list");
    if (!keys.length) return;
    patch({ reviewed: new Set([...keys, ...state.reviewed]) });
  } catch { /* 桥没起 / 单测环境：只是没有上次的记忆 */ }
}

/**
 * 启动回填一轮：AI 改文件发生在上次会话时，内存事件必为空。
 * 只取最近 24 小时、最多 12 个已打开标签的归档点，失败一律静默。
 */
async function seedRoundsFromHistory(): Promise<void> {
  if (seedTried) return;
  seedTried = true;
  const tabs = seedPaths();
  if (!tabs.length) {
    // 冷启动：标签恢复要等 root（useTabSession），此刻 tabs 与快照都拿不到。
    // 挂一个一次性订阅等标签出现，否则「启动时也会回填」的空态文案是空话。
    if (stopSeedWatch || getTimeline().length) return;
    stopSeedWatch = subscribe(() => {
      if (getTimeline().length) { disarmSeedWatch(); return; }
      if (!getSession().tabs.length) return;
      disarmSeedWatch();
      seedTried = false;
      void seedRoundsFromHistory();
    });
    return;
  }
  const versions: Record<string, string> = {};
  const paths: string[] = [];
  const DAY = 24 * 60 * 60 * 1000;
  for (const tab of tabs) {
    if (!tab || tab.includes("://")) continue;
    try {
      const hit = (await listLocalHistory(tab)).find((v) => Date.now() - v.ts < DAY);
      if (!hit) continue;
      paths.push(tab);
      versions[tab] = hit.id;
    } catch { /* 桥没起 / 没有历史：没得回填，不影响主流程 */ }
  }
  if (!paths.length || getTimeline().length) return;
  pushTimelineEvent({
    kind: "history",
    paths,
    versions,
    label: "上次会话的归档点（启动回填）",
  });
}

/** 回填候选：优先内存里的活标签，冷启动回退到 tabPersistence 的同工作区快照。 */
function seedPaths(): string[] {
  const live = getSession().tabs
    .slice(0, 12)
    .map((t) => t.path)
    .filter((p): p is string => !!p && !p.includes("://"));
  if (live.length) return live;
  const root = getSession().root;
  if (!root) return [];
  return readTabSnapshot(root)?.tabs.slice(0, 12) ?? [];
}

function disarmSeedWatch(): void {
  const stop = stopSeedWatch;
  stopSeedWatch = null;
  stop?.();
}

/** 单测用：把会话状态清回初始值。 */
export function resetReviewSession(): void {
  state = {
    view: "timeline", round: null, baselineMode: "svn",
    selected: [], diffPaths: [], startEvent: null, endEvent: null,
    reviewed: new Set<string>(),
  };
  started = false;
  seedTried = false;
  disarmSeedWatch();
  emit();
}
