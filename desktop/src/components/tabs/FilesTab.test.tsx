// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilesTab } from "./FilesTab";
import { setSession } from "../../lib/workspaceSession";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), toast: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));
vi.mock("../../components/ui/toast", () => ({ toast: mocks.toast }));
vi.mock("../../hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => true }));
// 编辑器要 Monaco，jsdom 里起不来；本测试只关心文件页的接线
vi.mock("../workspace/EditorPane", () => ({
  EditorPane: () => <div data-testid="editor-pane" />,
}));
vi.mock("../../lib/editorStore", () => ({
  onDirtyChange: () => () => {},
  openModel: vi.fn(),
  closeModel: vi.fn(),
  renameModel: vi.fn(),
  markSaved: vi.fn(),
  getText: vi.fn(() => ""),
  replaceContent: vi.fn(),
}));
// 代码智能依赖 Monaco 与后端事件，jsdom 里起不来；这里只验证文件页没有因它挂掉
vi.mock("../../lib/lang", () => ({
  initLang: vi.fn(async () => {}),
  ensureLang: vi.fn(),
  stopLang: vi.fn(async () => {}),
  setNavHandler: vi.fn(),
  loadJdtSource: vi.fn(),
  restartLang: vi.fn(),
  useLangView: () => ({
    state: "stopped",
    module: null,
    message: "",
    sourceFiles: 0,
    jarCount: 0,
    settled: false,
  }),
}));
vi.mock("../../lib/compile", () => ({
  compileModule: vi.fn(),
  onCompileLog: vi.fn(async () => () => {}),
}));

const ROOT = "C:\\w\\newar";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

const render = async () => {
  await act(async () => root.render(<FilesTab />));
  await act(async () => {}); // 等 get_workspace 落回状态
};

const buttonByText = (text: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as
    | HTMLButtonElement
    | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "get_workspace") return null;
    if (cmd === "fs_list_dir") return [];
    if (cmd === "fs_encoding_marks") return [];
    if (cmd === "set_workspace") return ROOT;
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

describe("文件页", () => {
  it("没有工作区时只给一句引导和一个输入框，不画空的树和编辑器", async () => {
    await render();
    expect(container.textContent).toContain("还没有打开工程目录");
    expect(container.querySelector(".wb-root")).toBeNull();
    // 没填路径时「打开」是禁用的
    expect(buttonByText("打开")?.disabled).toBe(true);
  });

  it("填了路径点打开，把后端返回的规范化路径写回会话，页面切到正常布局", async () => {
    await render();
    const input = container.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, ROOT);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => buttonByText("打开")!.click());

    expect(mocks.invoke).toHaveBeenCalledWith("set_workspace", { path: ROOT });
    expect(container.querySelector(".wb-root")).toBeTruthy();
    expect(container.textContent).toContain("资源管理器");
  });

  it("有工作区时渲染标题栏动作、标签条、编译按钮与状态栏", async () => {
    setSession({
      root: ROOT,
      tabs: [
        {
          path: `${ROOT}\\modules\\ic\\A.java`,
          name: "A.java",
          encoding: "UTF-8",
          hasBom: false,
          eol: "CRLF",
          mtimeMs: 1,
          dirty: false,
          eolChanged: false,
          readOnly: true,
          readOnlyReason: "mixed",
          lines: 10,
        },
      ],
      activePath: `${ROOT}\\modules\\ic\\A.java`,
      panelOpen: false,
      tree: {
        root: ROOT,
        expanded: new Set([ROOT]),
        marks: {},
        dirs: { [ROOT]: { status: "ok", items: [{ name: "modules", isDir: true, size: 0 }] } },
      },
    });
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_workspace") return ROOT;
      return [];
    });
    await render();

    // 标题栏三个动作
    expect(container.querySelector('[aria-label="新建文件"]')).toBeTruthy();
    expect(container.querySelector('[aria-label="新建文件夹"]')).toBeTruthy();
    expect(container.querySelector('[aria-label="更换工作区目录"]')).toBeTruthy();
    // 标签 + 只读徽标 + 编译按钮
    expect(container.querySelector(".wb-tab-name")?.textContent).toBe("A.java");
    expect(container.querySelector(".wb-status-warn")?.textContent).toBe("只读");
    expect(buttonByText("编译")).toBeTruthy();
    // 混合换行提示条带两个统一选项
    expect(container.textContent).toContain("混合换行");
    expect(buttonByText("统一为 CRLF 并编辑")).toBeTruthy();
    // 状态栏有路径与行列
    expect(container.querySelector(".wb-status-path")?.textContent).toBe(
      `${ROOT}\\modules\\ic\\A.java`,
    );
    expect(container.textContent).toContain("第 1 行，第 1 列");
  });
});
