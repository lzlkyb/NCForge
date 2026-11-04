// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ settle: vi.fn() }));
vi.mock("../../lib/dbConfirm", () => ({ settle: h.settle }));
import { FilesBody } from "./QuitFilesBody";
import type { Pending } from "../../lib/dbConfirm";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined, host: HTMLDivElement | undefined;
afterEach(() => { act(() => root?.unmount()); host?.remove(); h.settle.mockReset(); });
async function render(patch: Partial<Extract<Pending, { kind: "unsavedFiles" }>> = {}) {
  const p: Extract<Pending, { kind: "unsavedFiles" }> = { kind: "unsavedFiles", action: "提交选中文件", purpose: "svn", files: [{ path: "C:/a.java", name: "a.java", preview: false }], onSave: vi.fn(async () => []), resolve: vi.fn(), ...patch };
  h.settle.mockImplementation(run => run(p));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<FilesBody p={p} />));
  return p;
}
const button = (label: string) => [...host!.querySelectorAll("button")].find(b => b.textContent === label)!;
describe("SVN 保存预检确认", () => {
  it("说明磁盘提交保留编辑器草稿，动作标签明确", async () => {
    const p = await render();
    expect(host!.textContent).toContain("编辑器中的修改会保留");
    expect(host!.textContent).not.toContain("改动会丢失");
    expect(button("保存后继续")).toBeTruthy();
    await act(async () => button("提交磁盘版本").click());
    expect(p.resolve).toHaveBeenCalledWith("discard");
  });
  it("同步保存锁阻止同帧重复写盘，保存成功才继续", async () => {
    let release!: (bad: []) => void;
    const onSave = vi.fn(() => new Promise<[]>(resolve => { release = resolve; }));
    const p = await render({ onSave });
    await act(async () => { button("保存后继续").click(); button("保存后继续").click(); });
    expect(onSave).toHaveBeenCalledOnce(); expect(p.resolve).not.toHaveBeenCalled();
    await act(async () => release([]));
    expect(p.resolve).toHaveBeenCalledWith("save");
  });
  it("保存异常退出等待态并保留失败说明，不误报草稿丢失", async () => {
    const p = await render({ onSave: vi.fn(async () => { throw new Error("工作副本已切换"); }) });
    await act(async () => button("保存后继续").click());
    expect(host!.textContent).toContain("工作副本已切换");
    expect(host!.textContent).toContain("未保存修改仍保留"); expect(p.resolve).not.toHaveBeenCalled();
    expect(button("提交磁盘版本")).toBeTruthy();
  });
  it("原退出流程继续明确丢弃风险，不改变原标签", async () => {
    await render({ purpose: undefined, action: "退出" });
    expect(host!.textContent).toContain("改动会丢失");
    expect(button("保存全部并退出")).toBeTruthy(); expect(button("不保存并退出")).toBeTruthy();
  });
});
