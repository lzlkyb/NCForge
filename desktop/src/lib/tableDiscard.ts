import { ask } from "./dbConfirm";

/**
 * 表页离开当前视图前的确认：有未写回的改动就先问一句，没有就直接放行。
 *
 * 从组件里抽出来是因为这条**规则**比它的位置更重要：翻页、改查询条件、清掉恢复出来的
 * 筛选、冲突后重读——四条路径都必须在同一处判断。以前散落在调用点上，
 * 新加一个入口时很容易漏掉这一问，代价是用户改了半天格子被静默丢弃。
 *
 * 两个计数分开报：单元格改动与行级增删是两种心理成本（前者只需重打，
 * 后者要把整行重新填一遍），合成一个「N 处改动」会让用户判断不了值不值得丢弃。
 */
export function askDiscardEdits(changed: number, pendingRows: number): Promise<boolean> {
  if (changed === 0 && pendingRows === 0) return Promise.resolve(true);
  return ask(
    "丢弃未保存的修改？",
    `当前有 ${changed} 个单元格改过、${pendingRows} 处行级增删还没写回，翻页或改查询条件会丢弃它们。`,
    "丢弃并继续",
    true,
  );
}
