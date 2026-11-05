// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BmfRefScan } from "../../lib/bmf";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));

import { MetaRefs } from "./MetaRefs";

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

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const button = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes(text))!;

it("显式扫描后列出命中，并能打开引用方组件", async () => {
  const scan: BmfRefScan = {
    hits: [
      {
        path: "D:/ws/METADATA/other.bmf",
        component: "other",
        entity: "B",
        attr: "h",
        field: "typeName",
        value: "nc.vo.m.demo.H",
      },
    ],
    scanned: 7,
    skipped: 1,
    truncated: false,
  };
  mocks.invoke.mockResolvedValue(scan);
  const open = vi.fn();

  await act(async () => root.render(<MetaRefs path={"D:\\ws\\METADATA\\demo.bmf"} onOpen={open} />));
  expect(mocks.invoke).not.toHaveBeenCalled();

  await act(async () => button("扫描引用").click());
  await flush();

  expect(mocks.invoke).toHaveBeenCalledWith("bmf_references", { path: "D:\\ws\\METADATA\\demo.bmf" });
  expect(host.textContent).toContain("扫描 7 个组件，命中 1 处");
  expect(host.textContent).toContain("跳过 1 个无法解析的文件");
  expect(host.textContent).toContain("B.h");

  await act(async () => button("打开").click());
  expect(open).toHaveBeenCalledWith("D:/ws/METADATA/other.bmf");
});
