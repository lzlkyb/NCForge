/**
 * 改动时间线：把「已经存在的事件流」组织成一轮一轮可审查的单元。
 *
 * 三类事件，全部零协议依赖（方案 §6 B1）：
 * - 本人保存 → `onLocalSave`（写盘前打点）
 * - 外部写入 → `onExternalJavaChanged`（已排除本人保存，AI / SVN update / 别的编辑器都算）
 * - 本地历史归档点 → `onLocalHistoryCaptured`（写盘前自动归档出的版本 id）
 *
 * 不引 shadow-git、不新增快照引擎：本地历史本来就存原字节（GBK / 混合换行安全），
 * 这里只补「轮」这个概念。同类事件在 1.5 秒内合并成一条，**窗口锚定在轮起点、
 * 不随每次写入后移**——否则 AI 每 1 秒写一个文件会无限滚成一个没有边界的巨轮。
 *
 * 采集必须在 App 启动时就开始（`reviewSession.initReviewSession`），不能等用户
 * 第一次打开「改动」页签；否则主诉场景里面板永远是空的（P0-2）。
 */
import { onExternalJavaChanged } from "./externalJavaChanges";
import { onLocalSave } from "./localSaves";
import { onLocalHistoryCaptured } from "./localHistory";

export type ChangeKind = "me" | "external" | "history";

export interface ChangeEvent {
  id: string;
  at: number;
  kind: ChangeKind;
  paths: string[];
  /** 本地历史归档点：path → 版本 id，用于「还原本轮」与轮基线。 */
  versions?: Record<string, string>;
  /**
   * 这一轮的归档点是**变更后**快照（兜底 / 切页归档、启动回填取的都是磁盘现状）。
   * 为 true 时 versions 只能当比较的 B 点，绝不能当「轮前原文」——否则色条全空。
   */
  post?: boolean;
  label?: string;
}

const MAX_EVENTS = 200;
/** 同类事件合并成一个「轮」的窗口，锚定轮起点。 */
const GROUP_MS = 1500;

let events: ChangeEvent[] = [];
const listeners = new Set<() => void>();
let seq = 0;

export function subscribeTimeline(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
export function getTimeline(): readonly ChangeEvent[] {
  return events;
}
export function clearTimeline(): void {
  events = [];
  listeners.forEach((l) => l());
}

/** 追加一条；与最近一条同类且距「轮起点」不足 GROUP_MS 时合并文件列表（去重）。 */
export function pushTimelineEvent(input: Omit<ChangeEvent, "id" | "at"> & { at?: number }): void {
  const at = input.at ?? Date.now();
  const last = events[0];
  if (last && last.kind === input.kind && at - last.at < GROUP_MS) {
    const paths = [...new Set([...last.paths, ...input.paths])];
    // 同一路径保留**最早**那个 id：后到的归档已经是轮中/轮后内容，当基线会少画改动
    const versions = { ...(input.versions ?? {}), ...(last.versions ?? {}) };
    const post = last.post || input.post ? true : undefined;
    // 关键：保留 last.at，不把轮起点后移，窗口才是固定边界
    events = [{ ...last, paths, versions, post }, ...events.slice(1)];
  } else {
    seq += 1;
    events = [{ id: `e${at}-${seq}`, at, kind: input.kind, paths: [...new Set(input.paths)], versions: input.versions, post: input.post, label: input.label }, ...events].slice(0, MAX_EVENTS);
  }
  listeners.forEach((l) => l());
}

let started = false;
/** 幂等接线：只能由 App 启动路径调用，面板挂载时再调就晚了。 */
export function initChangeTimeline(): void {
  if (started) return;
  started = true;
  onLocalSave((path) => pushTimelineEvent({ kind: "me", paths: [path], label: "本人保存" }));
  onExternalJavaChanged((paths) => pushTimelineEvent({ kind: "external", paths: [...paths], label: "外部写入（AI / 更新 / 其他编辑器）" }));
  onLocalHistoryCaptured((path, id) => pushTimelineEvent({ kind: "history", paths: [path], versions: { [path]: id }, label: "本地历史归档点" }));
}

/** 单测用：重置幂等开关与事件。 */
export function resetChangeTimeline(): void {
  events = [];
  started = false;
  listeners.forEach((l) => l());
}
