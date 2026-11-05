// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BmfAttr, BmfEntity } from "../../lib/bmf";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));

import { MetaEditDialog } from "./MetaEditDialog";

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

const attr: BmfAttr = {
  id: "a1",
  name: "vbillcode",
  field: "vbillcode",
  displayName: "单据号",
  typeName: "String",
  typeDisplayName: "字符串",
  dataType: "BS000010000100001001",
  style: "SINGLE",
  dbType: "varchar",
  fieldType: "varchar",
  length: 40,
  precision: null,
  isKey: false,
  nullable: true,
  defaultValue: "",
  refModel: "",
  sequence: 1,
  refTarget: "",
  raw: "",
};

const entity: BmfEntity = {
  id: "e1",
  name: "H",
  displayName: "表头",
  fullClass: "nc.vo.uapbd.demo.DemoHVO",
  table: "demo_h",
  accessor: "getHead",
  isPrimary: true,
  keyAttrId: "a1",
  attrs: [attr],
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

it("长度必须是正整数，预览后才允许保存，改任何输入都会让预览失效", async () => {
  mocks.invoke.mockImplementation((cmd: string) => {
    if (cmd === "bmf_edit_preview") return Promise.resolve("--- 原文件\n+++ 修改后");
    if (cmd === "bmf_edit_save") return Promise.resolve({ path: "x", backup: null, shaBefore: "a", shaAfter: "b", diff: "", changed: true });
    return Promise.reject(new Error(`unexpected ${cmd}`));
  });
  await act(async () =>
    root.render(<MetaEditDialog path="D:/w/METADATA/demo.bmf" sha="sha" entity={entity} attr={null} onClose={() => {}} onSaved={() => {}} />),
  );

  expect(button("保存").disabled).toBe(true);

  await act(async () => setValue(input("如 vbillcode（小写字母开头）"), "BadName"));
  expect(document.body.textContent).toContain("只能用小写字母");
  expect(button("预览 diff").disabled).toBe(true);

  await act(async () => setValue(input("如 vbillcode（小写字母开头）"), "good_name"));
  await act(async () => setValue(input("空 = 不写"), "abc"));
  expect(document.body.textContent).toContain("长度必须是大于 0 的整数");
  expect(button("预览 diff").disabled).toBe(true);

  await act(async () => setValue(input("空 = 不写"), "40"));
  expect(button("预览 diff").disabled).toBe(false);
  await act(async () => button("预览 diff").click());
  await flush();
  expect(button("保存").disabled).toBe(false);

  // 预览之后又改了显示名：旧 diff 不再对应当前输入，保存必须重新变灰。
  await act(async () => setValue(input("界面上的中文名"), "单据号2"));
  expect(button("保存").disabled).toBe(true);

  await act(async () => button("预览 diff").click());
  await flush();
  await act(async () => button("保存").click());
  await flush();

  const saveCall = mocks.invoke.mock.calls.find(([cmd]) => cmd === "bmf_edit_save")!;
  const op = (saveCall[1] as { ops: { name: string; length: number }[] }).ops[0];
  expect(op.name).toBe("good_name");
  expect(op.length).toBe(40);
});

it("SHA 冲突时给出内联错误与重新加载入口，而不是只闪一条 toast", async () => {
  mocks.invoke.mockImplementation((cmd: string) => {
    if (cmd === "bmf_edit_preview") return Promise.resolve("diff");
    if (cmd === "bmf_edit_save") return Promise.reject(new Error("文件已被外部修改（SHA-256 不一致），请重新加载组件后再保存"));
    return Promise.reject(new Error(`unexpected ${cmd}`));
  });
  const onReload = vi.fn();
  await act(async () =>
    root.render(
      <MetaEditDialog path="D:/w/METADATA/demo.bmf" sha="sha" entity={entity} attr={attr} onClose={() => {}} onSaved={() => {}} onReload={onReload} />,
    ),
  );
  await act(async () => setValue(input("界面上的中文名"), "改过的名字"));
  await act(async () => button("预览 diff").click());
  await flush();
  await act(async () => button("保存").click());
  await flush();

  expect(document.body.textContent).toContain("文件已被外部修改");
  await act(async () => button("重新加载组件").click());
  expect(onReload).toHaveBeenCalled();
});
