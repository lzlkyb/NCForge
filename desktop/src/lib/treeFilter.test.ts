import { expect, it } from "vitest";
import { treeFilterFor } from "./treeFilter";
it("同一工程展示过滤跨视图复用，工程之间隔离", () => {
  const first = treeFilterFor("D:\\work\\filter"), second = treeFilterFor("d:/work/filter/");
  first.set({ open: true, text: "Demo" });
  expect(second.get()).toEqual({ open: true, text: "Demo" });
  expect(treeFilterFor("D:/other-filter").get()).toEqual({ open: false, text: "" });
});
