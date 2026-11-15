import { describe, expect, it } from "vitest";
import { billQueryRelations, billQueryTemplates, conditionQueryTemplates, completeQueryTemplates } from "./sqlBillTemplates";
import type { SqlBusinessMetadata, SqlBusinessRelation } from "./sqlBusiness";

const fields = { sales_head: [{ name: "VBILLCODE" }, { name: "HEAD_ID" }], sales_lines: [{ name: "PARENT_ID" }] };
const names = { sales_head: "销售单", sales_lines: "销售明细" };
const relation: SqlBusinessRelation = { id: "NC类引用:line_head", source: "SALES_LINES", target: "SALES_HEAD", from: ["PARENT_ID"], to: ["HEAD_ID"], kind: "NC类引用" };
const metadata = (relations = [relation]): SqlBusinessMetadata => ({ table: "sales_head", relations, enums: [], partial: false, sharedSession: false });
const resolve = (m: SqlBusinessMetadata | null = metadata(), available = Object.keys(fields)) => billQueryRelations("sales_head", available, m);
const expected = "SELECT a.*, b.*\nFROM sales_head a\nLEFT JOIN sales_lines b\n    ON a.head_id = b.parent_id\nWHERE a.vbillcode = '';";

describe("通用按单号查询模板", () => {
  it("按关联条件查完整结果把过滤留在EXISTS，外层关联返回全部行", () => {
    const [template] = completeQueryTemplates("sales_head", names, fields, resolve(), true);
    expect(template.insertText).toContain("LEFT JOIN sales_lines b\n    ON b.parent_id = a.head_id\nWHERE EXISTS (");
    expect(template.insertText).toContain("FROM sales_lines x\n    WHERE x.parent_id = a.head_id\n      AND (x.$0)\n);");
    expect(template.pickField).toBe(true);
    expect(template.label).toContain("按关联条件查完整结果");
    expect(template.insertText).not.toContain("vbillcode");
    expect(completeQueryTemplates("sales_head", names, { sales_head: fields.sales_head }, resolve(), true)).toEqual([]);
  });
  it("完整结果模板保留复合关联的每一对字段并尊重关键词大小写", () => {
    const columns = { sales_head: [...fields.sales_head, { name: "ORG_ID" }], sales_lines: [...fields.sales_lines, { name: "PARENT_ORG" }] };
    const relations = [{ ...resolve()[0], rootColumns: ["head_id", "org_id"], otherColumns: ["parent_id", "parent_org"] }];
    const [template] = completeQueryTemplates("sales_head", names, columns, relations, false);
    expect(template.insertText).toContain("where x.parent_id = a.head_id and x.parent_org = a.org_id\n      and (x.$0)");
  });
  it("通用条件模板不要求 vbillcode，光标在 WHERE 后", () => {
    const columns = { ...fields, sales_head: [{ name: "HEAD_ID" }] };
    const templates = conditionQueryTemplates("sales_head", names, columns, resolve(), true);
    expect(templates).toHaveLength(2);
    expect(templates[0]).toMatchObject({ label: "销售单 · 关联查询 销售明细", insertText: expected.replace("a.vbillcode = ''", "$0"), pickField: true });
    expect(templates[1].insertText).toBe("SELECT a.*\nFROM sales_head a\nWHERE $0;");
  });
  it("从 NC 引用生成任意名称和不同关联字段的主子表查询", () => {
    const templates = billQueryTemplates("sales_head", names, fields, resolve(), true);
    expect(templates.map(t => t.label)).toEqual(["销售单 · 按单号关联 销售明细", "销售单 · 按单号查主表"]);
    expect(templates[0].sql).toBe(expected);
    expect(templates[0].insertText).toBe(expected.replace("= ''", "= '$0'"));
    expect(templates[0].hint).toContain("NC类引用");
    expect(templates[1].sql).toBe("SELECT a.*\nFROM sales_head a\nWHERE a.vbillcode = '';" );
  });

  it("没有元数据时不再特殊照顾采购订单，也不从后缀和同名字段猜关系", () => {
    expect(resolve(null)).toEqual([]);
    const po = { po_order: [{ name: "vbillcode" }, { name: "pk_order" }], po_order_b: [{ name: "pk_order" }] };
    expect(billQueryTemplates("po_order", {}, po, billQueryRelations("po_order", Object.keys(po), null), true)).toHaveLength(1);
    expect(billQueryRelations("po_order", Object.keys(po), { ...metadata([]), table: "po_order" })).toEqual([]);
  });

  it("数据库外键支持复合键，并保持每一对字段的对应关系", () => {
    const composite = { ...relation, kind: "外键" as const, from: ["parent_id", "org_id"], to: ["head_id", "pk_org"] };
    const columns = { sales_head: [...fields.sales_head, { name: "PK_ORG" }], sales_lines: [...fields.sales_lines, { name: "ORG_ID" }] };
    const [tpl] = billQueryTemplates("sales_head", names, columns, resolve(metadata([composite])), false);
    expect(tpl.sql).toContain("on a.head_id = b.parent_id and a.pk_org = b.org_id");
    expect(tpl.hint).toContain("外键");
  });

  it("正向引用也以输入表为 a，避免反转单号过滤来源", () => {
    const outgoing = { ...relation, source: "sales_head", target: "sales_lines", from: ["head_id"], to: ["parent_id"] };
    expect(billQueryTemplates("sales_head", names, fields, resolve(metadata([outgoing])), true)[0].sql).toBe(expected);
  });

  it("多个关联表各给一条 LEFT JOIN，重复证据合并，不同关联键保留", () => {
    const columns = { ...fields, sales_lines: [...fields.sales_lines, { name: "original_id" }], bill_tax: [{ name: "head_id" }] };
    const relations = resolve(metadata([relation, { ...relation, id: "外键:duplicate", kind: "外键" },
      { ...relation, id: "NC类引用:original", from: ["original_id"] },
      { ...relation, source: "bill_tax", from: ["head_id"] }]), Object.keys(columns));
    const templates = billQueryTemplates("sales_head", names, columns, relations, true);
    expect(templates).toHaveLength(4);
    expect(templates.slice(0, 3).every(t => t.sql.split("LEFT JOIN").length === 2)).toBe(true);
    expect(templates[0].hint).not.toBe(templates[1].hint);
    expect(templates[2].sql).toContain("LEFT JOIN bill_tax b");
  });

  it("缺少当前表、关联表或关系上下文不匹配时不生成关联", () => {
    expect(resolve(metadata(), ["sales_head"])).toEqual([]);
    expect(resolve(metadata(), ["sales_lines"])).toEqual([]);
    expect(resolve({ ...metadata(), table: "other" })).toEqual([]);
    expect(resolve({ ...metadata(), sharedSession: true })).toEqual([]);
    expect(resolve(metadata([{ ...relation, source: "other.sales_lines" }]))).toEqual([]);
    expect(resolve(metadata([{ ...relation, source: "sales_head" }]))).toEqual([]);
  });

  it("不完整关系不参与查询，局部元数据失败仍能使用完整关系", () => {
    for (const broken of [{ ...relation, from: [] }, { ...relation, to: [] }, { ...relation, from: ["parent_id", "org"] }]) {
      expect(resolve(metadata([broken]))).toEqual([]);
    }
    expect(resolve({ ...metadata(), partial: true })).toHaveLength(1);
  });

  it("缺少单号字段不给单号模板，缺少任意关联字段只保留单表模板", () => {
    expect(billQueryTemplates("sales_head", names, { ...fields, sales_head: [{ name: "HEAD_ID" }] }, resolve(), true)).toEqual([]);
    for (const columns of [{ ...fields, sales_head: [{ name: "VBILLCODE" }] }, { sales_head: fields.sales_head },
      { ...fields, sales_lines: [{ name: "line_id" }] }]) {
      const templates = billQueryTemplates("sales_head", names, columns, resolve(), true);
      expect(templates).toHaveLength(1);
      expect(templates[0].sql).not.toContain("JOIN");
    }
  });

  it("特殊表名和混合大小写字段不从折叠缓存猜测", () => {
    expect(resolve(metadata([{ ...relation, source: "select" }]), ["sales_head", "SELECT"])).toEqual([]);
    expect(resolve(metadata([{ ...relation, from: ["Parent_ID"] }]))).toEqual([]);
    expect(billQueryTemplates("sales_head", names, { ...fields, sales_lines: [{ name: "Parent_ID" }] }, resolve(), true)).toHaveLength(1);
  });

  it("美元符号标识符按字面插入，仅保留单号光标落点", () => {
    const columns = { "bill$head": [{ name: "vbillcode" }, { name: "pk$0" }], "bill$lines": [{ name: "fk$0" }] };
    const meta = { ...metadata(), table: "bill$head", relations: [{ ...relation, source: "bill$lines", target: "bill$head", from: ["fk$0"], to: ["pk$0"] }] };
    const [template] = billQueryTemplates("bill$head", {}, columns, billQueryRelations("bill$head", Object.keys(columns), meta), true);
    expect(template.sql).toContain("ON a.pk$0 = b.fk$0");
    expect(template.insertText).toContain("ON a.pk\\$0 = b.fk\\$0");
    expect(template.insertText).toContain("WHERE a.vbillcode = '$0'");
  });
});
