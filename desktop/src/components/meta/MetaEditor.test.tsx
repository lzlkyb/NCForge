// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { newMetaEditorState, type MetaEditorState } from "../../lib/metaEditor";
import { metaAttr, metaDetail, metaEntity, metaIssue } from "../../test/metaFixtures";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));
import { MetaEditor } from "./MetaEditor";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root, ui: MetaEditorState, detail: ReturnType<typeof metaDetail>;
let drawer: boolean, open: boolean;
const edited = vi.fn(), editingChanged = vi.fn();
function render() {
  root.render(<MetaEditor detail={detail} state={ui} mode={ui.mode} issues={[metaIssue()]} issueBusy={false} issueError={null}
    inspectorDrawer={drawer} inspectorOpen={open} inspectorWidth={280} onInspectorWidth={() => {}}
    onInspectorOpen={(value) => { open = value; render(); }} onState={(patch, update = true) => { ui = { ...ui, ...patch }; if (update) render(); }}
    onEdited={edited} onOpenRefs={() => {}} onEditingChange={editingChanged} />);
}
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text)!;
function setValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
beforeEach(async () => {
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  ui = newMetaEditorState(); detail = metaDetail(); drawer = false; open = false;
  edited.mockReset(); editingChanged.mockReset(); mocks.invoke.mockReset();
  await act(async () => render());
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it("合并后的实体选择仍切换字段，实体操作菜单仍能打开属性检查器", async () => {
  drawer = true;
  await act(async () => render());
  const select = host.querySelector<HTMLSelectElement>('.meta-fields-head [aria-label="当前实体"]')!;
  await act(async () => { select.value = "body"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(ui.selection).toEqual({ kind: "entity", entityId: "body" });
  expect(host.querySelector('.meta-field-table [data-attr="item"]')).not.toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="实体操作"]')!.click());
  const properties = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(b => b.textContent?.includes("实体属性"))!;
  await act(async () => properties.click());
  expect(open).toBe(true);
  expect(host.querySelector('.meta-inspector-panel[role="dialog"]')).not.toBeNull();
  expect(ui.selection).toEqual({ kind: "entity", entityId: "body" });
});

it("图、表和检查器联动，选关系后两端与来源字段保持一致", async () => {
  await act(async () => host.querySelector<HTMLElement>('.meta-field-table [data-attr="amount"]')!.click());
  expect(host.querySelector('.meta-canvas-field[data-attr="amount"]')!.getAttribute("aria-pressed")).toBe("true");
  expect(host.querySelector(".meta-property-inspector h3")!.textContent).toBe("字段 amount");
  await act(async () => host.querySelector<SVGGElement>('.meta-canvas-field[data-attr="item"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(ui.selection).toEqual({ kind: "attr", entityId: "body", attrId: "item" });
  expect(host.querySelector('.meta-field-table [data-attr="item"]')!.getAttribute("aria-selected")).toBe("true");
  await act(async () => host.querySelector<SVGGElement>('.meta-canvas-rel[data-rel="rel"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(ui.selection).toEqual({ kind: "relation", relationId: "rel" });
  expect(host.querySelectorAll(".meta-canvas-node.is-active")).toHaveLength(2);
  expect(host.querySelector('.meta-field-table [data-attr="amount"]')!.getAttribute("aria-selected")).toBe("true");
  expect(host.querySelector(".meta-property-inspector")!.textContent).toContain("关系属性");
});
it("筛选不替换选中对象，检查器仍显示被筛掉字段", async () => {
  await act(async () => host.querySelector<HTMLElement>('.meta-field-table [data-attr="amount"]')!.click());
  await act(async () => setValue(host.querySelector<HTMLInputElement>('input[aria-label="过滤字段"]')!, "billcode"));
  expect(host.querySelector(".meta-filter-note")!.textContent).toContain("当前字段不在筛选结果中");
  expect(ui.selection).toEqual({ kind: "attr", entityId: "head", attrId: "amount" });
  expect(host.querySelector(".meta-property-inspector h3")!.textContent).toBe("字段 amount");
});
it("清除筛选会滚回长表中的选中字段", async () => {
  detail = metaDetail("demo", { entities: [metaEntity("head", Array.from({ length: 2000 }, (_, i) => metaAttr(`field${i}`)))], relations: [] });
  ui = { ...ui, selection: { kind: "attr", entityId: "head", attrId: "field1500" } };
  await act(async () => render());
  await act(async () => setValue(host.querySelector<HTMLInputElement>('input[aria-label="过滤字段"]')!, "field0"));
  expect(host.querySelector(".meta-filter-note")).not.toBeNull();
  await act(async () => button("清除筛选并定位").click());
  expect(host.querySelector<HTMLElement>(".meta-field-scroll")!.scrollTop).toBeGreaterThan(40000);
  expect(host.querySelector('.meta-field-table [data-attr="field1500"]')!.getAttribute("aria-selected")).toBe("true");
});
it("检查器内编辑复用预览保存链，失败保留输入；抽屉切换不会重建表单", async () => {
  mocks.invoke.mockImplementation((cmd: string) => {
    if (cmd === "bmf_edit_preview") return Promise.resolve("diff");
    if (cmd === "bmf_edit_save") return Promise.reject(new Error("文件已被外部修改 SHA-256"));
    throw new Error(`unexpected ${cmd}`);
  });
  await act(async () => host.querySelector<HTMLElement>('.meta-field-table [data-attr="amount"]')!.click());
  await act(async () => button("编辑字段").click());
  expect(editingChanged).toHaveBeenLastCalledWith(true);
  const input = host.querySelector<HTMLInputElement>('input[placeholder="界面上的中文名"]')!;
  await act(async () => setValue(input, "金额新名字"));
  await act(async () => { drawer = true; open = true; render(); });
  expect(host.querySelector('input[placeholder="界面上的中文名"]')).toBe(input);
  expect(input.value).toBe("金额新名字");
  await act(async () => button("预览 diff").click());
  await act(async () => button("保存").click());
  expect(input.value).toBe("金额新名字");
  expect(host.textContent).toContain("文件已被外部修改");
  await act(async () => host.querySelector<SVGGElement>('.meta-canvas-field[data-attr="item"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(ui.selection).toEqual({ kind: "attr", entityId: "head", attrId: "amount" });
  await act(async () => button("取消").click());
  expect(editingChanged).toHaveBeenLastCalledWith(false);
});
it("校验问题直接定位字段，并保留原始问题列表入口", async () => {
  await act(async () => button("校验问题1").click());
  await act(async () => button("定位对象").click());
  expect(ui.pane).toBe("fields");
  expect(ui.selection).toEqual({ kind: "attr", entityId: "head", attrId: "amount" });
  expect(host.querySelector(".meta-property-inspector")!.textContent).toContain("缺少长度");
});
it("2000 字段的可见范围有界，方向键选择和 F2 编辑可用", async () => {
  detail = metaDetail("demo", { entities: [metaEntity("head", Array.from({ length: 2000 }, (_, i) => metaAttr(`field${i}`)))], relations: [] });
  await act(async () => render());
  expect(host.querySelectorAll(".meta-field-table tr[data-attr]").length).toBeLessThan(40);
  const table = host.querySelector<HTMLElement>(".meta-field-scroll")!;
  await act(async () => table.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  expect(ui.selection).toEqual({ kind: "attr", entityId: "head", attrId: "field0" });
  await act(async () => table.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true })));
  expect(host.querySelector(".meta-inline-edit h3")!.textContent).toContain("field0");
});

it("全选筛选结果保留被隐藏的批量选择，取消时只移除当前结果", async () => {
  ui = { ...ui, selectedFields: ["amount"] };
  await act(async () => render());
  await act(async () => setValue(host.querySelector<HTMLInputElement>('input[aria-label="过滤字段"]')!, "billcode"));
  const all = host.querySelector<HTMLInputElement>('input[aria-label="选择筛选后的全部字段"]')!;
  await act(async () => all.click());
  expect(ui.selectedFields).toEqual(["amount", "billcode"]);
  await act(async () => all.click());
  expect(ui.selectedFields).toEqual(["amount"]);
});
