// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BmfBusinessInterface, BmfInterfaceMapping } from "../../lib/bmf";
import { metaAttr, metaDetail, metaEntity } from "../../test/metaFixtures";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));
import { MetaSemanticPanel } from "./MetaSemanticPanel";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const itf: BmfBusinessInterface = {
  id: "IObject", name: "IObject", displayName: "业务对象", fullClass: "nc.vo.demo.IObject", external: true,
  sourcePath: "D:/workspace/METADATA/common.bmf", definitionSha: "definition-sha",
  attrs: [{ id: "Icode", name: "businesscode", displayName: "业务编码", typeName: "String", dataType: "", style: "SINGLE", dbType: "varchar", sequence: 1 }],
};
const binding = (attrId: string, overrides: Partial<BmfInterfaceMapping> = {}): BmfInterfaceMapping => ({
  interfaceId: itf.id, interfaceAttrId: "Icode", entityId: "head", attrId, attrPath: "", attrPathId: "", ...overrides,
});
const detail = (mappings: BmfInterfaceMapping[] = []) => metaDetail("demo", {
  interfaces: [itf], relations: [], entities: [metaEntity("head", [metaAttr("billcode"), metaAttr("othercode"), metaAttr("amount", "amount", { typeName: "UFDouble" })],
    { interfaceIds: [itf.id], mappings })],
});
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text)!;
const row = () => document.querySelector<HTMLTableRowElement>('tr[data-mapping="head/Icode"]')!;
const editButton = () => row().querySelector<HTMLButtonElement>('button[aria-label="修改 head 的 businesscode 映射"]')!;
const target = () => document.querySelector<HTMLSelectElement>('select[aria-label="映射目标字段"]')!;
function choose(select: HTMLSelectElement, value: string) {
  select.value = value; select.dispatchEvent(new Event("change", { bubbles: true }));
}
beforeEach(() => {
  mocks.invoke.mockReset(); host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ""; });

it("接口属性与目标字段双向定位，外部定义保持只读", async () => {
  const onSelect = vi.fn(), onStage = vi.fn();
  await act(async () => root.render(<MetaSemanticPanel detail={detail([binding("billcode")])} selection={{ kind: "interface", interfaceId: itf.id }}
    onSelect={onSelect} onStage={onStage} onEdited={() => {}} locked={false} />));
  expect(host.textContent).toContain("外部定义只读");
  expect(row().textContent).toContain("已绑定");
  await act(async () => [...row().querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "businesscode")!.click());
  expect(onSelect).toHaveBeenLastCalledWith({ kind: "interfaceAttr", interfaceId: itf.id, attrId: "Icode" });
  await act(async () => [...row().querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "billcode")!.click());
  expect(onSelect).toHaveBeenLastCalledWith({ kind: "attr", entityId: "head", attrId: "billcode" });
  expect(onStage).not.toHaveBeenCalled();
});

it("兼容字段加入草稿，失败时保留目标输入和编辑锁", async () => {
  const onStage = vi.fn().mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("映射预检失败")).mockResolvedValueOnce(true);
  const onEdited = vi.fn(), onSelect = vi.fn(), onEditingChange = vi.fn();
  await act(async () => root.render(<MetaSemanticPanel detail={detail()} selection={{ kind: "interface", interfaceId: itf.id }}
    onSelect={onSelect} onStage={onStage} onEdited={onEdited} onEditingChange={onEditingChange} locked={false} />));
  await act(async () => editButton().click());
  expect(onEditingChange).toHaveBeenLastCalledWith(true);
  expect(target().querySelector<HTMLOptionElement>('option[value="amount"]')!.disabled).toBe(true);
  await act(async () => choose(target(), "billcode"));
  await act(async () => button("加入草稿").click());
  expect(target().value).toBe("billcode");
  expect(onEdited).not.toHaveBeenCalled();
  expect(onEditingChange).toHaveBeenLastCalledWith(true);
  await act(async () => button("加入草稿").click());
  expect(document.body.textContent).toContain("映射预检失败");
  expect(target().value).toBe("billcode");
  await act(async () => choose(target(), "othercode"));
  await act(async () => button("加入草稿").click());
  expect(onStage).toHaveBeenLastCalledWith(expect.any(String), [{ op: "setMapping", entity: "head", interfaceId: itf.id, interfaceAttrId: "Icode", attrId: "othercode" }]);
  expect(onEdited).toHaveBeenCalledOnce();
  expect(onEditingChange).toHaveBeenLastCalledWith(false);
  expect(onSelect).not.toHaveBeenCalled();
  expect(mocks.invoke).not.toHaveBeenCalled();
  expect(document.querySelector('[aria-label="编辑接口映射"]')).toBeNull();
});

