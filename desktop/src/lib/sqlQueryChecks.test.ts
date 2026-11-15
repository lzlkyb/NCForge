import { describe, expect, it } from "vitest";
import type { ColumnInfo } from "./dbApi";
import type { SqlBusinessMetadata, SqlBusinessRelation } from "./sqlBusiness";
import type { BillQueryRelation } from "./sqlBillTemplates";
import { buildBillRelationChecks, buildDetailSummaryChecks, buildDuplicateCombinationCheck, buildIncomingDetailCountChecks, selectedQueryFields, type SqlQueryCheckContext } from "./sqlQueryChecks";

const column = (name: string, type = "VARCHAR2", pk = false): ColumnInfo => ({ name, type, pk, size: 40, full: type, nullable: !pk, default: null, comment: null, zh: null });
const context: SqlQueryCheckContext = {
  tables: ["ROOT_HEAD", "LINE_ITEMS"],
  columns: {
    root_head: [column("KEY_A", "VARCHAR2", true), column("KEY_B", "VARCHAR2", true), column("TITLE")],
    line_items: [column("REF_A"), column("REF_B"), column("AMOUNT", "NUMBER"), column("QUANTITY", "BINARY_DOUBLE"), column("NOTE"), column("DUPLICATE_COUNT")],
  },
  names: { root_head: "主记录", line_items: "明细记录" },
};
const businessRelation: SqlBusinessRelation = { id: "外键:line_parent", source: "LINE_ITEMS", target: "ROOT_HEAD", from: ["REF_A", "REF_B"], to: ["KEY_A", "KEY_B"], kind: "外键" };
const metadata = (table = "LINE_ITEMS", relations = [businessRelation]): SqlBusinessMetadata => ({ table, relations, enums: [], partial: false, sharedSession: false });
const billRelation: BillQueryRelation = { table: "line_items", rootColumns: ["key_a", "key_b"], otherColumns: ["ref_a", "ref_b"], source: "外键 · line_parent" };
function selection(before: string, fields: string, after: string) {
  return { sql: before + fields + after, start: before.length, end: before.length + fields.length };
}
const duplicate = (s: ReturnType<typeof selection>, c = context) => buildDuplicateCombinationCheck(s.sql, s.start, s.end, c);
const summary = (s: ReturnType<typeof selection>, m: SqlBusinessMetadata | null = metadata(), c = context) => buildDetailSummaryChecks(s.sql, s.start, s.end, m, c);
const amounts = selection("SELECT ", "l.amount, l.quantity", " FROM line_items l");

describe("主子数据核查", () => {
  it("两个方向保留完整复合键，孤立记录排除任意空引用键", () => {
    const [missing, orphan] = buildBillRelationChecks("root_head", [billRelation], context);
    expect(missing).toMatchObject({ scope: "whole-table", kind: "missing-related", root: "ROOT_HEAD", related: "LINE_ITEMS" });
    expect(missing.sql).toContain("FROM ROOT_HEAD a\nWHERE NOT EXISTS");
    expect(missing.sql).toContain("WHERE b.REF_A = a.KEY_A AND b.REF_B = a.KEY_B");
    expect(orphan.sql).toContain("WHERE b.REF_A IS NOT NULL AND b.REF_B IS NOT NULL\n  AND NOT EXISTS");
    expect(orphan.sql).toContain("FROM ROOT_HEAD a\n    WHERE b.REF_A = a.KEY_A AND b.REF_B = a.KEY_B");
    expect(orphan.label).toContain("全表，关联键非 NULL");
    expect(orphan.hint).toContain("排除任一关联键为 NULL");
  });
  it("没有关系、不完整配对、真实列缺失时不猜", () => {
    expect(buildBillRelationChecks("root_head", [], context)).toEqual([]);
    for (const r of [{ ...billRelation, otherColumns: ["ref_a"] }, { ...billRelation, rootColumns: [] },
      { ...billRelation, rootColumns: ["key_a", "missing"] }, { ...billRelation, rootColumns: ["key_a", "key_a"] }]) {
      expect(buildBillRelationChecks("root_head", [r], context)).toEqual([]);
    }
  });
  it.each(["CLOB", "BLOB", "LONG", "RAW(16)", "", "NC_REFERENCE"])("关联两侧不可靠类型不生成Oracle等值核查：%s", type => {
    for (const table of ["root_head", "line_items"] as const) {
      const field = table === "root_head" ? "KEY_A" : "REF_A";
      const c = { ...context, columns: { ...context.columns, [table]: context.columns[table]!.map(columnInfo => columnInfo.name === field ? { ...columnInfo, type, full: type } : columnInfo) } };
      expect(buildBillRelationChecks("root_head", [billRelation], c)).toEqual([]);
    }
  });
  it("接受折叠关系描述，但实际表与列必须唯一且为大写库存", () => {
    expect(buildBillRelationChecks("ROOT_HEAD", [{ ...billRelation, rootColumns: ["KEY_A", "KEY_B"] }], context)).toHaveLength(2);
    for (const c of [
      { ...context, tables: ["Root_Head", "LINE_ITEMS"] },
      { ...context, tables: [...context.tables, "root_head"] },
      { ...context, columns: { ...context.columns, line_items: [column("Ref_A"), column("REF_B")] } },
      { ...context, columns: { ...context.columns, line_items: [...context.columns.line_items!, column("ref_a")] } },
    ]) expect(buildBillRelationChecks("root_head", [billRelation], c)).toEqual([]);
    expect(buildBillRelationChecks("root_head", [{ ...billRelation, rootColumns: ["Key_A", "key_b"] }], context)).toEqual([]);
  });
  it("重复证据合并，关键词设置不改变实际标识符", () => {
    const checks = buildBillRelationChecks("root_head", [billRelation, billRelation], { ...context, upper: false });
    expect(checks).toHaveLength(2);
    expect(checks[0].sql).toContain("select a.*\nfrom ROOT_HEAD a\nwhere not exists");
  });
});

