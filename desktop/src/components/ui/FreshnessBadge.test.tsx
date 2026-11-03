// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FreshnessBadge } from "./FreshnessBadge";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const render = (el: ReactElement) => act(() => root.render(el));

describe("FreshnessBadge", () => {
  it("实时数据不带时间", () => {
    render(<FreshnessBadge state="live" at={null} />);
    expect(container.textContent).toContain("实时");
    expect(container.querySelector("[data-freshness=live]")).not.toBeNull();
  });

  it("更新时间可见，超过阈值自动转 stale 并给出重试", () => {
    vi.useFakeTimers();
    const at = Date.now();
    render(<FreshnessBadge state="live" at={at} staleAfterMs={60_000} onRefresh={() => {}} />);
    expect(container.textContent).toContain("已更新");
    expect(container.querySelector("[data-freshness=live]")).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(60_100);
    });
    expect(container.textContent).toContain("停在");
    expect(container.querySelector("[data-freshness=stale]")).not.toBeNull();
    expect(container.textContent).toContain("重试");
  });

  it("失败状态可重试", () => {
    const retry = vi.fn();
    render(<FreshnessBadge state="error" at={null} label="日志" onRefresh={retry} />);
    expect(container.textContent).toContain("日志更新失败");
    act(() => {
      container.querySelector("button")?.click();
    });
    expect(retry).toHaveBeenCalledOnce();
  });

  it("加载中只说在更新，不展示旧时间", () => {
    render(<FreshnessBadge state="loading" at={Date.now()} label="扫描" />);
    expect(container.textContent).toContain("扫描更新中");
    expect(container.textContent).not.toContain("已更新");
  });
});
