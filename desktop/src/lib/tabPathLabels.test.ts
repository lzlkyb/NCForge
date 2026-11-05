import { expect, it } from "vitest";
import { tabPathLabels } from "./tabPathLabels";

it("同名 NC 源文件显示模块和源码根，普通文件名不加后缀", () => {
  const root = "C:/nc";
  const bill = "C:\\nc\\bill\\src\\public\\nc\\impl\\OrderService.java";
  const pm = "C:/nc/pm/src/private/nc/impl/OrderService.java";
  const plain = "C:/nc/README.md";
  const labels = tabPathLabels(root, [
    { path: bill, name: "OrderService.java" }, { path: pm, name: "OrderService.java" },
    { path: plain, name: "README.md" },
  ]);
  expect([...labels]).toEqual([[bill, "bill/public"], [pm, "pm/private"]]);
});

it("末级目录相同时增加必要的上级目录，并区分根目录文件", () => {
  const paths = ["C:/nc/x.properties", "C:/nc/a/conf/x.properties", "C:/nc/b/conf/x.properties"];
  const labels = tabPathLabels("C:/nc", paths.map(path => ({ path, name: "x.properties" })));
  expect([...labels.values()]).toEqual(["./", "a/conf", "b/conf"]);
});
