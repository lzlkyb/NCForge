import type { BmfAttr, BmfDetail, BmfEntity, BmfEntry, BmfIssue } from "../lib/bmf";

export const metaAttr = (id: string, name = id, overrides: Partial<BmfAttr> = {}): BmfAttr => ({
  id, name, field: name, displayName: `字段 ${name}`, typeName: "String", typeDisplayName: "字符串",
  dataType: "", style: "SINGLE", dbType: "varchar", fieldType: "", length: 40, precision: null,
  isKey: false, nullable: true, defaultValue: "", refModel: "", sequence: 1, refTarget: "", raw: "", ...overrides,
});
export const metaEntity = (id: string, attrs: BmfAttr[] = [], overrides: Partial<BmfEntity> = {}): BmfEntity => ({
  id, name: id, displayName: `${id}实体`, fullClass: `nc.vo.demo.${id}VO`, table: `demo_${id}`,
  accessor: "", isPrimary: id === "head", keyAttrId: attrs[0]?.id ?? "", attrs, raw: "", ...overrides,
});
export const metaEntry = (name = "demo", overrides: Partial<BmfEntry> = {}): BmfEntry => ({
  path: `D:/workspace/METADATA/${name}.bmf`, name, displayName: `${name}组件`, module: "demo", origin: "工作区",
  namespace: "demo", version: 1, entityCount: 2, attrCount: 3, enumCount: 0, size: 100, mtimeMs: 0, error: null, ...overrides,
});
export const metaDetail = (name = "demo", overrides: Partial<BmfDetail> = {}): BmfDetail => ({
  path: metaEntry(name).path, encoding: "UTF-8", eol: "LF", bom: false, size: 100, sha256: "sha-original", mtimeMs: 0,
  component: { id: name, name, displayName: `${name}组件`, namespace: "demo", ownModule: "demo", genCodeStyle: "",
    version: 1, mainEntity: "head", industry: "", metaType: "" },
  entities: [metaEntity("head", [metaAttr("billcode"), metaAttr("amount")]), metaEntity("body", [metaAttr("item")])],
  relations: [{ id: "rel", kind: "AggregationRelation", name: "主子", source: "head", target: "body", srcAttrId: "amount", targetAttrId: "item" }],
  enums: [], unknownTags: [], ...overrides,
});
export const metaIssue = (overrides: Partial<BmfIssue> = {}): BmfIssue => ({
  id: "issue", code: "LENGTH", severity: "warn", title: "缺少长度", detail: "字段长度没有声明", why: "建表需要长度",
  action: "补上字段长度", file: metaEntry().path, line: 7, component: "demo", entity: "head", attr: "amount", ...overrides,
});
