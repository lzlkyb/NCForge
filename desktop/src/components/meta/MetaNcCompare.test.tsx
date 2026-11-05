// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BmfDetail } from "../../lib/bmf";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));

import { MetaNcCompare } from "./MetaNcCompare";

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

const mkDetail = (path: string, version: number, len: number): BmfDetail => ({
  path,
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

const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

const click = async () => {
  const btn = host.querySelector<HTMLButtonElement>(".meta-nc-bar button")!;
  await act(async () => {
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
};

it("按文件名对比安装目录副本并标出字段差异", async () => {
  mocks.invoke.mockImplementation((cmd: string) => {
    if (cmd === "bmf_nchome_compare") {
      return Promise.resolve({
        ncHome: "D:/ncc/1909home",
        component: "demo",
        workspaceModule: "uapbd",
        candidates: [{ path: "D:/ncc/1909home/modules/uapbd/METADATA/demo.bmf", module: "uapbd", size: 1, mtimeMs: 0 }],
        selected: "D:/ncc/1909home/modules/uapbd/METADATA/demo.bmf",
        detail: mkDetail("D:/ncc/1909home/modules/uapbd/METADATA/demo.bmf", 3, 50),
      });
    }
    return Promise.reject(new Error(`unexpected ${cmd}`));
  });

  await act(async () => root.render(<MetaNcCompare current={mkDetail("D:/ws/uapbd/METADATA/demo.bmf", 1, 20)} />));
  expect(host.textContent).toContain("只读");
  await click();

  expect(mocks.invoke).toHaveBeenCalledWith("bmf_nchome_compare", {
    path: "D:/ws/uapbd/METADATA/demo.bmf",
    component: "demo",
    installPath: null,
  });
  expect(host.textContent).toContain("D:/ncc/1909home");
  expect(host.textContent).toContain("工作区 v1 → 安装目录 v3");
  expect(host.textContent).toContain("billno.长度");
  expect(host.textContent).toContain("~2"); // 组件版本 + 字段长度
  expect(host.textContent).toContain("不会改安装目录");
});

it("安装目录里没有同名组件时给出明确说明", async () => {
  mocks.invoke.mockResolvedValue({
    ncHome: "D:/ncc/1909home",
    component: "demo",
    workspaceModule: "uapbd",
    candidates: [],
    selected: null,
    detail: null,
  });
  await act(async () => root.render(<MetaNcCompare current={mkDetail("D:/ws/uapbd/METADATA/demo.bmf", 1, 20)} />));
  await click();
  expect(host.textContent).toContain("安装目录里没有 demo.bmf");
});

it("NC home 不可读时显示后端错误", async () => {
  mocks.invoke.mockRejectedValue(new Error("读不到 D:/ncc/modules"));
  await act(async () => root.render(<MetaNcCompare current={mkDetail("D:/ws/uapbd/METADATA/demo.bmf", 1, 20)} />));
  await click();
  expect(host.textContent).toContain("读不到 D:/ncc/modules");
});
