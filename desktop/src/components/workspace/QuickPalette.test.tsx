// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({ buildItems: vi.fn() }));

vi.mock("../../lib/paletteSources", () => ({ buildItems: deps.buildItems }));
vi.mock("../../lib/lang", () => ({ navigate: vi.fn() }));
vi.mock("../../lib/openFileRequest", () => ({ requestOpenFile: vi.fn() }));
vi.mock("../../lib/workspaceSession", () => ({
  useWorkspaceSelector: (sel: (s: { root: string; activePath: null; tabs: [] }) => unknown) =>
    sel({ root: "C:\\w", activePath: null, tabs: [] }),
}));

import { QuickPalette } from "./QuickPalette";
import { closePalette, openPalette } from "../../lib/paletteStore";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  // jsdom 没有布局，scrollIntoView 需要补一个空实现
  Element.prototype.scrollIntoView = vi.fn();
  deps.buildItems.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    closePalette();
    root.unmount();
  });
  container.remove();
});

const tick = () => new Promise((r) => setTimeout(r, 0));
const listbox = () => document.querySelector<HTMLElement>("#qp-listbox");

async function flush() {
  await act(async () => {
    await tick();
  });
}

function type(value: string) {
  const input = document.querySelector<HTMLInputElement>('input[aria-label="快速导航输入"]')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("快速导航浮层的查询状态", () => {
  it("查询失败给出原因和重试按钮，重试成功后列表恢复", async () => {
    deps.buildItems.mockRejectedValueOnce(new Error("语言服务挂了"));
    openPalette("cmd");
    act(() => root.render(<QuickPalette activeTab="files" onNavigate={vi.fn()} />));
    await flush();

    expect(container.textContent).toContain("查询失败：语言服务挂了");
    const retry = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "重试")!;
    deps.buildItems.mockResolvedValueOnce({ items: [{ key: "a", title: "编译当前模块", run: vi.fn() }], note: "命令" });
    act(() => retry.click());
    await flush();

    expect(container.textContent).toContain("编译当前模块");
    expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent === "重试")).toBe(false);
  });

  it("换查询先清空旧结果：加载期间不留下会回车误开的条目", async () => {
    deps.buildItems.mockResolvedValueOnce({ items: [{ key: "a", title: "旧结果", run: vi.fn() }], note: "命令" });
    openPalette("cmd");
    act(() => root.render(<QuickPalette activeTab="files" onNavigate={vi.fn()} />));
    await flush();
    expect(container.textContent).toContain("旧结果");

    let resolveNext: (value: unknown) => void = () => {};
    deps.buildItems.mockReturnValueOnce(new Promise((r) => { resolveNext = r; }));
    type("新查询");
    await flush();
    expect(container.textContent).not.toContain("旧结果");
    expect(container.textContent).toContain("查询中");
    expect(listbox()?.getAttribute("aria-busy")).toBe("true");

    await act(async () => {
      resolveNext({ items: [{ key: "b", title: "新结果", run: vi.fn() }], note: "命令" });
      await tick();
    });
    expect(container.textContent).toContain("新结果");
    expect(listbox()?.getAttribute("aria-busy")).toBe("false");
  });
});
