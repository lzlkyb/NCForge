// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewChecklist } from "./ReviewChecklist";
import type { ChangeEvent } from "../../lib/changeTimeline";
import type { ChangedProblem } from "../../lib/changedProblems";

const mocks = vi.hoisted(() => ({
  session: { tabs: [] as { path: string; eol: string; readOnlyReason: string | null }[], compileResult: null as unknown },
  langState: "stopped",
  problems: [] as ChangedProblem[],
  tables: [] as { name: string; line: number; exists: boolean | null }[],
  // useSyncExternalStore 的快照必须引用稳定：每次返回新对象会触发无限重渲染
  snap: { rows: [], tooBig: false },
  noDiags: [] as unknown[],
}));

vi.mock("../../lib/workspaceSession", () => ({
  getSession: () => mocks.session,
  useWorkspaceSession: () => mocks.session,
}));
vi.mock("../../lib/lang", () => ({ useLangView: () => ({ state: mocks.langState }) }));
vi.mock("../../lib/diagStore", () => ({
  getCodeDiags: () => mocks.noDiags,
  subscribeCodeDiags: () => () => {},
}));
vi.mock("../../lib/changedLinesStore", () => ({
  getChangedRows: () => [],
  getSnapshotFor: () => mocks.snap,
  subscribeSnapshot: () => () => {},
}));
vi.mock("../../lib/changedProblems", () => ({ problemsInChangedArea: () => mocks.problems }));
vi.mock("../../lib/changedTables", () => ({
  tableRefsInChangedLines: () => [],
  checkChangedTables: () => mocks.tables,
}));
vi.mock("../../lib/reviewSession", () => ({ openTimeline: vi.fn() }));
vi.mock("../ui/toast", () => ({ toast: vi.fn() }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

const A = "C:\\w\\modules\\ic\\A.java";
const round: ChangeEvent = { id: "e1", at: 1, kind: "me", paths: [A] };

const render = async () => {
  await act(async () => root.render(
    <ReviewChecklist root="C:\\w" activePath={A} round={round} onOpenAt={() => {}} />,
  ));
};
const items = () => [...container.querySelectorAll(".ncf-check-item")];
const greenLabels = () => items().filter((n) => n.getAttribute("data-tone") === "ok").map((n) => n.querySelector(".ncf-check-label")?.textContent);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session = { tabs: [], compileResult: null };
  mocks.langState = "stopped";
  mocks.problems = [];
  mocks.tables = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("ReviewChecklist 编译错误项", () => {
  it("没编译过、语言服务也没就绪时不出绿色「没有编译错误」", async () => {
    await render();
    expect(greenLabels()).not.toContain("本轮文件没有编译错误");
    const item = items().find((n) => n.querySelector(".ncf-check-label")?.textContent?.includes("还没编译过"));
    expect(item).toBeTruthy();
    expect(item!.getAttribute("data-tone")).toBe("info");
    expect(item!.querySelector(".ncf-check-detail")?.textContent).toContain("不代表没有错误");
  });

  it("编译过且没有错误时才说「没有编译错误」", async () => {
    mocks.session.compileResult = { problems: [] };
    await render();
    expect(greenLabels()).toContain("本轮文件没有编译错误");
  });

  it("没编译过但语言服务就绪，也允许下结论", async () => {
    mocks.langState = "ready";
    await render();
    expect(greenLabels()).toContain("本轮文件没有编译错误");
  });

  it("有错误时列出来并给定位入口", async () => {
    mocks.problems = [{ path: A, line: 42, message: "找不到符号", severity: "error", source: "ecj", inChangedArea: true }];
    mocks.session.compileResult = { problems: [] };
    await render();
    const bad = items().find((n) => n.getAttribute("data-tone") === "bad");
    expect(bad!.querySelector(".ncf-check-label")?.textContent).toContain("1 条编译错误");
    expect(bad!.querySelector(".ncf-check-detail")?.textContent).toContain("A.java:42");
    expect(bad!.querySelector("button")?.textContent).toBe("定位");
  });

  it("没选轮时不生成任何清单项", async () => {
    await act(async () => root.render(
      <ReviewChecklist root="C:\\w" activePath={A} round={null} onOpenAt={() => {}} />,
    ));
    expect(items()).toHaveLength(0);
    expect(container.textContent).toContain("先在「改动时间线」里选中一轮");
  });
});
