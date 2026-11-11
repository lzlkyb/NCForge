// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SrcNoteResults } from "./SrcNoteResults";
import { resetSearchForm, setSearchForm } from "../../lib/searchStore";
import type { SrcNoteResult } from "../../lib/srcNoteSearch";

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

const emptyResult = (patch: Partial<SrcNoteResult> = {}): SrcNoteResult => ({
  items: [],
  total: 0,
  truncated: false,
  building: false,
  stale: false,
  elapsedMs: 1,
  ...patch,
});

const render = async (onOpenSource = vi.fn()) => {
  await act(async () => {
    root.render(<SrcNoteResults onOpenSource={onOpenSource} />);
  });
  return onOpenSource;
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

describe("SrcNoteResults", () => {
  it("没有全文结果时整段不出现，也不发请求", async () => {
    await render();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(container.querySelector("[aria-label='依赖 jar 内的源码注释']")).toBeNull();
  });

  it("一次全文搜索完成后用同一个词搜源码注释，列出注释正文与所在类", async () => {
    mocks.invoke.mockResolvedValue(
      emptyResult({
        total: 5,
        items: [
          {
            jar: "D:\\ncc\\1909home\\modules\\aeam\\lib\\pubaeam_amLevel-1_src.jar",
            path: "nc/pub/ba/update/BAPUpdateDB.java",
            line: 2,
            text: "61升级63，部分功能节点编码从8001变为8004",
          },
        ],
      }),
    );
    setSearchForm({ query: "升级63", outcome: outcome(), outcomeQuery: "升级63" });
    const onOpenSource = await render();

    expect(mocks.invoke).toHaveBeenCalledWith("search_src_notes", {
      query: "升级63",
      limit: 40,
    });
    const section = container.querySelector("[aria-label='依赖 jar 内的源码注释']")!;
    expect(section.textContent).toContain("61升级63，部分功能节点编码从8001变为8004");
    // 类名由包内路径换算（`nc/pub/ba/update/BAPUpdateDB.java` → 点形）
    expect(section.textContent).toContain("nc.pub.ba.update.BAPUpdateDB");
    expect(section.textContent).toContain("pubaeam_amLevel-1_src.jar");
    // `total` 是**命中条数**（不是索引里的注释总数）：5 条命中、只列了 1 条
    expect(section.textContent).toContain("命中 5 条");
    expect(section.textContent).toContain("显示前 1");

    // 点命中把 jar + 点形类名 + 行号交给调用方（由它拼打开地址）
    await act(async () => {
      section.querySelector("button")!.click();
    });
    expect(onOpenSource).toHaveBeenCalledWith(
      "D:\\ncc\\1909home\\modules\\aeam\\lib\\pubaeam_amLevel-1_src.jar",
      "nc.pub.ba.update.BAPUpdateDB",
      2,
    );
  });

  it("常驻说明写清这段与上一段的分工——注释只能来自源码包", async () => {
    mocks.invoke.mockResolvedValue(
      emptyResult({
        items: [
          {
            jar: "D:\\ncc\\a_src.jar",
            path: "nc/vo/Foo.java",
            line: 1,
            text: "设置创建时间",
          },
        ],
      }),
    );
    setSearchForm({ query: "创建时间", outcome: outcome(), outcomeQuery: "创建时间" });
    await render();
    const section = container.querySelector("[aria-label='依赖 jar 内的源码注释']")!;
    expect(section.textContent).toContain("_src.jar");
    expect(section.textContent).toContain("class 文件不含注释");
  });

  it("索引还没建好：说明在建，但不该报错", async () => {
    mocks.invoke.mockResolvedValue(emptyResult({ building: true }));
    setSearchForm({ query: "升级63", outcome: outcome(), outcomeQuery: "升级63" });
    await render();
    const section = container.querySelector("[aria-label='依赖 jar 内的源码注释']")!;
    expect(section.textContent).toContain("正在后台建立");
  });

  it("building 时不报命中数：索引还没建好，这次没有任何命中可言", async () => {
    mocks.invoke.mockResolvedValue(emptyResult({ building: true, total: 300000 }));
    setSearchForm({ query: "升级63", outcome: outcome(), outcomeQuery: "升级63" });
    await render();
    const section = container.querySelector("[aria-label='依赖 jar 内的源码注释']")!;
    // 条数是上一次索引的量级，报出来只会让人以为库里没注释
    expect(section.textContent).not.toContain("命中");
    expect(section.textContent).not.toContain("300000");
    expect(section.textContent).toContain("正在后台建立");
  });

  it("自己的 IPC 在飞：先亮个壳说「搜索中…」，不拿旧结果冒充", async () => {
    let settle: (r: SrcNoteResult) => void = () => {};
    mocks.invoke.mockReturnValue(
      new Promise<SrcNoteResult>((r) => {
        settle = r;
      }),
    );
    setSearchForm({ query: "升级63", outcome: outcome(), outcomeQuery: "升级63" });
    await render();
    const section = container.querySelector("[aria-label='依赖 jar 内的源码注释']")!;
    expect(section.textContent).toContain("搜索中");
    // 请求没回来就没有列表，也不报命中数
    expect(section.querySelector("ul")).toBeNull();
    expect(section.textContent).not.toContain("命中");

    await act(async () => {
      settle(
        emptyResult({
          items: [{ jar: "D:\\ncc\\a_src.jar", path: "nc/vo/Foo.java", line: 1, text: "设置创建时间" }],
        }),
      );
    });
    await act(async () => {});
    const after = container.querySelector("[aria-label='依赖 jar 内的源码注释']")!;
    expect(after.textContent).not.toContain("搜索中");
    expect(after.textContent).toContain("设置创建时间");
  });

  it("源码包已变动：提示结果来自旧索引", async () => {
    mocks.invoke.mockResolvedValue(
      emptyResult({
        stale: true,
        items: [
          { jar: "D:\\ncc\\a_src.jar", path: "nc/vo/Foo.java", line: 3, text: "设置pk_corp" },
        ],
      }),
    );
    setSearchForm({ query: "pk_corp", outcome: outcome(), outcomeQuery: "pk_corp" });
    await render();
    expect(
      container.querySelector("[aria-label='依赖 jar 内的源码注释']")!.textContent,
    ).toContain("来自旧索引");
  });

  it("后端失败不该让搜索页挂掉：静默不显示这一段", async () => {
    mocks.invoke.mockRejectedValue(new Error("no nc home"));
    setSearchForm({ query: "升级63", outcome: outcome(), outcomeQuery: "升级63" });
    await render();
    await act(async () => {});
    expect(container.querySelector("[aria-label='依赖 jar 内的源码注释']")).toBeNull();
  });

  it("0 命中时不渲染这一段", async () => {
    mocks.invoke.mockResolvedValue(emptyResult());
    setSearchForm({ query: "升级63", outcome: outcome(), outcomeQuery: "升级63" });
    await render();
    await act(async () => {});
    expect(container.querySelector("[aria-label='依赖 jar 内的源码注释']")).toBeNull();
  });

  it("只认搜索完成时的词快照：搜完再打字不重发 IPC", async () => {
    mocks.invoke.mockResolvedValue(
      emptyResult({
        total: 1,
        items: [{ jar: "D:\\ncc\\a_src.jar", path: "nc/vo/Foo.java", line: 1, text: "升级63" }],
      }),
    );
    setSearchForm({ query: "升级63", outcome: outcome(), outcomeQuery: "升级63" });
    await render();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);

    // 主结果还停在「升级63」上，输入框里已经打成「升级6」：拿实时词当依赖会让
    // 每敲一个字都重发一路 IPC，而两段与主结果对不上
    await act(async () => {
      setSearchForm({ query: "升级6" });
    });
    await act(async () => {});
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it("索引建失败：说建失败与怎么办，不演「正在后台建立」的假进度", async () => {
    mocks.invoke.mockResolvedValue(emptyResult({ error: "磁盘空间不足" }));
    setSearchForm({ query: "升级63", outcome: outcome(), outcomeQuery: "升级63" });
    await render();
    const section = container.querySelector("[aria-label='依赖 jar 内的源码注释']")!;
    expect(section.textContent).toContain("建立失败");
    expect(section.textContent).toContain("磁盘空间不足");
    expect(section.textContent).not.toContain("正在后台建立");
    // 建失败就是 0 命中，不该再报条数
    expect(section.textContent).not.toContain("命中");
  });

  it("加载更多：limit 翻倍再搜同一个词", async () => {
    const items = Array.from({ length: 40 }, (_, i) => ({
      jar: "D:\\ncc\\a_src.jar",
      path: "nc/vo/Foo.java",
      line: i + 1,
      text: `注释${i}`,
    }));
    mocks.invoke.mockResolvedValue(emptyResult({ total: 90, items }));
    setSearchForm({ query: "升级63", outcome: outcome(), outcomeQuery: "升级63" });
    await render();
    const section = container.querySelector("[aria-label='依赖 jar 内的源码注释']")!;
    const more = [...section.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("加载更多"),
    )!;
    expect(more.textContent).toContain("还有 50 条");
    await act(async () => {
      more.click();
    });
    await act(async () => {});
    expect(mocks.invoke).toHaveBeenLastCalledWith("search_src_notes", {
      query: "升级63",
      limit: 80,
    });
  });
});
