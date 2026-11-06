// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TabStrip } from "./TabStrip";
import { setCodeDiags } from "../../lib/diagStore";

vi.mock("../../lib/editorStore", () => ({ getText: () => undefined }));
import type { TabMeta } from "../../lib/workspaceSession";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("./WorkbenchDock", () => ({ useWorkbenchDock: () => null }));
vi.mock("./TaskMenu", () => ({ TaskMenu: () => null }));
const session = vi.hoisted(() => ({ state: {} as { compileResult?: unknown; root?: string } }));
vi.mock("../../lib/workspaceSession", () => ({
  setSession: vi.fn(),
  useWorkspaceSelector: (select: (s: typeof session.state) => unknown) => select(session.state),
}));

const tab = (path: string, dirty = false): TabMeta => ({
  path,
  name: path.split("\\").pop() ?? path,
  encoding: "UTF-8",
  hasBom: false,
  eol: "LF",
  mtimeMs: 0,
  dirty,
  eolChanged: false,
  readOnly: false,
  readOnlyReason: null,
  lines: 1,
  preview: false,
});

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  session.state = { root: "C:\\w", compileResult: null };
  setCodeDiags([]);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const onSelect=vi.fn(),onClose=vi.fn();
function render(tabs: TabMeta[], activePath: string) {
  act(() =>
    root.render(
      <TabStrip
        root="C:\\w"
        tabs={tabs}
        activePath={activePath}
        splitPath={null}
        compiling={false}
        canCompile
        onSelect={onSelect}
        onClose={onClose}
        onCloseMany={() => 0}
        onPin={vi.fn()}
        onOpenSplit={vi.fn()}
        onCloseSplit={vi.fn()}
        onCompile={vi.fn()}
      />,
    ),
  );
}

describe("TabStrip 未保存标签", () => {
  it("平时留状态点，关闭按钮仍然可点并说明会先确认", () => {
    render([tab("C:\\w\\A.java", true)], "C:\\w\\A.java");
    const x = container.querySelector<HTMLButtonElement>(".wb-tab-x");
    expect(x?.getAttribute("aria-label")).toBe("关闭 A.java");
    expect(x?.title).toContain("未保存");
    expect(x?.querySelector(".wb-dirty-dot")).not.toBeNull();
    expect(x?.querySelector(".wb-tab-close")).not.toBeNull();
  });

  it("已保存标签只显示叉", () => {
    render([tab("C:\\w\\B.java")], "C:\\w\\B.java");
    const x = container.querySelector<HTMLButtonElement>(".wb-tab-x");
    expect(x?.querySelector(".wb-dirty-dot")).toBeNull();
    expect(x?.querySelector(".wb-tab-close")).toBeNull();
  });
});

describe("编译问题落到标签", () => {
  it("有错误的文件显示红色计数，其他标签不显示", () => {
    session.state = {
      root: "C:\\w",
      compileResult: {
        problems: [{ severity: "error", file: "C:\\w\\A.java", line: 1, message: "x" }],
      },
    };
    render([tab("C:\\w\\A.java"), tab("C:\\w\\B.java")], "C:\\w\\A.java");
    const badges = container.querySelectorAll(".wb-tab .wb-problem-badge");
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent).toBe("1");
    expect(badges[0].getAttribute("title")).toContain("1 个编译错误");
  });
});

describe("代码检查徽标", () => {
  it("jdt.ls 用独立徽标和 tooltip，不和编译错误相加", () => {
    setCodeDiags([
      { path: "C:\\w\\A.java", line: 1, column: 1, severity: "warning", message: "未使用的导入" },
    ]);
    render([tab("C:\\w\\A.java"), tab("C:\\w\\B.java")], "C:\\w\\A.java");
    const badges = container.querySelectorAll('.wb-tab .wb-problem-badge[data-sev="inspect"]');
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent).toBe("1");
    expect(badges[0].getAttribute("title")).toContain("代码检查（jdt.ls）");
  });
});

describe("标签键盘与子按钮",()=>{  it.each(["Enter"," "])("关闭按钮的%s不被父标签拦截",key=>{
    render([tab("C:\\w\\A.java")],"C:\\w\\A.java");
    const x=container.querySelector<HTMLButtonElement>(".wb-tab-x")!;
    const e=new KeyboardEvent("keydown",{key,bubbles:true,cancelable:true});act(()=>x.dispatchEvent(e));
    expect(e.defaultPrevented).toBe(false);expect(onSelect).not.toHaveBeenCalled();
    act(()=>x.click());expect(onClose).toHaveBeenCalledOnce();expect(onSelect).not.toHaveBeenCalled();
  });
  it("标签自身方向键漫游仍生效，组合输入不选中",()=>{
    render([tab("C:\\w\\A.java"),tab("C:\\w\\B.java")],"C:\\w\\A.java");
    const row=container.querySelector<HTMLElement>('[role="tab"]')!;
    act(()=>row.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",isComposing:true,bubbles:true,cancelable:true})));
    expect(onSelect).not.toHaveBeenCalled();
    act(()=>row.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true,cancelable:true})));
    expect(onSelect).toHaveBeenCalledWith("C:\\w\\B.java");
  });
});
