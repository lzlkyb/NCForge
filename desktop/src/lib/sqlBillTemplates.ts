import type { SqlLanguage } from "sql-formatter";
import { sqlIdentifier } from "./sqlCompletionContext";
import { snippetEscape, type SqlTemplate } from "./sqlTemplates";
import type { SqlBusinessMetadata } from "./sqlBusiness";

type Columns = Readonly<Partial<Record<string, readonly { name: string }[]>>>;
export interface BillQueryTemplate extends SqlTemplate { sql: string; pickField?: boolean }
export interface BillQueryRelation { table: string; rootColumns: string[]; otherColumns: string[]; source: string; incoming?: boolean }

const plain = (name: string) => /^[a-z_][\w$#]*$/i.test(name) && (name === name.toUpperCase() || name === name.toLowerCase());
const usable = (name: string) => plain(name) && sqlIdentifier(name.toLowerCase(), "plsql") === name.toLowerCase();

/** Both directions use declared column pairs; a suffix or a shared field name is not a relationship. */
export function billQueryRelations(table: string, available: readonly string[], metadata: SqlBusinessMetadata | null): BillQueryRelation[] {
  if (!usable(table) || !metadata || metadata.sharedSession || metadata.table.toLowerCase() !== table.toLowerCase()) return [];
  const root = table.toLowerCase(), tables = new Set(available.filter(usable).map(t => t.toLowerCase()));
  if (!tables.has(root)) return [];
  const out: BillQueryRelation[] = [], seen = new Set<string>();
  // Incoming references put detail tables before outgoing references such as organizations.
  const relations = [...metadata.relations].sort((a, b) => Number(b.target.toLowerCase() === root) - Number(a.target.toLowerCase() === root));
  for (const relation of relations) {
    if (![relation.source, relation.target, ...relation.from, ...relation.to].every(usable) || !relation.from.length || relation.from.length !== relation.to.length) continue;
    const from = relation.source.toLowerCase(), to = relation.target.toLowerCase();
    const other = from === root ? to : to === root ? from : "";
    if (!other || other === root || !tables.has(other)) continue;
    const rootColumns = (from === root ? relation.from : relation.to).map(c => c.toLowerCase());
    const otherColumns = (from === root ? relation.to : relation.from).map(c => c.toLowerCase());
    const key = JSON.stringify([other, rootColumns.map((c, i) => [c, otherColumns[i]]).sort()]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ table: other, rootColumns, otherColumns, source: `${relation.kind} · ${relation.id.slice(relation.kind.length + 1)}`, incoming: to === root });
  }
  return out;
}

export function billQueryTemplates(table: string, names: Readonly<Record<string, string>>, columns: Columns, relations: readonly BillQueryRelation[], upper: boolean, dialect: SqlLanguage = "plsql"): BillQueryTemplate[] {
  return queryTemplates(table, names, columns, relations, upper, dialect, true);
}

export function conditionQueryTemplates(table: string, names: Readonly<Record<string, string>>, columns: Columns, relations: readonly BillQueryRelation[], upper: boolean, dialect: SqlLanguage = "plsql"): BillQueryTemplate[] {
  return queryTemplates(table, names, columns, relations, upper, dialect, false);
}

/** Filter in a correlated subquery so the outer relation still returns every matching row. */
export function completeQueryTemplates(table: string, names: Readonly<Record<string, string>>, columns: Columns, relations: readonly BillQueryRelation[], upper: boolean): BillQueryTemplate[] {
  if (!usable(table)) return [];
  const root = table.toLowerCase(), kw = (text: string) => upper ? text : text.toLowerCase();
  const has = (source: string, field: string) => columns[source]?.filter(c => plain(c.name) && c.name.toLowerCase() === field).length === 1;
  return relations.flatMap(relation => {
    if (!usable(relation.table) || !relation.rootColumns.length || relation.rootColumns.length !== relation.otherColumns.length
      || !relation.rootColumns.every((c, i) => usable(c) && usable(relation.otherColumns[i]) && has(root, c) && has(relation.table, relation.otherColumns[i]))) return [];
    const condition = (alias: string) => relation.rootColumns.map((c, i) => `${alias}.${relation.otherColumns[i]} = a.${c}`).join(` ${kw("AND")} `);
    const sql = `${kw("SELECT")} a.*, b.*\n${kw("FROM")} ${root} a\n${kw("LEFT JOIN")} ${relation.table} b\n    ${kw("ON")} ${condition("b")}\n${kw("WHERE EXISTS")} (\n    ${kw("SELECT")} 1\n    ${kw("FROM")} ${relation.table} x\n    ${kw("WHERE")} ${condition("x")}\n      ${kw("AND")} ()\n);`;
    return [{ label: `${names[root] || root} · 按关联条件查完整结果 ${names[relation.table] || relation.table}`, hint: `${relation.source} · 在 x 中筛选，外层 b 保留全部关联行`,
      sql, pickField: true, insertText: snippetEscape(sql).replace(`      ${kw("AND")} ()`, `      ${kw("AND")} (x.$0)`) }];
  });
}

function queryTemplates(table: string, names: Readonly<Record<string, string>>, columns: Columns, relations: readonly BillQueryRelation[], upper: boolean, dialect: SqlLanguage, bill: boolean): BillQueryTemplate[] {
  if (!usable(table)) return [];
  const root = table.toLowerCase(), name = names[root] || root;
  const has = (source: string, field: string) => columns[source]?.filter(c => plain(c.name) && c.name.toLowerCase() === field).length === 1;
  if (bill ? !has(root, "vbillcode") : !columns[root]?.length) return [];
  const kw = (text: string) => upper ? text : text.toLowerCase();
  const finish = (sql: string, label: string, hint: string): BillQueryTemplate => ({
    label, hint, sql, pickField: !bill,
    insertText: bill ? snippetEscape(sql).replace("= '';", "= '$0';") : snippetEscape(sql).slice(0, -1) + "$0;",
  });
  const where = `${kw("WHERE")} ${bill ? "a.vbillcode = ''" : ""};`;
  const templates: BillQueryTemplate[] = [];
  for (const relation of relations) {
    if (!relation.rootColumns.every((c, i) => has(root, c) && has(relation.table, relation.otherColumns[i]))) continue;
    const condition = relation.rootColumns.map((c, i) => `a.${c} = b.${relation.otherColumns[i]}`).join(` ${kw("AND")} `);
    const sql = `${kw("SELECT")} a.*, b.*\n${kw("FROM")} ${root} a\n${kw("LEFT JOIN")} ${relation.table} b\n    ${kw("ON")} ${condition}\n${where}`;
    templates.push(finish(sql, `${name} · ${bill ? "按单号关联" : "关联查询"} ${names[relation.table] || relation.table}`, `${relation.source} · ${condition}`));
  }
  const sql = `${kw("SELECT")} a.*\n${kw("FROM")} ${sqlIdentifier(root, dialect)} a\n${where}`;
  templates.push(finish(sql, `${name} · ${bill ? "按单号查主表" : "主表条件查询"}`, bill ? "已确认单号字段 · 直接在引号中填单号" : "选择条件字段后填写查询值"));
  return templates;
}
