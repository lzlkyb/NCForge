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

export function loadTableView(connId: string, tableRef: string, filterKey: string): TableView | null {
  try {
    const raw = sessionStorage.getItem(key(connId, tableRef));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<TableView> | null;
    if (!v || typeof v.where !== "string" || typeof v.order !== "string" || !Array.isArray(v.params)) return null;
    if (v.filterKey !== filterKey) return null;
    const page = typeof v.page === "number" && Number.isInteger(v.page) && v.page >= 0 ? v.page : 0;
    return { where: v.where, order: v.order, params: v.params, page, filterKey };
  } catch {
    return null;
  }
}

export function saveTableView(connId: string, tableRef: string, view: TableView): void {
  try {
    sessionStorage.setItem(key(connId, tableRef), JSON.stringify(view));
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
    const raw = sessionStorage.getItem(fkey(connId, table));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<FilterView> | null;
    if (!v || !v.filter || !Array.isArray(v.filter.conditions)) return null;
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
    sessionStorage.setItem(fkey(connId, table), JSON.stringify(view));
  } catch {
    // 同上：没存下不影响本次查询。
  }
}
