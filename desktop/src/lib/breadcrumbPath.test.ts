import { expect, it } from "vitest";
import { breadcrumbParts } from "./breadcrumbPath";
it("混合斜杠与 Windows 大小写仍得到工程相对路径", () => {
  expect(breadcrumbParts("D:\\Work\\NC\\", "d:/work/nc/src/demo/A.java")).toEqual(["src", "demo", "A.java"]);
});
it("同名前缀的工程外文件保留路径", () => {
  expect(breadcrumbParts("D:/NC", "D:/NC-other/A.java")).toEqual(["D:", "NC-other", "A.java"]);
});
