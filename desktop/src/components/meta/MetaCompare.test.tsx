// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BmfDetail, BmfEntry } from "../../lib/bmf";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));

import { MetaCompare } from "./MetaCompare";

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

const mkDetail = (version: number, len: number): BmfDetail => ({
  path: "D:/ws/METADATA/demo.bmf",
  encoding: "UTF-8",
  eol: "CRLF",
  bom: false,
  size: 1,
  sha256: "",
  mtimeMs: 0,
  component: {
    id: "c",
    name: "demo",
    displayName: "演示",
    namespace: "m",
    ownModule: "m",
    genCodeStyle: "",
    version,
    mainEntity: "e",
    industry: "",
    metaType: "",
  },
  entities: [
    {
      id: "e",
      name: "H",
      displayName: "H",
      fullClass: "nc.vo.m.H",
      table: "t_h",
      accessor: "",
      isPrimary: false,
      keyAttrId: "a",
      raw: "",
      attrs: [
        {
          id: "a",
          name: "billno",
          field: "billno",
          displayName: "单据号",
          typeName: "String",
          typeDisplayName: "",
          dataType: "",
          style: "",
          dbType: "",
          fieldType: "",
          length: len,
          precision: null,
          isKey: false,
          nullable: true,
          defaultValue: "",
          refModel: "",
          sequence: 0,
          refTarget: "",
          raw: "",
        },
      ],
    },
  ],
  enums: [],
  relations: [],
  unknownTags: [],
});

const entries: BmfEntry[] = [
  {
    path: "D:/ws/METADATA/demo.bmf",
    module: "m",
    origin: "主工程",
    name: "demo",
    displayName: "演示",
    namespace: "m",
    version: 1,
    entityCount: 1,
    attrCount: 1,
    enumCount: 0,
    size: 1,
    mtimeMs: 0,
    error: null,
  },
  {
    path: "D:/old/METADATA/demo.bmf",
    module: "m",
    origin: "旧工程",
    name: "demo",
    displayName: "演示",
    namespace: "m",
    version: 3,
    entityCount: 1,
    attrCount: 1,
    enumCount: 0,
    size: 1,
    mtimeMs: 0,
    error: null,
  },
];

it("选择对比对象后按字段级列出差异，并排除当前文件", async () => {
  mocks.invoke.mockImplementation((cmd: string) => {
    if (cmd === "bmf_doc_detail") return Promise.resolve(mkDetail(3, 50));
    return Promise.reject(new Error(`unexpected ${cmd}`));
  });

  await act(async () => root.render(<MetaCompare current={mkDetail(1, 20)} entries={entries} />));
  const select = host.querySelector<HTMLSelectElement>('[aria-label="选择对比的 BMF"]')!;
  expect(select.options).toHaveLength(2); // 占位 + 另一个组件，当前文件不出现
  expect([...select.options].some((o) => o.value === "D:/ws/METADATA/demo.bmf")).toBe(false);

  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, "D:/old/METADATA/demo.bmf");
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(mocks.invoke).toHaveBeenCalledWith("bmf_doc_detail", { path: "D:/old/METADATA/demo.bmf" });
  expect(host.textContent).toContain("demo v1 → demo v3");
  expect(host.textContent).toContain("billno.长度");
  expect(host.textContent).toContain("20");
  expect(host.textContent).toContain("50");
  expect(host.textContent).toContain("~2");
});
