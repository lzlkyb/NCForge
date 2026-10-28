// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchTab } from "./SearchTab";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));

const ROOT = "C:\\w\\newar";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
const onOpenFile = vi.fn();

const render = async () => {
  await act(async () => root.render(<SearchTab onOpenFile={onOpenFile} />));
  await act(async () => {}); // 等 get_workspace 落回状态
};

const input = () => container.querySelector<HTMLInputElement>("input[list]")!;

/** React 受控输入：必须走原生 setter，否则 React 收不到这次变化。 */
const typeInto = async (el: HTMLInputElement, value: string) =>
  act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });

const press = async (el: HTMLInputElement, key: string) =>
  act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });

const buttonByText = (text: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as
    | HTMLButtonElement
    | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "get_workspace") return ROOT;
    throw new Error(`unexpected command: ${cmd}`);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("搜索页", () => {
  it("没搜过时给的是操作指引，不是空表格", async () => {
    await render();
    expect(container.textContent).toContain("输入关键字，回车搜索整个工作区");
    // 三个开关与文件过滤常显
    expect(buttonByText("Aa")).toBeTruthy();
    expect(buttonByText("整词")).toBeTruthy();
    expect(buttonByText(".*")).toBeTruthy();
    expect(container.textContent).toContain("文件过滤");
  });

  it("回车才发请求，结果按文件分组，点命中带绝对路径和行号交给文件页", async () => {
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_workspace") return ROOT;
      if (cmd === "search_workspace")
        return {
          hits: [
            { path: "modules/ic/src/A.java", line: 12, text: "billSave(v);", ranges: [{ start: 0, end: 8 }] },
            { path: "modules/ic/src/A.java", line: 30, text: "x = billSave;", ranges: [{ start: 4, end: 12 }] },
          ],
          filesMatched: 1,
          filesScanned: 7000,
          elapsedMs: 620,
          truncated: false,
        };
      throw new Error(`unexpected command: ${cmd}`);
    });
    await render();

    await typeInto(input(), "billSave");
    // 只输入不搜：不该发请求（边输边搜会把磁盘打满）
    expect(mocks.invoke).not.toHaveBeenCalledWith("search_workspace", expect.anything());

    await press(input(), "Enter");
    expect(mocks.invoke).toHaveBeenCalledWith("search_workspace", {
      options: {
        text: "billSave",
        caseSensitive: false,
        wholeWord: false,
        regex: false,
        include: "",
      },
    });

    // 汇总行 + 两条命中
    expect(container.textContent).toContain("2");
    expect(container.textContent).toContain("A.java");
    const hit = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("billSave(v);"),
    )!;
    await act(async () => hit.click());
    expect(onOpenFile).toHaveBeenCalledWith(`${ROOT}\\modules\\ic\\src\\A.java`, 12);
  });

  it("正则出错时清掉旧结果并就地报错（不弹 toast）", async () => {
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_workspace") return ROOT;
      if (cmd === "search_workspace") throw "正则语法错误：unclosed group";
      throw new Error(`unexpected command: ${cmd}`);
    });
    await render();

    await typeInto(input(), "a(b");
    await press(input(), "Enter");

    expect(container.textContent).toContain("正则语法错误：unclosed group");
    // 没有结果就不该还挂着「没有找到」
    expect(container.textContent).not.toContain("没有找到");
  });
});
