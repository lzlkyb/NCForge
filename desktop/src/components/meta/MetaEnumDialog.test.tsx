// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BmfEnum } from "../../lib/bmf";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));

import { MetaEnumDialog } from "./MetaEnumDialog";

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

const en: BmfEnum = {
  id: "n1",
  name: "billstatus",
  displayName: "单据状态",
  typeName: "String",
  dataType: "BS2",
  fullClass: "",
  items: [
    { id: "i1", value: "1", display: "A", hidden: false },
    { id: "i2", value: "2", display: "B", hidden: false },
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

it("编辑枚举：改名 + 删项 + 加项合成一批 ops", async () => {
  mocks.invoke.mockImplementation((cmd: string) => {
    if (cmd === "bmf_edit_preview") return Promise.resolve("diff");
    if (cmd === "bmf_edit_save") return Promise.resolve({ path: "x", backup: null, shaBefore: "a", shaAfter: "b", diff: "", changed: true });
    return Promise.reject(new Error(`unexpected ${cmd}`));
  });
  await act(async () => root.render(<MetaEnumDialog path="D:/w/a.bmf" sha="sha" en={en} onClose={() => {}} onSaved={() => {}} />));

  await act(async () => setValue(input("如 单据状态"), "单据状态（新）"));
  act(() => document.querySelector<HTMLButtonElement>('button[aria-label="删除枚举项 1"]')!.click());
  await act(async () => setValue(input("值"), "3"));
  await act(async () => setValue(input("显示名"), "C"));
  await act(async () => button("加一项").click());

  await act(async () => button("预览 diff").click());
  await flush();
  await act(async () => button("保存").click());
  await flush();

  const call = mocks.invoke.mock.calls.find(([cmd]) => cmd === "bmf_edit_save")!;
  const ops = (call[1] as { ops: Record<string, unknown>[] }).ops;
  expect(ops).toContainEqual({ op: "setAttr", id: "n1", name: "displayName", value: "单据状态（新）" });
  expect(ops).toContainEqual({ op: "deleteNode", id: "i1" });
  expect(ops).toContainEqual(expect.objectContaining({ op: "addEnumItem", enumId: "n1", value: "3", display: "C" }));
});

it("重复枚举值会阻止预览", async () => {
  await act(async () => root.render(<MetaEnumDialog path="D:/w/a.bmf" sha="sha" en={en} onClose={() => {}} onSaved={() => {}} />));
  await act(async () => setValue(input("值"), "2"));
  await act(async () => setValue(input("显示名"), "重复"));
  await act(async () => button("加一项").click());
  expect(document.body.textContent).toContain("枚举值重复");
  expect(button("预览 diff").disabled).toBe(true);
});
