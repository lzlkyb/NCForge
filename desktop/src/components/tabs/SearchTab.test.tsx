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
  scopeDirs: [],
  missingDirs: [],
  scopeFallback: false,
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
  it("搜索与文件过滤输入有稳定名称，清空搜索词按钮按名称可找到", async () => {
    await render();
    expect(input().getAttribute("aria-label")).toBe("搜索工程文件内容");
    expect(container.querySelector('input[aria-label="文件过滤"]')).not.toBeNull();
    await typeInto(input(), "凭证");
    const clear = container.querySelector<HTMLButtonElement>('button[aria-label="清空搜索词"]')!;
    await act(async () => clear.click());
    expect(input().value).toBe("");
  });

  it.each([
    { field: "query", composing: true, keyCode: 13 },
    { field: "query", composing: false, keyCode: 229 },
    { field: "filter", composing: true, keyCode: 13 },
    { field: "filter", composing: false, keyCode: 229 },
  ])("$field 输入法组词 Enter 不启动扫描（composing=$composing / $keyCode）", async ({ field, composing, keyCode }) => {
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_workspace") return ROOT;
      if (cmd === "search_projects") return { projects: [], errors: [], truncated: false, elapsedMs: 0 };
      throw new Error(`unexpected command: ${cmd}`);
    });
    await render(); await typeInto(input(), "凭证");
    const target = field === "query" ? input() : container.querySelector<HTMLInputElement>('input[aria-label="文件过滤"]')!;
    const event = new KeyboardEvent("keydown", { key: "Enter", keyCode, isComposing: composing, bubbles: true, cancelable: true });
    await act(async () => { target.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(false);
    expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "search_projects")).toHaveLength(0);
    await press(target, "Enter");
    expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "search_projects")).toHaveLength(1);
  });

  it("后端截断丢失匹配位置时打开原行，不用显示副本猜列号", async () => {
    const missingRange = { path: "A.java", line: 42, text: `${"x".repeat(300)}…`, ranges: [] };
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_workspace") return ROOT;
      if (cmd === "search_workspace") return { ...ONE_HIT, hits: [missingRange] };
      throw new Error(`unexpected command: ${cmd}`);
    });
    await render(); await act(async () => buttonByText("当前工程")!.click());
    await typeInto(input(), "凭证"); await press(input(), "Enter");
    await clickHit("预览未包含匹配位置，打开完整行查看");
    expect(onOpenFile).toHaveBeenCalledWith(`${ROOT}\\A.java`, 42, 1);
  });

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
        // 全部工程不接受范围（后端会拒绝 dirs），所以这里必须是空的
        dirs: [],
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

  // ── 按业务组件搜索（manifest 当数据用）──

  const MANIFEST = {
    components: [
      { name: "bill", dispname: "票据", roots: ["src/public", "src/client"] },
      { name: "gl", dispname: "总账", roots: ["src/public"] },
    ],
    notes: [],
  };

  /** 打开「组件」菜单并点一个组件（菜单体是 portal 到 body 的）。 */
  const pickComponent = async (name: string) => {
    await act(async () => buttonByText("组件")!.click());
    await act(async () => {});
    const item = [...document.querySelectorAll('[role^="menuitem"]')].find((el) =>
      el.textContent?.includes(name),
    ) as HTMLButtonElement;
    expect(item).toBeTruthy();
    await act(async () => item.click());
  };

  it("按组件搜索：范围取组件目录，命令仍是单工作区那条", async () => {
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_workspace") return ROOT;
      if (cmd === "nc_manifest") return MANIFEST;
      if (cmd === "search_workspace") return { ...ONE_HIT, scopeDirs: ["bill"] };
      throw new Error(`unexpected command: ${cmd}`);
    });
    await render();
    await pickComponent("bill");

    // 芯片上写清选的是哪个组件（切范围后也能一眼看出当前口径）
    expect(container.textContent).toContain("组件 bill");
    await typeInto(input(), "billSave");
    await press(input(), "Enter");

    // 范围是模块目录本身：resources / META-INF 也算组件的一部分（不只是 src/public）
    expect(mocks.invoke).toHaveBeenCalledWith("search_workspace", {
      options: {
        text: "billSave",
        caseSensitive: false,
        wholeWord: false,
        regex: false,
        include: "",
        dirs: ["bill"],
      },
    });
    expect(container.textContent).toContain("A.java");
  });

  it("组件菜单底部说明「另有 N 个模块未登记」", async () => {
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_workspace") return ROOT;
      if (cmd === "nc_manifest") return MANIFEST;
      if (cmd === "nc_manifest_audit")
        return { registered: 2, onDisk: 4, unregistered: ["aim", "cmp"] };
      throw new Error(`unexpected command: ${cmd}`);
    });
    await render();
    await act(async () => buttonByText("组件")!.click());
    await act(async () => {});

    // 只陈述事实，不报警：登记表由 NC 设计器维护，平台/工具模块本来就不在里面
    expect(document.body.textContent).toContain("另有 2 个模块未在 manifest 登记");
    expect(document.body.textContent).toContain("照样能搜索、能编译");
    expect(document.body.textContent).toContain("aim");
  });

  it("组件目录不存在时说明「已按整个工作区搜索」，不静默换口径", async () => {
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_workspace") return ROOT;
      if (cmd === "nc_manifest")
        return { components: [{ name: "gone", dispname: "", roots: [] }], notes: [] };
      if (cmd === "search_workspace")
        return { ...ONE_HIT, scopeFallback: true, missingDirs: ["gone"], scopeDirs: [] };
      throw new Error(`unexpected command: ${cmd}`);
    });
    await render();
    await pickComponent("gone");
    await typeInto(input(), "billSave");
    await press(input(), "Enter");

    expect(container.textContent).toContain("按整个工作区搜索");
    // 结果没丢：回落不是报错
    expect(container.textContent).toContain("A.java");
  });

  it("拿不到 manifest 时「按组件」置灰，并在 title 里说明原因", async () => {
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_workspace") return ROOT;
      if (cmd === "nc_manifest") throw new Error("读取 manifest.xml 失败: 文件不存在");
      throw new Error(`unexpected command: ${cmd}`);
    });
    await render();

    const chip = buttonByText("组件") as HTMLButtonElement;
    expect(chip.disabled).toBe(true);
    expect(chip.getAttribute("title")).toContain("没有登记业务组件");
  });
});