describe("完整 SELECT 字段选区", () => {
  it("先解析统一来源，无元数据时只返回字段引用和来源", () => {
    const s = selection("-- 说明\nSELECT h.*, ", "  l.amount,\n l.quantity  ", " FROM root_head h LEFT JOIN line_items l ON l.ref_a=h.key_a WHERE h.title='ok';");
    expect(selectedQueryFields(s.sql, s.start, s.end)).toMatchObject({ table: "line_items", fieldNames: ["amount", "quantity"], fieldRefs: ["l.amount", "l.quantity"], hadWhere: true, start: s.start + 2, end: s.end - 2 });
  });
  it("完整字段可以是单表无别名，或准确匹配的引号别名", () => {
    for (const s of [selection("SELECT ", "amount, quantity", " FROM line_items"), selection("SELECT ", '"L".amount', ' FROM line_items "L"')]) {
      expect(selectedQueryFields(s.sql, s.start, s.end).table).toBe("line_items");
    }
  });
  it.each([
    ["SELECT ", "sum(l.amount)", " FROM line_items l"],
    ["SELECT ", "l.amount + l.quantity", " FROM line_items l"],
    ["SELECT ", "l.amount", " total FROM line_items l"],
    ["SELECT l.", "amount", " FROM line_items l"],
    ["SELECT ", "l.amount", " + 1 FROM line_items l"],
    ["SELECT ", "l.amount,", " l.quantity FROM line_items l"],
    ["SELECT ", "amount", " FROM root_head h JOIN line_items l ON l.ref_a=h.key_a"],
    ["SELECT ", "h.key_a, l.ref_a", " FROM root_head h JOIN line_items l ON l.ref_a=h.key_a"],
    ["SELECT ", "l.amount", " FROM line_items l JOIN line_items l ON 1=1"],
    ["SELECT ", 'l."AMOUNT"', " FROM line_items l"],
    ["SELECT ", "amount", ' FROM "LINE_ITEMS"'],
    ["WITH x AS (SELECT * FROM line_items) SELECT ", "amount", " FROM x"],
    ["INSERT INTO other SELECT ", "amount", " FROM line_items"],
    ["SELECT * FROM (SELECT ", "amount", " FROM line_items) x"],
    ["SELECT DISTINCT ", "amount", " FROM line_items"],
    ["SELECT ", "amount", " FROM line_items GROUP BY amount"],
    ["SELECT ", "amount", " FROM line_items UNION SELECT amount FROM line_items"],
    ["BEGIN SELECT ", "amount", " FROM line_items; END;"],
  ])("不在表达式、别名、歧义或固定输出查询中猜选区：%s", (before, fields, after) => {
    const s = selection(before, fields, after);
    expect(() => selectedQueryFields(s.sql, s.start, s.end)).toThrow();
  });
  it("独立语句可以位于脚本中，选区跨语句或半个字段不能通过", () => {
    const s = selection("SELECT * FROM root_head;\nSELECT ", "l.amount", " FROM line_items l;");
    expect(selectedQueryFields(s.sql, s.start, s.end).table).toBe("line_items");
    expect(() => selectedQueryFields(s.sql, s.start + 1, s.end)).toThrow();
    expect(() => selectedQueryFields(s.sql, 0, s.end)).toThrow();
  });
});

