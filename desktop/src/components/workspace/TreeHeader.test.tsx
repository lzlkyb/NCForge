// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TreeHeader } from "./TreeHeader";
import { treeFilterFor } from "../../lib/treeFilter";
import { setPackageView, setRevealOnOpen } from "../../lib/treeViewPrefs";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const createFile = vi.fn(), createDir = vi.fn();
beforeEach(() => {
  localStorage.clear(); createFile.mockClear(); createDir.mockClear();
  treeFilterFor("C:/w").set({ text: "", open: false }); setPackageView(false); setRevealOnOpen(false);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root.render(<TreeHeader root="C:/w" projectCount={2} onCreateFile={createFile} onCreateDir={createDir} />));
});
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ""; });
it("名称过滤和文件/包视图可用，全文搜索与切换工程归顶栏", async () => {
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="过滤资源树入口"]')!.click());
  expect(treeFilterFor("C:/w").get().open).toBe(true);
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="包视图"]')!.click());
  expect(host.querySelector('[aria-label="包视图"]')?.getAttribute("aria-pressed")).toBe("true");
  expect(host.querySelector('[aria-label="全工程搜索"]')).toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="更多资源操作"]')!.click());
  expect(document.body.textContent).not.toContain("更换工作区目录");
  expect(document.body.textContent).not.toContain("最近工作区");
  expect(host.textContent).toContain("编译 / SVN 只作用于它");
});
it("新建文件与文件夹保持独立动作", async () => {
  for (const label of ["新建文件", "新建文件夹"]) {
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="更多资源操作"]')!.click());
    const item = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(button => button.textContent === label)!;
    await act(async () => item.click());
  }
  expect(createFile).toHaveBeenCalledTimes(1); expect(createDir).toHaveBeenCalledTimes(1);
});
