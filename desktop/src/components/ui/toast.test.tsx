// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ToastProvider, toast } from "./toast";
vi.mock("../../hooks/useAutoAnimateRM", () => ({ useAutoAnimateRM: () => ({ current: null }) }));
vi.mock("../../hooks/usePresence", () => ({ usePresence: (open: boolean) => ({ mounted: open, entered: open }) }));
vi.mock("../../lib/appVisibility", () => ({ useAppHidden: () => false }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("超出显示上限的错误仍可查看复制，关闭后移除", async () => {
  const copy = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ToastProvider>内容</ToastProvider>));
    await act(async () => {
      for (let i = 0; i < 6; i++) toast(`错误-${i}`, "error");
      for (let i = 0; i < 5; i++) toast(`完成-${i}`, "success");
    });
    expect(container.querySelectorAll(".toast")).toHaveLength(4);
    const button = (label: string) => [...container.querySelectorAll("button")].find(b => b.textContent?.includes(label))!;
    await act(async () => button("复制全部错误（6）").click());
    expect(copy).toHaveBeenCalledWith(Array.from({length: 6}, (_, i) => `错误-${i}`).join("\n"));
    await act(async () => button("查看错误（6）").click());
    expect(container.querySelectorAll(".toast")).toHaveLength(6);
    expect(container.textContent).toContain("错误-0");
    await act(async () => container.querySelector<HTMLButtonElement>('.toast button[aria-label="关闭"]')!.click());
    expect(container.textContent).toContain("复制全部错误（5）");
  } finally {
    await act(async () => root.unmount()); container.remove();
  }
});
