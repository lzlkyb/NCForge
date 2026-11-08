import type { TxInfo } from "./dbApi";

/**
 * 「有没有待提交事务」的唯一裁决，数据库真源优先。
 *
 * 本地 `statements` 只是 DML 计数：手写大写 COMMIT、PL/SQL 内部提交、别的工具回滚之后
 * 它不会归零，用户会被永久挡在「请先提交或回滚」后面。点过「核对事务」后后端会把
 * `v$transaction` 的结论放进 `tx.active`，那时一律以它为准。
 *
 * `dbConfirmed` = null 表示**尚未核对或字典不可读**，此时退回本地推断；
 * 绝不把「查不了」当成「没有事务」。
 */
export function txPending(tx: TxInfo | undefined): { pending: boolean; dbConfirmed: boolean | null } {
  if (!tx) return { pending: false, dbConfirmed: null };
  const dbConfirmed = tx.active === true ? true : tx.active === false ? false : null;
  const pending = dbConfirmed === null
    ? !tx.autoCommit && tx.statements > 0
    : dbConfirmed;
  return { pending, dbConfirmed };
}
