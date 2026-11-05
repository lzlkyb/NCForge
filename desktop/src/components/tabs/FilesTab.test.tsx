import { DockRegion } from "../workspace/WorkbenchDock";
// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilesTab } from "./FilesTab";
import { WorkbenchFrame } from "../workspace/WorkbenchFrame";
import { setSession } from "../../lib/workspaceSession";
import { setSidebarView } from "../../lib/sidebarView";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), toast: vi.fn() }));
// 服务面板与状态栏胶囊都走 useQuery（server-status）：这里给一份空状态，不让测试去碰真实后端
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: () => ({ data: undefined, refetch: vi.fn(), isError: false, error: null }),
}));
vi.mock("../workspace/TreeSvnProvider", () => ({ TreeSvnProvider: ({ children }: { children: import("react").ReactNode }) => <>{children}</> }));
// 文件树要订阅 fs-changed：给个空注册，本测试不关心外部改动
vi.mock("../../lib/tauri", () => ({
  invoke: mocks.invoke,
  listen: async () => () => {},
}));
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
  getModel: vi.fn(() => undefined),
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
  onLangReadyChange: vi.fn(() => () => {}),
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
  // 侧栏视图与底部标签都是模块级仓库：不还原，后面的用例会互相污染
  setSidebarView("files");
  setSession({ panelTab: "problems", panelOpen: true });
});

describe("文件页", () => {
  it("没有工作区时保留工作台框架与打开引导，不创建编辑器", async () => {
    await render();
    expect(container.textContent).toContain("还没有打开工程目录");
    expect(container.querySelector('[data-testid="editor-pane"]')).toBeNull();
    expect(container.querySelector(".wb-root")).toBeTruthy();
    // 不再手填路径：只有「选择工程目录」按钮，没有输入框
    expect(container.querySelector("input")).toBeNull();
    expect(buttonByText("选择工程目录…")?.disabled).toBe(false);
  });

  it("选文件夹后把后端返回的规范化路径写回会话，页面切到正常布局", async () => {
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_workspace") return null;
      if (cmd === "pick_folder") return ROOT;
      if (cmd === "set_workspace") return ROOT;
      return [];
    });
    await render();
    await act(async () => buttonByText("选择工程目录…")!.click());
    await act(async () => {});

    expect(mocks.invoke).toHaveBeenCalledWith("pick_folder", {
      title: "选择 NC 二开工程根目录",
      defaultPath: null,
    });
    expect(mocks.invoke).toHaveBeenCalledWith("set_workspace", { path: ROOT });
    expect(container.querySelector(".wb-root")).toBeTruthy();
    expect(container.textContent).toContain("资源管理器");
  });

  it("搜索是文件侧栏视图，NC 服务在底部面板，两者都不换掉编辑器节点", async () => {
    mocks.invoke.mockImplementation(async (cmd: string) => cmd === "get_workspace" ? ROOT : []);
    await render();
    const editor = container.querySelector('[data-testid="editor-pane"]');
    expect(editor).toBeTruthy();

    // 搜索并进侧栏：文件树槽位换成搜索表单，编辑器原样保留
    await act(async () => setSidebarView("search"));
    expect(container.querySelector('[data-testid="editor-pane"]')).toBe(editor);
    expect(container.querySelector(".wb-tree input[list]")).toBeTruthy();
    expect(container.querySelector(".wb-pane-title")?.textContent).toContain("全工程搜索");
    await act(async () => setSidebarView("files"));
    expect(container.querySelector(".wb-tree")?.textContent).toContain("资源管理器");
    expect(container.querySelector('[aria-label="全工程搜索"]')).toBeTruthy();

    // 文档型工具仍然占文档区，编辑器留在 DOM 里
    await render("db", <DockRegion region="document"><div>SQL 查询</div></DockRegion>);
    expect(container.querySelector('[data-testid="editor-pane"]')).toBe(editor);
    expect((container.querySelector(".wb-code-surface") as HTMLElement).hidden).toBe(true);

    // NC 服务是底部面板的一个标签：不占导航页签，也没有独立的工具页。
    // 切回文件工具页再开服务面板——文档页（db）还占着文档槽时编辑器本就该让位
    await render("files");
    await act(async () => setSession({ panelOpen: true, panelTab: "svc" }));
    expect(container.querySelector('[data-testid="editor-pane"]')).toBe(editor);
    expect(container.querySelector(".wb-svc-host")?.textContent).toContain("NC 中间件");
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
