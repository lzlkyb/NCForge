import { DockRegion } from "../workspace/WorkbenchDock";
// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilesTab } from "./FilesTab";
import { WorkbenchFrame } from "../workspace/WorkbenchFrame";
import { setSession } from "../../lib/workspaceSession";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), toast: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock("../workspace/TreeSvnProvider", () => ({ TreeSvnProvider: ({ children }: { children: import("react").ReactNode }) => <>{children}</> }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));
vi.mock("../../components/ui/toast", () => ({ toast: mocks.toast }));
vi.mock("../../hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => true }));
// 任何一条链只要摸到编辑器就会加载真 Monaco（要 worker / canvas，jsdom 里第一行
// `document.queryCommandSupported` 就炸）。本测试只关心文件页的接线，整块替掉。
vi.mock("../../lib/monacoSetup", () => ({ initMonaco: vi.fn(), monaco: {} }));
// 编辑器要 Monaco，jsdom 里起不来；本测试只关心文件页的接线
vi.mock("../workspace/EditorPane", () => ({
  EditorPane: () => <div data-testid="editor-pane" />,
}));
// 编辑器动作会 import 真的 monacoSetup（要 worker / canvas），本测试不关心命令面板里那几条，
// 给个空清单即可
vi.mock("../../lib/editorActions", () => ({
  EDITOR_COMMANDS: [],
  currentIsJava: () => false,
  runEditorCommand: () => false,
  setRenameRequest: vi.fn(),
  setGenerateRequest: vi.fn(),
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
  navigate: vi.fn(),
  inLangModule: () => false,
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

/**
 * 文件页不再是「所有页面的宿主」：它只往外壳的槽位里 portal 内容。
 * 测试要自己搭一层外壳，组合方式与 App 里的 WorkbenchShell 一致
 * （FilesTab 必须在 frame 内部才拿得到 dock 上下文）。
 */
const frame = (activeTool: string, tool: ReactNode = null) => (
  <WorkbenchFrame
    activeTool={activeTool}
    fileTabs
    tool={
      <>
        <FilesTab activeTool={activeTool} />
        {tool}
      </>
    }
    tree={null}
    tabs={null}
    editor={null}
    output={null}
    status={null}
  />
);

const render = async (activeTool = "files", tool: ReactNode = null) => {
  await act(async () => root.render(frame(activeTool, tool)));
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
  it("没有工作区时保留工作台框架与打开引导，不创建编辑器", async () => {
    await render();
    expect(container.textContent).toContain("还没有打开工程目录");
    expect(container.querySelector('[data-testid="editor-pane"]')).toBeNull();
    expect(container.querySelector(".wb-root")).toBeTruthy();
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

  it("工具面板切换保持同一个编辑器节点", async () => {
    mocks.invoke.mockImplementation(async (cmd: string) => cmd === "get_workspace" ? ROOT : []);
    await render();
    const editor = container.querySelector('[data-testid="editor-pane"]');
    expect(editor).toBeTruthy();
    await render("search", <DockRegion region="sidebar"><div>搜索结果</div></DockRegion>);
    expect(container.querySelector('[data-testid="editor-pane"]')).toBe(editor);
    expect(container.querySelector(".wb-tree")?.textContent).toContain("搜索结果");
    await render("db", <DockRegion region="document"><div>SQL 查询</div></DockRegion>);
    expect(container.querySelector('[data-testid="editor-pane"]')).toBe(editor);
    expect((container.querySelector(".wb-code-surface") as HTMLElement).hidden).toBe(true);
    await render("services", <DockRegion region="bottom"><div>服务日志</div></DockRegion>);
    expect(container.querySelector('[data-testid="editor-pane"]')).toBe(editor);
    // 服务日志停靠在底部面板「NC 服务」标签的宿主里
    expect(container.querySelector(".wb-svc-host")?.textContent).toContain("服务日志");
    expect((container.querySelector(".wb-code-surface") as HTMLElement).hidden).toBe(false);
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
