// @vitest-environment jsdom
/**
 * 远程附加表单：地址没填全时不能提交，提交时把规范化地址交给回调并记住。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteAttachForm } from "./RemoteAttachForm";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function type(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function submitButton(): HTMLButtonElement {
  const btn = container.querySelector(".dbg-remote-row button");
  if (!btn) throw new Error("没有提交按钮");
  return btn as HTMLButtonElement;
}

describe("RemoteAttachForm", () => {
  it("端口没填时按钮禁用并给出提示", () => {
    act(() => root.render(<RemoteAttachForm busy={false} onAttach={vi.fn()} />));
    expect(submitButton().disabled).toBe(true);
    expect(container.textContent).toContain("端口");
  });

  it("端口越界时不提交", () => {
    const onAttach = vi.fn();
    act(() => root.render(<RemoteAttachForm busy={false} onAttach={onAttach} />));
    type(container.querySelectorAll("input")[1] as HTMLInputElement, "70000");
    expect(container.textContent).toContain("1–65535");
    expect(submitButton().disabled).toBe(true);
    act(() => submitButton().click());
    expect(onAttach).not.toHaveBeenCalled();
  });

  it("提交时交给回调，并把地址记到本机", () => {
    const onAttach = vi.fn();
    act(() => root.render(<RemoteAttachForm busy={false} onAttach={onAttach} />));
    type(container.querySelectorAll("input")[0] as HTMLInputElement, " 10.0.0.7 ");
    type(container.querySelectorAll("input")[1] as HTMLInputElement, "5005");
    act(() => submitButton().click());
    expect(onAttach).toHaveBeenCalledWith("10.0.0.7", 5005);
    expect(JSON.parse(localStorage.getItem("ncforge-debug-remote-endpoint") ?? "{}")).toEqual({
      host: "10.0.0.7",
      port: "5005",
    });
  });

  it("附加中时按钮禁用，避免重复发起", () => {
    act(() => root.render(<RemoteAttachForm busy onAttach={vi.fn()} />));
    type(container.querySelectorAll("input")[1] as HTMLInputElement, "5005");
    expect(submitButton().disabled).toBe(true);
    expect(container.textContent).toContain("附加中");
  });
});
