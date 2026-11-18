/**
 * 结果页「带出子表明细」（纯逻辑 + 可测的副作用边界，不碰 React / monaco）。
 *
 * 场景：查完主表结果，手里已经有数据，最想顺着关系看子表明细。编辑器侧的表名 chip
 * 覆盖的是「写 SQL 时」；这里补的是「查完之后」这个时机。
 *
 * 🔴 只认**已读到的**关系：走 `peekSqlBusinessMetadata` 的同步副本，没读到就整个
 * 不显示。说了「支持联查」却点不动，比不标更糟（与 `sqlBillHint` 同一条规矩）。
 *
 * 交互：能生成联查 SQL 就生成（调用方填入编辑器，执不执行由用户定）；生成不了
 * （列读不到 / 模板不成立）就退回「定位到编辑器里那条 SQL」，用户用表名旁的 chip 自己来。
 */
import { connOf, rtOf } from "./dbStore";
import { peekSqlBusinessMetadata, readSqlBusinessMetadata } from "./sqlBusiness";
import { sqlAssistScope } from "./sqlAssistLearning";
import { billQueryRelations, billQueryTemplates } from "./sqlBillTemplates";
import { sqlAssistColumns } from "./sqlAssistColumns";
import { getSqlFormatPrefs } from "./sqlFormatPrefs";
import { plainName } from "./sqlBillHint";

/** 主表 + 已知关联表数。`null` = 没什么可提示的。 */
export function relationHintOf(connId: string | null | undefined, table: string): { table: string; count: number } | null {
  if (!connId || !table) return null;
  const scope = sqlAssistScope(connId);
  const available = (rtOf(connId).tables ?? []).map((t) => t.name);
  if (!scope || !available.length) return null;
  const count = billQueryRelations(plainName(table), available, peekSqlBusinessMetadata(connId, scope, table)).length;
  return count > 0 ? { table, count } : null;
}

export type DeepDivePlan = { kind: "sql"; sql: string } | { kind: "locate"; line: number };

/**
 * 点「带出子表明细」之后干什么。读列失败、主表没有 vbillcode 等一切生成不了的情形
 * 都退回定位——那条路永远走得通（chip 在编辑器里等着）。
 */
export async function planDeepDive(input: { connId: string; table: string; line: number }): Promise<DeepDivePlan> {
  const { connId, table, line } = input, root = plainName(table);
  const locate: DeepDivePlan = { kind: "locate", line };
  const rt = rtOf(connId);
  const scope = sqlAssistScope(connId);
  const available = (rt.tables ?? []).map((t) => t.name);
  if (!scope || rt.status !== "connected") return locate;
  const relations = billQueryRelations(root, available, peekSqlBusinessMetadata(connId, scope, root)).slice(0, 8);
  if (!relations.length) return locate;
  const current = () => rt.status === "connected";
  const rootColumns = await sqlAssistColumns(connId, root, current, true).catch(() => []);
  if (!rootColumns.length) return locate;
  // 与 `sqlBillAssist.billActions` 同一口径：子表最多读 3 张，读不到就少一张关联，
  // 不因为一张表读失败把整件事搅黄（剩下的关系照样能生成）。
  const others = [...new Set(relations.map((r) => r.table))].slice(0, 3);
  const related = await Promise.all(others.map(async (other) => [other, await sqlAssistColumns(connId, other, current).catch(() => [])] as const));
  const columns = { [root]: rootColumns, ...Object.fromEntries(related) };
  const upper = getSqlFormatPrefs().keywordCase !== "lower";
  const sql = billQueryTemplates(root, rt.ncNames ?? {}, columns, relations, upper, "plsql")[0]?.sql;
  return sql ? { kind: "sql", sql } : locate;
}

/** 编辑器里有没有这个连接（断开时结果页照样显示历史结果，但深挖需要元数据）。 */
export const canDeepDive = (connId: string | null | undefined): boolean => !!connId && !!connOf(connId) && rtOf(connId).status === "connected";

/**
 * 结果页用的关系预热，与编辑器侧 `sqlAssistGhost` 同一口径（光标在表名上停 400ms
 * 才读）。区别只在时机：查完 SQL 时光标未必在表名上停过，快照里常常还没有这张表，
 * 于是这里补读一次；读到了调用方重画，`relationHintOf` 才可能有值。
 *
 * `warmed` 去重（同一张表一个会话只读一次），上限 128 条防泄漏；读失败不重试——
 * 下一次换结果标签重挂这个视图时 `warmed` 里已有记录，反而不会再读，所以失败要清掉。
 */
const warmed = new Set<string>();
export function warmResultRelations(connId: string | null | undefined, table: string): Promise<void> {
  if (!connId || !table) return Promise.resolve();
  const scope = sqlAssistScope(connId);
  if (!scope) return Promise.resolve();
  const key = `${connId}|${scope}|${table.toLowerCase()}`;
  if (warmed.has(key) || peekSqlBusinessMetadata(connId, scope, table)) return Promise.resolve();
  warmed.add(key);
  if (warmed.size > 128) warmed.delete(warmed.keys().next().value!);
  return readSqlBusinessMetadata(connId, scope, table).then(() => undefined, () => { warmed.delete(key); });
}
