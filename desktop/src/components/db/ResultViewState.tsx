import { thousands } from "../../lib/db";
import type { ColumnMeta } from "../../lib/dbApi";
import { cellBrief, type SortState, type ValueFilter } from "../../lib/resultView";

/**
 * 结果条下方那行「当前视图状态」。
 *
 * 三件事必须同时说清楚，否则用户会误判数据：
 * 1. 筛出多少行；
 * 2. 值筛选筛的是哪一列、哪个值（`= BD001` 与「为空」是两种完全不同的收窄）；
 * 3. **只作用于已经取到的行** —— 表头排序与筛选都是本地行为，库里并没有真的重排。
 */
export function ResultViewState({ filter, sort, valueFilter, columns, visibleCount, loadedCount, pending, serverSort, onClear }: {
  /** 关键字筛选（任一列子串匹配）。 */
  filter: string;
  /** 表头排序；只用于判断这行是否需要出现。 */
  sort: SortState | null;
  valueFilter: ValueFilter | null;
  columns: ColumnMeta[];
  /** 筛选后剩下的行数。 */
  visibleCount: number;
  /** 已经取到的行数（筛选前）。 */
  loadedCount: number;
  /** 大结果集在 worker 里算：此时 `visibleCount` 还是 0，不能拿它说「筛出 0 行」。 */
  pending?: boolean;
  /** 这个结果支持「重排并重查」时，提示里多给一句出路。 */
  serverSort: boolean;
  onClear: () => void;
}) {
  if (!sort && !filter && !valueFilter) return null;
  const narrowed = !!filter || !!valueFilter;
  return (
    <div className="dbx-result-view-state" role="status">
      {pending && <span>正在筛选…</span>}
      {narrowed && !pending && <span>筛出 <b>{thousands(visibleCount)}</b> 行</span>}
      {valueFilter && <span className="dbx-mono">
        {columns[valueFilter.col]?.name ?? "列"} {valueFilter.value === null ? "为空" : `= ${cellBrief(valueFilter.value)}`}
      </span>}
      <span
        className="dbx-localhint"
        title={serverSort
          ? "表头排序与筛选只作用于已经取到的行；要整表有序：右键表头 →「重排并重查」"
          : "表头排序与筛选只作用于已经取到的行"}
      >
        仅作用于已取的 {thousands(loadedCount)} 行{serverSort ? " · 右键表头可整表重排" : ""}
      </span>
      <button type="button" className="dbx-lk" onClick={onClear}>清除筛选与排序</button>
    </div>
  );
}
