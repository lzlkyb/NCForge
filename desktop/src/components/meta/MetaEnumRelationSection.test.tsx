// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { metaDetail } from "../../test/metaFixtures";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));
import { MetaEnumRelationSection } from "./MetaEnumRelationSection";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === text)!;
function setName(value: string) {
  const node = document.querySelector<HTMLInputElement>('input[placeholder="如 billstatus"]')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value);
  node.dispatchEvent(new Event("input", { bubbles: true }));
}
beforeEach(() => { mocks.invoke.mockReset(); host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ""; });

it("枚举和关系新增都转入文档草稿，并通知内部表单的编辑状态", async () => {
  const onStage = vi.fn().mockResolvedValue(true), onEdited = vi.fn(), onEditingChange = vi.fn();
  await act(async () => root.render(<MetaEnumRelationSection detail={metaDetail()} onStage={onStage} onEdited={onEdited} onEditingChange={onEditingChange} />));
  await act(async () => button("加枚举").click());
  expect(onEditingChange).toHaveBeenLastCalledWith(true);
  await act(async () => setName("status"));
  await act(async () => button("加入草稿").click());
  expect(onStage.mock.calls[0][1]).toEqual([expect.objectContaining({ op: "addEnum", name: "status" })]);
  expect(onEditingChange).toHaveBeenLastCalledWith(false);
  await act(async () => button("加关系").click());
  expect(onEditingChange).toHaveBeenLastCalledWith(true);
  await act(async () => button("加入草稿").click());
  expect(onStage.mock.calls[1][1]).toEqual([expect.objectContaining({ op: "addRelation", kind: "AggregationRelation", source: "head", target: "body" })]);
  expect(onEdited).toHaveBeenCalledTimes(2);
  expect(onEditingChange).toHaveBeenLastCalledWith(false);
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it("冲突重新加载关闭内部表单，独立调用 reload", async () => {
  const onStage = vi.fn().mockRejectedValue(new Error("文件已被外部修改")), onReload = vi.fn(), onEdited = vi.fn(), onEditingChange = vi.fn();
  await act(async () => root.render(<MetaEnumRelationSection detail={metaDetail()} onStage={onStage} onEdited={onEdited} onReload={onReload} onEditingChange={onEditingChange} />));
  await act(async () => button("加关系").click());
  await act(async () => button("加入草稿").click());
  await act(async () => button("重新加载组件").click());
  expect(onReload).toHaveBeenCalledOnce();
  expect(onEdited).not.toHaveBeenCalled();
  expect(onEditingChange).toHaveBeenLastCalledWith(false);
  expect(document.querySelector('[aria-label="新增关系"]')).toBeNull();
});

it("参照关系显示已加载名称，未知关系没有删除入口", async () => {
  const value = metaDetail();
  value.references = [{ id: "ref", refId: "other", name: "Ref", displayName: "外部参照", fullClass: "", module: "demo", metadataPath: "demo.other", resolution: "" }];
  value.relations = [{ ...value.relations[0], kind: "FutureConnection", target: "ref" }];
  await act(async () => root.render(<MetaEnumRelationSection detail={value} onEdited={() => {}} />));
  const relation = host.querySelector('.meta-relation')!;
  expect(relation.textContent).toContain("外部参照");
  expect(relation.textContent).toContain("未经验证的关系类型 · 只读");
  expect(relation.querySelector('.is-danger')).toBeNull();
});
