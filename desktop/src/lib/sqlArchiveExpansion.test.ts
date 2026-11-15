import { describe, expect, it } from "vitest";
import type { ColumnInfo } from "./dbApi";
import type { SqlBusinessMetadata, SqlBusinessRelation } from "./sqlBusiness";
import { analyzeSql, sqlScopeAt } from "./sqlScope";
import { archiveExpansion, archiveProjectionAt, archiveRelations } from "./sqlArchiveExpansion";

const col = (name: string, zh: string | null = null, pk = false) => ({ name, zh, pk, full: "VARCHAR2(30)" } as ColumnInfo);
const field = col("PK_ITEM", "物料"), sourceColumns = [field, col("ORG_ID")];
const target = [col("ITEM_ID", null, true), col("ITEM_NUMBER", "物料编码"), col("ITEM_TITLE", "物料名称")];
const relation: SqlBusinessRelation = { id: "外键:item", kind: "外键", source: "ORDER_LINES", target: "ITEM_CATALOG", from: ["PK_ITEM"], to: ["ITEM_ID"] };
const metadata: SqlBusinessMetadata = { table: "order_lines", relations: [relation], enums: [], partial: false, sharedSession: false };
const available = ["ORDER_LINES", "ITEM_CATALOG"];
function context(sql = "SELECT a.pk_item FROM order_lines a WHERE a.org_id = '1';", occurrence = 0) {
  const analysis = analyzeSql(sql, "plsql"), start = sql.indexOf("pk_item", occurrence), end = start + 7;
  const source = sqlScopeAt(analysis, start)!.sources[0];
  return { sql, analysis, source, projection: archiveProjectionAt(analysis, start, end, source) };
}
function expand(ctx = context(), columns = target, r = relation) {
  return ctx.projection && archiveExpansion(ctx.analysis, ctx.projection, ctx.source, field, sourceColumns, r, columns, true);
}
function apply(ctx: ReturnType<typeof context>, result: NonNullable<ReturnType<typeof expand>>) {
  const edits = [{ start: ctx.projection!.start, end: ctx.projection!.end, text: result.insertText }, ...(result.join ? [{ start: result.join.offset, end: result.join.offset, text: result.join.text }] : [])];
  return edits.sort((a, b) => b.start - a.start).reduce((sql, e) => sql.slice(0, e.start) + e.text + sql.slice(e.end), ctx.sql);
}

