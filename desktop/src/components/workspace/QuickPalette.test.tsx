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
  it("跨工具定位预填类名，正常重开清空旧查询", async () => {
    deps.buildItems.mockResolvedValue({ items: [], note: "" });
    openPalette("type", "nc.impl.ic.StockService");
    act(() => root.render(<QuickPalette activeTab="logs" onNavigate={vi.fn()} />));
    await flush();
    expect(container.querySelector<HTMLInputElement>('[aria-label="快速导航输入"]')?.value).toBe("nc.impl.ic.StockService");
    act(() => { closePalette(); openPalette("file"); }); await flush();
    expect(container.querySelector<HTMLInputElement>('[aria-label="快速导航输入"]')?.value).toBe("");
  });
  it("五种模式的标签与快捷键分开显示，切换后只标记当前模式", async () => {
    deps.buildItems.mockResolvedValue({ items: [], note: "" });
    openPalette("file");
    act(() => root.render(<QuickPalette activeTab="files" onNavigate={vi.fn()} />));
    await flush();

    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>(".qp-mode"));
    expect(buttons.map((b) => b.querySelector(".qp-mode-label")?.textContent)).toEqual(["文件", "类型", "符号", "工作区符号", "命令"]);
    expect(buttons.every((b) => b.querySelector("kbd")?.textContent)).toBe(true);

    for (const label of ["工作区符号", "命令", "类型", "符号", "文件"]) {
      const target = Array.from(container.querySelectorAll<HTMLButtonElement>(".qp-mode"))
        .find((b) => b.querySelector(".qp-mode-label")?.textContent === label)!;
      act(() => target.click());
      await flush();
      const selected = container.querySelectorAll('.qp-mode[aria-pressed="true"]');
      expect(selected).toHaveLength(1);
      expect(selected[0].querySelector(".qp-mode-label")?.textContent).toBe(label);
      expect(document.activeElement).toBe(container.querySelector(".qp-in input"));
    }
  });

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

  it("换查询保留旧结果，加载中回车不误开上一轮的条目", async () => {
    const oldRun = vi.fn();
    deps.buildItems.mockResolvedValueOnce({ items: [{ key: "a", title: "旧结果", run: oldRun }], note: "命令" });
    openPalette("cmd");
    act(() => root.render(<QuickPalette activeTab="files" onNavigate={vi.fn()} />));
    await flush();
    expect(container.textContent).toContain("旧结果");

    let resolveNext: (value: unknown) => void = () => {};
    deps.buildItems.mockReturnValueOnce(new Promise((r) => { resolveNext = r; }));
    type("新查询");
    await flush();
    // 不清空列表：慢查询时才不会「闪成空白 + 一直查询中」的假死观感
    expect(container.textContent).toContain("旧结果");
    expect(container.textContent).toContain("更新中");
    expect(listbox()?.getAttribute("aria-busy")).toBe("true");

    // 但列表里是上一轮的条目：加载期间按回车不能把它打开
    act(() => {
      document.querySelector<HTMLInputElement>('input[aria-label="快速导航输入"]')!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(oldRun).not.toHaveBeenCalled();

    await act(async () => {
      resolveNext({ items: [{ key: "b", title: "新结果", run: vi.fn() }], note: "命令" });
      await tick();
    });
    expect(container.textContent).toContain("新结果");
    expect(listbox()?.getAttribute("aria-busy")).toBe("false");
  });

  it("#内容 分批到达就先显示命中，不必等全量扫完", async () => {
    let resolveFinal: (value: unknown) => void = () => {};
    deps.buildItems.mockImplementationOnce(
      (_mode: string, _q: string, _ctx: unknown, onPartial?: (r: unknown) => void) => {
        onPartial?.({ items: [{ key: "a", title: "先到的命中", run: vi.fn() }], note: "内容 · 已找到 1 条，还在扫…" });
        return new Promise((r) => {
          resolveFinal = r;
        });
      },
    );
    openPalette("file");
    act(() => root.render(<QuickPalette activeTab="files" onNavigate={vi.fn()} />));
    await flush();

    // 扫描还没结束，但列表里已经有东西了，且可以回车打开（都是本次查询的真实命中）
    expect(container.textContent).toContain("先到的命中");
    expect(container.textContent).toContain("还在扫");
    expect(listbox()?.getAttribute("aria-busy")).toBe("false");
    expect(container.textContent).not.toContain("查询中");

    await act(async () => {
      resolveFinal({ items: [{ key: "a", title: "先到的命中", run: vi.fn() }], note: "内容 · 1 项" });
      await tick();
    });
    expect(container.textContent).toContain("内容 · 1 项");
  });
});
