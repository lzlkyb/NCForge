// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BmfGenPlan } from "../../lib/bmf";

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

const plan: BmfGenPlan = {
  artifacts: [
    {
      id: "db.ddl.oracle",
      family: "db",
      kind: "ddl",
      name: "demo.oracle.sql",
      pathHint: "db/demo.oracle.sql",
      encoding: "GBK",
      eol: "CRLF",
      text: "create table demo_h (pk_demo char(20));",
      sha256: "0".repeat(64),
      sourceRefs: [],
      dependsOn: [],
    },
  ],
  warnings: ["字段长度缺失"],
  timings: { parseMs: 1, validateMs: 0, graphMs: 0.2, renderMs: 0.5, diffMs: 0, writeMs: 0, totalMs: 1.7 },
  inputSha256: "1".repeat(64),
  profileSha256: "2".repeat(64),
  profile: {
    style: "traditional",
    dialect: "oracle",
    basePackage: "",
    publicSrcRoot: "src/public",
    clientSrcRoot: "src/client",
    testSrcRoot: "src/test",
    options: {
      generateAggVo: true,
      generateEnumVo: true,
      generateInterfaces: false,
      generateSelVo: false,
      generateTest: false,
      generateDdl: true,
      withForeignKeys: false,
      onlyExtensionTables: false,
      ufBooleanToBoolean: false,
      localization: false,
    },
  },
};

const button = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes(text))!;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

it("重新生成失败时清掉旧产物，不能把上一次的 DDL 留在错误旁边", async () => {
  let fail = false;
  mocks.invoke.mockImplementation((cmd: string) => {
    if (cmd === "bmf_generate_plan") {
      return fail ? Promise.reject(new Error("bmf 文件不存在")) : Promise.resolve(plan);
    }
    if (cmd === "bmf_validate") {
      return Promise.resolve([]);
    }
    if (cmd === "bmf_gen_diff") {
      return Promise.resolve({ items: [], manifest: null, timings: plan.timings });
    }
    return Promise.reject(new Error(`unexpected ${cmd}`));
  });

  await act(async () => root.render(<MetaGenerate path="D:/work/uapbd/METADATA/demo.bmf" />));
  await flush();
  expect(host.textContent).toContain("create table demo_h");
  expect(host.textContent).toContain("字段长度缺失");
  expect(host.textContent).toContain("规则校验：0 错误");
  expect(host.textContent).toContain("预算 10s");

  fail = true;
  await act(async () => button("重新生成").click());
  await flush();

  expect(host.textContent).toContain("bmf 文件不存在");
  expect(host.textContent).not.toContain("create table demo_h");
  expect(host.textContent).not.toContain("字段长度缺失");
  expect(host.querySelector(".meta-code")).toBeNull();
});

it("校验存在 error 时禁止落盘", async () => {
  mocks.invoke.mockImplementation((cmd: string) => {
    if (cmd === "bmf_generate_plan") return Promise.resolve(plan);
    if (cmd === "bmf_validate") {
      return Promise.resolve([
        {
          id: "A001#1",
          code: "A001",
          severity: "error",
          title: "属性名称为空",
          detail: "",
          why: "",
          action: "",
          file: "demo.bmf",
          line: 3,
          component: "demo",
          entity: "DemoVO",
          attr: "",
        },
      ]);
    }
    if (cmd === "bmf_gen_diff") {
      return Promise.resolve({ items: [], manifest: null, timings: plan.timings });
    }
    return Promise.reject(new Error(`unexpected ${cmd}`));
  });

  await act(async () => root.render(<MetaGenerate path="D:/work/uapbd/METADATA/demo.bmf" />));
  await flush();

  expect(host.textContent).toContain("规则校验：1 错误");
  expect(button("写入磁盘").disabled).toBe(true);
});
