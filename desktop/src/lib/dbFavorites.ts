import { useSyncExternalStore } from "react";

/**
 * 数据库对象收藏：表 / 视图 / 包 / 过程等，**跨连接**聚合并存本机 localStorage。
 *
 * 旧版只按连接存表名（`{connId: string[]}`），入口在对象树里；v2 改成带类型的条目，
 * 侧栏顶部可以跨连接展示。旧 key 只读：首次加载自动迁移，之后只写 v2。
 *
 * 为什么不放后端：收藏是「我自己的常用对象」，和片段库一样属于本机备忘；
 * 换机器时应该自己带走，不混进连接配置。
 */

export type FavoriteKind = "table" | "object";

export interface FavoriteItem {
  connId: string;
  kind: FavoriteKind;
  /** 对象名，统一大写。 */
  name: string;
  /** `object` 的 Oracle 类型（PACKAGE / PROCEDURE …）；表收藏没有。 */
  otype?: string;
  /** 收藏时间，超过上限时淘汰最旧的。 */
  at: number;
}

const KEY = "ncforge-db-fav-v2";
const LEGACY_KEY = "ncforge-db-fav";
const MAX = 500;
const listeners = new Set<() => void>();

function keyOf(f: FavoriteItem): string {
  return `${f.connId}\u0000${f.kind}\u0000${f.otype ?? ""}\u0000${f.name}`;
}

/** 去重 / 判断是否已收藏用的稳定键。名称与类型统一大写。 */
export function favoriteKey(connId: string, kind: FavoriteKind, name: string, otype?: string): string {
  return `${connId}\u0000${kind}\u0000${otype?.trim().toUpperCase() ?? ""}\u0000${name.trim().toUpperCase()}`;
}

function normalize(f: FavoriteItem): FavoriteItem {
  const name = f.name.trim().toUpperCase();
  const base = { connId: f.connId, kind: f.kind, name, at: f.at };
  return f.kind === "object" && f.otype?.trim()
    ? { ...base, otype: f.otype.trim().toUpperCase() }
    : base;
}

function isItem(v: unknown): v is FavoriteItem {
  if (!v || typeof v !== "object") return false;
  const f = v as Partial<FavoriteItem>;
  return (
    typeof f.connId === "string" &&
    f.connId.length > 0 &&
    (f.kind === "table" || f.kind === "object") &&
    typeof f.name === "string" &&
    f.name.trim().length > 0 &&
    (f.otype === undefined || typeof f.otype === "string") &&
    typeof f.at === "number"
  );
}

function dedupe(list: FavoriteItem[]): FavoriteItem[] {
  const seen = new Set<string>();
  const out: FavoriteItem[] = [];
  for (const raw of list) {
    const item = normalize(raw);
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** 旧版 `{connId: string[]}` → 表收藏；顺序保留，`at` 只用于容量淘汰。 */
function migrateLegacy(): FavoriteItem[] {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return [];
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object") return [];
    const now = Date.now();
    const out: FavoriteItem[] = [];
    for (const [connId, names] of Object.entries(value as Record<string, unknown>)) {
      if (!Array.isArray(names)) continue;
      names.forEach((name, i) => {
        if (typeof name === "string" && name.trim()) {
          out.push({ connId, kind: "table", name, at: now - names.length + i });
        }
      });
    }
    return out;
  } catch {
    return [];
  }
}

function readAll(): { items: FavoriteItem[]; legacy: boolean } {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const value = JSON.parse(raw) as { v?: number; items?: unknown };
      const items = Array.isArray(value?.items) ? value.items.filter(isItem) : [];
      return { items: dedupe(items).slice(0, MAX), legacy: false };
    }
  } catch {
    // 坏 JSON 当空库，不把旧 key 再捞回来（那会复活已经被删掉的收藏）
    return { items: [], legacy: false };
  }
  const legacy = dedupe(migrateLegacy()).slice(0, MAX);
  return { items: legacy, legacy: legacy.length > 0 };
}

function persist(items: FavoriteItem[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ v: 2, items }));
  } catch {
    // 本机存满就只在本次会话生效
  }
}

const loaded = readAll();
let all = loaded.items;
if (loaded.legacy) persist(all);

function emit() {
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 当前收藏快照（引用稳定；`useSyncExternalStore` 依赖这一点）。 */
export function listFavorites(): FavoriteItem[] {
  return all;
}

export function useAllFavorites(): FavoriteItem[] {
  return useSyncExternalStore(subscribe, listFavorites);
}

/** 切换收藏，返回切换后的状态（true = 现在已收藏）。 */
export function toggleFavorite(connId: string, kind: FavoriteKind, name: string, otype?: string): boolean {
  const clean = name.trim();
  if (!connId || !clean) return false;
  const key = favoriteKey(connId, kind, clean, otype);
  const exists = all.some((f) => keyOf(f) === key);
  const next: FavoriteItem = {
    connId,
    kind,
    name: clean.toUpperCase(),
    ...(kind === "object" && otype?.trim() ? { otype: otype.trim().toUpperCase() } : {}),
    at: Date.now(),
  };
  all = exists ? all.filter((f) => keyOf(f) !== key) : [next, ...all].slice(0, MAX);
  persist(all);
  emit();
  return !exists;
}

/** 删除连接时清掉它的收藏；连接删除失败不要调用。 */
export function clearFavorites(connId: string): void {
  const next = all.filter((f) => f.connId !== connId);
  if (next.length === all.length) return;
  all = next;
  persist(all);
  emit();
}

/** 仅测试用：重置模块内缓存与 localStorage。 */
export function __resetFavoritesForTest(): void {
  all = [];
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    // 测试环境没有 localStorage 也不影响内存态
  }
  emit();
}
