// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BottomPanel, type PanelTab } from "./BottomPanel";
import type { CompileResult, Problem } from "../../lib/compile";
import type { CodeDiag } from "../../lib/diagStore";
import { restoreWorkbenchLayout } from "../../lib/workbenchLayout";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 底部面板的每个内容块都挂着各自的 store / 后端订阅；这里只验证面板自己的语义。
// ProblemsView 仍 mock，但把入参摆到 data-* 上：合并/去重是面板算的，不是它算的。
vi.mock("./WorkbenchDock", () => ({ useWorkbenchDock: () => null }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock("../../lib/debugSession", () => ({ useDebugSnapshot: () => ({ paused: false }) }));
vi.mock("../../lib/workspaceSession", () => ({
  useWorkspaceSelector: (sel: (s: { compileLog: string[] }) => unknown) => sel({ compileLog: [] }),
  setSession: vi.fn(),
}));
vi.mock("./ProblemsView", () => ({
  ProblemsView: (p: { problems: Problem[]; diags: CodeDiag[]; compiled: boolean }) => (
    <div
      data-testid="problems"
      data-count={p.problems.length}
      data-diags={p.diags.length}
      data-compiled={p.compiled ? "1" : "0"}
    />
  ),
}));
vi.mock("./CallHierarchyPanel", () => ({ CallHierarchyPanel: () => <div /> }));
vi.mock("./TypeHierarchyPanel", () => ({ TypeHierarchyPanel: () => <div /> }));
vi.mock("./TodoPanel", () => ({ TodoPanel: () => <div /> }));
vi.mock("./BookmarkPanel", () => ({ BookmarkPanel: () => <div /> }));
vi.mock("./DebugPanel", () => ({ DebugPanel: () => <div /> }));
vi.mock("../../lib/callHierarchy", () => ({ openCallHierarchy: vi.fn() }));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  restoreWorkbenchLayout();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

interface RenderOpts {
  log?: string[];
  result?: CompileResult | null;
  inspect?: CodeDiag[];
  onOpenAt?: (path: string, line: number) => void;
  onOpenProblem?: (p: Problem) => void;
}

function render(tab: PanelTab, opts: RenderOpts = {}) {
  const onTab = vi.fn();
  const el: ReactElement = (
    <BottomPanel
      root="C:\\w"
      tab={tab}
      onTab={onTab}
      running={false}
      result={opts.result ?? null}
      log={opts.log}
      onOpenProblem={opts.onOpenProblem ?? vi.fn()}
      onOpenAt={opts.onOpenAt ?? vi.fn()}
      inspect={opts.inspect ?? []}
      onNextProblem={vi.fn()}
      onPrevProblem={vi.fn()}
      onCancel={vi.fn()}
      onClose={vi.fn()}
    />
  );
  act(() => root.render(el));
  return onTab;
}

const tab = (name: string) => container.querySelector<HTMLButtonElement>(`[role=tab][id=wb-ptab-${name}]`);

describe("BottomPanel 页签条", () => {
  it("默认空问题保留紧凑入口，用户主动打开后保持正文", () => {
    render("problems");
    expect(container.querySelector(".wb-panel")?.getAttribute("data-compact")).toBe("true");
    expect(container.querySelector<HTMLElement>("#wb-panel-body")?.hidden).toBe(true);
    act(() => tab("problems")!.click());
    expect(container.querySelector<HTMLElement>("#wb-panel-body")?.hidden).toBe(false);
  });
  it("用 tablist/tab 语义，只有当前页签可被 Tab 键停靠", () => {
    render("build");
    expect(container.querySelector("[role=tablist]")).not.toBeNull();
    expect(tab("build")?.getAttribute("aria-selected")).toBe("true");
    expect(tab("build")?.tabIndex).toBe(0);
    expect(tab("problems")?.getAttribute("aria-selected")).toBe("false");
    expect(tab("problems")?.tabIndex).toBe(-1);
    expect(container.querySelector("[role=tabpanel]")?.id).toBe("wb-panel-body");
  });

  it("左右键切换并把焦点带到新页签，Home/End 到两端", () => {
    const onTab = render("build");
    act(() => {
      tab("build")?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(onTab).toHaveBeenLastCalledWith("svc");
    expect(document.activeElement).toBe(tab("svc"));

    act(() => {
      tab("svc")?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    });
    expect(onTab).toHaveBeenLastCalledWith("debug");

    act(() => {
      tab("debug")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    });
    expect(onTab).toHaveBeenLastCalledWith("problems");
  });

  it("点击页签仍按原路径切换", () => {
    const onTab = render("problems");
    expect(tab("todo")).toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="更多底部工具"]')!.click());
    act(() => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button => button.textContent === "待办")!.click());
    expect(onTab).toHaveBeenCalledWith("todo");
  });
});

describe("BottomPanel 的编译日志", () => {
  it("编译器缺失时可直接请求单包下载", () => {
    const requested = vi.fn();
    window.addEventListener("ncforge-resource-download", requested);
    try {
      render("build", { log: ["编译失败：找不到 Java 编译器组件（ecj）"] });
      const download = [...container.querySelectorAll("button")].find(button => button.textContent?.includes("下载 Java 编译器"));
      expect(download).toBeDefined(); act(() => download!.click());
      expect((requested.mock.calls[0][0] as CustomEvent).detail).toEqual({ id: "ecj" });
      render("build", { log: ["其他编译错误"] });
      expect(container.textContent).not.toContain("下载 Java 编译器");
    } finally { window.removeEventListener("ncforge-resource-download", requested); }
  });
  it("编译失败无结果时，问题页保持缺组件下载入口和输出可见", () => {
    render("problems", { log: ["编译失败：找不到 Java 编译器组件（ecj）"] });
    expect(container.querySelector<HTMLElement>("#wb-panel-body")?.hidden).toBe(false);
    expect(container.querySelector(".wb-panel")?.hasAttribute("data-compact")).toBe(false);
    expect(container.textContent).toContain("下载 Java 编译器");
    render("problems", { log: ["编译失败：Java 配置无效"] });
    expect(container.querySelector<HTMLElement>("#wb-panel-body")?.hidden).toBe(false);
  });
  it("报错行能点开对应文件的那一行", () => {
    const log = [
      "模块 gl · 120 个源文件 · 按 import 挑出 30 个 jar",
      "----------",
      "1. ERROR in C:\\work\\aier\\newar\\gl\\src\\public\\A.java (at line 12)",
      "\tIVoucherQuery cannot be resolved to a type",
      "----------",
      "11 problems (10 errors, 1 warning)",
    ];
    const onOpenAt = vi.fn();
    render("build", { log, onOpenAt });
    const links = [...container.querySelectorAll<HTMLButtonElement>(".wb-log-link")];
    // 只有带「文件:行」的那一行是按钮，其余仍是纯文本
    expect(links).toHaveLength(1);
    expect(links[0].textContent).toContain("A.java");
    act(() => links[0].click());
    expect(onOpenAt).toHaveBeenCalledWith("C:\\work\\aier\\newar\\gl\\src\\public\\A.java", 12);
  });

  it("认不出位置的日志行不变成按钮（点了没反应比不能点更糟）", () => {
    render("build", { log: ["诊断：工程 pm 有 3 个源文件比产物新"] });
    expect(container.querySelectorAll(".wb-log-link")).toHaveLength(0);
  });
});

describe("BottomPanel 的合并口径", () => {
  it("同一处编译错误与代码检查只算一条", () => {
    const p: Problem = { severity: "error", file: "C:\\w\\A.java", line: 12, message: "X" };
    const diag: CodeDiag = { path: "C:\\w\\A.java", line: 12, column: 1, severity: "error", message: "X" };
    const result: CompileResult = {
      ok: false,
      durationMs: 1,
      sourceCount: 1,
      errorCount: 1,
      warningCount: 0,
      problems: [p],
      jarCount: 0,
      rounds: 1,
      outDir: "",
      diagnostics: [],
    };
    render("problems", { result, inspect: [diag] });
    const view = container.querySelector("[data-testid=problems]");
    expect(view?.getAttribute("data-count")).toBe("1");
    expect(view?.getAttribute("data-compiled")).toBe("1");
  });
});
