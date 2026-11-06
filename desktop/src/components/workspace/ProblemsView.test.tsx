// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProblemsView } from "./ProblemsView";
import type { ProblemPathScope } from "../../lib/diagnosticScope";
import type { UnifiedProblem } from "../../lib/problemList";
import type { CompileDiagnostic, CompileResult } from "../../lib/compile";
import { setSession } from "../../lib/workspaceSession";

const mocks = vi.hoisted(() => ({ openLinkedDialog: vi.fn() }));
vi.mock("../../lib/linkedDialog", () => ({ openLinkedDialog: mocks.openLinkedDialog }));
vi.mock("../../lib/editorStore", () => ({ getText: () => "first\nsource context\nthird" }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

const u = (over: Partial<UnifiedProblem> = {}): UnifiedProblem => ({
  path: "C:\\w\\A.java",
  line: 1,
  severity: "error",
  message: "找不到符号",
  source: "compile",
  ...over,
});

const render = async (
  problems: UnifiedProblem[],
  extra: { pathFilter?: string | null; pathFilterScope?: ProblemPathScope; onClearPathFilter?: () => void; root?: string; activePath?: string; result?: CompileResult } = {},
) => {
  const onOpenProblem = vi.fn();
  const onOpenAt = vi.fn();
  await act(async () =>
    root.render(
      <ProblemsView
        problems={problems}
        diags={[]}
        running={false}
        compiled
        pathFilter={extra.pathFilter ?? null}
        pathFilterScope={extra.pathFilterScope}
        onClearPathFilter={extra.onClearPathFilter}
        root={extra.root}
        activePath={extra.activePath}
        result={extra.result}
        onOpenProblem={onOpenProblem}
        onOpenAt={onOpenAt}
      />,
    ),
  );
  return { onOpenProblem, onOpenAt };
};

const button = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    (b.textContent ?? "").startsWith(label),
  );

beforeEach(() => {
  setSession({ tabs: [] });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async () => {}) },
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("ProblemsView 筛选与分组", () => {
  it("范围只显示当前模块/文件，预览不跳编辑器且换工程后关闭", async () => {
    const problems = [u({ path: "D:/p/gl/src/A.java" }), u({ path: "D:/p/gl/src/B.java" }), u({ path: "D:/p/ar/src/C.java" })];
    const actions = await render(problems, { root: "D:/p", activePath: problems[0].path });
    const scope = container.querySelector<HTMLSelectElement>('[aria-label="问题范围"]')!;
    await act(async () => { scope.value = "module"; scope.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(container.querySelectorAll(".wb-prow")).toHaveLength(2);
    await act(async () => { scope.value = "file"; scope.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(container.querySelectorAll(".wb-prow")).toHaveLength(1);
    await act(async () => container.querySelector<HTMLButtonElement>(".dw-preview-button")!.click());
    expect(container.querySelector('[aria-label="源码上下文预览"]')).not.toBeNull(); expect(actions.onOpenProblem).not.toHaveBeenCalled();
    await render(problems, { root: "D:/other", activePath: problems[0].path });
    expect(container.querySelector('[aria-label="源码上下文预览"]')).toBeNull();
  });
  it("saved disk changes remain visibly stale against the captured build version", async () => {
    const path = "D:/p/gl/A.java";
    setSession({ tabs: [{ path, name: "A.java", encoding: "UTF-8", hasBom: false, eol: "LF", mtimeMs: 20, dirty: false, eolChanged: false, readOnly: false, readOnlyReason: null, lines: 2 }] });
    const result: CompileResult = { ok: true, errorCount: 0, warningCount: 0, sourceCount: 1, durationMs: 1, jarCount: 0, rounds: 1, outDir: "classes", problems: [], diagnostics: [], completedAtMs: 123, sourceSnapshots: { "d:/p/gl/a.java": { mtimeMs: 10, atMs: 123 } } };
    await render([], { root: "D:/p", activePath: path, result });
    expect(container.textContent).toContain("1 个文件需核对新版本"); expect(container.textContent).toContain("编译结果");
  });
  it("按严重度筛选：只剩该档的行，筛空时可一键恢复全部", async () => {
    await render([
      u({ line: 1, severity: "error", message: "错误一" }),
      u({ line: 2, severity: "warning", message: "警告一" }),
    ]);
    expect(container.querySelectorAll(".wb-prow")).toHaveLength(2);

    await act(async () => button("错误")?.click());
    expect(container.querySelectorAll(".wb-prow")).toHaveLength(1);
    expect(container.textContent).toContain("错误一");

    // 切到没有条目的档位：给出空态，而不是空白一片
    await act(async () => button("提示")?.click());
    expect(container.querySelectorAll(".wb-prow")).toHaveLength(0);
    expect(container.textContent).toContain("没有符合筛选");

    await act(async () => button("显示全部")?.click());
    expect(container.querySelectorAll(".wb-prow")).toHaveLength(2);
  });

  it("按文件分组：组头带条数，组内行仍可点", async () => {
    await render([u({ line: 1 }), u({ line: 2 }), u({ path: "C:\\w\\B.java", line: 5 })]);
    await act(async () => button("按文件分组")?.click());
    const heads = [...container.querySelectorAll(".wb-pgroup-head")];
    expect(heads).toHaveLength(2);
    expect(heads[0].textContent).toContain("A.java");
    expect(heads[0].textContent).toContain("2");
    expect(heads[1].textContent).toContain("B.java");
    expect(container.querySelectorAll(".wb-prow")).toHaveLength(3);
  });
});

describe("ProblemsView 行语义", () => {
  it("按目录边界筛选，跳到合并诊断保留的实时列号", async () => {
    const problems = [
      u({ path: "C:/w/mod/A.java", column: 7, alsoInspected: true }),
      u({ path: "C:/w/mod/nested/B.java" }),
      u({ path: "C:/w/module/C.java" }),
    ];
    const actions = await render(problems, { pathFilter: "c:/W/mod", pathFilterScope: "branch" });
    expect(container.querySelectorAll(".wb-prow")).toHaveLength(2);
    expect(container.textContent).toContain("实时检查 + 最近编译");
    await act(async () => container.querySelector<HTMLButtonElement>(".wb-prow")!.click());
    expect(actions.onOpenAt).toHaveBeenCalledWith("C:/w/mod/A.java", 1, true, 7);
    await render(problems, { pathFilter: "c:/W/mod", pathFilterScope: "package" });
    expect(container.querySelectorAll(".wb-prow")).toHaveLength(1);
  });
  it("编译问题点开走 onOpenProblem，代码检查点开走 onOpenAt", async () => {
    const { onOpenProblem, onOpenAt } = await render([
      u({ line: 7, message: "编译错" }),
      u({ path: "C:\\w\\B.java", line: 9, source: "inspect", message: "检查项" }),
    ]);
    const rows = [...container.querySelectorAll<HTMLButtonElement>(".wb-prow")];
    await act(async () => rows[0].click());
    expect(onOpenProblem).toHaveBeenCalledWith(
      expect.objectContaining({ file: "C:\\w\\A.java", line: 7, message: "编译错" }),
    );
    await act(async () => rows[1].click());
    expect(onOpenAt).toHaveBeenCalledWith("C:\\w\\B.java", 9);
    expect(onOpenProblem).toHaveBeenCalledTimes(1);
  });

  it("未编译且没有问题：提示去点编译；编译过则说没有发现问题", async () => {
    await act(async () =>
      root.render(
        <ProblemsView
          problems={[]}
          diags={[]}
          running={false}
          compiled={false}
          onOpenProblem={() => {}}
          onOpenAt={() => {}}
        />,
      ),
    );
    expect(container.textContent).toContain("还没有编译过");
  });
});

describe("ProblemsView 诊断行", () => {
  it("按诊断归属给出去处：被停用去覆盖规则，没产物/产物旧去依赖链", async () => {
    const diag = (kind: CompileDiagnostic["kind"], project: string): CompileDiagnostic => ({
      kind,
      project,
      message: `${project} 的诊断`,
      file: null,
    });
    await act(async () =>
      root.render(
        <ProblemsView
          problems={[]}
          diags={[diag("disabled", "pm"), diag("uncompiled", "newar"), diag("stale-class", "EyePortal")]}
          running={false}
          compiled
          onOpenProblem={() => {}}
          onOpenAt={() => {}}
        />,
      ),
    );

    const acts = [...container.querySelectorAll<HTMLButtonElement>(".wb-diag-act")];
    expect(acts.map((b) => b.textContent)).toEqual(["覆盖规则", "依赖链", "依赖链"]);

    await act(async () => acts[0].click());
    expect(mocks.openLinkedDialog).toHaveBeenCalledWith("overrides");
    await act(async () => acts[1].click());
    expect(mocks.openLinkedDialog).toHaveBeenCalledWith("chain");
    expect(mocks.openLinkedDialog).toHaveBeenCalledTimes(2);
  });
});

describe("ProblemsView 复制全部", () => {
  it("复制的是当前筛选后的列表（一行一条，含中文严重度）", async () => {
    await render([u({ line: 1, message: "错误一" }), u({ line: 2, severity: "warning", message: "警告一" })]);
    await act(async () => button("复制全部")?.click());
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "C:\\w\\A.java:1  错误  错误一\nC:\\w\\A.java:2  警告  警告一",
    );
  });
});

describe("ProblemsView 来源与文件过滤", () => {
  it("每行标出最近编译或实时检查来源", async () => {
    await render([
      u({ line: 1 }),
      u({ path: "C:\\w\\B.java", line: 2, severity: "info", source: "inspect", message: "未使用的导入" }),
    ]);
    const srcs = [...container.querySelectorAll(".wb-prow-src")];
    expect(srcs.map((s) => s.textContent)).toEqual(["最近编译", "实时检查"]);
    expect(srcs[1].getAttribute("data-source")).toBe("inspect");
  });

  it("只看一个文件：计数与列表都按该文件收窄，可清除过滤", async () => {
    const clear = vi.fn();
    await render(
      [
        u({ line: 1, message: "A 的错误" }),
        u({ path: "C:\\w\\B.java", line: 2, message: "B 的错误" }),
      ],
      { pathFilter: "C:\\w\\A.java", onClearPathFilter: clear },
    );
    expect(container.querySelectorAll(".wb-prow")).toHaveLength(1);
    expect(container.textContent).toContain("仅看");
    expect(container.textContent).toContain("A 的错误");
    expect(container.textContent).not.toContain("B 的错误");
    await act(async () => button("显示全部文件")?.click());
    expect(clear).toHaveBeenCalledOnce();
  });

  it("该文件没有问题时空态给出清除入口", async () => {
    const clear = vi.fn();
    await render([u({ path: "C:\\w\\B.java", line: 2 })], {
      pathFilter: "C:\\w\\A.java",
      onClearPathFilter: clear,
    });
    expect(container.querySelectorAll(".wb-prow")).toHaveLength(0);
    expect(container.textContent).toContain("该文件没有问题了");
    await act(async () => button("显示全部文件")?.click());
    expect(clear).toHaveBeenCalledOnce();
  });
});
