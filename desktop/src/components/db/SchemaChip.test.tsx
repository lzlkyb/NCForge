// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ change: vi.fn(), schemas: vi.fn() }));
vi.mock("../../lib/dbStore", () => ({
  useConnOf: () => ({ id: "c1", name: "测试库", env: "test", user: "AIER633", url: "jdbc:oracle:thin:@h:1521/x", autoCommit: false, defaultSchema: "" }),
  useConnRt: () => ({
    status: "connected",
    currentSchema: "AIER633",
    schemas: ["AIER633", "OTHER"],
    info: { user: "AIER633" },
  }),
  changeSchema: mocks.change,
}));
vi.mock("../../lib/dbApi", () => ({ dbApi: { schemas: mocks.schemas } }));
vi.mock("../ui/toast", () => ({ toast: vi.fn() }));
import { SchemaChip } from "./SchemaChip";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  mocks.change.mockReset();
  mocks.change.mockResolvedValue("OTHER");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("默认 schema 胶囊", () => {
  it("组合搜索只设置一个焦点容器，方向键与 Enter 选择后回到触发器", async () => {
    act(() => root.render(<SchemaChip connId="c1" />));
    const trigger = host.querySelector<HTMLButtonElement>(".dbx-schema-chip")!;
    act(() => trigger.click());
    const filter = host.querySelector<HTMLInputElement>('[role="combobox"]')!;
    expect(filter.parentElement?.hasAttribute("data-focus-container")).toBe(true);
    expect(filter.getAttribute("aria-controls")).toBe(host.querySelector('[role="listbox"]')?.id);
    act(() => filter.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true})));
    expect(host.querySelector('[data-highlighted]')?.textContent).toBe("OTHER");
    expect(document.getElementById(filter.getAttribute("aria-activedescendant")!)?.textContent).toBe("OTHER");
    await act(async () => filter.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true})));
    expect(mocks.change).toHaveBeenCalledWith("c1","OTHER");
    expect(document.activeElement).toBe(trigger);
  });
  it("Esc 关闭并恢复焦点，输入法确认键不切换 Schema", () => {
    act(() => root.render(<SchemaChip connId="c1" />));
    const trigger = host.querySelector<HTMLButtonElement>(".dbx-schema-chip")!;
    act(() => trigger.click());
    const filter = host.querySelector<HTMLInputElement>('[role="combobox"]')!;
    act(() => filter.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,isComposing:true})));
    expect(mocks.change).not.toHaveBeenCalled();
    act(() => filter.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})));
    expect(host.querySelector(".dbx-schema-pop")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
  it("显示当前生效的 schema，点开可筛选并切换", async () => {
    act(() => root.render(<SchemaChip connId="c1" />));
    expect(host.querySelector(".dbx-schema-name")?.textContent).toBe("AIER633");
    act(() => host.querySelector<HTMLButtonElement>(".dbx-schema-chip")!.click());
    const items = () => [...host.querySelectorAll<HTMLButtonElement>(".dbx-schema-item")];
    expect(items().map((b) => b.textContent)).toEqual(["AIER633", "OTHER"]);
    // 当前项要有可读标记（不能只靠颜色）
    expect(items()[0].getAttribute("aria-selected")).toBe("true");
    const filter = host.querySelector<HTMLInputElement>(".dbx-schema-filter input")!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(filter, "oth");
      filter.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(items().map((b) => b.textContent)).toEqual(["OTHER"]);
    await act(async () => items()[0].click());
    expect(mocks.change).toHaveBeenCalledWith("c1", "OTHER");
    // 切完收起
    expect(host.querySelector(".dbx-schema-pop")).toBeNull();
  });

  it("恢复默认发空串（后端据此切回登录账号）", async () => {
    act(() => root.render(<SchemaChip connId="c1" />));
    act(() => host.querySelector<HTMLButtonElement>(".dbx-schema-chip")!.click());
    await act(async () => host.querySelector<HTMLButtonElement>(".dbx-schema-reset")!.click());
    expect(mocks.change).toHaveBeenCalledWith("c1", "");
  });
});
