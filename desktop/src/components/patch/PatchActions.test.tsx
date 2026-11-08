// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { PatchActions } from "./PatchActions";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("收起打包设置不丢失目录草稿，阻断信息与未保存限制始终可见", async () => {
  const host = document.createElement("div"), root = createRoot(host), save = vi.fn();
  document.body.append(host);
  try {
    await act(async()=>root.render(<PatchActions dir="C:/out" origin={null} onSaveDir={save} sqls={[]} onSqls={vi.fn()} blockedCount={2} deletedCount={1} building={false} progress={null} onCancel={vi.fn()} count={3} zipName="test.zip" canBuild onBuild={vi.fn()}/>));
    expect(document.querySelector('[aria-label="补丁输出目录"]')).toBeNull();
    const trigger = [...host.querySelectorAll("button")].find(b=>b.textContent?.includes("打包设置"))!;
    await act(async()=>trigger.click());
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
    await act(async()=>trigger.click());
    expect(document.querySelector<HTMLInputElement>('[aria-label="补丁输出目录"]')?.value).toBe("C:/next");
  } finally { await act(async()=>root.unmount());host.remove(); }
});