it("重复映射先全部解除，预览更新后才重新绑定", async () => {
  const onStage = vi.fn().mockResolvedValue(true), onSelect = vi.fn();
  const render = (mappings: BmfInterfaceMapping[]) => root.render(<MetaSemanticPanel detail={detail(mappings)} selection={{ kind: "interface", interfaceId: itf.id }}
    onSelect={onSelect} onStage={onStage} onEdited={() => {}} locked={false} />);
  await act(async () => render([binding("billcode"), binding("othercode")]));
  expect(row().textContent).toContain("重复映射");
  await act(async () => editButton().click());
  expect(target().disabled).toBe(true);
  expect(target().value).toBe("");
  expect(document.body.textContent).toContain("先解除全部重复项");
  await act(async () => button("加入草稿").click());
  expect(onStage).toHaveBeenLastCalledWith(expect.any(String), [{ op: "setMapping", entity: "head", interfaceId: itf.id, interfaceAttrId: "Icode", attrId: "" }]);
  await act(async () => render([]));
  await act(async () => editButton().click());
  expect(target().disabled).toBe(false);
  await act(async () => choose(target(), "billcode"));
  await act(async () => button("加入草稿").click());
  expect(onStage).toHaveBeenLastCalledWith(expect.any(String), [{ op: "setMapping", entity: "head", interfaceId: itf.id, interfaceAttrId: "Icode", attrId: "billcode" }]);
});

it("路径映射、缺失定义和孤立接口属性明确只读", async () => {
  const value = detail([binding("billcode", { attrPath: "body.code" }), binding("othercode", { interfaceAttrId: "orphan" })]);
  value.entities[0].interfaceIds!.push("unresolved");
  const onStage = vi.fn();
  await act(async () => root.render(<MetaSemanticPanel detail={value} selection={{ kind: "interface", interfaceId: itf.id }}
    onSelect={() => {}} onStage={onStage} onEdited={() => {}} locked={false} />));
  expect(row().textContent).toContain("路径映射 · 只读");
  expect(editButton().disabled).toBe(true);
  expect(host.textContent).toContain("接口属性 orphan 未加载");
  expect(host.textContent).toContain("接口 unresolved 未加载或存在定义冲突");
  await act(async () => editButton().click());
  expect(document.querySelector('[aria-label="编辑接口映射"]')).toBeNull();
  expect(onStage).not.toHaveBeenCalled();
});

it("目标字段缺失的旧映射保留原始标识，可直接解除", async () => {
  const onStage = vi.fn().mockResolvedValue(true);
  await act(async () => root.render(<MetaSemanticPanel detail={detail([binding("deleted-field")])} selection={{ kind: "interface", interfaceId: itf.id }}
    onSelect={() => {}} onStage={onStage} onEdited={() => {}} locked={false} />));
  expect(row().textContent).toContain("目标字段不存在");
  await act(async () => editButton().click());
  expect(target().value).toBe("deleted-field");
  expect(button("加入草稿").disabled).toBe(true);
  await act(async () => choose(target(), ""));
  await act(async () => button("加入草稿").click());
  expect(onStage).toHaveBeenLastCalledWith(expect.any(String), [{ op: "setMapping", entity: "head", interfaceId: itf.id, interfaceAttrId: "Icode", attrId: "" }]);
});

