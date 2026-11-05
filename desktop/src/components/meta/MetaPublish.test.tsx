// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BmfPublishProbe } from "../../lib/bmf";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));

import { MetaPublish } from "./MetaPublish";

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

const probe: BmfPublishProbe = {
  ncHome: "D:/nchome",
  component: "demo",
  module: "uapbd",
  checks: [{ id: "nc_home", label: "NC Home", status: "ok", detail: "D:/nchome", hint: "已识别" }],
  blockers: 0,
  warnings: 0,
  ready: true,
  manual: "# 发布手册",
};

const button = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes(text))!;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

it("探测失败时清掉旧的通过结果，并给出内联错误", async () => {
  let fail = false;
  mocks.invoke.mockImplementation((cmd: string) => {
    if (cmd === "bmf_release_plan") {
      return Promise.resolve({
        ncHome: null,
        component: "demo",
        module: "uapbd",
        tools: [],
        steps: [],
        blockers: 1,
        warnings: 0,
        ready: false,
        autoPublish: false,
        installCopy: null,
        workspaceSha256: null,
        installSha256: null,
        evidenceTemplate: "",
      });
    }
    if (cmd !== "bmf_publish_probe") return Promise.reject(new Error(`unexpected ${cmd}`));
    return fail ? Promise.reject(new Error("nc_home 未配置")) : Promise.resolve(probe);
  });

  await act(async () => root.render(<MetaPublish component="demo" module="uapbd" path="D:/work/uapbd/METADATA/demo.bmf" />));
  await flush();
  expect(host.textContent).toContain("前置条件通过，可以按手册开始");
  expect(host.querySelector(".meta-manual")).not.toBeNull();

  fail = true;
  await act(async () => button("重新探测").click());
  await flush();

  expect(host.textContent).toContain("探针失败：");
  expect(host.textContent).toContain("nc_home 未配置");
  // 上一次的「通过」与手册不能再留在错误旁边，否则会被当成当前环境的结论。
  expect(host.textContent).not.toContain("前置条件通过");
  expect(host.querySelector(".meta-manual")).toBeNull();
  expect(button("复制手册").disabled).toBe(true);
});
