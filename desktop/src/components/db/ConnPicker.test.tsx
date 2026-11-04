// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbConn } from "../../lib/dbApi";

vi.mock("../../lib/dbStore", () => ({
  useDbConns: () => conns,
  useDbRt: () => ({}),
  connOf: (id: string | null) => conns.find((c) => c.id === id) ?? null,
  rtOf: (id: string) => ({ status: id === "dev" ? "connected" : "idle" }),
  openConnDialog: vi.fn(),
}));

import { ConnPicker } from "./ConnPicker";
import { openConnDialog } from "../../lib/dbStore";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const conns: DbConn[] = [{
  id: "dev",
  name: "开发库",
  env: "dev",
  source: "manual",
  url: "jdbc:oracle:thin:@localhost:1521/orcl",
  user: "u",
  propDs: null,
  autoCommit: false,
  note: "",
  hasPassword: false,
  engine: "java",
}, {
  id: "prod", name: "生产库", env: "prod", source: "manual",
  url: "jdbc:oracle:thin:@localhost:1521/prod", user: "u", propDs: null,
  autoCommit: false, note: "", hasPassword: false, engine: "java",
}];

const originalWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  if (originalWidth) Object.defineProperty(window, "innerWidth", originalWidth);
});

const openPicker = (width: number, anchorLeft: number, onPick = vi.fn()) => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  act(() => root.render(<ConnPicker connId={null} onPick={onPick} />));
  const button = host.querySelector<HTMLButtonElement>(".dbx-connpick")!;
  vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
    left: anchorLeft, right: anchorLeft + 120, top: 40, bottom: 70,
    x: anchorLeft, y: 40, width: 120, height: 30, toJSON: () => ({}),
  });
  act(() => button.click());
  return document.querySelector<HTMLDivElement>(".dbx-dd")!;
};

describe("连接选择菜单", () => {
  it.each([[560, 320], [360, 200]])("在 %i px 窗口内保留完整菜单", (width, anchorLeft) => {
    const menu = openPicker(width, anchorLeft);
    const left = Number.parseFloat(menu.style.left);
    // 断言可见范围，而不是复刻定位算法；旧实现直接沿用 anchorLeft 会超出窗口。
    expect(left).toBeGreaterThanOrEqual(8);
    expect(left + Math.min(380, width - 16)).toBeLessThanOrEqual(width - 8);
    expect(menu.textContent).toContain("开发库");
  });

  it("空间充足时沿按钮对齐，选择连接后关闭菜单", () => {
    const onPick = vi.fn();
    const menu = openPicker(1280, 300, onPick);
    expect(menu.style.left).toBe("300px");
    act(() => menu.querySelector<HTMLButtonElement>(".li")!.click());
    expect(onPick).toHaveBeenCalledWith("dev");
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it("方向键与Home/End移动选项，Space选择后返回按钮焦点", () => {
    const onPick = vi.fn();
    const menu = openPicker(1280, 300, onPick);
    const trigger = host.querySelector<HTMLButtonElement>(".dbx-connpick")!;
    const options = [...menu.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    expect(trigger.getAttribute("aria-haspopup")).toBe("listbox");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-controls")).toBe(menu.querySelector('[role="listbox"]')!.id);
    expect(document.activeElement).toBe(options[0]);
    const key = (value: string) => act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })); });
    key("ArrowUp"); expect(document.activeElement).toBe(options[1]);
    key("Home"); expect(document.activeElement).toBe(options[0]);
    key("End"); expect(document.activeElement).toBe(options[1]);
    key(" ");
    expect(onPick).toHaveBeenCalledWith("prod");
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("当前选项语义、Escape归还焦点及新建连接动作彼此独立", () => {
    const menu = openPicker(1280, 300);
    act(() => root.render(<ConnPicker connId="dev" onPick={vi.fn()} />));
    const selected = menu.querySelector('[role="option"][aria-selected="true"]');
    expect(selected?.textContent).toContain("开发库");
    expect(menu.querySelector('[role="listbox"]')?.textContent).not.toContain("新建连接");
    act(() => selected?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    const trigger = host.querySelector<HTMLButtonElement>(".dbx-connpick")!;
    expect(document.activeElement).toBe(trigger);
    act(() => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
    const create = [...document.querySelectorAll<HTMLButtonElement>(".dbx-dd button")].find((b) => b.textContent?.includes("新建连接"))!;
    act(() => create.click());
    expect(openConnDialog).toHaveBeenCalledWith(null);
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });
});