describe("重复字段组合检查", () => {
  it("按用户真实字段组合生成全表独立SQL，原WHERE不搬运", () => {
    const s = selection("SELECT ", "l.ref_a, l.ref_b", " FROM line_items l WHERE l.note='x'");
    const result = duplicate(s);
    expect(result).toMatchObject({ scope: "whole-table", hadWhere: true, kind: "duplicate-combination" });
    expect(result.sql).toBe("SELECT a.REF_A, a.REF_B, COUNT(*) AS DUPLICATE_COUNT\nFROM LINE_ITEMS a\nGROUP BY a.REF_A, a.REF_B\nHAVING COUNT(*) > 1;");
    expect(result.hint).toContain("原 SELECT 的 WHERE 条件不带入");
    expect(result.sql).not.toContain("note");
  });
  it("在已有JOIN查询中只按统一来源检查，新SQL不带JOIN", () => {
    const s = selection("SELECT h.*, ", "l.ref_a, l.ref_b", " FROM root_head h JOIN line_items l ON l.ref_a=h.key_a");
    expect(duplicate(s).sql).toContain("FROM LINE_ITEMS a\nGROUP BY a.REF_A, a.REF_B");
    expect(duplicate(s).sql).not.toContain("JOIN");
  });
  it("拒绝未知、重复或混合实际列以及不唯一表库存", () => {
    expect(() => duplicate(selection("SELECT ", "missing", " FROM line_items"))).toThrow("元数据");
    expect(() => duplicate(selection("SELECT ", "amount, amount", " FROM line_items"))).toThrow("重复字段");
    const s = selection("SELECT ", "amount", " FROM line_items");
    expect(() => duplicate(s, { ...context, columns: { ...context.columns, line_items: [column("Amount")] } })).toThrow("元数据");
    expect(() => duplicate(s, { ...context, tables: [...context.tables, "line_items"] })).toThrow("元数据");
  });
  it("COUNT别名避开选中的同名字段，schema只接受已确认当前范围", () => {
    const s = selection("SELECT ", "duplicate_count", " FROM line_items");
    expect(duplicate(s).sql).toContain("COUNT(*) AS DUPLICATE_COUNT_2");
    const qualified = selection("SELECT ", "l.amount", " FROM nc.line_items l");
    expect(() => duplicate(qualified)).toThrow("schema");
    expect(duplicate(qualified, { ...context, schema: "NC" }).sql).toContain("FROM LINE_ITEMS a");
    expect(() => duplicate(qualified, { ...context, schema: "OTHER" })).toThrow("schema");
  });
  it.each(["CHAR(20)", "NCHAR(20)", "VARCHAR2(40 CHAR)", "NVARCHAR2(40)", "NUMBER(18,2)", "FLOAT(126)", "BINARY_FLOAT", "BINARY_DOUBLE", "DATE", "TIMESTAMP", "TIMESTAMP(6)", "TIMESTAMP(6) WITH TIME ZONE", "TIMESTAMP WITH LOCAL TIME ZONE"])("仅开放实际可分组的常见Oracle类型：%s", type => {
    const c = { ...context, columns: { ...context.columns, line_items: [column("VALUE_FIELD", type)] } };
    expect(duplicate(selection("SELECT ", "value_field", " FROM line_items"), c).sql).toContain("GROUP BY a.VALUE_FIELD");
  });
  it.each(["CLOB", "NCLOB", "BLOB", "BFILE", "LONG", "LONG RAW", "RAW(16)", "XMLTYPE", "CUSTOM_OBJECT", "", "NUMBER_EXTRA", "TIMESTAMP_EXTRA"])("不可分组或未知类型不猜：%s", type => {
    const c = { ...context, columns: { ...context.columns, line_items: [column("VALUE_FIELD", type)] } };
    expect(() => duplicate(selection("SELECT ", "value_field", " FROM line_items"), c)).toThrow("可分组");
  });
  it("字段组合中的任一不支持类型都会拒绝整条检查，缺失类型给明确提示", () => {
    const s = selection("SELECT ", "ref_a, note", " FROM line_items");
    const columns = [column("REF_A"), column("NOTE", "CLOB")];
    expect(() => duplicate(s, { ...context, columns: { ...context.columns, line_items: columns } })).toThrow("大对象");
    const missing = { ...column("NOTE"), type: undefined, full: undefined } as unknown as ColumnInfo;
    expect(() => duplicate(s, { ...context, columns: { ...context.columns, line_items: [columns[0], missing] } })).toThrow("未知类型");
  });
});

