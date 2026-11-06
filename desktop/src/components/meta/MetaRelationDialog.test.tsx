// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BmfDetail, BmfRelation } from "../../lib/bmf";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));

import { MetaRelationDialog } from "./MetaRelationDialog";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  mocks.invoke.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

const attr = (id: string, name: string) => ({
  id,
  name,
  field: name,
  displayName: "",
  typeName: "String",
  typeDisplayName: "",
  dataType: "",
  style: "SINGLE",
  dbType: "",
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
});

const detail: BmfDetail = {
  path: "D:/w/a.bmf",
  encoding: "UTF-8",
  eol: "CRLF",
  bom: true,
  size: 10,
  sha256: "sha",
  mtimeMs: 0,
  component: {
    id: "c",
    name: "c",
    displayName: "",
    namespace: "m",
    ownModule: "m",
    genCodeStyle: "",
    version: 1,
    mainEntity: "e1",
    industry: "",
    metaType: "",
  },
  entities: [
    { id: "e1", name: "H", displayName: "表头", fullClass: "nc.vo.m.c.H", table: "h", accessor: "", isPrimary: true, keyAttrId: "a1", attrs: [attr("a1", "pk")], raw: "" },
    { id: "e2", name: "B", displayName: "表体", fullClass: "nc.vo.m.c.B", table: "b", accessor: "", isPrimary: false, keyAttrId: "a2", attrs: [attr("a2", "pk_b")], raw: "" },
  ],
  enums: [],
  relations: [],
  unknownTags: [],
};

const button = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text)!;
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}
const select = (label: string) => document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
function choose(label: string, value: string) {
  const node = select(label); node.value = value; node.dispatchEvent(new Event("change", { bubbles: true }));
}
function setValue(label: string, value: string) {
  const node = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value);
  node.dispatchEvent(new Event("input", { bubbles: true }));
}

it("新增关系：默认两端是已有实体，提交 addRelation", async () => {
  mocks.invoke.mockImplementation((cmd: string) => {
    if (cmd === "bmf_edit_preview") return Promise.resolve("diff");
    if (cmd === "bmf_edit_save") return Promise.resolve({ path: "x", backup: null, shaBefore: "a", shaAfter: "b", diff: "", changed: true });
    return Promise.reject(new Error(`unexpected ${cmd}`));
  });
  await act(async () => root.render(<MetaRelationDialog path={detail.path} sha="sha" detail={detail} onClose={() => {}} onSaved={() => {}} />));

  await act(async () => button("预览 diff").click());
  await flush();
  await act(async () => button("保存").click());
  await flush();

  const call = mocks.invoke.mock.calls.find(([cmd]) => cmd === "bmf_edit_save")!;
  const ops = (call[1] as { ops: Record<string, unknown>[] }).ops;
  expect(ops).toEqual([
    expect.objectContaining({ op: "addRelation", kind: "AggregationRelation", source: "e1", target: "e2" }),
  ]);
});

