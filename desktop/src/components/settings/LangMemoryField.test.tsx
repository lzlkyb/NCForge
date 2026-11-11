// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LangMemoryField } from "./LangMemoryField";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const onSave = vi.fn<(value: number) => Promise<boolean>>();
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  onSave.mockReset();
  onSave.mockResolvedValue(true);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const render = async (value = 1024, disabled = false) => {
  await act(async () => root.render(<LangMemoryField value={value} disabled={disabled} pending={false} onSave={onSave} />));
};
const input = () => container.querySelector("input")!;
const save = async () => { await act(async () => container.querySelector("button")!.click()); };
const change = async (value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("代码智能内存草稿", () => {
  it("清空和输入过程不会保存，非法范围在明确提交后解释", async () => {
    await render();
    await change("");
    expect(onSave).not.toHaveBeenCalled();
    await save();
    expect(container.querySelector('[role="alert"]')!.textContent).toContain("512–4096");
    expect(onSave).not.toHaveBeenCalled();
    await change("4097");
    await save();
    expect(onSave).not.toHaveBeenCalled();
  });
  it("保存失败保留草稿，用户可直接重试", async () => {
    await render();
    onSave.mockResolvedValueOnce(false);
    await change("2048");
    await save();
    expect(input().value).toBe("2048");
    expect(container.querySelector("button")!.disabled).toBe(false);
    await save();
    expect(onSave).toHaveBeenNthCalledWith(2, 2048);
  });
  it("外部成功值同步，关闭代码智能时不能提交", async () => {
    await render();
    await render(2048, true);
    expect(input().value).toBe("2048");
    expect(input().disabled).toBe(true);
    expect(container.querySelector("button")!.disabled).toBe(true);
  });
});

it("语言服务内存失焦只校验，Esc 还原最新值", async () => {
  await render(); await change("2048");
  await act(async () => input().dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  expect(onSave).not.toHaveBeenCalled();
  expect(container.textContent).toContain("待保存");
  await act(async () => input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(input().value).toBe("1024");
});
