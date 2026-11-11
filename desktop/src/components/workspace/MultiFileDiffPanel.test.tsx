// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MultiFileDiffPanel } from "./MultiFileDiffPanel";
import type { ChangeEvent } from "../../lib/changeTimeline";
import type { RoundPair } from "../../lib/roundBaseline";

const mocks = vi.hoisted(() => ({
  diff: vi.fn((_path: string) => Promise.resolve({ baseText: "BASE\n", workingText: "DISK\n", eol: "LF", encoding: "UTF-8" })),
  pair: vi.fn((_path: string, _from: unknown, _to: unknown): Promise<RoundPair> =>
    Promise.resolve({ original: null, modified: null, originalLabel: "", degraded: false })),
  editor: [] as Record<string, unknown>[],
}));

vi.mock("../svn/SvnDiffEditor", () => ({
  SvnDiffEditor: (props: Record<string, unknown>) => {
    mocks.editor.push(props);
    return <div data-testid="diff-editor" />;
  },
}));
vi.mock("../../lib/svn", () => ({ svnDiff: mocks.diff }));
vi.mock("../../lib/roundBaseline", () => ({ resolveRoundPair: mocks.pair }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

const A = "C:\\w\\modules\\ic\\A.java";
const P = "C:\\w\\modules\\ic\\run.properties";
const start: ChangeEvent = { id: "e1", at: 1000, kind: "me", paths: [A, P], versions: { [A]: "v1", [P]: "v2" } };

const render = async (paths: string[], endEvent: ChangeEvent | null = null) => {
  await act(async () => root.render(
    <MultiFileDiffPanel paths={paths} root="C:\\w" startEvent={start} endEvent={endEvent} onBack={() => {}} />,
  ));
};
const editorProps = () => mocks.editor[mocks.editor.length - 1];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.editor = [];
  mocks.diff.mockResolvedValue({ baseText: "BASE\n", workingText: "DISK\n", eol: "LF", encoding: "UTF-8" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("MultiFileDiffPanel 基线来源", () => {
  it("两侧都有归档点时完全不碰 SVN 桥", async () => {
    mocks.pair.mockImplementation(async (path: string) => ({
      original: `before-${path}\n`,
      modified: `at-${path}\n`,
      originalLabel: "选中时间点之前",
      degraded: false,
    }));
    await render([A]);
    await act(async () => {});
    expect(mocks.diff).not.toHaveBeenCalled();
    expect(mocks.pair).toHaveBeenCalledWith(A, start, null);
    expect(editorProps().original).toBe(`before-${A}\n`);
    expect(editorProps().modified).toBe(`at-${A}\n`);
    expect(editorProps().originalLabel).toBe("选中时间点之前");
    expect(container.textContent).not.toContain("未取到基线");
  });

  it("SVN 桥挂了但本地历史有两点，仍能比较（不再全盘皆空）", async () => {
    mocks.diff.mockRejectedValue(new Error("桥没起"));
    mocks.pair.mockImplementation(async (path: string) => ({
      original: `before-${path}\n`,
      modified: `at-${path}\n`,
      originalLabel: "选中时间点之前",
      degraded: false,
    }));
    await render([A, P]);
    await act(async () => {});
    expect(mocks.diff).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("未取到基线");
    // 已加载 2 个，编辑器渲染第一个
    expect(container.querySelectorAll(".ncf-multi-file:not([disabled])").length).toBe(2);
  });

  it("没有归档点才退化到 SVN 基线，并明确标注", async () => {
    mocks.pair.mockImplementation(async (path: string) => path === A
      ? { original: null, modified: null, originalLabel: "SVN 基线（该轮前无归档点）", degraded: true }
      : { original: "before\n", modified: "at\n", originalLabel: "选中时间点之前", degraded: false });
    await render([A, P]);
    await act(async () => {});
    expect(mocks.diff).toHaveBeenCalledTimes(1);
    expect(mocks.diff).toHaveBeenCalledWith(A);
    const na = [...container.querySelectorAll(".ncf-multi-na")].map((n) => n.textContent);
    expect(na).toEqual([]);
    expect(container.textContent).toContain("已退化为 SVN 基线");
  });

  it("语言按扩展名映射，properties 不再是 java", async () => {
    mocks.pair.mockResolvedValue({ original: "a=1\n", modified: "a=2\n", originalLabel: "选中时间点之前", degraded: false });
    await render([P]);
    await act(async () => {});
    expect(editorProps().language).toBe("ini");
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>(".ncf-multi-file")][0].click();
    });
    expect(editorProps().language).toBe("ini");
  });

  it("sql / xml 仍映射到 sql / xml", async () => {
    mocks.pair.mockResolvedValue({ original: "select 1\n", modified: "select 2\n", originalLabel: "选中时间点之前", degraded: false });
    await render(["C:\\w\\a.sql", "C:\\w\\b.xml"]);
    await act(async () => {});
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>(".ncf-multi-file")][0].click();
    });
    expect(editorProps().language).toBe("sql");
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>(".ncf-multi-file")][1].click();
    });
    expect(editorProps().language).toBe("xml");
  });
});
