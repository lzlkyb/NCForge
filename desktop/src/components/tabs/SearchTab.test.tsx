// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchTab } from "./SearchTab";
import { setSession } from "../../lib/workspaceSession";
import { resetSearchForm, setSearchForm } from "../../lib/searchStore";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));

const ROOT = "C:\\w\\newar";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
const onOpenFile = vi.fn();

const render = async () => {
  await act(async () => root.render(<SearchTab projects={[]} onOpenFile={onOpenFile} />));
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

const ONE_HIT = {
  hits: [
    { path: "modules/ic/src/A.java", line: 12, text: "billSave(v);", ranges: [{ start: 2, end: 8 }] },
    { path: "modules/ic/src/A.java", line: 30, text: "x = billSave;", ranges: [{ start: 4, end: 12 }] },
  ],
  filesMatched: 1,
  filesScanned: 7000,
  elapsedMs: 620,
  truncated: false,
};

const clickHit = async (text: string) => {
  const hit = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(text),
  )!;
  await act(async () => hit.click());
};

beforeEach(() => {
  vi.clearAllMocks();
  // 搜索仓库是模块级的：范围、结果都会跨用例残留，先回到默认「全部工程」
  resetSearchForm();
  setSearchForm({
    scope: "all",
    query: "",
    include: "",
    caseSensitive: false,
    wholeWord: false,
    regex: false,
    replacement: "",
    replacing: false,
  });
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
  // 会话仓库是模块级的：本文件里写过的 root 要还回去，否则同文件后续用例走不到兜底分支
  setSession({ root: undefined });
});

describe("搜索页", () => {
  it("没搜过时给的是操作指引，不是空表格", async () => {
    await render();
    // 默认范围是全部关联工程
    expect(container.textContent).toContain("输入关键字，回车搜索全部关联工程");
    expect(container.textContent).toContain("范围");
    expect(buttonByText("全部工程")).toBeTruthy();
    expect(buttonByText("当前工程")).toBeTruthy();
    // 三个开关与文件过滤常显
    expect(buttonByText("Aa")).toBeTruthy();
    expect(buttonByText("整词")).toBeTruthy();
    expect(buttonByText(".*")).toBeTruthy();
    expect(container.textContent).toContain("文件过滤");
  });

  it("默认搜全部工程：结果按工程分组，点命中用该工程的根拼绝对路径", async () => {
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_workspace") return ROOT;
      if (cmd === "search_projects")
        return {
          projects: [{ project: "newar", root: ROOT, outcome: ONE_HIT }],
          errors: [],
          truncated: false,
          elapsedMs: 620,
        };
      throw new Error(`unexpected command: ${cmd}`);
    });
    await render();

    await typeInto(input(), "billSave");
    // 只输入不搜：不该发请求（边输边搜会把磁盘打满）
    expect(mocks.invoke).not.toHaveBeenCalledWith("search_projects", expect.anything());

    await press(input(), "Enter");
    expect(mocks.invoke).toHaveBeenCalledWith("search_projects", {
      options: {
        text: "billSave",
        caseSensitive: false,
        wholeWord: false,
        regex: false,
        include: "",
      },
    });
    // 默认范围不该退化成只搜当前工作区
    expect(mocks.invoke).not.toHaveBeenCalledWith("search_workspace", expect.anything());

    // 汇总行 + 工程分段 + 两条命中
    expect(container.textContent).toContain("1 个工程");
    expect(container.textContent).toContain("newar");
    expect(container.textContent).toContain("A.java");
    await clickHit("billSave(v);");
    // 第三个参数是列号：ranges[0].start 是行内 UTF-16 偏移（0 基 2），+1 得 1 基列号 3。
    expect(onOpenFile).toHaveBeenCalledWith(`${ROOT}\\modules\\ic\\src\\A.java`, 12, 3);
  });

  it("切到当前工程才走单工作区命令，并清掉全部工程的旧结果", async () => {
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_workspace") return ROOT;
      if (cmd === "search_projects")
        return {
          projects: [{ project: "newar", root: ROOT, outcome: ONE_HIT }],
          errors: [],
          truncated: false,
          elapsedMs: 620,
        };
      if (cmd === "search_workspace")
        return {
          hits: [{ path: "modules/ic/src/A.java", line: 12, text: "其他工程命中", ranges: [] }],
          filesMatched: 1,
          filesScanned: 7000,
          elapsedMs: 620,
          truncated: false,
        };
      throw new Error(`unexpected command: ${cmd}`);
    });
    await render();

    await typeInto(input(), "billSave");
    await press(input(), "Enter");
    expect(container.textContent).toContain("A.java");

    await act(async () => buttonByText("当前工程")!.click());
    // 旧结果的口径不同，不能留在屏幕上
    expect(container.textContent).not.toContain("A.java");
    expect(container.textContent).toContain("输入关键字，回车搜索整个工作区");

    await press(input(), "Enter");
    expect(mocks.invoke).toHaveBeenCalledWith("search_workspace", expect.anything());
    // search_projects 只被第一次搜索调用过
    expect(
      mocks.invoke.mock.calls.filter(([cmd]) => cmd === "search_projects"),
    ).toHaveLength(1);
    expect(container.textContent).toContain("其他工程命中");
  });

  it("正则出错时清掉旧结果并就地报错（不弹 toast）", async () => {
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_workspace") return ROOT;
      if (cmd === "search_projects") throw "正则语法错误：unclosed group";
      throw new Error(`unexpected command: ${cmd}`);
    });
    await render();

    await typeInto(input(), "a(b");
    await press(input(), "Enter");

    expect(container.textContent).toContain("正则语法错误：unclosed group");
    // 没有结果就不该还挂着「没有找到」
    expect(container.textContent).not.toContain("没有找到");
  });

  it("切换工作区后不重挂载也用新 root 拼路径（订阅会话，不是挂载时读一次）", async () => {
    const NEW = "D:\\w\\other";
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_workspace") return ROOT;
      if (cmd === "search_workspace") return ONE_HIT;
      throw new Error(`unexpected command: ${cmd}`);
    });
    await render();

    await act(async () => buttonByText("当前工程")!.click());
    // 搜索页被 ActivityPanel 保活：切工作区不会重挂载。
    // 模拟 applyWorkspace 把新 root 写进会话——旧实现到这里还挂着旧 root，
    // 点命中会拿旧相对路径拼旧 root，替换更糟（确认框显示旧工作区的改动面）
    await act(async () => setSession({ root: NEW }));

    await typeInto(input(), "billSave");
    await press(input(), "Enter");
    await clickHit("billSave(v);");
    expect(onOpenFile).toHaveBeenCalledWith(`${NEW}\\modules\\ic\\src\\A.java`, 12, 3);
  });
});
