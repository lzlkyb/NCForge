// @vitest-environment jsdom
/**
 * 数据字典文档（数据库页的一种标签）的接线。
 *
 * 盯的是四件「看着能用、其实没接上」的事：
 * ① 没选范围时生成按钮是**禁用**的——后端会报 `no-selection`，但让用户点一次才看到错很蠢；
 * ② 勾选真的进了请求：`nc_md_tables` 回来的行点一下，`nc_md_dict` 的 filter.names 里要有它；
 * ③ 表卡片默认折叠、展开才渲染列行（328 表 × 25 列一次铺开会卡）；
 * ④ 「补丁涉及」扫出的表里，库里没有的必须**标出来**——静默丢掉会让人以为这张表没字段。
 *
 * 选表过程与结果现在存在 `dbStore` 的字典标签里（切到 SQL 标签再切回来不能丢），
 * 所以每个用例先开一个字典标签，组件按 tabId 从仓库读。
 *
 * `workspaceSession` 整模块 mock 掉：它静态引 `editorStore`，后者会把 Monaco 拖进 jsdom。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), toast: vi.fn(), draft: vi.fn() }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));
vi.mock("../ui/toast", () => ({ toast: mocks.toast }));
vi.mock("../../lib/workspaceSession", () => ({ useWorkspaceRoot: () => null }));
vi.mock("../../lib/patchDraft", () => ({
  loadPatchDraft: mocks.draft,
  savePatchDraft: vi.fn(),
}));

import { DictWorkspace } from "./DictWorkspace";
import { __resetDbForTest, openDictTab } from "../../lib/dbStore";
import type { TableBrief, MdDictOut } from "../../lib/mdDict";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MATERIAL: TableBrief = {
  name: "bd_material",
  displayName: "物料",
  isExtend: false,
  module: "bd",
};

const DICT: MdDictOut = {
  tables: [
    {
      name: "bd_material",
      displayName: "物料",
      isExtend: false,
      module: "bd",
      resid: "bd_material",
      entities: [{ className: "MaterialVO", fullClassName: "nc.vo.bd.material.MaterialVO", columns: 2 }],
      columns: [
        {
          name: "pk_material",
          displayName: "物料主键",
          type: "CHAR(20)",
          pkey: true,
          nullable: false,
          seq: 1,
          props: [{ name: "pk_material", displayName: "物料主键" }],
        },
        {
          name: "code",
          displayName: "物料编码",
          type: "VARCHAR2(40)",
          pkey: false,
          nullable: false,
          seq: 2,
          props: [{ name: "code", displayName: "编码" }],
        },
      ],
      notes: [],
    },
  ],
  tableCount: 1,
  columnCount: 2,
  columnsWithoutName: 0,
  missing: [],
  selection: "指定 1 张表",
  source: "nc@10.200.22.144/aier260824",
  elapsedMs: 812,
};

let root: Root;
let container: HTMLDivElement;

const flush = async () => {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
};

const render = async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let tabId = "";
  act(() => {
    __resetDbForTest();
    tabId = openDictTab(null);
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <DictWorkspace tabId={tabId} />
      </QueryClientProvider>,
    );
  });
  await flush();
};

const buttonByText = (text: string) =>
  [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim().includes(text)) as
    | HTMLButtonElement
    | undefined;

const typeQuery = async (text: string) => {
  const el = container.querySelector<HTMLInputElement>(".md-find input")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
};

const click = async (el: HTMLElement | null | undefined) => {
  expect(el).toBeTruthy();
  await act(async () => el!.click());
  await flush();
};

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.draft.mockReset();
  mocks.draft.mockReturnValue(null);
  mocks.invoke.mockImplementation((cmd: string) => {
    if (cmd === "nc_md_tables") {
      return Promise.resolve({ tables: [MATERIAL], truncated: false, source: "nc@db" });
    }
    if (cmd === "nc_md_dict") return Promise.resolve(DICT);
    return Promise.resolve(null);
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  act(() => __resetDbForTest());
  container.remove();
});

describe("数据字典文档", () => {
  it("没选范围时不能生成", async () => {
    await render();
    expect(container.textContent).toContain("还没生成");
    expect(container.textContent).toContain("输入表名或中文名开始找表");
    expect(buttonByText("生成字典")!.disabled).toBe(true);
    // 关键词为空就不该去打库
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("搜表 → 勾选 → 生成，请求里带的是勾中的表名", async () => {
    await render();
    await typeQuery("物料");

    const item = container.querySelector<HTMLButtonElement>(".md-pick-item")!;
    expect(item.textContent).toContain("bd_material");
    expect(item.getAttribute("data-on")).toBeNull();

    await click(item);
    expect(container.querySelector(".md-pick-item")!.getAttribute("data-on")).not.toBeNull();
    expect(buttonByText("生成字典")!.disabled).toBe(false);

    await click(buttonByText("生成字典"));
    const call = mocks.invoke.mock.calls.find((c) => c[0] === "nc_md_dict")!;
    expect((call[1] as { filter: { names: string[] } }).filter.names).toEqual(["bd_material"]);

    // 抬头统计与表卡片
    expect(container.querySelector(".md-sum")!.textContent).toContain("1 张表 · 2 列");
    expect(container.querySelector(".md-tname")!.textContent).toBe("bd_material");
  });

  it("表卡片默认折叠，展开才渲染列行", async () => {
    await render();
    await typeQuery("物料");
    await click(container.querySelector<HTMLButtonElement>(".md-pick-item"));
    await click(buttonByText("生成字典"));

    expect(container.querySelectorAll(".md-col:not([data-h])").length).toBe(0);

    await click(container.querySelector<HTMLButtonElement>(".md-tcard-h"));
    const cols = [...container.querySelectorAll(".md-col:not([data-h])")].map((n) => n.textContent);
    expect(cols).toHaveLength(2);
    expect(cols[0]).toContain("物料主键");
    expect(cols[0]).toContain("PK");
  });

  it("补齐缺失表提示：草稿里写了、库里没有的表要标出来", async () => {
    mocks.draft.mockReturnValue({
      desc: "改动",
      draft: {},
      sqls: ["select * from bd_material", "update bd_ghost set a = 1"],
      picked: null,
      layers: [],
    });
    await render();

    await click(buttonByText("补丁涉及"));

    // chip 上显示扫到 2 张（1 张存在 + 1 张缺失）
    expect(buttonByText("补丁涉及")!.textContent).toContain("2");
    const miss = container.querySelector(".md-tag-miss");
    expect(miss?.textContent).toBe("库里没有");
    // 缺失行不可点（勾了也会被后端跳过）
    expect(miss!.closest("button")!.disabled).toBe(true);
    // 存在的那张默认勾上
    const on = container.querySelectorAll(".md-pick-item[data-on]");
    expect(on).toHaveLength(1);
    expect(on[0].textContent).toContain("bd_material");
  });

  it("字典结果里的 missing 会提示，不是静默丢掉", async () => {
    mocks.invoke.mockImplementation((cmd: string) => {
      if (cmd === "nc_md_tables") {
        return Promise.resolve({ tables: [MATERIAL], truncated: false, source: "nc@db" });
      }
      if (cmd === "nc_md_dict") return Promise.resolve({ ...DICT, missing: ["bd_billtype_b"] });
      return Promise.resolve(null);
    });
    await render();
    await typeQuery("物料");
    await click(container.querySelector<HTMLButtonElement>(".md-pick-item"));
    await click(buttonByText("生成字典"));

    const note = container.querySelector(".md-note[data-tone='warn']");
    expect(note?.textContent).toContain("1 张表库里没有");
    expect(note?.textContent).toContain("bd_billtype_b");
  });

  /**
   * 导出与复制：**必须走后端渲染**。
   *
   * 这一条盯的是最容易在重构中丢掉的东西 —— 如果哪天有人图省事在前端拼一份 CSV，
   * 那次点击就不会再出现 `nc_md_dict_export`，而 BOM/转义/竖线处理全在 Rust 里。
   */
  it("导出走的是后端的渲染命令，落盘后能定位", async () => {
    mocks.invoke.mockImplementation((cmd: string) => {
      if (cmd === "nc_md_tables") {
        return Promise.resolve({ tables: [MATERIAL], truncated: false, source: "nc@db" });
      }
      if (cmd === "nc_md_dict") return Promise.resolve(DICT);
      if (cmd === "nc_md_dict_export") {
        return Promise.resolve({
          path: "C:/cfg/exports/NC数据字典-指定-1-张表-202611021220.csv",
          name: "NC数据字典-指定-1-张表-202611021220.csv",
          bytes: 2048,
          dir: "C:/cfg/exports",
        });
      }
      return Promise.resolve(null);
    });
    await render();
    await typeQuery("物料");
    await click(container.querySelector<HTMLButtonElement>(".md-pick-item"));
    await click(buttonByText("生成字典"));

    await click(buttonByText("导出 CSV"));

    const call = mocks.invoke.mock.calls.find((c) => c[0] === "nc_md_dict_export")!;
    const req = call[1] as { format: string; doc: { tables: unknown[]; selection: string; generated: string } };
    expect(req.format).toBe("csv");
    // 传回去的必须是**屏幕上这一份**，不是重新查一遍
    expect(req.doc.tables).toHaveLength(1);
    expect(req.doc.selection).toBe("指定 1 张表");
    expect(req.doc.generated).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);

    const bar = container.querySelector(".md-note[data-tone='info']");
    expect(bar?.textContent).toContain("NC数据字典-指定-1-张表-202611021220.csv");

    await click(buttonByText("打开所在文件夹"));
    expect(mocks.invoke).toHaveBeenCalledWith("db_export_reveal", {
      path: "C:/cfg/exports/NC数据字典-指定-1-张表-202611021220.csv",
    });
  });

  it("复制拿到的也是后端渲染好的文本", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    mocks.invoke.mockImplementation((cmd: string) => {
      if (cmd === "nc_md_tables") {
        return Promise.resolve({ tables: [MATERIAL], truncated: false, source: "nc@db" });
      }
      if (cmd === "nc_md_dict") return Promise.resolve(DICT);
      if (cmd === "nc_md_dict_text") return Promise.resolve({ text: "# NC 数据字典\n", bytes: 18 });
      return Promise.resolve(null);
    });
    await render();
    await typeQuery("物料");
    await click(container.querySelector<HTMLButtonElement>(".md-pick-item"));
    await click(buttonByText("生成字典"));

    await click(buttonByText("复制 Markdown"));

    expect(mocks.invoke).toHaveBeenCalledWith("nc_md_dict_text", expect.objectContaining({ format: "md" }));
    expect(writeText).toHaveBeenCalledWith("# NC 数据字典\n");
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("已复制 Markdown"), "success");
  });
});
