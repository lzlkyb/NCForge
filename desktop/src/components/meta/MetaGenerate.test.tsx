// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BmfGeneration } from "../../lib/bmf";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));

import { MetaGenerate } from "./MetaGenerate";

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

const generation: BmfGeneration = {
  ddl: "CREATE TABLE demo_h (pk_demo varchar2(20));",
  files: [
    { kind: "head", name: "DemoHVO.java", pathHint: "src/nc/vo/uapbd/demo/DemoHVO.java", encoding: "UTF-8", eol: "CRLF", text: "class DemoHVO {}" },
  ],
  registry: [{ area: "上游注册", hint: "reg", existing: "", suggested: "demo", note: "示例说明" }],
  upm: "",
  warnings: ["字段长度缺失"],
};

const button = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes(text))!;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

it("重新生成失败时清掉旧内容，不能把上一次的 DDL 留在错误旁边", async () => {
  let fail = false;
  mocks.invoke.mockImplementation((cmd: string) => {
    if (cmd !== "bmf_generate") return Promise.reject(new Error(`unexpected ${cmd}`));
    return fail ? Promise.reject(new Error("bmf 文件不存在")) : Promise.resolve(generation);
  });

  await act(async () => root.render(<MetaGenerate path="D:/work/uapbd/METADATA/demo.bmf" />));
  await flush();
  expect(host.textContent).toContain("CREATE TABLE demo_h");
  expect(host.textContent).toContain("字段长度缺失");

  fail = true;
  await act(async () => button("重新生成").click());
  await flush();

  expect(host.textContent).toContain("bmf 文件不存在");
  expect(host.textContent).not.toContain("CREATE TABLE demo_h");
  expect(host.textContent).not.toContain("字段长度缺失");
  expect(host.querySelector(".meta-code")).toBeNull();
});
