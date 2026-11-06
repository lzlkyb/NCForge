import { describe, expect, it } from "vitest";
import { fieldWindow, locateMetaIssue, restoreMetaSelection, selectedMetaEntity } from "./metaEditor";
import { metaDetail, metaIssue } from "../test/metaFixtures";

describe("元数据稳定选中与定位", () => {
  it("刷新保留对象 ID；字段删除回到所属实体，实体删除回到组件", () => {
    const selection = { kind: "attr", entityId: "head", attrId: "amount" } as const;
    const detail = metaDetail();
    expect(restoreMetaSelection(detail, selection)).toEqual(selection);
    detail.entities[0].attrs = [];
    expect(restoreMetaSelection(detail, selection)).toEqual({ kind: "entity", entityId: "head" });
    detail.entities = [];
    expect(restoreMetaSelection(detail, selection)).toEqual({ kind: "component" });
  });
  it("关系使用来源实体的字段，不选择另一份无关实体", () => {
    expect(selectedMetaEntity(metaDetail(), { kind: "relation", relationId: "rel" })?.id).toBe("head");
    expect(restoreMetaSelection(metaDetail(), { kind: "relation", relationId: "gone" })).toEqual({ kind: "component" });
  });
  it("校验问题支持技术名和 ID，未知对象不给假定位", () => {
    const detail = metaDetail();
    detail.entities[0].name = "DemoHVO";
    detail.entities[0].attrs[1].name = "namount";
    expect(locateMetaIssue(detail, metaIssue({ entity: "DemoHVO", attr: "namount" }))).toEqual({ kind: "attr", entityId: "head", attrId: "amount" });
    expect(locateMetaIssue(detail, metaIssue({ entity: "missing" }))).toBeNull();
  });
});
it("2000 字段只渲染可见区及缓冲行，越界滚动仍保持合法范围", () => {
  const middle = fieldWindow(2000, 32000, 320);
  expect(middle.end - middle.start).toBeLessThanOrEqual(20);
  expect(middle.before + middle.after + (middle.end - middle.start) * 32).toBe(64000);
  expect(fieldWindow(0, 1000, 320)).toEqual({ start: 0, end: 0, before: 0, after: 0 });
  expect(fieldWindow(2, 9999, 320).after).toBe(0);
});
