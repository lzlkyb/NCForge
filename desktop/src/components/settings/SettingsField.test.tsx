// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { SettingsField, integerRange } from "./SettingsField";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
// 显式给出签名：`ReturnType<typeof vi.fn>` 在 vitest 4 里是 `Mock<Procedure>`，
// 赋给 `onSave: (value: string) => void` 时类型不兼容（返回 any 也不行）
let save: Mock<(value: string) => void>;
const field = () => container.querySelector("input")!;

const render = async (value: number = 13) => {
  await act(async () => root.render(<SettingsField value={value} type="number"
    ariaLabel="代码字号" validate={integerRange(9, 28, "px")} onSave={save} />));
};
const type = async (text: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field(), text);
    field().dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const enter = async () => {
  await act(async () => field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  save = vi.fn();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("设置输入草稿与提交", () => {
  it("数字保存成功后规范化显示，避免保留前导零草稿", async () => {
    await render(); await type("016"); await enter();
    expect(save).toHaveBeenCalledWith("016");
    await render(16);
    expect(field().value).toBe("16");
    expect([...container.querySelectorAll("button")].some(b => b.textContent === "保存")).toBe(false);
  });
  it("失焦只校验草稿，不自动保存", async () => {
    await render(); await type("16");
    await act(async () => field().dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(save).not.toHaveBeenCalled(); expect(container.textContent).toContain("待保存");
    await enter(); expect(save).toHaveBeenCalledWith("16");
  });
  it("允许中间输入，完成输入且通过范围校验后才保存", async () => {
    await render();
    await type("1");
    expect(save).not.toHaveBeenCalled();
    await enter();
    expect(save).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("9–28");
    expect(field().value).toBe("1");
    await type("16");
    await enter();
    expect(save).toHaveBeenCalledWith("16");
    expect(container.textContent).toContain("已保存");
  });

  it("保存失败不丢输入，并可重新提交同一草稿", async () => {
    save.mockRejectedValueOnce(new Error("无法保存到本机"));
    await render();
    await type("18");
    await enter();
    expect(field().value).toBe("18");
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(container.textContent).toContain("无法保存到本机");
    await render(18);
    await act(async () => field().dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(container.textContent).toContain("无法保存到本机");
    await enter();
    expect(save).toHaveBeenCalledTimes(2);
    expect(field().value).toBe("18");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("外部值变化不覆盖正在输入的草稿，Escape 可恢复最新值", async () => {
    await render();
    await type("16");
    await render(20);
    expect(field().value).toBe("16");
    await act(async () => field().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(field().value).toBe("20");
    expect(save).not.toHaveBeenCalled();
  });

  it("保存尚未返回时重复 Enter 只提交一次", async () => {
    let finish!: () => void;
    save.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    await render();
    await type("18");
    await enter();
    await enter();
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => finish());
  });

  it("改回原值后 dirty 复位，外部更新能重新同步", async () => {
    await render();
    await type("16");
    await type("13");
    await render(20);
    expect(field().value).toBe("20");
    expect(save).not.toHaveBeenCalled();
  });

  it("保存期间输入保持可聚焦，完成后焦点不丢", async () => {
    let finish!: () => void;
    save.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    await render();
    field().focus();
    await type("18");
    await enter();
    expect(document.activeElement).toBe(field());
    expect(field().disabled).toBe(false);
    expect(field().readOnly).toBe(true);
    expect(field().getAttribute("aria-busy")).toBe("true");
    await act(async () => finish());
    expect(document.activeElement).toBe(field());
    expect(field().readOnly).toBe(false);
    expect(field().value).toBe("18");
  });
});


it("输入法确认不触发设置保存", async () => {
  await render(); await type("16");
  await act(async () => field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true })));
  expect(save).not.toHaveBeenCalled();
  await enter(); expect(save).toHaveBeenCalledOnce();
});
