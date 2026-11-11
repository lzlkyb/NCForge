import { expect, it } from "vitest";
import { txStateText } from "./txResultState";
import type { TxEpoch } from "./dbTxEpoch";

/**
 * 写语句结果上的「提交了没有」。
 *
 * 旧文案「执行时为手动提交 · 当前状态以连接详情与提交/回滚按钮为准」是死的：
 * 提交之后它还在，用户回头一看就以为没提交。这里守住三条：
 * 提交后说已提交、回滚后说已撤销、还没提交才说未提交。
 */
const entry = (autoCommit: boolean, completedAt: number) =>
  ({ kind: "update", autoCommit, completedAt } as never);
const epoch = (patch: Partial<TxEpoch>): TxEpoch =>
  ({ seq: 1, action: "commit", at: 0, commitAt: 0, rollbackAt: 0, ...patch });

it("提交之后再说「尚未提交」就是错的", () => {
  expect(txStateText(entry(false, 1000), epoch({ commitAt: 2000 }))).toBe("已提交");
});

it("提交之前的写入仍是未提交", () => {
  expect(txStateText(entry(false, 3000), epoch({ commitAt: 2000 }))).toContain("尚未提交");
});

it("先提交再回滚：那次提交的写入已经落库，不能说被撤销", () => {
  const e = epoch({ action: "rollback", commitAt: 2000, rollbackAt: 4000, at: 4000 });
  expect(txStateText(entry(false, 1000), e)).toBe("已提交");
  // 提交之后才执行的写入，跟着回滚撤掉了。
  expect(txStateText(entry(false, 3000), e)).toContain("已回滚");
});

it("自动提交、未知与老结果各有说法", () => {
  expect(txStateText(entry(true, 1000), epoch({}))).toBe("已自动提交");
  expect(txStateText({ kind: "update" } as never, epoch({}))).toBe("提交状态待核对");
  expect(txStateText(entry(false, 0), epoch({ commitAt: 2000 }))).toContain("见上方事务条");
});
