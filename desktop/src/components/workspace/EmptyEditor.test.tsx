// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EmptyEditor } from "./EmptyEditor";
import { recordRecent } from "../../lib/recentFiles";

const h = vi.hoisted(() => ({ openPalette: vi.fn() }));
vi.mock("../../lib/paletteStore", () => ({ openPalette: h.openPalette }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const workspace = "C:\\w\\工程";
beforeEach(() => {
  localStorage.clear(); h.openPalette.mockClear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it("最近文件仍按工程隔离并保持最近顺序，点击传递完整路径", () => {
  recordRecent("D:\\其他工程", "D:\\其他工程\\Other.java");
  for (let i = 0; i < 6; i++) recordRecent(workspace, `${workspace}\\src\\目录\\File${i}.java`);
  const onOpen = vi.fn();
  act(() => root.render(<EmptyEditor root={workspace} onOpen={onOpen} />));
  const files = Array.from(host.querySelectorAll<HTMLButtonElement>('.wb-empty-file'));
  expect(files).toHaveLength(5);
  expect(files[0].textContent).toContain("File5.java");
  expect(files[0].textContent).toContain("src\\目录");
  expect(host.textContent).not.toContain("Other.java");
  expect(host.textContent).not.toContain("File0.java");
  expect(files[0].title).toBe(`${workspace}\\src\\目录\\File5.java`);
  act(() => files[0].click());
  expect(onOpen).toHaveBeenCalledExactlyOnceWith(`${workspace}\\src\\目录\\File5.java`);
  expect(host.querySelector('.wb-empty-sub')?.getAttribute("title")).toBe(workspace);
});

it("没有最近文件时保留明确引导、打开入口和完整快捷键", () => {
  act(() => root.render(<EmptyEditor root={workspace} onOpen={vi.fn()} />));
  expect(host.querySelector('[aria-label="最近打开的文件"]')?.textContent).toContain("暂无最近文件");
  expect(host.querySelectorAll('kbd')).toHaveLength(5);
  expect(host.querySelector('[aria-label="编辑器快捷键"]')?.textContent).toContain("全工程搜索");
  act(() => host.querySelector<HTMLButtonElement>('.wb-empty-go')!.click());
  expect(h.openPalette).toHaveBeenCalledExactlyOnceWith("file");
});
