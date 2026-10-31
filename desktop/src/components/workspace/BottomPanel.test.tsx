// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BottomPanel } from "./BottomPanel";
import type { CompileDiagnostic, CompileResult, Problem } from "../../lib/compile";

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

const render = async (r: CompileResult | null, onOpenProblem = vi.fn()) => {
  await act(async () =>
    root.render(
      <BottomPanel
        root="C:/work/aier/newar"
        tab="problems"
        onTab={() => {}}
        running={false}
        result={r}
        log={[]}
        onOpenProblem={onOpenProblem}
        onCancel={() => {}}
        onClose={() => {}}
      />,
    ),
  );
  return onOpenProblem;
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
    const onOpen = await render(result({ diagnostics: [unlinked] }));
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
    const onOpen = await render(result({ problems: [p], errorCount: 1, diagnostics: [unlinked] }));
    const row = container.querySelector<HTMLButtonElement>(".wb-prow:not(.wb-diag)");
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain("IVoucherQuery");
    await act(async () => row?.click());
    expect(onOpen).toHaveBeenCalledWith(p);
  });
});
