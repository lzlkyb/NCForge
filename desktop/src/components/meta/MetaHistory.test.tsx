// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BmfDetail } from "../../lib/bmf";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));

import { MetaHistory } from "./MetaHistory";

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
  eol: "LF",
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

const history = (entries: unknown[]) => ({
  repositoryPath: "https://svn.example/repo",
  entries,
});

const rev = (revision: number, message = "改动") => ({
  revision,
  author: "alice",
  date: Date.parse("2026-11-01T10:00:00Z"),
  message,
  paths: [{ path: "m/METADATA/demo.bmf", action: "M", copyFromPath: null, copyFromRevision: 0 }],
});

const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

it("列出修订，选中后读取旧正文并展示历史 → 当前的字段级差异", async () => {
  mocks.invoke.mockImplementation((cmd: string) => {
    if (cmd === "bmf_history") return Promise.resolve(history([rev(12, "加长字段"), rev(9, "初版")]));
    if (cmd === "bmf_revision_text")
      return Promise.resolve({ revision: 12, sourcePath: "D:/ws/METADATA/demo.bmf", text: "<component/>", encoding: "UTF-8", empty: false });
    if (cmd === "bmf_detail_text") return Promise.resolve(mkDetail(1, 20));
    return Promise.reject(new Error(`unexpected ${cmd}`));
  });

  await act(async () => root.render(<MetaHistory current={mkDetail(2, 50)} />));
  await act(flush);

  expect(mocks.invoke).toHaveBeenCalledWith("bmf_history", {
    path: "D:/ws/METADATA/demo.bmf",
    limit: 50,
    from: 0,
  });
  const items = host.querySelectorAll<HTMLButtonElement>(".meta-history-item");
  expect(items).toHaveLength(2);
  expect(items[0].textContent).toContain("r12");
  expect(items[0].textContent).toContain("加长字段");

  await act(async () => {
    items[0].click();
    await flush();
  });

  expect(mocks.invoke).toHaveBeenCalledWith("bmf_revision_text", {
    path: "D:/ws/METADATA/demo.bmf",
    repositoryPath: "https://svn.example/repo",
    revision: 12,
  });
  expect(mocks.invoke).toHaveBeenCalledWith("bmf_detail_text", {
    path: "D:/ws/METADATA/demo.bmf",
    text: "<component/>",
  });
  expect(host.textContent).toContain("billno.长度");
  expect(host.textContent).toContain("20");
  expect(host.textContent).toContain("50");
  expect(host.textContent).toContain("~2");
  expect(host.querySelector(".meta-history-item.is-active")).toBeTruthy();
});

it("修订里没有该文件时给出说明，不调用解析", async () => {
  mocks.invoke.mockImplementation((cmd: string) => {
    if (cmd === "bmf_history") return Promise.resolve(history([rev(12)]));
    if (cmd === "bmf_revision_text")
      return Promise.resolve({ revision: 12, sourcePath: "D:/ws/METADATA/demo.bmf", text: "", encoding: "UTF-8", empty: true });
    return Promise.reject(new Error(`unexpected ${cmd}`));
  });

  await act(async () => root.render(<MetaHistory current={mkDetail(2, 50)} />));
  await act(flush);
  await act(async () => {
    host.querySelector<HTMLButtonElement>(".meta-history-item")!.click();
    await flush();
  });

  expect(mocks.invoke).not.toHaveBeenCalledWith("bmf_detail_text", expect.anything());
  expect(host.textContent).toContain("r12 里没有这个文件");
});

it("历史读取失败时展示原因，并提示组件必须在工作副本内", async () => {
  mocks.invoke.mockImplementation((cmd: string) => {
    if (cmd === "bmf_history") return Promise.reject(new Error("这个组件不在 SVN 工作副本内"));
    return Promise.reject(new Error(`unexpected ${cmd}`));
  });

  await act(async () => root.render(<MetaHistory current={mkDetail(2, 50)} />));
  await act(flush);

  expect(host.textContent).toContain("读不到这个组件的历史");
  expect(host.textContent).toContain("不在 SVN 工作副本内");
  expect(host.querySelector(".meta-history-item")).toBeNull();
});
