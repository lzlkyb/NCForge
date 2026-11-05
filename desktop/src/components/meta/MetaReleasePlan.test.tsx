// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BmfReleasePlan } from "../../lib/bmf";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));

import { MetaReleasePlan } from "./MetaReleasePlan";

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

const plan: BmfReleasePlan = {
  ncHome: "D:/nchome",
  component: "demo",
  module: "uapbd",
  tools: [
    { id: "java", label: "NC 自带 JDK", status: "found", path: "D:/nchome/ufjdk/bin/java.exe", note: "1.8" },
    { id: "studio", label: "官方发布入口（UAP Studio）", status: "unknown", path: null, note: "无法从 NC home 判断" },
  ],
  steps: [
    { id: "preflight", title: "前置检查", mode: "auto", status: "ready", detail: "0 项阻断，1 项需人工确认", hint: "只读检查" },
    { id: "publish", title: "官方工具发布元数据", mode: "manual", status: "pending", detail: "在 UAP Studio 里发布 demo", hint: "本工具不会调用发布接口" },
  ],
  blockers: 0,
  warnings: 1,
  ready: true,
  autoPublish: false,
  installCopy: "D:/nchome/modules/uapbd/METADATA/demo.bmf",
  workspaceSha256: "aaa",
  installSha256: "bbb",
  evidenceTemplate: "# 发布证据",
};

const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

const button = (text: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes(text))!;

async function setValue(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
  const proto =
    el instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

it("列出官方工具与步骤，并声明不会自动发布", async () => {
  mocks.invoke.mockResolvedValue(plan);
  await act(async () =>
    root.render(<MetaReleasePlan path="D:/ws/uapbd/METADATA/demo.bmf" component="demo" module="uapbd" />),
  );
  await flush();

  expect(mocks.invoke).toHaveBeenCalledWith("bmf_release_plan", {
    path: "D:/ws/uapbd/METADATA/demo.bmf",
    component: "demo",
    module: "uapbd",
  });
  expect(host.textContent).toContain("不会自动发布");
  expect(host.textContent).toContain("NC 自带 JDK");
  expect(host.textContent).toContain("官方发布入口（UAP Studio）");
  expect(host.textContent).toContain("待确认");
  expect(host.textContent).toContain("官方工具发布元数据");
  expect(host.textContent).toContain("本工具不会调用发布接口");
  expect(button("记录证据").disabled).toBe(true);
});

it("填好结果与执行人后记录证据，并显示保存路径", async () => {
  mocks.invoke.mockImplementation((cmd: string) => {
    if (cmd === "bmf_release_plan") return Promise.resolve(plan);
    if (cmd === "bmf_release_evidence") {
      return Promise.resolve({ path: "C:/cfg/bmf_release/demo-1.md", content: "# 发布证据" });
    }
    return Promise.reject(new Error(`unexpected ${cmd}`));
  });
  await act(async () =>
    root.render(<MetaReleasePlan path="D:/ws/uapbd/METADATA/demo.bmf" component="demo" module="uapbd" />),
  );
  await flush();

  await setValue(host.querySelector<HTMLSelectElement>('[aria-label="发布结果"]')!, "success");
  await setValue(host.querySelector<HTMLInputElement>('[aria-label="执行人"]')!, "张三");
  await setValue(host.querySelector<HTMLTextAreaElement>('[aria-label="执行记录"]')!, "VOMeta 正常");

  expect(button("记录证据").disabled).toBe(false);
  await act(async () => button("记录证据").click());
  await flush();

  expect(mocks.invoke).toHaveBeenCalledWith("bmf_release_evidence", {
    path: "D:/ws/uapbd/METADATA/demo.bmf",
    component: "demo",
    module: "uapbd",
    result: "success",
    operator: "张三",
    note: "VOMeta 正常",
  });
  expect(host.textContent).toContain("C:/cfg/bmf_release/demo-1.md");
  expect(host.textContent).toContain("不代表发布已由工具执行");
});

it("计划读取失败时清掉内容并显示错误", async () => {
  mocks.invoke.mockRejectedValue(new Error("NC home 未配置"));
  await act(async () =>
    root.render(<MetaReleasePlan path="D:/ws/uapbd/METADATA/demo.bmf" component="demo" module="uapbd" />),
  );
  await flush();
  expect(host.textContent).toContain("编排失败：");
  expect(host.textContent).toContain("NC home 未配置");
  expect(host.textContent).not.toContain("步骤顺序");
});
