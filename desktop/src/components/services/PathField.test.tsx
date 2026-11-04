// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../ui/toast", () => ({ toast: vi.fn() }));
import { PathField } from "./PathField";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let host: HTMLDivElement;
const save = vi.fn();
beforeEach(async () => {
  save.mockReset(); save.mockResolvedValue(undefined);
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root.render(<PathField label="工程" value="C:/old" placeholder="路径" onSave={save} />));
  await act(async () => host.querySelector("button")!.click());
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const input = () => host.querySelector("input")!;
const key = (name: string, isComposing = false) => input().dispatchEvent(new KeyboardEvent("keydown", { key: name, isComposing, bubbles: true }));
describe("路径保存交互", () => {
  it("输入法确认不保存；从首帧锁住连按、取消与输入，完成后退出编辑", async () => {
    await act(async () => { key("Enter", true); }); expect(save).not.toHaveBeenCalled();
    let finish!: () => void; save.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    await act(async () => { key("Enter"); key("Enter"); key("Escape"); });
    expect(save).toHaveBeenCalledOnce(); expect(input().disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('button[title="正在保存，请稍候"]')?.disabled).toBe(true);
    expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
    await act(async () => { finish(); }); expect(host.querySelector("input")).toBeNull();
  });
  it("守卫取消或保存失败保持编辑态，并解除锁允许重试", async () => {
    save.mockResolvedValueOnce("cancelled").mockRejectedValueOnce(new Error("目录不存在"));
    await act(async () => { key("Enter"); }); expect(input().disabled).toBe(false);
    await act(async () => { key("Enter"); }); expect(input().disabled).toBe(false);
    await act(async () => { key("Enter"); }); expect(save).toHaveBeenCalledTimes(3); expect(host.querySelector("input")).toBeNull();
  });
});
