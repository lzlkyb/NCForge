// @vitest-environment jsdom
/**
 * 打开工程只通过系统文件夹选择器。
 *
 * 盯住三件事：选择器返回 canceled 时什么都不发生；选中目录后交给
 * 保存/切换流程；打开失败的原因留在按钮下方（不靠几秒后消失的 toast）。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NoWorkspace } from "./NoWorkspace";

const h = vi.hoisted(() => ({ pickFolder: vi.fn() }));
vi.mock("../../lib/folderPicker", () => ({
  pickFolder: h.pickFolder,
  pickFolderError: (e: unknown) => `无法打开文件夹选择框：${String(e)}`,
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const onOpen = vi.fn<(path: string) => Promise<string | null>>();

beforeEach(() => {
  onOpen.mockReset();
  h.pickFolder.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const flush = async (times = 3) => {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
};

function render(recents: string[] = []) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(<NoWorkspace recents={recents} onOpen={onOpen} />);
  });
  return host;
}

const chooseButton = (el: HTMLElement) =>
  [...el.querySelectorAll("button")].find((b) => b.textContent?.includes("选择工程目录"))!;

describe("NoWorkspace 目录选择", () => {
  it("选中目录后交给打开流程，失败原因留在按钮下方", async () => {
    h.pickFolder.mockResolvedValueOnce("C:\\work\\newar");
    onOpen.mockResolvedValueOnce("无法打开目录：路径不存在");
    const el = render();
    await act(async () => { chooseButton(el).click(); });
    await flush();

    expect(h.pickFolder).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledWith("C:\\work\\newar");
    expect(el.querySelector('[role="alert"]')?.textContent).toContain("路径不存在");
    expect(el.querySelector("#wb-root-error")).toBe(el.querySelector('[role="alert"]'));
    // 页面里不再有手填路径的输入框
    expect(el.querySelector("input")).toBeNull();
  });

  it("取消选择时既不打开、也不留错误", async () => {
    h.pickFolder.mockResolvedValueOnce(null);
    const el = render();
    await act(async () => { chooseButton(el).click(); });
    await flush();

    expect(onOpen).not.toHaveBeenCalled();
    expect(el.querySelector('[role="alert"]')).toBeNull();
  });

  it("选择器本身失败时给出原因", async () => {
    h.pickFolder.mockRejectedValueOnce(new Error("dialog unavailable"));
    const el = render();
    await act(async () => { chooseButton(el).click(); });
    await flush();

    expect(el.querySelector('[role="alert"]')?.textContent).toContain("无法打开文件夹选择框");
  });

  it("打开成功时不留错误残留", async () => {
    h.pickFolder.mockResolvedValueOnce("C:\\work\\newar");
    onOpen.mockResolvedValueOnce(null);
    const el = render();
    await act(async () => { chooseButton(el).click(); });
    await flush();

    expect(el.querySelector('[role="alert"]')).toBeNull();
  });

  it("同名工程显示完整路径以便区分", () => {
    const paths = ["C:/customer-a/newar", "D:/customer-b/newar"];
    const el = render(paths);
    expect([...el.querySelectorAll(".wb-root-recent-name")].map(n => n.textContent)).toEqual(["newar", "newar"]);
    expect([...el.querySelectorAll(".wb-root-recent-path")].map(n => n.textContent)).toEqual(paths);
  });

  it("最近工作区仍然一键打开", async () => {
    onOpen.mockResolvedValueOnce(null);
    const el = render(["C:\\work\\old"]);
    const recent = [...el.querySelectorAll("button")].find((b) => b.querySelector(".wb-root-recent-name")?.textContent === "old")!;
    await act(async () => { recent.click(); });
    await flush();

    expect(onOpen).toHaveBeenCalledWith("C:\\work\\old");
    expect(h.pickFolder).not.toHaveBeenCalled();
  });
});
