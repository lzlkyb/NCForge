import type { ResultEntry } from "./dbStore";
import type { TxEpoch } from "./dbTxEpoch";

/**
 * 一条写语句「现在」提交了没有。
 *
 * 以前结果页写死「执行时为手动提交 · 当前状态以连接详情与提交/回滚按钮为准」：提交之后
 * 这行还在，用户回头一看以为没提交，于是又去点一次提交（或者以为软件没提交）。
 * 现在按会话的提交纪元算，提交 / 回滚后跟着变；事务条仍是唯一入口，这里只负责把
 * 「这条语句」的结局说准。
 */
export function txStateText(entry: ResultEntry, epoch: TxEpoch): string {
  if (entry.autoCommit === undefined) return "提交状态待核对";
  if (entry.autoCommit) return "已自动提交";
  const at = entry.completedAt ?? 0;
  // 恢复出来的旧结果没有执行时刻（升级前存的标签页）：不敢断言它属于哪次事务。
  if (at <= 0) return "提交状态见上方事务条";
  if (epoch.commitAt >= at) return "已提交";
  // 先提交再回滚时，这条写入已经跟着提交走了：只有「提交之后才回滚」才真的撤掉了它。
  if (epoch.rollbackAt >= at && epoch.rollbackAt > epoch.commitAt) return "已回滚 · 这次写入已撤销";
  return "尚未提交 · 见上方事务条";
}
