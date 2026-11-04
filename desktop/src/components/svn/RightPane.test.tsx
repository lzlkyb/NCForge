// @vitest-environment jsdom
/**
 * 右栏失败态的重试。
 *
 * 之前 diff 拉失败只剩一句错误文案：用户只能去顶栏点「刷新」，把整份改动清单
 * 重扫一遍。这里盯住「重试按钮真的再打一次 svn diff」——别让按钮只换了个文案。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ diff: vi.fn(), blame: vi.fn() }));

vi.mock("../../lib/tauri", () => ({ invoke: vi.fn() }));
vi.mock("../../lib/svnHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/svnHistory")>();
  return { ...actual, svnBlameSnapshot: mocks.blame };
});
vi.mock("../../lib/svn", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/svn")>();
  return { ...actual, svnDiff: mocks.diff, svnBlame: mocks.blame };
});
// 出错分支不渲染这些面板；挡掉 Monaco 的加载只为让测试跑得动
vi.mock("./DiffPane", () => ({ DiffPane: () => null }));
vi.mock("./HistoryView", () => ({ HistoryView: () => null }));
vi.mock("./ConflictPane", () => ({ ConflictPane: () => null }));

import { RightPane } from "./RightPane";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FILE = {
  path: "D:\\work\\newar\\modules\\a\\src\\A.java",
  rel: "a/src/A.java",
  module: "a",
  letter: "M" as const,
  status: "modified",
  revision: 12,
  isDir: false,
  ignored: false,
};

const flush = async (times = 4) => {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  mocks.diff.mockReset();
  mocks.blame.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("RightPane 差异失败重试", () => {
  it("点重试会再请求一次，成功后离开错误态", async () => {
    mocks.diff.mockRejectedValueOnce(new Error("svn: E155004 工作副本被锁"));
    mocks.diff.mockResolvedValueOnce({
      baseText: "",
      workingText: "",
      encoding: "UTF-8",
      eol: "LF",
      baseEmpty: true,
      baseSize: 0,
      workingSize: 0,
      editable: true,
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={qc}>
          <RightPane
            file={FILE}
            mode="diff"
            onMode={vi.fn()}
            reviewed={false}
            busy={false}
            onToggleReviewed={vi.fn()}
            onOpenFile={vi.fn()}
            onMarkAndNext={vi.fn()}
            onResolve={vi.fn()}
            onLater={vi.fn()}
          />
        </QueryClientProvider>,
      );
    });
    await flush();
    expect(mocks.diff).toHaveBeenCalledTimes(1);

    const retry = [...host.querySelectorAll("button")].find((b) => b.textContent === "重试");
    expect(retry).toBeTruthy();
    await act(async () => { retry!.click(); });
    await flush();

    expect(mocks.diff).toHaveBeenCalledTimes(2);
    // 成功分支没有错误警报（DiffPane 被挡成 null，只剩空壳）
    expect(host.querySelector('[class="vc-alert"]')).toBeNull();
  });

  it("Blame 失败时重试会再算一次", async () => {
    mocks.diff.mockResolvedValue({
      baseText: "a",
      workingText: "a",
      encoding: "UTF-8",
      eol: "LF",
      baseEmpty: false,
      baseSize: 1,
      workingSize: 1,
      editable: true,
    });
    mocks.blame.mockRejectedValueOnce(new Error("svn: E170013 无法连接服务器"));
    mocks.blame.mockResolvedValueOnce({ sourceRevision: 3, text: "a", encoding: "UTF-8", lines: [{ revision: 3, author: "dev", date: 1 }] });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={qc}>
          <RightPane
            file={FILE}
            mode="blame"
            onMode={vi.fn()}
            reviewed={false}
            busy={false}
            onToggleReviewed={vi.fn()}
            onOpenFile={vi.fn()}
            onMarkAndNext={vi.fn()}
            onResolve={vi.fn()}
            onLater={vi.fn()}
          />
        </QueryClientProvider>,
      );
    });
    await flush();
    expect(mocks.blame).toHaveBeenCalledTimes(1);

    const retry = [...host.querySelectorAll("button")].find((b) => b.textContent === "重试");
    expect(retry).toBeTruthy();
    await act(async () => { retry!.click(); });
    await flush();

    expect(mocks.blame).toHaveBeenCalledTimes(2);
    expect(host.textContent).not.toContain("无法连接服务器");
  });
});
