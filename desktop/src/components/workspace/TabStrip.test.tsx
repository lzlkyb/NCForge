// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TreeSvnContext } from "./TreeSvnContext";
import type { StatusLetter } from "../../lib/svn";
import { TabStrip } from "./TabStrip";
import { svnSession } from "../../lib/svnSession";
import { setCodeDiags } from "../../lib/diagStore";

vi.mock("../../lib/editorStore", () => ({ getText: () => undefined }));
import type { TabMeta } from "../../lib/workspaceSession";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("./WorkbenchDock", () => ({ useWorkbenchDock: () => null }));
vi.mock("./TaskMenu", () => ({ TaskMenu: () => null }));
const session = vi.hoisted(() => ({ state: {} as { compileResult?: unknown; root?: string; tabs?: TabMeta[] } }));
vi.mock("../../lib/workspaceSession", () => ({
  setSession: vi.fn(),
  getSession: () => session.state,
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
function render(tabs: TabMeta[], activePath: string, files = new Map<string, StatusLetter>()) {
  session.state.tabs = tabs;
  act(() =>
    root.render(
      <TreeSvnContext.Provider value={{ files, directories: new Map(), summary: null }}>
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
      />
      </TreeSvnContext.Provider>,
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

  it("shows the SVN status alongside unsaved edits and offers targeted review", () => {
    const changed = tab("C:/w/A.java", true);
    changed.name = "A.java";
    render([changed], changed.path, new Map([["c:/w/a.java", "?"]]));
    const row = container.querySelector<HTMLElement>("[role=tab]")!;
    expect(row.textContent).toContain("未跟踪");
    expect(row.querySelector(".wb-dirty-dot")).not.toBeNull();
    act(() => row.querySelector<HTMLButtonElement>(".wb-svn-badge-action")!.click());
    expect(svnSession.get()).toMatchObject({
      selectedPath: changed.path, changeIntent: { path: changed.path, action: "review" },
    });
    expect(onSelect).not.toHaveBeenCalled();
    act(() => row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
    expect(document.body.textContent).toContain("到版本控制查看改动");
    expect(document.body.textContent).toContain("加入本次提交");
    const action = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find(item => item.textContent?.includes("加入本次提交"))!;
    act(() => action.click());
    expect(svnSession.get()).toMatchObject({
      page: "review", selectedPath: changed.path, changeIntent: { path: changed.path, action: "commit" },
    });
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
    expect(badges[0].getAttribute("title")).toContain("1 个错误 · 最近编译 1 条");
  });
});

describe("代码检查徽标", () => {
  it("实时检查按警告样式显示，悬停说明来源", () => {
    setCodeDiags([
      { path: "C:\\w\\A.java", line: 1, column: 1, severity: "warning", message: "未使用的导入" },
    ]);
    render([tab("C:\\w\\A.java"), tab("C:\\w\\B.java")], "C:\\w\\A.java");
    const badges = container.querySelectorAll('.wb-tab .wb-problem-badge[data-sev="warning"]');
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent).toBe("1");
    expect(badges[0].getAttribute("title")).toContain("实时检查 1 条");
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

  it("Delete 关掉标签后焦点落到相邻标签，不掉到 body",async()=>{
    const list=[tab("C:\\w\\A.java"),tab("C:\\w\\B.java"),tab("C:\\w\\C.java")];
    // 关闭由调用方真正把标签摘掉：不这么做的话 DOM 节点还在，焦点「没掉」是假象
    const draw=(tabs:TabMeta[])=>act(()=>root.render(
      <TreeSvnContext.Provider value={{ files:new Map(), directories:new Map(), summary:null }}>
      <TabStrip root="C:\\w" tabs={tabs} activePath="C:\\w\\B.java" splitPath={null} compiling={false} canCompile
        onSelect={onSelect} onClose={(p)=>draw(tabs.filter(t=>t.path!==p))} onCloseMany={()=>0}
        onPin={vi.fn()} onOpenSplit={vi.fn()} onCloseSplit={vi.fn()} onCompile={vi.fn()} />
      </TreeSvnContext.Provider>,
    ));
    session.state.tabs=list;draw(list);
    const b=[...container.querySelectorAll<HTMLElement>('[role="tab"]')][1];
    b.focus();
    expect(document.activeElement).toBe(b);
    await act(async()=>{
      b.dispatchEvent(new KeyboardEvent("keydown",{key:"Delete",bubbles:true,cancelable:true}));
      await new Promise(resolve=>requestAnimationFrame(()=>resolve(null)));
    });
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(2);
    // B 被关掉后焦点该接在它后面的 C 上。必须断言 role=tab：焦点掉到 body 时
    // body 的 textContent 里也有 "C.java"，只看文字会当成通过。
    expect(document.activeElement?.getAttribute("role")).toBe("tab");
    expect(document.activeElement?.textContent).toContain("C.java");
  });
});
