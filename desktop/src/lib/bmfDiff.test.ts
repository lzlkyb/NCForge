import { expect, it } from "vitest";
import type { BmfAttr, BmfDetail, BmfEntity } from "./bmf";
import { diffDetails, summarize } from "./bmfDiff";

const attr = (name: string, over: Partial<BmfAttr> = {}): BmfAttr => ({
  id: `a-${name}`,
  name,
  field: name,
  displayName: name,
  typeName: "String",
  typeDisplayName: "",
  dataType: "BS",
  style: "NORMAL",
  dbType: "varchar2",
  fieldType: "",
  length: 20,
  precision: null,
  isKey: false,
  nullable: true,
  defaultValue: "",
  refModel: "",
  sequence: 0,
  refTarget: "",
  raw: "",
  ...over,
});

const entity = (name: string, attrs: BmfAttr[], over: Partial<BmfEntity> = {}): BmfEntity => ({
  id: `e-${name}`,
  name,
  displayName: name,
  fullClass: `nc.vo.m.${name}`,
  table: `t_${name}`,
  accessor: `nc.vo.m.${name}`,
  isPrimary: false,
  keyAttrId: attrs[0]?.id ?? "",
  attrs,
  raw: "",
  ...over,
});

const detail = (entities: BmfEntity[], over: Partial<BmfDetail> = {}): BmfDetail => ({
  path: "D:/ws/METADATA/demo.bmf",
  encoding: "UTF-8",
  eol: "CRLF",
  bom: false,
  size: 1,
  sha256: "",
  mtimeMs: 0,
  component: {
    id: "c",
    name: "demo",
    displayName: "演示",
    namespace: "m",
    ownModule: "m",
    genCodeStyle: "",
    version: 1,
    mainEntity: "e-H",
    industry: "",
    metaType: "",
  },
  entities,
  enums: [],
  relations: [],
  unknownTags: [],
  ...over,
});

it("结构一致时没有差异行", () => {
  const d = detail([entity("H", [attr("pk"), attr("billno")])]);
  expect(diffDetails(d, d)).toEqual([]);
});

it("定位到字段级：字段属性、实体增删、枚举项与关系", () => {
  const before = detail([entity("H", [attr("pk"), attr("billno", { length: 20 })])]);
  const after = detail(
    [entity("H", [attr("pk"), attr("billno", { length: 50, displayName: "单据号" })], { table: "t_h2" }), entity("B", [attr("x")])],
    {
      component: { ...before.component, version: 2 },
      enums: [{ id: "n", name: "status", displayName: "状态", typeName: "String", dataType: "", fullClass: "", raw: "", items: [{ id: "i1", value: "0", display: "未审", hidden: false }] }],
      relations: [
        { id: "r", kind: "AggregationRelation", name: "H-B", source: "e-H", target: "e-B", srcAttrId: "", targetAttrId: "" },
      ],
    },
  );
  const rows = diffDetails(before, after);
  const has = (kind: string, scope: string, field: string) =>
    rows.some((r) => r.kind === kind && r.scope === scope && r.field === field);

  expect(has("component", "组件", "版本")).toBe(true);
  expect(has("entity", "H", "表名")).toBe(true);
  expect(has("attr", "H", "billno.长度")).toBe(true);
  expect(has("attr", "H", "billno.显示名")).toBe(true);
  expect(has("entity", "B", "实体")).toBe(true);
  expect(has("enum", "status", "枚举")).toBe(true);
  expect(has("relation", "H → B", "AggregationRelation")).toBe(true);
  expect(rows.find((r) => r.field === "billno.长度")).toMatchObject({ before: "20", after: "50", change: "changed" });

  const after2 = detail([]);
  const removed = diffDetails(before, after2);
  expect(removed.some((r) => r.kind === "entity" && r.scope === "H" && r.change === "removed")).toBe(true);
  expect(summarize(rows)).toEqual({
    added: rows.filter((r) => r.change === "added").length,
    removed: rows.filter((r) => r.change === "removed").length,
    changed: rows.filter((r) => r.change === "changed").length,
  });
});
