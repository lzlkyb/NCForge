import type { BoundCell } from "./dbApi";
import type { TableFilter } from "./dbConditions";

/** 表页上次看到的查询状态：切到「结构」再回来、切文档再回来都还能接着看。 */
export interface TableView {
  where: string;
  order: string;
  params: BoundCell[];
  page: number;
  /** 存这一页时的「常用筛选」指纹：常用筛选改过之后，旧视图不再顶替新条件。 */
  filterKey?: string;
}

const key = (connId: string, tableRef: string) => `ncforge.db.tableView:${connId}:${tableRef.toLowerCase()}`;

/**
 * 视图记忆的有效期。
 *
 * 🔴 必须有过期时间：跨重启记住筛选/页码之后，「半年后打开这张表、发现只有 37 行」
 * 比「没记住」糟糕得多——用户会以为数据丢了。7 天足够覆盖连续几天的工作。
 */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 存下来的时间戳是否还在有效期内。老版本数据没有时间戳，一律当作过期。 */
function fresh(savedAt: unknown): boolean {
  return typeof savedAt === "number" && savedAt > 0 && Date.now() - savedAt <= TTL_MS;
}

export function loadTableView(connId: string, tableRef: string, filterKey: string): TableView | null {
  try {
    const raw = localStorage.getItem(key(connId, tableRef));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<TableView> & { savedAt?: number } | null;
    if (!v || typeof v.where !== "string" || typeof v.order !== "string" || !Array.isArray(v.params)) return null;
    if (!fresh(v.savedAt)) return null;
    if (v.filterKey !== filterKey) return null;
    const page = typeof v.page === "number" && Number.isInteger(v.page) && v.page >= 0 ? v.page : 0;
    return { where: v.where, order: v.order, params: v.params, page, filterKey };
  } catch {
    return null;
  }
}

/**
 * 这份视图记忆里有没有「用户能感知到的条件」。
 *
 * 只记住页码 0 + 空条件时不必提示「已恢复上次条件」——那和默认打开没区别，
 * 提示反而是噪音。有筛选或翻过页才需要说出来。
 */
export function hasViewState(view: TableView | null): boolean {
  return !!view && (view.where !== "" || view.order !== "" || view.page > 0);
}

export function saveTableView(connId: string, tableRef: string, view: TableView): void {
  try {
    localStorage.setItem(key(connId, tableRef), JSON.stringify({ ...view, savedAt: Date.now() }));
  } catch {
    // 存不下（隐私模式 / 配额满）就算了：本次会话仍在内存里。
  }
}

/** 筛选栏自己的编辑状态（可视化条件 / 手写 WHERE）。与上面的编译结果成对恢复。 */
export interface FilterView {
  filter: TableFilter;
  advanced: boolean;
  raw: { where: string; order: string };
}

const fkey = (connId: string, table: string) => `ncforge.db.filterView:${connId}:${table.toLowerCase()}`;

export function loadFilterView(connId: string, table: string): FilterView | null {
  try {
    const raw = localStorage.getItem(fkey(connId, table));
    if (!raw) return null;
    const v = JSON.parse(raw) as (Partial<FilterView> & { savedAt?: number }) | null;
    if (!v || !v.filter || !Array.isArray(v.filter.conditions)) return null;
    // 与 TableView 同一个有效期：筛选栏显示条件、查询却不带条件，是最容易看错数据的一种错位
    if (!fresh(v.savedAt)) return null;
    return {
      filter: v.filter,
      advanced: !!v.advanced,
      raw: { where: String(v.raw?.where ?? ""), order: String(v.raw?.order ?? "") },
    };
  } catch {
    return null;
  }
}

export function saveFilterView(connId: string, table: string, view: FilterView): void {
  try {
    localStorage.setItem(fkey(connId, table), JSON.stringify({ ...view, savedAt: Date.now() }));
  } catch {
    // 同上：没存下不影响本次查询。
  }
}