it("两端同一实体时禁止预览", async () => {
  await act(async () => root.render(<MetaRelationDialog path={detail.path} sha="sha" detail={detail} onClose={() => {}} onSaved={() => {}} />));
  const select = document.querySelector<HTMLSelectElement>('select[aria-label="目标实体"]')!;
  act(() => {
    select.value = "e1";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(document.body.textContent).toContain("不能是同一个实体");
  expect(button("预览 diff").disabled).toBe(true);
});

it("业务接口实现目标区分本地接口与已解析接口参照", async () => {
  const value: BmfDetail = { ...detail, interfaces: [
    { id: "Ilocal", name: "ILocal", displayName: "本地接口", fullClass: "nc.vo.m.ILocal", attrs: [], external: false, sourcePath: detail.path, definitionSha: "local-sha" },
    { id: "Iexternal", name: "IExternal", displayName: "外部接口", fullClass: "nc.vo.m.IExternal", attrs: [], external: true, sourcePath: "D:/w/common.bmf", definitionSha: "external-sha" },
  ], references: [
    { id: "refItf", refId: "Iexternal", name: "external", displayName: "外部接口参照", fullClass: "nc.vo.m.IExternal", module: "m", metadataPath: "m.common", resolution: "" },
    { id: "missing", refId: "unknown", name: "missing", displayName: "未解析参照", fullClass: "", module: "m", metadataPath: "m.missing", resolution: "缺失" },
  ] };
  const onStage = vi.fn().mockResolvedValue(true);
  await act(async () => root.render(<MetaRelationDialog path={detail.path} sha="sha" detail={value} onStage={onStage} onClose={() => {}} onSaved={() => {}} />));
  expect([...select("关系类型").options].map((item) => item.textContent)).toEqual(["聚合（主子表）", "关联 / 参照", "业务接口实现", "实体继承"]);
  await act(async () => choose("关系类型", "busiitfconnection"));
  expect([...select("目标实体").options].map((item) => item.value)).toEqual(["", "Ilocal", "refItf"]);
  expect(button("加入草稿").disabled).toBe(true);
  await act(async () => choose("目标实体", "refItf"));
  await act(async () => setValue("接口实现类", "nc.impl.m.ObjectImpl"));
  await act(async () => button("加入草稿").click());
  const ops = onStage.mock.calls[0][1] as Record<string, unknown>[];
  expect(ops[0]).toMatchObject({ op: "addRelation", kind: "busiitfconnection", source: "e1", target: "refItf", srcAttrId: "", targetAttrId: "" });
  expect(ops[1]).toEqual({ op: "setAttr", id: ops[0].id, name: "bizItfImpClassName", value: "nc.impl.m.ObjectImpl" });
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it("已有关系仅修改显示名、多重性和实现类，端点及属性保持只读", async () => {
  const relation: BmfRelation = { id: "existing", kind: "busiitfconnection", name: "busiItf connection", displayName: "实现", source: "e1", target: "foreign-reference",
    srcAttrId: "a1", targetAttrId: "foreign-property", sourceConstraint: "1", targetConstraint: "0..n", implementationClass: "nc.impl.m.Old" };
  const value = { ...detail, relations: [relation] }, onStage = vi.fn().mockResolvedValue(true);
  await act(async () => root.render(<MetaRelationDialog path={detail.path} sha="sha" detail={value} relation={relation} onStage={onStage} onClose={() => {}} onSaved={() => {}} />));
  for (const label of ["关系类型", "源实体", "目标实体", "源属性", "目标属性"]) expect(select(label).disabled).toBe(true);
  expect(select("目标实体").value).toBe("foreign-reference");
  expect(select("目标属性").value).toBe("foreign-property");
  await act(async () => setValue("关系显示名", "新实现"));
  await act(async () => choose("来源多重性", "0..1"));
  await act(async () => choose("目标多重性", "1..n"));
  await act(async () => setValue("接口实现类", "nc.impl.m.New"));
  await act(async () => button("加入草稿").click());
  expect(onStage).toHaveBeenLastCalledWith(expect.any(String), [
    { op: "setAttr", id: relation.id, name: "displayName", value: "新实现" },
    { op: "setAttr", id: relation.id, name: "sourceConstraint", value: "0..1" },
    { op: "setAttr", id: relation.id, name: "targetConstraint", value: "1..n" },
    { op: "setAttr", id: relation.id, name: "bizItfImpClassName", value: "nc.impl.m.New" },
  ]);
});

it("未解析的旧端点与未声明多重性保留原值，修改显示名不补写约束", async () => {
  const relation: BmfRelation = { id: "existing", kind: "relation", name: "relation", source: "foreign-source", target: "foreign-target", srcAttrId: "foreign-source-property", targetAttrId: "foreign-target-property" };
  const onStage = vi.fn().mockResolvedValue(true);
  await act(async () => root.render(<MetaRelationDialog path={detail.path} sha="sha" detail={{ ...detail, relations: [relation] }} relation={relation}
    onStage={onStage} onClose={() => {}} onSaved={() => {}} />));
  expect(select("源实体").value).toBe(relation.source);
  expect(select("源属性").value).toBe(relation.srcAttrId);
  expect(select("目标实体").value).toBe(relation.target);
  expect(select("目标属性").value).toBe(relation.targetAttrId);
  expect(select("来源多重性").value).toBe("");
  expect(select("目标多重性").value).toBe("");
  await act(async () => setValue("关系显示名", "外部关联"));
  await act(async () => button("加入草稿").click());
  expect(onStage).toHaveBeenLastCalledWith(expect.any(String), [{ op: "setAttr", id: relation.id, name: "displayName", value: "外部关联" }]);
});

it("未知关系类型只读，已有特殊多重性可原样保留", async () => {
  const relation: BmfRelation = { id: "future", kind: "FutureConnection", name: "future", source: "e1", target: "e2", srcAttrId: "", targetAttrId: "", sourceConstraint: "custom", targetConstraint: "custom" };
  const onStage = vi.fn();
  await act(async () => root.render(<MetaRelationDialog path={detail.path} sha="sha" detail={{ ...detail, relations: [relation] }} relation={relation}
    onStage={onStage} onClose={() => {}} onSaved={() => {}} />));
  expect(document.body.textContent).toContain("此关系类型未经写入验证");
  expect(button("加入草稿").disabled).toBe(true);
  expect(select("来源多重性").value).toBe("custom");
  await act(async () => button("加入草稿").click());
  expect(onStage).not.toHaveBeenCalled();
});
