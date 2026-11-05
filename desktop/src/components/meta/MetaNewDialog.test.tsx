// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BmfScaffold } from "../../lib/bmf";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));
vi.mock("../../lib/appConfig", () => ({
  getConfig: async () => ({ workspace_root: "D:\\work\\" }),
}));

import { MetaNewDialog } from "./MetaNewDialog";

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

const scaffold: BmfScaffold = {
  text: "<bmf/>",
  pathHint: "demo.bmf",
  component: "demo",
  namespace: "uapbd",
  module: "uapbd",
  skeleton: "headBody",
  entities: [{ name: "H", displayName: "表头", table: "demo_h", fullClass: "nc.vo.uapbd.demo.DemoHVO", primary: true, attrCount: 2 }],
  fields: [],
  tables: ["demo_h"],
  voFiles: ["DemoHVO.java"],
  defs: 20,
};

function setValue(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function field(labelText: string) {
  const label = [...document.querySelectorAll("label")].find((l) => l.querySelector("span")?.textContent?.startsWith(labelText))!;
  return label.querySelector<HTMLInputElement>("input")!;
}

const button = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text)!;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderDialog(onCreated = vi.fn()) {
  await act(async () => root.render(<MetaNewDialog open onClose={() => {}} onCreated={onCreated} />));
  await flush();
  return onCreated;
}

it("编码/路径归一化，自定义项超 50 时挡住预览", async () => {
  mocks.invoke.mockImplementation((cmd: string) => {
    if (cmd === "bmf_scaffold_preview") return Promise.resolve(scaffold);
    return Promise.reject(new Error(`unexpected ${cmd}`));
  });
  await renderDialog();

  // 工作区根去掉反斜杠与尾部分隔符；大写编码按后端同口径转小写。
  await act(async () => setValue(field("组件编码"), "DEMO"));
  await act(async () => setValue(field("中文名"), "演示单据"));
  expect(field("目标路径").placeholder).toBe("D:/work/uapbd/METADATA/demo.bmf");
  expect(button("预览").disabled).toBe(false);

  await act(async () => setValue(field("自定义项数量"), "51"));
  expect(document.body.textContent).toContain("必须是 0–50 的整数");
  expect(button("预览").disabled).toBe(true);

  await act(async () => setValue(field("自定义项数量"), "20"));
  expect(button("预览").disabled).toBe(false);
});

it("手填目标不在 METADATA 或文件名与编码不一致时禁止创建；改目标不作废骨架预览", async () => {
  mocks.invoke.mockImplementation((cmd: string) => {
    if (cmd === "bmf_scaffold_preview") return Promise.resolve(scaffold);
    return Promise.reject(new Error(`unexpected ${cmd}`));
  });
  const onCreated = await renderDialog();

  await act(async () => setValue(field("组件编码"), "demo"));
  await act(async () => setValue(field("中文名"), "演示单据"));
  await act(async () => button("预览").click());
  await flush();
  expect(button("创建文件").disabled).toBe(false);

  await act(async () => setValue(field("目标路径"), "D:/work/uapbd/demo.bmf"));
  expect(document.body.textContent).toContain("目标必须位于 METADATA 目录下");
  expect(button("创建文件").disabled).toBe(true);

  await act(async () => setValue(field("目标路径"), "D:/work/uapbd/METADATA/other.bmf"));
  expect(document.body.textContent).toContain("目标文件名应与组件编码一致");
  expect(button("创建文件").disabled).toBe(true);

  // 路径不属于生成参数：改回合法值后旧预览依然有效，不必重新预览。
  await act(async () => setValue(field("目标路径"), "D:/work/uapbd/METADATA/demo.bmf"));
  expect(button("创建文件").disabled).toBe(false);
  expect(onCreated).not.toHaveBeenCalled();
});

it("改生成参数会让预览失效；创建时发送归一化编码与目标路径", async () => {
  mocks.invoke.mockImplementation((cmd: string) => {
    if (cmd === "bmf_scaffold_preview") return Promise.resolve(scaffold);
    if (cmd === "bmf_scaffold_write") return Promise.resolve("D:/work/uapbd/METADATA/demo.bmf");
    return Promise.reject(new Error(`unexpected ${cmd}`));
  });
  const onCreated = await renderDialog();

  await act(async () => setValue(field("组件编码"), "DEMO"));
  await act(async () => setValue(field("中文名"), "演示单据"));
  await act(async () => button("预览").click());
  await flush();
  expect(button("创建文件").disabled).toBe(false);

  // 预览之后改中文名：骨架已经不对应当前参数，必须重新预览。
  await act(async () => setValue(field("中文名"), "另一个名字"));
  expect(button("创建文件").disabled).toBe(true);

  await act(async () => button("预览").click());
  await flush();
  await act(async () => button("创建文件").click());
  await flush();

  const write = mocks.invoke.mock.calls.find(([cmd]) => cmd === "bmf_scaffold_write")!;
  const spec = write[1] as { spec: { code: string; module: string; name: string }; path: string };
  expect(spec.spec.code).toBe("demo");
  expect(spec.spec.module).toBe("uapbd");
  expect(spec.spec.name).toBe("另一个名字");
  expect(spec.path).toBe("D:/work/uapbd/METADATA/demo.bmf");
  expect(onCreated).toHaveBeenCalledWith("D:/work/uapbd/METADATA/demo.bmf");
});
