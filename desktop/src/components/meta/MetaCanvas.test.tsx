// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { BmfAttr, BmfDetail, BmfEntity, BmfRelation } from "../../lib/bmf";
import { canvasLayout, visibleAttrs, NODE_W, GAP_X, PAD } from "./canvasLayout";
import { MetaCanvas } from "./MetaCanvas";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

const attr = (id: string, name: string, isKey = false): BmfAttr => ({
  id,
  name,
  field: name,
  displayName: name,
  typeName: "String",
  typeDisplayName: "字符串",
  dataType: "",
  style: "",
  dbType: "VARCHAR",
  fieldType: "",
  length: 20,
  precision: null,
  isKey,
  nullable: true,
  defaultValue: "",
  refModel: "",
  sequence: 0,
  refTarget: "",
  raw: "",
});

const ent = (id: string, name: string, attrs: BmfAttr[] = []): BmfEntity => ({
  id,
  name,
  displayName: `${name} 显示名`,
  fullClass: `nc.vo.m.${name}`,
  table: `t_${name}`,
  accessor: "",
  isPrimary: false,
  keyAttrId: attrs.find((a) => a.isKey)?.id ?? "",
  attrs,
  raw: "",
});

const relation = (source: string, target: string, srcAttrId = "", targetAttrId = ""): BmfRelation => ({
  id: `r-${source}-${target}-${srcAttrId}${targetAttrId}`,
  kind: "AggregationRelation",
  name: "",
  source,
  target,
  srcAttrId,
  targetAttrId,
});

const detail = (entities: BmfEntity[], relations: BmfRelation[] = []): BmfDetail => ({
  path: "D:/ws/METADATA/demo.bmf",
  encoding: "UTF-8",
  eol: "CRLF",
  bom: false,
  size: 100,
  sha256: "abc",
  mtimeMs: 0,
  component: {
    id: "c",
    name: "demo",
    displayName: "演示",
    namespace: "m",
    ownModule: "m",
    genCodeStyle: "",
    version: 1,
    mainEntity: entities[0]?.id ?? "",
    industry: "",
    metaType: "",
  },
  entities,
  enums: [],
  relations,
  unknownTags: [],
});

const pointer = (type: string, clientX: number, clientY: number) =>
  new MouseEvent(type, { bubbles: true, clientX, clientY });

it("方阵布局收敛，50 个实体也不无限变宽", () => {
  const few = canvasLayout([ent("e1", "H"), ent("e2", "H2"), ent("e3", "B"), ent("e4", "B2")], []);
  const many = canvasLayout(
    Array.from({ length: 50 }, (_, i) => ent(`e${i}`, `H${i}`)),
    [],
  );
  expect(few.width).toBe(2 * NODE_W + GAP_X + 2 * PAD);
  expect(many.width).toBeLessThanOrEqual(6 * NODE_W + 5 * GAP_X + 2 * PAD);
  expect(many.height).toBeGreaterThan(few.height);
});

it("关系端点字段优先占字段行，最多 6 行", () => {
  const attrs = Array.from({ length: 9 }, (_, i) => attr(`a${i}`, `f${i}`, i === 2));
  const e = ent("e", "H", attrs);
  const rows = visibleAttrs(e, [relation("e", "x", "a8")]);
  expect(rows).toHaveLength(6);
  expect(rows[0].id).toBe("a8");
  expect(rows[1].id).toBe("a2");
});

it("画节点与字段行；无字段的关系落在节点边框，有字段的关系落到字段行", async () => {
  const h = ent("e", "H", [attr("a1", "pk", true), attr("a2", "fk")]);
  const h2 = ent("e2", "H2", [attr("b1", "pk", true)]);
  const plain = relation("e", "e2");
  const field = relation("e", "e2", "a2", "b1");
  await act(async () => root.render(<MetaCanvas detail={detail([h, h2], [plain, field])} />));

  expect(host.querySelectorAll(".meta-canvas-node")).toHaveLength(2);
  expect(host.querySelectorAll(".meta-canvas-field")).toHaveLength(3);
  expect(host.querySelectorAll(".meta-canvas-rel")).toHaveLength(2);
  expect(host.querySelectorAll(".meta-canvas-rel.is-field")).toHaveLength(1);
  expect(host.textContent).toContain("2 实体 · 2 关系");

  const node = host.querySelectorAll<SVGGElement>(".meta-canvas-node")[1];
  await act(async () => node.dispatchEvent(pointer("pointerdown", 0, 0)));
  expect(host.textContent).toContain("H2 的信息");
  expect(host.textContent).toContain("nc.vo.m.H2");

  await act(async () =>
    host.querySelector<SVGGElement>(".meta-canvas-rel.is-field")!.dispatchEvent(pointer("click", 0, 0)),
  );
  expect(host.querySelector(".meta-canvas-rel.is-field")!.classList.contains("is-active")).toBe(true);
});

it("没有实体时给空状态，不画空网格", async () => {
  await act(async () => root.render(<MetaCanvas detail={detail([])} />));
  expect(host.querySelector(".meta-canvas")).toBeNull();
  expect(host.textContent).toContain("没有可绘制的实体、接口或参照");
});

it("50 个实体仍可拖拽：节点坐标跟随指针", async () => {
  const entities = Array.from({ length: 50 }, (_, i) =>
    ent(`e${i}`, `H${i}`, [attr(`a${i}-1`, "pk", true), attr(`a${i}-2`, "name")]),
  );
  const d = detail(entities);
  await act(async () => root.render(<MetaCanvas detail={d} />));
  expect(host.querySelectorAll(".meta-canvas-node")).toHaveLength(50);

  const layout = canvasLayout(entities, []);
  const pos = layout.pos[1];
  const node = host.querySelectorAll<SVGGElement>(".meta-canvas-node")[1];
  await act(async () => node.dispatchEvent(pointer("pointerdown", pos.x + 10, pos.y + 10)));
  await act(async () => window.dispatchEvent(pointer("pointermove", pos.x + 60, pos.y + 40)));
  await act(async () => window.dispatchEvent(pointer("pointerup", pos.x + 60, pos.y + 40)));

  expect(node.getAttribute("transform")).toBe(`translate(${pos.x + 50} ${pos.y + 30})`);
});

it("拖把手到另一个实体，弹框预填两端", async () => {
  const entities = [ent("e", "H", [attr("a1", "pk", true)]), ent("e2", "H2", [attr("b1", "pk", true)])];
  const d = detail(entities);
  await act(async () => root.render(<MetaCanvas detail={d} />));

  const layout = canvasLayout(entities, []);
  const target = layout.pos[1];
  const handle = host.querySelectorAll<SVGGElement>(".meta-canvas-handle")[0];
  await act(async () => handle.dispatchEvent(pointer("pointerdown", 0, 0)));
  await act(async () => window.dispatchEvent(pointer("pointermove", target.x + 20, target.y + 20)));
  await act(async () => window.dispatchEvent(pointer("pointerup", target.x + 20, target.y + 20)));

  const source = document.querySelector<HTMLSelectElement>('select[aria-label="源实体"]');
  const dest = document.querySelector<HTMLSelectElement>('select[aria-label="目标实体"]');
  expect(source?.value).toBe("e");
  expect(dest?.value).toBe("e2");
});
