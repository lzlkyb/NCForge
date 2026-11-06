import { expect, it } from "vitest";
import { metaDetail } from "../test/metaFixtures";
import { canvasObjects, canvasSelection, visibleCanvasNodes } from "./metaCanvasModel";

it("接口和引用保持真实类别，外部接口定义经引用节点显示", () => {
  const detail = metaDetail("demo", { entities: [], interfaces: [
    { id: "local", name: "ILocal", displayName: "本地接口", fullClass: "nc.vo.ILocal", attrs: [], external: false, sourcePath: "", definitionSha: "a" },
    { id: "external", name: "IExternal", displayName: "外部接口", fullClass: "nc.vo.IExternal", attrs: [], external: true, sourcePath: "ref.bmf", definitionSha: "b" },
  ], references: [{ id: "ref", refId: "external", name: "IExternal", displayName: "引用", fullClass: "nc.vo.IExternal", module: "demo", metadataPath: "ref.bmf", resolution: "已加载" }] });
  const objects = canvasObjects(detail);
  expect(objects.map((o) => o.modelKind)).toEqual(["interface", "reference"]);
  expect(canvasSelection(objects[0], "attr")).toEqual({ kind: "interfaceAttr", interfaceId: "local", attrId: "attr" });
  expect(canvasSelection(objects[1])).toEqual({ kind: "reference", referenceId: "ref" });
});
it("500 个节点只挂载视区与缓冲范围，选中节点始终保留", () => {
  const positions = Array.from({ length: 500 }, (_, i) => ({ x: (i % 6) * 308, y: Math.floor(i / 6) * 200 }));
  const visible = visibleCanvasNodes(positions, Array(500).fill(150), { left: 0, top: 0, width: 800, height: 400 }, 1, 499);
  expect(visible.size).toBeLessThan(40); expect(visible.has(499)).toBe(true); expect(visible.has(200)).toBe(false);
  const scrolled = visibleCanvasNodes(positions, Array(500).fill(150), { left: 0, top: 6000, width: 800, height: 400 }, 1);
  expect(scrolled.has(0)).toBe(false); expect(scrolled.size).toBeLessThan(40);
});
