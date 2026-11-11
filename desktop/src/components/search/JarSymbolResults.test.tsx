// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JarSymbolResults } from "./JarSymbolResults";
import { resetSearchForm, setSearchForm } from "../../lib/searchStore";
import type { JarSymbolResult } from "../../lib/jarSymbolSearch";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

const outcome = () => ({
  hits: [
    {
      path: "modules/ic/A.java",
      line: 12,
      column: 1,
      text: "billSave",
      ranges: [],
    },
  ],
  filesScanned: 100,
  filesMatched: 1,
  truncated: false,
  elapsedMs: 20,
  scopeDirs: [],
  missingDirs: [],
  scopeFallback: false,
});

const emptyResult = (patch: Partial<JarSymbolResult> = {}): JarSymbolResult => ({
  items: [],
  total: 0,
  truncated: false,
  building: false,
  stale: false,
  elapsedMs: 1,
  ...patch,
});

const render = async (onOpenClass = vi.fn()) => {
  await act(async () => {
    root.render(<JarSymbolResults onOpenClass={onOpenClass} />);
  });
  return onOpenClass;
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  resetSearchForm();
  mocks.invoke.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("JarSymbolResults", () => {
  it("没有全文结果时整段不出现，也不发请求", async () => {
    await render();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(container.querySelector("[aria-label='依赖 jar 内的符号']")).toBeNull();
  });

  it("一次全文搜索完成后用同一个词搜 jar，并列出词与所在类", async () => {
    mocks.invoke.mockResolvedValue(
      emptyResult({
        total: 3,
        items: [
          {
            term: "nc/vo/VoucherBillOrder",
            score: 2,
            places: [{ jar: "C:\\nc\\modules\\a.jar", class: "nc.vo.VoucherBillOrder" }],
          },
        ],
      }),
    );
    setSearchForm({ query: "VoucherBillOrder", outcome: outcome(), outcomeQuery: "VoucherBillOrder" });
    const onOpenClass = await render();

    expect(mocks.invoke).toHaveBeenCalledWith("search_jar_symbols", {
      query: "VoucherBillOrder",
      limit: 50,
    });
    const section = container.querySelector("[aria-label='依赖 jar 内的符号']")!;
    expect(section.textContent).toContain("nc/vo/VoucherBillOrder");
    expect(section.textContent).toContain("nc.vo.VoucherBillOrder");
    expect(section.textContent).toContain("a.jar");
    expect(section.textContent).toContain("3");

    // 点命中把 jar + 点形类名交给调用方（由它拼反编译 URI）
    await act(async () => {
      section.querySelector("button")!.click();
    });
    expect(onOpenClass).toHaveBeenCalledWith("C:\\nc\\modules\\a.jar", "nc.vo.VoucherBillOrder");
  });

  it("常驻说明写清「搜不到注释」——class 文件物理上不含注释", async () => {
    mocks.invoke.mockResolvedValue(
      emptyResult({
        items: [
          {
            term: "数据源ID重复",
            score: 0,
            places: [{ jar: "C:\\nc\\modules\\a.jar", class: "nc.vo.X" }],
          },
        ],
      }),
    );
    setSearchForm({ query: "数据源ID重复", outcome: outcome(), outcomeQuery: "数据源ID重复" });
    await render();
    const section = container.querySelector("[aria-label='依赖 jar 内的符号']")!;
    expect(section.textContent).toContain("搜不到注释");
    expect(section.textContent).toContain("编译时已剥离");
    // 下一段就是源码注释：不指过去，两段挨着就像自相矛盾
    expect(section.textContent).toContain("jar 内源码注释");
    // 中文字符串原文能作为命中项出现
    expect(section.textContent).toContain("数据源ID重复");
  });

  it("索引还没建好：说明在建，但不该报错", async () => {
    mocks.invoke.mockResolvedValue(emptyResult({ building: true }));
    setSearchForm({ query: "VoucherBillOrder", outcome: outcome(), outcomeQuery: "VoucherBillOrder" });
    await render();
    const section = container.querySelector("[aria-label='依赖 jar 内的符号']")!;
    expect(section.textContent).toContain("正在后台建立");
  });

  it("自己的 IPC 在飞：先亮个壳说「搜索中…」，不拿旧结果冒充", async () => {
    let settle: (r: JarSymbolResult) => void = () => {};
    mocks.invoke.mockReturnValue(
      new Promise<JarSymbolResult>((r) => {
        settle = r;
      }),
    );
    setSearchForm({ query: "VoucherBillOrder", outcome: outcome(), outcomeQuery: "VoucherBillOrder" });
    await render();
    const section = container.querySelector("[aria-label='依赖 jar 内的符号']")!;
    expect(section.textContent).toContain("搜索中");
    expect(section.querySelector("ul")).toBeNull();
    expect(section.textContent).not.toContain("命中");

    await act(async () => {
      settle(
        emptyResult({
          items: [
            {
              term: "nc/vo/VoucherBillOrder",
              score: 2,
              places: [{ jar: "C:\\nc\\modules\\a.jar", class: "nc.vo.VoucherBillOrder" }],
            },
          ],
        }),
      );
    });
    await act(async () => {});
    const after = container.querySelector("[aria-label='依赖 jar 内的符号']")!;
    expect(after.textContent).not.toContain("搜索中");
    expect(after.textContent).toContain("nc.vo.VoucherBillOrder");
  });

  it("jar 已变动：提示结果来自旧索引", async () => {
    mocks.invoke.mockResolvedValue(
      emptyResult({
        stale: true,
        items: [
          {
            term: "pk_corp",
            score: 0,
            places: [{ jar: "C:\\nc\\modules\\a.jar", class: "nc.vo.X" }],
          },
        ],
      }),
    );
    setSearchForm({ query: "pk_corp", outcome: outcome(), outcomeQuery: "pk_corp" });
    await render();
    expect(container.querySelector("[aria-label='依赖 jar 内的符号']")!.textContent).toContain(
      "来自旧索引",
    );
  });

  it("后端失败不该让搜索页挂掉：静默不显示这一段", async () => {
    mocks.invoke.mockRejectedValue(new Error("no nc home"));
    setSearchForm({ query: "VoucherBillOrder", outcome: outcome(), outcomeQuery: "VoucherBillOrder" });
    await render();
    await act(async () => {});
    expect(container.querySelector("[aria-label='依赖 jar 内的符号']")).toBeNull();
  });

  it("0 命中时不渲染这一段（有工作区结果已经够说明问题了）", async () => {
    mocks.invoke.mockResolvedValue(emptyResult());
    setSearchForm({ query: "VoucherBillOrder", outcome: outcome(), outcomeQuery: "VoucherBillOrder" });
    await render();
    await act(async () => {});
    expect(container.querySelector("[aria-label='依赖 jar 内的符号']")).toBeNull();
  });

  it("只认搜索完成时的词快照：搜完再打字不重发全 jar 扫描", async () => {
    mocks.invoke.mockResolvedValue(
      emptyResult({
        total: 1,
        items: [
          {
            term: "nc/vo/VoucherBillOrder",
            score: 2,
            places: [{ jar: "C:\\nc\\modules\\a.jar", class: "nc.vo.VoucherBillOrder" }],
          },
        ],
      }),
    );
    setSearchForm({ query: "VoucherBillOrder", outcome: outcome(), outcomeQuery: "VoucherBillOrder" });
    await render();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);

    // 主结果还停在旧词上，输入框里已经又打了两个字
    await act(async () => {
      setSearchForm({ query: "VoucherBillOrderX" });
    });
    await act(async () => {});
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it("中文单字放行：长度门槛只挡纯 ASCII 单字母", async () => {
    mocks.invoke.mockResolvedValue(
      emptyResult({
        items: [
          {
            term: "税率",
            score: 0,
            places: [{ jar: "C:\\nc\\modules\\a.jar", class: "nc.vo.X" }],
          },
        ],
      }),
    );
    setSearchForm({ query: "税", outcome: outcome(), outcomeQuery: "税" });
    await render();
    expect(mocks.invoke).toHaveBeenCalledWith("search_jar_symbols", { query: "税", limit: 50 });
    expect(container.querySelector("[aria-label='依赖 jar 内的符号']")!.textContent).toContain("税率");
  });

  it("单个 ASCII 字母不搜：几十 MB 词表里的噪音", async () => {
    setSearchForm({ query: "a", outcome: outcome(), outcomeQuery: "a" });
    await render();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("索引建失败：说建失败与怎么办，不演「正在后台建立」的假进度", async () => {
    mocks.invoke.mockResolvedValue(emptyResult({ error: "磁盘空间不足" }));
    setSearchForm({ query: "VoucherBillOrder", outcome: outcome(), outcomeQuery: "VoucherBillOrder" });
    await render();
    const section = container.querySelector("[aria-label='依赖 jar 内的符号']")!;
    expect(section.textContent).toContain("建立失败");
    expect(section.textContent).toContain("磁盘空间不足");
    expect(section.textContent).not.toContain("正在后台建立");
    expect(section.textContent).not.toContain("个词命中");
  });

  it("「另有 N 处」按真实命中数算，不只按列出的 8 处", async () => {
    mocks.invoke.mockResolvedValue(
      emptyResult({
        total: 1,
        items: [
          {
            term: "pk_corp",
            score: 0,
            places: [
              { jar: "C:\\nc\\modules\\a.jar", class: "nc.vo.A" },
              { jar: "C:\\nc\\modules\\b.jar", class: "nc.vo.B" },
              { jar: "C:\\nc\\modules\\c.jar", class: "nc.vo.C" },
              { jar: "C:\\nc\\modules\\d.jar", class: "nc.vo.D" },
            ],
            // 后端每词最多列 8 处，真实命中 42 处
            placesTotal: 42,
          },
        ],
      }),
    );
    setSearchForm({ query: "pk_corp", outcome: outcome(), outcomeQuery: "pk_corp" });
    await render();
    const section = container.querySelector("[aria-label='依赖 jar 内的符号']")!;
    // 4 处里只列前 3 个，剩下的按 placesTotal 说：39 处，不是 1 处
    expect(section.textContent).toContain("另有 39 处");
  });
});
