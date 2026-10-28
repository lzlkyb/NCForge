/**
 * 表名悬停「问谁」的插槽。
 *
 * 单独一个模块是为了不把 Monaco 拖进主 chunk：壳子（App）只需要注入一个查询器，
 * 不该因此 import 整个编辑器。真正的 hover provider 在 `monacoSetup` 里，
 * 它从这里取当前的查询器。
 */

export interface HoverColumn {
  name: string;
  type: string;
}

export interface TableLookup {
  /** 这个词是不是库里的表名（实现里按小写比较）。 */
  has(table: string): boolean;
  /** 取一张表的字段；拿不到返回 null（连不上、没缓存、表不在）。 */
  columns(table: string): Promise<HoverColumn[] | null>;
  /** 缓存时间的说法，如「2 小时前」；没有缓存时为空串。 */
  cacheAge(): string;
}

let current: TableLookup | null = null;

export function setTableLookup(lookup: TableLookup | null): void {
  current = lookup;
}

export function getTableLookup(): TableLookup | null {
  return current;
}
