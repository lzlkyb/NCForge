// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BmfExportResult } from "../../lib/bmf";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), pick: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));
vi.mock("../../lib/folderPicker", () => ({
  pickFolder: mocks.pick,
  pickFolderError: (e: unknown) => `无法打开文件夹选择框：${String(e)}`,
}));

import { MetaExportBar } from "./MetaExportBar";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.pick.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

const result: BmfExportResult = {
  items: [
    { relPath: "sql/demo_ddl.sql", kind: "ddl", status: "written", detail: "sql/demo_ddl.sql" },
    { relPath: "registry.md", kind: "registry", status: "skipped", detail: "目标已存在，未覆盖" },
  ],
  written: 1,
  skipped: 1,
  targetDir: "D:\\proj\\gen",
};

const button = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes(text))!;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

it("默认落在 BMF 同级的 gen 目录，写入结果按状态列出", async () => {
  mocks.invoke.mockResolvedValue(result);
  await act(async () => root.render(<MetaExportBar path={"D:\\proj\\METADATA\\demo.bmf"} />));

  const input = host.querySelector<HTMLInputElement>(".meta-export-input")!;
  expect(input.value).toBe("D:\\proj\\METADATA\\gen");

  await act(async () => button("写入磁盘").click());
  await flush();

  expect(mocks.invoke).toHaveBeenCalledWith("bmf_gen_export", {
    path: "D:\\proj\\METADATA\\demo.bmf",
    targetDir: "D:\\proj\\METADATA\\gen",
    entities: null,
    overwrite: false,
  });
  expect(host.textContent).toContain("已写入 1 个，跳过 1 个");
  expect(host.textContent).toContain("已写入");
  expect(host.textContent).toContain("已跳过");
  expect(host.textContent).toContain("目标已存在，未覆盖");
});

it("勾选覆盖后按 overwrite=true 调用；失败清掉上一次结果", async () => {
  mocks.invoke.mockResolvedValueOnce(result);
  await act(async () => root.render(<MetaExportBar path={"D:\\proj\\METADATA\\demo.bmf"} />));

  const box = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  await act(async () => {
    box.click();
  });
  await act(async () => button("写入磁盘").click());
  await flush();
  expect(mocks.invoke).toHaveBeenLastCalledWith(
    "bmf_gen_export",
    expect.objectContaining({ overwrite: true }),
  );

  mocks.invoke.mockRejectedValueOnce(new Error("目标目录不在工作区内"));
  await act(async () => button("写入磁盘").click());
  await flush();
  expect(host.textContent).toContain("目标目录不在工作区内");
  expect(host.textContent).not.toContain("已写入 1 个");
});
