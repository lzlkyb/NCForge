/**
 * 选区上能做什么：`Ctrl+.` 菜单的判定真源。
 *
 * 「转为 IN 条件」「检查重复」「汇总」三个动作的实现都在 editor action 里
 * （`sqlBatchAssist` / `sqlQueryCheckAssist`），它们要等**异步读库**之后才
 * `executeEdits`。而 CodeAction 的 `edit` 必须同步返回——所以菜单里只放
 * **命令型** action（`{ title, command }`），选中后转调同一个 editor action。
 * 判定与实现都不复制，否则「菜单里有、点了报错」是迟早的事。
 *
 * 这里直接复用那两个实现自己的**入参校验**：`sqlBatchTarget` / `selectedQueryFields`
 * 抛错即不可用。另写一套「选区像不像一列值」的启发式，必然与真正执行时的判据分叉。
 *
 * 代价：两个校验都会解析一次全文。`sqlSelectionAssist` 按「模型版本 + 选区」缓存，
 * 光标在同一处移动不会重复算。
 */
import type { SqlLanguage } from "sql-formatter";
import { sqlBatchTarget } from "./sqlBatchConditions";
import { selectedQueryFields } from "./sqlQueryChecks";

export type SqlSelectionActionId = "batch.in" | "check.duplicates" | "check.summary";

export interface SqlSelectionAction {
  id: SqlSelectionActionId;
  title: string;
  detail: string;
  /** 真正干活的 editor action id（`ncforge.sql.runAction` 的参数）。 */
  actionId: string;
}

const BATCH_IN: SqlSelectionAction = { id: "batch.in", title: "转为 IN 条件", detail: "把选中的一列值转成 IN (...) 条件", actionId: "ncforge.sql.batchIn" };
const CHECK_DUPLICATES: SqlSelectionAction = { id: "check.duplicates", title: "按所选字段检查重复（全表）", detail: "全表范围，原 WHERE 条件不带入", actionId: "ncforge.sql.checkDuplicates" };
const CHECK_SUMMARY: SqlSelectionAction = { id: "check.summary", title: "按所选明细字段汇总（全表）", detail: "全表范围，原 WHERE 条件不带入", actionId: "ncforge.sql.detailSummary" };

/** 选区上可用的动作，按展示顺序返回；空数组 = 这个选区什么都不给。 */
export function sqlSelectionActions(sql: string, start: number, end: number, dialect: SqlLanguage): SqlSelectionAction[] {
  if (start < 0 || start >= end || end > sql.length) return [];
  const actions: SqlSelectionAction[] = [];
  // 一列值（粘贴自 Excel）→ IN 条件。判据含「光标得在 WHERE/ON/IN 里」。
  try { sqlBatchTarget(sql, start, end, dialect); actions.push(BATCH_IN); } catch { /* 不是一列值 */ }
  // 查重与汇总只支持 Oracle：`selectedQueryFields` 内部硬编码了 plsql 解析。
  if (dialect !== "plsql") return actions;
  try {
    if (selectedQueryFields(sql, start, end).fieldNames.length) actions.push(CHECK_DUPLICATES, CHECK_SUMMARY);
  } catch { /* 不是一条可解析的投影字段列表 */ }
  return actions;
}
