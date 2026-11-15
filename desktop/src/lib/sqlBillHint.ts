/**
 * 表名补全项上的「主子表联查」说明（纯逻辑，不碰 monaco，可单测）。
 *
 * 那些联查模板只在「新语句开头直接打表名」时才进补全列表（`sqlAssistProvider`
 * 的 `bare` 分支）。用户按最常见的 `SELECT * FROM po_...` 写法永远撞不到，所以
 * 在表名项自己的说明里先把它说清楚。
 *
 * 🔴 只认**已读到的**关系：走 `peekSqlBusinessMetadata` 的同步副本，没读到就
 * 不说话。说了「支持联查」却点不出东西，比不标更糟。
 */
import { peekSqlBusinessMetadata } from "./sqlBusiness";
import { billQueryRelations } from "./sqlBillTemplates";

export const pureName = (name: string) => /^[a-z_][\w$#]*$/i.test(name) && (name === name.toUpperCase() || name === name.toLowerCase());
export const plainName = (name: string) => /[a-z]/.test(name) && /[A-Z]/.test(name) ? name : name.toLowerCase();

/** 该表能联查几个关联表。没读到关系返回 0，不猜。 */
export function billLinkHint(connId: string, scopeKey: string, table: string, available: readonly string[]): string {
  const meta = peekSqlBusinessMetadata(connId, scopeKey, table);
  if (!meta) return "";
  const count = billQueryRelations(plainName(table), available, meta).length;
  return count ? `${count} 个关联表 · 支持主子表联查` : "";
}

interface TableDescInput {
  zh: string; view: boolean; why: string;
  connId: string; scope: string | null; prefix: string; name: string; available: readonly string[];
}

/**
 * 表名补全项的说明行：`中文名 · 推荐依据 · N 个关联表 · 支持主子表联查`。
 *
 * 关联数只在**表名被完整打出**时才算。空前缀时列表里有几千张表，逐项算关联
 * 会退化成 O(n²)，把补全卡住；而也只有打到完整表名时，用户才真的在挑这张表。
 */
export function sqlTableDescription(input: TableDescInput): string {
  const { prefix, name, zh, scope } = input, lower = prefix.toLowerCase();
  const exact = !!prefix && (name.toLowerCase() === lower || !!zh && zh.toLowerCase() === lower);
  const parts = [zh || (input.view ? "视图" : ""), input.why, exact && scope ? billLinkHint(input.connId, scope, name, input.available) : ""];
  return parts.filter(Boolean).join(" · ");
}
