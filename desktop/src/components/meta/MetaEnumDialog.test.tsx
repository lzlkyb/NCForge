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

it("新增枚举与多项同批加入草稿，失败重试保留容器和枚举项 ID", async () => {
  const onStage = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true), onSaved = vi.fn();
  await act(async () => root.render(<MetaEnumDialog path="D:/w/a.bmf" sha="sha" en={null} onStage={onStage} onClose={() => {}} onSaved={onSaved} />));
  await act(async () => setValue(input("如 billstatus"), "billstatus"));
  await act(async () => setValue(input("值"), " 1 "));
  await act(async () => setValue(input("显示名"), " 草稿 "));
  await act(async () => button("加一项").click());
  await act(async () => setValue(input("值"), "2"));
  await act(async () => setValue(input("显示名"), "确认"));
  await act(async () => button("加一项").click());
  expect(document.body.textContent).toContain("枚举项（2）");
  await act(async () => button("加入草稿").click());
  const first = onStage.mock.calls[0][1] as Record<string, unknown>[];
  expect(first).toHaveLength(3);
  expect(first[0]).toMatchObject({ op: "addEnum", name: "billstatus" });
  expect(first[1]).toMatchObject({ op: "addEnumItem", enumId: first[0].id, value: "1", display: "草稿" });
  expect(first[2]).toMatchObject({ op: "addEnumItem", enumId: first[0].id, value: "2", display: "确认" });
  expect(first[1].id).not.toBe(first[2].id);
  expect(onSaved).not.toHaveBeenCalled();
  await act(async () => setValue(input("如 单据状态"), "状态"));
  await act(async () => button("加入草稿").click());
  const retry = onStage.mock.calls[1][1] as Record<string, unknown>[];
  expect(retry[0].id).toBe(first[0].id);
  expect(retry.slice(1)).toEqual(first.slice(1));
  expect(onSaved).toHaveBeenCalledOnce();
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it("空值不能添加，未加入的完整枚举项阻止应用并保留输入", async () => {
  const onStage = vi.fn();
  await act(async () => root.render(<MetaEnumDialog path="D:/w/a.bmf" sha="sha" en={en} onStage={onStage} onClose={() => {}} onSaved={() => {}} />));
  await act(async () => setValue(input("显示名"), "新状态"));
  await act(async () => setValue(input("值"), "   "));
  expect(button("加一项").disabled).toBe(true);
  expect(button("加入草稿").disabled).toBe(true);
  await act(async () => setValue(input("值"), "3"));
  expect(button("加一项").disabled).toBe(false);
  expect(button("加入草稿").disabled).toBe(true);
  expect(document.body.textContent).toContain("当前枚举项尚未加入");
  await act(async () => button("加入草稿").click());
  expect(onStage).not.toHaveBeenCalled();
  expect(input("值").value).toBe("3");
  await act(async () => button("加一项").click());
  expect(input("值").value).toBe("");
  expect(button("加入草稿").disabled).toBe(false);
});

it("带空白的重复枚举值阻止草稿，移除重复项可恢复", async () => {
  await act(async () => root.render(<MetaEnumDialog path="D:/w/a.bmf" sha="sha" en={en} onStage={vi.fn()} onClose={() => {}} onSaved={() => {}} />));
  await act(async () => setValue(input("值"), " 2 "));
  await act(async () => setValue(input("显示名"), "重复"));
  await act(async () => button("加一项").click());
  expect(button("加入草稿").disabled).toBe(true);
  await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="移除待新增枚举项 2"]')!.click());
  expect(button("加入草稿").disabled).toBe(false);
});
