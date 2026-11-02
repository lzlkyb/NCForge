// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProblemsView } from "./ProblemsView";
import type { UnifiedProblem } from "../../lib/problemList";

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

const render = async (problems: UnifiedProblem[]) => {
  const onOpenProblem = vi.fn();
  const onOpenAt = vi.fn();
  await act(async () =>
    root.render(
      <ProblemsView
        problems={problems}
        diags={[]}
        running={false}
        compiled
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

describe("ProblemsView 复制全部", () => {
  it("复制的是当前筛选后的列表（一行一条，含中文严重度）", async () => {
    await render([u({ line: 1, message: "错误一" }), u({ line: 2, severity: "warning", message: "警告一" })]);
    await act(async () => button("复制全部")?.click());
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "C:\\w\\A.java:1  错误  错误一\nC:\\w\\A.java:2  警告  警告一",
    );
  });
});
