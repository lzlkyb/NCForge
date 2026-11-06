// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BmfEditOp, BmfImportPreview } from "../../lib/bmf";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));

import { MetaExcel } from "./MetaExcel";

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

const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

const ops: BmfEditOp[] = [
  { op: "setAttr", id: "a1", name: "length", value: "32" },
  { op: "addAttribute", entity: "e1", name: "memo2", displayName: "备注2" },
];

const preview = (errors: number): BmfImportPreview => {
  const rows: BmfImportPreview["rows"] = [
    {
      row: 2,
      entity: "H",
      attrName: "pk",
      status: "update",
      changes: [{ field: "长度", before: "", after: "32" }],
      message: "",
    },
    {
      row: 3,
      entity: "H",
      attrName: "memo2",
      status: "add",
      changes: [{ field: "字段名", before: "", after: "memo2" }],
      message: "",
    },
    { row: 4, entity: "H", attrName: "memo", status: "same", changes: [], message: "" },
    {
      row: 5,
      entity: "Missing",
      attrName: "x",
      status: "error",
      changes: [],
      message: "实体 Missing 不在这个组件里",
    },
  ];
  return {
    file: "D:/ws/demo-字段模板.xlsx",
    sheet: "字段",
    sha256: "sha-1",
    rows: errors ? rows : rows.slice(0, 3),
    ops: errors ? [] : ops,
    add: 1,
    update: 1,
    same: 1,
    errors,
  };
};

const fillFile = async (value: string) => {
  const input = host.querySelector<HTMLInputElement>('[aria-label="导入文件路径"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const click = async (label: string) => {
  const btn = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    b.textContent?.includes(label),
  )!;
  await act(async () => {
    btn.click();
    await flush();
  });
  return btn;
};

it("预览逐行展示新增/修改/无变化/错误，有错误时禁止写入", async () => {
  mocks.invoke.mockImplementation((cmd: string) => {
    if (cmd === "bmf_excel_preview") return Promise.resolve(preview(1));
    return Promise.reject(new Error(`unexpected ${cmd}`));
  });
  const onEdited = vi.fn();
  await act(async () => root.render(<MetaExcel path="D:/ws/METADATA/demo.bmf" component="demo" onEdited={onEdited} />));
  await fillFile("D:/ws/filled.xlsx");
  await click("解析预览");
  const writeBtn = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    b.textContent?.includes("写入"),
  )!;

  expect(mocks.invoke).toHaveBeenCalledWith("bmf_excel_preview", {
    path: "D:/ws/METADATA/demo.bmf",
    file: "D:/ws/filled.xlsx",
  });
  expect(host.textContent).toContain("实体 Missing 不在这个组件里");
  expect(host.textContent).toContain("有 1 行错误");
  expect(writeBtn.disabled).toBe(true);
  expect(host.textContent).toContain("自有模板");
  expect(host.textContent).toContain("非官方 PDM");
});

it("无错误时按预览时的 SHA 写入并回报 diff", async () => {
  mocks.invoke.mockImplementation((cmd: string) => {
    if (cmd === "bmf_excel_preview") return Promise.resolve(preview(0));
    if (cmd === "bmf_edit_save")
      return Promise.resolve({
        path: "D:/ws/METADATA/demo.bmf",
        backup: "C:/cfg/bmf_backup/20261105-demo.bmf",
        shaBefore: "sha-1",
        shaAfter: "sha-2",
        diff: "--- a\n+++ b\n@@ -1 +1 @@\n-length=\"\"\n+length=\"32\"",
        changed: true,
      });
    return Promise.reject(new Error(`unexpected ${cmd}`));
  });
  const onEdited = vi.fn();
  await act(async () => root.render(<MetaExcel path="D:/ws/METADATA/demo.bmf" component="demo" onEdited={onEdited} />));
  await fillFile("D:/ws/filled.xlsx");
  await click("解析预览");
  await click("写入 2 条变更");

  expect(mocks.invoke).toHaveBeenCalledWith("bmf_edit_save", {
    path: "D:/ws/METADATA/demo.bmf",
    ops,
    expectedSha: "sha-1",
    expectedDefinitions: null,
    strict: false,
  });
  expect(onEdited).toHaveBeenCalled();
  expect(host.textContent).toContain("+length=\"32\"");
});
