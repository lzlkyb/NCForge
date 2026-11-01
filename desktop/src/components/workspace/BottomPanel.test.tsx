// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BottomPanel } from "./BottomPanel";
import type { CompileDiagnostic, CompileResult, Problem } from "../../lib/compile";
import type { CodeDiag } from "../../lib/diagStore";

// 调用层级面板要连语言服务（`lib/callHierarchy` → `editorActions` → Monaco），
// jsdom 里起不来；这里只验证面板宿主没被它拖挂，层级本身另有单测。
vi.mock("../../lib/callHierarchy", () => ({
  useCallState: () => ({ root: null, incoming: [], outgoing: [], loading: false, error: null }),
  openCallHierarchy: vi.fn(),
  openCallItem: vi.fn(),
}));

// 类型层级面板同样要连语言服务，理由同上
vi.mock("../../lib/typeHierarchy", () => ({
  useTypeState: () => ({ root: null, supertypes: [], subtypes: [], loading: false, error: null }),
  openTypeHierarchy: vi.fn(),
  openTypeEntry: vi.fn(),
  kindLabel: (k: string) => k,
  typeHierarchyKey: () => "Ctrl+T",
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

const result = (over: Partial<CompileResult> = {}): CompileResult => ({
  ok: false,
  durationMs: 1200,
  sourceCount: 10,
  errorCount: 0,
  warningCount: 0,
  problems: [],
  jarCount: 3,
  rounds: 1,
  outDir: "C:/work/aier/newar/gl/classes",
  diagnostics: [],
  ...over,
});

const unlinked: CompileDiagnostic = {
  kind: "uncompiled",
  project: "newar",
  message: "「newar」里有 nc.bs.foo.X 的源码，但没有编译产物（缺 nc/bs/foo/X.class），先编译「newar」再试",
  file: "C:\\work\\aier\\newar\\gl\\src\\private\\nc\\bs\\foo\\X.java",
};

const render = async (
  r: CompileResult | null,
  onOpenProblem = vi.fn(),
  log: string[] = [],
  tab: "problems" | "build" = "problems",
  inspect: CodeDiag[] = [],
) => {
  const onOpenAt = vi.fn();
  await act(async () =>
    root.render(
      <BottomPanel
        root="C:/work/aier/newar"
        tab={tab}
        onTab={() => {}}
        running={false}
        result={r}
        log={log}
        onOpenProblem={onOpenProblem}
        onOpenAt={onOpenAt}
        inspect={inspect}
        onNextProblem={() => {}}
        onPrevProblem={() => {}}
        onCancel={() => {}}
        onClose={() => {}}
      />,
    ),
  );
  return { onOpenProblem, onOpenAt };
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("BottomPanel 的编译诊断", () => {
  it("只有诊断时不再说「没有发现问题」，且把源码路径摆出来", async () => {
    await render(result({ diagnostics: [unlinked] }));
    const text = container.textContent ?? "";
    expect(text).not.toContain("没有发现问题");
    expect(text).toContain("nc.bs.foo.X");
    expect(text).toContain("X.java");
    // 诊断不是错误，标签页上的错误数不该被它顶起来
    expect(container.querySelector(".wb-ptab-n")).toBeNull();
  });

  it("诊断不可点：源码在关联工程里（工作区外），点了只会被路径守卫挡住", async () => {
    const { onOpenProblem: onOpen } = await render(result({ diagnostics: [unlinked] }));
    const rows = [...container.querySelectorAll(".wb-diag")];
    expect(rows).toHaveLength(1);
    expect(rows[0].tagName).not.toBe("BUTTON");
    await act(async () => {
      rows[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onOpen).not.toHaveBeenCalled();
    // 工程名单独一列，能一眼看出是谁没编译
    expect(rows[0].textContent).toContain("newar");
  });

  it("ecj 报错照旧可点、可跳转（诊断只是追加，不替换原文）", async () => {
    const p: Problem = {
      severity: "error",
      file: "C:/work/aier/newar/gl/src/public/A.java",
      line: 12,
      message: "IVoucherQuery cannot be resolved to a type",
    };
    const { onOpenProblem: onOpen } = await render(result({ problems: [p], errorCount: 1, diagnostics: [unlinked] }));
    const row = container.querySelector<HTMLButtonElement>(".wb-prow:not(.wb-diag)");
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain("IVoucherQuery");
    await act(async () => row?.click());
    expect(onOpen).toHaveBeenCalledWith(p);
  });
});

describe("BottomPanel 的代码检查", () => {
  const diag: CodeDiag = {
    path: "C:\\work\\aier\\newar\\gl\\src\\public\\A.java",
    line: 12,
    column: 5,
    severity: "error",
    message: "The method save() is undefined",
  };

  it("波浪线那批也进问题面板，并且能点开", async () => {
    // 以前只有 Monaco 的波浪线，面板里什么都没有——两套说法各说各的
    const { onOpenAt } = await render(null, undefined, [], "problems", [diag]);
    const text = container.textContent ?? "";
    expect(text).toContain("代码检查");
    expect(text).toContain("A.java:12");
    const rows = [...container.querySelectorAll<HTMLButtonElement>(".wb-prow")];
    expect(rows).toHaveLength(1);
    await act(async () => rows[0].click());
    expect(onOpenAt).toHaveBeenCalledWith(diag.path, diag.line);
  });

  it("只有代码检查时也不再是「还没有编译过」的空面板", async () => {
    await render(null, undefined, [], "problems", [diag]);
    expect(container.textContent).not.toContain("还没有编译过");
    expect(container.querySelector(".wb-ptab-n")?.textContent).toBe("1");
  });

  it("编译错误与同一处代码检查不会重复计数", async () => {
    const p: Problem = { severity: "error", file: diag.path, line: 12, message: "The method save() is undefined" };
    await render(result({ problems: [p], errorCount: 1 }), undefined, [], "problems", [diag]);
    expect(container.querySelector(".wb-ptab-n")?.textContent).toBe("1");
  });

  it("info 档（未使用的导入 / 命名建议）弱化显示，不顶徽章数", async () => {
    const info: CodeDiag = { ...diag, severity: "info", message: "未使用的导入：java.util.List" };
    const { onOpenAt } = await render(null, undefined, [], "problems", [info]);
    // 图标用 info 档样式（弱化色），不再是警告的三角
    expect(container.querySelector(".wb-prow-info")).not.toBeNull();
    expect(container.querySelector(".wb-prow-warn")).toBeNull();
    // 徽章只数 error：纯 info 时连数字都不显示
    expect(container.querySelector(".wb-ptab-n")).toBeNull();
    // 照旧可点开
    const rows = [...container.querySelectorAll<HTMLButtonElement>(".wb-prow")];
    expect(rows).toHaveLength(1);
    await act(async () => rows[0].click());
    expect(onOpenAt).toHaveBeenCalledWith(info.path, info.line);
  });
});

describe("BottomPanel 的编译日志", () => {
  it("报错行能点开对应文件的那一行", async () => {
    const log = [
      "模块 gl · 120 个源文件 · 按 import 挑出 30 个 jar",
      "----------",
      "1. ERROR in C:\\work\\aier\\newar\\gl\\src\\public\\A.java (at line 12)",
      "\tIVoucherQuery cannot be resolved to a type",
      "----------",
      "11 problems (10 errors, 1 warning)",
    ];
    const { onOpenAt } = await render(null, undefined, log, "build");
    const links = [...container.querySelectorAll<HTMLButtonElement>(".wb-log-link")];
    // 只有带「文件:行」的那一行是按钮，其余仍是纯文本
    expect(links).toHaveLength(1);
    expect(links[0].textContent).toContain("A.java");
    await act(async () => links[0].click());
    expect(onOpenAt).toHaveBeenCalledWith("C:\\work\\aier\\newar\\gl\\src\\public\\A.java", 12);
  });

  it("认不出位置的日志行不变成按钮（点了没反应比不能点更糟）", async () => {
    await render(null, undefined, ["诊断：工程 pm 有 3 个源文件比产物新"], "build");
    expect(container.querySelectorAll(".wb-log-link")).toHaveLength(0);
  });
});
