// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Button } from "./button";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("公共操作按钮", () => {
  it("刷新和忙碌切换不触发布局测量，调用方清空内容时仍保留原标签", () => {
    const measure = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    const render = (label: string, busy = false) => act(() => root.render(
      <Button isLoading={busy} loadingText="写入中…" style={{ minWidth: 96 }}>
        {busy ? null : <><svg aria-hidden="true" />{label}</>}
      </Button>,
    ));
    render("检查目录");
    render("确认写入全部产物");
    render("", true);
    act(() => vi.advanceTimersByTime(180));
    expect(host.querySelector("button > span")?.textContent).toBe("确认写入全部产物");
    expect(host.querySelector("button")?.style.minWidth).toBe("96px");
    expect(host.querySelector('[role="status"]')?.textContent).toBe("写入中…");
    render("重新生成");
    expect(host.querySelector("button > span")?.textContent).toBe("重新生成");
    expect(measure).not.toHaveBeenCalled();
  });

  it("图标与文字混排时使用可读的默认加载文案", () => {
    act(() => root.render(<Button isLoading><svg aria-hidden="true" />写入文件</Button>));
    expect(host.querySelector("button")?.disabled).toBe(true);
    act(() => vi.advanceTimersByTime(179));
    expect(host.querySelector('[role="status"]')).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(host.querySelector('[role="status"]')?.textContent).toBe("处理中…");
    expect(host.textContent).not.toContain("[object Object]");
  });

  it("长标签在忙碌切换时保留，忙碌期间阻止重复操作，结束后恢复", () => {
    const click = vi.fn();
    const render = (busy: boolean) => act(() => root.render(
      <Button isLoading={busy} loadingText="正在保存…" onClick={click}>保存全部并关闭</Button>,
    ));
    render(false);
    let button = host.querySelector("button")!;
    act(() => button.click());
    expect(click).toHaveBeenCalledTimes(1);
    render(true);
    button = host.querySelector("button")!;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain("保存全部并关闭");
    expect(host.querySelector('[role="status"]')).toBeNull();
    act(() => vi.advanceTimersByTime(180));
    expect(host.querySelector('[role="status"]')?.textContent).toBe("正在保存…");
    act(() => button.click());
    expect(click).toHaveBeenCalledTimes(1);
    render(false);
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(host.querySelector("button")?.disabled).toBe(false);
  });
});
