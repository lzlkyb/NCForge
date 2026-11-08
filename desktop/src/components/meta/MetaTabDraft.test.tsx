// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BmfDetail, BmfDraftPreview, BmfEditOp } from "../../lib/bmf";
import { metaDetail, metaEntry } from "../../test/metaFixtures";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));
import { MetaTab } from "./MetaTab";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement, disk: BmfDetail, saveError: string | null;
const entry = metaEntry();
const clone = (detail: BmfDetail): BmfDetail => JSON.parse(JSON.stringify(detail));
function project(ops: BmfEditOp[], expectedSha: string): BmfDraftPreview {
  if (expectedSha !== disk.sha256) throw new Error("文件已被外部修改 SHA-256");
  const projected = clone(disk);
  for (const op of ops) {
    if (op.op !== "setAttr" || op.name !== "displayName") throw new Error("本场景只模拟显示名操作");
    const attr = projected.entities.flatMap((entity) => entity.attrs).find((a) => a.id === op.id)!;
    attr.displayName = op.value;
  }
  projected.sha256 = ops.length ? `draft-${JSON.stringify(ops)}` : disk.sha256;
  return { detail: projected, diff: ops.length ? "-旧显示名\n+新显示名" : "", baseSha: disk.sha256, ops, blockingIssues: [] };
}
beforeEach(async () => {
  disk = metaDetail("demo", { issues: [] }); saveError = null;
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("prefers-reduced-motion"), addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation((command: string, args: { ops: BmfEditOp[]; expectedSha: string }) => {
    if (command === "bmf_index_scan") return Promise.resolve({ entries: [entry], roots: [], warnings: [], elapsedMs: 1, cached: 0 });
    if (command === "bmf_doc_detail") return Promise.resolve(clone(disk));
    if (command === "bmf_draft_preview") return Promise.resolve(project(args.ops, args.expectedSha));
    if (command === "bmf_edit_save") {
      if (saveError) return Promise.reject(new Error(saveError));
      const preview = project(args.ops, args.expectedSha); disk = preview.detail;
      return Promise.resolve({ path: disk.path, shaBefore: args.expectedSha, shaAfter: disk.sha256, diff: preview.diff, backup: "D:/backup/demo.bmf", changed: true });
    }
    throw new Error(`未预期的 IPC ${command}`);
  });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root.render(<MetaTab />));
  await act(async () => host.querySelector<HTMLButtonElement>(".meta-entry")!.click());
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === name)!;
const currentLabel = () => host.querySelector('.meta-field-table [data-attr="billcode"] td:nth-child(3)')?.textContent;
function value(input: HTMLInputElement | HTMLTextAreaElement, text: string) {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
async function quickEdit() {
  await act(async () => host.querySelector<HTMLElement>('.meta-field-table [data-attr="billcode"]')!.click());
  await act(async () => host.querySelector<HTMLElement>(".meta-field-scroll")!.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true })));
  const input = host.querySelector<HTMLInputElement>('[aria-label="快速编辑显示名"]')!;
  await act(async () => value(input, "新单据编码"));
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
}

it("专注模式收起侧栏且保留草稿、选中字段和同一个表格滚动容器", async () => {
  await quickEdit();
  const fields = host.querySelector<HTMLElement>(".meta-field-scroll")!;
  fields.scrollTop = 64;
  await act(async () => fields.dispatchEvent(new Event("scroll", { bubbles: true })));
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="进入元数据专注模式"]')!.click());
  expect(host.querySelector(".meta-workbench")?.getAttribute("data-focused")).toBe("true");
  expect(host.querySelector<HTMLElement>(".meta-resource-panel")!.hidden).toBe(true);
  expect(host.querySelector<HTMLElement>(".meta-inspector-panel")!.hidden).toBe(true);
  expect(host.querySelector(".meta-field-scroll")).toBe(fields);
  expect(fields.scrollTop).toBe(64);
  expect(currentLabel()).toBe("新单据编码");
  expect(host.querySelector('.meta-field-table [data-attr="billcode"]')?.getAttribute("aria-selected")).toBe("true");
  await act(async () => button("属性").click());
  expect(host.querySelector('.meta-inspector-panel[role="dialog"]')).not.toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="收起属性检查器"]')!.click());
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="退出元数据专注模式"]')!.click());
  expect(host.querySelector(".meta-workbench")?.hasAttribute("data-focused")).toBe(false);
  expect(host.querySelector<HTMLElement>(".meta-resource-panel")!.hidden).toBe(false);
  expect(currentLabel()).toBe("新单据编码");
  expect(mocks.invoke.mock.calls.some(([command]) => command === "bmf_edit_save")).toBe(false);
});

