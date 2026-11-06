// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { metaDetail } from "../../test/metaFixtures";
import { MetaInspector } from "./MetaInspector";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ""; });

it("已有关系可编辑已验证属性，端点定位保留实体字段与参照类型", async () => {
  const value = metaDetail();
  value.references = [{ id: "refItf", refId: "IObject", name: "Ref", displayName: "外部参照", fullClass: "nc.vo.demo.IObject", module: "demo", metadataPath: "demo.common", resolution: "" }];
  value.relations = [{ id: "rel", kind: "busiitfconnection", name: "实现关系", source: "head", target: "refItf", srcAttrId: "billcode", targetAttrId: "", implementationClass: "nc.impl.demo.ObjectImpl" }];
  const onEdit = vi.fn(), onSelect = vi.fn();
  await act(async () => root.render(<MetaInspector detail={value} selection={{ kind: "relation", relationId: "rel" }} issues={[]} onEdit={onEdit} onSelect={onSelect} onEdited={() => {}} />));
  expect(host.textContent).toContain("nc.impl.demo.ObjectImpl");
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "编辑关系")!.click());
  expect(onEdit).toHaveBeenCalledExactlyOnceWith("relation");
  const endpoints = host.querySelectorAll<HTMLButtonElement>('.meta-relation-end button');
  await act(async () => endpoints[0].click());
  expect(onSelect).toHaveBeenLastCalledWith({ kind: "attr", entityId: "head", attrId: "billcode" });
  await act(async () => endpoints[1].click());
  expect(onSelect).toHaveBeenLastCalledWith({ kind: "reference", referenceId: "refItf" });
});

it("未知关系类型的只读提示与能力一致，没有编辑或删除入口", async () => {
  const value = metaDetail(); value.relations[0].kind = "FutureConnection";
  await act(async () => root.render(<MetaInspector detail={value} selection={{ kind: "relation", relationId: "rel" }} issues={[]} onEdit={vi.fn()} onSelect={vi.fn()} onEdited={() => {}} />));
  expect(host.textContent).toContain("此关系类型的写入语义尚未验证");
  expect(host.querySelector('.meta-inspector-actions')!.textContent?.trim()).toBe("");
});
