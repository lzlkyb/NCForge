import { describe, expect, it } from "vitest";
import { inspectSqlStatement, resolveSqlInspection, type SqlInspectionCatalog } from "./sqlInspection";
import { scanSql } from "./sqlLex";

function inspect(sql: string, tables: Record<string, string[] | null> = {}, offset = sql.length) {
  const plan = inspectSqlStatement(sql, offset, "plsql")!;
  const catalog: SqlInspectionCatalog = Object.fromEntries(plan.sources.flatMap(({ id, object }) => {
    if (object.declaredColumnKeys) return [[id, { columns: object.declaredColumnKeys }]];
    const columns = tables[object.table!];
    return columns === undefined ? [] : [[id, columns ? { columns } : { unconfirmed: true }]];
  }));
  return resolveSqlInspection(plan, catalog);
}

describe("SQL 执行前检查", () => {
  it("按 Oracle 真实列名检查 SELECT 与 WHERE，精确提供原位替换", () => {
    const sql = "select a.vbillcod from po_order a where a.statu = 1;";
    const issues = inspect(sql, { po_order: ["VBILLCODE", "STATUS"] });
    expect(issues.map(i => [sql.slice(i.start, i.end), i.fixes?.[0]?.text]))
      .toEqual([["vbillcod", "vbillcode"], ["statu", "status"]]);
  });

  it("多表字段歧义仅在字段元数据齐全时提示，USING 里的合并列合法", () => {
    const sql = "select id from orders a join regions b on a.region_id = b.id";
    const [issue] = inspect(sql, { orders: ["ID", "REGION_ID"], regions: ["ID"] });
    expect(issue).toMatchObject({ code: "ambiguous-column", fixes: [{ text: "a.id" }, { text: "b.id" }] });
    expect(inspect(sql, { orders: ["ID", "REGION_ID"] })).toEqual([]);
    expect(inspect("select id from orders a join regions b using(id)", { orders: ["ID"], regions: ["ID"] })).toEqual([]);
  });

  it("目录不可确认时只给中性提示，引用了外层列的子查询不误报", () => {
    const unconfirmed = inspect("select a.id from private_table a", { private_table: null });
    expect(unconfirmed).toEqual([expect.objectContaining({ code: "unverified-object", severity: "info" })]);
    expect(inspect("select (select outer_id from detail d) from orders a", { detail: ["ID"], orders: ["OUTER_ID"] })).toEqual([]);
    expect(inspect("with a as (select * from orders) select a.dynamic_column from a", { orders: ["ID"] })).toEqual([]);
    expect(inspect('with c("Mixed", total) as (select id, 1 from orders) select c.mixed from c', { orders: ["ID"] })[0]?.code).toBe("unknown-column");
    expect(inspect('with c("Mixed", total) as (select id, 1 from orders) select c."Mixed" from c', { orders: ["ID"] })).toEqual([]);
  });

  it("已知别名可以检测引用和重复声明，序列与跨库对象保留原样", () => {
    expect(inspect("select b.id from orders a")[0]?.code).toBe("unknown-qualifier");
    const duplicate = "select a.id from orders a join regions a on a.id = a.id";
    const [issue] = inspect(duplicate);
    expect(issue.code).toBe("duplicate-alias");
    expect(duplicate.slice(issue.start, issue.end)).toBe("a");
    expect(inspect("select seq_orders.nextval from dual")).toEqual([]);
    expect(inspect("select a.id from orders@remote_db a", { orders: ["OTHER_ID"] })).toEqual([]);
  });

  it("MERGE 的目标和来源别名同时作用于 WHEN 分支", () => {
    const sql = "merge into orders a using staged b on (a.id = b.id) when matched then update set a.vbillcod = b.vbillcode";
    const [issue] = inspect(sql, { orders: ["ID", "VBILLCODE"], staged: ["ID", "VBILLCODE"] });
    expect(issue?.code).toBe("unknown-column");
    expect(sql.slice(issue.start, issue.end)).toBe("vbillcod");
    expect(issue.fixes?.[0]?.text).toBe("vbillcode");
  });

  it("引号、括号和未完成子句只报告真实语法边界", () => {
    expect(inspect("select q'[ '; from ]' from dual")).toEqual([]);
    expect(inspect("select /*+ action( */ id from orders")).toEqual([]);
    expect(inspect("select (id from orders")[0]?.code).toBe("unclosed-parenthesis");
    expect(inspect("select 'abc")[0]?.code).toBe("unterminated");
    expect(inspect("select id from")[0]).toMatchObject({ code: "incomplete-clause", severity: "info" });
    expect(inspect("select /* draft */ from dual")[0]?.code).toBe("missing-projection");
  });

  it("超出全文分析阈值的脚本仍准确检查光标语句，保留原文绝对位置", () => {
    const prefix = "select q'[;()]' from dual;\n".repeat(9_000);
    const sql = prefix + "select a.vbillcod from po_order a;";
    const [issue] = inspect(sql, { po_order: ["VBILLCODE"] });
    expect(prefix.length).toBeGreaterThan(200_000);
    expect(issue.start).toBe(prefix.length + "select a.".length);
    expect(sql.slice(issue.start, issue.end)).toBe("vbillcod");
    const analysis = inspectSqlStatement(sql, sql.length, "plsql")?.activeAnalysis;
    expect(analysis?.tokens[0]?.start).toBe(prefix.length);
    expect(analysis?.scopes[0]?.start).toBe(prefix.length);
  });
});

it.each([
  ["postgresql", "ILIKE"], ["tsql", "TOP"], ["mysql", "DELIMITER"], ["mariadb", "REGEXP"], ["db2", "OPTIMIZE"], ["sqlite", "PRAGMA"],
] as const)("方言 %s 给 %s 正确的词法分类", (dialect, word) => {
  expect(scanSql(word, dialect).tokens[0]?.kind).toBe("keyword");
});