it("F2 快改只加入草稿；撤销和重做同步图、表、检查器且不写盘", async () => {
  await quickEdit();
  expect(currentLabel()).toBe("新单据编码");
  expect(host.querySelector(".meta-property-inspector h3")?.textContent).toBe("新单据编码");
  expect(host.querySelector('[aria-label="待保存"]')).not.toBeNull();
  expect(disk.entities[0].attrs[0].displayName).toBe("字段 billcode");
  expect(mocks.invoke.mock.calls.some(([command]) => command === "bmf_edit_save")).toBe(false);
  const xml = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "查看原始 XML")!;
  expect(xml.disabled).toBe(true);
  await act(async () => button("撤销").click());
  expect(currentLabel()).toBe("字段 billcode");
  await act(async () => button("重做").click());
  expect(currentLabel()).toBe("新单据编码");
});
it("关闭脏文档先保护草稿，继续编辑保留修改，放弃后才能关闭", async () => {
  await quickEdit();
  const close = () => host.querySelector<HTMLButtonElement>('[aria-label="关闭 demo"]')!.click();
  await act(async () => close());
  expect(document.querySelector('[aria-label="关闭未保存的元数据文档"]')).not.toBeNull();
  await act(async () => button("继续编辑").click());
  expect(currentLabel()).toBe("新单据编码");
  await act(async () => close());
  await act(async () => button("放弃并关闭").click());
  expect(host.querySelector(".meta-document-tab")).toBeNull();
  expect(disk.entities[0].attrs[0].displayName).toBe("字段 billcode");
});
it("预览后保存使用新鲜差异和基础 SHA，成功后关闭原文档", async () => {
  await quickEdit();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="关闭 demo"]')!.click());
  await act(async () => button("预览后保存").click());
  expect(document.querySelector('[aria-label="保存元数据草稿"]')).not.toBeNull();
  expect(disk.entities[0].attrs[0].displayName).toBe("字段 billcode");
  await act(async () => button("保存全部修改").click());
  expect(mocks.invoke).toHaveBeenCalledWith("bmf_edit_save", expect.objectContaining({ expectedSha: "sha-original", expectedDefinitions: {}, strict: true }));
  expect(disk.entities[0].attrs[0].displayName).toBe("新单据编码");
  expect(host.querySelector(".meta-document-tab")).toBeNull();
});
it("保存失败保留草稿和输入，重新预览可重试成功", async () => {
  await quickEdit(); saveError = "备份失败";
  await act(async () => button("预览保存").click());
  await act(async () => button("保存全部修改").click());
  expect(document.body.textContent).toContain("备份失败");
  expect(currentLabel()).toBe("新单据编码");
  expect(host.querySelector('[aria-label="待保存"]')).not.toBeNull();
  expect(button("保存全部修改").disabled).toBe(true);
  await act(async () => button("继续编辑").click());
  saveError = null;
  await act(async () => button("预览保存").click());
  await act(async () => button("保存全部修改").click());
  expect(host.querySelector('[aria-label="待保存"]')).toBeNull();
  expect(disk.entities[0].attrs[0].displayName).toBe("新单据编码");
});
it("非法粘贴不生成部分草稿；修正后端确认前没有写盘", async () => {
  await act(async () => button("字段操作").click());
  await act(async () => button("粘贴字段").click());
  const input = document.querySelector<HTMLTextAreaElement>('[aria-label="粘贴字段内容"]')!;
  await act(async () => value(input, "字段名\t长度\nnewfield\t40\nsecond\t-1"));
  expect(document.body.textContent).toContain("第 3 行");
  expect(button("加入草稿").disabled).toBe(true);
  await act(async () => button("加入草稿").click());
  expect(mocks.invoke.mock.calls.some(([command]) => command === "bmf_draft_preview")).toBe(false);
  expect(host.querySelector('[aria-label="待保存"]')).toBeNull();
});
it("预览后外部改文件拒绝保存，已有草稿仍可查看和放弃", async () => {
  await quickEdit();
  await act(async () => button("预览保存").click());
  disk.sha256 = "changed-externally";
  disk.entities[0].attrs[0].displayName = "外部编码";
  await act(async () => button("保存全部修改").click());
  expect(mocks.invoke.mock.calls.some(([command]) => command === "bmf_edit_save")).toBe(false);
  expect(document.body.textContent).toContain("文件已被外部修改");
  expect(currentLabel()).toBe("新单据编码");
  expect(disk.entities[0].attrs[0].displayName).toBe("外部编码");
});
