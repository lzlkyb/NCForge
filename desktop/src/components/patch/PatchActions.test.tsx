// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { PatchActions } from "./PatchActions";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("输出目录常显，失焦保留草稿并阻止误出包，显式保存后恢复", async () => {
  const host = document.createElement("div"), root = createRoot(host), save = vi.fn(async () => {});
  document.body.append(host);
  try {
    await act(async()=>root.render(<PatchActions dir="C:/out" origin={null} onSaveDir={save} sqls={[]} onSqls={vi.fn()} blockedCount={2} deletedCount={1} building={false} progress={null} onCancel={vi.fn()} count={3} zipName="test.zip" canBuild onBuild={vi.fn()}/>));
    expect(host.querySelector('[aria-label="补丁输出目录"]')).not.toBeNull();
    const input = document.querySelector<HTMLInputElement>('[aria-label="补丁输出目录"]')!;
    await act(async()=>{
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"C:/next");
      input.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await act(async()=>document.body.dispatchEvent(new MouseEvent("mousedown",{bubbles:true})));
    expect(host.textContent).toContain("2 个阻断");
    expect(host.textContent).toContain("输出目录未保存");
    expect([...host.querySelectorAll("button")].find(b=>b.textContent?.includes("生成补丁包"))?.disabled).toBe(true);
    expect(save).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLInputElement>('[aria-label="补丁输出目录"]')?.value).toBe("C:/next");
    await act(async()=>[...host.querySelectorAll("button")].find(b=>b.textContent === "保存")!.click());
    expect(save).toHaveBeenCalledWith("C:/next");
    await act(async()=>root.render(<PatchActions dir="C:/next" origin={null} onSaveDir={save} sqls={[]} onSqls={vi.fn()} blockedCount={2} deletedCount={1} building={false} progress={null} onCancel={vi.fn()} count={3} zipName="test.zip" canBuild onBuild={vi.fn()}/>));
    expect([...host.querySelectorAll("button")].find(b=>b.textContent?.includes("生成补丁包"))?.disabled).toBe(false);
  } finally { await act(async()=>root.unmount());host.remove(); }
});
it.each([["", 1, "请选择输出目录"], ["C:/out", 0, "请选择出包文件"], ["C:/out", 2, "请填写改动描述后生成"]])("不能出包时说明原因 %s / %s", async (dir, count, reason) => {
  const host = document.createElement("div"), root = createRoot(host);
  document.body.append(host);
  try {
    await act(async()=>root.render(<PatchActions dir={dir as string} origin={null} onSaveDir={vi.fn()} sqls={[]} onSqls={vi.fn()} blockedCount={0} deletedCount={0} building={false} progress={null} onCancel={vi.fn()} count={count as number} zipName="test.zip" canBuild={false} onBuild={vi.fn()}/>));
    expect(host.textContent).toContain(reason);
    expect([...host.querySelectorAll("button")].find(b=>b.textContent?.includes("生成补丁包"))?.disabled).toBe(true);
  } finally { await act(async()=>root.unmount()); host.remove(); }
});
