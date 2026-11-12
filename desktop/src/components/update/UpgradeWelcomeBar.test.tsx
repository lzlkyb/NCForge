// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_SLUG } from "../../lib/about";
import { UpgradeWelcomeBar } from "./UpgradeWelcomeBar";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const KEY = "shell_last_run_version";
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("升级后首次启动欢迎条", () => {
  it("版本变化时浮出，可跳到更新历史并手动关闭", async () => {
    localStorage.setItem(KEY, "0.0.9");
    const openHistory = vi.fn();
    await act(async () => root.render(<UpgradeWelcomeBar currentVersion="0.1.0" onOpenHistory={openHistory} />));

    expect(container.textContent).toContain("已升级到");
    expect(container.textContent).toContain("v0.0.9");
    expect(localStorage.getItem(KEY)).toBe("0.1.0");
    expect(JSON.parse(localStorage.getItem(`${APP_SLUG}.last_update_result`)!)).toMatchObject({
      from: "0.0.9", to: "0.1.0", status: "confirmed",
    });

    const link = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("查看更新内容"))!;
    await act(async () => link.click());
    expect(openHistory).toHaveBeenCalledOnce();

    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="关闭升级提示"]')!.click(),
    );
    expect(container.textContent).toBe("");
  });

  it("首次安装（没有上次版本）不显示", async () => {
    await act(async () => root.render(<UpgradeWelcomeBar currentVersion="0.1.0" />));
    expect(container.textContent).toBe("");
    expect(localStorage.getItem(KEY)).toBe("0.1.0");
  });
});
