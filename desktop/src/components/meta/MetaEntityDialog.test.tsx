// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BmfEntity } from "../../lib/bmf";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));

import { MetaEntityDialog } from "./MetaEntityDialog";

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

const entity: BmfEntity = {
  id: "e1",
  name: "H",
  displayName: "表头",
  fullClass: "nc.vo.uapbd.demo.DemoHVO",
  table: "demo_h",
  accessor: "nc.vo.uapbd.demo.DemoHVO",
  isPrimary: true,
  keyAttrId: "a1",
  attrs: [
    {
      id: "a1",
      name: "pk",
      field: "pk",
      displayName: "主键",
      typeName: "UFID",
      typeDisplayName: "",
      dataType: "",
      style: "SINGLE",
      dbType: "",
      fieldType: "",
      length: 20,
      precision: null,
      isKey: true,
      nullable: false,
      defaultValue: "",
      refModel: "",
      sequence: 0,
      refTarget: "",
      raw: "",
    },
  ],
  raw: "",
};

function setValue(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

const button = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text)!;
const input = (placeholder: string) => document.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)!;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

it("新增实体：校验类名与表名，提交 addEntity 且清理首尾空白", async () => {
  mocks.invoke.mockImplementation((cmd: string) => {
    if (cmd === "bmf_edit_preview") return Promise.resolve("diff");
    if (cmd === "bmf_edit_save") return Promise.resolve({ path: "x", backup: null, shaBefore: "a", shaAfter: "b", diff: "", changed: true });
    return Promise.reject(new Error(`unexpected ${cmd}`));
  });
  const saved = vi.fn();
  await act(async () => root.render(<MetaEntityDialog path="D:/w/a.bmf" sha="sha" entity={null} onClose={() => {}} onSaved={saved} />));

  await act(async () => setValue(input("如 BillH"), "BillH"));
  await act(async () => setValue(input("如 bd_bill_h"), "bd_bill_h"));
  await act(async () => setValue(input("nc.vo.module.BillHVO"), "com.bad.Class"));
  expect(document.body.textContent).toContain("必须是 nc.vo. 开头");
  expect(button("预览 diff").disabled).toBe(true);

  await act(async () => setValue(input("nc.vo.module.BillHVO"), " nc.vo.uapbd.demo.BillHVO "));
  await act(async () => button("预览 diff").click());
  await flush();
  await act(async () => button("保存").click());
  await flush();

  const call = mocks.invoke.mock.calls.find(([cmd]) => cmd === "bmf_edit_save")!;
  const ops = (call[1] as { ops: Record<string, unknown>[] }).ops;
  expect(ops).toHaveLength(1);
  expect(ops[0]).toMatchObject({
    op: "addEntity",
    name: "BillH",
    table: "bd_bill_h",
    fullClass: "nc.vo.uapbd.demo.BillHVO",
  });
  expect(saved).toHaveBeenCalled();
});

it("编辑实体：主键改选提交 keyAttributeId", async () => {
  mocks.invoke.mockImplementation((cmd: string) => {
    if (cmd === "bmf_edit_preview") return Promise.resolve("diff");
    if (cmd === "bmf_edit_save") return Promise.resolve({ path: "x", backup: null, shaBefore: "a", shaAfter: "b", diff: "", changed: true });
    return Promise.reject(new Error(`unexpected ${cmd}`));
  });
  await act(async () => root.render(<MetaEntityDialog path="D:/w/a.bmf" sha="sha" entity={entity} onClose={() => {}} onSaved={() => {}} />));

  const select = document.querySelector<HTMLSelectElement>('select[aria-label="主键字段"]')!;
  act(() => {
    select.value = "";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => button("预览 diff").click());
  await flush();
  await act(async () => button("保存").click());
  await flush();

  const call = mocks.invoke.mock.calls.find(([cmd]) => cmd === "bmf_edit_save")!;
  const ops = (call[1] as { ops: Record<string, unknown>[] }).ops;
  expect(ops).toEqual([{ op: "setAttr", id: "e1", name: "keyAttributeId", value: "" }]);
});
