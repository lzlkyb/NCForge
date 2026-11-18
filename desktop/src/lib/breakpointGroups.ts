// 断点分组与静音的纯函数层。
//
// 与 `breakpoints.ts`（可变状态 + 持久化 + 订阅）分开：这里不碰 localStorage、
// 不触发 React 订阅，只做「清单 → 清单」与「状态 → 判定」，配单测钉住语义。
//
// 数据形状：组名挂在每条断点的 `group` 字段上（缺省 = 默认组，永远启用）；
// 「组被禁用」与「全局静音」是会话级偏好，随断点清单一起按工作区存盘。
// 为什么组禁用不进每条断点的 enabled：一个组动辄几十条断点，「整组禁用」
// 是一次操作，落成每条改字段既慢又会在重命名组时丢掉禁用状态。

/** 组名上限：再长就不是分组名，而是把需求文档贴进来了。 */
export const MAX_GROUP_NAME = 40;

/** 组名清洗：去空白、截断。空串 = 无效（调用方按「默认组」处理）。 */
export function cleanGroupName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const text = raw.trim().slice(0, MAX_GROUP_NAME);
  return text.length > 0 ? text : undefined;
}

/** 组启用判定：没有组的断点（默认组）永远启用。 */
export const isGroupEnabled = (disabledGroups: string[], group: string | undefined): boolean =>
  !group || !disabledGroups.includes(group);

/** 存盘形状（v2）：清单 + 两个会话级偏好。v1 只有清单数组（见 normalizeStored）。 */
export interface StoredBreakpoints {
  items: unknown[];
  muted: boolean;
  disabledGroups: string[];
}

/** 读盘数据 → v2 形状。v1（裸数组）按「不静音、无禁用组」兼容，老工作区不丢断点。 */
export function normalizeStored(raw: unknown): StoredBreakpoints {
  if (Array.isArray(raw)) return { items: raw, muted: false, disabledGroups: [] };
  if (!raw || typeof raw !== "object") return { items: [], muted: false, disabledGroups: [] };
  const o = raw as Record<string, unknown>;
  return {
    items: Array.isArray(o.items) ? o.items : [],
    muted: o.muted === true,
    disabledGroups: Array.isArray(o.disabledGroups)
      ? o.disabledGroups.filter((g): g is string => typeof g === "string" && g.trim().length > 0)
      : [],
  };
}

/** 去掉成员已空掉的组名：断点清空后，禁用清单不该留着幽灵组名（重组同名时莫名被禁用）。 */
export function pruneDisabledGroups(disabledGroups: string[], items: readonly { group?: string }[]): string[] {
  return disabledGroups.filter((g) => items.some((b) => b.group === g));
}

/** 面板要的组摘要：按名字排序，count = 组内断点数（含禁用项）。 */
export interface BreakpointGroupInfo {
  name: string;
  count: number;
  enabled: boolean;
}

export function groupInfos(
  items: readonly { group?: string }[],
  disabledGroups: string[],
): BreakpointGroupInfo[] {
  const counts = new Map<string, number>();
  for (const b of items) {
    if (!b.group) continue;
    counts.set(b.group, (counts.get(b.group) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count, enabled: isGroupEnabled(disabledGroups, name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** 重命名组（返回新清单，不改原引用）。同名目标已存在时调用方要先合并或拒绝。 */
export function renameGroupInList<T extends { group?: string }>(list: T[], from: string, to: string): T[] {
  if (from === to) return list;
  return list.map((b) => (b.group === from ? { ...b, group: to } : b));
}

/** 解散组：断点全部回到默认组（不断点本身）。 */
export function clearGroupInList<T extends { group?: string }>(list: T[], name: string): T[] {
  return list.map((b) => (b.group === name ? { ...b, group: undefined } : b));
}