it("冲突后的重新加载关闭映射表单并调用真实重载回调", async () => {
  const onStage = vi.fn().mockRejectedValue(new Error("文件已被外部修改")), onReload = vi.fn(), onEdited = vi.fn();
  await act(async () => root.render(<MetaSemanticPanel detail={detail()} selection={{ kind: "interface", interfaceId: itf.id }}
    onSelect={() => {}} onStage={onStage} onEdited={onEdited} onReload={onReload} locked={false} />));
  await act(async () => editButton().click());
  await act(async () => choose(target(), "billcode"));
  await act(async () => button("加入草稿").click());
  await act(async () => button("重新加载组件").click());
  expect(onReload).toHaveBeenCalledOnce();
  expect(onEdited).not.toHaveBeenCalled();
  expect(document.querySelector('[aria-label="编辑接口映射"]')).toBeNull();
});

it("参照只打开已解析的完整定义路径，不猜测未解析路径", async () => {
  const value = detail();
  value.references = [
    { id: "resolved", refId: itf.id, name: "loaded", displayName: "已加载参照", fullClass: itf.fullClass, module: "demo", metadataPath: "demo.common", resolution: "" },
    { id: "missing", refId: "absent", name: "missing", displayName: "未解析参照", fullClass: "", module: "demo", metadataPath: "demo.unknown", resolution: "缺失定义" },
  ];
  const onOpenRefs = vi.fn(), onSelect = vi.fn();
  await act(async () => root.render(<MetaSemanticPanel detail={value} selection={{ kind: "reference", referenceId: "missing" }}
    onSelect={onSelect} onEdited={() => {}} onOpenRefs={onOpenRefs} locked={false} />));
  await act(async () => button("未解析参照").click());
  expect(onSelect).toHaveBeenLastCalledWith({ kind: "reference", referenceId: "missing" });
  expect(document.querySelectorAll('.meta-relation button').length).toBe(3);
  await act(async () => button("打开已定位定义").click());
  expect(onOpenRefs).toHaveBeenCalledExactlyOnceWith(itf.sourcePath);
});

it("1000 个映射属性只挂载可见行，选中远端属性自动定位", async () => {
  const attrs = Array.from({ length: 1000 }, (_, index) => ({ ...itf.attrs[0], id: `I${index}`, name: `p${index}` }));
  const value = metaDetail("large", { interfaces: [{ ...itf, attrs }], entities: [metaEntity("head", [], { interfaceIds: [itf.id] })], relations: [] });
  await act(async () => root.render(<MetaSemanticPanel detail={value} selection={{ kind: "interfaceAttr", interfaceId: itf.id, attrId: "I999" }}
    onSelect={() => {}} onEdited={() => {}} locked={false} />));
  expect(host.querySelectorAll('tr[data-mapping]').length).toBeLessThan(32);
  expect(host.querySelector('tr[data-mapping="head/I999"]')!.classList.contains("is-active")).toBe(true);
  expect(host.querySelector<HTMLElement>('.meta-field-scroll')!.scrollTop).toBeGreaterThan(30000);
});

it("500 实体乘以 1000 接口属性的映射表按可见索引取行", async () => {
  const attrs = Array.from({ length: 1000 }, (_, index) => ({ ...itf.attrs[0], id: `I${index}`, name: `p${index}` }));
  const entities = Array.from({ length: 500 }, (_, index) => metaEntity(`e${index}`, [], { interfaceIds: [itf.id] }));
  const value = metaDetail("large", { interfaces: [{ ...itf, attrs }], entities, relations: [] });
  await act(async () => root.render(<MetaSemanticPanel detail={value} selection={{ kind: "interface", interfaceId: itf.id }} onSelect={() => {}} onEdited={() => {}} locked={false} />));
  expect(host.querySelector('table')!.getAttribute("aria-rowcount")).toBe("500001");
  const scroll = host.querySelector<HTMLElement>('.meta-field-scroll')!;
  await act(async () => { scroll.scrollTop = 499996 * 32; scroll.dispatchEvent(new Event("scroll", { bubbles: true })); });
  expect(host.querySelectorAll('tr[data-mapping]').length).toBeLessThan(32);
  expect(host.querySelector('tr[data-mapping="e499/I999"]')).not.toBeNull();
});