describe("明细预聚合汇总", () => {
  it("复合键预聚合多个数值列，外层每主记录一行且无明细为0", () => {
    const [result] = summary(amounts);
    expect(result).toMatchObject({ root: "ROOT_HEAD", related: "LINE_ITEMS", kind: "detail-summary", scope: "whole-table" });
    expect(result.sql).toContain("SELECT p.*,\n       NVL(d.DETAIL_COUNT, 0) AS DETAIL_COUNT,\n       NVL(d.SUM_AMOUNT, 0) AS SUM_AMOUNT,\n       NVL(d.SUM_QUANTITY, 0) AS SUM_QUANTITY");
    expect(result.sql).toContain("LEFT JOIN (\n    SELECT c.REF_A, c.REF_B,\n           COUNT(*) AS DETAIL_COUNT,\n           SUM(c.AMOUNT) AS SUM_AMOUNT,\n           SUM(c.QUANTITY) AS SUM_QUANTITY\n    FROM LINE_ITEMS c\n    GROUP BY c.REF_A, c.REF_B\n) d\n    ON d.REF_A = p.KEY_A AND d.REF_B = p.KEY_B;");
    expect(result.sql.match(/COUNT\(\*\)/g)).toHaveLength(1);
    expect(result.sql).not.toContain("GROUP BY p.");
    expect(result.hint).toContain("每张主表一行，无明细为 0");
  });
  it("仅incoming计数同样先按完整父主键聚合，不写外层COUNT(*)", () => {
    const [result] = buildIncomingDetailCountChecks("root_head", metadata("ROOT_HEAD"), context);
    expect(result.kind).toBe("detail-count");
    expect(result.sql).toContain("COUNT(*) AS DETAIL_COUNT");
    expect(result.sql).toContain("NVL(d.DETAIL_COUNT, 0) AS DETAIL_COUNT");
    expect(result.sql).not.toContain("SUM(");
    expect(buildIncomingDetailCountChecks("line_items", metadata(), context)).toEqual([]);
  });
  it("没有完整父主键、关系错误方向、共享会话或缺列时不提供模板", () => {
    expect(summary(amounts, null)).toEqual([]);
    expect(summary(amounts, { ...metadata(), sharedSession: true })).toEqual([]);
    expect(summary(amounts, metadata("OTHER"))).toEqual([]);
    expect(summary(amounts, metadata("LINE_ITEMS", [{ ...businessRelation, source: "ROOT_HEAD", target: "LINE_ITEMS" }]))).toEqual([]);
    expect(summary(amounts, metadata("LINE_ITEMS", [{ ...businessRelation, from: ["REF_A"], to: ["KEY_A"] }]))).toEqual([]);
    expect(summary(amounts, metadata("LINE_ITEMS", [{ ...businessRelation, from: ["REF_A", "missing"] }]))).toEqual([]);
    expect(summary(amounts, metadata(), { ...context, columns: { ...context.columns, root_head: context.columns.root_head!.map(c => ({ ...c, pk: false })) } })).toEqual([]);
    expect(buildIncomingDetailCountChecks("root_head", metadata("ROOT_HEAD", [{ ...businessRelation, from: ["REF_A"], to: ["KEY_A"] }]), context)).toEqual([]);
  });
  it("按完整PK集合核验，配对顺序始终与关系一致", () => {
    const reversed = { ...businessRelation, from: ["ref_b", "ref_a"], to: ["key_b", "key_a"] };
    expect(summary(amounts, metadata("LINE_ITEMS", [reversed]))[0].sql).toContain("ON d.REF_B = p.KEY_B AND d.REF_A = p.KEY_A");
    expect(summary(amounts, metadata("LINE_ITEMS", [{ ...businessRelation, to: ["KEY_A", "TITLE"] }]))).toEqual([]);
  });
  it.each(["CLOB", "BLOB", "LONG", "RAW(16)", "", "NC_REFERENCE"])("关联分组键类型不可靠时不生成计数或汇总：%s", type => {
    const c = { ...context, columns: { ...context.columns, line_items: context.columns.line_items!.map(field => field.name === "REF_A" ? column("REF_A", type) : field) } };
    expect(summary(amounts, metadata(), c)).toEqual([]);
    expect(buildIncomingDetailCountChecks("root_head", metadata("ROOT_HEAD"), c)).toEqual([]);
  });
  it.each(["VARCHAR2", "DATE", "TIMESTAMP", "CLOB", "", "NUMBER_EXTRA"])("数字外观不能代替实际数值类型：%s", type => {
    const c = { ...context, columns: { ...context.columns, line_items: [...context.columns.line_items!.filter(c => c.name !== "AMOUNT"), column("AMOUNT", type)] } };
    expect(() => summary(selection("SELECT ", "amount", " FROM line_items"), metadata(), c)).toThrow("数值字段");
  });
  it("SUM优先完整物理类型并回退基础类型，元数据缺失仍明确拒绝", () => {
    const s = selection("SELECT ", "amount", " FROM line_items");
    for (const field of [{ ...column("AMOUNT"), type: "", full: "NUMBER(18,2)" }, { ...column("AMOUNT", "NUMBER"), full: "" }]) {
      const c = { ...context, columns: { ...context.columns, line_items: [...context.columns.line_items!.filter(c => c.name !== "AMOUNT"), field] } };
      expect(summary(s, metadata(), c)[0].sql).toContain("SUM(c.AMOUNT)");
      expect(duplicate(s, c).sql).toContain("GROUP BY a.AMOUNT");
    }
    const missing = { ...column("AMOUNT"), type: undefined, full: undefined } as unknown as ColumnInfo;
    const c = { ...context, columns: { ...context.columns, line_items: [...context.columns.line_items!.filter(c => c.name !== "AMOUNT"), missing] } };
    expect(() => summary(s, metadata(), c)).toThrow("数值字段");
    const fullClob = { ...missing, type: "NUMBER", full: "CLOB" };
    const invalid = { ...c, columns: { ...c.columns, line_items: [...c.columns.line_items!.filter(c => c.name !== "AMOUNT"), fullClob] } };
    expect(() => summary(s, metadata(), invalid)).toThrow("数值字段");
  });
  it("旧查询WHERE不会搬到明细聚合，关键词大小写保留", () => {
    const s = selection("SELECT ", "l.amount", " FROM line_items l WHERE l.amount > 100");
    const [result] = summary(s, metadata(), { ...context, upper: false });
    expect(result.hadWhere).toBe(true);
    expect(result.sql).toContain("sum(c.AMOUNT) as SUM_AMOUNT");
    expect(result.sql).not.toContain("100");
    expect(result.hint).toContain("原 WHERE 条件不带入");
  });
  it("结果别名避开父列和分组字段，长别名保持Oracle30字符范围", () => {
    const long = "EXTREMELY_LONG_NUMERIC_COLUMN";
    const c: SqlQueryCheckContext = { ...context, columns: {
      root_head: [...context.columns.root_head!, column("DETAIL_COUNT"), column("SUM_AMOUNT")],
      line_items: [...context.columns.line_items!, column(long, "FLOAT")],
    } };
    const [result] = summary(selection("SELECT ", `amount, ${long.toLowerCase()}`, " FROM line_items"), metadata(), c);
    expect(result.sql).toContain("COUNT(*) AS DETAIL_COUNT_2");
    expect(result.sql).toContain("SUM(c.AMOUNT) AS SUM_AMOUNT_2");
    for (const match of result.sql.matchAll(/\bAS ([A-Z_0-9]+)/g)) expect(match[1].length).toBeLessThanOrEqual(30);
    const changed = { ...businessRelation, from: ["DETAIL_COUNT", "REF_B"] };
    const child = { ...c, columns: { ...c.columns, line_items: [...c.columns.line_items!, column("DETAIL_COUNT")] } };
    expect(summary(amounts, metadata("LINE_ITEMS", [changed]), child)[0].sql).toContain("COUNT(*) AS DETAIL_COUNT_2");
  });
  it("不同证据同一配对去重，每个父关系独立汇总，最多8候选", () => {
    expect(summary(amounts, metadata("LINE_ITEMS", [businessRelation, { ...businessRelation, id: "NC类引用:other", kind: "NC类引用" }]))).toHaveLength(1);
    const parents = Array.from({ length: 10 }, (_, i) => `PARENT_${i}`);
    const c: SqlQueryCheckContext = { ...context, tables: [...context.tables, ...parents], columns: { ...context.columns, ...Object.fromEntries(parents.map(t => [t.toLowerCase(), context.columns.root_head])) } };
    const relations = parents.map(target => ({ ...businessRelation, target, id: `外键:${target}` }));
    const checks = summary(amounts, metadata("LINE_ITEMS", relations), c);
    expect(checks).toHaveLength(8);
    expect(checks.map(c => c.root)).toEqual(parents.slice(0, 8));
    expect(checks.every(c => c.sql.match(/LEFT JOIN/g)?.length === 1)).toBe(true);
  });
});
