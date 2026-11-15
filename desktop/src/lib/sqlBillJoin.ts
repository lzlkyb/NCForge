/**
 * 表位置（`SELECT * FROM po_order`）的主子表联查片段（纯逻辑，不碰 monaco，可单测）。
 *
 * 整条联查模板只在「新语句开头直接打表名」的裸表名分支进列表（`sqlAssistProvider`
 * 的 `bare`），而 `FROM po_...` 是更常见的写法。这条路径上要给出两样东西：
 * 表名项说明里的「N 个关联表 · 支持主子表联查」（`sqlBillHint`），以及这里可插入的
 * JOIN 片段 —— 只有说明却点不出东西，等于说了不给。
 */
import type { SqlBusinessMetadata } from "./sqlBusiness";
import { billQueryRelations } from "./sqlBillTemplates";
import { plainName } from "./sqlBillHint";

/** 光标前的词精确命中的那张表（小写规范名）。半截前缀不猜。 */
export function billTableOf(prefix: string, names: readonly string[], ncNames: Readonly<Record<string, string>> | undefined, usable: (name: string) => boolean): string {
  if (!prefix) return "";
  const typed = prefix.toLowerCase();
  const hit = names.find(n => plainName(n) === typed)
    ?? names.find(n => (ncNames?.[n.toLowerCase()] ?? "").toLowerCase() === typed);
  if (!hit) return "";
  const name = plainName(hit);
  return usable(name) ? name : "";
}

export interface BillJoinSpec { table: string; sql: string; source: string }

/**
 * 主表能接上的子表 JOIN 片段。
 *
 * 表名与列名都用元数据里的小写规范名：Oracle 不区分大小写，拼出来的片段与用户
 * 手写的 `po_order` 一致，也不会因为 `sqlIdentifier` 给大写名加引号（`"PO_ORDER_B"`）。
 */
export function billJoinSpecs(table: string, available: readonly string[], meta: SqlBusinessMetadata | null, limit = 6): BillJoinSpec[] {
  return billQueryRelations(table, available, meta).slice(0, limit).flatMap(rel => {
    const on = rel.otherColumns.map((column, i) => `${rel.table}.${column} = ${table}.${rel.rootColumns[i]}`).join(" AND ");
    return [{ table: rel.table, sql: ` LEFT JOIN ${rel.table} ON ${on}`, source: rel.source }];
  });
}
