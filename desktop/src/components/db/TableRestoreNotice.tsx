/**
 * 「已恢复上次的查看条件」提示条。
 *
 * 为什么必须有这条提示：用户打开一张几万行的表，看到的是上次筛过的一小撮行，
 * 第一反应是「数据丢了」——这类误会代价最高，所以恢复条件必须显式说出来，
 * 并给一个一键退回全表的出口（`onClear` 同时清掉记忆，否则下次又被恢复）。
 */
export function TableRestoreNotice({ where, page, onClear }: {
  /** 恢复出来的 WHERE（非空就在提示里注明「有筛选」）。 */
  where: string;
  /** 恢复出来的页码（0 起）；> 0 时提示第几页。 */
  page: number;
  onClear: () => void;
}) {
  return (
    <div className="dbx-restored" role="status">
      已恢复上次的查看条件{where ? "（有筛选）" : ""}{page > 0 ? ` · 第 ${page + 1} 页` : ""}
      <button type="button" className="dbx-lk" onClick={onClear}>清空条件，回到第 1 页</button>
    </div>
  );
}
