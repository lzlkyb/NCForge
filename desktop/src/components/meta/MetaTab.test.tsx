// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BmfDetail, BmfEntry, BmfIndex } from "../../lib/bmf";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));

import { MetaTab } from "./MetaTab";
import { WorkbenchFrame } from "../workspace/WorkbenchFrame";

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

const entry = (path: string, name: string, error: string | null = null): BmfEntry => ({
  path,
  module: "uapbd",
  origin: "工作区",
  name,
  displayName: `${name}组件`,
  namespace: "uapbd",
  version: 1,
  entityCount: 1,
  attrCount: 2,
  enumCount: 0,
  size: 10,
  mtimeMs: 0,
  error,
});

const detail = (path: string, name: string): BmfDetail => ({
  path,
  encoding: "UTF-8",
  eol: "CRLF",
  bom: false,
  size: 10,
  sha256: "sha",
  mtimeMs: 0,
  component: {
    id: `c-${name}`,
    name,
    displayName: `${name}组件`,
    namespace: "uapbd",
    ownModule: "uapbd",
    genCodeStyle: "NC传统样式",
    version: 1,
    mainEntity: "",
    industry: "",
    metaType: "",
  },
  entities: [],
  enums: [],
  relations: [],
  unknownTags: [],
});

const index = (...entries: BmfEntry[]): BmfIndex => ({
  entries,
  roots: ["D:/work"],
  warnings: ["一条索引提示"],
  elapsedMs: 12,
  cached: 0,
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const entryButton = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>(".meta-entry")].find((b) => b.textContent?.includes(name))!;

describe("元数据页", () => {
  it("停靠进文档区，而不是成为内容框的兄弟节点", async () => {
    mocks.invoke.mockImplementation((cmd: string) => {
      if (cmd === "bmf_index_scan") return Promise.resolve(index(entry("D:/work/uapbd/METADATA/demo.bmf", "demo")));
      if (cmd === "bmf_doc_detail") return Promise.resolve(detail("D:/work/uapbd/METADATA/demo.bmf", "demo"));
      if (cmd === "bmf_validate") return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });
    await act(async () =>
      root.render(
        <WorkbenchFrame
          activeTool="meta"
          tree={<div>File tree</div>}
          tabs={null}
          editor={<div>code</div>}
          output={null}
          status={null}
          tool={<MetaTab />}
        />,
      ),
    );
    await flush();
    expect(host.querySelector(".wb-document-surface .meta-page")).not.toBeNull();
    expect(host.querySelector(".wb-tool-runtime .meta-page")).toBeNull();
    // 元数据页自带清单，外层文件树不再同时展开
    expect(host.querySelector(".wb-layout")?.getAttribute("data-side-open")).toBe("false");
    expect(host.querySelector<HTMLElement>(".wb-document-surface")?.hidden).toBe(false);
  });

  it("坏文件被选中后，晚到的正常详情不能覆盖解析失败页", async () => {
    const good = entry("D:/work/uapbd/METADATA/good.bmf", "good");
    const broken = entry("D:/work/uapbd/METADATA/broken.bmf", "broken", "第 3 行：标签未闭合");
    const pending = deferred<BmfDetail>();
    mocks.invoke.mockImplementation((cmd: string, args: { path?: string }) => {
      if (cmd === "bmf_index_scan") return Promise.resolve(index(good, broken));
      if (cmd === "bmf_doc_detail") {
        return args.path === good.path ? pending.promise : Promise.reject(new Error("broken"));
      }
      if (cmd === "bmf_validate") return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });
    await act(async () => root.render(<MetaTab />));
    await flush();
    await act(async () => entryButton("good").click());
    await act(async () => entryButton("broken").click());
    await act(async () => pending.resolve(detail(good.path, "good")));
    await flush();
    expect(host.textContent).toContain("无法解析这个组件");
    expect(host.textContent).toContain("第 3 行：标签未闭合");
    expect(host.querySelector(".meta-main-head h2")?.textContent).toContain("broken组件");
  });

  it("快速切换两个正常组件时只采用最后一次选中", async () => {
    const a = entry("D:/work/uapbd/METADATA/a.bmf", "a");
    const b = entry("D:/work/uapbd/METADATA/b.bmf", "b");
    const da = deferred<BmfDetail>();
    const db = deferred<BmfDetail>();
    mocks.invoke.mockImplementation((cmd: string, args: { path?: string }) => {
      if (cmd === "bmf_index_scan") return Promise.resolve(index(a, b));
      if (cmd === "bmf_doc_detail") return args.path === a.path ? da.promise : db.promise;
      if (cmd === "bmf_validate") return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });
    await act(async () => root.render(<MetaTab />));
    await flush();
    await act(async () => entryButton("a组件").click());
    await act(async () => entryButton("b组件").click());
    await act(async () => db.resolve(detail(b.path, "b")));
    await flush();
    await act(async () => da.resolve(detail(a.path, "a")));
    await flush();
    expect(host.querySelector(".meta-main-head h2")?.textContent).toContain("b组件");
  });

  it("「校验」会重新读盘，能从解析失败恢复", async () => {
    const broken = entry("D:/work/uapbd/METADATA/demo.bmf", "demo", "第 2 行：根节点缺失");
    let fixed = false;
    mocks.invoke.mockImplementation((cmd: string) => {
      if (cmd === "bmf_index_scan") return Promise.resolve(index(broken));
      if (cmd === "bmf_doc_detail") {
        return fixed ? Promise.resolve(detail(broken.path, "demo")) : Promise.reject(new Error("第 2 行：根节点缺失"));
      }
      if (cmd === "bmf_validate") return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });
    await act(async () => root.render(<MetaTab />));
    await flush();
    await act(async () => entryButton("demo").click());
    expect(host.textContent).toContain("无法解析这个组件");
    fixed = true;
    const validate = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "校验")!;
    await act(async () => validate.click());
    await flush();
    expect(host.textContent).not.toContain("无法解析这个组件");
    expect(host.textContent).toContain("结构");
  });
});
