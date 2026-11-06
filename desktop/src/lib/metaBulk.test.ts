import { describe, expect, it } from "vitest";
import { metaAttr, metaDetail, metaEntity } from "../test/metaFixtures";
import { autoMetaColumns, META_TEMPLATES, parseMetaPaste, planMetaBatch, planMetaPaste } from "./metaBulk";
import { BMF_BASE_TYPES, fieldTypeOps } from "./bmfTypes";

const detail = metaDetail();
const entity = detail.entities[0];
const plan = (text: string, mode: "add" | "update" = "add") => {
  const parsed = parseMetaPaste(text);
  return planMetaPaste(detail, entity, parsed, autoMetaColumns(parsed.headers), mode);
};
describe("元数据粘贴预检", () => {
  it("整批错误不会返回前面合法行的操作", () => {
    const result = plan("字段名\t显示名\t长度\nnewfield\t新字段\t40\nsecond\t第二个\t-1");
    expect(result.errors).toHaveLength(1); expect(result.ops).toEqual([]);
  });
  it("重复行、已存在字段、非法列名和列数不一致均拒绝", () => {
    for (const text of ["name\na\na", "name\nbillcode", "name,field\na,not valid", "name,length\na,1,extra"]) expect(plan(text).ops).toEqual([]);
  });
  it("CSV 引号内的分隔符与换行保持内容；未闭合引号拒绝", () => {
    const result = plan('name,displayName,type\ncode,"名称,\n多行",String');
    expect(result.errors).toEqual([]);
    expect(result.ops[0]).toMatchObject({ op: "addAttribute", name: "code", displayName: "名称,\n多行", dataType: BMF_BASE_TYPES[0].id });
    expect(() => parseMetaPaste('name,displayName\ncode,"oops')).toThrow("未闭合");
  });
  it("更新按字段名定位稳定 ID，未映射列保持原值", () => {
    expect(plan("字段名\t显示名\nbillcode\t新单据号", "update").ops).toEqual([{ op: "setAttr", id: "billcode", name: "displayName", value: "新单据号" }]);
    expect(plan("name,displayName\nmissing,名称", "update").errors[0]).toContain("不存在");
  });
  it("同一目标列重复映射不会执行", () => {
    const parsed = parseMetaPaste("a,b\nfoo,bar");
    expect(planMetaPaste(detail, entity, parsed, ["name", "name"], "add").ops).toEqual([]);
  });
  it("新增字段再修改列名和精度引用同一个 ID", () => {
    const result = plan("name,field,type,length,precision\nprice,amount,UFDouble,28,8");
    expect(result.errors).toEqual([]);
    const created = result.ops[0];
    expect(created.op).toBe("addAttribute");
    expect(result.ops.slice(1).every((op) => "id" in op && op.id === (created as { id: string }).id)).toBe(true);
  });
  it("字段模板通过真实类型目录预检，已有同名字段时拒绝重复新增", () => {
    for (const text of Object.values(META_TEMPLATES)) expect(plan(text).errors).toEqual([]);
    const parsed = parseMetaPaste(META_TEMPLATES["删除标记与时间戳"]);
    const withDr = metaEntity("head", [metaAttr("dr")]);
    expect(planMetaPaste(detail, withDr, parsed, autoMetaColumns(parsed.headers), "add").ops).toEqual([]);
  });
});
describe("批量约束与类型", () => {
  it("主键、参照和未加载接口定义不能被普通批改破坏", () => {
    const key = metaEntity("head", [metaAttr("pk", "pk", { isKey: true, nullable: false })]);
    expect(planMetaBatch(detail, key, ["pk"], { nullable: true }).ops).toEqual([]);
    expect(() => fieldTypeOps(detail, metaAttr("ref", "ref", { style: "REF" }), BMF_BASE_TYPES[2].id)).toThrow("参照或数组");
    const linked = metaEntity("head", [metaAttr("x")], { mappings: [{ interfaceId: "itf", interfaceAttrId: "i", entityId: "head", attrId: "x", attrPath: "", attrPathId: "" }] });
    expect(planMetaBatch(metaDetail("demo", { entities: [linked] }), linked, ["x"], { typeId: BMF_BASE_TYPES[2].id }).ops).toEqual([]);
  });
  it("错误长度和精度阻断全批，合法约束落到正确字段", () => {
    expect(planMetaBatch(detail, entity, ["billcode", "amount"], { length: 10, precision: 12 }).ops).toEqual([]);
    expect(planMetaBatch(detail, entity, ["billcode", "amount"], { nullable: false }).ops).toEqual([
      { op: "setAttr", id: "billcode", name: "isNullable", value: "false" }, { op: "setAttr", id: "amount", name: "isNullable", value: "false" },
    ]);
  });
});
