// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { metaAttr, metaDetail, metaEntity } from "../../test/metaFixtures";
import { MetaOutline } from "./MetaOutline";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text)!;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

it("500 实体与当前实体的 1000 字段只挂载可见大纲行，远端选择自动定位", async () => {
  const entities = Array.from({ length: 500 }, (_, index) => metaEntity(`e${index}`, index === 499 ? Array.from({ length: 1000 }, (_, n) => metaAttr(`f${n}`)) : []));
  const value = metaDetail("large", { entities, relations: [] });
  await act(async () => root.render(<MetaOutline detail={value} selection={{ kind: "attr", entityId: "e499", attrId: "f999" }} locked={false} onSelect={() => {}} />));
  expect(host.querySelectorAll('.meta-outline-row').length).toBeLessThan(30);
  expect(host.querySelector('.meta-outline-row[aria-pressed="true"]')!.textContent).toContain("字段 f999");
  expect(host.querySelector<HTMLElement>('.meta-outline-scroll')!.scrollTop).toBeGreaterThan(40000);
});

it("业务接口、接口属性和参照保留独立选择类型", async () => {
  const value = metaDetail("demo", { entities: [], relations: [],
    interfaces: [{ id: "IObject", name: "IObject", displayName: "业务对象", fullClass: "nc.vo.demo.IObject", external: false, sourcePath: "", definitionSha: "sha",
      attrs: [{ id: "Icode", name: "businesscode", displayName: "业务编码", typeName: "String", dataType: "", style: "SINGLE", dbType: "varchar", sequence: 1 }] }],
    references: [{ id: "ref", refId: "IObject", name: "Ref", displayName: "外部参照", fullClass: "nc.vo.demo.IObject", module: "demo", metadataPath: "demo.common", resolution: "" }],
  });
  const onSelect = vi.fn();
  await act(async () => root.render(<MetaOutline detail={value} selection={{ kind: "component" }} locked={false} onSelect={onSelect} />));
  await act(async () => button("业务对象").click());
  expect(onSelect).toHaveBeenLastCalledWith({ kind: "interface", interfaceId: "IObject" });
  await act(async () => root.render(<MetaOutline detail={value} selection={{ kind: "interface", interfaceId: "IObject" }} locked={false} onSelect={onSelect} />));
  await act(async () => button("业务编码").click());
  expect(onSelect).toHaveBeenLastCalledWith({ kind: "interfaceAttr", interfaceId: "IObject", attrId: "Icode" });
  await act(async () => button("外部参照").click());
  expect(onSelect).toHaveBeenLastCalledWith({ kind: "reference", referenceId: "ref" });
});

it("方向键及 Home/End 导航，锁定后保持当前选择", async () => {
  const value = metaDetail(), onSelect = vi.fn();
  await act(async () => root.render(<MetaOutline detail={value} selection={{ kind: "entity", entityId: "head" }} locked={false} onSelect={onSelect} />));
  const region = host.querySelector<HTMLElement>('[aria-label="模型对象大纲"]')!;
  await act(async () => region.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  expect(onSelect).toHaveBeenLastCalledWith({ kind: "attr", entityId: "head", attrId: "billcode" });
  await act(async () => region.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
  expect(onSelect).toHaveBeenLastCalledWith({ kind: "component" });
  await act(async () => region.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
  expect(onSelect).toHaveBeenLastCalledWith({ kind: "relation", relationId: "rel" });
  await act(async () => region.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
  expect(onSelect).toHaveBeenLastCalledWith({ kind: "component" });
  await act(async () => root.render(<MetaOutline detail={value} selection={{ kind: "entity", entityId: "head" }} locked onSelect={onSelect} />));
  onSelect.mockClear();
  await act(async () => region.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  await act(async () => button("字段 billcode").click());
  expect(onSelect).not.toHaveBeenCalled();
  expect(host.querySelector('.meta-outline-row[aria-pressed="true"]')!.textContent).toContain("head实体");
});
