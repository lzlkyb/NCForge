// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BmfBusinessInterface } from "../../lib/bmf";
import { metaAttr, metaDetail, metaEntity } from "../../test/metaFixtures";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));
import { MetaSemanticInspector } from "./MetaSemanticInspector";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const itf: BmfBusinessInterface = {
  id: "IObject", name: "IObject", displayName: "业务对象", fullClass: "nc.vo.demo.IObject", external: true,
  sourcePath: "D:/workspace/METADATA/common.bmf", definitionSha: "definition-sha",
  attrs: [{ id: "Icode", name: "businesscode", displayName: "业务编码", typeName: "String", dataType: "", style: "SINGLE", dbType: "varchar", sequence: 1 }],
};
const detail = () => metaDetail("demo", { interfaces: [itf], relations: [], entities: [metaEntity("head", [metaAttr("billcode")], {
  interfaceIds: [itf.id], mappings: [{ interfaceId: itf.id, interfaceAttrId: "Icode", entityId: "head", attrId: "billcode", attrPath: "", attrPathId: "" }],
  accessorConfig: { name: "ncbean", displayName: "NCBean", fullClass: "nc.md.model.access.javamap.NCBeanStyle",
    properties: [{ name: "wrapclsname", displayName: "包装类", value: "nc.vo.demo.HeadVO", sequence: 1 }] },
})] });
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text)!;
const parameter = () => host.querySelector<HTMLInputElement>('input[aria-label="访问器参数 wrapclsname"]')!;
function setValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
beforeEach(() => { mocks.invoke.mockReset(); host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ""; });

it("字段检查器定位接口属性，接口属性检查器反向定位实体字段", async () => {
  const onSelect = vi.fn(), onOpenRefs = vi.fn(), value = detail();
  await act(async () => root.render(<MetaSemanticInspector detail={value} selection={{ kind: "attr", entityId: "head", attrId: "billcode" }}
    onSelect={onSelect} onEdited={() => {}} />));
  await act(async () => button("业务编码").click());
  expect(onSelect).toHaveBeenLastCalledWith({ kind: "interfaceAttr", interfaceId: itf.id, attrId: "Icode" });
  await act(async () => root.render(<MetaSemanticInspector detail={value} selection={{ kind: "interfaceAttr", interfaceId: itf.id, attrId: "Icode" }}
    onSelect={onSelect} onOpenRefs={onOpenRefs} onEdited={() => {}} />));
  expect(host.textContent).toContain("外部接口定义只读");
  expect(host.querySelectorAll("input")).toHaveLength(0);
  await act(async () => button("billcode").click());
  expect(onSelect).toHaveBeenLastCalledWith({ kind: "attr", entityId: "head", attrId: "billcode" });
  await act(async () => button("打开已定位定义").click());
  expect(onOpenRefs).toHaveBeenCalledExactlyOnceWith(itf.sourcePath);
});

it("已有访问器参数在检查器内编辑，校验包装类并加入草稿", async () => {
  const onStage = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true), onEdited = vi.fn(), onEditingChange = vi.fn();
  await act(async () => root.render(<MetaSemanticInspector detail={detail()} selection={{ kind: "entity", entityId: "head" }}
    onSelect={() => {}} onStage={onStage} onEdited={onEdited} onEditingChange={onEditingChange} />));
  await act(async () => button("编辑参数 wrapclsname").click());
  expect(onEditingChange).toHaveBeenLastCalledWith(true);
  expect(host.querySelector('.meta-inline-edit')).not.toBeNull();
  await act(async () => setValue(parameter(), "HeadVO"));
  expect(button("加入草稿").disabled).toBe(true);
  expect(host.textContent).toContain("包装类参数必须是完整类名");
  await act(async () => setValue(parameter(), "nc.vo.demo.NewHeadVO"));
  await act(async () => button("加入草稿").click());
  expect(parameter().value).toBe("nc.vo.demo.NewHeadVO");
  expect(onEdited).not.toHaveBeenCalled();
  expect(onEditingChange).toHaveBeenLastCalledWith(true);
  await act(async () => button("加入草稿").click());
  expect(onStage).toHaveBeenLastCalledWith(expect.any(String), [{ op: "setAccessorProperty", entity: "head", name: "wrapclsname", value: "nc.vo.demo.NewHeadVO" }]);
  expect(onEdited).toHaveBeenCalledOnce();
  expect(onEditingChange).toHaveBeenLastCalledWith(false);
  expect(parameter()).toBeNull();
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it("同名访问器参数保留原文只读，不建立未知参数", async () => {
  const value = detail(), config = value.entities[0].accessorConfig!;
  config.properties.push({ ...config.properties[0], value: "nc.vo.demo.DuplicateVO" });
  const onStage = vi.fn();
  await act(async () => root.render(<MetaSemanticInspector detail={value} selection={{ kind: "entity", entityId: "head" }}
    onSelect={() => {}} onStage={onStage} onEdited={() => {}} />));
  expect(host.textContent).toContain("参数名重复，保留原文只读");
  const buttons = [...host.querySelectorAll<HTMLButtonElement>("button")];
  expect(buttons).toHaveLength(2);
  expect(buttons.every((item) => item.disabled)).toBe(true);
  await act(async () => buttons[0].click());
  expect(host.querySelector('.meta-inline-edit')).toBeNull();
  expect(onStage).not.toHaveBeenCalled();
});

it("参数冲突的重新加载与 stage 成功回调分离", async () => {
  const onStage = vi.fn().mockRejectedValue(new Error("文件已被外部修改")), onReload = vi.fn(), onEdited = vi.fn();
  await act(async () => root.render(<MetaSemanticInspector detail={detail()} selection={{ kind: "entity", entityId: "head" }}
    onSelect={() => {}} onStage={onStage} onEdited={onEdited} onReload={onReload} />));
  await act(async () => button("编辑参数 wrapclsname").click());
  await act(async () => setValue(parameter(), "nc.vo.demo.NewHeadVO"));
  await act(async () => button("加入草稿").click());
  await act(async () => button("重新加载组件").click());
  expect(onReload).toHaveBeenCalledOnce();
  expect(onEdited).not.toHaveBeenCalled();
  expect(host.querySelector('.meta-inline-edit')).toBeNull();
});

it("未解析参照可查看标识和原因，没有猜测文件的打开入口", async () => {
  const value = detail();
  value.references = [{ id: "missing", refId: "absent", name: "MissingReference", displayName: "缺失定义", fullClass: "nc.vo.demo.Missing",
    module: "demo", metadataPath: "demo.missing", resolution: "工作区没有定义" }];
  await act(async () => root.render(<MetaSemanticInspector detail={value} selection={{ kind: "reference", referenceId: "missing" }}
    onSelect={() => {}} onOpenRefs={vi.fn()} onEdited={() => {}} />));
  expect(host.textContent).toContain("工作区没有定义");
  expect(host.textContent).toContain("demo.missing");
  expect(host.querySelectorAll("button")).toHaveLength(0);
});