describe("档案引用字段展开", () => {
  it("保留引用主键，按真实字段描述追加编码名称和LEFT JOIN，WHERE不改变", () => {
    const ctx = context(), result = expand(ctx)!;
    expect(result.insertText).toBe("a.pk_item,\n    ref1.item_number AS pk_item_code,\n    ref1.item_title AS pk_item_name");
    expect(result.join?.offset).toBe(ctx.sql.indexOf("WHERE"));
    expect(apply(ctx, result)).toContain("LEFT JOIN item_catalog ref1\n    ON a.pk_item = ref1.item_id\nWHERE a.org_id = '1';");
  });
  it("仅使用当前表出向且配对完整的已声明关系", () => {
    const { source } = context();
    expect(archiveRelations(source, "pk_item", available, metadata)).toEqual([relation]);
    for (const m of [null, { ...metadata, table: "other" }, { ...metadata, sharedSession: true },
      { ...metadata, relations: [{ ...relation, from: [] }] }, { ...metadata, relations: [{ ...relation, to: ["ITEM_ID", "ORG_ID"] }] },
      { ...metadata, relations: [{ ...relation, source: "ITEM_CATALOG", target: "ORDER_LINES" }] },
      { ...metadata, relations: [{ ...relation, target: "other.ITEM_CATALOG" }] }]) {
      expect(archiveRelations(source, "pk_item", available, m)).toEqual([]);
    }
    expect(archiveRelations(source, "pk_item", ["ORDER_LINES"], metadata)).toEqual([]);
    expect(archiveRelations(source, "pk_item", [...available, "item_catalog"], metadata)).toEqual([]);
    expect(archiveRelations(source, "pk_item", available, { ...metadata, relations: [relation, { ...relation, id: "NC类引用:duplicate", kind: "NC类引用" }] })).toHaveLength(1);
  });
  it("无目标主键、复合键不完整、缺少关联字段时不展开，防止行数膨胀", () => {
    expect(expand(context(), target.map(c => ({ ...c, pk: false })))).toBeUndefined();
    expect(expand(context(), [...target, col("ORG_ID", null, true)])).toBeUndefined();
    expect(expand(context(), target.filter(c => !c.pk))).toBeUndefined();
    expect(expand(context(), target, { ...relation, from: ["missing"] })).toBeUndefined();
  });
  it("完整复合主键生成对应的多个ON条件", () => {
    const r = { ...relation, from: ["PK_ITEM", "ORG_ID"], to: ["ITEM_ID", "ORG_ID"] };
    expect(expand(context(), [...target, col("ORG_ID", null, true)], r)?.join?.text).toContain("ON a.pk_item = ref1.item_id AND a.org_id = ref1.org_id");
  });
  it("Oracle实际小写引用列及表不被折叠成未引用的大写对象", () => {
    const ctx = context('SELECT a."pk_item" FROM order_lines a');
    const lowerField = col("pk_item", "物料");
    expect(archiveExpansion(ctx.analysis, ctx.projection!, ctx.source, lowerField, [lowerField], relation, target, true)).toBeUndefined();
    expect(archiveExpansion(ctx.analysis, ctx.projection!, ctx.source, lowerField, [lowerField, field], relation, target, true)).toBeUndefined();
    expect(archiveExpansion(ctx.analysis, ctx.projection!, ctx.source, field, [lowerField, field], relation, target, true)).toBeUndefined();
    expect(expand(context(), target.map(c => c.name === "ITEM_NUMBER" ? { ...c, name: "item_number" } : c))).toBeUndefined();
    expect(expand(context(), [...target.map(c => c.name === "ITEM_NUMBER" ? { ...c, name: "item_number" } : c), col("ITEM_NUMBER")])).toBeUndefined();
    expect(archiveRelations(context().source, "pk_item", ["ORDER_LINES", "item_catalog"], metadata)).toEqual([]);
  });
  it("编码名称不唯一或未知时隐藏，不能猜一个字段", () => {
    expect(expand(context(), [...target, col("OTHER_CODE", "备用编码")])).toBeUndefined();
    expect(expand(context(), target.filter(c => c.zh !== "物料名称"))).toBeUndefined();
    expect(expand(context(), target.map(c => ({ ...c, zh: null })))).toBeUndefined();
    expect(expand(context(), [target[0], col("CODE"), col("NAME")])?.code).toBe("code");
  });
  it("聚合、函数、算术、DISTINCT、已起别名、集合查询、逗号关联不改写", () => {
    for (const sql of ["SELECT sum(a.pk_item) FROM order_lines a", "SELECT a.pk_item + 1 FROM order_lines a", "SELECT DISTINCT a.pk_item FROM order_lines a",
      "SELECT a.pk_item AS item FROM order_lines a", "SELECT a.pk_item FROM order_lines a GROUP BY a.pk_item", "SELECT a.pk_item FROM order_lines a UNION SELECT pk_item FROM order_lines",
      "SELECT a.pk_item FROM order_lines a, another b", "SELECT a.pk_item FROM order_lines a NATURAL JOIN another b", "SELECT a.pk_item FROM order_lines a JOIN another b USING (org_id)"]) {
      expect(context(sql).projection, sql).toBeUndefined();
    }
  });
  it("不展开固定列数的子查询，保留前后相邻语句", () => {
    for (const sql of ["SELECT (SELECT a.pk_item FROM order_lines a) FROM dual", "SELECT 1 FROM dual WHERE 1 IN (SELECT a.pk_item FROM order_lines a)",
      "SELECT 1 FROM dual WHERE EXISTS (SELECT a.pk_item FROM order_lines a)", "INSERT INTO output(pk_item) SELECT a.pk_item FROM order_lines a",
      "WITH q(pk_item) AS (SELECT a.pk_item FROM order_lines a) SELECT * FROM q"]) expect(context(sql).projection).toBeUndefined();
    const sql = "SELECT 1 FROM dual; SELECT a.pk_item FROM order_lines a WHERE a.org_id='2'; SELECT 2 FROM dual;";
    const ctx = context(sql), result = apply(ctx, expand(ctx)!);
    expect(result).toContain("WHERE a.org_id='2'; SELECT 2 FROM dual;");
    expect(result.startsWith("SELECT 1 FROM dual; SELECT a.pk_item,")).toBe(true);
  });
  it("沿用引用别名，避开已有别名和输出名", () => {
    const ctx = context('SELECT "a".pk_item, a2.pk_item_code FROM order_lines "a" LEFT JOIN another ref1 ON 1=1 JOIN order_lines a2 ON 1=1');
    const result = expand(ctx)!;
    expect(result.insertText).toContain('"a".pk_item');
    expect(result.insertText).toContain("ref2.item_number AS pk_item_code_2");
  });
  it("重复展开复用同一已确认LEFT JOIN，额外ON条件或INNER JOIN不会被复用", () => {
    const ctx = context("SELECT a.pk_item FROM order_lines a LEFT JOIN item_catalog m ON a.pk_item = m.item_id WHERE a.org_id='1';");
    expect(expand(ctx)?.join).toBeUndefined();
    expect(expand(ctx)?.insertText).toContain("m.item_number");
    for (const join of ["INNER JOIN item_catalog m ON a.pk_item = m.item_id", "LEFT JOIN item_catalog m ON a.pk_item = m.item_id AND m.dr=0"]) {
      expect(expand(context("SELECT a.pk_item FROM order_lines a " + join))?.join).toBeDefined();
    }
  });
  it("无WHERE时在语句结尾插入，末尾行注释不会吞掉JOIN", () => {
    const ctx = context("SELECT a.pk_item FROM order_lines a -- keep\n;");
    expect(apply(ctx, expand(ctx)!)).toContain("-- keep\n\nLEFT JOIN item_catalog ref1");
  });
});
